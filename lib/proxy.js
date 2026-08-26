/**
 * proxy.js — the one thing a transcript can never show you: the literal bytes
 * that left the machine, system prompt and tool definitions included.
 *
 *   ccpayload proxy &                                   # observe on :8789
 *   ANTHROPIC_BASE_URL=http://localhost:8789 claude   # use cc as usual
 *   ccpayload proxy-report                               # what happened
 *
 * Pure observation: requests and responses pass through byte-for-byte
 * unmodified. Auth headers are NEVER logged. Records per request:
 * model, system prompt size, message/tool counts, and token usage
 * (parsed from the response, streaming or not).
 *
 * Kept separate from ccpayload's main path on purpose: that path reads a
 * transcript after the fact with zero setup, which is why it gets used. This
 * one needs the session actually routed through it, which is real friction —
 * reach for it only when you need the bytes the transcript cannot show.
 */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = +(process.env.CCPAYLOAD_PROXY_PORT || 8789);
const FORWARD = process.env.CCPAYLOAD_PROXY_FORWARD_URL || 'https://api.anthropic.com';
const LOG = process.env.CCPAYLOAD_PROXY_LOG || path.join(os.homedir(), '.ccpayload-proxy', 'requests.jsonl');

// ---------- request analysis (never includes auth or full content) ----------
function analyzeRequest(body) {
  let o;
  try { o = JSON.parse(body.toString('utf8')); } catch (e) { return null; }
  const sys = typeof o.system === 'string'
    ? o.system
    : Array.isArray(o.system) ? o.system.map((s) => s.text || '').join('') : '';
  const messages = Array.isArray(o.messages) ? o.messages : [];
  let toolResults = 0, textParts = 0;
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === 'tool_result') toolResults++;
        if (b && b.type === 'text') textParts++;
      }
    } else if (typeof m.content === 'string') textParts++;
  }
  return {
    model: o.model || null,
    stream: !!o.stream,
    system_chars: sys.length,
    messages: messages.length,
    text_parts: textParts,
    tool_results: toolResults,
    tools_offered: Array.isArray(o.tools) ? o.tools.length : 0,
    max_tokens: o.max_tokens || null,
    body_bytes: body.length,
  };
}

// SSE/JSONレスポンスから usage を拾う(観測のみ、ストリームには手を触れない)
function usageCollector() {
  let buf = '';
  const usage = {};
  return {
    feed(chunk) {
      buf += chunk.toString('utf8');
      if (buf.length > 4 * 1024 * 1024) buf = buf.slice(-1024 * 1024); // 念のため
    },
    result(contentType) {
      try {
        if (String(contentType || '').includes('event-stream')) {
          // message_start に input/cache、message_delta に output_tokens が来る
          for (const m of buf.matchAll(/"usage"\s*:\s*(\{[^}]*\})/g)) {
            try { Object.assign(usage, JSON.parse(m[1])); } catch (e) {}
          }
        } else {
          const o = JSON.parse(buf);
          if (o && o.usage) Object.assign(usage, o.usage);
        }
      } catch (e) {}
      return Object.keys(usage).length ? usage : null;
    },
  };
}

function logRecord(rec) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
  } catch (e) {}
}

// ---------- proxy (byte-for-byte passthrough) ----------
function handle(req, res) {
  // origin-form only (paths starting with '/') — an absolute-form request-target
  // (e.g. "POST http://internal/x HTTP/1.1") would make `new URL(req.url, FORWARD)`
  // ignore FORWARD and target whatever host the client asked for, turning this
  // into an open relay for anyone who can reach the port.
  if (!req.url.startsWith('/')) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'proxy_forbidden', message: 'absolute-form request targets are not allowed; only requests to FORWARD are proxied' } }));
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);
    const target = new URL(req.url, FORWARD);
    const lib = target.protocol === 'https:' ? https : http;

    const headers = Object.assign({}, req.headers);
    delete headers.host;

    const isMessages = req.method === 'POST' && /\/v1\/messages$/.test(req.url.split('?')[0]);
    const info = isMessages ? analyzeRequest(rawBody) : null;
    const t0 = Date.now();
    const collector = info ? usageCollector() : null;

    const upstream = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers,
    }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.on('data', (chunk) => {
        if (collector) collector.feed(chunk); // 観測のみ
        res.write(chunk);
      });
      up.on('end', () => {
        res.end();
        if (info) {
          const usage = collector.result(up.headers['content-type']);
          const rec = Object.assign({ ts: new Date().toISOString(), status: up.statusCode, ms: Date.now() - t0 }, info, { usage });
          logRecord(rec);
          const u = usage || {};
          console.error(`[ccpayload proxy] ${info.model}  sys=${(info.system_chars / 1000).toFixed(1)}k chars  msgs=${info.messages}  tools=${info.tools_offered}  ` +
            `in=${u.input_tokens ?? '?'} out=${u.output_tokens ?? '?'} cacheR=${u.cache_read_input_tokens ?? '?'} cacheW=${u.cache_creation_input_tokens ?? '?'}  ${Date.now() - t0}ms`);
        }
      });
    });
    upstream.on('error', (e) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'proxy_upstream_error', message: e.message } }));
    });
    upstream.end(rawBody);
  });
}

// ---------- report ----------
function report() {
  if (!fs.existsSync(LOG)) {
    console.log(`no log yet (${LOG}). Run the proxy and use Claude Code through it first.`);
    return;
  }
  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
  const models = {};
  let totIn = 0, totOut = 0, totCr = 0, totCw = 0, withUsage = 0;
  let sysMax = 0, sysSum = 0, toolsMax = 0;
  for (const l of lines) {
    let r; try { r = JSON.parse(l); } catch (e) { continue; }
    models[r.model] = (models[r.model] || 0) + 1;
    sysSum += r.system_chars || 0; sysMax = Math.max(sysMax, r.system_chars || 0);
    toolsMax = Math.max(toolsMax, r.tools_offered || 0);
    if (r.usage) {
      withUsage++;
      totIn += r.usage.input_tokens || 0; totOut += r.usage.output_tokens || 0;
      totCr += r.usage.cache_read_input_tokens || 0; totCw += r.usage.cache_creation_input_tokens || 0;
    }
  }
  const totalTok = totIn + totOut + totCr + totCw;
  console.log(`=== ccpayload proxy-report (${lines.length} requests, ${withUsage} with usage) ===`);
  console.log(`models: ${Object.entries(models).map(([m, n]) => `${m}×${n}`).join('  ')}`);
  console.log(`system prompt: avg ${(sysSum / Math.max(1, lines.length) / 1000).toFixed(1)}k chars, max ${(sysMax / 1000).toFixed(1)}k chars`);
  console.log(`tools offered: up to ${toolsMax} per request`);
  console.log(`tokens: input ${totIn.toLocaleString()}  output ${totOut.toLocaleString()}  cache_read ${totCr.toLocaleString()}  cache_write ${totCw.toLocaleString()}`);
  if (totalTok) {
    console.log(`cache share: ${((totCr / totalTok) * 100).toFixed(1)}% of all tokens are cache reads`);
  }
  console.log(`log: ${LOG}`);
}

function serve() {
  const server = http.createServer(handle);
  server.listen(PORT, '127.0.0.1', () => {
    console.error(`[ccpayload proxy] observing on http://localhost:${PORT} → ${FORWARD}`);
    console.error(`[ccpayload proxy] usage: ANTHROPIC_BASE_URL=http://localhost:${PORT} claude`);
    console.error('[ccpayload proxy] passthrough is byte-for-byte; auth headers are never logged');
  });
  return server;
}

module.exports = { analyzeRequest, usageCollector, handle, report, serve, PORT, LOG };
