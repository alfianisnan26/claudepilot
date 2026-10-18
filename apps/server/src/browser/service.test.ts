import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCK_HASH } from './compile.js';
import { browserHarness, supervisorStatus } from './testkit.js';

const WS = 'docker/dev';

/** A workspace named `dev` running on the fake Docker target, with a browser pool assigned. */
async function assigned(content = {}) {
  const h = await browserHarness();
  h.target.addWorkspace('dev');
  const p = h.create('Dev browser', content);
  h.pools.setAssignments(WS, 'browser', [{ poolId: p.id }]);
  return { h, p };
}
const row = (h: Awaited<ReturnType<typeof browserHarness>>) => h.service.configuration(WS);

test('converge: a running workspace with a pool gets a browser container, created and started once', async () => {
  const { h } = await assigned();
  try {
    await h.service.converge(WS, 'test');
    assert.deepEqual(h.target.calls, ['mounts dev', 'create dev', 'start dev']);
    assert.equal(row(h).container, 'running');
    assert.equal(row(h).sandbox, 'on');
    await h.service.converge(WS, 'again');
    assert.deepEqual(h.target.calls, ['mounts dev', 'create dev', 'start dev'], 'a second pass changes nothing');
    const c = h.target.containers.get('dev')!;
    assert.equal(c.netns, h.target.workspaces.get('dev')!.id, 'it joins the workspace’s network namespace');
  } finally {
    h.done();
  }
});

test('converge: a stopped workspace has no running browser, and it comes back with the workspace', async () => {
  const { h } = await assigned();
  try {
    await h.service.converge(WS, 'test');
    h.target.workspaces.get('dev')!.running = false;
    await h.service.converge(WS, 'workspace stopped');
    assert.equal(h.target.containers.get('dev')!.running, false);
    assert.equal(row(h).container, 'stopped');
    assert.equal((await h.service.status(WS)).state, 'workspace_stopped');
    h.target.restartWorkspace('dev');
    await h.service.converge(WS, 'workspace started');
    assert.equal(h.target.containers.get('dev')!.running, true);
    assert.ok(h.target.calls.includes('restart dev') || h.target.calls.filter((c) => c === 'start dev').length === 2);
  } finally {
    h.done();
  }
});

test('converge: a restarted workspace has a new namespace, so a browser that predates it restarts', async () => {
  const { h } = await assigned();
  try {
    await h.service.converge(WS, 'test');
    h.target.restartWorkspace('dev'); // the workspace started after the browser: the browser sits in a dead namespace
    await h.service.converge(WS, 'event');
    assert.ok(h.target.calls.includes('restart dev'));
    await h.service.converge(WS, 'event');
    assert.equal(h.target.calls.filter((c) => c === 'restart dev').length, 1, 'once');
  } finally {
    h.done();
  }
});

test('converge: a recreated workspace (a new container) means a new browser container', async () => {
  const { h } = await assigned();
  try {
    await h.service.converge(WS, 'test');
    const before = h.target.containers.get('dev')!.id;
    h.target.recreateWorkspace('dev');
    await h.service.converge(WS, 'event');
    const after = h.target.containers.get('dev')!;
    assert.notEqual(after.id, before);
    assert.equal(after.netns, h.target.workspaces.get('dev')!.id);
    assert.deepEqual(h.target.calls.slice(-4), ['remove dev', 'mounts dev', 'create dev', 'start dev']);
    assert.ok(h.target.calls.includes('remove dev'));
  } finally {
    h.done();
  }
});

test('converge: a changed pool recreates the browser only when it is idle', async () => {
  const { h, p } = await assigned();
  try {
    await h.service.converge(WS, 'test');
    h.pools.update(p.id, { content: { idleMinutes: 5 } });
    // A person has control: the change waits.
    h.target.state.supervisor = supervisorStatus({ control: { held: true, holder: 'd1', label: 'iPhone', since: Date.now(), leaseUntil: Date.now() + 60_000 } });
    await h.service.converge(WS, 'pool changed');
    assert.equal(h.target.calls.filter((c) => c === 'create dev').length, 1, 'not recreated under control');
    h.target.state.supervisor = supervisorStatus({ activity: { at: Date.now() - 5000, toolAt: Date.now() - 5000, tool: 'browser_click', session: 'g1' } });
    await h.service.converge(WS, 'pool changed');
    assert.equal(h.target.calls.filter((c) => c === 'create dev').length, 1, 'nor within a minute of a call');
    h.target.state.supervisor = supervisorStatus({ activity: { at: Date.now() - 120_000, toolAt: Date.now() - 120_000, tool: 'browser_click', session: 'g1' } });
    await h.service.converge(WS, 'pool changed');
    assert.equal(h.target.calls.filter((c) => c === 'create dev').length, 2, 'once idle');
    assert.ok(h.target.calls.includes('remove dev'));
  } finally {
    h.done();
  }
});

test('converge: unassigning removes the container and the sign-ins, or waits for the workspace to start', async () => {
  const { h } = await assigned();
  try {
    await h.service.converge(WS, 'test');
    h.pools.setAssignments(WS, 'browser', []);
    await h.service.converge(WS, 'unassigned');
    assert.equal(h.target.containers.has('dev'), false);
    assert.deepEqual(h.target.state.wiped, ['dev']);
    assert.equal(row(h).container, 'none');
    assert.equal((await h.service.status(WS)).state, 'none');

    // A stopped workspace: the wipe waits for its next start.
    const p2 = h.create('Again');
    h.pools.setAssignments(WS, 'browser', [{ poolId: p2.id }]);
    await h.service.converge(WS, 'test');
    h.target.workspaces.get('dev')!.running = false;
    h.pools.setAssignments(WS, 'browser', []);
    await h.service.converge(WS, 'unassigned');
    assert.equal(h.target.state.wiped.length, 1, 'not wiped while the workspace is stopped');
    h.target.workspaces.get('dev')!.running = true;
    await h.service.converge(WS, 'started');
    assert.equal(h.target.state.wiped.length, 2);
  } finally {
    h.done();
  }
});

test('a browser fault is recorded on the browser and never thrown at the workspace', async () => {
  const { h } = await assigned();
  try {
    h.target.state.failCreate = 'no space left on device';
    await h.service.converge(WS, 'test'); // resolves: nothing for the caller to catch
    assert.equal(row(h).container, 'error');
    assert.match(row(h).error ?? '', /no space left/);
    const s = await h.service.status(WS);
    assert.equal(s.state, 'error');
    assert.match(s.detail ?? '', /no space left/);
    h.target.state.failCreate = null;
    await h.service.converge(WS, 'retry');
    assert.equal(row(h).container, 'running');
    assert.equal(row(h).error, null);
  } finally {
    h.done();
  }
});

test('sandbox: probed on the daemon; off only where the pool allows it, and a pool that requires it refuses', async () => {
  const { h, p } = await assigned();
  try {
    h.target.state.sandboxWorks = false;
    await h.service.converge(WS, 'test');
    assert.equal(row(h).container, 'running');
    assert.equal(row(h).sandbox, 'off', 'the pool didn’t require it');
    h.pools.update(p.id, { content: { requireSandbox: true } });
    h.target.state.supervisor = supervisorStatus({ activity: { at: 0, toolAt: 0, tool: null, session: null } });
    await h.service.converge(WS, 'pool changed');
    assert.equal(row(h).container, 'error');
    assert.match(row(h).error ?? '', /sandbox can’t start/);
    assert.equal(h.target.containers.get('dev')!.running, false, 'and it doesn’t run without one');
  } finally {
    h.done();
  }
});

test('status: one word for the browser, from the supervisor’s own state', async () => {
  const { h } = await assigned();
  try {
    await h.service.converge(WS, 'test');
    const at = (over = {}) => {
      h.target.state.supervisor = supervisorStatus(over);
      h.service.invalidate(WS); // the supervisor's answer is shared for a second; this asks again
      return h.service.status(WS, { deviceId: 'd1', secure: true });
    };
    assert.equal((await at()).state, 'ready');
    assert.equal((await at({ chrome: { ...supervisorStatus().chrome, state: 'asleep' } })).state, 'asleep');
    assert.equal((await at({ activity: { at: Date.now() - 10_000, toolAt: Date.now() - 10_000, tool: 'browser_click', session: 'g1' } })).state, 'working');
    assert.equal((await at({ activity: { at: Date.now() - 1000, toolAt: 0, tool: null, session: null } })).state, 'ready', 'waking the browser, or a viewer, isn’t the agent working');
    const handoff = { id: 'h1', reason: 'Sign in to github.com', origin: 'https://github.com', session: 'g1', state: 'waiting' as const, requestedAt: Date.now(), resolvedAt: null, note: '' };
    const waiting = await at({ handoffs: [handoff] });
    assert.equal(waiting.state, 'needs_input');
    assert.equal(waiting.handoffs[0]!.origin, 'https://github.com');
    const held = await at({ control: { held: true, holder: 'd1', label: 'Alfian’s iPhone', since: Date.now() - 1000, leaseUntil: Date.now() + 60_000, private: true } });
    assert.equal(held.state, 'in_control');
    assert.equal(held.control?.mine, true, 'the holder sees it is theirs');
    assert.equal(held.control?.label, 'Alfian’s iPhone');
    assert.equal(held.control?.private, true);
    const other = await at({ control: { held: true, holder: 'd2', label: 'MacBook', since: Date.now(), leaseUntil: Date.now() + 60_000 } });
    assert.equal(other.control?.mine, false);
    const crashed = await at({ chrome: { ...supervisorStatus().chrome, state: 'error', error: 'The browser crashed 3 times in 10 minutes.' } });
    assert.equal(crashed.state, 'error');
    assert.match(crashed.detail ?? '', /crashed 3 times/);
    // T-921 self-heal: Chrome did not start with the request headers and runs without them; the browser is usable, the status says so.
    const degraded = await at({ chrome: { ...supervisorStatus().chrome, headers: 'degraded' } });
    assert.equal(degraded.state, 'ready');
    assert.equal(degraded.detail, 'Running without headers');
    assert.equal((await at({ chrome: { ...supervisorStatus().chrome, headers: 'on' } })).detail, null);
  } finally {
    h.done();
  }
});

test('status: taking over needs HTTPS or localhost and a pool that allows it; handoff text from the agent is redacted', async () => {
  const { h } = await assigned({ takeOver: true });
  try {
    await h.service.converge(WS, 'test');
    const insecure = await h.service.status(WS, { secure: false });
    assert.equal(insecure.canTakeOver, false);
    assert.match(insecure.takeOverBlocked ?? '', /HTTPS or localhost/);
    assert.equal((await h.service.status(WS, { secure: true })).canTakeOver, true);
    h.service.invalidate(WS);
    h.target.state.supervisor = supervisorStatus({ handoffs: [{ id: 'h1', reason: 'use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', origin: null, session: 'g', state: 'waiting', requestedAt: Date.now(), resolvedAt: null, note: '' }] });
    const s = await h.service.status(WS, { secure: true });
    assert.ok(!s.handoffs[0]!.reason.includes('abcdefghijklmnopqrstuvwxyz0123456789'), s.handoffs[0]!.reason);
  } finally {
    h.done();
  }
});

test('the servers install once per lockfile after a delivery to a running workspace, and again after a failure', async () => {
  const { h } = await assigned();
  try {
    h.deliver(WS, false);
    assert.equal(h.queued.length, 0, 'not into a stopped workspace');
    h.deliver(WS);
    assert.equal(h.queued.length, 1);
    const { step, workspaceId } = h.queued[0]!;
    assert.equal(workspaceId, WS);
    assert.equal(step.owner, 'browser');
    assert.match(step.script, /^\/bin\/sh \/etc\/claudepilot\/bin\/browser-install \/etc\/claudepilot\/marketplace\/plugins\/cpb-browser\/[0-9a-f]{12}\/npm$/);
    h.deliver(WS);
    assert.equal(h.queued.length, 1, 'still installing: no second step');
    step.done!({ code: 1, stdout: '', stderr: 'npm ERR! network', timedOut: false, ms: 5 });
    assert.deepEqual(h.service.configuration(WS).install, { state: 'failed', error: 'npm ERR! network' });
    h.deliver(WS);
    assert.equal(h.queued.length, 1, 'a failure isn’t retried at once');
    h.service.retryInstall(WS);
    assert.equal(h.queued.length, 2, 'Retry does');
    h.queued[1]!.step.done!({ code: 0, stdout: 'ok', stderr: '', timedOut: false, ms: 9000 });
    assert.deepEqual(h.service.configuration(WS).install, { state: 'installed', error: null });
    h.deliver(WS);
    assert.equal(h.queued.length, 2, 'installed: nothing more to do for this lockfile');
    const stored = h.store.db!.prepare('SELECT lock_hash FROM browser_installs WHERE workspace_id = ?').get(WS) as { lock_hash: string };
    assert.equal(stored.lock_hash, LOCK_HASH);
  } finally {
    h.done();
  }
});

test('removing a workspace takes its browser away first, so its volume can be removed', async () => {
  const { h } = await assigned();
  try {
    await h.service.converge(WS, 'test');
    await h.service.removeFor(WS, 'workspace removed');
    assert.equal(h.target.containers.has('dev'), false);
    assert.equal(h.store.db!.prepare('SELECT count(*) AS n FROM browser_instances WHERE workspace_id = ?').get(WS)!.n, 0);
    const kinds = (h.store.db!.prepare('SELECT kind FROM browser_events WHERE workspace_id = ? ORDER BY id').all(WS) as { kind: string }[]).map((r) => r.kind);
    assert.deepEqual(kinds, ['started', 'removed']);
  } finally {
    h.done();
  }
});

test('actions: wake, stop and restart go to the supervisor; stop refuses while a person has control', async () => {
  const { h } = await assigned();
  try {
    await h.service.converge(WS, 'test');
    await h.service.action(WS, 'wake');
    await h.service.action(WS, 'restart');
    h.target.state.supervisor = supervisorStatus({ control: { held: true, holder: 'd1', since: Date.now(), leaseUntil: Date.now() + 9000 } });
    await assert.rejects(() => h.service.action(WS, 'stop'), /Someone has control/);
    h.target.state.supervisor = supervisorStatus();
    await h.service.action(WS, 'stop');
    assert.deepEqual(h.target.state.ctl.map((c) => [c.cmd, c.args.join(' ')]).filter(([c]) => c !== 'status'), [['wake', ''], ['chrome', '--action restart'], ['chrome', '--action stop']]);
    await assert.rejects(() => h.service.action('docker/none', 'wake'), /no browser/);
  } finally {
    h.done();
  }
});

test('another portal’s browser containers are never touched (several portals can share one Docker daemon)', async () => {
  const h = await browserHarness();
  try {
    h.target.addWorkspace('dev');
    // Another portal made a browser container for `dev`; this portal has no pool assigned there.
    h.target.containers.set('dev', { id: 'theirs', running: true, startedAt: new Date().toISOString(), netns: 'x', spec: 'y', pool: 'p', portal: 'another-portal' });
    await h.service.converge(WS, 'timer');
    assert.equal(h.target.containers.has('dev'), true, 'not reaped as an orphan');
    assert.deepEqual(h.target.calls, []);
    await h.service.removeFor(WS, 'workspace removed');
    await h.service.stopFor(WS);
    assert.equal(h.target.containers.get('dev')!.running, true, 'nor removed or stopped with the workspace');
    // With a pool assigned here, the clash is shown, and still nothing is touched.
    const p = h.create('Dev browser');
    h.pools.setAssignments(WS, 'browser', [{ poolId: p.id }]);
    await h.service.converge(WS, 'test');
    assert.equal(h.service.configuration(WS).container, 'error');
    assert.match(h.service.configuration(WS).error ?? '', /Another portal/);
    assert.deepEqual(h.target.calls, []);
  } finally {
    h.done();
  }
});

test('a portal that does not trust its own database manages no browsers', async () => {
  const { h } = await assigned();
  try {
    Object.defineProperty(h.store, 'trust', { value: { state: 'frozen', reasons: [] }, configurable: true });
    await h.service.converge(WS, 'test');
    assert.deepEqual(h.target.calls, []);
  } finally {
    h.done();
  }
});
