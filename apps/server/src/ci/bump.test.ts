// Bump on a CI run (local-git-ci PRD FR37a, T-32 item 3): the sessions offered (its own first, a moved chat as it is now, then the
// workspace's, then the ticket's), the two modes, the refusals, the record on the run and the ticket, the limits, the audit, and the
// Portal MCP tool with its confirmation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { BUMPS_PER_HOUR_RUN } from './links.js';
import { registerCiTools } from './portalTools.js';
import { FakeSessions } from './sessions.js';
import { FakeTickets } from './tickets.js';
import { codeOf, harness, remote, WS, type H } from './testkit.js';

const FAILING = 'on:\n  push: {}\n  manual: {}\njobs:\n  test:\n    steps:\n      - name: Unit tests\n        run: |\n          echo "FAIL src/a.test.js"\n          exit 3\n';
const UI = { actor: 'ui', label: null, userId: 'u_owner' };

/** A failing run on `ticket/12-login`, linked to session s1 and ticket T-12, its failure already reported to s1. */
async function failedRun(h: H, sessions: FakeSessions) {
  await remote(h, { '.pilot/ci.yml': FAILING });
  h.home.git(['checkout', '-q', '-B', 'ticket/12-login', 'main'], h.src);
  h.home.commit(h.src, { 'a.txt': 'a' }, 'a change');
  h.home.git(['push', '-q', 'pilot', 'ticket/12-login'], h.src);
  await h.until('the report', () => sessions.sent.length === 1);
  return h.svc.list({ branch: 'ticket/12-login' }).items[0]!;
}

test('the picker and the two modes: Fix goes in as next with the report, Ask as later; recorded on the run, the ticket and the audit', async () => {
  const sessions = new FakeSessions();
  const tickets = new FakeTickets('T-12');
  const audits: { kind: string; actor: string; detail?: Record<string, unknown> }[] = [];
  const h = await harness({ tickets, sessions, audit: (e) => void audits.push(e) });
  try {
    sessions.add({ id: 's1', workspaceId: WS, branch: 'ticket/12-login', ticketId: 'T-12', title: 'Login fixer' });
    sessions.add({ id: 's2', workspaceId: WS, branch: null, title: 'Helper' });
    sessions.add({ id: 's3', workspaceId: WS, branch: null, state: 'waiting' });
    sessions.add({ id: 's4', workspaceId: WS, branch: null, live: false });
    sessions.add({ id: 's5', workspaceId: 'docker/other', branch: null, ticketId: 'T-12', title: 'Elsewhere on the ticket' });
    sessions.add({ id: 's6', workspaceId: 'docker/other', branch: null });
    const run = await failedRun(h, sessions);

    assert.deepEqual(
      h.svc.bumpTargets(run.id).map((t) => [t.id, t.preferred, t.refusal]),
      [
        ['s1', true, null],
        ['s2', false, null],
        ['s3', false, 'waiting'],
        ['s5', false, null],
      ],
      'its session, the workspace’s live ones, then the ticket’s; ended and unrelated ones left out',
    );

    const after = await h.svc.bump(run.id, { sessionId: 's2', mode: 'prioritise', note: 'Before the release' }, UI);
    const fix = sessions.sent[1]!;
    assert.deepEqual([fix.sessionId, fix.runId, fix.priority, fix.label], ['s2', run.id, 'next', '#1'], 'from the run, labelled #1 ("From CI #1"), as next');
    assert.match(fix.text, /^A person in the portal bumped CI run #1 to you: make it your next work\./);
    assert.match(fix.text, /Pipeline: ci · Status: failed/);
    assert.match(fix.text, /Ticket: T-12/);
    assert.match(fix.text, /“Before the release”/);
    assert.match(fix.text, /-----\nCI: the pipeline "ci" failed on ticket\/12-login/);
    assert.match(fix.text, /^\| FAIL src\/a\.test\.js$/m);
    assert.match(fix.text, /Act on it now/);
    assert.deepEqual(after.bumps.map((b) => [b.sessionId, b.mode, b.outcome, b.note]), [['s2', 'prioritise', 'sent', 'Before the release']]);
    assert.deepEqual(after.reports.map((r) => [r.state, r.outcome]), [['failed', 'sent']], 'a bump is not a report');
    assert.equal(tickets.notes.length, 1);
    assert.equal(tickets.notes[0]!.actor, `ci:${run.id}`);
    assert.match(tickets.notes[0]!.text, /^Admin bumped CI #1 \(ci, failed\) into “Helper” \(Fix\): Before the release$/);
    assert.deepEqual(audits.map((a) => [a.kind, a.actor, a.detail?.sessionId, a.detail?.mode]), [['ci.run_bumped', 'ui', 's2', 'prioritise']]);

    await h.svc.bump(run.id, { sessionId: 's5', mode: 'ask' }, UI);
    const ask = sessions.sent[2]!;
    assert.deepEqual([ask.sessionId, ask.priority], ['s5', 'later'], 'the ticket’s session in another workspace may be asked');
    assert.match(ask.text, /^A person in the portal has a question about CI run #1 for you\./);
    assert.match(ask.text, /Answer in your reply here/);
    // The bumps never count against the report caps.
    assert.equal((h.store.db!.prepare("SELECT count(*) AS n FROM ci_messages WHERE outcome = 'sent'").get() as { n: number }).n, 1);
  } finally {
    h.done();
  }
});

test('refusals, a session that would not take it, a moved chat, and the limit', async () => {
  const sessions = new FakeSessions();
  const h = await harness({ tickets: new FakeTickets('T-12'), sessions });
  try {
    sessions.add({ id: 's1', workspaceId: WS, branch: 'ticket/12-login', ticketId: 'T-12' });
    sessions.add({ id: 's3', workspaceId: WS, branch: null, state: 'waiting' });
    sessions.add({ id: 's4', workspaceId: WS, branch: null, live: false });
    sessions.add({ id: 's6', workspaceId: 'docker/other', branch: null });
    const run = await failedRun(h, sessions);
    const bump = (req: object) => codeOf(() => h.svc.bump(run.id, req, UI));

    assert.equal(await bump({ sessionId: 's3', mode: 'ask' }), 'CONFLICT', 'waiting on an approval');
    assert.equal(await bump({ sessionId: 's4', mode: 'ask' }), 'CONFLICT', 'ended');
    assert.equal(await bump({ sessionId: 's6', mode: 'ask' }), 'CONFLICT', 'another workspace, not the ticket’s');
    assert.equal(await bump({ sessionId: 'nope', mode: 'ask' }), 'VALIDATION_FAILED');
    assert.equal(await bump({ mode: 'ask' }), 'VALIDATION_FAILED');
    assert.equal(await bump({ sessionId: 's1', mode: 'now' }), 'VALIDATION_FAILED');
    assert.equal(await bump({ sessionId: 's1', mode: 'ask', note: `key ${'sk-ant-api03-' + 'k'.repeat(24)}` }), 'VALIDATION_FAILED');
    assert.equal(await codeOf(() => h.svc.bump('rnosuchrun0001', { sessionId: 's1', mode: 'ask' }, UI)), 'NOT_FOUND');
    assert.equal(sessions.sent.length, 1, 'nothing sent');
    assert.deepEqual(h.svc.get(run.id).bumps, []);

    // The session said no: recorded as not taken, and the caller is told.
    sessions.failSend = new Error('This session is switching Claudes.');
    assert.equal(await bump({ sessionId: 's1', mode: 'ask' }), 'SERVICE_UNAVAILABLE');
    sessions.failSend = null;
    assert.deepEqual(h.svc.get(run.id).bumps.map((b) => [b.outcome, b.note]), [['refused', 'This session is switching Claudes.']]);

    // The chat moved to another Claude: offered and reached under the id it goes by now.
    sessions.add({ id: 's1-now', workspaceId: WS, branch: 'ticket/12-login', ticketId: 'T-12' });
    sessions.moved.set('s1', 's1-now');
    sessions.sessions.delete('s1');
    assert.equal(h.svc.bumpTargets(run.id)[0]!.id, 's1-now');
    assert.equal(h.svc.bumpTargets(run.id)[0]!.preferred, true);
    await h.svc.bump(run.id, { sessionId: 's1', mode: 'prioritise' }, UI);
    assert.equal(sessions.sent.at(-1)!.sessionId, 's1-now');

    // Ten bumps of a run an hour (the refused one counts too).
    for (let i = 2; i < BUMPS_PER_HOUR_RUN; i++) await h.svc.bump(run.id, { sessionId: 's1-now', mode: 'ask' }, UI);
    assert.equal(await bump({ sessionId: 's1-now', mode: 'ask' }), 'RATE_LIMITED');
  } finally {
    h.done();
  }
});

test('ci_run_bump: listed with session control, lists the sessions, previews and asks for confirmation, then bumps as the token', async () => {
  const sessions = new FakeSessions();
  const h = await harness({ tickets: new FakeTickets('T-12'), sessions });
  const mcp = await portalMcpHarness();
  try {
    registerCiTools(h.svc, sessions, mcp.registry);
    sessions.add({ id: 's1', workspaceId: WS, branch: 'ticket/12-login', ticketId: 'T-12', title: 'Login fixer' });
    sessions.add({ id: 's3', workspaceId: WS, branch: null, state: 'waiting' });
    const run = await failedRun(h, sessions);
    const op = mcp.token('operate', 'deploy-bot');
    const read = mcp.token('read');
    const listed = async (secret: string) => ((await mcp.rpc(secret, 'tools/list')).body.result.tools as { name: string }[]).some((t) => t.name === 'ci_run_bump');
    assert.equal(await listed(op.secret), false, 'only while session control is on');
    mcp.module.settings.update({ sessionControl: true });
    assert.equal(await listed(op.secret), true);
    const code = (r: Awaited<ReturnType<typeof mcp.call>>) => r.result?.structuredContent?.error?.code as string | undefined;
    assert.equal(code(await mcp.call(read.secret, 'ci_run_bump', { id: run.id, session_id: 's1' })), 'SCOPE_REQUIRED');

    const offered = (await mcp.call(op.secret, 'ci_run_bump', { id: run.id })).result!.structuredContent;
    assert.deepEqual(offered.sessions.map((s: { id: string; started_it: boolean; can_bump: boolean }) => [s.id, s.started_it, s.can_bump]), [['s1', true, true], ['s3', false, false]]);

    const ask = (await mcp.call(op.secret, 'ci_run_bump', { id: run.id, session_id: 's1', mode: 'fix', note: 'look now' })).result!.structuredContent;
    assert.equal(ask.status, 'confirmation_required');
    assert.deepEqual([ask.preview.run, ask.preview.mode, ask.preview.priority, ask.preview.note], ['#1 ci (failed)', 'Fix', 'next', 'look now']);
    assert.equal(sessions.sent.length, 1, 'asking sends nothing');
    const done = await mcp.call(op.secret, 'ci_run_bump', { id: run.id, session_id: 's1', mode: 'fix', note: 'look now', confirm_token: ask.confirm_token });
    assert.equal(done.result!.isError, undefined, JSON.stringify(done.result));
    assert.equal(sessions.sent.length, 2);
    assert.match(sessions.sent[1]!.text, /^The MCP client “deploy-bot” bumped CI run #1 to you/);
    assert.equal(sessions.sent[1]!.priority, 'next');

    const w = (await mcp.call(op.secret, 'ci_run_bump', { id: run.id, session_id: 's3', mode: 'ask' })).result!.structuredContent;
    assert.equal(code(await mcp.call(op.secret, 'ci_run_bump', { id: run.id, session_id: 's3', mode: 'ask', confirm_token: w.confirm_token })), 'CONFLICT');
    assert.ok(mcp.module.audit.list({ limit: 50 }).filter((x) => x.tool === 'ci_run_bump').every((x) => !!x.actor?.startsWith('portal-mcp:')));
    // Agents never get it.
    const agent = await mcp.agentToken(WS, 's1');
    assert.equal(await listed(agent.secret), false);
  } finally {
    mcp.done();
    h.done();
  }
});
