// T-AGENT: how the agent treats a portal that refuses it, speaks a protocol it doesn't, or breaks the rules (docs/prd/targets-connect.md §9.2, §9.6,
// FR23, FR25), against a minimal fake portal built on the tunnel library's server side. Refusals have their own waits (an hour for the fatal ones,
// `retryAfterS` for a busy portal), a portal that speaks only newer protocols is `upgrade_required`, and the agent opens exactly one stream: control.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { CONNECT_LIMITS, CONNECT_SUBPROTOCOL, type ConnectAuth } from '@portal/contracts';
import { generateNodeKeyPair, verifyChallenge } from '../tunnel/auth.js';
import { acceptService, MuxSession, TUNNEL_WS_OPTIONS, WsMuxSocket, type MuxStream } from '../tunnel/index.js';
import { runAgent, type AgentClock, type AgentHandle } from './client.js';
import { FileIdentityStore } from './identity.js';
import { collectingLogger } from './log.js';
import { agentConfig } from './testkit/agentConfig.js';

type Behaviour = (ws: WebSocket, auth: ConnectAuth, challenge: { connId: string; nonce: string }) => void;

let server: Server;
let wss: WebSocketServer;
let behaviour: Behaviour = () => undefined;
let protocol = { min: 1, max: 1 };
let port = 0;
let dir: string;
const agents: AgentHandle[] = [];
const keys = generateNodeKeyPair();
const NODE = 'nd_0123456789ab';
const handshakes: ConnectAuth[] = [];

before(async () => {
  server = createServer();
  wss = new WebSocketServer({ server, ...TUNNEL_WS_OPTIONS, handleProtocols: (p) => (p.has(CONNECT_SUBPROTOCOL) ? CONNECT_SUBPROTOCOL : false) });
  wss.on('connection', (ws) => {
    const challenge = { connId: 'c0ffee00-0000-4000-8000-000000000001', nonce: Buffer.alloc(32, 9).toString('base64url') };
    ws.send(JSON.stringify({ t: 'challenge', v: 1, ...challenge, serverTime: new Date().toISOString(), protocol }));
    ws.once('message', (data) => {
      const auth = JSON.parse(data.toString()) as ConnectAuth;
      handshakes.push(auth);
      behaviour(ws, auth, challenge);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
after(async () => {
  for (const c of wss.clients) c.terminate();
  wss.close();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cx2-proto-'));
  mkdirSync(join(dir, 'home'));
  await new FileIdentityStore(join(dir, 'agent')).save({ node: NODE, target: 'lab', portalUrl: `http://127.0.0.1:${port}`, portalId: null, privateKey: keys.privateKey, publicKey: keys.publicKey, enrolledAt: new Date().toISOString() });
  handshakes.length = 0;
  protocol = { min: 1, max: 1 };
});
afterEach(async () => {
  behaviour = () => undefined;
  for (const a of agents.splice(0)) await a.stop().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

const until = async (fn: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const fakeClock = () => {
  const sleeps: number[] = [];
  let release: (() => void) | null = null;
  const clock: AgentClock = {
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        sleeps.push(ms);
        release = resolve;
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    now: () => Date.now(),
    random: () => 0.5,
  };
  return { clock, sleeps, go: () => release?.() };
};
const start = (clock?: AgentClock) => {
  const log = collectingLogger();
  const h = runAgent({ config: agentConfig({ dataDir: join(dir, 'agent'), home: join(dir, 'home'), url: `http://127.0.0.1:${port}` }), log: log.logger, build: 'abcabcabcabc', ...(clock ? { clock } : {}) });
  agents.push(h);
  return { h, log };
};

describe('a portal that refuses, and one that speaks another protocol', () => {
  it('signs the challenge with the node key (the contract’s message) and says who it is', async () => {
    behaviour = (ws, auth, c) => {
      ws.send(JSON.stringify({ t: 'reject', code: 'revoked', message: 'stop here' }));
      assert.equal(verifyChallenge(keys.publicKey, auth.sig, c.connId, c.nonce, NODE), true, 'the signature verifies');
      ws.close(4401);
    };
    const fc = fakeClock();
    start(fc.clock);
    await until(() => fc.sleeps.length >= 1);
    assert.equal(handshakes[0]!.node, NODE);
    assert.equal(handshakes[0]!.hello.mode, 'host');
    assert.equal(handshakes[0]!.hello.protocol, 1);
    assert.equal(fc.sleeps[0], CONNECT_LIMITS.reconnect.fatalMs, 'revoked is fatal: an hour');
  });

  it('upgrade_required (the portal only speaks newer protocols) waits an hour and never exits', async () => {
    protocol = { min: 2, max: 3 };
    const fc = fakeClock();
    const { h, log } = start(fc.clock);
    const refused: string[] = [];
    h.events.on('refused', (r) => refused.push(`${r.code}:${r.fatal}`));
    await until(() => fc.sleeps.length >= 1);
    assert.deepEqual(refused, ['upgrade_required:true']);
    assert.equal(fc.sleeps[0], CONNECT_LIMITS.reconnect.fatalMs);
    assert.match(log.text(), /protocol 2 to 3; this agent speaks 1/);
    assert.equal(h.state(), 'waiting');
  });

  it('rate_limited and already_connected are not fatal, and retryAfterS is honoured', async () => {
    const fc = fakeClock();
    behaviour = (ws) => {
      ws.send(JSON.stringify({ t: 'reject', code: 'rate_limited', message: 'slow down', retryAfterS: 90 }));
      ws.close(4429);
    };
    const { h } = start(fc.clock);
    const refused: { code: string; fatal: boolean }[] = [];
    h.events.on('refused', (r) => refused.push(r));
    await until(() => fc.sleeps.length >= 1);
    assert.equal(refused[0]!.fatal, false);
    assert.ok(fc.sleeps[0]! >= 90_000, `waited ${fc.sleeps[0]}`);
    behaviour = (ws) => {
      ws.send(JSON.stringify({ t: 'reject', code: 'already_connected', message: 'another connection is healthy' }));
      ws.close(4409);
    };
    fc.go();
    await until(() => fc.sleeps.length >= 2);
    assert.equal(refused[1]!.code, 'already_connected');
    assert.equal(refused[1]!.fatal, false);
    assert.ok(fc.sleeps[1]! < CONNECT_LIMITS.reconnect.fatalMs);
  });

  it('opens exactly one stream, control, and answers the portal’s opens by service', async () => {
    const opened: number[] = [];
    let controlLine: string | null = null;
    behaviour = (ws) => {
      ws.send(JSON.stringify({ t: 'welcome', v: 1, node: NODE, target: 'lab', portalId: null, portalVersion: '0.0.0', agentBuild: 'abcabcabcabc', protocol: 1, heartbeat: { pingEveryMs: 15_000, deadAfterMs: 45_000 } }));
      const session = new MuxSession({
        role: 'server',
        socket: new WsMuxSocket(ws),
        onStream: (s: MuxStream) => {
          opened.push(s.id);
          void acceptService(s, (req) => (req.service === 'control' ? { ok: true } : { ok: false, code: 'bad_open', message: 'no' })).then((req) => {
            if (!req) return;
            s.write(`${JSON.stringify({ t: 'config', portalId: null, statusEveryS: 30, limits: { docker: 64, kube: 64, host: 32 }, agentBuild: 'abcabcabcabc' })}\n`);
            s.on('data', (d: Buffer) => (controlLine ??= d.toString()));
          });
        },
      });
      void session;
    };
    const { h } = start();
    await h.whenConnected();
    await until(() => controlLine !== null);
    assert.match(controlLine!, /"t":"status"/);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(opened, [1], 'the agent opened one stream, number 1, and nothing else');
  });

  it('a control line that is not JSON ends the connection, and the agent comes back', async () => {
    let connections = 0;
    behaviour = (ws) => {
      connections++;
      ws.send(JSON.stringify({ t: 'welcome', v: 1, node: NODE, target: 'lab', portalId: null, portalVersion: '0.0.0', agentBuild: 'abcabcabcabc', protocol: 1, heartbeat: { pingEveryMs: 15_000, deadAfterMs: 45_000 } }));
      new MuxSession({
        role: 'server',
        socket: new WsMuxSocket(ws),
        onStream: (s: MuxStream) => {
          void acceptService(s, () => ({ ok: true })).then((req) => req && s.write('{this is not json\n'));
        },
      });
    };
    const { h, log } = start();
    await until(() => connections >= 2, 15_000);
    assert.match(log.text(), /control\.protocol_error/);
    assert.notEqual(h.state(), 'stopped');
  });
});
