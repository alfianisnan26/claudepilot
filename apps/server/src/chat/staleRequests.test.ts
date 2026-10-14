// T-284: a request raised by a process that is no longer the live one (a move, a restart, a crash, a resume) can never be answered. It is
// resolved `stale` by itself (a new process's launch, the liveness round), a Restart drops it instead of refusing (and refuses only for a
// request of the live process), and a route and the Portal MCP tool `session_request_clear` clear it explicitly, audited. Fixtures are
// built at runtime; the ids and the process labels are made up.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { Hono } from 'hono';
import { clearResolvers, declaredPolicies, declaredToolPolicies } from '../authz/seam.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { registerChatAuthz } from './authz.js';
import { registerChatTools } from './portalTools.js';
import { createChatRoutes } from './routes.js';
import { ChatStore } from './store.js';
import { firstTurn, line, liveSession, until, type Live } from './testkit.js';

afterEach(() => clearResolvers());

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (isAppError(e) ? e.code : String(e)));
const ask = (requestId: string) =>
  line({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: `toolu_${requestId}` } });
const outcome = (s: Live, requestId: string) => new ChatStore(s.store).requestOutcome(s.id, requestId);
const staleAudits = (s: Live) => s.controller.audit({ kind: 'session.request_stale' }).map((a) => a.detail as { why: string; requestIds: string[] });

/** An open request recorded for `proc` (an earlier process's), or with no process at all (a row from before migration 830) read at `at`. */
function oldRequest(s: Live, requestId: string, o: { proc?: string | null; at?: string } = {}) {
  new ChatStore(s.store).addRequest(s.id, { requestId, kind: 'tool', toolName: 'Bash', agentLabel: null, title: 'Run a command', detail: 'ls', createdAt: '' }, o.proc === undefined ? 'an-earlier-process/0/' : o.proc);
  if (o.at) s.store.db!.prepare('UPDATE chat_requests SET created_at = ? WHERE session_id = ? AND request_id = ?').run(o.at, s.id, requestId);
}

test('a request records the process that raised it; the liveness round resolves the ones of another process stale and keeps the live one’s', async () => {
  const s = await liveSession({ livenessMs: 40 });
  try {
    await firstTurn(s);
    s.tail.push(ask('R-live'));
    await until(() => s.state() === 'waiting');
    const proc = (s.store.db!.prepare("SELECT proc FROM chat_requests WHERE request_id = 'R-live'").get() as { proc: string | null }).proc;
    assert.ok(proc && proc.startsWith(`${s.controller.get(s.id)!.claudeSessionId}/`), 'the live process’s controlProc, ids only');
    oldRequest(s, 'R-other'); // another process's
    oldRequest(s, 'R-legacy', { proc: null, at: '2026-10-10T11:59:00.000Z' }); // before migration 830, read before this process started (the fake host's start)
    oldRequest(s, 'R-legacy-live', { proc: null, at: '2026-10-10T12:00:00.500Z' }); // the same second as the start: never judged stale by the rounding
    await until(() => outcome(s, 'R-other') === 'stale' && outcome(s, 'R-legacy') === 'stale');
    assert.equal(outcome(s, 'R-live'), null, 'the live process’s request stays open');
    assert.equal(outcome(s, 'R-legacy-live'), null);
    assert.equal(s.state(), 'waiting', 'it still waits on its own request');
    assert.ok(s.controller.history(s.id).some((e) => e.kind === 'resolved' && e.requestId === 'R-other' && e.outcome === 'stale'), 'the transcript shows it resolved');
    const audit = staleAudits(s);
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0]!.why, [...audit[0]!.requestIds].sort()], ['sweep', ['R-legacy', 'R-other']]);
    assert.doesNotMatch(JSON.stringify(s.controller.audit({ kind: 'session.request_stale' })), /Run a command|"ls"/, 'never the request’s text');
  } finally {
    await s.done();
  }
});

test('the chat leaves waiting when its only request was of a process that is gone', async () => {
  const s = await liveSession({ livenessMs: 40 });
  try {
    await firstTurn(s);
    oldRequest(s, 'R-old');
    s.store.db!.prepare("UPDATE chat_sessions SET state = 'waiting' WHERE id = ?").run(s.id);
    await until(() => outcome(s, 'R-old') === 'stale');
    await until(() => s.state() === 'idle');
    assert.equal(s.controller.get(s.id)!.waiting, 0);
  } finally {
    await s.done();
  }
});

test('a new process (here a resume) resolves what an earlier one left open as stale, at its launch', async () => {
  const s = await liveSession();
  try {
    await firstTurn(s);
    // The process went away without the portal closing it out (the row lost track): a request is still open.
    s.store.db!.prepare("UPDATE chat_sessions SET process = 'gone', state = 'interrupted' WHERE id = ?").run(s.id);
    oldRequest(s, 'R-left', { proc: null });
    const tails = s.ws.tails.length;
    await s.controller.control(s.id, 'resume');
    await until(() => s.ws.tails.length > tails);
    assert.equal(outcome(s, 'R-left'), 'stale');
    assert.deepEqual(staleAudits(s).map((a) => a.why), ['launch']);
    assert.equal(s.controller.get(s.id)!.waiting, 0);
  } finally {
    await s.done();
  }
});

test('Restart drops stale requests instead of refusing; a request of the live process still refuses it; a process the host says is gone does not', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    await firstTurn(s);
    // 1. A stale request (another process's) never blocks it: dropped, audited, then the restart runs.
    oldRequest(s, 'R-stale');
    const starts = s.ws.starts;
    await s.answering(s.controller.restart(s.id));
    assert.equal(s.ws.starts, starts + 1, 'restarted');
    assert.equal(outcome(s, 'R-stale'), 'stale');
    assert.deepEqual(staleAudits(s).map((a) => a.why), ['restart']);

    // 2. A request of the live process (the host says it runs): refused, as before, and the request stays open.
    s.tail = s.ws.tails.at(-1)!;
    s.tail.push(ask('R-live'));
    await until(() => s.controller.get(s.id)!.waiting === 1);
    assert.equal(await code(s.controller.restart(s.id)), 'CONFLICT');
    assert.equal(outcome(s, 'R-live'), null);

    // 3. The same request when the host says that process is gone (it crashed; the row did not know yet): resolved stale, then restarted.
    s.ws.status.set(s.controller.get(s.id)!.claudeSessionId, false);
    const before = s.ws.starts;
    await s.answering(s.controller.restart(s.id));
    s.ws.status.clear();
    assert.equal(s.ws.starts, before + 1, 'restarted');
    assert.equal(outcome(s, 'R-live'), 'stale');
    assert.deepEqual(staleAudits(s).map((a) => a.why).sort(), ['gone', 'restart']);
    assert.notEqual(s.controller.get(s.id)!.state, 'waiting');
  } finally {
    await s.done();
  }
});

test('the clear route: operate on the session (another user: the same 404); a stale request is cleared and audited; the live process’s is refused', async () => {
  const s = await liveSession();
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    assert.deepEqual(declaredPolicies().get('POST /api/chat/sessions/:id/requests/:requestId/clear'), {
      kind: 'objects',
      checks: [{ type: 'session', verb: 'operate', from: 'path', param: 'id' }],
      audit: 'session.request_clear',
    });
    const app = (actor: unknown) => {
      const a = new Hono();
      a.onError((e, c) => {
        const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
        return c.json(err.toJSON(), err.status as 404);
      });
      a.use(async (c, next) => {
        if (actor === 'owner') (c as unknown as { set(k: string, v: unknown): void }).set('token', 'signed-in');
        else if (actor) (c as unknown as { set(k: string, v: unknown): void }).set('actor', actor);
        await next();
      });
      a.route('/', createChatRoutes(s.controller));
      return a;
    };
    const post = (who: unknown, requestId: string) => app(who).request(`/${s.id}/requests/${requestId}/clear`, { method: 'POST' });
    await firstTurn(s);
    s.tail.push(ask('R-live'));
    await until(() => s.state() === 'waiting');
    oldRequest(s, 'R-stale');

    assert.equal((await post({ kind: 'user', userId: 'u_a', loginSessionId: 'l1', via: 'ui' }, 'R-stale')).status, 404, 'another user: the same 404');
    assert.equal(outcome(s, 'R-stale'), null, 'a denial changes nothing');
    assert.equal((await post('owner', 'R-nothing')).status, 404, 'an id the session never had');
    const live = await post('owner', 'R-live');
    assert.equal(live.status, 409, 'a request of the live process is answered, never cleared');
    assert.equal(outcome(s, 'R-live'), null);

    const res = await post('owner', 'R-stale');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { requestId: string; outcome: string } };
    assert.deepEqual([body.data.requestId, body.data.outcome], ['R-stale', 'stale']);
    assert.deepEqual(
      s.controller.audit({ kind: 'session.request_stale' }).map((a) => [a.actor, (a.detail as { why: string }).why, (a.detail as { requestIds: string[] }).requestIds]),
      [['ui', 'clear', ['R-stale']]],
    );
    assert.equal((await post('owner', 'R-stale')).status, 409, 'no longer open');
    assert.equal(s.state(), 'waiting', 'still waits on the live request');
  } finally {
    await s.done();
  }
});

test('session_request_clear over MCP: an agent of the workspace clears a stale request; another workspace’s agent gets not found; the live process’s is refused', async () => {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const s = await liveSession();
  try {
    registerChatTools(s.controller, registry);
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    assert.deepEqual(declaredToolPolicies().get('session_request_clear'), { kind: 'agent', reach: 'workspace', audit: 'session.request_clear' });
    await firstTurn(s);
    const asker = await s.controller.create({ workspaceId: 'docker/ws1', title: 'Asker' });
    await until(() => s.ws.tails.length === 2);
    const mine = await h.agentToken('docker/ws1', asker.id);
    const other = await h.agentToken('docker/ws2', 'sess-elsewhere');
    s.ws.tails[0]!.push(ask('R-live'));
    await until(() => s.state() === 'waiting');
    oldRequest(s, 'R-stale');

    const far = await h.call(other.secret, 'session_request_clear', { session_id: s.id, request_id: 'R-stale' });
    assert.equal(far.result?.structuredContent.error.code, 'NOT_FOUND', JSON.stringify(far.raw));
    assert.equal(outcome(s, 'R-stale'), null, 'a denial changes nothing');
    const live = await h.call(mine.secret, 'session_request_clear', { session_id: s.id, request_id: 'R-live' });
    assert.equal(live.result?.structuredContent.error.code, 'CONFLICT', JSON.stringify(live.raw));
    assert.equal(outcome(s, 'R-live'), null);

    const done = await h.call(mine.secret, 'session_request_clear', { session_id: s.id, request_id: 'R-stale' });
    assert.equal(done.result?.isError, undefined, JSON.stringify(done.raw));
    assert.equal(done.result!.structuredContent.outcome, 'stale');
    assert.equal(outcome(s, 'R-stale'), 'stale');
    assert.deepEqual(s.controller.audit({ kind: 'session.request_stale' }).map((a) => a.actor), [`session:${asker.id}`]);
  } finally {
    h.done();
    await s.done();
  }
});
