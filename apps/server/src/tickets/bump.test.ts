// Bump (tickets PRD FR28 to FR32): a ticket pushed into a running session, as its next work (Prioritise) or as a question (Ask). The two
// modes, the refusals, the timeline entry, the message the session gets, the answer by comment, the limits, the audit, the routes behind
// the seam and the Portal MCP tool with its confirmation.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { FOUNDING_USER_ID, sessionRef, TICKET_API, type Actor, type BumpRequest } from '@portal/contracts';
import { Hono } from 'hono';
import { clearResolvers, declaredPolicies, declaredToolPolicies, registerResolver } from '../authz/seam.js';
import type { ChatController } from '../chat/controller.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { TICKET_BUMP_POLICIES, TICKET_BUMP_TOOL_POLICIES } from './authz.js';
import { registerTicketTools } from './portalTools.js';
import { createTicketRoutes } from './routes.js';
import { BUMP_PER_HOUR_SESSION, BUMP_PER_HOUR_TICKET, Tickets, type TicketAudit } from './service.js';
import { ChatTicketSessions } from './sessions.js';
import { agent, FakeSessions, ticketsHarness, token, UI } from './testkit.js';

afterEach(() => clearResolvers());

const codeAsync = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    return e instanceof AppError ? e.code : `other:${(e as Error).message}`;
  }
  return 'none';
};
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : `other:${(e as Error).message}`;
  }
  return 'none';
};

test('Prioritise: the ticket is assigned to the session and in progress, a bumped entry, and the message goes in as next from the ticket', async () => {
  const h = await ticketsHarness();
  try {
    const audits: TicketAudit[] = [];
    h.tickets.onAudit = (e) => void audits.push(e);
    h.sessions.add({ id: 'sa', workspaceId: 'docker/api', title: 'Alpha', state: 'working' });
    h.sessions.add({ id: 'sb', workspaceId: 'docker/api', title: 'Beta' });
    const t = h.tickets.create(UI, { summary: 'Fix the login redirect', type: 'bug', priority: 'high', tags: ['login'], description: 'After login the user lands on /undefined.', assignee: { kind: 'session', sessionId: 'sb' } });
    let assignedWhenSent = false;
    h.sessions.onSend = (sid) => {
      const now = h.tickets.get(UI, t.id).ticket;
      assignedWhenSent = now.assignee?.kind === 'session' && now.assignee.sessionId === sid && now.status === 'in_progress';
    };

    const r = await h.tickets.bump(UI, t.id, { sessionId: 'sa', mode: 'prioritise', note: 'Before the release, please' });
    assert.ok(assignedWhenSent, 'the session’s first tool call finds the ticket assigned to it');
    assert.equal(r.mode, 'prioritise');
    assert.equal(r.ticket.status, 'in_progress');
    assert.deepEqual(r.ticket.assignee, { kind: 'session', sessionId: 'sa' });
    assert.equal(r.session.id, 'sa');

    const events = h.tickets.get(UI, t.id).events;
    assert.deepEqual(events.map((e) => e.kind), ['created', 'assigned', 'assigned', 'status', 'bumped']);
    const bumped = events.at(-1)!;
    assert.deepEqual([bumped.actor, bumped.actorLabel, bumped.body], ['ui', 'Admin', 'Before the release, please']);
    assert.deepEqual(bumped.data, { sessionId: 'sa', sessionTitle: 'Alpha', mode: 'prioritise' });

    // The transcript event: from ticket:T-1, labelled T-1 ("From ticket T-1"), queued as next.
    const sent = h.sessions.sent[0]!;
    assert.deepEqual([sent.sessionId, sent.ticketId, sent.label, sent.priority], ['sa', 'T-1', 'T-1', 'next']);
    assert.match(sent.text, /^A person in the portal bumped ticket T-1 to you: make it your next work\./);
    assert.match(sent.text, /Type: Bug · Priority: High · Tags: login/);
    assert.match(sent.text, /Summary: Fix the login redirect/);
    assert.match(sent.text, /Link: \/admin\/tickets\/T-1/);
    assert.match(sent.text, /“Before the release, please”/);
    assert.ok(sent.text.includes('-----\nAfter login the user lands on /undefined.\n-----'));
    assert.match(sent.text, /assigned to your session \(sa\) and in progress/);
    assert.match(sent.text, /ticket_close/);

    // Audited: who, which ticket, which session, how; never the note's words.
    assert.deepEqual(audits, [{ kind: 'ticket.bumped', actor: 'ui', actorLabel: null, userId: FOUNDING_USER_ID, subject: 'ticket:T-1', detail: { ticketId: 'T-1', sessionId: 'sa', mode: 'prioritise', note: true } }]);

    // Prioritising into the session it is already with only adds the bumped entry.
    await h.tickets.bump(UI, t.id, { sessionId: 'sa', mode: 'prioritise' });
    assert.deepEqual(h.tickets.get(UI, t.id).events.slice(5).map((e) => e.kind), ['bumped']);
  } finally {
    h.done();
  }
});

test('Ask: nothing about the ticket changes, the message waits (later), and the session may answer with a comment, only on that ticket', async () => {
  const h = await ticketsHarness();
  try {
    h.sessions.add({ id: 'sa', workspaceId: 'docker/api', title: 'Alpha' });
    h.sessions.add({ id: 'sb', workspaceId: 'docker/api', title: 'Beta' });
    const t = h.tickets.create(UI, { summary: 'Why is the build slow?', workspaceId: 'docker/api', assignee: { kind: 'user', name: 'admin' } });
    const other = h.tickets.create(UI, { summary: 'Not asked', workspaceId: 'docker/api' });
    const before = h.tickets.get(UI, t.id).ticket;

    const r = await h.tickets.bump(UI, t.id, { sessionId: 'sa', mode: 'ask' });
    assert.deepEqual([r.ticket.status, r.ticket.assignee], [before.status, before.assignee], 'nothing reassigned, the ticket stays as it is');
    assert.deepEqual(h.tickets.get(UI, t.id).events.map((e) => e.kind), ['created', 'assigned', 'bumped']);
    const sent = h.sessions.sent[0]!;
    assert.equal(sent.priority, 'later');
    assert.match(sent.text, /^A person in the portal has a question about ticket T-1 for you\./);
    assert.match(sent.text, /No note: say what you know about it/);
    assert.match(sent.text, /Answer with ticket_comment on T-1/);

    // The asked session answers on the ticket (a person holds it, so FR9 alone would refuse); another session can't, nor on another ticket.
    assert.equal(h.tickets.comment(agent('docker/api', 'sa'), t.id, 'It rebuilds the web app twice.').actor, 'session:sa');
    assert.equal(code(() => h.tickets.comment(agent('docker/api', 'sb'), t.id, 'me too')), 'FORBIDDEN');
    assert.equal(code(() => h.tickets.comment(agent('docker/api', 'sa'), other.id, 'and this')), 'FORBIDDEN');
    assert.equal(code(() => h.tickets.update(agent('docker/api', 'sa'), t.id, { status: 'blocked' })), 'FORBIDDEN', 'an answer, not a change');
    h.tickets.close(UI, t.id, { summary: 'answered' });
    assert.equal(code(() => h.tickets.comment(agent('docker/api', 'sa'), t.id, 'late')), 'FORBIDDEN', 'not on a closed ticket');
  } finally {
    h.done();
  }
});

test('the answer window closes after a day', async () => {
  let now = new Date('2026-03-01T10:00:00Z');
  const h = await ticketsHarness({ now: () => now });
  try {
    h.sessions.add({ id: 'sa', workspaceId: 'docker/api' });
    const t = h.tickets.create(UI, { summary: 'A question', workspaceId: 'docker/api' });
    await h.tickets.bump(UI, t.id, { sessionId: 'sa', mode: 'ask' });
    now = new Date(now.getTime() + 25 * 3_600_000);
    assert.equal(code(() => h.tickets.comment(agent('docker/api', 'sa'), t.id, 'late')), 'FORBIDDEN');
  } finally {
    h.done();
  }
});

test('refusals: an ended, waiting or other-workspace session, a closed ticket, a bad mode or note, and who may bump; nothing is written', async () => {
  const h = await ticketsHarness();
  try {
    h.sessions.add({ id: 'ok', workspaceId: 'docker/api' });
    h.sessions.add({ id: 'ended', workspaceId: 'docker/api', state: 'ended' });
    h.sessions.add({ id: 'asks', workspaceId: 'docker/api', state: 'waiting' });
    h.sessions.add({ id: 'web', workspaceId: 'docker/web' });
    const t = h.tickets.create(UI, { summary: 'Work', workspaceId: 'docker/api' });
    const bump = (caller: Parameters<Tickets['bump']>[0], req: object) => codeAsync(() => h.tickets.bump(caller, t.id, req as Partial<BumpRequest>));

    assert.equal(await bump(UI, { sessionId: 'ended', mode: 'ask' }), 'CONFLICT');
    assert.equal(await bump(UI, { sessionId: 'asks', mode: 'prioritise' }), 'CONFLICT');
    assert.equal(await bump(UI, { sessionId: 'web', mode: 'prioritise' }), 'CONFLICT');
    assert.equal(await bump(UI, { sessionId: 'nope', mode: 'ask' }), 'VALIDATION_FAILED');
    assert.equal(await bump(UI, { mode: 'ask' }), 'VALIDATION_FAILED');
    assert.equal(await bump(UI, { sessionId: 'ok', mode: 'later' }), 'VALIDATION_FAILED');
    assert.equal(await bump(UI, { sessionId: 'ok', mode: 'ask', note: 'x'.repeat(201) }), 'VALIDATION_FAILED');
    assert.equal(await bump(UI, { sessionId: 'ok', mode: 'ask', note: `key ${'sk-ant-api03-' + 'k'.repeat(24)}` }), 'VALIDATION_FAILED');
    assert.equal(await bump(agent('docker/api', 'ok'), { sessionId: 'ok', mode: 'ask' }), 'FORBIDDEN', 'an agent never bumps');
    assert.equal(await bump(token('ptk_r', 'read'), { sessionId: 'ok', mode: 'ask' }), 'FORBIDDEN', 'a read token only reads');
    assert.equal(await codeAsync(() => h.tickets.bump(UI, 'T-99', { sessionId: 'ok', mode: 'ask' })), 'NOT_FOUND');
    assert.deepEqual(h.tickets.get(UI, t.id).events.map((e) => e.kind), ['created']);
    assert.equal(h.sessions.sent.length, 0);

    h.tickets.close(UI, t.id, { summary: 'x' });
    assert.equal(await bump(UI, { sessionId: 'ok', mode: 'ask' }), 'CONFLICT', 'reopen it first');

    // The picker offers the same: ended and other workspaces left out, the waiting one greyed out with why.
    const u = h.tickets.create(UI, { summary: 'Picker', assignee: { kind: 'session', sessionId: 'web' } });
    h.tickets.update(UI, u.id, { workspaceId: 'docker/api' }); // its session works elsewhere
    assert.deepEqual(h.tickets.bumpTargets(UI, u.id).map((x) => [x.id, x.preferred, x.refusal]), [['web', true, 'other_workspace'], ['ok', false, null], ['asks', false, 'waiting']]);
    assert.equal(code(() => h.tickets.bumpTargets(agent('docker/api', 'ok'), u.id)), 'FORBIDDEN');
  } finally {
    h.done();
  }
});

test('a script with an operate token bumps, and is named on the timeline and in the message', async () => {
  const h = await ticketsHarness();
  try {
    h.sessions.add({ id: 'sa', workspaceId: 'docker/api' });
    const t = h.tickets.create(UI, { summary: 'From CI', workspaceId: 'docker/api' });
    await h.tickets.bump(token('ptk_ops', 'operate'), t.id, { sessionId: 'sa', mode: 'prioritise' });
    const e = h.tickets.get(UI, t.id).events.at(-1)!;
    assert.deepEqual([e.kind, e.actor, e.actorLabel, e.fromAgent], ['bumped', 'portal-mcp:ptk_ops', 'ptk_ops-label', true]);
    assert.match(h.sessions.sent[0]!.text, /^The MCP client “ptk_ops-label” bumped ticket T-1/);
  } finally {
    h.done();
  }
});

test('limits: 10 bumps of a ticket and 20 into a session in an hour', async () => {
  let now = new Date('2026-03-01T10:00:00Z');
  const h = await ticketsHarness({ now: () => now });
  try {
    h.sessions.add({ id: 'sa', workspaceId: 'docker/api' });
    h.sessions.add({ id: 'sb', workspaceId: 'docker/api' });
    const t = h.tickets.create(UI, { summary: 'Hot', workspaceId: 'docker/api' });
    for (let i = 0; i < BUMP_PER_HOUR_TICKET; i++) await h.tickets.bump(UI, t.id, { sessionId: 'sa', mode: 'ask' });
    assert.equal(await codeAsync(() => h.tickets.bump(UI, t.id, { sessionId: 'sb', mode: 'ask' })), 'RATE_LIMITED');
    const others = Array.from({ length: 3 }, (_, i) => h.tickets.create(UI, { summary: `Other ${i}`, workspaceId: 'docker/api' }));
    for (let i = BUMP_PER_HOUR_TICKET; i < BUMP_PER_HOUR_SESSION; i++) await h.tickets.bump(UI, others[i % 3]!.id, { sessionId: 'sa', mode: 'ask' });
    assert.equal(await codeAsync(() => h.tickets.bump(UI, others[0]!.id, { sessionId: 'sa', mode: 'ask' })), 'RATE_LIMITED', 'the session has had enough');
    assert.equal(await codeAsync(() => h.tickets.bump(UI, others[0]!.id, { sessionId: 'sb', mode: 'ask' })), 'none', 'another session still can');
    now = new Date(now.getTime() + 61 * 60_000);
    assert.equal(await codeAsync(() => h.tickets.bump(UI, t.id, { sessionId: 'sa', mode: 'ask' })), 'none', 'an hour later');
  } finally {
    h.done();
  }
});

test('a bump that cannot be sent leaves a note on the ticket and says so', async () => {
  const h = await ticketsHarness();
  try {
    h.sessions.add({ id: 'sa', workspaceId: 'docker/api' });
    const t = h.tickets.create(UI, { summary: 'Work', workspaceId: 'docker/api' });
    h.sessions.failSend = new Error('Claude Code is not running');
    assert.equal(await codeAsync(() => h.tickets.bump(UI, t.id, { sessionId: 'sa', mode: 'ask' })), 'SERVICE_UNAVAILABLE');
    const last = h.tickets.get(UI, t.id).events.at(-1)!;
    assert.equal(last.actor, 'system');
    assert.match(last.body!, /The bump could not be sent/);
  } finally {
    h.done();
  }
});

test('the session page’s chips: the latest bump of each ticket into the session, newest first', async () => {
  const h = await ticketsHarness();
  try {
    h.sessions.add({ id: 'sa', workspaceId: 'docker/api' });
    h.sessions.add({ id: 'sb', workspaceId: 'docker/api' });
    const one = h.tickets.create(UI, { summary: 'One', workspaceId: 'docker/api' });
    const two = h.tickets.create(UI, { summary: 'Two', workspaceId: 'docker/api' });
    await h.tickets.bump(UI, one.id, { sessionId: 'sa', mode: 'ask' });
    await h.tickets.bump(UI, two.id, { sessionId: 'sb', mode: 'ask' });
    await h.tickets.bump(UI, two.id, { sessionId: 'sa', mode: 'ask' });
    await h.tickets.bump(UI, one.id, { sessionId: 'sa', mode: 'prioritise' });
    assert.deepEqual(h.tickets.bumpedInto(UI, 'sa').map((b) => [b.ticketId, b.mode, b.status]), [['T-1', 'prioritise', 'in_progress'], ['T-2', 'ask', 'open']]);
    assert.deepEqual(h.tickets.bumpedInto(UI, 'sb').map((b) => b.ticketId), ['T-2']);
    assert.deepEqual(h.tickets.bumpedInto(UI, 'nobody'), []);
  } finally {
    h.done();
  }
});

test('the real adapter sends a bump from ticket:<id> with its label and the queue priority', async () => {
  const calls: unknown[][] = [];
  const chat = { send: async (...args: unknown[]) => void calls.push(args) } as unknown as ChatController;
  await new ChatTicketSessions(chat).send('sa', 'T-4', 'text', 'T-4', { priority: 'next' });
  await new ChatTicketSessions(chat).send('sa', 'T-4', 'opening', 'T-4');
  assert.equal(calls[0]![0], 'sa');
  assert.equal(calls[0]![2], 'text');
  assert.deepEqual(calls[0]![3], { actor: 'ticket:T-4', actorLabel: 'T-4', priority: 'next' });
  assert.deepEqual(calls[1]![3], { actor: 'ticket:T-4', actorLabel: 'T-4' }, 'Start session keeps its plain send');
});

/* ---------- The routes, behind the seam ---------- */

function routes(tickets: Tickets, actor?: Actor) {
  const a = new Hono<{ Variables: { token: string; actor: Actor } }>();
  a.use(async (c, next) => {
    if (actor) c.set('actor', actor);
    else c.set('token', 'signed-in');
    await next();
  });
  a.onError((e, c) => (isAppError(e) ? c.json({ error: { code: e.code, message: e.message } }, e.status as 400) : c.json({ error: { code: 'INTERNAL', message: String(e) } }, 500)));
  a.route('/api/tickets', createTicketRoutes(tickets));
  return a;
}
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('routes: declared, operate on the ticket and on the session; another person’s session is the same 404 as a missing one', async () => {
  const h = await ticketsHarness();
  try {
    h.sessions.add({ id: 'mine', workspaceId: 'docker/api', title: 'Mine' });
    h.sessions.add({ id: 'theirs', workspaceId: 'docker/api', title: 'Theirs' });
    registerResolver({ type: 'session', resolve: (id) => (h.sessions.get(id) ? { ref: sessionRef(id), owner: { kind: 'user', id: id === 'theirs' ? 'u_alice' : FOUNDING_USER_ID } } : null) });
    const t = h.tickets.create(UI, { summary: 'Work', workspaceId: 'docker/api' });
    const app = routes(h.tickets);

    for (const key of Object.keys(TICKET_BUMP_POLICIES)) assert.ok(declaredPolicies().has(key), key);
    const list = (await (await app.request(TICKET_API.bump(t.id))).json()) as { data: { id: string }[] };
    assert.deepEqual(list.data.map((x) => x.id), ['mine'], 'the picker lists only what the person may operate');

    const theirs = await app.request(TICKET_API.bump(t.id), post({ sessionId: 'theirs', mode: 'ask' }));
    assert.equal(theirs.status, 404);
    const missing = await app.request(TICKET_API.bump(t.id), post({ sessionId: 'gone', mode: 'ask' }));
    assert.equal(missing.status, 404);
    assert.equal(h.sessions.sent.length, 0);

    const ok = await app.request(TICKET_API.bump(t.id), post({ sessionId: 'mine', mode: 'prioritise', note: 'now' }));
    assert.equal(ok.status, 201);
    assert.equal(((await ok.json()) as { data: { ticket: { status: string } } }).data.ticket.status, 'in_progress');
    const bumped = (await (await app.request(TICKET_API.bumped('mine'))).json()) as { data: { ticketId: string }[] };
    assert.deepEqual(bumped.data.map((b) => b.ticketId), ['T-1']);
    assert.equal((await app.request(TICKET_API.bumped('theirs'))).status, 404);

    const anon = routes(h.tickets, { kind: 'anonymous' });
    assert.equal((await anon.request(TICKET_API.bump(t.id), post({ sessionId: 'mine', mode: 'ask' }))).status, 401);
  } finally {
    h.done();
  }
});

/* ---------- The Portal MCP tool ---------- */

test('ticket_bump: listed with session control, operate scope, lists the sessions, previews and asks for confirmation, then bumps once', async () => {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const sessions = new FakeSessions();
  const tickets = new Tickets(h.store, sessions);
  tickets.start();
  registerTicketTools(tickets, registry);
  try {
    assert.ok(declaredToolPolicies().has('ticket_bump'));
    assert.deepEqual(declaredToolPolicies().get('ticket_bump'), TICKET_BUMP_TOOL_POLICIES.ticket_bump);
    sessions.add({ id: 'sa', workspaceId: 'docker/api', title: 'Alpha' });
    sessions.add({ id: 'sw', workspaceId: 'docker/api', title: 'Waits', state: 'waiting' });
    const t = tickets.create(UI, { summary: 'Fix it', workspaceId: 'docker/api' });
    const read = h.token('read');
    const op = h.token('operate');
    const listed = async (secret: string) => ((await h.rpc(secret, 'tools/list')).body.result.tools as { name: string }[]).some((x) => x.name === 'ticket_bump');
    assert.equal(await listed(op.secret), false, 'only while session control is on');
    h.module.settings.update({ sessionControl: true });
    assert.equal(await listed(op.secret), true);
    const err = (r: Awaited<ReturnType<typeof h.call>>) => r.result?.structuredContent?.error?.code as string | undefined;
    assert.equal(err(await h.call(read.secret, 'ticket_bump', { id: t.id, session_id: 'sa' })), 'SCOPE_REQUIRED');

    const offered = (await h.call(op.secret, 'ticket_bump', { id: t.id })).result!.structuredContent;
    assert.deepEqual(offered.sessions.map((x: { id: string; can_bump: boolean; why_not: string | null }) => [x.id, x.can_bump, x.why_not]), [['sa', true, null], ['sw', false, 'Waiting on an approval']]);
    assert.deepEqual(offered.sessions[0].title, { untrusted_text: 'Alpha', source: 'agent' });

    const ask = (await h.call(op.secret, 'ticket_bump', { id: t.id, session_id: 'sa', mode: 'ask', note: 'quick one' })).result!.structuredContent;
    assert.equal(ask.status, 'confirmation_required');
    assert.deepEqual([ask.preview.session, ask.preview.mode, ask.preview.priority, ask.preview.note], ['sa', 'ask', 'later', 'quick one']);
    assert.equal(sessions.sent.length, 0, 'asking sends nothing');
    const done = (await h.call(op.secret, 'ticket_bump', { id: t.id, session_id: 'sa', mode: 'ask', note: 'quick one', confirm_token: ask.confirm_token })).result!.structuredContent;
    assert.equal(done.mode, 'ask');
    assert.equal(sessions.sent.length, 1);
    assert.equal(sessions.sent[0]!.priority, 'later');
    const again = (await h.call(op.secret, 'ticket_bump', { id: t.id, session_id: 'sa', mode: 'ask', note: 'quick one', confirm_token: ask.confirm_token })).result!.structuredContent;
    assert.equal(again.status, 'confirmation_required', 'a token is used once');

    // A refusal comes back as a tool error, and the call is in the audit trail with its token.
    const w = (await h.call(op.secret, 'ticket_bump', { id: t.id, session_id: 'sw', mode: 'prioritise' })).result!.structuredContent;
    assert.equal(err(await h.call(op.secret, 'ticket_bump', { id: t.id, session_id: 'sw', mode: 'prioritise', confirm_token: w.confirm_token })), 'CONFLICT');
    const audited = h.module.audit.list({ limit: 50 }).filter((x) => x.tool === 'ticket_bump');
    assert.ok(audited.length >= 4 && audited.every((x) => x.actor === `portal-mcp:${op.id}` || x.actor === `portal-mcp:${read.id}`), JSON.stringify(audited.map((x) => [x.actor, x.outcome])));

    // Agents never get it.
    const a = await h.agentToken('docker/api', 'sa');
    assert.equal(await listed(a.secret), false);
  } finally {
    tickets.stop();
    h.done();
  }
});
