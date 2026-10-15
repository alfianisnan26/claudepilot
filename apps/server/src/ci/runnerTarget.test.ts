// The runner seam (T-557): the lifecycle against the fake target, the idle sweep, and the cluster adapter against a fake exec of
// job-run.sh. No cluster, no GitHub, no network.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClusterTarget, FakeTarget, runOnTarget, sweepIdle, type RunnerHandle } from './runnerTarget.js';

const spec = { command: 'npm test' };

test('a passing run: start, run, logs, stop, remove, in that order', async () => {
  const t = new FakeTarget();
  const o = await runOnTarget(t, spec);
  assert.deepEqual(t.calls, ['start', 'run', 'logs', 'stop', 'remove']);
  assert.deepEqual({ rc: o.rc, reason: o.reason, log: o.log, errs: o.cleanupErrors }, { rc: 0, reason: 'ok', log: 'fake log\n', errs: [] });
  assert.equal(t.live.size, 0);
});

test('a failing command is a result, and the runner is still removed', async () => {
  const t = new FakeTarget();
  t.rc = 3;
  const o = await runOnTarget(t, spec);
  assert.deepEqual({ rc: o.rc, reason: o.reason }, { rc: 3, reason: 'step_failed' });
  assert.equal(t.live.size, 0);
});

test('run throws: runner_error, log kept from the target, runner removed', async () => {
  const t = new FakeTarget();
  t.failOn.run = new Error('boom');
  const o = await runOnTarget(t, spec);
  assert.equal(o.reason, 'runner_error');
  assert.equal(o.log, 'fake log\n');
  assert.deepEqual(t.calls.slice(-2), ['stop', 'remove']);
  assert.equal(t.live.size, 0);
});

test('start fails: start_failed, nothing to stop, nothing left', async () => {
  const t = new FakeTarget();
  t.failOn.start = new Error('quota');
  const o = await runOnTarget(t, spec);
  assert.deepEqual({ rc: o.rc, reason: o.reason, log: o.log }, { rc: null, reason: 'start_failed', log: 'quota' });
  assert.deepEqual(t.calls, ['start']);
});

test('a timeout aborts a hung command and still stops and removes', async () => {
  const t = new FakeTarget();
  t.hang = true;
  const o = await runOnTarget(t, { ...spec, timeoutMs: 20 });
  assert.equal(o.reason, 'timeout');
  assert.deepEqual(t.calls, ['start', 'run', 'logs', 'stop', 'remove']);
  assert.equal(t.live.size, 0);
});

test('a cancel by the caller is reported as cancelled and cleans up', async () => {
  const t = new FakeTarget();
  t.hang = true;
  const ctl = new AbortController();
  const p = runOnTarget(t, spec, { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 10);
  const o = await p;
  assert.equal(o.reason, 'cancelled');
  assert.equal(t.live.size, 0);
});

test('a failing stop does not skip remove, and is reported', async () => {
  const t = new FakeTarget();
  t.failOn.stop = new Error('stop refused');
  const o = await runOnTarget(t, spec);
  assert.equal(o.reason, 'ok');
  assert.deepEqual(o.cleanupErrors, ['stop: stop refused']);
  assert.equal(t.live.size, 0);
});

test('a failing remove is reported, not swallowed', async () => {
  const t = new FakeTarget();
  t.failOn.remove = new Error('delete refused');
  const o = await runOnTarget(t, spec);
  assert.deepEqual(o.cleanupErrors, ['remove: delete refused']);
  assert.equal(t.live.size, 1);
});

test('idle sweep removes only handles idle past the period, and keeps one whose removal fails', async () => {
  const t = new FakeTarget();
  const a = await t.start(spec);
  const b = await t.start(spec);
  const held = new Map<string, { handle: RunnerHandle; idleSince: number }>([
    [a.id, { handle: a, idleSince: 0 }],
    [b.id, { handle: b, idleSince: 900 }],
  ]);
  assert.deepEqual(await sweepIdle(t, held, 1000, 500), [a.id]);
  assert.deepEqual([...held.keys()], [b.id]);
  assert.deepEqual([...t.live], [b.id]);
  t.failOn.remove = new Error('later');
  assert.deepEqual(await sweepIdle(t, held, 5000, 500), []);
  assert.equal(held.size, 1, 'kept for the next sweep');
  t.failOn.remove = undefined;
  assert.deepEqual(await sweepIdle(t, held, 5000, 500), [b.id]);
});

/* The lease interface: a runner gets a sealed lease for the declared names, never a value; it is revoked on every path. */

const issuer = () => {
  const log: string[] = [];
  const leases = {
    issue: async (names: string[], audience: string) => {
      log.push(`issue ${names.join(',')} for ${audience}`);
      return { id: 'lease-1', audience, names, sealed: 'opaque', expiresAt: 1 };
    },
    revoke: async (id: string) => void log.push(`revoke ${id}`),
  };
  return { leases, log };
};

test('declared secret names: the runner receives the sealed lease and it is revoked after the run', async () => {
  const t = new FakeTarget();
  const { leases, log } = issuer();
  const o = await runOnTarget(t, { ...spec, secrets: ['pool:E2E_ID', 'pool:E2E_SECRET'] }, { leases, audience: 'connect:mac' });
  assert.equal(o.reason, 'ok');
  assert.deepEqual(t.leases[0]?.names, ['pool:E2E_ID', 'pool:E2E_SECRET']);
  assert.equal(t.leases[0]?.audience, 'connect:mac');
  assert.deepEqual(log, ['issue pool:E2E_ID,pool:E2E_SECRET for connect:mac', 'revoke lease-1']);
});

test('no declared names: no lease is issued', async () => {
  const t = new FakeTarget();
  const { leases, log } = issuer();
  await runOnTarget(t, spec, { leases });
  assert.equal(t.leases[0], undefined);
  assert.deepEqual(log, []);
});

test('the lease is revoked when the run fails, and when start fails', async () => {
  for (const key of ['run', 'start'] as const) {
    const t = new FakeTarget();
    t.failOn[key] = new Error('x');
    const { leases, log } = issuer();
    await runOnTarget(t, { ...spec, secrets: ['pool:A'] }, { leases });
    assert.equal(log.at(-1), 'revoke lease-1', key);
  }
});

test('declared secrets with no issuer: start_failed, nothing started', async () => {
  const t = new FakeTarget();
  const o = await runOnTarget(t, { ...spec, secrets: ['pool:A'] });
  assert.equal(o.reason, 'start_failed');
  assert.deepEqual(t.calls, []);
});

test('cluster: refuses declared secrets until the lease exists, and never runs the script', async () => {
  const { t, calls } = clusterWith(0, '');
  const { leases } = issuer();
  const o = await runOnTarget(t, { ...spec, secrets: ['pool:A'] }, { leases });
  assert.equal(o.reason, 'start_failed');
  assert.match(o.log, /no secret lease yet/);
  assert.equal(calls.length, 0);
});

/* The cluster adapter: job-run.sh's arguments and exit codes pass through as before. */

const clusterWith = (rc: number, out: string) => {
  const calls: string[][] = [];
  const t = new ClusterTarget(async (argv) => {
    calls.push(argv);
    return argv[0] === '--stop' ? { rc: 0, out: '' } : { rc, out };
  });
  return { t, calls };
};

test('cluster: the script gets the options, --ref and the command unchanged; rc and log come back as they are', async () => {
  const { t, calls } = clusterWith(0, 'hello\njob-run: claudepilot-job-abcd1234 rc=0 in 5s\n');
  const o = await runOnTarget(t, { command: 'cd apps/server && npm test', ref: 'f98a254', options: ['--role', 'T557', '--timeout', '600'] });
  assert.deepEqual(calls[0], ['--role', 'T557', '--timeout', '600', '--ref', 'f98a254', '--', 'cd apps/server && npm test']);
  assert.deepEqual({ rc: o.rc, reason: o.reason }, { rc: 0, reason: 'ok' });
  assert.match(o.log, /claudepilot-job-abcd1234 rc=0/);
  assert.deepEqual(calls[1], ['--stop', 'claudepilot-job-abcd1234'], 'only a Job the script named is stopped');
});

test('cluster: exit codes keep their meaning (command rc, 124 deadline, 1 not finished, 2 usage)', async () => {
  for (const [rc, reason] of [[3, 'step_failed'], [124, 'timeout'], [1, 'runner_error'], [2, 'runner_error']] as const) {
    const { t } = clusterWith(rc, 'job-run: claudepilot-job-00000001 failed\n');
    const o = await runOnTarget(t, spec);
    assert.deepEqual({ rc: o.rc, reason: o.reason }, { rc, reason }, `rc ${rc}`);
  }
});

test('cluster: no Job named in the output, no --stop call; stop and remove twice are harmless', async () => {
  const { t, calls } = clusterWith(2, 'job-run: usage\n');
  const h = await t.start(spec);
  await t.run(h);
  await t.stop(h);
  await t.remove(h);
  await t.remove(h);
  assert.equal(calls.length, 1);
  assert.equal(await t.logs(h), '', 'forgotten after remove');
});
