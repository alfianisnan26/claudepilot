// Connect abuse run (docs/prd/targets-connect.md §19.3 T-SEC, §19.4 A9, §19.7): a hostile agent and a token thief against a SCRATCH portal, black box,
// over real HTTP and WebSockets. Never point it at a real portal: it signs in with the scratch code, makes targets and tokens, and floods.
//
//   scripts/scratch-portal.sh start 3413
//   cd apps/server && QA_PORT=3413 QA_CODE=24681372 npx tsx ../../tools/connect/abuse.mts [--only name,name] [--skip-slow]
//
// Each check prints `PASS|FAIL <name>: <what was observed>`; the exit code is the number of failures. Wrong-token floods come from a second
// address (ALT_HOST, default the first non-loopback IPv4 of this machine) so loopback is not locked out for the checks after them.
// PORTAL_PID (optional): the portal's pid, to report its resident memory around the floods. Tokens are never printed.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { CONNECT_PROTOCOL, CONNECT_SUBPROTOCOL } from '@portal/contracts';
import WebSocket from 'ws';
import { generateNodeKeyPair, signChallenge } from '../../apps/server/src/connect/tunnel/auth.js';
import { FRAME_FLAG, dataFrame, encodeHeader, pingFrame } from '../../apps/server/src/connect/tunnel/frame.js';

const PORT = Number(process.env.QA_PORT ?? 3413);
const CODE = process.env.QA_CODE ?? '24681372';
const LOCAL = `127.0.0.1:${PORT}`;
const altIp = process.env.ALT_HOST ?? Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
const ALT = altIp ? `${altIp}:${PORT}` : null;
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1]!.split(',')) : null;
const skipSlow = args.includes('--skip-slow');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function report(ok: boolean, name: string, what: string) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${what}`);
}
async function check(name: string, fn: () => Promise<[boolean, string]>, slow = false) {
  if (only && !only.has(name)) return;
  if (slow && skipSlow) return console.log(`SKIP ${name} (slow)`);
  try {
    const [ok, what] = await fn();
    report(ok, name, what);
  } catch (e) {
    report(false, name, `threw ${(e as Error).message}`);
  }
}
const rss = () => {
  const pid = process.env.PORTAL_PID;
  if (!pid) return null;
  try {
    return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0) / 1024;
  } catch {
    return null;
  }
};

// ---- the admin side (the scratch portal's sign-in) -----------------------------------------------------------------------------------
let cookie = '';
async function admin(method: string, path: string, body?: unknown): Promise<{ status: number; data: any; text: string }> {
  if (!cookie) {
    const r = await fetch(`http://localhost:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${PORT}` }, body: JSON.stringify({ code: CODE }) });
    cookie = /portal_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1] ?? '';
    if (!cookie) throw new Error(`sign-in failed (${r.status})`);
  }
  const r = await fetch(`http://localhost:${PORT}${path}`, { method, headers: { Cookie: `portal_session=${cookie}`, Origin: `http://localhost:${PORT}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, data: json?.data, text };
}
const suffix = randomBytes(3).toString('hex');
async function newHostTarget(id: string, extra: Record<string, unknown> = {}) {
  const r = await admin('POST', '/api/connect/targets', { kind: 'host', platform: 'linux', id: `${id}-${suffix}`, portalUrl: `http://127.0.0.1:${PORT}`, options: { hostAccess: true }, ...extra });
  if (r.status !== 201) throw new Error(`target ${id}: ${r.status} ${r.text.slice(0, 200)}`);
  return { target: r.data.target.id as string, enrollment: r.data.enrollment.id as string, token: r.data.token as string };
}

// ---- the agent side --------------------------------------------------------------------------------------------------------------------
const hello = (over: Record<string, unknown> = {}) => ({
  agentVersion: '0.0.0-abuse',
  agentBuild: '000000000000',
  protocol: CONNECT_PROTOCOL,
  os: 'linux',
  arch: 'x64',
  hostname: 'abuse',
  mode: 'host',
  runtime: 'host',
  services: [{ name: 'host', ok: true }],
  clock: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  ...over,
});
async function enroll(host: string, token: string | null, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`http://${host}/connect/v1/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let reason = '';
  try {
    reason = JSON.parse(text)?.error?.details?.reason ?? '';
  } catch {
    /* not JSON */
  }
  return { status: r.status, reason, text };
}
interface Rogue {
  node: string;
  privateKey: string;
  target: string;
}
async function rogue(id: string): Promise<Rogue> {
  const t = await newHostTarget(id);
  const keys = generateNodeKeyPair();
  const r = await enroll(LOCAL, t.token, { publicKey: keys.publicKey, hello: hello(), nodeName: 'rogue' });
  if (r.status !== 200) throw new Error(`enroll ${id}: ${r.status} ${r.text.slice(0, 200)}`);
  return { node: JSON.parse(r.text).data.node, privateKey: keys.privateKey, target: t.target };
}

interface Sock {
  ws: WebSocket;
  texts: string[];
  binaries: Buffer[];
  closed: Promise<{ code: number; reason: string }>;
  opened: Promise<{ status: number } | 'open'>;
  challenge: () => Promise<{ connId: string; nonce: string }>;
}
function dial(headers: Record<string, string> = {}, protocols: string[] = [CONNECT_SUBPROTOCOL], host = LOCAL): Sock {
  const ws = new WebSocket(`ws://${host}/connect/v1/tunnel`, protocols, { headers, perMessageDeflate: false, maxPayload: 2 << 20 });
  const texts: string[] = [];
  const binaries: Buffer[] = [];
  let firstText: (m: string) => void = () => undefined;
  const first = new Promise<string>((r) => (firstText = r));
  ws.on('message', (d, bin) => {
    if (bin) binaries.push(d as Buffer);
    else {
      texts.push(String(d));
      if (texts.length === 1) firstText(String(d));
    }
  });
  ws.on('error', () => undefined);
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })));
  const opened = new Promise<{ status: number } | 'open'>((r) => {
    ws.on('open', () => r('open'));
    ws.on('unexpected-response', (_q, res) => r({ status: res.statusCode ?? 0 }));
  });
  return { ws, texts, binaries, closed, opened, challenge: async () => JSON.parse(await first) };
}
const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'timeout'> => Promise.race([p, sleep(ms).then(() => 'timeout' as const)]);
async function authed(r: Rogue, over: Record<string, unknown> = {}): Promise<Sock & { welcome: any }> {
  const s = dial();
  const ch = await s.challenge();
  s.ws.send(JSON.stringify({ t: 'auth', node: r.node, sig: signChallenge(r.privateKey, ch.connId, ch.nonce, r.node), hello: hello(over) }));
  for (let i = 0; i < 100 && s.texts.length < 2; i++) await sleep(20);
  return Object.assign(s, { welcome: s.texts[1] ? JSON.parse(s.texts[1]) : null });
}
const rejectOf = (s: Sock) => (s.texts[1] ? JSON.parse(s.texts[1]) : null) as { t: string; code: string } | null;

// ---- the checks --------------------------------------------------------------------------------------------------------------------------
console.log(`Connect abuse run against ${LOCAL} (second address ${ALT ?? 'none'}), ${new Date().toISOString()}`);

await check('origin', async () => {
  const s = dial({ Origin: 'https://evil.example' });
  const o = await within(s.opened, 3000);
  return [typeof o === 'object' && o.status === 403, `an upgrade with an Origin header: ${JSON.stringify(o)}`];
});
await check('subprotocol', async () => {
  const s = dial({}, ['something.else']);
  const o = await within(s.opened, 3000);
  return [typeof o === 'object' && o.status === 400, `an upgrade without pilot.tunnel.v1: ${JSON.stringify(o)}`];
});
await check('first-binary', async () => {
  const s = dial();
  await s.challenge();
  s.ws.send(Buffer.from('xx'));
  const c = await within(s.closed, 4000);
  return [rejectOf(s)?.code === 'bad_request', `binary before the handshake: ${s.texts[1] ?? '-'} close ${JSON.stringify(c)}`];
});
await check('first-oversize', async () => {
  const s = dial();
  await s.challenge();
  s.ws.send('x'.repeat(9000));
  const c = await within(s.closed, 4000);
  return [c !== 'timeout' && c.code === 1009, `a 9,000 byte first message: close ${JSON.stringify(c)}`];
});
await check('first-garbage', async () => {
  const s = dial();
  await s.challenge();
  s.ws.send('{not json');
  const c = await within(s.closed, 4000);
  return [rejectOf(s)?.code === 'bad_request', `not JSON: ${s.texts[1] ?? '-'} close ${JSON.stringify(c)}`];
});
await check('forged-node', async () => {
  const s = dial();
  const ch = await s.challenge();
  const fake = `nd_${randomBytes(6).toString('hex')}`;
  const k = generateNodeKeyPair();
  s.ws.send(JSON.stringify({ t: 'auth', node: fake, sig: signChallenge(k.privateKey, ch.connId, ch.nonce, fake), hello: hello() }));
  const c = await within(s.closed, 4000);
  return [rejectOf(s)?.code === 'unknown_node', `a node id the portal never issued: ${rejectOf(s)?.code} close ${JSON.stringify(c)}`];
});

let r1: Rogue | null = null;
await check('forged-key', async () => {
  r1 ??= await rogue('abuse-a');
  const s = dial();
  const ch = await s.challenge();
  const k = generateNodeKeyPair();
  s.ws.send(JSON.stringify({ t: 'auth', node: r1.node, sig: signChallenge(k.privateKey, ch.connId, ch.nonce, r1.node), hello: hello() }));
  const c = await within(s.closed, 4000);
  return [rejectOf(s)?.code === 'bad_signature', `a real node id signed with another key: ${rejectOf(s)?.code} close ${JSON.stringify(c)}`];
});
await check('replayed-signature', async () => {
  r1 ??= await rogue('abuse-a');
  const a = dial();
  const ch = await a.challenge();
  const sig = signChallenge(r1.privateKey, ch.connId, ch.nonce, r1.node);
  a.ws.close();
  const b = dial();
  await b.challenge();
  b.ws.send(JSON.stringify({ t: 'auth', node: r1.node, sig, hello: hello() })); // the signature of another connection's challenge
  await within(b.closed, 4000);
  return [rejectOf(b)?.code === 'bad_signature', `a valid signature from another connection: ${rejectOf(b)?.code}`];
});
await check('protocol-0', async () => {
  r1 ??= await rogue('abuse-a');
  const s = await authed(r1, { protocol: 0 });
  await within(s.closed, 4000);
  return [rejectOf(s)?.code === 'upgrade_required', `an agent that says protocol 0: ${rejectOf(s)?.code}`];
});
await check('duplicate', async () => {
  r1 ??= await rogue('abuse-a');
  const a = await authed(r1);
  const b = await authed(r1);
  await within(b.closed, 4000);
  const firstOpen = a.ws.readyState === WebSocket.OPEN;
  const ok = a.welcome?.t === 'welcome' && rejectOf(b)?.code === 'already_connected' && firstOpen;
  a.ws.terminate();
  await a.closed;
  return [ok, `the first got ${a.welcome?.t}, a second with the same key ${rejectOf(b)?.code}, the first still open: ${firstOpen}`];
});
// After the welcome: what a rogue agent can send. Each opens its own connection (the previous one was terminated: the next waits for the portal to see it).
async function fresh(): Promise<Sock & { welcome: any }> {
  r1 ??= await rogue('abuse-a');
  for (let i = 0; i < 40; i++) {
    const s = await authed(r1);
    if (s.welcome?.t === 'welcome') return s;
    await sleep(250);
  }
  throw new Error('no welcome');
}
await check('text-after-welcome', async () => {
  const s = await fresh();
  s.ws.send('{"t":"status"}');
  const c = await within(s.closed, 4000);
  return [c !== 'timeout' && c.code === 1002, `a TEXT message after welcome: close ${JSON.stringify(c)}`];
});
await check('oversize-message', async () => {
  const s = await fresh();
  s.ws.send(Buffer.alloc((1 << 20) + 16));
  const c = await within(s.closed, 4000);
  return [c !== 'timeout' && c.code === 1009, `a 1 MiB + 16 byte binary message: close ${JSON.stringify(c)}`];
});
await check('oversize-frame', async () => {
  const s = await fresh();
  s.ws.send(Buffer.concat([encodeHeader({ type: 0, flags: FRAME_FLAG.syn, streamId: 3, length: 70_000 }), Buffer.alloc(70_000)]));
  const c = await within(s.closed, 4000);
  return [c !== 'timeout' && c.code === 1002, `a DATA frame of 70,000 bytes: close ${JSON.stringify(c)}`];
});
await check('bad-frames', async () => {
  const seen: string[] = [];
  for (const [what, frame] of [
    ['unknown type 7', encodeHeader({ type: 7, flags: 0, streamId: 0, length: 0 })],
    ['version 1', Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['the portal’s parity (even id)', dataFrame(2, FRAME_FLAG.syn, Buffer.from('x'))],
    ['a stream never opened', dataFrame(9, 0, Buffer.from('x'))],
    ['a ping on a stream', encodeHeader({ type: 2, flags: FRAME_FLAG.syn, streamId: 5, length: 1 })],
  ] as const) {
    const s = await fresh();
    s.ws.send(frame);
    const c = await within(s.closed, 4000);
    seen.push(`${what}: ${c === 'timeout' ? 'still open' : c.code}`);
  }
  return [seen.every((x) => x.endsWith(': 1002')), seen.join('; ')];
});
await check('short-frame', async () => {
  // A header that announces 100 bytes and delivers 10: the portal waits for the rest (a frame may span messages) and the ping keeps the
  // connection alive; the next header is read as payload. Whatever it parses afterwards, it must not crash and must stay bounded.
  const s = await fresh();
  s.ws.send(Buffer.concat([encodeHeader({ type: 0, flags: FRAME_FLAG.syn, streamId: 1, length: 100 }), Buffer.alloc(10)]));
  s.ws.send(Buffer.concat([pingFrame(false, 1)]));
  const c = await within(s.closed, 2000);
  const health = await fetch(`http://${LOCAL}/connect/v1/health`).then((r) => r.status);
  s.ws.terminate();
  return [health === 200, `a frame shorter than its length: ${c === 'timeout' ? 'held open, waiting for the rest' : `closed ${c.code}`}; the portal answers health ${health}`];
});
await check('streams-as-agent', async () => {
  // An agent may open control and nothing else (FR23): a docker stream and a second control are refused with bad_open.
  const s = await fresh();
  const line = (o: unknown) => Buffer.from(`${JSON.stringify(o)}\n`);
  s.ws.send(dataFrame(1, FRAME_FLAG.syn, line({ v: 1, service: 'control', trace: 'aaaa0001' })));
  s.ws.send(dataFrame(3, FRAME_FLAG.syn, line({ v: 1, service: 'docker', trace: 'aaaa0002' })));
  s.ws.send(dataFrame(5, FRAME_FLAG.syn, line({ v: 1, service: 'control', trace: 'aaaa0003' })));
  s.ws.send(dataFrame(7, FRAME_FLAG.syn, line({ v: 1, service: 'tcp', trace: 'aaaa0004', args: { host: '169.254.169.254', port: 80 } })));
  await sleep(800);
  const text = s.binaries.map((b) => b.toString('latin1')).join('');
  const refusals = (text.match(/"code":"bad_open"/g) ?? []).length;
  s.ws.terminate();
  return [refusals === 3 && /"ok":true/.test(text), `control accepted: ${/"ok":true/.test(text)}; docker, a second control and tcp to the metadata address refused bad_open: ${refusals} of 3`];
});
await check('control-flood', async () => {
  // Status lines at 200 a second and a 300 KiB line: the first are ignored past the burst, the long one ends the connection.
  const s = await fresh();
  s.ws.send(dataFrame(1, FRAME_FLAG.syn, Buffer.from('{"v":1,"service":"control","trace":"aaaa0001"}\n')));
  await sleep(200);
  for (let i = 0; i < 200; i++) s.ws.send(dataFrame(1, 0, Buffer.from(`{"t":"status","services":[{"name":"host","ok":true}],"n":${i}}\n`)));
  for (let i = 0; i < 60; i++) s.ws.send(dataFrame(1, 0, Buffer.from(`{"t":"log","level":"warn","message":"flood ${i}"}\n`)));
  await sleep(300);
  const open = s.ws.readyState === WebSocket.OPEN;
  // 300 KiB in frames of 64 KiB, no newline until the end: past the 256 KiB line limit (the window is 256 KiB: the portal reads as it goes)
  const chunk = Buffer.alloc(60_000, 0x61);
  for (let i = 0; i < 5; i++) s.ws.send(dataFrame(1, 0, chunk));
  const c = await within(s.closed, 5000);
  const ev = await admin('GET', `/api/connect/targets/${r1!.target}/events?limit=200`);
  const logs = (ev.data ?? []).filter((e: any) => e.type === 'agent.log').length;
  return [open && c !== 'timeout' && logs <= 20, `after 200 status and 60 log lines the connection was ${open ? 'open' : 'closed'}; agent.log rows kept: ${logs} (cap 20 a minute); a 300 KB line: ${c === 'timeout' ? 'still open' : `closed ${c.code}`}`];
});
await check('ping-flood-no-read', async () => {
  // The agent stops reading its socket and floods pings: before the T6 fix every answer waited in an unbounded queue.
  const s = await fresh();
  const before = rss();
  const raw = (s.ws as unknown as { _socket: import('node:net').Socket })._socket;
  raw.pause(); // read nothing: the portal's answers pile up in its send buffer, then in its queue
  const burst = Buffer.concat(Array.from({ length: 80_000 }, (_, i) => pingFrame(false, i)));
  const t0 = Date.now();
  let sent = 0;
  while (Date.now() - t0 < 8000 && s.ws.readyState === WebSocket.OPEN) {
    if (s.ws.bufferedAmount < 8 << 20) {
      s.ws.send(burst);
      sent += 80_000;
    }
    await sleep(5);
  }
  raw.resume();
  const c = await within(s.closed, 3000);
  const after = rss();
  s.ws.terminate();
  const growth = before !== null && after !== null ? `, portal RSS ${before.toFixed(0)} -> ${after.toFixed(0)} MB` : '';
  return [c !== 'timeout' && c.code === 1002, `${sent.toLocaleString('en')} pings while reading nothing: ${c === 'timeout' ? 'connection still open' : `closed ${c.code}`}${growth}`];
});

// ---- tokens (A9) -------------------------------------------------------------------------------------------------------------------------
await check('token-forged', async () => {
  const r = await enroll(LOCAL, `cpen_${randomBytes(32).toString('base64url')}`, { publicKey: generateNodeKeyPair().publicKey, hello: hello() });
  return [r.status === 401 && r.reason === 'token_invalid', `a token-shaped guess: ${r.status} ${r.reason}`];
});
await check('token-replayed', async () => {
  const t = await newHostTarget('abuse-b');
  const first = await enroll(LOCAL, t.token, { publicKey: generateNodeKeyPair().publicKey, hello: hello() });
  const again = await enroll(LOCAL, t.token, { publicKey: generateNodeKeyPair().publicKey, hello: hello() });
  const nodes = (await admin('GET', `/api/connect/targets/${t.target}`)).data?.nodes?.length;
  return [first.status === 200 && again.status === 401 && again.reason === 'token_used' && nodes === 1, `first use ${first.status}, the same token again ${again.status} ${again.reason}; nodes on the target: ${nodes}`];
});
await check('token-revoked', async () => {
  const t = await newHostTarget('abuse-c');
  const del = await admin('DELETE', `/api/connect/targets/${t.target}/enrollments/${t.enrollment}`);
  const r = await enroll(LOCAL, t.token, { publicKey: generateNodeKeyPair().publicKey, hello: hello() });
  const plan = await fetch(`http://${LOCAL}/connect/v1/plan`, { headers: { Authorization: `Bearer ${t.token}` } }).then((x) => x.status);
  return [r.status === 401 && r.reason === 'token_revoked' && plan === 401, `revoke ${del.status}; enroll ${r.status} ${r.reason}; plan ${plan}`];
});
await check('token-bad-requests', async () => {
  const t = await newHostTarget('abuse-d');
  const k = generateNodeKeyPair().publicKey;
  const origin = await enroll(LOCAL, t.token, { publicKey: k, hello: hello() }, { Origin: `http://localhost:${PORT}` });
  const big = await enroll(LOCAL, t.token, JSON.stringify({ publicKey: k, hello: hello(), pad: 'x'.repeat(20_000) }));
  const notJson = await enroll(LOCAL, t.token, '{nope');
  const badKey = await enroll(LOCAL, t.token, { publicKey: Buffer.alloc(32, 0).toString('base64url'), hello: hello() });
  const shortKey = await enroll(LOCAL, t.token, { publicKey: 'AAAA', hello: hello() });
  const wrongMode = await enroll(LOCAL, t.token, { publicKey: k, hello: hello({ mode: 'docker' }) });
  const still = await enroll(LOCAL, t.token, { publicKey: k, hello: hello() });
  const rows = [origin, big, notJson, badKey, shortKey, wrongMode].map((r) => `${r.status}${r.reason ? ` ${r.reason}` : ''}`);
  const ok = origin.status === 403 && big.status === 413 && notJson.status === 400 && badKey.status === 422 && shortKey.status === 422 && wrongMode.status >= 400 && still.status === 200;
  return [ok, `Origin, 20 KB body, not JSON, an all-zero key, a short key, the wrong mode: ${rows.join(', ')}; the token still works afterwards: ${still.status}`];
});
await check('token-expired', async () => {
  const t = await newHostTarget('abuse-e', { ttlMinutes: 1 });
  await sleep(62_000);
  const r = await enroll(LOCAL, t.token, { publicKey: generateNodeKeyPair().publicKey, hello: hello() });
  return [r.status === 401 && r.reason === 'token_expired', `a token one minute old after 62 s: ${r.status} ${r.reason}`];
}, true);
await check('token-flood', async () => {
  if (!ALT) return [false, 'no second address to flood from'];
  const t = await newHostTarget('abuse-f');
  const codes: string[] = [];
  for (let i = 0; i < 11; i++) {
    const r = await enroll(ALT, `cpen_${randomBytes(32).toString('base64url')}`, { publicKey: generateNodeKeyPair().publicKey, hello: hello() });
    codes.push(String(r.status));
  }
  const goodFromAlt = await enroll(ALT, t.token, { publicKey: generateNodeKeyPair().publicKey, hello: hello() });
  const goodFromLocal = await enroll(LOCAL, t.token, { publicKey: generateNodeKeyPair().publicKey, hello: hello() });
  const ok = codes.slice(0, 10).every((c) => c === '401') && codes[10] === '429' && goodFromAlt.status === 429 && goodFromLocal.status === 200;
  return [ok, `11 wrong tokens from ${altIp}: ${codes.join(' ')}; then the right token from there ${goodFromAlt.status}, from loopback ${goodFromLocal.status}`];
});
await check('enroll-flood', async () => {
  // 400 enroll calls in a burst from one address with junk bodies (no token): the per-address request limit (300 a minute) answers 429.
  if (!ALT) return [false, 'no second address'];
  const statuses = new Map<number, number>();
  await Promise.all(
    Array.from({ length: 400 }, async () => {
      const r = await fetch(`http://${ALT}/connect/v1/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
    }),
  );
  const health = await fetch(`http://${LOCAL}/connect/v1/health`).then((r) => r.status);
  return [(statuses.get(429) ?? 0) > 0 && health === 200, `statuses ${JSON.stringify(Object.fromEntries(statuses))}; health from loopback ${health}`];
});

// ---- pre-auth floods (last: they use up the per-address upgrade budget of loopback for a minute) ----------------------------------------
await check('preauth-slots', async () => {
  if (!ALT) return [false, 'no second address'];
  const socks = Array.from({ length: 6 }, () => dial({}, [CONNECT_SUBPROTOCOL], ALT));
  const outcomes = await Promise.all(socks.map((s) => within(s.opened, 3000)));
  const refused = outcomes.filter((o) => typeof o === 'object' && o.status === 429).length;
  for (const s of socks) s.ws.terminate();
  return [refused === 1, `six silent sockets from one address: ${outcomes.map((o) => (typeof o === 'object' ? o.status : o)).join(', ')}`];
});
await check('preauth-silence', async () => {
  const s = dial({}, [CONNECT_SUBPROTOCOL], ALT ?? LOCAL);
  await s.challenge();
  const t0 = Date.now();
  const c = await within(s.closed, 15_000);
  return [c !== 'timeout' && c.code === 4408 && Date.now() - t0 < 12_000, `a socket that never authenticates: ${c === 'timeout' ? 'open after 15 s' : `closed ${c.code} after ${Date.now() - t0} ms`}`];
}, true);
await check('upgrade-rate', async () => {
  if (!ALT) return [false, 'no second address'];
  let limited = 0;
  for (let i = 0; i < 32; i++) {
    const s = dial({}, [CONNECT_SUBPROTOCOL], ALT);
    const o = await within(s.opened, 3000);
    if (o === 'open') {
      // a limited address gets its reject at once, in place of the challenge
      await within(s.challenge(), 2000);
      if (!s.texts.some((t) => t.includes('"rate_limited"'))) s.ws.send('{"t":"auth","node":"nd_000000000000","sig":"x","hello":{}}');
      await within(s.closed, 3000);
      if (s.texts.some((t) => t.includes('"rate_limited"'))) limited++;
    }
    s.ws.terminate();
  }
  return [limited >= 1, `32 upgrades in a row from one address: ${limited} answered rate_limited (30 a minute allowed)`];
});

console.log(`${failures} failed`);
process.exit(failures);
