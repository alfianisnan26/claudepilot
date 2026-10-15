// Runners (T-557): a pipeline with `runs-on` runs on another workspace that carries those labels. Two temporary homes stand for the
// repository's workspace and the runner, each running the real cp-ci against real git: the commit travels as a bundle into the runner's
// mirror (never its own remotes), the secret as a lease that is masked in the log and gone after the run, and the run reads as the
// runner's. Plus the spec's `runs-on` rules and the runner settings' checks.

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import type { CiHost, CiReply } from './host.js';
import { Home } from './runner/testkit.js';
import { CiService, mirrorOf } from './service.js';
import { validateFiles } from './spec/validate.js';
import { codeOf, sleep } from './testkit.js';

const SRC = 'docker/test';
const RUNNER = 'connect/box';
const PERSON = { actor: 'user:u_owner', userId: 'u_owner' };

/** Workspaces that are temporary homes here; each id its own home, so a runner's files are apart from the source's. */
class Homes implements CiHost {
  readonly homes = new Map<string, Home>();
  readonly calls: { ws: string; args: string[] }[] = [];
  readonly down = new Set<string>();
  /** Workspaces whose cp-ci never answers (a stalled tunnel). */
  readonly hang = new Set<string>();
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
    if (this.hang.has(id)) return new Promise<CiReply>(() => undefined);
    const h = this.homes.get(id);
    if (!h) throw new Error(`no workspace ${id}`);
    return h.ci(args, { stdin: opts?.stdin });
  }
  async install() {}
}

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));

const PIPELINE = `on:
  push: { branches: ['**'] }
  manual: {}
jobs:
  test:
    runs-on: [self-hosted, python, big]
    secrets: [DEPLOY_TOKEN]
    steps:
      - run: test -f README.md && echo "token=$DEPLOY_TOKEN" && echo "ran-in=$HOME"
`;

async function setup() {
  const store = await Store.open({ dataDir: tempDirectory('cp-ci-runners-'), secretKey: parseSecretKey(generateSecretKey()) });
  cleanups.push(() => store.close());
  const host = new Homes();
  const src = host.add(SRC);
  const runner = host.add(RUNNER);
  // Made at runtime, never a literal that looks like a token.
  const token = `tok-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const audits: { kind: string; detail?: Record<string, unknown> }[] = [];
  const svc = new CiService(store, host, {
    pollActiveMs: 50,
    pollIdleMs: 50,
    secrets: (ws, name) => (ws === SRC && name === 'DEPLOY_TOKEN' ? { kind: 'secret', asFile: true, asVariable: false } : null),
    secretValue: (ws, name) => (ws === SRC && name === 'DEPLOY_TOKEN' ? token : null),
    audit: (e) => void audits.push(e),
  });
  const dir = src.repo('app', { 'README.md': '# app\n' });
  src.commit(dir, { '.pilot/ci.yml': PIPELINE }, 'add pipeline');
  const repo = await svc.createRepo({ workspaceId: SRC, name: 'app', source: dir, connect: true });
  await svc.poll(SRC);
  const settle = async (id: string, ms = 90_000) => {
    const stop = Date.now() + ms;
    for (;;) {
      await svc.poll(SRC);
      await svc.poll(RUNNER);
      const r = await svc.show(id);
      if (r.status === 'passed' || r.status === 'failed' || r.status === 'cancelled') return r;
      if (Date.now() > stop) throw new Error(`run ${id} still ${r.status}`);
      await sleep(100);
    }
  };
  return { store, host, src, runner, token, audits, svc, repo, settle };
}

test('no runner carries the labels: the run fails at once as no_runner, naming them', async () => {
  const s = await setup();
  const run = await s.svc.startRun({ repoId: s.repo.id, pipeline: 'ci', ref: 'main' });
  assert.deepEqual(run.runsOn, ['big', 'python']);
  const done = await s.settle(run.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.reason, 'no_runner');
  assert.match(done.diagnostics[0]!.message, /big, python/);
});

test('a runner with the labels takes the run: commit by bundle into its mirror, secret by lease, masked, removed after', async () => {
  const s = await setup();
  const r = await s.svc.upsertRunner(RUNNER, { labels: ['python', 'BIG', 'gpu'], maxRuns: 1 }, PERSON);
  assert.deepEqual(r.labels, ['big', 'gpu', 'python']);
  assert.equal(r.state, 'online');

  const run = await s.svc.startRun({ repoId: s.repo.id, pipeline: 'ci', ref: 'main' });
  const done = await s.settle(run.id);
  assert.equal(done.status, 'passed', JSON.stringify(done.detail));
  assert.equal(done.runnerWorkspaceId, RUNNER);
  // The step ran in the runner's home, with the secret, which the log shows masked.
  const log = (await s.svc.log(run.id, 'test', 0, 0)).text;
  assert.match(log, new RegExp(`ran-in=${s.runner.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(!log.includes(s.token), 'the secret value never reaches the log');
  assert.match(log, /token=\*+|token=\[/);
  // The commit came as a bundle into a mirror, not into the runner's own remotes; the lease is gone; the source's outbox is empty.
  const ci = join(s.runner.home, '.claudepilot/ci');
  assert.ok(existsSync(join(ci, 'mirrors', `${mirrorOf(SRC, 'app')}.git`, 'HEAD')));
  assert.ok(!existsSync(join(s.runner.home, '.claudepilot/git/app.git')));
  assert.deepEqual(existsSync(join(ci, 'leases')) ? readdirSync(join(ci, 'leases')) : [], []);
  assert.deepEqual(existsSync(join(s.src.home, '.claudepilot/ci/outbox')) ? readdirSync(join(s.src.home, '.claudepilot/ci/outbox')) : [], []);
  assert.ok(s.host.calls.some((c) => c.ws === RUNNER && c.args[0] === 'mirror' && c.args[1] === 'put'));
  // Audited with the secret's NAME only.
  const a = s.audits.find((e) => e.kind === 'ci.run_on_runner');
  assert.deepEqual(a?.detail?.secrets, ['DEPLOY_TOKEN']);
  assert.ok(!JSON.stringify(s.audits).includes(s.token));
  const listed = await s.svc.runners();
  assert.equal(listed[0]!.running, 0);

  // The same commit again: the mirror has it, nothing travels.
  const before = s.host.calls.length;
  const again = await s.svc.startRun({ repoId: s.repo.id, pipeline: 'ci', ref: 'main' });
  assert.equal((await s.settle(again.id)).status, 'passed');
  assert.ok(!s.host.calls.slice(before).some((c) => c.args[0] === 'mirror' && c.args[1] === 'put'));
  assert.ok(!s.host.calls.slice(before).some((c) => c.args[0] === 'repo' && c.args[1] === 'bundle'));
});

test('a drained or stopped runner gets no run: it waits queued', async () => {
  const s = await setup();
  await s.svc.upsertRunner(RUNNER, { labels: ['big', 'python'], drained: true }, PERSON);
  const run = await s.svc.startRun({ repoId: s.repo.id, pipeline: 'ci', ref: 'main' });
  await s.svc.poll(SRC);
  assert.equal((await s.svc.show(run.id)).status, 'queued');
  await s.svc.upsertRunner(RUNNER, { labels: ['big', 'python'], drained: false }, PERSON);
  s.host.down.add(RUNNER);
  await s.svc.poll(SRC);
  assert.equal((await s.svc.show(run.id)).status, 'queued');
  s.host.down.delete(RUNNER);
  assert.equal((await s.settle(run.id)).status, 'passed');
});

test('a stalled runner never holds the source workspace\'s poll, and a run is handed to it once', async () => {
  const s = await setup();
  await s.svc.upsertRunner(RUNNER, { labels: ['big', 'python'] }, PERSON);
  s.host.hang.add(RUNNER);
  const run = await s.svc.startRun({ repoId: s.repo.id, pipeline: 'ci', ref: 'main' });
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await s.svc.poll(SRC);
    assert.ok(Date.now() - t0 < 5_000, `poll ${i} took ${Date.now() - t0} ms`);
  }
  assert.equal((await s.svc.show(run.id)).status, 'queued');
  assert.equal(s.host.calls.filter((c) => c.ws === RUNNER && c.args[0] === 'mirror').length, 1, 'one hand-off in flight, not one per poll');
});

test('runner settings: labels are checked, and a runner that is gone is refused', async () => {
  const s = await setup();
  assert.equal(await codeOf(() => s.svc.upsertRunner(RUNNER, { labels: [] }, PERSON)), 'VALIDATION_FAILED');
  assert.equal(await codeOf(() => s.svc.upsertRunner(RUNNER, { labels: ['Bad Label'] }, PERSON)), 'VALIDATION_FAILED');
  assert.equal(await codeOf(() => s.svc.upsertRunner(RUNNER, { labels: ['self-hosted'] }, PERSON)), 'VALIDATION_FAILED');
  assert.equal(await codeOf(() => s.svc.upsertRunner(RUNNER, { labels: ['x'], maxRuns: 99 }, PERSON)), 'VALIDATION_FAILED');
  assert.equal(await codeOf(() => s.svc.upsertRunner('docker/nope', { labels: ['x'] }, PERSON)), 'NOT_FOUND');
  await s.svc.upsertRunner(RUNNER, { labels: ['x'] }, PERSON);
  await s.svc.removeRunner(RUNNER, PERSON);
  assert.equal(await codeOf(() => s.svc.removeRunner(RUNNER, PERSON)), 'NOT_FOUND');
});

test('runs-on in the spec: labels, the old hosted names, and one runner per pipeline', () => {
  const read = (yml: string) => validateFiles([{ path: '.pilot/ci.yml', text: yml }]).pipelines[0]!;
  const job = (on: string) => `on: { push: {} }\njobs:\n  a:\n    runs-on: ${on}\n    steps: [{ run: 'true' }]\n`;
  assert.deepEqual(read(job('[self-hosted, Python, big]')).pipeline?.runsOn, ['big', 'python']);
  const hosted = read(job('ubuntu-latest'));
  assert.equal(hosted.pipeline?.runsOn, null);
  assert.ok(hosted.info.diagnostics.some((d) => d.code === 'ignored-runs-on' && d.severity === 'warning'));
  assert.equal(read(job('workspace')).info.diagnostics.length, 0);
  assert.ok(read(job('"bad label"')).info.diagnostics.some((d) => d.code === 'bad-name'));
  // GitHub's hosted macOS and Windows images are not runners here; a runner of our own may be labelled macos.
  assert.ok(read(job('macos-latest')).info.diagnostics.some((d) => d.code === 'unsupported-runner' && d.severity === 'error'));
  assert.deepEqual(read(job('[macos, arm64]')).pipeline?.runsOn, ['arm64', 'macos']);
  const mixed = read(`on: { push: {} }\njobs:\n  a:\n    runs-on: [python]\n    steps: [{ run: 'true' }]\n  b:\n    steps: [{ run: 'true' }]\n`);
  assert.equal(mixed.pipeline, null);
  assert.ok(mixed.info.diagnostics.some((d) => d.code === 'runs-on-mixed'));
});
