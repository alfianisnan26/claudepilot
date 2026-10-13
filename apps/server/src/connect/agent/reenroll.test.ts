// A dead identity and a new command (T6; docs/prd/targets-connect.md §10.5, A2 "a new command re-enrolls"). Seen on a real cluster: after a
// revoke, the new command's installer applied the manifest, the agent kept its revoked identity, slept its fatal hour, and the installer gave
// up after waiting. The same held for the Docker, Container and Host kinds (`enroll` said "already enrolled"). Against the real hub in one process.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { runAgent, type AgentHandle } from './client.js';
import { FileIdentityStore } from './identity.js';
import { collectingLogger } from './log.js';
import { main, type MainIo } from './main.js';
import { agentConfig } from './testkit/agentConfig.js';
import { openPortal, stopAgents, type Portal } from './testkit/portalRig.js';
import { withTimeout } from '../testkit.js';

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
  dir = mkdtempSync(join(tmpdir(), 't6-reenroll-'));
  mkdirSync(join(dir, 'home'));
});
afterEach(async () => {
  await stopAgents(agents);
  rmSync(dir, { recursive: true, force: true });
});

const start = (over: Record<string, unknown> = {}, extra: Partial<Parameters<typeof runAgent>[0]> = {}) => {
  const log = collectingLogger();
  const handle = runAgent({
    config: agentConfig({ dataDir: join(dir, 'agent'), home: join(dir, 'home'), url: portal.origin, ...over }),
    log: log.logger,
    build: 'bbbbbbbbbbbb',
    ...extra,
  });
  agents.push(handle);
  return { handle, log };
};
const until = async (fn: () => boolean, what: string, ms = 8000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const io = (stdin = ''): MainIo & { out: string; err: string } => {
  const o = { out: '', err: '', stdout: (t: string) => void (o.out += t), stderr: (t: string) => void (o.err += t), stdin: async () => stdin };
  return o;
};

/** Enrolls a host agent on a new target, then revokes its node the way an admin does. Returns the target, the dead node and a new token for the target. */
async function revokedMachine(id: string) {
  const t = portal.target({ id });
  const first = start({ enrollToken: t.token });
  await withTimeout(first.handle.whenConnected(), 'the first enrollment', 8000);
  const dead = first.handle.identity()!.node;
  await withTimeout(first.handle.stop(), 'the first agent to stop', 5000);
  portal.core.registry.revokeNode(dead, 'Revoked by an admin.', portal.core.ctx);
  await portal.hub.hub.disconnect(dead, 'revoked');
  const target = portal.core.registry.requireTarget(id);
  const fresh = portal.core.enrollments.create(target, { platform: 'linux', options: { hostAccess: true } }, portal.core.ctx);
  return { target: id, dead, token: fresh.token, oldToken: t.token };
}

describe('a revoked machine and a new command', () => {
  it('a running agent with a token in its environment (Kubernetes, Swarm) enrolls again with it and connects as a new node', async () => {
    const m = await revokedMachine('re1');
    const { handle, log } = start({ enrollToken: m.token });
    await withTimeout(handle.whenConnected(), 'the re-enrolled agent to connect', 8000);
    const now = handle.identity()!.node;
    assert.notEqual(now, m.dead);
    assert.equal((await new FileIdentityStore(join(dir, 'agent')).load())!.node, now, 'the new identity is what the store keeps');
    assert.match(log.text(), /identity\.dead code=revoked/);
    assert.ok(portal.hub.hub.isConnected(now));
  });

  it('with the old, used token in its environment it says why and waits; it does not loop', async () => {
    const m = await revokedMachine('re2');
    const refused: string[] = [];
    const { handle } = start({ enrollToken: m.oldToken }, { timing: { fatalMs: 60_000 } });
    handle.events.on('refused', (r) => refused.push(r.code));
    await until(() => refused.includes('token_used'), 'token_used');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual([...refused].sort(), ['revoked', 'token_used'], 'one try with the token, then the fatal wait');
    assert.equal(handle.connected(), false);
    assert.equal(handle.state(), 'waiting');
  });

  it('`enroll` replaces an identity the portal declared dead, and the agent asleep on it wakes up with the new one (Docker, Container, Host)', async () => {
    const m = await revokedMachine('re3');
    // The agent that keeps running on the machine: revoked, no token, asleep for its fatal hour.
    const asleep = start({}, { timing: { fatalMs: 3_600_000, identityPollMs: 50 } });
    await until(() => asleep.handle.state() === 'waiting', 'the fatal wait');
    // The installer of the new command runs `enroll --token-stdin` on the same data folder.
    const out = io(`${m.token}\n`);
    const env = { PILOT_MODE: 'host', PILOT_DATA_DIR: join(dir, 'agent'), PILOT_URL: portal.origin, PILOT_ALLOW_HTTP: '1', PILOT_HOME: join(dir, 'home') };
    assert.equal(await main(['enroll', '--token-stdin'], env, 'bbbbbbbbbbbb', out), 0, out.err);
    assert.match(out.err, /no longer accepts node .* \(revoked\): enrolling again/);
    assert.match(out.out, /Enrolled as nd_/);
    const now = (await new FileIdentityStore(join(dir, 'agent')).load())!.node;
    assert.notEqual(now, m.dead);
    await withTimeout(asleep.handle.whenConnected(), 'the sleeping agent to pick up the new identity', 8000);
    assert.equal(asleep.handle.identity()!.node, now);
  });

  it('`enroll` keeps an identity that works: a healthy node is never thrown away by a re-run with another token', async () => {
    const t = portal.target({ id: 're4' });
    const a = start({ enrollToken: t.token });
    await withTimeout(a.handle.whenConnected(), 'the agent', 8000);
    const node = a.handle.identity()!.node;
    const other = portal.target({ id: 're5' });
    const out = io(`${other.token}\n`);
    const env = { PILOT_MODE: 'host', PILOT_DATA_DIR: join(dir, 'agent'), PILOT_URL: portal.origin, PILOT_ALLOW_HTTP: '1', PILOT_HOME: join(dir, 'home') };
    assert.equal(await main(['enroll', '--token-stdin'], env, 'bbbbbbbbbbbb', out), 0);
    assert.match(out.err, /already enrolled/);
    assert.equal((await new FileIdentityStore(join(dir, 'agent')).load())!.node, node);
    assert.ok(a.handle.connected(), 'the running agent was not disturbed');
  });
});
