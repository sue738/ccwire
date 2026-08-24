/* vendored copy — do not edit. Source: apps/cctranscript/lib/index.js — regenerate with tools/sync-vendor.js */
/**
 * cctranscript — the one place that knows how to read Claude Code transcripts.
 *
 * Claude Code stores every session as JSONL under ~/.claude/projects/<encoded-dir>/<session>.jsonl.
 * That format is undocumented and can change. Six separate tools re-implementing
 * their own reader means six things to fix (and, as we learned the hard way, six
 * chances to get it subtly different). This library is the single source of truth.
 *
 * Design rules:
 *  - Zero dependencies.
 *  - Fail soft, always. A truncated/garbage line is skipped, never thrown.
 *  - Only depend on the most stable fields (type, timestamp, cwd, message.content,
 *    message.usage, isSidechain, isMeta).
 *  - Pure functions where possible so callers can test without touching disk.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// ---------------------------------------------------------------- locating

function defaultBaseDir() {
  return process.env.CC_TRANSCRIPT_BASE_DIR || path.join(os.homedir(), '.claude', 'projects');
}

/**
 * List transcript files.
 *
 * Subagent transcripts do not sit next to the session file — they live one
 * level down, at `<project>/<session-uuid>/subagents/*.jsonl`. Walking only the
 * project directory therefore misses them entirely, and on a machine that
 * delegates that is most of the data: 782 session files against 3,103 total
 * here. Tools built on this reader were not excluding subagent turns by policy,
 * they were never opening the files. ccleaks hit this and fixed it in its own
 * walker; this is the same fix in the shared one.
 *
 * The default stays main-loop-only so existing numbers do not move under
 * anyone. Pass `subagents: true` to include them; each result carries
 * `isSubagent` so a caller can report the two separately.
 *
 * @returns [{file, projectDir, session, isSubagent, mtimeMs, size}] newest first
 */
function walkSubagents(dir, projectDir, session, take) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSubagents(p, projectDir, session, take);
    else if (e.name.endsWith('.jsonl')) take(p, projectDir, session, true);
  }
}

function locate(opts) {
  opts = opts || {};
  const baseDir = opts.baseDir || defaultBaseDir();
  const now = opts.now || Date.now();
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(baseDir, { withFileTypes: true }).filter((d) => d.isDirectory()); }
  catch (e) { return out; }

  const take = (file, projectDir, session, isSubagent) => {
    let st;
    try { st = fs.statSync(file); } catch (e) { return; }
    if (opts.sinceMs && st.mtimeMs < opts.sinceMs) return;
    if (opts.activeHours && now - st.mtimeMs > opts.activeHours * 3600 * 1000) return;
    out.push({ file, projectDir, session, isSubagent, mtimeMs: st.mtimeMs, size: st.size });
  };

  for (const d of dirs) {
    if (opts.project && !d.name.toLowerCase().includes(String(opts.project).toLowerCase())) continue;
    const pdir = path.join(baseDir, d.name);
    let entries;
    try { entries = fs.readdirSync(pdir, { withFileTypes: true }); }
    catch (e) { continue; }

    for (const f of entries) {
      if (f.isDirectory()) {
        // <session-uuid>/subagents/**.jsonl — the delegated half of the work.
        // Depth varies: plain subagents sit directly under subagents/, while
        // workflow agents nest another level as subagents/workflows/<run>/.
        if (!opts.subagents) continue;
        walkSubagents(path.join(pdir, f.name, 'subagents'), d.name, f.name, take);
        continue;
      }
      if (!f.name.endsWith('.jsonl')) continue;
      take(path.join(pdir, f.name), d.name, path.basename(f.name, '.jsonl'), false);
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// ---------------------------------------------------------------- file io

/** Read the first `bytes` of a file as utf8. */
function headOf(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

/** Read the last `bytes` of a file as utf8. */
function tailOf(file, bytes) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

/** Parse JSONL text into entries, skipping unparsable lines. */
function parseLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { const o = JSON.parse(s); if (o && typeof o === 'object') out.push(o); }
    catch (e) { /* truncated or partial write */ }
  }
  return out;
}

/**
 * Stream a transcript file entry by entry (memory-safe for huge files).
 * A missing/unreadable file yields nothing rather than throwing — note that
 * createReadStream reports such errors asynchronously on the stream, so the
 * handler below (not a try/catch around the constructor) is what makes this safe.
 */
async function* readEntries(file) {
  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' });
  } catch (e) { return; }
  let failed = false;
  stream.on('error', () => { failed = true; });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const s = line.trim();
      if (!s) continue;
      try { const o = JSON.parse(s); if (o && typeof o === 'object') yield o; }
      catch (e) { /* skip */ }
    }
  } catch (e) {
    if (!failed) return; // unexpected: still fail soft
  } finally {
    rl.close();
    stream.destroy();
  }
}

// ---------------------------------------------------------------- entries

/** Main-loop entries only: excludes subagent (sidechain) and meta bookkeeping. */
function isMainLoop(entry) {
  return !!entry && !entry.isSidechain && !entry.isMeta;
}

/**
 * One line naming which turns a number was computed over.
 *
 * Whether a tool calls isMainLoop() is a per-tool choice, and both choices are
 * defensible — but a reader comparing two tools cannot tell them apart from the
 * numbers alone. Subagent turns are roughly half of all activity on a machine
 * that delegates, so the same metric legitimately differs by more than 2x.
 * Every tool that prints an aggregate should print this next to it.
 */
const SCOPES = {
  main: ['main loop only (subagent turns excluded)', 'メインループのみ(サブエージェント除く)'],
  side: ['subagent turns only', 'サブエージェントのみ'],
  both: ['main loop + subagent turns', 'メインループ + サブエージェント'],
};

function scopeNote(scope, ja) {
  const s = SCOPES[scope];
  if (!s) throw new Error(`unknown scope: ${scope}`);
  return ja ? s[1] : s[0];
}

function isUser(entry) { return !!entry && entry.type === 'user'; }
function isAssistant(entry) { return !!entry && entry.type === 'assistant'; }

/** Content blocks of an entry, always as an array (string content is wrapped). */
function blocksOf(entry) {
  const c = entry && entry.message && entry.message.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c.filter((b) => b && typeof b === 'object') : [];
}

/**
 * Human-readable text of an entry.
 * @param {object} opts {thinking: include thinking blocks, toolResults: include tool output}
 */
function textOf(entry, opts) {
  opts = opts || {};
  const parts = [];
  for (const b of blocksOf(entry)) {
    if (b.type === 'text' && b.text) parts.push(b.text);
    else if (b.type === 'thinking' && opts.thinking && b.thinking) parts.push(b.thinking);
    else if (b.type === 'tool_result' && opts.toolResults) {
      const c = b.content;
      if (typeof c === 'string') parts.push(c);
      else if (Array.isArray(c)) parts.push(c.map((x) => (x && x.text) || '').join(' '));
    }
  }
  return parts.join('\n').trim();
}

/** Tool calls in an entry: [{name, input, id}] */
function toolUsesOf(entry) {
  return blocksOf(entry)
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ name: b.name || null, input: b.input || {}, id: b.id || null }));
}

/**
 * True when a user entry is not actually the human speaking: slash-command
 * echoes and their stdout are injected into the transcript as user turns
 * (`<command-name>/model</command-name>`, `<local-command-stdout>…`). They are
 * real entries, but treating them as prompts pollutes anything that reasons
 * about what you asked for.
 */
function isCommandEcho(entry) {
  if (!isUser(entry)) return false;
  const t = textOf(entry).trimStart();
  return /^<(local-command-std(out|err)|command-(name|message|args))\b/.test(t)
    || /^<local-command-caveat\b/.test(t);
}

/** True when this user entry is only tool results (the agent's internal loop, not you talking). */
function isToolResultTurn(entry) {
  if (!isUser(entry)) return false;
  const c = entry.message && entry.message.content;
  return Array.isArray(c) && c.length > 0 && c.every((b) => b && b.type === 'tool_result');
}

/**
 * What kind of turn is this, from a state-machine point of view?
 * 'prompt' (you spoke) | 'text' (Claude answered) | 'tool_use' (Claude wants to run something)
 * | 'tool_result' (a tool came back) | null
 */
function kindOf(entry) {
  if (!isMainLoop(entry)) return null;
  if (isAssistant(entry)) return toolUsesOf(entry).length ? 'tool_use' : 'text';
  if (isUser(entry)) return isToolResultTurn(entry) ? 'tool_result' : 'prompt';
  return null;
}

/** Token usage of an assistant entry, normalized. null when absent. */
function usageOf(entry) {
  const u = entry && entry.message && entry.message.usage;
  if (!u) return null;
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/**
 * Short model family name: claude-opus-5 -> opus.
 * "<synthetic>" is the CLI's marker on locally-stamped entries (API errors and
 * the like), not a served model — treated as absent so it never pollutes stats.
 */
function modelOf(entry) {
  const m = entry && entry.message && entry.message.model;
  if (!m || m === '<synthetic>') return null;
  for (const fam of ['fable', 'opus', 'sonnet', 'haiku']) if (m.includes(fam)) return fam;
  return m;
}

// ---------------------------------------------------------------- sessions

/**
 * Project display name.
 *
 * The directory name is a path with every "/" replaced by "-", so it is
 * ambiguous for any folder whose own name contains a hyphen ("my-app"):
 * "-home-me-my-app" could be /home/me/my-app or /home/me/my/app. Never guess —
 * transcripts carry the real `cwd`. The dash split is a last-resort fallback.
 */
function projectName(projectDir, cwd) {
  if (cwd) {
    const base = String(cwd).split('/').filter(Boolean).pop();
    if (base) return base;
  }
  const parts = String(projectDir || '').split('-').filter(Boolean);
  return parts[parts.length - 1] || String(projectDir || '');
}

/**
 * The session's working directory: the FIRST cwd in the file. That is where the
 * session was launched — a stable identity. The last entry's cwd drifts with
 * whatever directory the most recent shell command ran in.
 */
function cwdOf(text) {
  for (const e of parseLines(text)) {
    if (typeof e.cwd === 'string' && e.cwd) return e.cwd;
  }
  return null;
}

/** Cheap session summary without reading the whole file. */
function sessionInfo(file, opts) {
  opts = opts || {};
  const headBytes = opts.headBytes || 16 * 1024;
  const tailBytes = opts.tailBytes || 64 * 1024;
  let cwd = null, session = null, firstTs = null, lastTs = null, lastKind = null;
  try {
    const head = headOf(file, headBytes);
    cwd = cwdOf(head);
    for (const e of parseLines(head)) {
      if (!session && e.sessionId) session = e.sessionId;
      if (!firstTs && e.timestamp) firstTs = e.timestamp;
      if (session && firstTs) break;
    }
  } catch (e) { /* fail soft */ }
  // Which tool the run last reached for, alongside the kind. A transcript that
  // ends in a tool_result looks the same whether the run died mid-turn or
  // finished normally — a headless run that returns structured output ends
  // exactly that way — so the tool's name is what tells the two apart.
  let lastTool = null;
  try {
    const entries = parseLines(tailOf(file, tailBytes));
    for (let i = entries.length - 1; i >= 0; i--) {
      const uses = toolUsesOf(entries[i]);
      if (uses.length && !lastTool) lastTool = uses[uses.length - 1].name || null;
      const k = kindOf(entries[i]);
      if (k && !lastKind) { lastKind = k; lastTs = entries[i].timestamp || null; }
      if (lastKind && lastTool) break;
    }
  } catch (e) { /* fail soft */ }
  return {
    file,
    session: session || path.basename(file, '.jsonl'),
    cwd,
    project: projectName(path.basename(path.dirname(file)), cwd),
    firstTs, lastTs, lastKind, lastTool,
  };
}

module.exports = {
  // locating
  defaultBaseDir, locate,
  // io
  headOf, tailOf, parseLines, readEntries,
  // entries
  isMainLoop, scopeNote, SCOPES,
  isUser, isAssistant, blocksOf, textOf, toolUsesOf, isCommandEcho,
  isToolResultTurn, kindOf, usageOf, modelOf,
  // sessions
  projectName, cwdOf, sessionInfo,
};
