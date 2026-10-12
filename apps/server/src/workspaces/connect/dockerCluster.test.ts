// T-RT / T-MGR for a Docker cluster target (docs/prd/targets-connect.md §12.4): two nodes, each a fake daemon behind its own tunnel (an
// in-memory mux). Placement (least loaded, ties by cores, an asked node, drained), names unique across nodes (an offline node's
// snapshot included), maxWorkspaces, routing of calls to the node that has the workspace, and a node going offline: its workspaces
// stay listed as unreachable, calls to them fail with TargetUnreachableError, the other node keeps working.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { isTargetUnreachable } from '../runtime.js';
import { ConnectDockerRuntime } from './dockerCluster.js';
import { fakeDaemon, FakeLink, memoryDeps, targetRecord } from './testkit.js';

let dir: string;
let daemons: Awaited<ReturnType<typeof fakeDaemon>>[];
let links: FakeLink[];
let hold: NodeJS.Timeout;
const node = (id: string, drained = false) => ({ id, targetId: 'cx3-dock', name: `host-${id}`, drained, keyFingerprint: 'x' });

before(async () => {
  hold = setInterval(() => undefined, 1000);
  dir = mkdtempSync(join(tmpdir(), 'cx3-cluster-'));
  daemons = [await fakeDaemon(join(dir, 'a.sock')), await fakeDaemon(join(dir, 'b.sock'))];
  links = [
    new FakeLink('a', 'cx3-dock', { dockerSocket: join(dir, 'a.sock') }, { docker: { ncpu: 2 } as never }).connect(),
    new FakeLink('b', 'cx3-dock', { dockerSocket: join(dir, 'b.sock') }, { docker: { ncpu: 8 } as never }).connect(),
  ];
});
after(async () => {
  clearInterval(hold);
  links.forEach((l) => l.drop());
  await Promise.all(daemons.map((d) => d.close()));
  rmSync(dir, { recursive: true, force: true });
});

const make = (deps = memoryDeps(), settings = {}, drainedB = false) =>
  new ConnectDockerRuntime(targetRecord({ id: 'cx3-dock', settings }), [
    { record: node('a'), link: links[0]! },
    { record: node('b', drainedB), link: links[1]! },
  ], deps);

describe('ConnectDockerRuntime', () => {
  it('places by load (ties: most cores), routes calls to the node, and refuses a name taken on any node', async () => {
    const deps = memoryDeps();
    const rt = make(deps, { maxWorkspaces: 3 });
    await rt.check();
    assert.equal(rt.target.role, 'cluster');
    assert.deepEqual(rt.target.nodes!.map((n) => n.connected), [true, true]);
    await rt.create({ name: 'w1' }, () => undefined);
    // Both empty: the one with more cores (b).
    assert.ok(daemons[1]!.containers.has('claudepilot-w1'));
    await rt.create({ name: 'w2' }, () => undefined);
    assert.ok(daemons[0]!.containers.has('claudepilot-w2'));
    await rt.create({ name: 'w3', node: 'a' }, () => undefined);
    assert.ok(daemons[0]!.containers.has('claudepilot-w3'));
    const list = await rt.list();
    assert.deepEqual(list.map((w) => [w.name, w.node, w.status]).sort(), [['w1', 'b', 'running'], ['w2', 'a', 'running'], ['w3', 'a', 'running']]);
    // Labels: the portal's id on every container.
    assert.equal(daemons[1]!.containers.get('claudepilot-w1')!.Labels['claudepilot.portal'], 'cx3-portal');
    await assert.rejects(rt.create({ name: 'w4' }, () => undefined), /at most 3/);
    await rt.stop('w1');
    assert.equal(daemons[1]!.containers.get('claudepilot-w1')!.State, 'exited');
    assert.equal(daemons[0]!.requests.filter((r) => r.includes('w1')).length, 0, 'node a never heard of w1');
    await rt.remove('w3');
    assert.ok(!daemons[0]!.containers.has('claudepilot-w3'));
    await assert.rejects(rt.create({ name: 'w2' }, () => undefined), /already exists/);
    await assert.rejects(rt.start('nope'), (e) => (e as { statusCode?: number }).statusCode === 404);
    rt.dispose();
  });

  it('skips a drained node, and refuses one asked for by name', async () => {
    const rt = make(memoryDeps(), {}, true);
    await rt.create({ name: 'd1' }, () => undefined);
    assert.ok(daemons[0]!.containers.has('claudepilot-d1'));
    await assert.rejects(rt.create({ name: 'd2', node: 'b' }, () => undefined), /drained/);
    await assert.rejects(rt.create({ name: 'd3', node: 'zz' }, () => undefined), /Pick a node/);
    await rt.remove('d1');
    rt.dispose();
  });

  it('a node offline: its workspaces stay listed as unreachable, calls to them fail, a name there stays taken, the other node works', async () => {
    const deps = memoryDeps();
    const rt = make(deps);
    await rt.list();
    links[1]!.drop();
    const list = await rt.list();
    const w1 = list.find((w) => w.name === 'w1')!;
    assert.equal(w1.status, 'unreachable');
    assert.ok(w1.lastSeenAt);
    assert.equal(list.find((w) => w.name === 'w2')!.status, 'running');
    await assert.rejects(rt.start('w1'), (e) => isTargetUnreachable(e));
    await assert.rejects(rt.delivery!.state('w1'), (e) => isTargetUnreachable(e));
    await assert.rejects(rt.create({ name: 'w1' }, () => undefined), /already exists/);
    assert.deepEqual(await rt.usage(['w1']), [{ cpuPercent: null, memoryBytes: null }]);
    assert.deepEqual(rt.target.nodes!.map((n) => n.connected), [true, false]);
    // All nodes down: the target is unreachable and the manager serves the snapshot.
    links[0]!.drop();
    await assert.rejects(rt.check(), (e) => isTargetUnreachable(e));
    await assert.rejects(rt.list(), (e) => isTargetUnreachable(e));
    assert.deepEqual(rt.listLastKnown().map((w) => [w.name, w.status]).sort(), [['w1', 'unreachable'], ['w2', 'unreachable']]);
    // A new runtime made after a restart (the snapshot is the registry's) still knows the names.
    const again = make(deps);
    assert.deepEqual(again.listLastKnown().map((w) => w.name).sort(), ['w1', 'w2']);
    links[0]!.connect();
    links[1]!.connect();
    assert.equal((await rt.list()).find((w) => w.name === 'w1')!.status, 'stopped');
    await rt.remove('w1');
    await rt.remove('w2');
    rt.dispose();
    again.dispose();
  });
});

describe('T-PERF (PRD §19.6)', () => {
  it('list() of 20 workspaces through the tunnel takes at most 300 ms', async () => {
    const rt = make(memoryDeps());
    for (let i = 0; i < 20; i++) await rt.create({ name: `p${i}`, node: i % 2 ? 'a' : 'b' }, () => undefined);
    await rt.list(); // warm the pooled streams
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      assert.equal((await rt.list()).length, 20);
      times.push(performance.now() - t);
    }
    times.sort((x, y) => x - y);
    assert.ok(times[2]! <= 300, `median ${times[2]!.toFixed(1)} ms`);
    for (let i = 0; i < 20; i++) await rt.remove(`p${i}`);
    rt.dispose();
  });
});
