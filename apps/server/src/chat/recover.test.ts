// T-136 slice 2 (D-30): a session ended for integrity is recovered IN PLACE from its tape: the same row (id, title, pin, ticket, parent,
// cost series), its conversation resumed with `--resume` on a fresh log segment (the line that ended it is never read again), Bypass only
// through the restart's grant, a trail entry and the short continuation. Refused for a person's close, a suspicious cause for an agent
// (and for a person who did not confirm), past the day's cap (one watchdog ticket) and within the pause. Fixtures are built at runtime.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { CHAT_RECOVER_CAPPED, CHAT_RECOVER_CONFIRM, CHAT_RECOVER_PAUSED, CHAT_RECOVER_SUSPICIOUS } from '@portal/contracts';
import { Hono } from 'hono';
import { clearResolvers, declaredPolicies, declaredToolPolicies } from '../authz/seam.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { registerChatAuthz } from './authz.js';
import { ENDING_CASES, readEnding } from './integrity.js';
import { registerChatTools } from './portalTools.js';
import { readRecoverConfig, recoverContinuation } from './recover.js';
import { createChatRoutes } from './routes.js';
import { APPLIED, fail, firstTurn, init, line, liveSession, ok, sleep, until, type Live } from './testkit.js';

afterEach(() => clearResolvers());

const FLAG = '--allow-dangerously-skip-permissions';
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (isAppError(e) ? e.code : String(e)));
const result = (sessionId: string, cost: number) =>
  line({ type: 'result', subtype: 'success', total_cost_usd: cost, duration_ms: 10, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false, session_id: sessionId });
const taskStarted = (session: string, taskId: string) =>
  line({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: `toolu_${taskId}`, description: 'a slice', subagent_type: 'general-purpose', is_backgrounded: true, task_type: 'local_agent', uuid: randomUUID(), session_id: session });
/** A replayed user line the portal did not send, with an origin of the given kind (and for `peer`, its sender). */
const replayed = (session: string, origin: Record<string, unknown>) =>
  line({ type: 'user', message: { role: 'user', content: 'text the portal never sent' }, session_id: session, parent_tool_use_id: null, uuid: randomUUID(), isReplay: true, isSynthetic: true, origin });
const csidOf = (s: Live, id: string) => s.controller.get(id)!.claudeSessionId;
const lastStart = (s: Live) => s.ws.startArgs.at(-1)!;

function controlsOf(s: Live) {
  return s.ws.sends.flatMap((x) => {
    try {
      const o = JSON.parse(x.line) as { type?: string; request_id?: string; request?: Record<string, unknown> };
      return o.type === 'control_request' && o.request_id && o.request ? [{ id: o.request_id, request: o.request }] : [];
    } catch {
      return [];
    }
  });
}

/** The newest process answers every control request the portal asks (settings, modes, models) until `p` settles. */
async function answered<T>(s: Live, p: Promise<T>, mode: (m: string) => 'ok' | string = () => 'ok'): Promise<T> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  const seen = new Set<string>(controlsOf(s).map((c) => c.id));
  while (!settled) {
    for (const c of controlsOf(s)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const tail = s.ws.tails.at(-1)!;
      if (c.request.subtype === 'get_settings') tail.push(ok(c.id, APPLIED));
      else if (c.request.subtype === 'set_permission_mode') {
        const r = mode(String(c.request.mode));
        tail.push(r === 'ok' ? ok(c.id, { mode: String(c.request.mode) }) : fail(c.id, r));
      } else tail.push(ok(c.id));
    }
    await sleep(5);
  }
  return p;
}

/** The harmless ending: a peer line from a sub-agent that ran in this process, with no SendMessage cause seen (`replay-peer`'s near miss). */
async function endHarmless(s: Live, id = s.id) {
  const tail = s.ws.tails.at(-1)!;
  const task = `t${randomUUID().slice(0, 6)}`;
  tail.push(taskStarted(csidOf(s, id), task));
  await until(() => s.controller.get(id)!.agentsRunning === 1 || s.controller.get(id)!.state === 'ended');
  tail.push(replayed(csidOf(s, id), { kind: 'peer', from: task, senderTaskId: task, name: 'general-purpose', body: 'hello' }));
  await until(() => s.controller.get(id)!.state === 'ended');
}

/** The suspicious ending: a replayed line of an origin Claude Code's harness never uses for it. */
async function endSuspicious(s: Live, id = s.id) {
  s.ws.tails.at(-1)!.push(replayed(csidOf(s, id), { kind: 'channel' }));
  await until(() => s.controller.get(id)!.state === 'ended');
}

function policy(s: Live, allowed: boolean) {
  const state = { allowed };
  s.controller.bypassAllowed = () => state.allowed;
  s.controller.reauth = { fresh: (token) => token === 'tok' };
  return state;
}

/** A bypass-capable session past its first turn, in Bypass. */
async function inBypass(s: Live) {
  const before = s.ws.tails.length;
  const { id } = await s.controller.create({ workspaceId: 'docker/ws1' }, { bypassOptIn: true });
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(id)?.state === 'idle');
  await sleep(20);
  const tail = s.ws.tails.at(-1)!;
  tail.push(init(id));
  tail.push(ok((await s.take('get_settings')).id, APPLIED));
  await until(() => s.controller.get(id)!.effort === 'medium');
  const entering = s.controller.enterBypass(id, { acknowledged: true, sessionToken: 'tok' });
  tail.push(ok((await s.take('set_permission_mode')).id, { mode: 'bypassPermissions' }));
  await entering;
  assert.equal(s.controller.get(id)!.mode, 'bypassPermissions');
  return id;
}

/* ---------- Pure: the classification and the settings ---------- */

test('readEnding: a stored record wins; a legacy reason is classified from its text (only the pre-T-265 duplicate is harmless); others are not integrity', () => {
  assert.equal(readEnding('closed by operator', null), null);
  assert.equal(readEnding('credential: x', '{"case":"replay-peer"}'), null);
  assert.deepEqual(readEnding('integrity: anything', JSON.stringify({ case: 'replay-peer', classified: 'suspicious', origin: 'a sub-agent of this process', bypass: true })), {
    case: 'replay-peer',
    classified: 'harmless', // the table decides, never the stored word
    origin: 'a sub-agent of this process',
    bypass: true,
  });
  assert.equal(readEnding('integrity: a second control response for request 375d24ec', null)!.classified, 'harmless');
  assert.equal(readEnding('integrity: a second, different control response for request 375d24ec', null)!.classified, 'suspicious');
  assert.equal(readEnding("integrity: a message this portal didn't send reached Claude Code (abc, origin peer)", null)!.classified, 'suspicious');
  assert.equal(readEnding('integrity: something new', 'not json')!.case, 'unknown');
  for (const [id, c] of Object.entries(ENDING_CASES)) assert.ok(c.classified === 'harmless' ? ['replay-peer', 'control-duplicate'].includes(id) : true, `${id} harmless only by evidence`);
  assert.deepEqual(readRecoverConfig(undefined), { maxPerDay: 4, pauseMs: 120_000 });
  assert.deepEqual(readRecoverConfig((k) => (k === 'chat.recover.maxPerDay' ? 99 : 'x')), { maxPerDay: 24, pauseMs: 120_000 });
  const text = recoverContinuation('a reason');
  assert.ok(text.length < 400, 'the continuation is short');
  assert.match(text, /recovered in place/);
});

/* ---------- Recover in place ---------- */

test('recover keeps the row: same id, title, pin, ticket, parent, created_at and one continuous cost series; resumed on a fresh segment; the line is dropped; trail, continuation, audit', async () => {
  const s = await liveSession();
  try {
    await firstTurn(s);
    s.tail.push(result(csidOf(s, s.id), 0.5));
    await until(() => s.controller.get(s.id)!.costUsd > 0);
    s.controller.rename(s.id, 'Orchestrator: dev', { actor: 'ui' });
    s.controller.pin(s.id);
    s.controller.setTicket(s.id, 'T-1');
    const before = s.controller.get(s.id)!;
    const rows = s.controller.list().length;
    const seg = Number(lastStart(s)[2]);
    await endHarmless(s);
    const ended = s.controller.get(s.id)!;
    assert.deepEqual(ended.endedFor, { reason: ended.endedReason!.slice('integrity: '.length), classified: 'harmless', case: 'replay-peer', origin: 'a sub-agent of this process' });
    const oldTail = s.ws.tails.at(-1)!;
    const back = await answered(s, s.controller.recover(s.id));
    assert.equal(back.id, before.id);
    assert.equal(s.controller.list().length, rows, 'no new row');
    assert.deepEqual([back.title, back.pinnedAt, back.ticketId, back.parentId, back.createdAt, back.claudeId, back.claudeSessionId], [before.title, before.pinnedAt, before.ticketId, before.parentId, before.createdAt, before.claudeId, before.claudeSessionId]);
    assert.notEqual(back.state, 'ended');
    assert.equal(back.endedFor, null);
    const args = lastStart(s);
    assert.ok(args.includes('--resume') && args.includes(before.claudeSessionId), 'the same conversation');
    assert.ok(Number(args[2]) > seg, 'a fresh log segment: the old one (and the line) is not followed again');
    assert.notEqual(s.ws.tails.at(-1), oldTail);
    const history = s.controller.history(s.id);
    const marker = history.find((e) => e.kind === 'system' && e.recovered === true)!;
    assert.match(marker.text ?? '', /^Recovered in place after an integrity ending: a message this portal didn't send reached Claude Code/);
    assert.ok(history.some((e) => e.kind === 'system' && /^The line that ended it was dropped: it isn’t read again \(harmless, a sub-agent of this process\)\.$/.test(e.text ?? '')));
    assert.ok(!history.some((e) => e.text === 'text the portal never sent'), 'the line itself is never stored');
    await until(() => s.ws.sends.some((x) => x.line.includes('recovered in place')));
    const cont = s.controller.history(s.id).findLast((e) => e.kind === 'user')!;
    assert.equal(cont.actor, 'portal:recover');
    // The cost series goes on from where it was: nothing was reset by the recovery, and the resumed process's running total (the same
    // Claude Code session, as on a wake) carries on in the same row.
    assert.equal(s.controller.get(s.id)!.costUsd, before.costUsd);
    s.ws.tails.at(-1)!.push(init(csidOf(s, s.id)));
    s.ws.tails.at(-1)!.push(result(csidOf(s, s.id), 0.75));
    await until(() => s.controller.get(s.id)!.costUsd > 0.5);
    assert.ok(Math.abs(s.controller.get(s.id)!.costUsd - 0.75) < 1e-9, String(s.controller.get(s.id)!.costUsd));
    const done = s.controller.audit({ kind: 'session.recover.done' });
    assert.deepEqual([done.length, done[0]!.actor, done[0]!.detail.by, done[0]!.detail.case, done[0]!.detail.bypass], [1, 'ui', 'person', 'replay-peer', 'none']);
    // No sign-in code anywhere on this path: the start never carried one.
    assert.ok(!s.ws.startArgs.flat().some((a) => /code/i.test(a)));
  } finally {
    await s.done();
  }
});

test('recover refuses: a session a person closed (409 closed), a live one, one that ended otherwise; and every refusal is on the record', async () => {
  const s = await liveSession();
  try {
    await firstTurn(s);
    assert.equal(await codeOf(s.controller.recover(s.id)), 'CONFLICT', 'not ended');
    await s.controller.end(s.id);
    const e = await s.controller.recover(s.id).catch((x: unknown) => x as AppError);
    assert.ok(isAppError(e));
    assert.deepEqual([e.code, (e.details as { recover?: string }).recover], ['CONFLICT', 'closed']);
    assert.equal(s.controller.get(s.id)!.state, 'ended');
    assert.equal(s.controller.audit({ kind: 'session.recover.refused' }).length, 2);
    assert.equal(await codeOf(s.controller.recover('nope')), 'NOT_FOUND');
    // An archived one is unarchived first (it would come back hidden).
    const t = await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.ws.tails.length === 2);
    await until(() => s.controller.get(t.id)?.state === 'idle');
    await sleep(20);
    s.ws.tails.at(-1)!.push(replayed(csidOf(s, t.id), { kind: 'channel' }));
    await until(() => s.controller.get(t.id)!.state === 'ended');
    await s.controller.archive(t.id);
    const archived = await s.controller.recover(t.id, { confirm: true }).catch((x: unknown) => x as AppError);
    assert.deepEqual([isAppError(archived) && archived.code, (archived as AppError).details], ['CONFLICT', { recover: 'archived' }]);
  } finally {
    await s.done();
  }
});

test('a suspicious cause: an agent is refused (403, with the classification); a person must confirm (409), then it comes back', async () => {
  const s = await liveSession();
  try {
    await firstTurn(s);
    await endSuspicious(s);
    assert.deepEqual(s.controller.get(s.id)!.endedFor, {
      reason: s.controller.get(s.id)!.endedReason!.slice('integrity: '.length),
      classified: 'suspicious',
      case: 'replay-unknown',
      origin: 'unknown origin: channel',
    });
    const agent = await s.controller.recover(s.id, { by: 'agent', actor: 'session:x' }).catch((x: unknown) => x as AppError);
    assert.ok(isAppError(agent));
    assert.deepEqual([agent.code, agent.status, (agent.details as { classified: string }).classified, (agent.details as { origin: string }).origin], [CHAT_RECOVER_SUSPICIOUS, 403, 'suspicious', 'unknown origin: channel']);
    assert.equal(await codeOf(s.controller.recover(s.id, { by: 'agent', confirm: true })), CHAT_RECOVER_SUSPICIOUS, 'an agent’s confirm counts for nothing');
    assert.equal(await codeOf(s.controller.recover(s.id)), CHAT_RECOVER_CONFIRM);
    assert.equal(s.controller.get(s.id)!.state, 'ended', 'nothing changed');
    const back = await answered(s, s.controller.recover(s.id, { confirm: true }));
    assert.notEqual(back.state, 'ended');
    assert.equal(s.controller.audit({ kind: 'session.recover.done' })[0]!.detail.confirmed, true);
  } finally {
    await s.done();
  }
});

test('the caps: a pause between recoveries, at most maxPerDay a day; past it ONE watchdog ticket, and it stays ended', async () => {
  let now = Date.now();
  const s = await liveSession({ clock: () => now });
  try {
    s.controller.recoverSettings = (k) => (k === 'chat.recover.maxPerDay' ? 2 : k === 'chat.recover.pauseMin' ? 2 : undefined);
    const tickets: unknown[] = [];
    s.controller.onRecoverCapped = (i) => tickets.push(i);
    await firstTurn(s);
    await endHarmless(s);
    await answered(s, s.controller.recover(s.id));
    await endHarmless(s);
    const paused = await s.controller.recover(s.id).catch((x: unknown) => x as AppError);
    assert.ok(isAppError(paused));
    assert.equal(paused.code, CHAT_RECOVER_PAUSED);
    assert.ok((paused.details as { retryAfterS: number }).retryAfterS > 0);
    now += 3 * 60_000;
    await answered(s, s.controller.recover(s.id));
    await endHarmless(s);
    now += 3 * 60_000;
    assert.equal(await codeOf(s.controller.recover(s.id)), CHAT_RECOVER_CAPPED);
    assert.equal(await codeOf(s.controller.recover(s.id, { by: 'agent' })), CHAT_RECOVER_CAPPED);
    assert.equal(tickets.length, 1, 'one ticket, not one per try');
    assert.deepEqual(Object.keys(tickets[0] as object).sort(), ['case', 'classified', 'count', 'max', 'reason', 'sessionId', 'workspaceId']);
    assert.equal(s.controller.get(s.id)!.state, 'ended');
    assert.equal(s.controller.audit({ kind: 'session.recover.capped' }).length, 1);
    // A day later the window has moved on.
    now += 25 * 60 * 60_000;
    await answered(s, s.controller.recover(s.id));
    assert.notEqual(s.controller.get(s.id)!.state, 'ended');
  } finally {
    await s.done();
  }
});

test('Bypass after a recovery: kept through the grant while the policy allows it (relaunched with the flag), else the start mode and the marker says why', async () => {
  for (const allowed of [true, false]) {
    const s = await liveSession();
    try {
      s.controller.controlTimeoutMs = 150;
      const state = policy(s, true);
      const id = await inBypass(s);
      await endSuspicious(s, id);
      assert.equal(s.controller.get(id)!.mode, 'default', 'an ended session shows no Bypass');
      state.allowed = allowed;
      const back = await answered(s, s.controller.recover(id, { confirm: true }));
      const notes = s.controller.history(id).filter((e) => e.kind === 'system').map((e) => e.text);
      if (allowed) {
        assert.ok(lastStart(s).includes(FLAG));
        assert.equal(back.mode, 'bypassPermissions');
        assert.ok(notes.includes('Bypass kept after the recovery.'));
        assert.deepEqual(s.controller.audit({ kind: 'bypass.entered' })[0]!.detail.how, 'recover');
        assert.equal(s.controller.audit({ kind: 'session.recover.done' })[0]!.detail.bypass, 'kept');
      } else {
        assert.ok(!lastStart(s).includes(FLAG));
        assert.equal(back.mode, 'default');
        assert.ok(notes.includes('Bypass not kept after the recovery: the policy no longer allows it.'));
        assert.equal(s.controller.audit({ kind: 'session.recover.done' })[0]!.detail.bypass, 'dropped');
      }
    } finally {
      await s.done();
    }
  }
});

test('the route: operate on the session (another user: 404); a person’s sign-in with by:agent is an agent; only a person’s confirm counts', async () => {
  const s = await liveSession();
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    assert.deepEqual(declaredPolicies().get('POST /api/chat/sessions/:id/recover')?.kind, 'objects');
    assert.deepEqual(declaredToolPolicies().get('session_recover'), { kind: 'agent', reach: 'workspace', confirm: true, audit: 'session.recover' });
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
    await firstTurn(s);
    await endSuspicious(s);
    const post = (who: unknown, body: unknown) => app(who).request(`/${s.id}/recover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ kind: 'user', userId: 'u_a', loginSessionId: 'l1', via: 'ui' }, {})).status, 404, 'another user: the same 404');
    const asAgent = await post('owner', { by: 'agent', confirm: true });
    assert.equal(asAgent.status, 403);
    assert.equal(((await asAgent.json()) as { error: { code: string } }).error.code, CHAT_RECOVER_SUSPICIOUS);
    assert.equal((await post('owner', {})).status, 409);
    const ok2 = answered(s, Promise.resolve(post('owner', { confirm: true })));
    assert.equal((await ok2).status, 200);
    assert.notEqual(s.controller.get(s.id)!.state, 'ended');
  } finally {
    await s.done();
  }
});

/* ---------- Portal MCP session_recover ---------- */

test('session_recover over MCP: confirmation first for an agent; the same rules; a suspicious cause refused before any confirmation; another workspace’s agent gets not found', async () => {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const s = await liveSession();
  try {
    registerChatTools(s.controller, registry);
    await firstTurn(s);
    // The orchestrator-like session that asks, in the same workspace, and one in another workspace.
    const asker = await s.controller.create({ workspaceId: 'docker/ws1', title: 'Asker' });
    await until(() => s.ws.tails.length === 2);
    const mine = await h.agentToken('docker/ws1', asker.id);
    const other = await h.agentToken('docker/ws2', 'sess-elsewhere');
    // The target's reader is the first tail: end it there.
    s.ws.tails[0]!.push(taskStarted(csidOf(s, s.id), 'tk1'));
    await until(() => s.controller.get(s.id)!.agentsRunning === 1);
    s.ws.tails[0]!.push(replayed(csidOf(s, s.id), { kind: 'peer', from: 'tk1', senderTaskId: 'tk1', name: 'general-purpose', body: 'x' }));
    await until(() => s.controller.get(s.id)!.state === 'ended');

    const far = await h.call(other.secret, 'session_recover', { session_id: s.id });
    assert.equal(far.result?.structuredContent.error.code, 'NOT_FOUND', JSON.stringify(far.raw));
    const first = await h.call(mine.secret, 'session_recover', { session_id: s.id });
    assert.equal(first.result?.structuredContent.status, 'confirmation_required', JSON.stringify(first.raw));
    assert.deepEqual(first.result!.structuredContent.preview.ended_for.classified, 'harmless');
    assert.equal(s.controller.get(s.id)!.state, 'ended', 'nothing happens without the confirmation');
    const token = first.result!.structuredContent.confirm_token as string;
    const going = h.call(mine.secret, 'session_recover', { session_id: s.id, confirm_token: token });
    const done = await answered(s, going);
    assert.equal(done.result?.isError, undefined, JSON.stringify(done.raw));
    assert.notEqual(s.controller.get(s.id)!.state, 'ended');
    assert.deepEqual([s.controller.audit({ kind: 'session.recover.done' })[0]!.actor, s.controller.audit({ kind: 'session.recover.done' })[0]!.detail.by], [`session:${asker.id}`, 'agent']);

    // Ended again, suspiciously: refused at once, with no confirmation offered.
    await endSuspicious(s);
    const sus = await h.call(mine.secret, 'session_recover', { session_id: s.id });
    assert.equal(sus.result?.structuredContent.error.code, CHAT_RECOVER_SUSPICIOUS, JSON.stringify(sus.raw));
    assert.equal(sus.result?.structuredContent.status, undefined);
  } finally {
    h.done();
    await s.done();
  }
});

/* ---------- The supervisor ---------- */

test('the supervisor recovers first, as an agent, and starts a new session only when refused (docs/dev-sessions/supervisor.mjs)', () => {
  const src = readFileSync(new URL('../../../../docs/dev-sessions/supervisor.mjs', import.meta.url), 'utf8');
  const one = (prefix: string) => src.split('\n').find((l) => l.startsWith(prefix));
  const bodyLine = one('const recoverBody = ');
  const verdictLine = one('const recoverVerdict = ');
  assert.ok(bodyLine && verdictLine, 'recoverBody and recoverVerdict are one line each');
  const recoverBody = new Function(`${bodyLine}\nreturn recoverBody;`)() as () => unknown;
  assert.deepEqual(recoverBody(), { by: 'agent' }, 'the supervisor is an agent to the portal: never a suspicious cause');
  const verdict = new Function(`${verdictLine}\nreturn recoverVerdict;`)() as (r: { status: number; error?: { code: string } }) => string;
  assert.equal(verdict({ status: 200 }), 'recovered');
  assert.equal(verdict({ status: 409, error: { code: CHAT_RECOVER_PAUSED } }), 'wait');
  assert.equal(verdict({ status: 500, error: { code: 'SERVICE_UNAVAILABLE' } }), 'wait');
  for (const code of ['NOT_FOUND', CHAT_RECOVER_CAPPED, CHAT_RECOVER_SUSPICIOUS, 'CONFLICT']) assert.equal(verdict({ status: code === 'NOT_FOUND' ? 404 : 409, error: { code } }), 'new', code);
  assert.match(src, /api\('POST', `\/api\/chat\/sessions\/\$\{cur\.id\}\/recover`, recoverBody\(\)\)/);
  assert.match(src, /if \(DRY\) \{[^\n]*would recover/, 'a dry run makes no call');
});
