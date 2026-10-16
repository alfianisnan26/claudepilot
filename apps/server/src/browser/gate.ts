import { INSTALL_PATH } from './scripts.js';
import { BROWSER_BIN, BROWSER_NPM_DIR } from './spec.js';

/**
 * The gate (browser & desktop PRD §11.3), delivered as `/etc/claudepilot/bin/browser-mcp` and started by
 * Claude Code as each stdio MCP server of the `cpb-browser` plugin:
 *
 *     browser-mcp <playwright|devtools> --tools <tools.json> --npm-files <folder> [--shared] -- <server arguments>
 *
 * It stands between Claude Code and the pinned server (Playwright MCP, chrome-devtools-mcp). It is plain Node
 * with no dependencies, and it pauses cooperative agents: it isn't a boundary, since anything in the workspace
 * can open CDP (§13 Not enforced).
 *
 * - `initialize` and `tools/list` it answers itself, from the pinned server's tool list shipped in the plugin, so
 *   a session start never starts a server or wakes Chrome. It adds `browser_status`, `browser_handoff` and, for
 *   Playwright, `browser_navigate_forward` and `browser_reload` (which Playwright MCP lacks).
 * - A tool call first checks the supervisor: while a person has control it answers with a tool error instead of
 *   forwarding; otherwise it wakes Chrome, starts the server (a new Chrome means a new server, replaying
 *   `initialize`), gives this Claude session its own tab when logins are shared, and forwards the call.
 * - Credential headers in results (cookie, set-cookie, authorization, proxy-authorization, x-api-key) are
 *   replaced, so live sessions stay out of transcripts.
 * - It reports each call to the supervisor, which is what idle stop and "Follow the agent" read.
 *
 * Only JSON lines go to stdout. Written as a string because the portal ships it into workspaces; a test
 * (gate.test.ts) runs the real thing against a fake supervisor and a fake server.
 */
export const GATE_SCRIPT = String.raw`#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');

const GATE_VERSION = '1';
const SUPERVISOR = new URL(process.env.CLAUDEPILOT_BROWSER_SUPERVISOR || 'http://127.0.0.1:9220');
const NPM_DIR = process.env.CLAUDEPILOT_BROWSER_NPM || path.join(os.homedir(), '${BROWSER_NPM_DIR}');
const SERVERS = {
  playwright: { name: 'browser', entry: 'node_modules/@playwright/mcp/cli.js' },
  devtools: { name: 'devtools', entry: 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js' },
};
const INSTALL = process.env.CLAUDEPILOT_BROWSER_INSTALL || '${INSTALL_PATH}';
const SESSION = 'g' + process.pid.toString(36) + Date.now().toString(36).slice(-4);

// ---- arguments: <server> [--tools file] [--shared] -- <server args> ----
const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const mine = dash < 0 ? argv : argv.slice(0, dash);
const serverArgs = dash < 0 ? [] : argv.slice(dash + 1);
const kind = mine[0];
if (!SERVERS[kind]) {
  process.stderr.write('usage: browser-mcp <playwright|devtools> [--tools file] [--shared] -- <server args>\n');
  process.exit(2);
}
const flag = (name) => { const i = mine.indexOf(name); return i >= 0 ? mine[i + 1] : undefined; };
const shared = mine.includes('--shared');
const toolsFile = flag('--tools');
const npmFiles = flag('--npm-files');

const log = (...a) => process.stderr.write('browser-mcp: ' + a.join(' ') + '\n');
const debug = process.env.CLAUDEPILOT_BROWSER_DEBUG ? (...a) => log('debug', ...a) : () => {};
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });
const text = (t, isError) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

// ---- the supervisor (loopback HTTP; X-CPB is what a web page can't send) ----
function supervisor(method, p, body, ms) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: SUPERVISOR.hostname, port: SUPERVISOR.port, path: p, method, timeout: ms || 5000,
      headers: { 'X-CPB': '1', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('the browser supervisor did not answer')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
let statusCache = { at: 0, value: null };
async function status(fresh) {
  if (!fresh && statusCache.value && Date.now() - statusCache.at < 1000) return statusCache.value;
  const r = await supervisor('GET', '/status');
  if (r.status !== 200 || !r.json) throw new Error('the browser supervisor is not reachable');
  statusCache = { at: Date.now(), value: r.json };
  return r.json;
}
const clock = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';

// ---- credentials never reach a transcript (§11.3) ----
// The names of the headers the pool adds from secrets (--redact a,b: names only, PRD §24) are credentials too, and the two Cloudflare
// Access ones always are. A name is only letters, digits and hyphens: anything else is dropped here, so it can't change the pattern.
const EXTRA_CRED = ['cf-access-client-id', 'cf-access-client-secret'].concat(String(flag('--redact') || '').split(',').filter((n) => /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(n)));
const CRED = '(cookie|set-cookie|authorization|proxy-authorization|x-api-key|' + EXTRA_CRED.join('|') + ')';
// The values of the secrets behind those headers (--redact-env a,b: the names of environment variables the plugin's .mcp.json passes through
// from Claude Code's own, so no value is in a file or on a command line). A value is masked wherever it appears: as it is, JSON-escaped or
// URL-encoded. Values under 8 characters are not masked: they would hit ordinary words.
// The header carries the value of a KEY=VALUE line as the portal reads it: without its quotes and without a trailing " # note"
// (headers.ts envFileValue). A reader that keeps the note (docker --env-file) leaves the variable longer than that value, and then masking the
// variable alone would let the real, shorter value through. So the parsed form of the variable is masked too, and of each line of a
// multi-line one.
function parsedForms(v) {
  const out = [v];
  for (const raw of v.split(/\r?\n/)) {
    let rest = raw.trim();
    const m = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=(.*)$/.exec(rest);
    if (m) rest = (m[1] || '').trim();
    out.push(rest);
    const q = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(rest);
    out.push(q ? q[2] : rest.replace(/(^|\s+)#.*$/, ''));
  }
  return out;
}
const SECRET_VALUES = String(flag('--redact-env') || '')
  .split(',')
  .filter((n) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(n))
  .map((n) => process.env[n])
  .filter((v) => typeof v === 'string' && v.length >= 8)
  .flatMap((v) => parsedForms(v))
  .flatMap((v) => [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)])
  .filter((v, i, all) => v.length >= 8 && all.indexOf(v) === i)
  .sort((a, b) => b.length - a.length);
function redact(s) {
  let out = s
    .replace(new RegExp('("' + CRED + '"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"', 'gi'), '$1"[redacted]"')
    .replace(new RegExp('("name"\\s*:\\s*"' + CRED + '"\\s*,\\s*"value"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"', 'gi'), '$1"[redacted]"')
    .replace(new RegExp('("value"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"(\\s*,\\s*"name"\\s*:\\s*"' + CRED + '")', 'gi'), '$1"[redacted]"$2')
    .replace(new RegExp('(\\|\\s*' + CRED + '\\s*\\|\\s*)[^|\\n]*', 'gi'), '$1[redacted] ')
    .replace(new RegExp('(^[ \\t>-]*\\[?' + CRED + '\\]?\\s*[:=]\\s*)(.+)$', 'gim'), '$1[redacted]');
  for (const v of SECRET_VALUES) out = out.split(v).join('[redacted]');
  return out;
}
function redactResult(result) {
  if (!result || !Array.isArray(result.content)) return result;
  return { ...result, content: result.content.map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? { ...c, text: redact(c.text) } : c)) };
}

// ---- tools this gate adds ----
const GATE_TOOLS = kind !== 'playwright' ? [] : [
  {
    name: 'browser_status',
    description: 'What the shared browser is doing: asleep or running, whether a person has control of it, and its open tabs. Never wakes the browser.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'browser_handoff',
    description: 'Ask a person to take over the browser for something only they can do: signing in, two-factor codes, QR codes, CAPTCHAs. Say what you need in "reason" (one short sentence). The call waits until they hand back (up to 10 minutes) and the browser then keeps their signed-in session. Check the result with browser_snapshot, not a screenshot. Never ask for or type passwords yourself.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string', maxLength: 200, description: 'What the person should do, e.g. "Sign in to github.com"' } }, required: ['reason'], additionalProperties: false },
  },
  { name: 'browser_navigate_forward', description: 'Go forward to the next page in the history', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'browser_reload', description: 'Reload the current page', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

let pinned = { tools: [], server: { name: 'claudepilot-browser', version: GATE_VERSION } };
if (toolsFile) {
  try { pinned = JSON.parse(fs.readFileSync(toolsFile, 'utf8')); } catch (e) { log('cannot read the tool list ' + toolsFile + ': ' + e.message); }
}
const allTools = () => [...pinned.tools, ...GATE_TOOLS];

// ---- the real server, started on the first call ----
let real = null; // { child, pending, bootId, ready, tab }
let nextId = 1;
let clientInit = null;
let clientReady = false;

function realEntry() {
  const entry = path.join(NPM_DIR, SERVERS[kind].entry);
  return fs.existsSync(entry) ? entry : null;
}

// The portal installs the pinned servers right after delivery; a session that calls a tool before that
// finished runs the same installer itself (one at a time, and a no-op once done).
let installing = null;
function install() {
  if (!npmFiles || !fs.existsSync(INSTALL)) return Promise.resolve();
  installing = installing || new Promise((resolve) => {
    log('installing the browser servers (first use)');
    const c = spawn('/bin/sh', [INSTALL, npmFiles], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, CLAUDEPILOT_BROWSER_NPM: NPM_DIR } });
    const timer = setTimeout(() => c.kill(), 300000);
    c.on('exit', () => { clearTimeout(timer); installing = null; resolve(); });
    c.on('error', () => { clearTimeout(timer); installing = null; resolve(); });
  });
  return installing;
}

function startReal(bootId) {
  const entry = realEntry();
  if (!entry) throw new Error('The browser tools are not installed in this workspace yet. Try again in a minute.');
  const child = spawn(process.execPath, [entry, ...serverArgs], { cwd: NPM_DIR, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  const r = { child, pending: new Map(), bootId, ready: null, tab: false, dead: false };
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch (e) { continue; }
      if (m.id !== undefined && m.method === undefined) {
        const p = r.pending.get(m.id);
        if (p) { r.pending.delete(m.id); p(m); }
      } else if (m.method !== undefined && m.id === undefined) {
        out(m); // progress, logging
      } else if (m.method !== undefined) {
        out(m); // a request to the client (roots/list, sampling): its answer is forwarded back below
      }
    }
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('exit', () => {
    r.dead = true;
    for (const p of r.pending.values()) p({ error: { code: -32000, message: 'The browser tool server stopped. Call the tool again.' } });
    r.pending.clear();
    if (real === r) real = null;
  });
  return r;
}

function realRequest(r, method, params, ms) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = ms ? setTimeout(() => { r.pending.delete(id); reject(new Error('the browser tool server did not answer')); }, ms) : null;
    r.pending.set(id, (m) => { if (timer) clearTimeout(timer); resolve(m); });
    r.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function ensureReal(st) {
  if (!realEntry()) await install();
  const bootId = st.chrome && st.chrome.bootId;
  if (real && !real.dead && real.bootId !== bootId) { try { real.child.kill(); } catch (e) { /* gone */ } real = null; } // a new Chrome: the old connection is stale
  if (real && !real.dead) return real.ready.then(() => real);
  real = startReal(bootId);
  const r = real;
  r.ready = (async () => {
    const init = clientInit || { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '0' } };
    const res = await realRequest(r, 'initialize', init, 30000);
    if (res.error) throw new Error('the browser tool server did not start: ' + res.error.message);
    r.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  })();
  r.ready.catch(() => { try { r.child.kill(); } catch (e) { /* gone */ } });
  await r.ready;
  return r;
}

const argsOf = (r, name, args) => realRequest(r, 'tools/call', { name, arguments: args || {} }, 120000);

// Shared logins (§11.3): this Claude session works in a tab of its own. It uses the blank tab Chrome starts with when
// that is all there is; otherwise it opens one (which comes to the front, where a page renders).
async function ensureTab(r) {
  if (r.tab || !shared || kind !== 'playwright') return;
  r.tab = true;
  const t = await supervisor('GET', '/tabs').catch(() => null);
  const tabs = (t && t.json && t.json.tabs) || [];
  if (tabs.length === 1 && tabs[0].url === 'about:blank') return;
  await argsOf(r, 'browser_tabs', { action: 'new' }).catch(() => undefined);
}

// A tab that isn't in front doesn't render, and a click waits forever for a frame: with more than one tab open, the
// session's current tab is brought forward before each call ("follow the agent", PRD §15.2).
async function toFront(r, st) {
  if (kind !== 'playwright' || !(st.tabCount > 1)) return;
  await argsOf(r, 'browser_run_code_unsafe', { code: 'async (page) => { await page.bringToFront(); }' }).catch(() => undefined);
}

// ---- a call ----
async function call(id, name, args) {
  debug('call', name);
  let st;
  try { st = await status(); } catch (e) { return reply(id, text('The browser is not available: ' + e.message, true)); }
  if (name === 'browser_status') return reply(id, text(await describe(st)));
  if (name === 'browser_handoff') return reply(id, await handoff(args || {}, st));
  if (st.control && st.control.held) {
    return reply(id, text('A person has control of the browser since ' + clock(st.control.since) + (st.control.label ? ' (' + st.control.label + ')' : '') + '. Wait a moment, then call browser_snapshot to see where it stands.', true));
  }
  if (!st.chrome || st.chrome.state !== 'up') {
    const w = await supervisor('POST', '/wake', {}, 45000).catch((e) => ({ status: 0, json: { error: e.message } }));
    if (w.status !== 200) return reply(id, text('The browser could not start: ' + ((w.json && w.json.error) || 'no answer') + '.', true));
    st = w.json;
    statusCache = { at: Date.now(), value: st };
  }
  debug('chrome is up; starting the server');
  supervisor('POST', '/activity', { tool: name, session: SESSION }).catch(() => undefined);
  let r;
  try {
    r = await ensureReal(st);
    await ensureTab(r);
    await toFront(r, st);
  } catch (e) {
    return reply(id, text(e.message, true));
  }
  let tool = name;
  let targs = args;
  if (name === 'browser_navigate_forward') { tool = 'browser_run_code_unsafe'; targs = { code: 'async (page) => { await page.goForward(); }' }; }
  else if (name === 'browser_reload') { tool = 'browser_run_code_unsafe'; targs = { code: 'async (page) => { await page.reload(); }' }; }
  debug('forwarding', tool);
  const res = await argsOf(r, tool, targs);
  if (res.error) return out({ jsonrpc: '2.0', id, error: res.error });
  reply(id, redactResult(res.result));
}

async function describe(st) {
  const lines = [];
  lines.push('Browser: ' + (st.chrome ? st.chrome.state : 'unknown') + ' (' + st.tier + ', ' + st.display.width + 'x' + st.display.height + ')');
  lines.push(st.control && st.control.held ? 'A person has control (' + (st.control.label || 'someone') + ' since ' + clock(st.control.since) + '). Browser tools wait.' : 'The agent has control.');
  if (st.chrome && st.chrome.state === 'up') {
    const t = await supervisor('GET', '/tabs').catch(() => null);
    const tabs = (t && t.json && t.json.tabs) || [];
    lines.push(tabs.length + ' open tab' + (tabs.length === 1 ? '' : 's') + (tabs.length ? ':' : ''));
    for (const x of tabs) lines.push('- ' + (x.title || '(untitled)') + ' ' + x.url);
  }
  if (st.idle && st.idle.stopAt) lines.push('Sleeps at ' + clock(st.idle.stopAt) + ' if unused.');
  return lines.join('\n');
}

// browser_handoff (§12.4): ask a person, then wait for the answer. Never wakes anything it doesn't need to.
async function handoff(args, st) {
  const reason = String(args.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!reason) return text('Say what the person should do in "reason".', true);
  if (st.chrome.state !== 'up') {
    const w = await supervisor('POST', '/wake', {}, 45000).catch((e) => ({ status: 0, json: { error: e.message } }));
    if (w.status !== 200) return text('The browser could not start: ' + ((w.json && w.json.error) || 'no answer') + '.', true);
  }
  // The person is shown the tab the agent is on, read from the browser (never from what the agent says): ask the pinned
  // server which tab is current, and let the supervisor find and bring forward the tab with that address.
  let tabUrl = null;
  try {
    const listed = await argsOf(await ensureReal(st), 'browser_tabs', { action: 'list' });
    const t = ((listed.result && listed.result.content) || []).map((c) => c.text || '').join('\n');
    const m = /^- \d+: \(current\) \[[\s\S]*?\]\((\S+?)\)\s*$/m.exec(t);
    tabUrl = m ? m[1] : null;
  } catch (e) { /* the supervisor falls back to the foreground tab */ }
  const made = await supervisor('POST', '/handoff', { reason, session: SESSION, tabUrl }).catch(() => null);
  if (!made || !made.json) return text('The browser supervisor is not reachable.', true);
  if (made.json.state === 'unavailable') return text(made.json.note || 'No live view for sign-in here.', true);
  let h = made.json;
  while (h.state === 'waiting' || h.state === 'in_control') {
    const next = await supervisor('GET', '/handoff/' + h.id + '?state=' + h.state, undefined, 30000).catch(() => null);
    if (!next || !next.json) return text('Lost contact with the browser supervisor while waiting.', true);
    h = next.json;
  }
  const note = h.note ? ': ' + h.note : '';
  switch (h.state) {
    case 'handed_back': return text('Handed back' + note + '. Check with browser_snapshot, not a screenshot.');
    case 'declined': return text('Declined' + note, true);
    case 'expired': return text('No response after 10 minutes of waiting.', true);
    case 'left': return text('The person left before finishing.', true);
    default: return text('The handoff ended (' + h.state + ').', true);
  }
}

// ---- the MCP loop ----
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch (e) { return; }
  void handle(m).catch((e) => { if (m.id !== undefined) fail(m.id, -32603, 'Internal error: ' + e.message); });
});
rl.on('close', () => shutdown());

async function handle(m) {
  if (m.method === undefined) { // the client answering a request of the real server's (roots/list)
    if (real && !real.dead) real.child.stdin.write(JSON.stringify(m) + '\n');
    return;
  }
  if (m.id === undefined) { // notification
    if (m.method === 'notifications/initialized') clientReady = true;
    else if (real && !real.dead) real.child.stdin.write(JSON.stringify(m) + '\n');
    return;
  }
  switch (m.method) {
    case 'initialize': {
      clientInit = m.params || null;
      const v = m.params && m.params.protocolVersion;
      return reply(m.id, {
        protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(v) ? v : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'claudepilot-' + SERVERS[kind].name, version: GATE_VERSION },
        instructions: kind === 'playwright'
          ? 'A shared browser a person can watch and take over. Prefer browser_snapshot to screenshots. Use one tab per task. For sign-ins, two-factor codes and CAPTCHAs call browser_handoff and wait; never type credentials yourself. Downloads land in ~/Downloads; never run a downloaded file.'
          : 'Chrome DevTools for the same shared browser: console, network, performance and Lighthouse.',
      });
    }
    case 'ping': return reply(m.id, {});
    case 'tools/list': return reply(m.id, { tools: allTools() });
    case 'resources/list': return reply(m.id, { resources: [] });
    case 'resources/templates/list': return reply(m.id, { resourceTemplates: [] });
    case 'prompts/list': return reply(m.id, { prompts: [] });
    case 'logging/setLevel': return reply(m.id, {});
    case 'tools/call': {
      const p = m.params || {};
      if (!allTools().some((t) => t.name === p.name)) return reply(m.id, text('Unknown tool ' + String(p.name).slice(0, 80), true));
      return call(m.id, p.name, p.arguments);
    }
    default: return fail(m.id, -32601, 'Method not found: ' + String(m.method).slice(0, 60));
  }
}

function shutdown() {
  try { if (real && !real.dead) real.child.kill(); } catch (e) { /* gone */ }
  setTimeout(() => process.exit(0), 50);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;

/** Where the gate is delivered. */
export const GATE_PATH = `${BROWSER_BIN}/browser-mcp`;
