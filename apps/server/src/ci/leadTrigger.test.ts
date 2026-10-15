// T-476: ci_run_trigger for a crew. A lead (no parent, holds a crew) may start any pipeline on a dev/* or ticket/* branch of its program's remote
// (the one whose folder it runs in); another program's remote answers exactly like a missing one; deploy pipelines keep today's rule and wait
// for a person; a worker's folder branch at its start counts as its own. Every start is one audit row: who, which pipeline, which branch, why.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSession } from '@portal/contracts';
import type { ChatController } from '../chat/controller.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { agentStart, isProgramBranch } from './authz.js';
import { registerCiTools } from './portalTools.js';
import { ChatSessionsAdapter, FakeSessions } from './sessions.js';
import { harness, remote, WS } from './testkit.js';

const GATE = 'on: manual\njobs:\n  t:\n    steps: [{ run: echo gate }]\n';
const DEPLOY = 'on: manual\njobs:\n  build:\n    steps: [{ run: echo build }]\n  release:\n    needs: [build]\n    environment: stg\n    steps: [{ run: echo released }]\n';
const FILES = { '.pilot/gate.yml': GATE, '.pilot/deploy.yml': DEPLOY };
const BAD = ['main', 'refs/heads/dev/x', 'heads/dev/x', 'origin/dev/x', 'dev/../main', 'dev/x/../../main', 'Dev/x', 'DEV/x', 'dev/', 'dev', 'dev//x', 'dev/.x', 'dev/x.lock', 'dev/x.', 'devx/y', 'dev-x', 'ticket', 'dev/x y', 'dev/x~1', 'dev/x^', 'dev/@{u}', 'dev/x:y', '-dev/x', 'release/dev/x', `dev/${'x'.repeat(100)}`];

test('branches a lead may test: dev/* and ticket/* exactly, nothing that only looks like one', () => {
  for (const ok of ['dev/x', 'dev/T-271', 'ticket/476-lead-gate', 'dev/t-476/1', 'dev/a.b_c-d']) assert.equal(isProgramBranch(ok), true, ok);
  for (const bad of BAD) assert.equal(isProgramBranch(bad), false, JSON.stringify(bad));
});

test('the rule, decided in authz.ts: own branch, a lead on its program remote, else deployments only (another program: not found)', () => {
  const app = { name: 'app', workspaceId: WS, sourcePath: '/w/app', connected: ['/w/app'] };
  const other = { name: 'other', workspaceId: WS, sourcePath: '/w/other', connected: [] };
  const lead = { id: 'l', title: '', ticketId: null, branch: null, live: true, state: 'idle' as const, workspaceId: WS, lastActivityAt: '', cwd: '/w/app', lead: true };
  assert.deepEqual(agentStart(lead, app, 'dev/x'), { rule: 'program_branch', ref: 'refs/heads/dev/x' });
  assert.equal(agentStart(lead, app, 'main').rule, 'deployment');
  const elsewhere = agentStart(lead, other, 'dev/x');
  assert.equal(elsewhere.rule === 'deployment' && elsewhere.refusal.code, 'NOT_FOUND');
  assert.equal(agentStart({ ...lead, lead: false }, app, 'dev/x').rule, 'deployment', 'no crew: not a lead');
  assert.equal(agentStart({ ...lead, cwd: '/w/app/sub' }, app, 'dev/x').rule, 'deployment', 'the folder must be the remote\'s exactly');
  assert.equal(agentStart({ ...lead, lead: false, branch: 'dev/y' }, app, 'dev/y').rule, 'own_branch');
});

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
  const rows = new Map<string, Partial<ChatSession>>([
    ['w', { id: 'w', workspaceId: WS, cwd: '/w/crew-api', state: 'idle', parentId: 'l', worktree: null, folderBranch: 'dev/y' }],
    ['l', { id: 'l', workspaceId: WS, cwd: '/w/app', state: 'idle', parentId: null, worktree: null }],
    ['solo', { id: 'solo', workspaceId: WS, cwd: '/w/app', state: 'idle', parentId: null, worktree: null }],
  ]);
  const chat = {
    resolve: (id: string) => id,
    get: (id: string) => rows.get(id) ?? null,
    list: (f: { parentId?: string }) => [...rows.values()].filter((s) => !f.parentId || s.parentId === f.parentId),
  } as unknown as ChatController;
  const adapter = new ChatSessionsAdapter(chat);
  assert.deepEqual([adapter.get('w')?.branch, adapter.get('w')?.lead], ['dev/y', false]);
  assert.deepEqual([adapter.get('l')?.branch, adapter.get('l')?.lead, adapter.get('l')?.cwd], [null, true, '/w/app']);
  assert.equal(adapter.get('solo')?.lead, false);

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
    sessions.add({ id: 'w', workspaceId: WS, branch: adapter.get('w')!.branch, cwd: '/w/crew-api', lead: false });
    const w = await mcp.agentToken(WS, 'w');
    const ok = await mcp.call(w.secret, 'ci_run_trigger', { repo: 'app', pipeline: 'gate', ref: 'dev/y' });
    assert.equal(ok.result!.isError, undefined, JSON.stringify(ok.result));
    const no = await mcp.call(w.secret, 'ci_run_trigger', { repo: 'app', pipeline: 'gate', ref: 'dev/z' });
    assert.equal(no.result!.isError, true);
    assert.match(no.result!.content![0]!.text, /only on the branch its own session works on \(dev\/y\)/);
  } finally {
    mcp.done();
    h.done();
  }
});
