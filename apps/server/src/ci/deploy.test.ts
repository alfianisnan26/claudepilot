// Deployments and their approval (PRD FR41) on the real runner and real git in a temporary home (the "workspace"): a job that names a
// protected environment waits for a person; approving hands the runner a key only the portal holds; rejecting ends the run; protection is a
// record a person switches; a rerun gets fresh gates; the key never leaves the service.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CiDecider } from './service.js';
import { codeOf, harness, remote, WS, type H } from './testkit.js';

const DEPLOY = `on:
  manual:
    inputs:
      deploy: { type: boolean, default: true }
jobs:
  build:
    steps: [{ run: echo built }]
  release:
    needs: [build]
    if: inputs.deploy
    environment: production
    steps: [{ run: echo released }]
  verify:
    needs: [release]
    steps: [{ run: echo verified }]
`;

const OWNER: CiDecider = { actor: 'user:u_owner', userId: 'u_owner' };

type Audit = { kind: string; actor: string; userId: string | null; subject?: string; detail?: Record<string, unknown> };

async function setup() {
  const audit: Audit[] = [];
  const h = await harness({ audit: (e) => void audit.push(e) });
  const repo = await remote(h, { '.pilot/deploy.yml': DEPLOY, '.pilot/ci.yml': 'on: [push, manual]\njobs:\n  t:\n    steps: [{ run: echo t }]\n' });
  return { h, repo, audit };
}

const waitingJob = async (h: H, id: string) => h.until('the release job to wait', () => h.svc.get(id).deployments.some((d) => d.approval === 'waiting'));

test('a protected environment holds its job until a person approves; the key is never shown and reaches the runner only then', async () => {
  const { h, repo, audit } = await setup();
  try {
    const started = await h.svc.startRun({ repoId: repo.id, pipeline: 'deploy', ref: 'main' });
    assert.deepEqual(started.deployments.map((d) => [d.job, d.environment, d.approval]), [['release', 'production', 'pending']]);
    assert.deepEqual(h.svc.environments(repo.id).map((e) => [e.name, e.protected]), [['production', true]], 'made protected on first use');
    await waitingJob(h, started.id);
    const held = h.svc.get(started.id);
    assert.equal(held.status, 'running');
    assert.deepEqual(held.detail.map((j) => [j.id, j.status, j.environment ?? null]), [['build', 'passed', null], ['release', 'waiting', 'production'], ['verify', 'pending', null]]);

    // The key is in the portal's database only: not in any answer, not in the plan the workspace got (that has its hash).
    const key = (h.store.db!.prepare('SELECT gate_key FROM ci_deployments WHERE run_id = ?').get(started.id) as { gate_key: string }).gate_key;
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(held).includes(key) && !JSON.stringify(h.svc.environments(repo.id)).includes(key));
    const planText = readFileSync(join(h.home.home, '.claudepilot/ci/runs', started.id, 'plan.json'), 'utf8');
    assert.ok(!planText.includes(key), 'the workspace sees the gate, never the key');
    assert.match(planText, /"approval":\{"environment":"production","gate":"[0-9a-f]{64}"\}/);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(h.svc.get(started.id).detail[1]!.status, 'waiting', 'nothing moves without a person');

    assert.equal(await codeOf(() => h.svc.decide(started.id, 'build', 'approve', OWNER)), 'NOT_FOUND', 'a job that deploys nowhere has nothing to approve');
    assert.equal(await codeOf(() => h.svc.decide(started.id, '../x', 'approve', OWNER)), 'VALIDATION_FAILED');
    const approved = await h.svc.decide(started.id, 'release', 'approve', OWNER);
    assert.deepEqual(approved.deployments.map((d) => [d.approval, d.decidedBy]), [['approved', 'user:u_owner']]);
    assert.equal(await codeOf(() => h.svc.decide(started.id, 'release', 'reject', OWNER)), 'CONFLICT', 'decided once');
    await h.until('the run to pass', () => h.svc.get(started.id).status === 'passed');
    const done = h.svc.get(started.id);
    assert.deepEqual(done.detail.map((j) => j.status), ['passed', 'passed', 'passed']);
    assert.deepEqual(done.deployments.map((d) => [d.approval, d.outcome]), [['approved', 'passed']]);
    assert.equal((h.store.db!.prepare('SELECT gate_key FROM ci_deployments WHERE run_id = ?').get(started.id) as { gate_key: string | null }).gate_key, null, 'the key is dropped once used');
    // FR39 (T-476): the start by hand is one more row, `ci.run_started`, ahead of the person's decision.
    assert.deepEqual(audit.map((a) => a.kind), ['ci.run_started', 'ci.deploy_approved']);
    assert.deepEqual(audit.filter((a) => a.kind !== 'ci.run_started').map((a) => [a.kind, a.actor, a.userId, a.subject, a.detail?.environment, a.detail?.job]), [['ci.deploy_approved', 'user:u_owner', 'u_owner', `ci_run:${started.id}`, 'production', 'release']]);
    assert.ok(!JSON.stringify(audit).includes(key));
    assert.deepEqual(h.svc.environments(repo.id)[0]!.deployments.map((d) => [d.runId, d.approval, d.outcome]), [[started.id, 'approved', 'passed']], 'the environment keeps its history');
    assert.equal(await codeOf(() => h.svc.decide(started.id, 'release', 'approve', OWNER)), 'CONFLICT', 'a finished run decides nothing');
  } finally {
    h.done();
  }
});

test('a rejection ends the run as cancelled (rejected) and never starts what waits on the job', async () => {
  const { h, repo, audit } = await setup();
  try {
    const run = await h.svc.startRun({ repoId: repo.id, pipeline: 'deploy', ref: 'main' });
    await waitingJob(h, run.id);
    const r = await h.svc.decide(run.id, 'release', 'reject', OWNER);
    assert.equal(r.deployments[0]!.approval, 'rejected');
    await h.until('the run to end', () => h.svc.get(run.id).status === 'cancelled');
    const done = h.svc.get(run.id);
    assert.deepEqual([done.status, done.reason], ['cancelled', 'rejected']);
    assert.deepEqual(done.detail.map((j) => [j.status, j.reason]), [['passed', null], ['cancelled', 'rejected'], ['cancelled', 'rejected']]);
    assert.deepEqual(done.deployments.map((d) => [d.approval, d.outcome]), [['rejected', 'cancelled']]);
    assert.deepEqual(audit.map((a) => a.kind), ['ci.run_started', 'ci.deploy_rejected'], 'FR39 (T-476): the start, then the rejection');
    assert.ok(!h.finished.some((f) => f.id === run.id && f.status === 'failed'), 'a rejection is not a failure (no failure message, no ci_failed)');
  } finally {
    h.done();
  }
});

test('protection off: the next deployment runs without asking (auto); one already waiting still needs a person; a rerun gets fresh gates', async () => {
  const { h, repo, audit } = await setup();
  try {
    const first = await h.svc.startRun({ repoId: repo.id, pipeline: 'deploy', ref: 'main' });
    await waitingJob(h, first.id);
    const gateOf = (id: string) => JSON.parse(readFileSync(join(h.home.home, '.claudepilot/ci/runs', id, 'plan.json'), 'utf8')).jobs[1].approval;
    const firstGate = gateOf(first.id);

    assert.equal(await codeOf(() => Promise.resolve(h.svc.setEnvironment(repo.id, 'Prod!', { protected: false }, OWNER))), 'VALIDATION_FAILED');
    assert.equal(await codeOf(() => Promise.resolve(h.svc.setEnvironment(repo.id, 'production', {}, OWNER))), 'VALIDATION_FAILED');
    const off = h.svc.setEnvironment(repo.id, 'production', { protected: false }, OWNER);
    assert.equal(off.protected, false);
    // FR39 (T-476): the first start (above) is one `ci.run_started` row; the protection change is one more.
    assert.deepEqual(audit.map((a) => [a.kind, a.detail?.protected]), [['ci.run_started', undefined], ['ci.environment_protection', false]]);
    h.svc.setEnvironment(repo.id, 'production', { protected: false }, OWNER);
    assert.equal(audit.length, 2, 'no change, no row');
    await new Promise((r) => setTimeout(r, 500));
    await h.svc.poll(WS);
    assert.equal(h.svc.get(first.id).detail[1]!.status, 'waiting', 'switching protection off never lets a held job go by itself');
    await h.svc.decide(first.id, 'release', 'approve', OWNER);
    await h.until('the first to pass', () => h.svc.get(first.id).status === 'passed');

    const second = await h.svc.startRun({ repoId: repo.id, pipeline: 'deploy', ref: 'main' });
    assert.equal(second.deployments[0]!.approval, 'auto');
    await h.until('the second to pass unattended', () => h.svc.get(second.id).status === 'passed');
    assert.equal(gateOf(second.id), null);
    assert.deepEqual(h.svc.get(second.id).deployments.map((d) => [d.approval, d.outcome]), [['auto', 'passed']]);

    // Back on, then a rerun of the first run: its own gate, its own approval.
    h.svc.setEnvironment(repo.id, 'production', { protected: true }, OWNER);
    const again = await h.svc.rerun(first.id);
    assert.equal(again.deployments[0]!.approval, 'pending');
    await waitingJob(h, again.id);
    assert.notEqual(gateOf(again.id).gate, firstGate.gate, 'a fresh key');
    await h.svc.cancel(again.id);
    await h.until('the rerun to be cancelled', () => h.svc.get(again.id).status === 'cancelled');
    assert.deepEqual(h.svc.get(again.id).deployments.map((d) => d.approval), ['expired'], 'nobody decided: it expired with the run');

    // An input that leaves the deploying job out: no deployment at all.
    const buildOnly = await h.svc.startRun({ repoId: repo.id, pipeline: 'deploy', ref: 'main', inputs: { deploy: false } });
    assert.deepEqual(buildOnly.deployments, []);
    await h.until('build-only to pass', () => h.svc.get(buildOnly.id).status === 'passed');
    assert.deepEqual(h.svc.get(buildOnly.id).detail.map((j) => j.status), ['passed', 'skipped', 'skipped']);
  } finally {
    h.done();
  }
});

test('T-3004: an agent never deploys unattended outside stg: a run it starts to an unprotected environment is refused before anything runs', async () => {
  const audit: Audit[] = [];
  const h = await harness({ audit: (e) => void audit.push(e) });
  try {
    const STG = DEPLOY.replace('environment: production', 'environment: stg');
    const repo = await remote(h, { '.pilot/deploy.yml': DEPLOY, '.pilot/stg.yml': STG });
    const planOf = (id: string) => JSON.parse(readFileSync(join(h.home.home, '.claudepilot/ci/runs', id, 'plan.json'), 'utf8')) as { jobs: { id: string; env: Record<string, string> }[] };
    const approvalEnv = (id: string) => planOf(id).jobs.find((j) => j.id === 'release')!.env.PILOT_APPROVAL;

    // Protected (the default): the agent's run is held for a decision, and the deploying job knows it waited.
    const held = await h.svc.startRun({ repoId: repo.id, pipeline: 'deploy', ref: 'main' }, 'session:s1', { sessionId: 's1', deploymentOnly: 'no' });
    assert.equal(held.deployments[0]!.approval, 'pending');
    await waitingJob(h, held.id);
    assert.equal(approvalEnv(held.id), 'held');
    await h.svc.cancel(held.id);
    await h.until('the held run to end', () => h.svc.get(held.id).status === 'cancelled');

    // Protection off: every agent-like actor is refused, with what to do; the refusal is a failed run (the evidence), and nothing ran.
    h.svc.setEnvironment(repo.id, 'production', { protected: false }, OWNER);
    for (const actor of ['session:s1', 'manager:gm1', 'portal-mcp:tok1']) {
      let message = '';
      await h.svc.startRun({ repoId: repo.id, pipeline: 'deploy', ref: 'main' }, actor, { sessionId: actor === 'session:s1' ? 's1' : null, deploymentOnly: 'no' }).then(
        () => assert.fail(`${actor}: started`),
        (e: { code?: string; message?: string }) => {
          assert.equal(e.code, 'FORBIDDEN', actor);
          message = e.message ?? '';
        },
      );
      assert.match(message, /deploys to production, which does not hold for an approval in the portal/, actor);
      assert.match(message, /What to do: a person starts this run in the portal, or a person protects production/, actor);
    }
    const refused = h.store.db!.prepare('SELECT id, actor, status FROM ci_runs WHERE repo_id = ? AND id <> ? ORDER BY number').all(repo.id, held.id) as { id: string; actor: string; status: string }[];
    assert.deepEqual(refused.map((r) => [r.actor, r.status]), [['session:s1', 'failed'], ['manager:gm1', 'failed'], ['portal-mcp:tok1', 'failed']], 'recorded as failed runs');
    for (const r of refused) assert.equal(h.svc.get(r.id).deployments.length, 0, 'no deployment row: nothing was let through');

    // A rerun by an agent is refused the same way.
    assert.equal(await codeOf(() => h.svc.rerun(held.id, 'session:s1')), 'CONFLICT');

    // A person (ui) still releases unattended, and the job is told nobody decided.
    const byPerson = await h.svc.startRun({ repoId: repo.id, pipeline: 'deploy', ref: 'main' });
    assert.equal(byPerson.deployments[0]!.approval, 'auto');
    assert.equal(approvalEnv(byPerson.id), 'auto');
    await h.until('the person\'s run to pass', () => h.svc.get(byPerson.id).status === 'passed');

    // stg is the one environment an agent may deploy to unattended (D-62).
    h.svc.setEnvironment(repo.id, 'stg', { protected: false }, OWNER);
    const stg = await h.svc.startRun({ repoId: repo.id, pipeline: 'stg', ref: 'main' }, 'session:s1', { sessionId: 's1', deploymentOnly: 'no' });
    assert.equal(stg.deployments[0]!.approval, 'auto');
    await h.until('the stg run to pass', () => h.svc.get(stg.id).status === 'passed');
  } finally {
    h.done();
  }
});

test('an agent-shaped start: deploymentOnly refuses a pipeline that deploys nowhere and links the run to the session that asked', async () => {
  const { h, repo } = await setup();
  try {
    assert.equal(await codeOf(() => h.svc.startRun({ repoId: repo.id, pipeline: 'ci', ref: 'main' }, 'session:s1', { sessionId: 's1', deploymentOnly: 'no' })), 'FORBIDDEN');
    const run = await h.svc.startRun({ repoId: repo.id, pipeline: 'deploy', ref: 'main' }, 'session:s1', { sessionId: 's1', deploymentOnly: 'no' });
    assert.deepEqual([run.actor, run.sessionId, run.deployments[0]!.actor], ['session:s1', 's1', 'session:s1']);
    await h.svc.cancel(run.id);
  } finally {
    h.done();
  }
});
