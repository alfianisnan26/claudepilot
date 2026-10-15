// T-558 (D-62): a lead starts its program's stg deploy itself. On the branch `stg` of its program's remote a lead may start a pipeline only when
// every job that names an environment names exactly `stg` (the file at that commit decides, never an input); anything else there answers like a
// missing remote. The run and its audit row name the lead's session; approval is untouched (a protected stg still waits for a person).
// ci_runs_list gives the lead the minutes since its program's last stg deploy that passed, or "unavailable".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CiDecider } from '@portal/contracts';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { agentStart, deploysOnlyToStg } from './authz.js';
import { registerCiTools } from './portalTools.js';
import { FakeSessions } from './sessions.js';
import { harness, remote, WS } from './testkit.js';

const OWNER: CiDecider = { actor: 'user:u_owner', userId: 'u_owner' };
const deployTo = (env: string, inputs = '') => `on:\n  manual:${inputs || ' {}'}\njobs:\n  build:\n    steps: [{ run: echo build }]\n  release:\n    needs: [build]\n    environment: ${env}\n    steps: [{ run: echo released }]\n`;
const TARGET = '\n    inputs:\n      target: { type: choice, options: [stg, production], default: stg }';
const FILES = {
  '.pilot/stg-deploy.yml': deployTo('stg', TARGET),
  '.pilot/prod-deploy.yml': deployTo('production'),
  '.pilot/uat-deploy.yml': deployTo('uat'),
  '.pilot/staging-deploy.yml': deployTo('staging'),
  '.pilot/mixed.yml': 'on: manual\njobs:\n  a:\n    environment: stg\n    steps: [{ run: echo a }]\n  b:\n    environment: production\n    steps: [{ run: echo b }]\n',
  '.pilot/gate.yml': 'on: manual\njobs:\n  t:\n    steps: [{ run: echo gate }]\n',
  // An environment from an input is not a pipeline the portal runs (environment names are literal): the file is invalid.
  '.pilot/from-input.yml': deployTo('${{ inputs.target }}', TARGET),
};

test('the rule: a lead on stg of its program remote is program_stg; any other ref or remote is not; the file test', () => {
  const app = { name: 'app', workspaceId: WS, sourcePath: '/w/app', connected: [] as string[] };
  const other = { ...app, name: 'other', sourcePath: '/w/other' };
  const lead = { id: 'l', title: '', ticketId: null, branch: null, cwd: '/w/app', lead: true, live: true, state: 'idle' as const, workspaceId: WS, lastActivityAt: '' };
  const stg = agentStart(lead, app, 'stg');
  assert.equal(stg.rule, 'program_stg');
  assert.equal(stg.ref, 'refs/heads/stg', 'the branch, never a tag of the same name');
  assert.equal(stg.rule === 'program_stg' && stg.refusal.code, 'NOT_FOUND');
  for (const ref of ['refs/heads/stg', 'Stg', 'stg/x', 'origin/stg', 'uat', 'production', 'main', 'stg ']) assert.notEqual(agentStart(lead, app, ref).rule, 'program_stg', ref);
  const far = agentStart(lead, other, 'stg');
  assert.equal(far.rule === 'deployment' && far.refusal.code, 'NOT_FOUND', 'another program: T-476 rule, never program_stg');
  assert.equal(agentStart({ ...lead, lead: false }, app, 'stg').rule, 'deployment', 'no crew: not a lead');

  const job = (environment: string | null, hidden = false) => ({ environment, hidden });
  assert.deepEqual(
    [[job('stg')], [job(null), job('stg')], [job('production')], [job('uat')], [job('stg'), job('production')], [job(null)], [], [job('staging')], [job('stg'), job('production', true)]].map(deploysOnlyToStg),
    [true, true, false, false, false, false, false, false, true],
  );
});

test('through the tool: the lead starts stg-deploy on stg (recorded, still held for a person); every other case on stg reads as a missing remote', async () => {
  const sessions = new FakeSessions();
  const audits: { kind: string; actor: string; detail?: Record<string, unknown> }[] = [];
  const h = await harness({ sessions, audit: (e) => void audits.push(e) });
  const mcp = await portalMcpHarness();
  try {
    registerCiTools(h.svc, sessions, mcp.registry);
    await remote(h, FILES);
    const otherSrc = h.home.repo('other');
    h.home.commit(otherSrc, FILES, 'add pipelines');
    await h.svc.createRepo({ workspaceId: WS, name: 'other', source: otherSrc, connect: true });
    h.home.git(['push', '-q', 'pilot', 'main'], otherSrc);
    for (const src of [h.src, otherSrc]) {
      h.home.git(['checkout', '-q', '-B', 'stg', 'main'], src);
      h.home.git(['push', '-q', 'pilot', 'stg'], src);
    }
    sessions.add({ id: 'lead', workspaceId: WS, branch: null, cwd: h.src, lead: true });
    const lead = await mcp.agentToken(WS, 'lead');
    const call = (tool: string, args: Record<string, unknown>) => mcp.call(lead.secret, tool, args).then((r) => r.result!);
    const started = () => audits.filter((a) => a.kind === 'ci.run_started');

    // Allowed: stg-deploy on stg. An input that names production changes nothing: the file's environment decides.
    const ok = await call('ci_run_trigger', { repo: 'app', pipeline: 'stg-deploy', ref: 'stg', inputs: { target: 'production' } });
    assert.equal(ok.isError, undefined, JSON.stringify(ok));
    const run = ok.structuredContent.run;
    assert.deepEqual([run.branch, run.actor, run.session_id], ['stg', 'session:lead', 'lead']);
    assert.match(ok.content![0]!.text, /Deploying to stg waits for a person's approval/, 'approval untouched: a new stg is protected');
    await h.until('the stg release to wait', () => h.svc.get(run.id).deployments.some((d) => d.environment === 'stg' && d.approval === 'waiting'));
    assert.deepEqual(started().map((a) => [a.actor, a.detail?.repo, a.detail?.pipeline, a.detail?.ref, a.detail?.sessionId, a.detail?.rule]), [
      ['session:lead', 'app', 'stg-deploy', 'refs/heads/stg', 'lead', 'program_stg'],
    ]);
    assert.doesNotMatch(JSON.stringify(started()), /secret|token|key/i, 'names and ids only');

    // Refused on stg, each the same answer as a remote that does not exist: production, uat, an unknown name, stg mixed with production,
    // no environment at all, an environment taken from an input.
    const none = await call('ci_run_trigger', { repo: 'nosuch', pipeline: 'stg-deploy', ref: 'stg' });
    assert.equal(none.isError, true);
    for (const pipeline of ['prod-deploy', 'uat-deploy', 'staging-deploy', 'mixed', 'gate', 'from-input']) {
      const r = await call('ci_run_trigger', { repo: 'app', pipeline, ref: 'stg' });
      assert.equal(r.isError, true, pipeline);
      assert.equal(JSON.stringify(r.content).replace('remote app in', 'remote nosuch in'), JSON.stringify(none.content), pipeline);
    }
    assert.equal(started().length, 1, 'nothing else started');

    // Not program_stg: another program's remote, and any other spelling of the ref. Those keep today's rules (T-476): a deploy pipeline starts
    // as `deployment` and its job waits for a person; the lead's own /deploy of production from another branch is unchanged.
    for (const [repo, pipeline, ref] of [['other', 'stg-deploy', 'stg'], ['app', 'prod-deploy', 'refs/heads/stg'], ['app', 'prod-deploy', 'main']] as const) {
      const r = await call('ci_run_trigger', { repo, pipeline, ref });
      assert.equal(r.isError, undefined, JSON.stringify(r));
      assert.match(r.content![0]!.text, /waits for a person's approval/);
    }
    assert.deepEqual(started().slice(1).map((a) => [a.detail?.repo, a.detail?.ref, a.detail?.rule]), [
      ['other', 'refs/heads/stg', 'deployment'],
      ['app', 'refs/heads/stg', 'deployment'],
      ['app', 'refs/heads/main', 'deployment'],
    ]);
    for (const ref of ['Stg', 'stg/x', 'origin/stg']) assert.equal((await call('ci_run_trigger', { repo: 'app', pipeline: 'gate', ref })).isError, true, ref);

    // Cancel: the lead cancels the run its own session started (today's rule: its own runs).
    const cancelled = await call('ci_run_cancel', { id: run.id });
    assert.equal(cancelled.isError, undefined, JSON.stringify(cancelled));
    await h.until('cancelled', () => h.svc.get(run.id).status === 'cancelled');
  } finally {
    mcp.done();
    h.done();
  }
});

test('stg age: "unavailable" before any stg deploy passed, then whole minutes since the run ended, on a fake clock', async () => {
  const sessions = new FakeSessions();
  let clock = new Date();
  const h = await harness({ sessions, now: () => clock });
  const mcp = await portalMcpHarness();
  try {
    registerCiTools(h.svc, sessions, mcp.registry);
    const repo = await remote(h, FILES);
    h.home.git(['checkout', '-q', '-B', 'stg', 'main'], h.src);
    h.home.git(['push', '-q', 'pilot', 'stg'], h.src);
    sessions.add({ id: 'lead', workspaceId: WS, branch: null, cwd: h.src, lead: true });
    sessions.add({ id: 'solo', workspaceId: WS, branch: null, cwd: h.src, lead: false });
    const lead = await mcp.agentToken(WS, 'lead');
    const solo = await mcp.agentToken(WS, 'solo');
    const age = async (who: { secret: string }) => (await mcp.call(who.secret, 'ci_runs_list', {})).result!.structuredContent.stg_age_minutes;

    assert.deepEqual(await age(lead), [{ repo: 'app', minutes: 'unavailable' }]);
    assert.equal(await age(solo), undefined, 'not a lead: no program remotes, no stg age');

    // A production deploy that passed is not a stg deploy.
    h.svc.setEnvironment(repo.id, 'production', { protected: false }, OWNER);
    const prod = await h.svc.startRun({ repoId: repo.id, pipeline: 'prod-deploy', ref: 'main' }, 'ui');
    await h.until('the production run to pass', () => h.svc.get(prod.id).status === 'passed');
    assert.deepEqual(await age(lead), [{ repo: 'app', minutes: 'unavailable' }]);

    // A person turned stg's protection off (the lead can not): the lead's stg-deploy runs through and passes.
    h.svc.setEnvironment(repo.id, 'stg', { protected: false }, OWNER);
    const r = await mcp.call(lead.secret, 'ci_run_trigger', { repo: 'app', pipeline: 'stg-deploy', ref: 'stg' });
    assert.equal(r.result!.isError, undefined, JSON.stringify(r.result));
    const id = r.result!.structuredContent.run.id as string;
    await h.until('the stg run to pass', () => h.svc.get(id).status === 'passed');
    const finished = Date.parse(h.svc.get(id).finishedAt!);
    clock = new Date(finished + 37 * 60_000 + 30_000);
    assert.deepEqual(await age(lead), [{ repo: 'app', minutes: 37 }]);
    clock = new Date(finished - 5_000);
    assert.deepEqual(await age(lead), [{ repo: 'app', minutes: 0 }], 'a clock behind the run never goes negative');
  } finally {
    mcp.done();
    h.done();
  }
});
