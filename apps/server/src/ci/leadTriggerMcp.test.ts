// T-476: ci_run_trigger for a crew, through the tool. A lead (no parent, holds a crew) may start any pipeline on a dev/* or ticket/* branch of
// its program's remote (the one whose folder it runs in); another program's remote answers exactly like a missing one; deploy pipelines keep
// today's rule and wait for a person; a worker's folder branch at its start counts as its own. Every start is one audit row: who, which
// pipeline, which branch, why. Imports only what existed before T-476, so each case fails on the parent for its behaviour.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSession } from '@portal/contracts';
import type { ChatController } from '../chat/controller.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { registerCiTools } from './portalTools.js';
import { ChatSessionsAdapter, FakeSessions } from './sessions.js';
import { harness, remote, WS } from './testkit.js';

const GATE = 'on: manual\njobs:\n  t:\n    steps: [{ run: echo gate }]\n';
const DEPLOY = 'on: manual\njobs:\n  build:\n    steps: [{ run: echo build }]\n  release:\n    needs: [build]\n    environment: stg\n    steps: [{ run: echo released }]\n';
const FILES = { '.pilot/gate.yml': GATE, '.pilot/deploy.yml': DEPLOY };

test('a lead starts gate on dev/x of its remote; another program\'s remote reads as missing; a deploy waits for a person; lookalike branches are refused', async () => {
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
    for (const [src, b] of [[h.src, 'dev/x'], [h.src, 'ticket/9-y'], [otherSrc, 'dev/x']] as const) {
      h.home.git(['checkout', '-q', '-B', b, 'main'], src);
      h.home.git(['push', '-q', 'pilot', b], src);
    }
    h.home.git(['tag', 'dev/t', 'main'], h.src);
    h.home.git(['push', '-q', 'pilot', 'dev/t'], h.src);
    sessions.add({ id: 'lead', workspaceId: WS, branch: null, cwd: h.src, lead: true });
    sessions.add({ id: 'solo', workspaceId: WS, branch: null, cwd: h.src, lead: false });
    const lead = await mcp.agentToken(WS, 'lead');
    const solo = await mcp.agentToken(WS, 'solo');
    const call = (who: { secret: string }, args: Record<string, unknown>) => mcp.call(who.secret, 'ci_run_trigger', args).then((r) => r.result!);

    // Its program's remote, dev/* and ticket/*: any pipeline, on the branch.
    for (const ref of ['dev/x', 'ticket/9-y']) {
      const ok = await call(lead, { repo: 'app', pipeline: 'gate', ref });
      assert.equal(ok.isError, undefined, JSON.stringify(ok));
      assert.equal(ok.structuredContent.run.branch, ref);
      assert.equal(ok.structuredContent.run.actor, 'session:lead');
    }
    const started = audits.filter((a) => a.kind === 'ci.run_started');
    assert.deepEqual(started.map((a) => [a.actor, a.detail?.repo, a.detail?.pipeline, a.detail?.ref, a.detail?.sessionId, a.detail?.rule]), [
      ['session:lead', 'app', 'gate', 'refs/heads/dev/x', 'lead', 'program_branch'],
      ['session:lead', 'app', 'gate', 'refs/heads/ticket/9-y', 'lead', 'program_branch'],
    ]);

    // Another program's remote: the same NOT_FOUND as a remote that does not exist.
    const other = await call(lead, { repo: 'other', pipeline: 'gate', ref: 'dev/x' });
    const none = await call(lead, { repo: 'nosuch', pipeline: 'gate', ref: 'dev/x' });
    assert.equal(other.isError, true);
    assert.deepEqual(JSON.parse(JSON.stringify(other.content).replaceAll('other', 'nosuch')), none.content);
    assert.match(other.content![0]!.text, /NOT_FOUND|There is no remote other/);

    // A session without a crew gets nothing new; a lead gets nothing on a branch that only looks like dev/*, nor on a TAG named dev/t.
    const soloTry = await call(solo, { repo: 'app', pipeline: 'gate', ref: 'dev/x' });
    assert.equal(soloTry.isError, true);
    assert.match(soloTry.content![0]!.text, /deploys to an environment/);
    for (const ref of ['main', 'refs/heads/dev/x', 'dev/../main', 'Dev/x', 'dev//x', 'origin/dev/x']) {
      const r = await call(lead, { repo: 'app', pipeline: 'gate', ref });
      assert.equal(r.isError, true, ref);
    }
    assert.equal((await call(lead, { repo: 'app', pipeline: 'gate', ref: 'dev/t' })).isError, true, 'a tag is not a branch');
    assert.equal(audits.filter((a) => a.kind === 'ci.run_started').length, 2, 'nothing else started');

    // A deploy pipeline keeps today's rule: started, and its deploying job waits for a person (also on another program's remote).
    for (const repo of ['app', 'other']) {
      const d = await call(lead, { repo, pipeline: 'deploy', ref: 'dev/x' });
      assert.equal(d.isError, undefined, JSON.stringify(d));
      assert.match(d.content![0]!.text, /waits for a person's approval/);
      const id = d.structuredContent.run.id as string;
      await h.until('the release to wait', () => h.svc.get(id).deployments.some((x) => x.approval === 'waiting'));
    }
    assert.deepEqual(audits.filter((a) => a.kind === 'ci.run_started').slice(2).map((a) => [a.detail?.repo, a.detail?.pipeline, a.detail?.rule]), [
      ['app', 'deploy', 'program_branch'],
      ['other', 'deploy', 'deployment'],
    ]);
  } finally {
    mcp.done();
    h.done();
  }
});

test('a worker whose folder was on dev/y at its start: gate on dev/y, refused on dev/z (its folder branch is its own)', async () => {
  // The real adapter over the chat: the folder branch is the session's branch for CI, and a session that started workers is a lead.
  const rows = new Map<string, Partial<ChatSession> & Record<string, unknown>>([
    ['w', { id: 'w', workspaceId: WS, cwd: '/w/crew-api', state: 'idle', parentId: 'l', worktree: null, folderBranch: 'dev/y' }],
    ['m', { id: 'm', workspaceId: WS, cwd: '/w/crew-api', state: 'idle', parentId: 'l', worktree: null, folderBranch: 'main' }],
    ['t', { id: 't', workspaceId: WS, cwd: '/w/app', state: 'idle', parentId: null, worktree: { branch: 'dev/wt' } as never,folderBranch: 'main' }],
    ['l', { id: 'l', workspaceId: WS, cwd: '/w/app', state: 'idle', parentId: null, worktree: null }],
    ['solo', { id: 'solo', workspaceId: WS, cwd: '/w/app', state: 'idle', parentId: null, worktree: null }],
  ]);
  const chat = {
    resolve: (id: string) => id,
    get: (id: string) => rows.get(id) ?? null,
    list: (f: { parentId?: string }) => [...rows.values()].filter((s) => !f.parentId || s.parentId === f.parentId),
  } as unknown as ChatController;
  const adapter = new ChatSessionsAdapter(chat);
  const view = (id: string) => adapter.get(id);
  assert.deepEqual([view('w')?.branch, view('w')?.lead], ['dev/y', false]);
  // The adapter marks the trusted case: true for a session with a worktree, not for a worker on its folder's branch (fail closed).
  assert.deepEqual([view('t')?.branch, view('t')?.branchFromWorktree], ['dev/wt', true]);
  assert.deepEqual([view('w')?.branchFromWorktree, view('m')?.branchFromWorktree], [false, false]);
  assert.equal(adapter.list({}).find((s) => s.id === 't')?.branchFromWorktree, true);
  assert.deepEqual([view('l')?.branch, view('l')?.lead, view('l')?.cwd], [null, true, '/w/app']);
  assert.equal(view('solo')?.lead, false);

  const sessions = new FakeSessions();
  const h = await harness({ sessions });
  const mcp = await portalMcpHarness();
  try {
    registerCiTools(h.svc, sessions, mcp.registry);
    await remote(h, FILES);
    for (const b of ['dev/y', 'dev/z']) {
      h.home.git(['checkout', '-q', '-B', b, 'main'], h.src);
      h.home.git(['push', '-q', 'pilot', b], h.src);
    }
    // The fake holds exactly what the real adapter produced, not a hand-built session.
    for (const id of ['w', 'm']) rows.get(id)!.cwd = h.src; // the folder the program's remote was made from
    sessions.add(view('w')!);
    sessions.add(view('m')!);
    const w = await mcp.agentToken(WS, 'w');
    const m = await mcp.agentToken(WS, 'm');
    const ok = await mcp.call(w.secret, 'ci_run_trigger', { repo: 'app', pipeline: 'gate', ref: 'dev/y' });
    assert.equal(ok.result!.isError, undefined, JSON.stringify(ok.result));
    const no = await mcp.call(w.secret, 'ci_run_trigger', { repo: 'app', pipeline: 'gate', ref: 'dev/z' });
    assert.equal(no.result!.isError, true);
    assert.match(no.result!.content![0]!.text, /only on the branch its own session works on \(dev\/y\)/);
    // A worker whose folder is on main: no gate run on main (the fail-closed rule, through the tool).
    const onMain = await mcp.call(m.secret, 'ci_run_trigger', { repo: 'app', pipeline: 'gate', ref: 'main' });
    assert.equal(onMain.result!.isError, true, JSON.stringify(onMain.result));
    assert.match(onMain.result!.content![0]!.text, /deploys to an environment/);
  } finally {
    mcp.done();
    h.done();
  }
});

test('reading runs: a lead reads every run on its program remote (get and list), another remote reads as a missing run; a folder branch on main reads nothing elsewhere', async () => {
  const sessions = new FakeSessions();
  const h = await harness({ sessions });
  const mcp = await portalMcpHarness();
  try {
    registerCiTools(h.svc, sessions, mcp.registry);
    await remote(h, FILES);
    const otherSrc = h.home.repo('other');
    h.home.commit(otherSrc, FILES, 'add pipelines');
    await h.svc.createRepo({ workspaceId: WS, name: 'other', source: otherSrc, connect: true });
    h.home.git(['push', '-q', 'pilot', 'main'], otherSrc);
    const repos = await h.svc.repos(WS);
    const app = repos.find((r) => r.name === 'app')!;
    const other = repos.find((r) => r.name === 'other')!;
    // Runs another session started, on the lead's remote and on another program's remote (both on main).
    const onApp = await h.svc.startRun({ repoId: app.id, pipeline: 'gate', ref: 'main' }, 'session:crew', { sessionId: 'crew' });
    const onOther = await h.svc.startRun({ repoId: other.id, pipeline: 'gate', ref: 'main' }, 'session:crew', { sessionId: 'crew' });
    sessions.add({ id: 'lead', workspaceId: WS, branch: null, cwd: h.src, lead: true });
    // A worker whose folder branch is main: its own branch only by the folder rule, which refuses main.
    sessions.add({ id: 'w', workspaceId: WS, branch: 'main', cwd: h.src, lead: false });
    const lead = await mcp.agentToken(WS, 'lead');
    const w = await mcp.agentToken(WS, 'w');
    const call = (who: { secret: string }, tool: string, args: Record<string, unknown>) => mcp.call(who.secret, tool, args).then((r) => r.result!);

    // The lead reads the run on its program remote, whoever started it: get and list.
    const got = await call(lead, 'ci_run_get', { id: onApp.id });
    assert.equal(got.isError, undefined, JSON.stringify(got));
    assert.equal(got.structuredContent.run.id, onApp.id);
    const listed = await call(lead, 'ci_runs_list', {});
    assert.deepEqual(listed.structuredContent.runs.map((r: { id: string }) => r.id), [onApp.id]);

    // Read only: no cancel for a run it did not start.
    const cancel = await call(lead, 'ci_run_cancel', { id: onApp.id });
    assert.equal(cancel.isError, true);
    assert.match(cancel.content![0]!.text, /No such run/);

    // Another program's remote: the same NOT_FOUND as a run that does not exist.
    const far = await call(lead, 'ci_run_get', { id: onOther.id });
    const none = await call(lead, 'ci_run_get', { id: 'nosuchrun' });
    assert.equal(far.isError, true);
    assert.deepEqual(far.content, none.content);
    assert.match(far.content![0]!.text, /No such run/);

    // The worker on main reads neither main run (not dev/* or ticket/*, and the other one is not its folder's remote).
    for (const id of [onApp.id, onOther.id]) {
      const r = await call(w, 'ci_run_get', { id });
      assert.equal(r.isError, true, id);
      assert.match(r.content![0]!.text, /No such run/);
    }
    assert.deepEqual((await call(w, 'ci_runs_list', {})).structuredContent.runs, []);
  } finally {
    mcp.done();
    h.done();
  }
});
