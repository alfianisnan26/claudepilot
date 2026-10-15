// PoC stand-in for the portal's SSH route (docs/prd/workspace-ssh.md v0.2 section 4): a WebSocket per connection, bearer token -> person,
// then `sudo sshd -i` in the workspace through `docker exec`, bytes piped both ways. Admin port: revoke a person, list live connections.
import { createRequire } from 'node:module'; import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http'; import fs from 'node:fs'; import crypto from 'node:crypto'; import path from 'node:path';
const require = createRequire(process.env.POC_REQUIRE_FROM || new URL('../../../package.json', import.meta.url)); const { WebSocketServer } = require('ws'); // ws from the repo's node_modules
const DIR = process.env.POC_STATE, CTR = 'cp-poc-ws'; // state/ and desk/ live here (poc.sh)
const tokens = () => JSON.parse(fs.readFileSync(path.join(DIR, 'state/tokens.json'), 'utf8'));
const audit = (o) => fs.appendFileSync(path.join(DIR, 'state/connections.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');
const put = (file, content, owner, mode) => execFileSync('docker', ['exec', '-i', '-u', 'root', CTR, 'sh', '-c',
  `d=$(dirname "$1"); mkdir -p "$d"; chmod 755 "$d"; cat > "$1"; chown "$2" "$1"; chmod "$3" "$1"`, 'put', file, owner, mode], { input: content });
const live = new Map(); // connId -> { person, ws, child }
const wss = new WebSocketServer({ noServer: true });
const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
server.on('upgrade', (req, socket, head) => {
  const m = /^\/api\/ssh\/([\w-]+)$/.exec(req.url || '');
  const tok = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
  const row = tok && tokens()[crypto.createHash('sha256').update(tok).digest('hex')];
  if (!m || !row || row.revoked || m[1] !== row.workspace) { // the same 404 for every refusal
    audit({ kind: 'ssh.refused', workspace: m?.[1] ?? null, reason: !tok ? 'no token' : !row ? 'unknown token' : row.revoked ? 'revoked' : 'workspace' });
    socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => open(ws, row.person, m[1]));
});
function open(ws, person, workspace) {
  const id = crypto.randomBytes(4).toString('hex'), cdir = `/etc/claudepilot/ssh/conn/${id}`, t0 = Date.now();
  const key = fs.readFileSync(path.join(DIR, `desk/${person}/id_ed25519.pub`), 'utf8');
  put(`${cdir}/authorized_keys`, key, 'root:root', '644');
  const others = [...new Set([...live.values()].filter((c) => c.workspace === workspace && c.person !== person).map((c) => c.person))];
  put(`${cdir}/welcome`, `\n  pilot · workspace ${workspace} · you are ${person} (connection ${id})\n  agent: run \`claude\` and /login with YOUR account (one sign-in per workspace)\n  online now: ${others.length ? others.join(', ') : 'only you'}\n  tickets: T-370 S0 spike (high) · T-371 S1 transport\n  rules: work on dev/* branches, never main; claim a ticket before you start\n\n`, `p-${person}:pilot-people`, '400');
  const child = spawn('docker', ['exec', '-i', '-u', 'node', CTR, 'sudo', '/usr/sbin/sshd', '-i', '-e', '-f', '/etc/claudepilot/ssh/sshd_config',
    '-o', `AuthorizedKeysFile=${cdir}/authorized_keys`, '-o', `AllowUsers=p-${person}`, '-o', `SetEnv=PILOT_PERSON=${person} PILOT_CONN_ID=${id}`]);
  const log = fs.createWriteStream(path.join(DIR, `state/sshd-${id}.log`)); child.stderr.pipe(log);
  let bin = 0, bout = 0, reason = 'closed by client';
  live.set(id, { person, workspace, ws, child });
  audit({ kind: 'ssh.open', id, person, workspace });
  ws.on('message', (d) => { bin += d.length; child.stdin.write(d); });
  child.stdout.on('data', (d) => { bout += d.length; ws.send(d); });
  const end = () => {
    if (!live.has(id)) return; live.delete(id);
    try { child.stdin.end(); } catch {} child.kill();
    // a normal close leaves detached processes (the VS Code server survives reconnects); a revocation ends all of the person's
    let k = ''; if (reason === 'revoked') try { k = execFileSync('docker', ['exec', '-u', 'root', CTR, '/etc/claudepilot/bin/kill-person', person]).toString().trim(); } catch {}
    try { execFileSync('docker', ['exec', '-u', 'root', CTR, 'rm', '-rf', cdir]); } catch {}
    audit({ kind: 'ssh.close', id, person, workspace, ms: Date.now() - t0, bytesIn: bin, bytesOut: bout, reason, cleanup: k });
  };
  ws.on('close', end); child.on('exit', () => { reason = reason === 'closed by client' ? 'sshd exited' : reason; ws.close(); end(); });
  ws._revoke = () => { reason = 'revoked'; ws.close(1008, 'revoked'); end(); };
}
server.listen(7788, '127.0.0.1');
http.createServer((req, res) => { // admin (local only)
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/revoke') {
    const person = u.searchParams.get('person'), t = tokens();
    for (const h in t) if (t[h].person === person) t[h].revoked = true;
    fs.writeFileSync(path.join(DIR, 'state/tokens.json'), JSON.stringify(t));
    let n = 0; for (const c of [...live.values()]) if (c.person === person) { c.ws._revoke(); n++; }
    // also with no live connection: a detached process (the VS Code server) outlives its connection
    let k = ''; try { k = execFileSync('docker', ['exec', '-u', 'root', CTR, '/etc/claudepilot/bin/kill-person', person]).toString().trim(); } catch {}
    audit({ kind: 'ssh.revoke', person, closed: n, cleanup: k }); res.end(`revoked ${person}, closed ${n}, ${k}\n`); return;
  }
  if (u.pathname === '/live') { res.end(JSON.stringify([...live.entries()].map(([id, c]) => ({ id, person: c.person, workspace: c.workspace }))) + '\n'); return; }
  res.writeHead(404); res.end();
}).listen(7789, '127.0.0.1');
console.log('bridge ready 7788 (ssh), 7789 (admin)');
