// The canary's stand-in for api.anthropic.com (docs/prd/claude-version-pinning.md §11): one plain Node script the portal writes into the
// throwaway container and runs as the workspace user, so a canary needs nothing from the machine the portal runs on (the portal and the daemon
// may be in different network namespaces) and nothing leaves the container. It is the in-container sibling of claudeusage/testkit/standin.ts:
// the same two servers (an HTTPS one with a throwaway certificate for api.anthropic.com, and a CONNECT proxy that lets that one host through and
// refuses every other), plus what the checks need that the usage testkit does not: scripted TOOL steps (a tool call the CLI must ask permission
// for), a held reply (so an interrupt lands mid-turn) and the tool results the CLI sent back, logged for assertions.
//
//   node standin.cjs <dir>
//     <dir>/script.json   what to answer, re-read on every request (written by the portal between checks)
//     <dir>/requests.jsonl one line per request: method, path, header NAMES, and for a model request the tool names, the model and the tool
//                          results the CLI sent back (clipped); never a header value
//     <dir>/ready.json    written when listening: { proxy, http, ca }
//
// script.json: { usage?, profile?, messages?, steps?, routes? }
//   usage     { status?, headers?, body }          GET /api/oauth/usage
//   profile   { status?, headers?, body }          GET /api/oauth/profile
//   messages  { text?, always?, status?, headers?, body? }  every POST /v1/messages that is not a step (a reply, or an error such as a 429; headers
//                                                  go on the response: the unified rate-limit headers make the CLI emit a rate_limit_event); `text`
//                                                  answers only requests that offer tools unless `always` is set
//   steps     [{ text } | { tool, input } ...]     consumed in order by the requests that OFFER TOOLS (the main turn); { waitFor: path } holds the
//                                                  reply until the file exists, { delayMs } holds it that long; a changed list (or `id`) starts over
//   routes    [{ prefix, status?, headers?, body }] any other path, first prefix wins
// Everything else answers `{}` with 200. A request without tools (a title, a summary) gets "ok".

export const CANARY_STANDIN = String.raw`'use strict';
const http = require('http'), https = require('https'), net = require('net'), fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = process.argv[2];
const pki = path.join(dir, 'pki');
fs.mkdirSync(pki, { recursive: true });
const run = (...a) => cp.execFileSync('openssl', a, { cwd: pki, stdio: 'ignore' });
run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=claudepilot-canary-ca-not-trusted');
run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=api.anthropic.com');
fs.writeFileSync(path.join(pki, 'ext.cnf'), 'subjectAltName=DNS:api.anthropic.com\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
run('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'ext.cnf');

let next = 0, stepsKey = '';
const script = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8')); } catch { return {}; } };
const log = (o) => { try { fs.appendFileSync(path.join(dir, 'requests.jsonl'), JSON.stringify(o) + '\n'); } catch {} };
const sendJson = (res, a, fallbackBody) => {
  a = a || {};
  res.writeHead(a.status || 200, Object.assign({ 'content-type': 'application/json' }, a.headers || {}));
  res.end(JSON.stringify(a.body === undefined ? (fallbackBody === undefined ? {} : fallbackBody) : a.body));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const message = () => ({ id: 'msg_canary', type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 5 } });

function sse(res, headers, block) {
  res.writeHead(200, Object.assign({ 'content-type': 'text/event-stream' }, headers || {}));
  const s = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, data)) + '\n\n');
  s('message_start', { message: message() });
  if (block.tool === undefined) {
    s('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    s('content_block_delta', { index: 0, delta: { type: 'text_delta', text: block.text === undefined ? 'ok' : block.text } });
  } else {
    s('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_canary_' + next, name: block.tool, input: {} } });
    s('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } });
  }
  s('content_block_stop', { index: 0 });
  s('message_delta', { delta: { stop_reason: block.tool === undefined ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
  s('message_stop', {});
  res.end();
}

async function messages(req, res, body) {
  let j = {};
  try { j = JSON.parse(body || '{}'); } catch {}
  const tools = (j.tools || []).map((t) => t.name);
  const results = [];
  const last = (j.messages || []).slice(-1)[0];
  for (const c of [].concat(last && last.content || [])) {
    if (c && c.type === 'tool_result') results.push({ error: !!c.is_error, content: JSON.stringify(c.content).slice(0, 600) });
  }
  log({ method: req.method, path: req.url, tools, model: j.model || null, stream: j.stream === true, toolResults: results });
  const sc = script();
  const m = sc.messages || {};
  // A new list of steps (or a new id) starts again from its first step.
  const key = JSON.stringify([sc.id === undefined ? null : sc.id, sc.steps === undefined ? null : sc.steps]);
  if (key !== stepsKey) { stepsKey = key; next = 0; }
  if (m.status && m.status !== 200) return sendJson(res, m, { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } });
  let step = null;
  if (tools.length && Array.isArray(sc.steps)) step = sc.steps[next++] || { text: 'done' };
  if (step) {
    if (step.waitFor) { for (let i = 0; i < 300 && !fs.existsSync(step.waitFor); i++) await sleep(200); }
    if (step.delayMs) await sleep(step.delayMs);
  }
  const block = step || { text: (tools.length || m.always) && m.text !== undefined ? m.text : 'ok' };
  if (j.stream !== true) {
    const content = block.tool === undefined ? [{ type: 'text', text: block.text }] : [{ type: 'tool_use', id: 'toolu_canary_' + next, name: block.tool, input: block.input || {} }];
    return sendJson(res, { headers: m.headers }, Object.assign(message(), { content, stop_reason: block.tool === undefined ? 'end_turn' : 'tool_use' }));
  }
  sse(res, m.headers, block);
}

const handler = (req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const p = req.url || '';
    const sc = script();
    const route = (sc.routes || []).find((r) => p.startsWith(r.prefix));
    if (route) { log({ method: req.method, path: p, headers: Object.keys(req.headers) }); return sendJson(res, route); }
    if (req.method === 'POST' && p.startsWith('/v1/messages') && !p.includes('count_tokens')) return messages(req, res, body);
    log({ method: req.method, path: p, headers: Object.keys(req.headers) });
    if (p.includes('count_tokens')) return sendJson(res, { body: { input_tokens: 1 } });
    if (req.method === 'GET' && p.startsWith('/api/oauth/usage')) return sc.usage ? sendJson(res, sc.usage) : sendJson(res, { status: 404, body: { error: 'not scripted' } });
    if (req.method === 'GET' && p.startsWith('/api/oauth/profile') && sc.profile) return sendJson(res, sc.profile);
    sendJson(res, {});
  });
};

const api = https.createServer({ key: fs.readFileSync(path.join(pki, 'leaf.key')), cert: fs.readFileSync(path.join(pki, 'leaf.pem')) }, handler);
const plain = http.createServer(handler);
const proxy = http.createServer((req, res) => { res.writeHead(502); res.end(); });
proxy.on('connect', (req, socket, head) => {
  if (String(req.url).split(':')[0] !== 'api.anthropic.com') {
    log({ method: 'CONNECT-REFUSED', path: String(req.url), headers: [] });
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const up = net.connect(api.address().port, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', r));
(async () => {
  await listen(api); await listen(plain); await listen(proxy);
  fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ proxy: 'http://127.0.0.1:' + proxy.address().port, http: 'http://127.0.0.1:' + plain.address().port, ca: path.join(pki, 'ca.pem') }));
})();
`;
