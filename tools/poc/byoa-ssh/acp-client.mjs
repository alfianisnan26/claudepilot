// A minimal ACP client: runs an agent over `ssh` (through the pilot tunnel) and speaks JSON-RPC on its stdio:
// initialize -> session/new -> session/prompt, printing session/update chunks. Permission requests are answered "cancelled".
import { spawn } from 'node:child_process'; import readline from 'node:readline';
const [cfg, ...remote] = process.argv.slice(2);
const ch = spawn('ssh', ['-F', cfg, 'poc-ws', remote.join(' ')], { stdio: ['pipe', 'pipe', 'pipe'] });
let n = 0; const wait = new Map(); const t0 = Date.now(); const ms = () => String(Date.now() - t0).padStart(5) + 'ms';
const send = (method, params) => new Promise((res) => { const id = ++n; wait.set(id, res); ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
let err = ''; ch.stderr.on('data', (d) => (err += d));
readline.createInterface({ input: ch.stdout }).on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id != null && wait.has(m.id)) { const r = wait.get(m.id); wait.delete(m.id); return r(m); }
  if (m.method === 'session/update') { const u = m.params.update; const txt = u.content?.text ?? ''; console.log(ms(), 'update', u.sessionUpdate, JSON.stringify(txt).slice(0, 90)); return; }
  if (m.method === 'session/request_permission') { ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } }) + '\n'); return; }
  if (m.id != null && m.method) { ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported' } }) + '\n'); }
});
const done = (c) => { ch.stdin.end(); setTimeout(() => process.exit(c), 300); };
setTimeout(() => { console.log(ms(), 'TIMEOUT; stderr:', err.slice(-300)); done(2); }, 90000);
const init = await send('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
if (init.error) { console.log(ms(), 'initialize error', JSON.stringify(init.error)); done(1); await new Promise(() => {}); }
const r = init.result; console.log(ms(), 'initialize ok: protocol', r.protocolVersion, '| agent', JSON.stringify(r.agentInfo ?? null), '| auth methods', JSON.stringify((r.authMethods || []).map((a) => a.id)));
const s = await send('session/new', { cwd: process.env.ACP_CWD, mcpServers: [] });
if (s.error) { console.log(ms(), 'session/new error', JSON.stringify(s.error).slice(0, 200)); done(1); await new Promise(() => {}); }
console.log(ms(), 'session/new ok:', s.result.sessionId);
const p = await send('session/prompt', { sessionId: s.result.sessionId, prompt: [{ type: 'text', text: 'say hi' }] });
console.log(ms(), 'session/prompt', p.error ? 'error ' + JSON.stringify(p.error).slice(0, 200) : 'stopReason ' + p.result.stopReason);
done(0);
