// T-1637: a run handed to a runner that then stops answering. Check #474 stayed `running` for 1.5 h on the Mac runner, and its cancel
// failed with SERVICE_UNAVAILABLE because the cancel went to the host first. Now: a cancel the host does not answer ends the run in the
// portal, and nothing the host says later changes that; a runner that has not answered for `ci.runnerLostMin` minutes loses its runs
// (`runner_lost`, a re-run on the fallback when there is one); a run in its own workspace is never lost this way. Two temporary homes
// stand for the repository's workspace and the runner, each running the real cp-ci against real git.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { CiRun } from '@portal/contracts';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import type { CiHost, CiReply } from './host.js';
import { Home } from './runner/testkit.js';
import { CiService } from './service.js';
import { sleep } from './testkit.js';

const SRC = 'docker/test';
const RUNNER = 'connect/box';
const PERSON = { actor: 'user:u_owner', userId: 'u_owner' };
const MIN = 60_000;

class Homes implements CiHost {
  readonly homes = new Map<string, Home>();
  readonly calls: { ws: string; args: string[] }[] = [];
  /** Stopped workspaces (state `stopped`). */
  readonly down = new Set<string>();
  /** Workspaces whose cp-ci calls fail at once (a tunnel that is gone). */
  readonly broken = new Set<string>();
  /** Runs once, inside the next `poll` call to that workspace, before it is answered. */
  beforePoll: { ws: string; fn: () => Promise<void> } | null = null;
  add(id: string): Home {
    const h = new Home(`cp-ci-${id.replace('/', '-')}-`);
    this.homes.set(id, h);
    return h;
  }
  async state(id: string) {
    return !this.homes.has(id) ? ('gone' as const) : this.down.has(id) ? ('stopped' as const) : ('running' as const);
  }
  async states() {
    return new Map([...this.homes.keys()].map((id) => [id, this.down.has(id) ? ('stopped' as const) : ('running' as const)]));
  }
  async cp(id: string, args: string[], opts?: { stdin?: string }): Promise<CiReply> {
    this.calls.push({ ws: id, args });
    if (this.broken.has(id)) throw new Error('The stream was reset by the other end.');
    const h = this.homes.get(id);
    if (!h) throw new Error(`no workspace ${id}`);
    if (args[0] === 'poll' && this.beforePoll?.ws === id) {
      const hook = this.beforePoll;
      this.beforePoll = null;
      await hook.fn();
    }
    return h.ci(args, { stdin: opts?.stdin });
  }
  async install() {}
}

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));

const onRunner = (seconds: number, fallback = false) => `on:
  push: { branches: ['**'] }
  manual: {}
jobs:
  test:
    runs-on: ${fallback ? '{ labels: [mac], fallback: workspace }' : '[mac]'}
    steps:
      - run: sleep ${seconds} && echo "runner=\${PILOT_RUNNER:-none}"
`;

async function setup(pipeline: string, runnerLostMin?: number | (() => number)) {
  const store = await Store.open({ dataDir: tempDirectory('cp-ci-lost-'), secretKey: parseSecretKey(generateSecretKey()) });
  cleanups.push(() => store.close());
  const host = new Homes();
  const src = host.add(SRC);
  host.add(RUNNER);
  const clock = { at: Date.now() };
  const svc = new CiService(store, host, {
    pollActiveMs: 50,
    pollIdleMs: 50,
    now: () => new Date(clock.at),
    ...(runnerLostMin === undefined ? {} : { runnerLostMin }),
  });
  const dir = src.repo('app', { 'README.md': '# app\n' });
  src.commit(dir, { '.pilot/ci.yml': pipeline }, 'add pipeline');
  const repo = await svc.createRepo({ workspaceId: SRC, name: 'app', source: dir, connect: true });
  await svc.poll(SRC);
  const pollBoth = async () => {
    await svc.poll(SRC);
    await svc.poll(RUNNER);
  };
  const until = async (id: string, ok: (r: CiRun) => boolean, what: string, ms = 60_000) => {
    const stop = Date.now() + ms;
    for (;;) {
      await pollBoth();
      const r = await svc.show(id);
      if (ok(r)) return r;
      if (Date.now() > stop) throw new Error(`run ${id}: ${what} (still ${r.status})`);
      await sleep(100);
    }
  };
  /** A run started and running, on the runner when the pipeline has runs-on. */
  const running = async () => {
    const run = await svc.startRun({ repoId: repo.id, pipeline: 'ci', ref: 'main' });
    await until(run.id, (r) => r.status === 'running' && r.detail.some((j) => j.status === 'running'), 'running');
    return run.id;
  };
  return { store, host, svc, repo, clock, pollBoth, until, running };
}

test('cancel while the runner does not answer: cancelled in the portal, and the runner hears it once it answers again', async () => {
  const s = await setup(onRunner(8));
  await s.svc.upsertRunner(RUNNER, { labels: ['mac'] }, PERSON);
  const id = await s.running();
  assert.equal((await s.svc.show(id)).runnerWorkspaceId, RUNNER);

  s.host.broken.add(RUNNER);
  const r = await s.svc.cancel(id, { actor: 'user:u_owner', note: 'stuck' });
  assert.equal(r.status, 'cancelled');
  assert.equal(r.reason, 'cancelled');
  assert.ok(r.finishedAt);
  assert.equal(r.cancelledBy, 'user:u_owner');
  assert.equal(r.cancelNote, 'stuck');
  assert.ok(r.diagnostics.some((d) => d.message === 'runner unreachable: cancelled in the portal'));
  assert.ok(
    r.detail.every((j) => j.status !== 'running' && j.status !== 'pending'),
    JSON.stringify(r.detail),
  );

  // Back: the cancel goes to the runner, and the run stays as the portal ended it.
  s.host.broken.delete(RUNNER);
  await s.pollBoth();
  assert.ok(s.host.calls.some((c) => c.ws === RUNNER && c.args[0] === 'cancel' && c.args[1] === id));
  await sleep(500);
  await s.pollBoth();
  const later = await s.svc.show(id);
  assert.equal(later.status, 'cancelled');
  assert.equal(later.reason, 'cancelled');
});

test('a report the runner sends after the portal cancelled the run never reopens it or changes its result', async () => {
  const s = await setup(onRunner(1));
  await s.svc.upsertRunner(RUNNER, { labels: ['mac'] }, PERSON);
  const id = await s.running();
  // The step ends on the runner (passed) while nobody asks; then a poll goes out, and the cancel lands (the runner not answering it)
  // before that poll's answer, which says `passed`.
  await sleep(2_500);
  s.host.beforePoll = {
    ws: RUNNER,
    fn: async () => {
      s.host.broken.add(RUNNER);
      await s.svc.cancel(id);
      s.host.broken.delete(RUNNER);
    },
  };
  await s.svc.poll(RUNNER);
  assert.equal(s.host.beforePoll, null, 'the cancel ran inside the poll');
  const r = await s.svc.show(id);
  assert.equal(r.status, 'cancelled');
  assert.equal(r.reason, 'cancelled');
  await s.pollBoth();
  assert.equal((await s.svc.show(id)).status, 'cancelled');
});

test('a runner that does not answer for ci.runnerLostMin: its run is untouched before, failed as runner_lost after', async () => {
  const s = await setup(onRunner(8), () => 10);
  await s.svc.upsertRunner(RUNNER, { labels: ['mac'] }, PERSON);
  const id = await s.running();
  s.host.down.add(RUNNER);
  await s.pollBoth();
  s.clock.at += 9.9 * MIN;
  await s.pollBoth();
  assert.equal((await s.svc.show(id)).status, 'running', 'untouched before N minutes');

  s.clock.at += 0.2 * MIN;
  await s.pollBoth();
  const r = await s.svc.show(id);
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'runner_lost');
  assert.ok(r.finishedAt);
  assert.ok(r.diagnostics.some((d) => d.code === 'runner_lost' && /connect\/box did not answer for 10 minutes/.test(d.message)));
  assert.ok(
    r.detail.every((j) => j.status === 'failed' || j.status === 'cancelled'),
    JSON.stringify(r.detail),
  );
  assert.ok(!s.svc.list({}).items.some((x) => x.rerunOf === id), 'no fallback: no re-run');
});

test('a runner answering again before N minutes starts the count over', async () => {
  const s = await setup(onRunner(8), () => 10);
  await s.svc.upsertRunner(RUNNER, { labels: ['mac'] }, PERSON);
  const id = await s.running();
  s.host.broken.add(RUNNER);
  await s.pollBoth();
  s.clock.at += 9 * MIN;
  s.host.broken.delete(RUNNER);
  await s.pollBoth();
  s.host.broken.add(RUNNER);
  await s.pollBoth();
  s.clock.at += 9 * MIN;
  await s.pollBoth();
  assert.equal((await s.svc.show(id)).status, 'running');
});

test('ci.runnerLostMin 0: a run on a runner that does not answer is never ended', async () => {
  const s = await setup(onRunner(8), () => 0);
  await s.svc.upsertRunner(RUNNER, { labels: ['mac'] }, PERSON);
  const id = await s.running();
  s.host.down.add(RUNNER);
  await s.pollBoth();
  s.clock.at += 24 * 60 * MIN;
  await s.pollBoth();
  assert.equal((await s.svc.show(id)).status, 'running');
});

test('runner lost with fallback: workspace: failed as runner_lost, and a re-run passes in the repository workspace', async () => {
  const s = await setup(onRunner(8, true));
  await s.svc.upsertRunner(RUNNER, { labels: ['mac'] }, PERSON);
  const id = await s.running();
  assert.equal((await s.svc.show(id)).runnerWorkspaceId, RUNNER);
  s.host.broken.add(RUNNER);
  await s.pollBoth();
  s.clock.at += 10 * MIN;
  await s.pollBoth();
  const r = await s.svc.show(id);
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'runner_lost');
  const again = s.svc.list({}).items.find((x) => x.rerunOf === id);
  assert.ok(again, 'a re-run on the fallback');
  const done = await s.until(again.id, (x) => x.status !== 'queued' && x.status !== 'running', 'the re-run ends', 90_000);
  assert.equal(done.status, 'passed', JSON.stringify(done.detail));
  assert.equal(done.runnerWorkspaceId, null);
  assert.match((await s.svc.log(again.id, 'test', 0, 0)).text, /runner=none/);
});

test('a run in its own workspace (no runner) is never lost, however long the workspace does not answer', async () => {
  const s = await setup(
    `on:
  push: { branches: ['**'] }
  manual: {}
jobs:
  test:
    steps:
      - run: sleep 8
`,
    () => 10,
  );
  const id = await s.running();
  assert.equal((await s.svc.show(id)).runnerWorkspaceId, null);
  s.host.broken.add(SRC);
  await s.pollBoth();
  s.clock.at += 24 * 60 * MIN;
  await s.pollBoth();
  s.host.broken.delete(SRC);
  s.host.down.add(SRC);
  await s.pollBoth();
  s.clock.at += 24 * 60 * MIN;
  await s.pollBoth();
  assert.equal((await s.svc.show(id)).status, 'running');
});
