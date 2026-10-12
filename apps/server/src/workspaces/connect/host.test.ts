// T-RT (c) and T-OUT for the Host runtime: an enrolled Host single over a real mux (in memory) to T2's `host` service in `host` mode with
// a temporary home. The contract: list, start and stop (the switch), exec with stdin and exit codes, a shell with a pty and resize,
// delivery run/put/read, watchStarts on start and on reconnect, usage from the status; and the outage rule: while the tunnel is down
// every call fails with TargetUnreachableError and the list says unreachable with when it was last seen.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createService } from '../../connect/agent/services/host/index.js';
import { silentLogger } from '../../connect/agent/log.js';
import { isTargetUnreachable, type ExecSession } from '../runtime.js';
import { HostRuntime } from './host.js';
import { FakeLink, memoryDeps, targetRecord } from './testkit.js';

let home: string;
let link: FakeLink;
let deps: ReturnType<typeof memoryDeps>;
let rt: HostRuntime;
const ID = 'cx3-metal';
// The in-memory tunnel's timers and the pty don't hold the event loop (a real WebSocket would): the test does.
let hold: NodeJS.Timeout;

const run = (s: ExecSession) =>
  new Promise<{ out: string; code: number | null }>((resolve) => {
    let out = '';
    s.onData((d) => (out += d.toString()));
    s.onExit((code) => resolve({ out, code }));
  });

before(() => {
  hold = setInterval(() => undefined, 1000);
  home = mkdtempSync(join(tmpdir(), 'cx3-host-'));
  const host = createService({ mode: 'host', home, log: silentLogger, baseEnv: { PATH: process.env.PATH, HOME: home } });
  link = new FakeLink('n1', ID, { host }, { usage: { cpuPercent: 12, memoryBytes: 1000, cores: 2, memoryTotalBytes: 4000 } }).connect();
  deps = memoryDeps();
  rt = new HostRuntime(targetRecord({ id: ID, kind: 'host', label: 'Metal' }), { record: { id: 'n1', targetId: ID, name: 'metal', drained: false, keyFingerprint: 'x' }, link }, deps);
});
after(() => {
  clearInterval(hold);
  rt.dispose();
  link.drop();
  rmSync(home, { recursive: true, force: true });
});

describe('HostRuntime over the tunnel', () => {
  it('is one workspace, switched by start and stop', async () => {
    await rt.check();
    let [w] = await rt.list();
    assert.equal(w!.id, `${ID}/${ID}`);
    assert.equal(w!.status, 'stopped');
    await assert.rejects(rt.exec(ID, ['true']), /switched off/);
    await assert.rejects(rt.create({ name: 'other' }), /Start it instead/);
    const started: string[] = [];
    const stop = rt.delivery!.watchStarts((n) => started.push(n));
    await rt.start(ID);
    [w] = await rt.list();
    assert.equal(w!.status, 'running');
    assert.deepEqual(started, [ID]);
    stop();
  });

  it('runs a command with stdin and its exit code, as the agent user in the mapped home', async () => {
    const s = await rt.exec(ID, ['sh', '-c', 'read x; echo "got $x in $HOME"; exit 3']);
    s.write('hello\n');
    const { out, code } = await run(s);
    assert.equal(code, 3);
    assert.equal(out.trim(), `got hello in ${home}`);
  });

  it('delivers: run with stdin and stderr, put with modes (paths mapped like This machine), read, a missing file', async () => {
    const r = await rt.delivery!.run(ID, 'cat; echo err >&2; exit 0', { stdin: 'in-data', user: 'node' });
    assert.deepEqual(r, { code: 0, stdout: 'in-data', stderr: 'err\n' });
    await rt.delivery!.put(ID, [
      { path: '/home/node/.cx3', type: 'directory', mode: 0o700, uid: 1000, gid: 1000 },
      { path: '/home/node/.cx3/secret', type: 'file', content: 's3cret', mode: 0o600, uid: 1000, gid: 1000 },
      { path: '/etc/claudepilot/bin/x', type: 'file', content: '#!/bin/sh\n', mode: 0o755, uid: 0, gid: 0 },
    ]);
    assert.equal(readFileSync(join(home, '.cx3/secret'), 'utf8'), 's3cret');
    assert.equal(statSync(join(home, '.cx3/secret')).mode & 0o777, 0o600);
    assert.equal(statSync(join(home, '.claudepilot/host/bin/x')).mode & 0o777, 0o755);
    assert.equal(await rt.delivery!.read(ID, '/home/node/.cx3/secret'), 's3cret');
    assert.equal(await rt.delivery!.read(ID, '/home/node/nothing-here'), null);
    // A script that names /etc/claudepilot gets the host's folder, as LocalRuntime does.
    assert.equal((await rt.delivery!.run(ID, 'test -x /etc/claudepilot/bin/x && echo yes')).stdout, 'yes\n');
  });

  it('times a delivery command out and kills it', async () => {
    await assert.rejects(rt.delivery!.run(ID, 'sleep 5', { timeoutMs: 300 }), /timed out after 300 ms/);
  });

  it('reports usage from the agent status', async () => {
    assert.deepEqual(await rt.usage([ID]), [{ cpuPercent: 12, memoryBytes: 1000, cores: 2, memoryTotalBytes: 4000 }]);
  });

  it('opens a terminal when the pty library is there', async (t) => {
    try {
      await import('@lydell/node-pty');
    } catch {
      return t.skip('no @lydell/node-pty');
    }
    const sh = await rt.shell(ID, { cols: 80, rows: 24 }, ['sh', '-c', 'stty size; read x; stty size']);
    let out = '';
    sh.onData((d) => (out += d.toString()));
    const exit = new Promise<number | null>((r) => sh.onExit(r));
    await new Promise((r) => setTimeout(r, 300));
    sh.resize(100, 30);
    await new Promise((r) => setTimeout(r, 100));
    sh.write(Buffer.from('\n'));
    assert.equal(await exit, 0);
    assert.match(out, /24 80[\s\S]*30 100/);
  });

  it('an outage: calls fail as unreachable, the list keeps the workspace with when it was seen, and the return re-delivers', async () => {
    const started: string[] = [];
    const stop = rt.delivery!.watchStarts((n) => started.push(n));
    // A command in flight when the tunnel drops ends (no hang).
    const s = await rt.exec(ID, ['sleep', '30']);
    const ended = run(s);
    link.drop();
    assert.equal((await ended).code, null);
    await assert.rejects(rt.check(), (e) => isTargetUnreachable(e));
    await assert.rejects(rt.list(), (e) => isTargetUnreachable(e));
    await assert.rejects(rt.delivery!.state(ID), (e) => isTargetUnreachable(e));
    await assert.rejects(rt.exec(ID, ['true']), (e) => isTargetUnreachable(e) && /Target unreachable \(since \d\d:\d\d\)/.test((e as Error).message));
    const [w] = rt.listLastKnown();
    assert.equal(w!.status, 'unreachable');
    assert.ok(w!.lastSeenAt);
    assert.equal(w!.detail, 'Last seen just now');
    assert.deepEqual(await rt.usage([ID]), [{ cpuPercent: null, memoryBytes: null }]);
    link.connect();
    assert.deepEqual(started, [ID]);
    assert.equal((await rt.list())[0]!.status, 'running');
    stop();
  });

  it('exposes no delivery when the target says so (FR43)', () => {
    const off = new HostRuntime(targetRecord({ id: 'cx3-off', kind: 'host', settings: { delivery: false } }), { record: { id: 'n2', targetId: 'cx3-off', name: 'x', drained: false, keyFingerprint: 'x' }, link }, deps);
    assert.equal(off.delivery, undefined);
    assert.equal(off.portalUrl, 'http://portal.example:3213');
    off.dispose();
  });
});
