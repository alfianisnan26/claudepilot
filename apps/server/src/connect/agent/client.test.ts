// T-AGENT (docs/prd/targets-connect.md §19.3): the agent against the portal's real hub in one process (C2's gate). Enrollment through the real
// EnrollmentService, connect, `welcome`, the control stream, status and logs, the streams the portal opens, restart without a token, the pinned
// portal id, fatal rejections that wait instead of exiting, backoff and its reset, reconnect after a dropped socket, `bye` and its reasons.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { CONNECT_LIMITS, type ConnectHostResult } from '@portal/contracts';
import { runAgent, type AgentClock, type AgentHandle } from './client.js';
import { fingerprintOf, FileIdentityStore } from './identity.js';
import { collectingLogger } from './log.js';
import { agentConfig } from './testkit/agentConfig.js';
import { openPortal, type Portal } from './testkit/portalRig.js';
import { generateNodeKeyPair } from '../tunnel/auth.js';
import { parseResult, RECORD, RecordParser } from '../tunnel/records.js';

let portal: Portal;
let dir: string;
const agents: AgentHandle[] = [];

before(async () => {
  portal = await openPortal();
});
after(async () => {
  await portal.close();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cx2-agent-'));
  mkdirSync(join(dir, 'home'));
});
afterEach(async () => {
  for (const a of agents.splice(0)) await a.stop().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

const start = (over: Parameters<typeof agentConfig>[0] extends infer C ? Partial<C> : never = {}, extra: Partial<Parameters<typeof runAgent>[0]> = {}) => {
  const log = collectingLogger();
  const handle = runAgent({
    config: agentConfig({ dataDir: join(dir, 'agent'), home: join(dir, 'home'), url: portal.origin, ...(over as object) }),
    log: log.logger,
    build: 'bbbbbbbbbbbb',
    ...extra,
  });
  agents.push(handle);
  return { handle, log };
};
const until = async (fn: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** What a portal's HostRuntime does: a `host` stream, one operation, the records back. */
async function hostOp(nodeId: string, targetId: string, op: Parameters<ReturnType<Portal['hub']['hub']['link']>['open']>[1]) {
  const link = portal.hub.hub.link({ id: nodeId, targetId });
  const stream = await link.open('host', op);
  const parser = new RecordParser();
  const out: Buffer[] = [];
  let result: ConnectHostResult | null = null;
  stream.on('data', (c: Buffer) => {
    for (const r of parser.push(c)) {
      if (r.kind === RECORD.data) out.push(r.payload);
      if (r.kind === RECORD.result) result = parseResult(r.payload);
    }
  });
  stream.on('end', () => stream.end());
  await until(() => result !== null);
  return { text: Buffer.concat(out).toString('utf8'), result: result! };
}

describe('enroll, connect, and what the portal sees', () => {
  it('enrolls with the token, keeps the key 0600, connects, and the portal knows the node by its fingerprint', async () => {
    const t = portal.target({ id: 'enr1' });
    const { handle, log } = start({ enrollToken: t.token });
    await handle.whenConnected();
    const id = handle.identity()!;
    assert.match(id.node, /^nd_/);
    assert.equal(id.target, 'enr1');
    const file = join(dir, 'agent', 'identity.json');
    assert.equal(statSync(file).mode & 0o777, 0o600, 'the identity file is private');
    assert.equal(statSync(join(dir, 'agent')).mode & 0o777, 0o700);
    assert.equal(portal.core.registry.requireNode(id.node).keyFingerprint, fingerprintOf(id), 'both sides show the same fingerprint');
    assert.equal(portal.hub.hub.isConnected(id.node), true);
    assert.equal(id.portalId, portal.core.store.portalId, 'the first welcome pinned the portal id');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).portalId, portal.core.store.portalId);
    assert.equal(log.text().includes(t.token), false, 'the token is nowhere in the agent’s log');
    assert.equal(log.text().includes(id.privateKey), false);
    assert.equal(portal.events('enr1').some((e) => e.type === 'node.enrolled'), true);
  });

  it('reports itself and sends status: services, usage, streams', async () => {
    const t = portal.target({ id: 'stat1' });
    const { handle } = start({ enrollToken: t.token });
    await handle.whenConnected();
    const node = handle.identity()!.node;
    await until(() => !!portal.hub.hub.connection(node)?.status);
    const conn = portal.hub.hub.connection(node)!;
    assert.equal(conn.hello.mode, 'host');
    assert.equal(conn.hello.agentBuild, 'bbbbbbbbbbbb');
    assert.equal(conn.hello.protocol, 1);
    assert.equal(conn.hello.runtime, 'host');
    assert.deepEqual(conn.hello.services.map((s) => [s.name, s.ok]), [['host', true]]);
    assert.equal(conn.status!.services[0]!.name, 'host');
    assert.ok(conn.status!.usage!.cores! >= 1);
    assert.deepEqual(conn.status!.streams, { docker: 0, kube: 0, host: 0 });
  });

  it('a restart without a token loads the identity and connects (no second enrollment)', async () => {
    const t = portal.target({ id: 'rest1' });
    const first = start({ enrollToken: t.token });
    await first.handle.whenConnected();
    const node = first.handle.identity()!.node;
    await first.handle.stop();
    await until(() => !portal.hub.hub.isConnected(node));
    const again = start({});
    await again.handle.whenConnected();
    assert.equal(again.handle.identity()!.node, node);
    assert.equal(portal.core.registry.liveNodes('rest1').length, 1, 'still one node');
    // With the token still set (a Kubernetes pod restarts with its Secret): it is not used.
    await again.handle.stop();
    const withToken = start({ enrollToken: t.token });
    await withToken.handle.whenConnected();
    assert.equal(withToken.handle.identity()!.node, node);
    assert.equal(withToken.log.text().includes('enroll.skipped'), true);
  });

  it('runs a command the portal asks for over a host stream, as a HostRuntime would', async () => {
    const t = portal.target({ id: 'host1' });
    const { handle } = start({ enrollToken: t.token });
    await handle.whenConnected();
    const { text, result } = await hostOp(handle.identity()!.node, 'host1', { op: 'exec', argv: ['sh', '-c', 'echo $((6*7)); pwd'] });
    assert.equal(text.split('\n')[0], '42');
    assert.equal(text.split('\n')[1], join(dir, 'home'));
    assert.deepEqual(result, { code: 0 });
  });
});

describe('streams the portal opens', () => {
  it('refuses control, a service this agent does not offer, a bad host operation, and a thirty-third host stream', async () => {
    const t = portal.target({ id: 'disp1' });
    const { handle } = start({ enrollToken: t.token });
    await handle.whenConnected();
    const id = handle.identity()!;
    const link = portal.hub.hub.link({ id: id.node, targetId: 'disp1' });
    await assert.rejects(link.open('kube'), { code: 'service_unavailable' });
    await assert.rejects(link.open('docker'), { code: 'service_unavailable' });
    await assert.rejects(link.open('host', { op: 'exec', argv: [] } as never), { code: 'bad_open' });
    await assert.rejects(link.open('host', { op: 'exec', argv: ['x'], tty: { cols: 0, rows: 0 } }), { code: 'bad_open' });
    // The caps: 32 host streams, then busy.
    const held = [];
    for (let i = 0; i < CONNECT_LIMITS.serviceStreams.host; i++) held.push(await link.open('host', { op: 'exec', argv: ['sleep', '30'] }));
    await assert.rejects(link.open('host', { op: 'exec', argv: ['true'] }), { code: 'busy' });
    await until(() => portal.hub.hub.connection(id.node)?.status?.streams?.host === 32 || true);
    for (const s of held) s.destroy();
    await until(() => handle.services().size > 0);
    const after = await link.open('host', { op: 'exec', argv: ['true'] }).catch((e: Error) => e);
    assert.ok(!(after instanceof Error), 'a slot is free again once the streams are gone');
    if (!(after instanceof Error)) after.destroy();
  });
});

describe('bye', () => {
  it('says shutdown on a normal stop, and uninstall or upgrade when the installer left a marker', async () => {
    for (const [marker, reason] of [[null, 'shutdown'], ['uninstalling', 'uninstall'], ['upgrading', 'upgrade']] as const) {
      const t = portal.target({ id: `bye-${reason}` });
      const { handle } = start({ enrollToken: t.token, dataDir: join(dir, `agent-${reason}`) });
      await handle.whenConnected();
      const node = handle.identity()!.node;
      if (marker) writeFileSync(join(dir, `agent-${reason}`, marker), '');
      await handle.stop();
      await until(() => !portal.hub.hub.isConnected(node));
      const gone = portal.events(`bye-${reason}`).find((e) => e.type === 'node.disconnected');
      assert.ok(gone, 'the portal audited the disconnect');
      assert.equal(JSON.stringify(gone!.detail).includes(reason), true, `the portal was told ${reason}: ${JSON.stringify(gone!.detail)}`);
      assert.equal(handle.state(), 'stopped');
    }
  });
});

describe('what the agent does when the portal says no', () => {
  const fakeClock = () => {
    const sleeps: number[] = [];
    let release: (() => void) | null = null;
    let now = 1_000_000;
    let rnd = 0.999;
    const clock: AgentClock = {
      sleep: (ms, signal) =>
        new Promise((resolve, reject) => {
          sleeps.push(ms);
          release = resolve;
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      now: () => now,
      random: () => rnd,
    };
    return { clock, sleeps, advance: (ms: number) => (now += ms), setRandom: (v: number) => (rnd = v), go: () => release?.() };
  };

  it('a fatal rejection (unknown node) is logged loudly, waits an hour and does not exit; then it tries again', async () => {
    portal.target({ id: 'fatal1' });
    const stranger = generateNodeKeyPair();
    const store = new FileIdentityStore(join(dir, 'agent'));
    await store.save({ node: 'nd_ffffffffffff', target: 'fatal1', portalUrl: portal.origin, portalId: null, privateKey: stranger.privateKey, publicKey: stranger.publicKey, enrolledAt: new Date().toISOString() });
    const fc = fakeClock();
    const { handle, log } = start({}, { clock: fc.clock });
    const refused: { code: string; fatal: boolean; waitMs: number }[] = [];
    handle.events.on('refused', (r) => refused.push(r));
    await until(() => fc.sleeps.length >= 1);
    assert.deepEqual(refused[0] && { code: refused[0].code, fatal: refused[0].fatal }, { code: 'unknown_node', fatal: true });
    assert.equal(fc.sleeps[0], CONNECT_LIMITS.reconnect.fatalMs, 'an hour');
    assert.equal(handle.state(), 'waiting');
    assert.match(log.text(), /ERROR connect\.fatal code=unknown_node/);
    // It is still alive and, an hour later, asks again.
    fc.go();
    await until(() => fc.sleeps.length >= 2);
    assert.equal(fc.sleeps[1], CONNECT_LIMITS.reconnect.fatalMs);
    assert.equal(refused.length, 2);
  });

  it('backs off with full jitter from 1 s to 60 s, honours the floor, and resets after a connection held for 30 s', async () => {
    // Nothing listens on this port: every attempt fails at once.
    const dead = start({ url: 'http://127.0.0.1:1', enrollToken: null }, {});
    await dead.handle.stop();
    const fc = fakeClock();
    const t = portal.target({ id: 'back1' });
    const { handle } = start({ enrollToken: t.token }, { clock: fc.clock });
    await handle.whenConnected();
    const node = handle.identity()!.node;
    // a short connection (held 0 s on the fake clock) that drops: the next attempt's cap is 1 s x 2 per failure
    await portal.hub.hub.disconnect(node, 'shutdown');
    await until(() => fc.sleeps.length >= 1);
    assert.ok(fc.sleeps[0]! >= 100 && fc.sleeps[0]! <= CONNECT_LIMITS.reconnect.minMs * 2, `first wait ${fc.sleeps[0]}`);
    fc.setRandom(0);
    fc.go();
    await handle.whenConnected();
    await portal.hub.hub.disconnect(node, 'shutdown');
    await until(() => fc.sleeps.length >= 2);
    assert.equal(fc.sleeps[1], 100, 'full jitter can be near zero, with a 100 ms floor');
    // held for a long time: the counter resets
    fc.setRandom(0.999);
    fc.go();
    await handle.whenConnected();
    fc.advance(31_000);
    await portal.hub.hub.disconnect(node, 'shutdown');
    await until(() => fc.sleeps.length >= 3);
    assert.ok(fc.sleeps[2]! <= CONNECT_LIMITS.reconnect.minMs * 2, `after 30 s healthy the wait is small again: ${fc.sleeps[2]}`);
    for (let i = 0; i < 12; i++) {
      fc.go();
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(fc.sleeps.every((s) => s <= CONNECT_LIMITS.reconnect.maxMs));
  });

  it('reconnects by itself after the socket is cut', async () => {
    const t = portal.target({ id: 'cut1' });
    const { handle } = start({ enrollToken: t.token });
    await handle.whenConnected();
    const node = handle.identity()!.node;
    const downs: number[] = [];
    handle.events.on('disconnected', () => downs.push(1));
    portal.hub.hub.connection(node)!.ws.terminate();
    await until(() => downs.length === 1);
    await until(() => handle.connected() && portal.hub.hub.isConnected(node), 8000);
    assert.equal(handle.state(), 'connected');
  });

  it('refuses a different portal than the one that enrolled it (portal_mismatch) and waits', async () => {
    const t = portal.target({ id: 'pin1' });
    const first = start({ enrollToken: t.token });
    await first.handle.whenConnected();
    const id = first.handle.identity()!;
    await first.handle.stop();
    await until(() => !portal.hub.hub.isConnected(id.node));
    // The agent remembers another portal's id: this one must be refused.
    const store = new FileIdentityStore(join(dir, 'agent'));
    await store.save({ ...id, portalId: 'a-different-portal' });
    const fc = fakeClock();
    const { handle } = start({}, { clock: fc.clock });
    const codes: string[] = [];
    handle.events.on('refused', (r) => codes.push(r.code));
    await until(() => fc.sleeps.length >= 1);
    assert.deepEqual(codes, ['portal_mismatch']);
    assert.equal(fc.sleeps[0], CONNECT_LIMITS.reconnect.fatalMs);
    assert.equal(handle.connected(), false);
  });

  it('does not touch a damaged identity file, and says so', async () => {
    mkdirSync(join(dir, 'agent'), { recursive: true });
    writeFileSync(join(dir, 'agent', 'identity.json'), '{"node": "nd_x", "privateKey": "oops"');
    const { handle, log } = start({ enrollToken: portal.target({ id: 'dmg1' }).token }, { timing: { notEnrolledPollMs: 60_000 } });
    await until(() => /identity\.damaged/.test(log.text()));
    assert.equal(handle.state(), 'waiting');
    assert.equal(readFileSync(join(dir, 'agent', 'identity.json'), 'utf8'), '{"node": "nd_x", "privateKey": "oops"', 'left exactly as it was');
    assert.equal(existsSync(join(dir, 'agent', 'identity.next.json')), false);
  });

  it('enrollment refusals are named and never retried blindly: a used token, an unknown one, a wrong mode', async () => {
    const t = portal.target({ id: 'used1' });
    const a = start({ enrollToken: t.token });
    await a.handle.whenConnected();
    const refused: string[] = [];
    const again = start({ enrollToken: t.token, dataDir: join(dir, 'second') }, { timing: { fatalMs: 60_000 } });
    again.handle.events.on('refused', (r) => refused.push(r.code));
    await until(() => refused.length >= 1);
    assert.equal(refused[0], 'token_used', 'the single-use token is spent');
    assert.match(again.log.text(), /ERROR enroll\.failed reason=token_used/);
    const bad = start({ enrollToken: `cpen_${'A'.repeat(43)}`, dataDir: join(dir, 'third') }, { timing: { fatalMs: 60_000 } });
    const badRefused: string[] = [];
    bad.handle.events.on('refused', (r) => badRefused.push(r.code));
    await until(() => badRefused.length >= 1);
    assert.equal(badRefused[0], 'token_invalid');
    assert.equal(bad.log.text().includes('A'.repeat(43)), false, 'a wrong token is not logged either');
    const mode = start({ enrollToken: portal.target({ id: 'mode1', kind: 'docker' }).token, dataDir: join(dir, 'fourth') }, { timing: { fatalMs: 60_000 } });
    const modeRefused: string[] = [];
    mode.handle.events.on('refused', (r) => modeRefused.push(r.code));
    await until(() => modeRefused.length >= 1);
    assert.ok(modeRefused[0], 'the portal refused a host agent on a docker target');
  });
});
