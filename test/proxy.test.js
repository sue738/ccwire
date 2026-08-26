/** proxy.test.js — zero-dep tests for the live-proxy path. Run: node test/proxy.test.js */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xray-'));
process.env.CCSENDSTATS_PROXY_LOG = path.join(tmp, 'requests.jsonl');

const { analyzeRequest, usageCollector, handle } = require('../lib/proxy.js');

console.log('== analyzeRequest ==');
const body = Buffer.from(JSON.stringify({
  model: 'claude-opus-5', stream: true, system: 'You are Claude Code'.repeat(100),
  max_tokens: 32000,
  tools: [{ name: 'Bash' }, { name: 'Read' }],
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    { role: 'user', content: [{ type: 'tool_result', content: 'out' }] },
  ],
}));
const a = analyzeRequest(body);
ok('model/stream/counts', a.model === 'claude-opus-5' && a.stream === true && a.messages === 3);
ok('system文字数', a.system_chars === 'You are Claude Code'.length * 100);
ok('tools数とtool_result数', a.tools_offered === 2 && a.tool_results === 1);
ok('壊れたbodyはnull', analyzeRequest(Buffer.from('nope')) === null);

console.log('== usageCollector ==');
{
  const c = usageCollector();
  c.feed('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5000}}}\n\n');
  c.feed('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n');
  const u = c.result('text/event-stream');
  ok('SSE: input/cache/outputを合成', u.input_tokens === 10 && u.cache_read_input_tokens === 5000 && u.output_tokens === 42);
}
{
  const c = usageCollector();
  c.feed(JSON.stringify({ usage: { input_tokens: 7, output_tokens: 3 } }));
  const u = c.result('application/json');
  ok('JSON: usage取得', u.input_tokens === 7 && u.output_tokens === 3);
}
{
  const c = usageCollector();
  c.feed('no usage here');
  ok('usage無しはnull', c.result('application/json') === null);
}

(async () => {
  console.log('== proxy e2e (mock upstream) ==');
  // モック上流: 受けたbody/headersをそのまま検証できる形で返す
  let received = null;
  const upstream = http.createServer((req, res) => {
    const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => {
      received = { body: Buffer.concat(ch).toString(), auth: req.headers['x-api-key'] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 999 } }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  process.env.CCSENDSTATS_PROXY_FORWARD_URL = 'http://localhost:' + upstream.address().port;
  // handleはmodule読込時にFORWARDを固定するので、env反映のためrequireし直す
  delete require.cache[require.resolve('../lib/proxy.js')];
  const fresh = require('../lib/proxy.js');

  const proxy = http.createServer(fresh.handle);
  await new Promise((r) => proxy.listen(0, r));
  const pPort = proxy.address().port;

  const reqBody = JSON.stringify({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'ping' }] });
  const resp = await new Promise((resolve, reject) => {
    const rq = http.request({ host: 'localhost', port: pPort, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'secret-key-123', 'content-length': Buffer.byteLength(reqBody) } },
      (rs) => { const c = []; rs.on('data', (x) => c.push(x)); rs.on('end', () => resolve(Buffer.concat(c).toString())); });
    rq.on('error', reject); rq.end(reqBody);
  });

  ok('e2e: bodyがバイト一致で素通し', received.body === reqBody);
  ok('e2e: 認証ヘッダが上流に届く', received.auth === 'secret-key-123');
  ok('e2e: レスポンスも素通し', JSON.parse(resp).id === 'msg_1');

  await new Promise((r) => setTimeout(r, 200)); // ログ書き込み待ち
  const log = fs.readFileSync(process.env.CCSENDSTATS_PROXY_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('e2e: 1リクエスト記録', log.length === 1 && log[0].model === 'claude-sonnet-5');
  ok('e2e: usageを記録', log[0].usage && log[0].usage.cache_read_input_tokens === 999);
  ok('e2e: ログに認証情報が無い', !fs.readFileSync(process.env.CCSENDSTATS_PROXY_LOG, 'utf8').includes('secret-key-123'));
  ok('e2e: ログに本文が無い(メタデータのみ)', !fs.readFileSync(process.env.CCSENDSTATS_PROXY_LOG, 'utf8').includes('ping'));

  proxy.close(); upstream.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n結果: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
