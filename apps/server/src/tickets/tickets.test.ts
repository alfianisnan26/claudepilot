import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import { parseTicketBranch, parseTicketTrailers } from '@portal/contracts';
import { MIGRATIONS } from '../store/migrations.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { CREATE_PER_HOUR } from './service.js';
import { agent, FakeSessions, token, ticketsHarness, UI } from './testkit.js';

const KEY = 'sk-ant-api03-' + 'k'.repeat(24);
const TAGS = String.fromCodePoint(0xe0049, 0xe0067, 0xe006e);

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : `other:${(e as Error).message}`;
  }
  return 'none';
};
const codeAsync = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    return e instanceof AppError ? e.code : `other:${(e as Error).message}`;
  }
  return 'none';
};
const kinds = (h: Awaited<ReturnType<typeof ticketsHarness>>, id: string) => h.tickets.get(UI, id).events.map((e) => e.kind);

test('a ticket has defaults, a counting id, and a created entry on its timeline', async () => {
  const h = await ticketsHarness();
  try {
    const a = h.tickets.create(UI, { summary: 'Fix the login redirect' });
    const b = h.tickets.create(UI, { summary: 'Second', type: 'bug', priority: 'high', tags: ['Frontend', 'login', 'frontend'], description: '## Steps\n1. open it' });
    assert.equal(a.id, 'T-1');
    assert.equal(b.id, 'T-2');
    assert.deepEqual([a.type, a.priority, a.status, a.source, a.assignee, a.workspaceId], ['task', 'normal', 'open', 'human', null, null]);
    assert.deepEqual(b.tags, ['frontend', 'login'], 'lowercased, de-duplicated, sorted');
    assert.deepEqual(a.reporter, { kind: 'ui', ref: null, label: 'Admin', workspaceId: null });
    const detail = h.tickets.get(UI, 'T-2');
    assert.deepEqual(detail.events.map((e) => [e.kind, e.actor]), [['created', 'ui']]);
    assert.equal(h.tickets.exists('T-2'), true);
    assert.equal(h.tickets.exists('t-3'), false);
    assert.ok(h.changes() >= 2, 'the live page is told');
  } finally {
    h.done();
  }
});

test('input is validated: caps, tags, hidden characters stripped, credentials refused and never stored', async () => {
  const h = await ticketsHarness();
  try {
    assert.equal(code(() => h.tickets.create(UI, { summary: '' })), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.create(UI, { summary: 'x'.repeat(141) })), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.create(UI, { summary: 'ok', type: 'epic' as never })), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.create(UI, { summary: 'ok', tags: ['Front End'] })), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.create(UI, { summary: 'ok', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.create(UI, { summary: 'ok', description: 'x'.repeat(20_001) })), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.create(UI, { summary: `use ${KEY}` })), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.create(UI, { summary: 'ok', description: `the key is ${KEY}` })), 'VALIDATION_FAILED');
    const t = h.tickets.create(UI, { summary: `Deploy\x1b[31m fix${TAGS}\n\u{202e}now`, description: `line\u{200b}one\x1b]0;x\x07\n\nline two` });
    assert.equal(t.summary, 'Deploy fix now', 'one line, no escapes, no hidden characters');
    assert.equal(t.description, 'lineone\n\nline two');
    assert.equal(code(() => h.tickets.comment(UI, t.id, `token ${KEY}`)), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.close(UI, t.id, { summary: `done with ${KEY}` })), 'VALIDATION_FAILED');
    const dump = JSON.stringify([h.store.db!.prepare('SELECT * FROM tickets').all(), h.store.db!.prepare('SELECT * FROM ticket_events').all()]);
    assert.ok(!dump.includes('k'.repeat(24)), 'no credential reached the database');
    assert.equal((h.store.db!.prepare('SELECT count(*) AS n FROM tickets').get() as { n: number }).n, 1, 'refused tickets were not stored');
  } finally {
    h.done();
  }
});

test('every change is a timeline entry, a no-op is none, and closing and reopening move the dates', async () => {
  let now = Date.parse('2026-03-01T10:00:00Z');
  const h = await ticketsHarness({ now: () => new Date(now) });
  try {
    const t = h.tickets.create(UI, { summary: 'One', tags: ['a'] });
    now += 1000;
    h.tickets.update(UI, t.id, { summary: 'Two', description: 'new text', type: 'bug', priority: 'urgent', tags: ['b', 'c'], status: 'blocked' });
    assert.deepEqual(kinds(h, t.id), ['created', 'summary', 'description', 'type', 'priority', 'tags', 'status']);
    const before = h.tickets.get(UI, t.id).events.length;
    h.tickets.update(UI, t.id, { summary: 'Two', priority: 'urgent', tags: ['c', 'b'] });
    assert.equal(h.tickets.get(UI, t.id).events.length, before, 'nothing changed, nothing recorded');
    now += 1000;
    const closed = h.tickets.update(UI, t.id, { status: 'done' });
    assert.equal(closed.closedAt, new Date(now).toISOString());
    assert.equal(h.tickets.get(UI, t.id).events.at(-1)!.kind, 'closed');
    const reopened = h.tickets.update(UI, t.id, { status: 'open' });
    assert.equal(reopened.closedAt, null);
    assert.equal(h.tickets.get(UI, t.id).events.at(-1)!.kind, 'reopened');
    const e = h.tickets.get(UI, t.id).events.find((x) => x.kind === 'priority')!;
    assert.deepEqual(e.data, { from: 'normal', to: 'urgent' });
    assert.equal(h.tickets.get(UI, t.id).ticket.priority, 'urgent');
  } finally {
    h.done();
  }
});

test('assigning: a person, a session (which sets the workspace), and back to the queue', async () => {
  const h = await ticketsHarness();
  try {
    const s = h.sessions.add({ workspaceId: 'docker/api' });
    const t = h.tickets.create(UI, { summary: 'Work', assignee: { kind: 'user', name: '' } });
    assert.deepEqual(t.assignee, { kind: 'user', name: 'admin' }, 'a person by default is "admin"');
    const toSession = h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: s.id }, status: 'in_progress' });
    assert.equal(toSession.workspaceId, 'docker/api', 'a session assignee puts the ticket in its workspace');
    assert.equal(toSession.assigneeSession?.id, s.id);
    const back = h.tickets.update(UI, t.id, { assignee: null });
    assert.equal(back.assignee, null);
    assert.equal(back.status, 'open', 'unassigning an in-progress ticket returns it to the queue');
    assert.equal(code(() => h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: 'nope' } })), 'VALIDATION_FAILED');
    h.sessions.setState(s.id, 'ended');
    assert.equal(code(() => h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: s.id } })), 'VALIDATION_FAILED', 'an ended session can’t take work');
    assert.deepEqual(kinds(h, t.id).filter((k) => k === 'assigned' || k === 'workspace' || k === 'status'), ['assigned', 'assigned', 'workspace', 'status', 'assigned', 'status']);
  } finally {
    h.done();
  }
});

test('list and filters: status, priority, type, tag, assignee, workspace, text (with % and _ literal), closed on request', async () => {
  const h = await ticketsHarness();
  try {
    const s = h.sessions.add({ workspaceId: 'docker/api' });
    h.tickets.create(UI, { summary: 'low chore', priority: 'low', type: 'chore', tags: ['ops'] });
    h.tickets.create(UI, { summary: 'urgent bug 100% fails', priority: 'urgent', type: 'bug', tags: ['frontend', 'login'], description: 'the login_form breaks' });
    h.tickets.create(UI, { summary: 'for me', priority: 'high', assignee: { kind: 'user', name: 'Alfian' } });
    h.tickets.create(UI, { summary: 'for the agent', assignee: { kind: 'session', sessionId: s.id } });
    const done = h.tickets.create(UI, { summary: 'finished' });
    h.tickets.close(UI, done.id, { summary: 'done' });

    const ids = (f: Parameters<typeof h.tickets.list>[1]) => h.tickets.list(UI, f).items.map((t) => t.id);
    assert.deepEqual(ids({}), ['T-2', 'T-3', 'T-4', 'T-1'], 'most urgent first; closed left out');
    assert.deepEqual(ids({ includeClosed: true }).length, 5);
    assert.deepEqual(ids({ sort: 'newest' }), ['T-4', 'T-3', 'T-2', 'T-1'], 'the latest made first (the Home page); closed left out');
    assert.deepEqual(ids({ status: ['done'] }), ['T-5']);
    assert.deepEqual(ids({ priority: ['low', 'urgent'] }), ['T-2', 'T-1']);
    assert.deepEqual(ids({ type: ['bug'] }), ['T-2']);
    assert.deepEqual(ids({ tag: 'LOGIN' }), ['T-2']);
    assert.deepEqual(ids({ assignee: 'unassigned' }), ['T-2', 'T-1']);
    assert.deepEqual(ids({ assignee: 'user' }), ['T-3']);
    assert.deepEqual(ids({ assignee: `session:${s.id}` }), ['T-4']);
    assert.deepEqual(ids({ workspaceId: 'docker/api' }), ['T-4']);
    assert.deepEqual(ids({ query: '100%' }), ['T-2'], '% is literal');
    assert.deepEqual(ids({ query: 'login_form' }), ['T-2'], '_ is literal');
    assert.deepEqual(ids({ query: 'ops' }), ['T-1'], 'tags are searched');
    assert.deepEqual(ids({ query: '%' }), ['T-2'], 'a lone % matches only text that has one');
    const list = h.tickets.list(UI, { limit: 2 });
    assert.equal(list.items.length, 2);
    assert.equal(list.total, 4);
    assert.deepEqual(list.counts, { byStatus: { open: 4, in_progress: 0, blocked: 0, in_review: 0, done: 1, wont_do: 0 }, needsYou: 1, unassigned: 2, orphans: 0, total: 5 });
    assert.deepEqual(h.tickets.tags(UI), [{ tag: 'frontend', count: 1 }, { tag: 'login', count: 1 }, { tag: 'ops', count: 1 }]);
  } finally {
    h.done();
  }
});

test('an agent sees its workspace and the shared queue, nothing else', async () => {
  const h = await ticketsHarness();
  try {
    h.sessions.add({ workspaceId: 'docker/api', id: 'sa' });
    const me = agent('docker/api', 'sa');
    h.tickets.create(UI, { summary: 'shared' });
    h.tickets.create(UI, { summary: 'mine', workspaceId: 'docker/api' });
    h.tickets.create(UI, { summary: 'theirs', workspaceId: 'docker/web' });
    assert.deepEqual(h.tickets.list(me).items.map((t) => t.summary).sort(), ['mine', 'shared']);
    assert.equal(h.tickets.list(me).counts.total, 2, 'counts follow what it can see');
    assert.equal(code(() => h.tickets.get(me, 'T-3')), 'NOT_FOUND', 'another workspace’s ticket does not exist for it');
    assert.equal(code(() => h.tickets.comment(me, 'T-3', 'hi')), 'NOT_FOUND');
    assert.deepEqual(h.tickets.tags(me), []);
    // An admin's token sees everything.
    assert.equal(h.tickets.list(token('ptk_s', 'read')).total, 3);
  } finally {
    h.done();
  }
});

test('what an agent may change: its own assigned tickets, and the ones it made that nobody holds', async () => {
  const h = await ticketsHarness();
  try {
    const sa = h.sessions.add({ workspaceId: 'docker/api', id: 'sa', title: 'Alpha' });
    const sb = h.sessions.add({ workspaceId: 'docker/api', id: 'sb' });
    const me = agent('docker/api', sa.id);
    const readOnly = token('ptk_r', 'read');

    const mine = h.tickets.create(UI, { summary: 'assigned to a', assignee: { kind: 'session', sessionId: sa.id } });
    const other = h.tickets.create(UI, { summary: 'assigned to b', assignee: { kind: 'session', sessionId: sb.id } });
    const person = h.tickets.create(UI, { summary: 'assigned to a person', workspaceId: 'docker/api', assignee: { kind: 'user', name: 'admin' } });
    const queue = h.tickets.create(UI, { summary: 'in the queue', workspaceId: 'docker/api' });

    assert.equal(h.tickets.comment(me, mine.id, 'working').kind, 'comment');
    assert.equal(h.tickets.update(me, mine.id, { status: 'blocked', priority: 'high' }).status, 'blocked');
    assert.equal(code(() => h.tickets.comment(me, other.id, 'hi')), 'FORBIDDEN', 'another session’s ticket, even in the same workspace');
    assert.equal(code(() => h.tickets.update(me, person.id, { priority: 'urgent' })), 'FORBIDDEN', 'a person holds it');
    assert.equal(code(() => h.tickets.update(me, queue.id, { assignee: { kind: 'session', sessionId: sa.id } })), 'FORBIDDEN', 'claim it, do not assign it to yourself');
    assert.equal(code(() => h.tickets.close(me, queue.id, { summary: 'x' })), 'FORBIDDEN');
    assert.equal(code(() => h.tickets.comment(readOnly, mine.id, 'hi')), 'FORBIDDEN', 'a read token only reads');
    assert.equal(code(() => h.tickets.create(readOnly, { summary: 'x' })), 'FORBIDDEN');
    assert.equal(code(() => h.tickets.remove(me, mine.id)), 'FORBIDDEN', 'agents never delete');
    assert.equal(code(() => h.tickets.update(me, mine.id, { status: 'done' })), 'VALIDATION_FAILED', 'closing goes through close, with a summary');
    assert.equal(code(() => h.tickets.close(me, mine.id, {})), 'VALIDATION_FAILED', 'an agent must say what was done');
    assert.equal(code(() => h.tickets.comment(me, mine.id, 'x', { sessionId: sb.id })), 'FORBIDDEN', 'an agent cannot act as another session');

    // A ticket an agent made for a person: it can comment and close it, and read the answer.
    const ask = h.tickets.create(me, { summary: 'May I delete the branch?', type: 'approval', assignee: { kind: 'user', name: 'admin' } });
    assert.equal(ask.source, 'agent');
    assert.equal(ask.workspaceId, 'docker/api', 'its own workspace');
    assert.deepEqual(ask.reporter, { kind: 'token', ref: 'session:sa', label: 'Alpha', workspaceId: 'docker/api' });
    h.tickets.comment(UI, ask.id, 'Yes, go ahead.');
    assert.equal(h.tickets.get(me, ask.id).events.at(-1)!.body, 'Yes, go ahead.');
    h.tickets.comment(me, ask.id, 'Thanks, deleting it.');
    const closed = h.tickets.close(me, ask.id, { summary: 'Deleted the branch.' });
    assert.equal(closed.status, 'done');
    assert.equal(closed.closingSummary, 'Deleted the branch.');
    assert.equal(code(() => h.tickets.comment(me, ask.id, 'one more')), 'FORBIDDEN', 'closed tickets are read-only for agents');
    assert.equal(code(() => h.tickets.update(me, ask.id, { status: 'open' })), 'FORBIDDEN', 'an agent cannot reopen');
    assert.equal(h.tickets.update(UI, ask.id, { status: 'open' }).status, 'open', 'a person can');
    assert.equal(h.tickets.update(token('ptk_s', 'operate'), ask.id, { priority: 'low' }).priority, 'low', 'an admin’s operate token can change anything');
    // The same session after a Claude switch (a new token, the same session id) is still the reporter; another session is not.
    assert.equal(h.tickets.comment(agent('docker/api', 'sa', 'agt_newer'), ask.id, 'back again').kind, 'comment');
    assert.equal(code(() => h.tickets.comment(agent('docker/api', 'sb'), ask.id, 'hi')), 'FORBIDDEN');
    // Another workspace's agent can't touch it at all.
    h.sessions.add({ workspaceId: 'docker/web', id: 'sw' });
    assert.equal(code(() => h.tickets.comment(agent('docker/web', 'sw'), ask.id, 'hi')), 'NOT_FOUND');
    // The timeline names the session, as the token verified it.
    const entry = h.tickets.get(UI, mine.id).events.find((e) => e.kind === 'comment')!;
    assert.equal(entry.actor, 'session:sa');
    assert.equal(entry.fromAgent, true);
    assert.deepEqual(entry.data, { session: 'sa' });
  } finally {
    h.done();
  }
});

test('which session is calling: an agent is its verified one, an admin’s token names it, and an ended session can do nothing', async () => {
  const h = await ticketsHarness();
  try {
    const a = h.sessions.add({ workspaceId: 'docker/api', id: 'sa', title: 'Alpha' });
    const b = h.sessions.add({ workspaceId: 'docker/api', id: 'sb', title: 'Beta' });
    h.sessions.add({ workspaceId: 'docker/web', id: 'sw' });
    const t = h.tickets.create(UI, { summary: 'queue work', workspaceId: 'docker/api' });
    const me = agent('docker/api', b.id);

    // An agent claims as its own session: no argument, and none to forge.
    const claimed = h.tickets.claimNext(me, {})!;
    assert.equal(claimed.id, t.id);
    assert.deepEqual(claimed.assignee, { kind: 'session', sessionId: 'sb' });
    assert.equal(code(() => h.tickets.claimNext(me, { sessionId: a.id })), 'FORBIDDEN', 'not as another session');
    assert.equal(h.tickets.meSession(me), 'sb');

    // An admin's token must say which session it acts for, and it must be a live one.
    const script = token('ptk_s', 'operate');
    assert.equal(code(() => h.tickets.claimNext(script, {})), 'SESSION_REQUIRED');
    assert.equal(code(() => h.tickets.claimNext(script, { sessionId: 'ghost' })), 'VALIDATION_FAILED');
    const t2 = h.tickets.create(UI, { summary: 'more work' });
    assert.equal(h.tickets.claimNext(script, { sessionId: a.id })!.id, t2.id);
    assert.equal(h.tickets.get(UI, t2.id).ticket.workspaceId, 'docker/api', 'a shared ticket takes its claimer’s workspace');

    // Once its session has ended, an agent's token can do nothing (the endpoint refuses it too; this is the service's own check).
    h.sessions.setState(b.id, 'ended');
    assert.equal(code(() => h.tickets.comment(me, t.id, 'late')), 'FORBIDDEN');
    assert.equal(code(() => h.tickets.claimNext(me, {})), 'FORBIDDEN');
    assert.equal(code(() => h.tickets.claimNext(script, { sessionId: b.id })), 'VALIDATION_FAILED');
  } finally {
    h.done();
  }
});

test('ticket_claim_next order and filters: urgent first then oldest, all tags, one of the types, never an approval', async () => {
  let now = Date.parse('2026-03-01T10:00:00Z');
  const h = await ticketsHarness({ now: () => new Date(now++ * 1000) });
  try {
    const s = h.sessions.add({ workspaceId: 'docker/api', id: 'sa' });
    const me = agent('docker/api', s.id);
    h.tickets.create(UI, { summary: 'old normal', tags: ['frontend'] });
    h.tickets.create(UI, { summary: 'newer urgent backend', priority: 'urgent', tags: ['backend'] });
    h.tickets.create(UI, { summary: 'urgent frontend bug', priority: 'urgent', type: 'bug', tags: ['frontend', 'login'] });
    h.tickets.create(UI, { summary: 'approval', priority: 'urgent', type: 'approval' });
    h.tickets.create(UI, { summary: 'other workspace', priority: 'urgent', workspaceId: 'docker/web' });
    h.tickets.create(UI, { summary: 'held by a person', priority: 'urgent', assignee: { kind: 'user', name: 'admin' } });

    assert.equal(h.tickets.claimNext(me, { tags: ['frontend', 'login'] })!.summary, 'urgent frontend bug', 'all the tags');
    assert.equal(h.tickets.claimNext(me, { types: ['chore'] }), null, 'nothing of that type: none, not an error');
    const next = h.tickets.claimNext(me, {})!;
    assert.equal(next.summary, 'newer urgent backend', 'urgent before older normal; never the approval, the other workspace or the held one');
    assert.equal(next.status, 'in_progress');
    assert.equal(next.workspaceId, 'docker/api', 'a shared ticket takes its claimer’s workspace');
    assert.equal(h.tickets.claimNext(me, {})!.summary, 'old normal');
    assert.equal(h.tickets.claimNext(me, {}), null, 'the queue is empty for it');
    assert.deepEqual(h.tickets.get(UI, 'T-2').events.map((e) => e.kind), ['created', 'assigned', 'status', 'workspace']);
    assert.equal((h.tickets.get(UI, 'T-2').events[1]!.data as { claimed: boolean }).claimed, true);
    // A specific ticket can be claimed by id when it is claimable.
    const t = h.tickets.create(UI, { summary: 'pick me', priority: 'low' });
    assert.equal(h.tickets.claimNext(me, { id: t.id })!.id, t.id);
    assert.equal(h.tickets.claimNext(me, { id: 'T-4' }), null, 'an approval is never claimable');
  } finally {
    h.done();
  }
});

test('two callers never get the same ticket', async () => {
  const h = await ticketsHarness();
  try {
    const sessions = Array.from({ length: 4 }, (_, i) => h.sessions.add({ workspaceId: 'docker/api', id: `s${i}` }));
    for (let i = 0; i < 6; i++) h.tickets.create(UI, { summary: `job ${i}`, priority: i % 2 ? 'high' : 'normal' });
    const got = new Set<string>();
    let rounds = 0;
    for (let round = 0; round < 3; round++)
      for (const s of sessions) {
        const t = h.tickets.claimNext(agent('docker/api', s.id), {});
        rounds++;
        if (t) {
          assert.ok(!got.has(t.id), `${t.id} was handed out twice`);
          got.add(t.id);
        }
      }
    assert.equal(got.size, 6);
    assert.equal(rounds, 12);
  } finally {
    h.done();
  }
});

test('queue limits: 50 tickets an hour per session, 200 open agent tickets per workspace', async () => {
  let now = Date.parse('2026-03-01T10:00:00Z');
  const h = await ticketsHarness({ now: () => new Date(now) });
  try {
    h.sessions.add({ workspaceId: 'docker/api', id: 'sa' });
    for (let i = 0; i < 5; i++) h.sessions.add({ workspaceId: 'docker/api', id: `s${i}` });
    const me = agent('docker/api', 'sa');
    for (let i = 0; i < CREATE_PER_HOUR; i++) h.tickets.create(me, { summary: `t${i}` });
    assert.equal(code(() => h.tickets.create(me, { summary: 'one too many' })), 'RATE_LIMITED');
    assert.equal(h.tickets.create(UI, { summary: 'a person is not limited' }).id, `T-${CREATE_PER_HOUR + 1}`);
    assert.equal(h.tickets.create(agent('docker/api', 's0'), { summary: 'another session has its own allowance' }).source, 'agent');
    now += 61 * 60_000;
    assert.equal(h.tickets.create(me, { summary: 'an hour later' }).source, 'agent');
    // Workspace cap: 200 open agent tickets across sessions.
    for (let i = 1; i < 5; i++) {
      now += 61 * 60_000;
      const t = agent('docker/api', `s${i}`);
      for (let j = 0; j < CREATE_PER_HOUR && (h.store.db!.prepare("SELECT count(*) AS n FROM tickets WHERE source = 'agent' AND status = 'open'").get() as { n: number }).n < 200; j++) h.tickets.create(t, { summary: `bulk ${i}-${j}` });
    }
    now += 61 * 60_000;
    assert.equal(code(() => h.tickets.create(agent('docker/api', 'sa'), { summary: 'over the cap' })), 'RATE_LIMITED');
  } finally {
    h.done();
  }
});

test('starting a session: created for the ticket, assigned before the message, opened as ticket:<id>', async () => {
  const h = await ticketsHarness();
  try {
    const t = h.tickets.create(UI, { summary: 'Fix the login redirect', type: 'bug', priority: 'high', tags: ['login'], description: 'After login the user lands on /undefined.' });
    let assignedWhenSent: string | null = null;
    h.sessions.onSend = (sessionId) => {
      const now = h.tickets.get(UI, t.id).ticket;
      assignedWhenSent = now.assignee?.kind === 'session' && now.assignee.sessionId === sessionId && now.status === 'in_progress' ? 'yes' : 'no';
    };
    const r = await h.tickets.startSession(UI, t.id, { workspaceId: 'docker/api', claudeId: 'c1', worktree: true });
    assert.equal(assignedWhenSent, 'yes', 'the agent’s first tool call finds the ticket assigned to it');
    assert.deepEqual(h.sessions.created[0], { ticketId: 'T-1', workspaceId: 'docker/api', claudeId: 'c1', cwd: undefined, title: 'T-1: Fix the login redirect', worktree: {} });
    assert.equal(r.ticket.status, 'in_progress');
    assert.equal(r.ticket.workspaceId, 'docker/api');
    assert.deepEqual(r.ticket.assignee, { kind: 'session', sessionId: r.session.id });
    assert.deepEqual(r.ticket.worktree, { branch: 'ticket-branch', path: '/home/node/work.worktrees/ticket-branch' });
    assert.deepEqual(kinds(h, t.id), ['created', 'session_started', 'assigned', 'status', 'workspace']);

    const sent = h.sessions.sent[0]!;
    assert.equal(sent.ticketId, 'T-1');
    assert.equal(sent.sessionId, r.session.id);
    assert.equal(sent.label, 'T-1', 'the transcript says "From ticket T-1"');
    assert.match(sent.text, /ticket T-1/);
    assert.match(sent.text, /Type: Bug · Priority: High · Tags: login/);
    assert.match(sent.text, /Reported by a person in the portal\./);
    assert.ok(sent.text.includes(`Your portal session id is ${r.session.id}.`));
    assert.ok(sent.text.includes('After login the user lands on /undefined.'));
    assert.match(sent.text, /ticket_close/);
    assert.deepEqual(h.tickets.get(UI, t.id).sessions.map((s) => s.id), [r.session.id], 'the ticket lists the sessions that worked it');

    // A closed ticket needs reopening first; a failed session create leaves the ticket as it was.
    h.tickets.close(UI, t.id, { summary: 'x' });
    assert.equal(await codeAsync(() => h.tickets.startSession(UI, t.id, { workspaceId: 'docker/api' })), 'CONFLICT');
    const t2 = h.tickets.create(UI, { summary: 'Second' });
    h.sessions.failCreate = new AppError('CONFLICT', 'The workspace is not eligible.');
    assert.equal(await codeAsync(() => h.tickets.startSession(UI, t2.id, { workspaceId: 'docker/api' })), 'CONFLICT');
    assert.equal(h.tickets.get(UI, t2.id).ticket.status, 'open');
    assert.deepEqual(kinds(h, t2.id), ['created']);
    // Only a person starts one.
    h.sessions.failCreate = null;
    h.sessions.add({ workspaceId: 'docker/api', id: 'sagent' });
    assert.equal(await codeAsync(() => h.tickets.startSession(agent('docker/api', 'sagent'), t2.id, { workspaceId: 'docker/api' })), 'FORBIDDEN', 'an agent can’t');
    assert.equal(await codeAsync(() => h.tickets.startSession(token('ptk_o', 'operate'), t2.id, { workspaceId: 'docker/api' })), 'FORBIDDEN', 'operate isn’t enough');
    const viaToken = await h.tickets.startSession(token('ptk_admin', 'admin'), t2.id, { workspaceId: 'docker/api' });
    assert.equal(h.tickets.get(UI, t2.id).events.find((e) => e.kind === 'session_started')!.actor, 'portal-mcp:ptk_admin', 'an admin’s token can, and is named');
    assert.ok(viaToken.session.id);
    // T-6: the timeline names the token by its label, also when it acts for a session.
    assert.equal(h.tickets.get(UI, t2.id).events.find((e) => e.kind === 'session_started')!.actorLabel, 'ptk_admin-label');
    h.sessions.add({ workspaceId: 'docker/api', id: 'sfor', title: 'Worker' });
    const viaTokenForSession = h.tickets.comment(token('ptk_admin', 'admin'), t2.id, 'seen', { sessionId: 'sfor' });
    assert.deepEqual([viaTokenForSession.actor, viaTokenForSession.actorLabel], ['portal-mcp:ptk_admin', 'ptk_admin-label']);
    assert.equal(await codeAsync(() => h.tickets.startSession(UI, 'T-9', { workspaceId: 'docker/api' })), 'NOT_FOUND');
  } finally {
    h.done();
  }
});

test('a session that starts but cannot be sent the ticket leaves a note and says so', async () => {
  const h = await ticketsHarness();
  try {
    const t = h.tickets.create(UI, { summary: 'Work' });
    h.sessions.failSend = new Error('Claude Code is not running');
    assert.match(await codeAsync(() => h.tickets.startSession(UI, t.id, { workspaceId: 'docker/api' })), /^(other:Claude Code is not running|SERVICE_UNAVAILABLE)$/);
    const detail = h.tickets.get(UI, t.id);
    assert.equal(detail.ticket.status, 'in_progress', 'it is assigned: the person can message the session');
    assert.ok(detail.events.at(-1)!.body!.includes('opening message could not be sent'));
    assert.equal(detail.events.at(-1)!.actor, 'system');
  } finally {
    h.done();
  }
});

test('a session that ends under an unfinished ticket leaves one entry, and nothing is closed or reassigned', async () => {
  const h = await ticketsHarness();
  try {
    const s = h.sessions.add({ workspaceId: 'docker/api', id: 'sa' });
    const t = h.tickets.create(UI, { summary: 'Work', assignee: { kind: 'session', sessionId: s.id } });
    const done = h.tickets.create(UI, { summary: 'Done work', assignee: { kind: 'session', sessionId: s.id } });
    h.tickets.close(UI, done.id, { summary: 'ok' });
    h.sessions.setState(s.id, 'ended', 'closed by operator');
    h.sessions.setState(s.id, 'ended', 'closed by operator');
    const detail = h.tickets.get(UI, t.id);
    assert.deepEqual(detail.events.map((e) => e.kind), ['created', 'assigned', 'session_ended']);
    assert.equal(detail.events.at(-1)!.data!.reason, 'closed by operator');
    assert.equal(detail.ticket.sessionEnded, true, 'the page flags it');
    assert.equal(detail.ticket.status, 'open');
    assert.deepEqual(detail.ticket.assignee, { kind: 'session', sessionId: 'sa' });
    assert.deepEqual(kinds(h, done.id).includes('session_ended'), false, 'a closed ticket is left alone');
  } finally {
    h.done();
  }
});

test('deleting is for people, and takes the timeline and tags with it', async () => {
  const h = await ticketsHarness();
  try {
    const t = h.tickets.create(UI, { summary: 'Spam', tags: ['x'] });
    assert.equal(code(() => h.tickets.remove(token('ptk_s', 'admin'), t.id)), 'FORBIDDEN');
    h.tickets.remove(UI, t.id);
    assert.equal(code(() => h.tickets.get(UI, t.id)), 'NOT_FOUND');
    assert.equal((h.store.db!.prepare('SELECT count(*) AS n FROM ticket_events').get() as { n: number }).n, 0);
    assert.equal((h.store.db!.prepare('SELECT count(*) AS n FROM ticket_tags').get() as { n: number }).n, 0);
    assert.equal(h.tickets.create(UI, { summary: 'Next' }).id, 'T-2', 'a deleted number is never reused');
  } finally {
    h.done();
  }
});

test('fake sessions stand in for the chat side: the real adapter has the same shape', async () => {
  const fake: import('./sessions.js').TicketSessions = new FakeSessions();
  assert.equal(typeof fake.create, 'function');
  assert.equal(typeof fake.send, 'function');
  assert.equal(typeof fake.onSession, 'function');
});

test('CI (interface I10): tickets are found from a branch or a commit trailer, a check is attached, a note is added', async () => {
  assert.equal(parseTicketBranch('ticket/T-12-fix-login'), 'T-12');
  assert.equal(parseTicketBranch('ticket/12-fix-login'), 'T-12');
  assert.equal(parseTicketBranch('feature/ticket/7'), 'T-7');
  assert.equal(parseTicketBranch('refs/heads/ticket/T-3_x'), 'T-3');
  assert.equal(parseTicketBranch('ticketing/12'), null);
  assert.equal(parseTicketBranch('main'), null);
  assert.deepEqual(parseTicketTrailers('Fix it\n\nTicket: T-4\nticket: 5\nTicket: #4\nSigned-off-by: x'), ['T-4', 'T-5']);
  assert.deepEqual(parseTicketTrailers('no trailer here Ticket: T-9 mid-line'), []);

  let now = Date.parse('2026-03-01T10:00:00Z');
  const h = await ticketsHarness({ now: () => new Date(now) });
  try {
    h.tickets.create(UI, { summary: 'One' });
    h.tickets.create(UI, { summary: 'Two' });
    assert.deepEqual(h.tickets.find({ branch: 'ticket/T-2-x', message: 'Body\n\nTicket: T-1\nTicket: T-99' }), ['T-2', 'T-1'], 'a branch first, then trailers; unknown ids left out');
    assert.deepEqual(h.tickets.find({ branch: 'main' }), []);

    const ci = { actor: 'ci:run-41', label: 'CI' };
    now += 1000;
    assert.equal(h.tickets.attachCheck('T-2', { name: 'build', state: 'queued', runId: 'run-41' }, ci)!.state, 'queued');
    now += 1000;
    const check = h.tickets.attachCheck('T-2', { name: 'build', state: 'running', runId: 'run-41', commit: 'ABCDEF1234', link: 'https://ci.example/runs/41' }, ci)!;
    assert.deepEqual([check.name, check.state, check.commit, check.link], ['build', 'running', 'abcdef1234', 'https://ci.example/runs/41']);
    now += 1000;
    h.tickets.attachCheck('T-2', { name: 'build', state: 'passed', runId: 'run-41', commit: 'abcdef1234' }, ci);
    h.tickets.attachCheck('T-2', { name: 'build', state: 'passed', runId: 'run-41' }, ci); // no change, no entry
    h.tickets.attachCheck('T-2', { name: 'lint', state: 'failed', link: '/admin/ci/runs/41' }, { actor: 'ci:run-41' });
    assert.equal(h.tickets.checks('T-2').find((c) => c.name === 'lint')!.link, '/admin/ci/runs/41', 'a page of the portal is a fine link');
    const detail = h.tickets.get(UI, 'T-2');
    assert.deepEqual(detail.checks.map((c) => [c.name, c.state]), [['build', 'passed'], ['lint', 'failed']], 'one row per name, its latest state');
    const entries = detail.events.filter((e) => e.kind === 'ci');
    assert.deepEqual(entries.map((e) => [e.actor, (e.data as { name: string; state: string }).state]), [['ci:run-41', 'queued'], ['ci:run-41', 'running'], ['ci:run-41', 'passed'], ['ci:run-41', 'failed']]);
    assert.equal(entries[0]!.fromAgent, true, 'CI text is as untrusted as an agent’s');
    assert.equal(detail.ticket.updatedAt, new Date(now).toISOString());

    assert.equal(h.tickets.attachCheck('T-9', { name: 'build', state: 'passed' }, ci), null, 'no such ticket');
    assert.equal(code(() => h.tickets.attachCheck('T-2', { name: 'build', state: 'green' as never }, ci)), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.attachCheck('T-2', { name: 'build', state: 'passed', link: 'javascript:alert(1)' }, ci)), 'VALIDATION_FAILED');
    for (const link of ['//evil.example/x', '/admin/../../etc', '/other/page', 'ftp://x.example/a', 'https://a b.example/', '/admin/ci\u0000x'])
      assert.equal(code(() => h.tickets.attachCheck('T-2', { name: 'build', state: 'passed', link }, ci)), 'VALIDATION_FAILED', `link ${JSON.stringify(link)}`);
    assert.equal(code(() => h.tickets.attachCheck('T-2', { name: 'build', state: 'passed', commit: 'zzz' }, ci)), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.attachCheck('T-2', { name: 'build', state: 'passed' }, { actor: 'CI RUN' })), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.attachCheck('T-2', { name: `key ${KEY}`, state: 'passed' }, ci)), 'VALIDATION_FAILED', 'credentials are refused here too');

    assert.equal(h.tickets.note('T-2', 'Run 41: 2 jobs, 1 failed (lint).', ci), true);
    assert.equal(h.tickets.note('T-9', 'x', ci), false);
    assert.equal(code(() => h.tickets.note('T-2', `token ${KEY}`, ci)), 'VALIDATION_FAILED');
    const last = h.tickets.get(UI, 'T-2').events.at(-1)!;
    assert.deepEqual([last.kind, last.actor, last.actorLabel, last.fromAgent], ['comment', 'ci:run-41', 'CI', true]);
    h.tickets.remove(UI, 'T-2');
    assert.equal((h.store.db!.prepare('SELECT count(*) AS n FROM ticket_checks').get() as { n: number }).n, 0, 'checks go with the ticket');
  } finally {
    h.done();
  }
});

test('migration 45 keeps what migration 44 wrote: a waiting check becomes queued, check entries become ci', async () => {
  const secretKey = parseSecretKey(generateSecretKey());
  const dataDir = tempDirectory('cp-tickets-mig-');
  const old = await Store.open({ dataDir, secretKey, migrations: MIGRATIONS.filter((m) => m.version !== 45) });
  const at = '2026-10-12T00:00:00.000Z';
  old.db!.prepare("INSERT INTO tickets (type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at) VALUES ('task', 'normal', 2, 'open', 'Old', 'human', 'ui', 'Admin', ?, ?)").run(at, at);
  old.db!.prepare("INSERT INTO ticket_checks (ticket_number, name, state, run_id, actor, updated_at) VALUES (1, 'build', 'pending', 'r1', 'ci:r1', ?), (1, 'lint', 'passed', 'r1', 'ci:r1', ?)").run(at, at);
  old.db!.prepare("INSERT INTO ticket_events (ticket_number, at, kind, actor, actor_label, data) VALUES (1, ?, 'check', 'ci:r1', 'CI', '{\"name\":\"build\"}')").run(at);
  old.close();

  const store = await Store.open({ dataDir, secretKey });
  try {
    const rows = store.db!.prepare('SELECT name, state FROM ticket_checks ORDER BY name').all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ name: 'build', state: 'queued' }, { name: 'lint', state: 'passed' }]);
    assert.equal((store.db!.prepare("SELECT kind FROM ticket_events WHERE ticket_number = 1").get() as { kind: string }).kind, 'ci');
    assert.throws(() => store.db!.prepare("UPDATE ticket_checks SET state = 'pending'").run(), /CHECK/, 'the old word is refused now');
  } finally {
    store.close();
  }
});
