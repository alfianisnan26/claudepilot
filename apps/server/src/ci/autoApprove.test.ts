// The auto-approve rule, slice 1 (T-110, PRD FR41a): DRY MODE. Each condition is refused with its own reason (a fake runner and store, a
// fake clock), the WOULD approve line, and then the whole thing through the CI service on the real runner and real git: dry never approves
// (no `cp-ci approve`, the key stays in the portal, the job keeps waiting), off writes nothing, a gate skipped by its input and a diff
// that touches authz or a released migration are WOULD NOT, and the audit row. Shas and dates are made at run time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CI_AUTO_APPROVE_DEFAULT_PATHS, type CiJob, type CiRunStateFile, type CiUnitStatus } from '@portal/contracts';
import { evaluateRule, gateVerdict, inWindow, MIGRATIONS_FILE, releasedMigrationChanges, type RuleDeps } from './autoApprove.js';
import type { CiReply } from './host.js';
import type { Plan } from './plan.js';
import type { CiDecider } from './service.js';
import type { CiStore, DeploymentRow, EnvironmentRow, RunRow } from './store.js';
import { codeOf, harness, remote, sleep, type H } from './testkit.js';

const sha = (c: string) => c.repeat(40);
const SHA = sha('c');
const BASE = sha('b');
/** A fake clock: today at 03:00 UTC (made at run time, never a fixed date). */
const at = (hh: number, mm = 0) => {
  const d = new Date();
  d.setUTCHours(hh, mm, 0, 0);
  return d;
};

/* ---------- Pure parts ---------- */

test('the gate verdict is the gate job’s own last line, green at this exact commit', () => {
  assert.equal(gateVerdict(`npm ci ok\ngate: green at ${SHA.slice(0, 7)}\n`, SHA), null);
  assert.match(gateVerdict('gate: skipped (input gate=false)\n', SHA)!, /did not say green .*skipped/);
  assert.match(gateVerdict('[dry-run] would run: scripts/gate-job.sh ccccccc\n', SHA)!, /no verdict line/);
  assert.match(gateVerdict(`gate: green at ${BASE.slice(0, 7)}\n`, SHA)!, /green at bbbbbbb, not at ccccccc/);
  assert.match(gateVerdict(`gate: green at ${SHA.slice(0, 7)}\ngate: red at ${SHA.slice(0, 7)}\n`, SHA)!, /did not say green/, 'the last verdict counts');
  assert.match(gateVerdict('', SHA)!, /no verdict line/);
});

const MIGS = (blocks: string[]) => `export const MIGRATIONS: Migration[] = [\n${blocks.join('')}];\n\nexport const ENCRYPTED_COLUMNS = [];\n`;
const block = (v: number, body: string) => `  {\n    version: ${v},\n    name: 'm${v}',\n    up(db) {\n      db.exec('${body}');\n    },\n  },\n`;

test('a released migration is one present at the last release: new ones anywhere pass, an edit or a removal does not', () => {
  const base = MIGS([block(1, 'A'), block(610, 'B'), block(713, 'C')]);
  assert.deepEqual(releasedMigrationChanges(base, MIGS([block(1, 'A'), block(610, 'B'), block(713, 'C'), block(714, 'D'), block(716, 'E')])), [], 'appended (run 18: 714 and 716)');
  assert.deepEqual(releasedMigrationChanges(base, MIGS([block(1, 'A'), block(381, 'N'), block(610, 'B'), block(713, 'C')])), [], 'inserted in the middle');
  assert.deepEqual(releasedMigrationChanges(base, MIGS([block(1, 'A'), block(610, 'B2'), block(713, 'C')])), [610], 'an edit');
  assert.deepEqual(releasedMigrationChanges(base, MIGS([block(1, 'A'), block(610, 'B')])), [713], 'a removal');
  assert.deepEqual(releasedMigrationChanges(null, base), [], 'no file at the release: nothing was released');
  assert.equal(releasedMigrationChanges(base, null), null, 'the file deleted: can not be judged');
  assert.equal(releasedMigrationChanges(base, 'not the file'), null);
  assert.equal(releasedMigrationChanges(base, MIGS([block(1, 'A'), block(1, 'A2')])), null, 'a version twice: can not be judged');
});

test('the window is HH:MM-HH:MM in UTC, may cross midnight, and null is always', () => {
  assert.equal(inWindow(null, at(3)), true);
  assert.equal(inWindow('02:00-06:00', at(3)), true);
  assert.equal(inWindow('02:00-06:00', at(6)), false);
  assert.equal(inWindow('22:00-04:00', at(3)), true);
  assert.equal(inWindow('22:00-04:00', at(12)), false);
  assert.equal(inWindow('25:00-04:00', at(3)), false, 'unreadable is never inside');
});

/* ---------- Each condition, with a fake runner and store ---------- */

const step = (idx: number, status: CiUnitStatus = 'passed') => ({ idx, name: `s${idx}`, status, startedAt: null, durationMs: null, exitCode: 0, logBytes: 0, logTruncated: false, ignored: false, reason: null });
const job = (id: string, status: CiUnitStatus, needs: string[] = [], extra: Partial<CiJob> = {}): CiJob => ({ id, name: id, status, needs, startedAt: null, durationMs: null, ignored: false, reason: null, steps: [step(0, status === 'pending' ? 'pending' : 'passed')], artifacts: [], artifactsSkipped: 0, environment: null, ...extra });
const JOBS = (): CiJob[] => [job('gate', 'passed'), job('build', 'passed', ['gate']), job('release', 'waiting', ['build'], { environment: 'production' }), job('verify', 'pending', ['release']), job('rollback', 'pending', ['release', 'verify'])];
const planOf = (jobs: CiJob[]): Plan => ({ jobs: jobs.map((j) => ({ id: j.id, name: j.name, needs: j.needs, skip: null, steps: [] })) }) as unknown as Plan;

function runRow(id: string, jobs: CiJob[], o: Partial<RunRow> = {}): RunRow {
  const state: CiRunStateFile = { v: 1, runId: id, status: 'running', reason: null, startedAt: null, finishedAt: null, durationMs: null, jobs };
  return { id, number: 9, workspace_id: 'docker/test', repo_id: 'p1', repo: 'app', pipeline: 'deploy', trigger: 'manual', event_id: null, ref: 'refs/heads/main', branch: 'main', tag: null, sha: SHA, base_sha: null, subject: null, status: 'running', reason: null, actor: 'ui', actor_label: null, inputs: '{}', ticket_id: null, ticket_source: null, session_id: null, rerun_of: null, concurrency_group: null, cancel_in_progress: 0, plan: JSON.stringify(planOf(jobs)), state: JSON.stringify(state), diagnostics: null, attempts: 0, created_at: at(2).toISOString(), started_at: null, finished_at: null, duration_ms: null, archived: 0, ...o };
}
const depRow = (o: Partial<DeploymentRow & { run_status: string | null }> = {}): DeploymentRow & { run_status: string | null } => ({ id: 'd1', run_id: 'r1', run_number: 9, job: 'release', repo_id: 'p1', environment: 'production', pipeline: 'deploy', sha: SHA, ref: 'refs/heads/main', actor: 'ui', approval: 'waiting', gate_key: null, decided_by: null, decided_at: null, outcome: null, owner_id: 'u_owner', created_by: 'u_owner', created_at: at(2).toISOString(), run_status: 'running', ...o });
const ENV: EnvironmentRow = { id: 'e1', repo_id: 'p1', name: 'production', protected: 1, owner_id: 'u_owner', created_by: 'system', created_at: '', updated_at: '', updated_by: 'u_owner', auto_approve: 'dry', auto_window: null, auto_paths: null };

interface World {
  run: RunRow;
  dep: DeploymentRow;
  env: EnvironmentRow;
  released: DeploymentRow | undefined;
  others: (DeploymentRow & { run_status: string | null })[];
  runs: Map<string, RunRow>;
  log: string;
  logReply?: CiReply;
  changes: CiReply;
  now: Date;
  calls: string[][];
}

function world(): World {
  const run = runRow('r1', JOBS());
  return {
    run,
    dep: depRow(),
    env: { ...ENV },
    released: depRow({ id: 'd0', run_id: 'r0', run_number: 8, sha: BASE, approval: 'approved', outcome: 'passed', run_status: 'passed' }),
    others: [],
    runs: new Map([['r1', run]]),
    log: `gate: green at ${SHA.slice(0, 7)}\n`,
    changes: { ok: true, paths: ['README.md', 'apps/web/src/x.tsx'], truncated: false, ancestor: true, show: { path: MIGRATIONS_FILE, base: null, head: null, tooLarge: false } },
    now: at(3),
    calls: [],
  };
}

async function judge(w: World) {
  const deps: RuleDeps = {
    cs: { lastReleased: () => w.released, ruleDeployments: () => [depRow(), ...w.others], run: (id: string) => w.runs.get(id) } as unknown as CiStore,
    now: () => w.now,
    cp: async (_ws, args) => {
      w.calls.push(args);
      if (args[0] === 'log') return w.logReply ?? { ok: true, text: w.log, size: w.log.length, next: w.log.length, done: true };
      if (args[0] === 'changes') return w.changes;
      return { ok: false, error: 'unexpected' };
    },
  };
  return evaluateRule(deps, w.run, w.dep, w.env);
}

const NOT = (why: RegExp) => async (change: (w: World) => void) => {
  const w = world();
  change(w);
  const v = await judge(w);
  assert.equal(v.verdict, 'would_not', v.line);
  assert.match(v.line, /^auto-approve \(dry\): WOULD NOT: /);
  assert.match(v.line, why);
  return w;
};

test('WOULD approve: every condition holds; the line names the commit and the count, and the rule only reads', async () => {
  const w = world();
  const v = await judge(w);
  assert.deepEqual(v, { verdict: 'would', line: 'auto-approve (dry): WOULD approve: gate green at ccccccc, build ok, verify and rollback present, no authz/secrets/Bypass/deny-rule/released-migration change in the diff, 1 of 6 today' });
  assert.deepEqual(w.calls.map((c) => c[0]), ['log', 'changes'], 'reads only: never approve');
  assert.deepEqual(w.calls[1], ['changes', 'app', BASE, SHA, '--show', MIGRATIONS_FILE], 'the diff since the last release');
  w.others = [1, 2].map((n) => depRow({ id: `w${n}`, run_id: `x${n}`, run_number: n, approval: 'expired', auto_verdict: 'would', auto_at: new Date(w.now.getTime() - n * 3_600_000).toISOString(), run_status: 'cancelled' }));
  assert.match((await judge(w)).line, /, 3 of 6 today$/);
});

test('1. the gate: no gate job, not passed, skipped by its input, green at another commit, a log that can not be read', async () => {
  await NOT(/the pipeline has no gate job/)((w) => (w.run = runRow('r1', JOBS().filter((j) => j.id !== 'gate'))));
  await NOT(/the gate job is failed, not passed/)((w) => (w.run = runRow('r1', JOBS().map((j) => (j.id === 'gate' ? { ...j, status: 'failed' as const, ignored: true } : j)))));
  await NOT(/did not say green \(“gate: skipped \(input gate=false\)”\)/)((w) => (w.log = 'gate: skipped (input gate=false)\n'));
  await NOT(/the gate was green at bbbbbbb, not at ccccccc/)((w) => (w.log = `gate: green at ${BASE.slice(0, 7)}\n`));
  await NOT(/the gate job’s log can not be read/)((w) => (w.logReply = { ok: false, error: 'bad_log' }));
});

test('2. the build: missing or not passed', async () => {
  await NOT(/the pipeline has no build job/)((w) => (w.run = runRow('r1', JOBS().filter((j) => j.id !== 'build'))));
  await NOT(/the build job is failed, not passed/)((w) => (w.run = runRow('r1', JOBS().map((j) => (j.id === 'build' ? { ...j, status: 'failed' as const, ignored: true } : j)))));
});

test('3. verify and rollback present and following the deploy; the previous release known', async () => {
  await NOT(/the pipeline has no verify job/)((w) => (w.run = runRow('r1', JOBS().filter((j) => j.id !== 'verify'))));
  await NOT(/the pipeline has no rollback job/)((w) => (w.run = runRow('r1', JOBS().filter((j) => j.id !== 'rollback'))));
  await NOT(/the rollback job does not follow release/)((w) => (w.run = runRow('r1', JOBS().map((j) => (j.id === 'rollback' ? { ...j, needs: ['verify'] } : j)))));
  await NOT(/no earlier release of production is recorded, so the rollback’s previous tag is not known/)((w) => (w.released = undefined));
});

test('4. the diff: a path that needs a person, a released migration, a diff that can not be read', async () => {
  for (const p of ['apps/server/src/authz/seam.ts', 'apps/server/src/tickets/authz.ts', 'apps/server/src/secrets/values.ts', 'apps/server/src/chat/bypass.ts', '.claude/settings.json', '.pilot/scripts/gate.sh', 'apps/server/src/ci/autoApprove.ts'])
    await NOT(new RegExp(`changes ${p.replace(/\./g, '\\.')}, which needs a person`))((w) => ((w.changes.paths as string[]).push(p)));
  const base = MIGS([block(1, 'A'), block(610, 'B')]);
  await NOT(/the diff changes released migration 610/)((w) => (w.changes = { ...w.changes, paths: [MIGRATIONS_FILE], show: { path: MIGRATIONS_FILE, base, head: MIGS([block(1, 'A'), block(610, 'B2')]), tooLarge: false } }));
  // New migrations (run 18 added 714 and 716) are no reason to refuse.
  const w = world();
  w.changes = { ...w.changes, paths: [MIGRATIONS_FILE], show: { path: MIGRATIONS_FILE, base, head: MIGS([block(1, 'A'), block(610, 'B'), block(714, 'C'), block(716, 'D')]), tooLarge: false } };
  assert.equal((await judge(w)).verdict, 'would');
  await NOT(/the migrations file can not be read/)((w) => (w.changes = { ...w.changes, paths: [MIGRATIONS_FILE], show: { path: MIGRATIONS_FILE, base, head: null, tooLarge: true } }));
  await NOT(/is too large to read/)((w) => (w.changes = { ...w.changes, truncated: true }));
  await NOT(/a commit is missing in the remote/)((w) => (w.changes = { ok: false, error: 'no_commit' }));
  await NOT(/the workspace’s runner is too old/)((w) => (w.changes = { ok: false, error: 'bad_command' }));
  await NOT(/ccccccc does not descend from the last release bbbbbbb/)((w) => (w.changes = { ...w.changes, ancestor: false }));
  // The environment's own list replaces the defaults.
  await NOT(/changes docs\/x\.md, which needs a person/)((w) => ((w.env = { ...w.env, auto_paths: JSON.stringify(['docs/**']) }), (w.changes.paths as string[]).push('docs/x.md')));
  assert.ok(CI_AUTO_APPROVE_DEFAULT_PATHS.includes('.claude/settings.json'));
});

test('5. at most 6 a day (the last 24 hours on the clock) and one at a time', async () => {
  const would = (n: number, hoursAgo: number, run_status = 'cancelled') => depRow({ id: `w${n}`, run_id: `x${n}`, run_number: n, approval: 'expired', auto_verdict: 'would', auto_at: new Date(at(3).getTime() - hoursAgo * 3_600_000).toISOString(), run_status });
  await NOT(/6 of 6 today already/)((w) => (w.others = [1, 2, 3, 4, 5, 6].map((n) => would(n, n))));
  const w = world();
  w.others = [1, 2, 3, 4, 5].map((n) => would(n, n)).concat([would(6, 25)]);
  assert.match((await judge(w)).line, /6 of 6 today$/, 'one 25 hours old no longer counts');
  await NOT(/#4, approved by the rule, is still running \(one at a time\)/)((w) => (w.others = [would(4, 1, 'running')]));
});

test('6. inside the allowed window', async () => {
  await NOT(/outside the allowed window 05:00-06:00 UTC/)((w) => (w.env = { ...w.env, auto_window: '05:00-06:00' }));
  const w = world();
  w.env = { ...w.env, auto_window: '02:00-04:00' };
  assert.equal((await judge(w)).verdict, 'would');
});

test('7. the previous auto-approved deploy is not failing or rolled back; a fact that can not be read is a WOULD NOT', async () => {
  const prev = (o: Partial<DeploymentRow & { run_status: string | null }>, jobs = JOBS()) => (w: World) => {
    w.others = [depRow({ id: 'p', run_id: 'rp', run_number: 7, approval: 'approved', auto_verdict: 'would', auto_at: at(1).toISOString(), outcome: 'passed', run_status: 'passed', ...o })];
    w.runs.set('rp', runRow('rp', jobs));
  };
  await NOT(/the previous auto-approved deploy #7 is failed/)(prev({ run_status: 'failed' }));
  await NOT(/the previous auto-approved deploy #7 was rolled back/)(prev({ run_status: 'failed' }, JOBS().map((j) => (j.id === 'rollback' ? { ...j, status: 'passed' as const } : j))));
  await NOT(/the record of the previous auto-approved deploy #7 is gone/)(prev({ run_status: null }));
  // A held deploy the owner rejected never went out: it is not "the previous deploy".
  const w = world();
  prev({ approval: 'rejected', outcome: 'cancelled', run_status: 'cancelled' })(w);
  assert.equal((await judge(w)).verdict, 'would');
  await NOT(/the run’s state can not be read/)((w) => (w.run = { ...w.run, state: null }));
});

/* ---------- Through the CI service, on the real runner ---------- */

const GATE_STEP = `if [ "$PILOT_INPUT_GATE" = true ]; then echo "gate: green at $(printf %.7s "$PILOT_SHA")"; else echo "gate: skipped (input gate=false)"; fi`;
const DEPLOY = `on:
  manual:
    inputs:
      gate: { type: boolean, default: true }
jobs:
  gate:
    steps:
      - run: '${GATE_STEP}'
  build:
    needs: [gate]
    steps: [{ run: echo built }]
  release:
    needs: [build]
    environment: production
    steps: [{ run: echo released }]
  verify:
    needs: [release]
    steps: [{ run: echo verified }]
  rollback:
    needs: [release, verify]
    if: failure()
    steps: [{ run: echo rolled back }]
`;
const OWNER: CiDecider = { actor: 'user:u_owner', userId: 'u_owner' };
type Audit = { kind: string; actor: string; userId: string | null; subject?: string; detail?: Record<string, unknown> };

async function setup() {
  const audit: Audit[] = [];
  const h = await harness({ audit: (e) => void audit.push(e), now: () => at(3) });
  const repo = await remote(h, { '.pilot/deploy.yml': DEPLOY, [MIGRATIONS_FILE]: MIGS([block(1, 'A'), block(610, 'B')]) });
  return { h, repo, audit };
}
const waiting = (h: H, id: string) => h.until('the release to wait', () => h.svc.get(id).deployments.some((d) => d.approval === 'waiting'));
const keyOf = (h: H, id: string) => (h.store.db!.prepare('SELECT gate_key FROM ci_deployments WHERE run_id = ?').get(id) as { gate_key: string | null }).gate_key;
const push = (h: H, files: Record<string, string>) => {
  h.home.commit(h.src, files, 'change');
  h.home.git(['push', '-q', 'pilot', 'main'], h.src);
};

test('service: off writes nothing; dry writes one line and one audit row, approves nothing, and the job keeps waiting with its key', async () => {
  const { h, repo, audit } = await setup();
  try {
    // Off (the default): the first deploy waits as always and the rule says nothing. A person approves it: the first release.
    assert.equal(h.svc.environments(repo.id).length, 0);
    const first = await h.svc.startRun({ repoId: repo.id, pipeline: 'deploy', ref: 'main' });
    await waiting(h, first.id);
    await h.svc.settled();
    assert.equal(h.svc.environments(repo.id)[0]!.autoApprove, 'off');
    assert.equal(h.svc.get(first.id).deployments[0]!.autoApprove, null, 'off writes nothing');
    assert.equal(audit.length, 0, 'no audit row');
    await h.svc.decide(first.id, 'release', 'approve', OWNER);
    await h.until('the first release to pass', () => h.svc.get(first.id).status === 'passed');

    // Dry, set by a person: audited.
    assert.equal(await codeOf(async () => h.svc.setAutoApprove(repo.id, 'production', { mode: 'on' as 'dry' }, OWNER)), 'VALIDATION_FAILED', 'on does not exist yet');
    assert.equal(await codeOf(async () => h.svc.setAutoApprove(repo.id, 'production', { mode: 'dry', window: '9-17' }, OWNER)), 'VALIDATION_FAILED');
    assert.equal(await codeOf(async () => h.svc.setAutoApprove(repo.id, 'staging', { mode: 'dry' }, OWNER)), 'NOT_FOUND');
    const env = h.svc.setAutoApprove(repo.id, 'production', { mode: 'dry' }, OWNER);
    assert.deepEqual([env.autoApprove, env.autoApproveWindow, env.needsPerson], ['dry', null, [...CI_AUTO_APPROVE_DEFAULT_PATHS]]);
    h.svc.setAutoApprove(repo.id, 'production', { mode: 'dry' }, OWNER);
    assert.deepEqual(audit.map((a) => [a.kind, a.actor, a.userId, a.subject, a.detail?.environment, a.detail?.mode, a.detail?.was]), [['ci.environment_auto_approve', 'user:u_owner', 'u_owner', `ci_repo:${repo.id}`, 'production', 'dry', 'off']], 'one row; no change, no row');

    // A harmless change, then a deploy: WOULD approve, and nothing else happens.
    push(h, { 'README.md': '# app, changed\n' });
    const second = await h.svc.startRun({ repoId: repo.id, pipeline: 'deploy', ref: 'main' });
    await waiting(h, second.id);
    await h.svc.settled();
    const held = h.svc.get(second.id);
    const line = `auto-approve (dry): WOULD approve: gate green at ${second.sha.slice(0, 7)}, build ok, verify and rollback present, no authz/secrets/Bypass/deny-rule/released-migration change in the diff, 1 of 6 today`;
    assert.deepEqual(held.deployments.map((d) => [d.approval, d.decidedBy, d.autoApprove?.verdict, d.autoApprove?.line]), [['waiting', null, 'would', line]]);
    assert.ok(!h.host.calls.some((c) => c[0] === 'approve'), 'cp-ci approve was never called');
    assert.match(keyOf(h, second.id) ?? '', /^[0-9a-f]{64}$/, 'the key is still in the portal, unused');
    await sleep(600);
    await h.svc.poll('docker/test');
    assert.equal(h.svc.get(second.id).detail.find((j) => j.id === 'release')!.status, 'waiting', 'dry approves nothing: the job still waits');
    const rows = audit.filter((a) => a.kind === 'ci.deploy_auto_approve');
    assert.deepEqual(rows.map((a) => [a.actor, a.userId, a.subject, a.detail?.verdict, a.detail?.mode, a.detail?.line]), [['rule:production', null, `ci_run:${second.id}`, 'would', 'dry', line]]);
    assert.ok(!JSON.stringify(audit).includes(keyOf(h, second.id)!), 'the key is in no audit row');
    // The environment list shows the line on its deployment too, and a person still decides.
    assert.equal(h.svc.environments(repo.id)[0]!.deployments[0]!.autoApprove?.line, line);
    await h.svc.decide(second.id, 'release', 'reject', OWNER);
    await h.until('the second to end', () => h.svc.get(second.id).status === 'cancelled');
  } finally {
    h.done();
  }
});

test('service: WOULD NOT for a gate skipped by its input, a diff into authz and an edit of a released migration (the real runner’s diff)', async () => {
  const { h, repo, audit } = await setup();
  try {
    const first = await h.svc.startRun({ repoId: repo.id, pipeline: 'deploy', ref: 'main' });
    await waiting(h, first.id);
    await h.svc.decide(first.id, 'release', 'approve', OWNER);
    await h.until('the first release to pass', () => h.svc.get(first.id).status === 'passed');
    h.svc.setAutoApprove(repo.id, 'production', { mode: 'dry' }, OWNER);

    const lineOf = async (inputs: Record<string, boolean> = {}) => {
      const run = await h.svc.startRun({ repoId: repo.id, pipeline: 'deploy', ref: 'main', inputs });
      await waiting(h, run.id);
      await h.svc.settled();
      const d = h.svc.get(run.id).deployments[0]!;
      assert.equal(d.approval, 'waiting');
      await h.svc.cancel(run.id);
      await h.until('the run to end', () => h.svc.get(run.id).status === 'cancelled');
      return d.autoApprove?.line ?? '';
    };
    assert.equal(await lineOf({ gate: false }), 'auto-approve (dry): WOULD NOT: the gate job did not say green (“gate: skipped (input gate=false)”)');
    push(h, { 'apps/server/src/authz/seam.ts': 'export {};\n' });
    assert.match(await lineOf(), /WOULD NOT: the diff since [0-9a-f]{7} changes apps\/server\/src\/authz\/seam\.ts, which needs a person$/);
    h.home.git(['rm', '-q', 'apps/server/src/authz/seam.ts'], h.src);
    push(h, { [MIGRATIONS_FILE]: MIGS([block(1, 'A'), block(610, 'B, edited')]) });
    assert.match(await lineOf(), /WOULD NOT: the diff changes released migration 610$/);
    assert.ok(!h.host.calls.some((c) => c[0] === 'approve'));
    assert.deepEqual(audit.filter((a) => a.kind === 'ci.deploy_auto_approve').map((a) => a.detail?.verdict), ['would_not', 'would_not', 'would_not']);
  } finally {
    h.done();
  }
});

test('migration 780: every environment starts off, the mode and the verdict take only their values', async () => {
  const h = await harness();
  try {
    const db = h.store.db!;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO ci_environments (id, repo_id, name, created_at, updated_at, updated_by) VALUES ('e1', 'p1', 'production', ?, ?, 'system')").run(now, now);
    assert.deepEqual({ ...(db.prepare('SELECT auto_approve, auto_window, auto_paths FROM ci_environments').get() as object) }, { auto_approve: 'off', auto_window: null, auto_paths: null });
    assert.throws(() => db.prepare("UPDATE ci_environments SET auto_approve = 'always'").run(), /CHECK/);
    db.prepare("INSERT INTO ci_deployments (id, run_id, run_number, job, repo_id, environment, pipeline, sha, ref, actor, approval, created_at) VALUES ('d1', 'r1', 1, 'release', 'p1', 'production', 'deploy', ?, 'refs/heads/main', 'ui', 'waiting', ?)").run(SHA, now);
    assert.throws(() => db.prepare("UPDATE ci_deployments SET auto_verdict = 'approved'").run(), /CHECK/);
  } finally {
    h.done();
  }
});
