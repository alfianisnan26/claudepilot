// T-294 (chat-sessions PRD FR51, "Limits per session"): how many workers a session may run at once (its own, clamped to the global
// sessions.maxChildren; 0 none) and whether its Claude may start Claude Code sub-agents (off: every start of its process carries
// `--disallowedTools Agent Task`). A worker's limits are never wider than its parent's; a person or an admin token changes them, a session
// never does. What the real CLI does with the flag (2.1.296): docs/prd/evidence/t294-subagents-flag.md.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { Hono } from 'hono';
import { clearResolvers, declaredPolicies } from '../authz/seam.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { effectiveMaxWorkers, spawnProblem, SUBAGENT_TOOLS, workerLimits, type AgentCaps } from './agents.js';
import { registerChatAuthz } from './authz.js';
import { SESSION_CAP } from './caps.js';
import { registerChatTools } from './portalTools.js';
import { createChatRoutes } from './routes.js';
import { APPLIED, init, line, liveSession, ok, sleep, until, USAGE_API_KEY, type Live } from './testkit.js';

afterEach(() => clearResolvers());

const CAPS: AgentCaps = { maxDepth: 2, maxChildren: 3, spawnsPerHour: 50, messagesPerHour: 50 };
const code = (p: Promise<unknown> | (() => unknown)) =>
  (typeof p === 'function' ? Promise.resolve().then(p) : p).then(
    () => 'ok',
    (e: unknown) => (isAppError(e) ? `${e.code}${(e.details as { scope?: string } | undefined)?.scope ? `:${(e.details as { scope: string }).scope}` : ''}` : String(e)),
  );
/** The `--disallowedTools` values of a start's command line, or null without the flag. */
const disallowedOf = (args: string[]): string[] | null => {
  const at = args.indexOf('--disallowedTools');
  if (at < 0) return null;
  const out: string[] = [];
  for (let i = at + 1; i < args.length && !args[i]!.startsWith('-'); i++) out.push(args[i]!);
  return out;
};
const lastStart = (s: Live) => s.ws.startArgs.at(-1)!;
const csidOf = (s: Live, id = s.id) => s.controller.get(id)!.claudeSessionId;
const resultLine = (sessionId: string) =>
  line({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false, session_id: sessionId });

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
async function answered<T>(s: Live, p: Promise<T>): Promise<T> {
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
      else if (c.request.subtype === 'set_permission_mode') tail.push(ok(c.id, { mode: String(c.request.mode) }));
      else tail.push(ok(c.id));
    }
    await sleep(5);
  }
  return p;
}

/** A worker of `parentId`, started as a session asks the controller to (its actor, its parent), with the limits it asks for. */
async function worker(s: Live, parentId: string, limits?: { maxWorkers?: number; subagents?: boolean }) {
  const before = s.ws.startArgs.length;
  const made = await s.controller.create({ workspaceId: 'docker/ws1', title: 'Worker' }, { actor: `session:${parentId}`, parentId, ...(limits ? { limits } : {}) });
  await until(() => s.ws.startArgs.length === before + 1);
  return made;
}

/* ---------- The rules (agents.ts) ---------- */

test('effectiveMaxWorkers: its own limit clamped to the global cap; none is the global cap; no caps installed is its own or none', () => {
  assert.equal(effectiveMaxWorkers(CAPS, null), 3);
  assert.equal(effectiveMaxWorkers(CAPS, undefined), 3);
  assert.equal(effectiveMaxWorkers(CAPS, 1), 1);
  assert.equal(effectiveMaxWorkers(CAPS, 0), 0);
  assert.equal(effectiveMaxWorkers(CAPS, 10), 3, 'above the global cap counts as the cap');
  assert.equal(effectiveMaxWorkers(null, 2), 2);
  assert.equal(effectiveMaxWorkers(null, null), null);
});

test('spawnProblem with a session’s own limit: 0 refuses every spawn; a tighter own limit is named as its own; a wider one is the global cap', () => {
  const kids = (n: number) => Array.from({ length: n }, () => ({ state: 'idle', createdAt: new Date().toISOString() }));
  const scope = (e: AppError | null) => (e ? `${e.code}:${(e.details as { scope: string }).scope}` : null);
  assert.equal(scope(spawnProblem(CAPS, { id: 'p', depth: 0, maxWorkers: 0 }, [])), `${SESSION_CAP}:session_workers`);
  assert.match(spawnProblem(CAPS, { id: 'p', depth: 0, maxWorkers: 0 }, [])!.message, /may not start workers/);
  assert.equal(scope(spawnProblem(null, { id: 'p', depth: 0, maxWorkers: 0 }, [])), `${SESSION_CAP}:session_workers`, 'without global caps too');
  assert.equal(spawnProblem(CAPS, { id: 'p', depth: 0, maxWorkers: 2 }, kids(1)), null);
  assert.equal(scope(spawnProblem(CAPS, { id: 'p', depth: 0, maxWorkers: 2 }, kids(2))), `${SESSION_CAP}:session_workers`);
  assert.equal((spawnProblem(CAPS, { id: 'p', depth: 0, maxWorkers: 2 }, kids(2))!.details as { limit: number }).limit, 2);
  assert.equal(scope(spawnProblem(CAPS, { id: 'p', depth: 0, maxWorkers: 10 }, kids(3))), `${SESSION_CAP}:children`, 'clamped: the global cap refuses');
  assert.equal(scope(spawnProblem(CAPS, { id: 'p', depth: 0, maxWorkers: null }, kids(3))), `${SESSION_CAP}:children`);
  assert.equal(scope(spawnProblem(null, { id: 'p', depth: 0, maxWorkers: 1 }, kids(1))), `${SESSION_CAP}:session_workers`);
  assert.equal(spawnProblem(null, { id: 'p', depth: 5, maxWorkers: null }, kids(30)), null, 'no caps and no own limit: no limits');
});

test('workerLimits: a worker takes its parent’s; it may be narrower, never wider (both fields)', () => {
  assert.deepEqual(workerLimits(CAPS, {}), { maxWorkers: null, subagents: true }, 'today’s behaviour');
  assert.deepEqual(workerLimits(CAPS, { maxWorkers: 2, subagents: false }), { maxWorkers: 2, subagents: false }, 'the parent’s own');
  assert.deepEqual(workerLimits(CAPS, { maxWorkers: 2 }, { maxWorkers: 1, subagents: false }), { maxWorkers: 1, subagents: false });
  assert.deepEqual(workerLimits(CAPS, {}, { maxWorkers: 3 }), { maxWorkers: 3, subagents: true }, 'up to the global cap for a parent on it');
  const refused = (f: () => unknown) => {
    try {
      f();
      return 'ok';
    } catch (e) {
      return isAppError(e) ? `${e.code}:${Object.keys(e.details as object).join()}` : String(e);
    }
  };
  assert.equal(refused(() => workerLimits(CAPS, { maxWorkers: 2 }, { maxWorkers: 3 })), 'VALIDATION_FAILED:max_workers');
  assert.equal(refused(() => workerLimits(CAPS, {}, { maxWorkers: 4 })), 'VALIDATION_FAILED:max_workers', 'the parent’s effective value is the global cap');
  assert.equal(refused(() => workerLimits(CAPS, { maxWorkers: 10 }, { maxWorkers: 4 })), 'VALIDATION_FAILED:max_workers', 'the parent’s own is clamped first');
  assert.equal(refused(() => workerLimits(CAPS, { maxWorkers: 0 }, { maxWorkers: 1 })), 'VALIDATION_FAILED:max_workers');
  assert.equal(refused(() => workerLimits(CAPS, { subagents: false }, { subagents: true })), 'VALIDATION_FAILED:subagents');
  assert.equal(refused(() => workerLimits(CAPS, {}, { maxWorkers: -1 })), 'VALIDATION_FAILED:max_workers');
  assert.equal(refused(() => workerLimits(CAPS, {}, { maxWorkers: 1.5 })), 'VALIDATION_FAILED:max_workers');
});

/* ---------- The controller ---------- */

test('a session’s own limit: 0 refuses every spawn (audited); a change applies at once; above the global cap counts as the cap', async () => {
  const s = await liveSession();
  try {
    s.controller.agentCaps = () => CAPS;
    assert.deepEqual([s.controller.get(s.id)!.maxWorkers, s.controller.get(s.id)!.subagents], [null, true], 'a new session: the global setting, sub-agents on');
    const zero = s.controller.setLimits(s.id, { maxWorkers: 0 }, { actor: 'ui' });
    assert.equal(zero.restartNeeded, false, 'workers apply at once: no restart');
    assert.equal(zero.session.maxWorkers, 0);
    const starts = s.ws.startArgs.length;
    assert.equal(await code(s.controller.create({ workspaceId: 'docker/ws1' }, { actor: `session:${s.id}`, parentId: s.id })), `${SESSION_CAP}:session_workers`);
    assert.equal(s.ws.startArgs.length, starts, 'nothing started');
    assert.equal(s.controller.children(s.id).length, 0, 'nothing made');
    assert.deepEqual(s.controller.audit({ kind: 'agent.refused' }).map((a) => a.detail.scope), ['session_workers']);
    assert.deepEqual(s.controller.audit({ kind: 'session.limits' }).map((a) => [a.actor, a.detail.to]), [['ui', { maxWorkers: 0, subagents: true }]]);

    // 1 at once: the first is fine, the second refused as its own limit.
    s.controller.setLimits(s.id, { maxWorkers: 1 }, { actor: 'ui' });
    await worker(s, s.id);
    assert.equal(await code(s.controller.create({ workspaceId: 'docker/ws1' }, { actor: `session:${s.id}`, parentId: s.id })), `${SESSION_CAP}:session_workers`);
    // 10 with the global cap at 3: three run, the fourth is refused by the global cap.
    s.controller.setLimits(s.id, { maxWorkers: 10 }, { actor: 'ui' });
    await worker(s, s.id);
    await worker(s, s.id);
    assert.equal(await code(s.controller.create({ workspaceId: 'docker/ws1' }, { actor: `session:${s.id}`, parentId: s.id })), `${SESSION_CAP}:children`);
    // Null: back to the global setting.
    assert.equal(s.controller.setLimits(s.id, { maxWorkers: null }, { actor: 'ui' }).session.maxWorkers, null);
  } finally {
    await s.done();
  }
});

test('setLimits: checked values only; a session’s own actor never changes limits, its own or another’s', async () => {
  const s = await liveSession();
  try {
    for (const bad of [{ maxWorkers: -1 }, { maxWorkers: 21 }, { maxWorkers: 1.5 }, { maxWorkers: '2' }, { subagents: 'off' }, { subagents: 0 }, {}, null])
      assert.equal(await code(() => s.controller.setLimits(s.id, bad, { actor: 'ui' })), 'VALIDATION_FAILED', JSON.stringify(bad));
    assert.equal(await code(() => s.controller.setLimits(s.id, { maxWorkers: 5 }, { actor: `session:${s.id}` })), 'FORBIDDEN', 'not itself');
    assert.equal(await code(() => s.controller.setLimits(s.id, { maxWorkers: 5 }, { actor: 'session:another' })), 'FORBIDDEN', 'not another session');
    assert.equal(await code(() => s.controller.setLimits('no-such-session', { maxWorkers: 5 }, { actor: 'ui' })), 'NOT_FOUND');
    assert.deepEqual([s.controller.get(s.id)!.maxWorkers, s.controller.get(s.id)!.subagents], [null, true], 'nothing changed');
    assert.equal(s.controller.audit({ kind: 'session.limits' }).length, 0);
  } finally {
    await s.done();
  }
});

test('a worker’s limits are never wider than its parent’s; what it is not given is its parent’s; the refusal is audited and nothing is made', async () => {
  const s = await liveSession();
  try {
    s.controller.agentCaps = () => CAPS;
    s.controller.setLimits(s.id, { maxWorkers: 2, subagents: false }, { actor: 'ui' });
    const before = s.controller.list().length;
    assert.equal(await code(s.controller.create({ workspaceId: 'docker/ws1' }, { actor: `session:${s.id}`, parentId: s.id, limits: { maxWorkers: 3 } })), 'VALIDATION_FAILED');
    assert.equal(await code(s.controller.create({ workspaceId: 'docker/ws1' }, { actor: `session:${s.id}`, parentId: s.id, limits: { subagents: true } })), 'VALIDATION_FAILED');
    assert.equal(s.controller.list().length, before, 'no session was made');
    assert.deepEqual(s.controller.audit({ kind: 'agent.refused' }).map((a) => a.detail.scope), ['worker_limits', 'worker_limits']);
    const inherits = await worker(s, s.id);
    assert.deepEqual([inherits.maxWorkers, inherits.subagents], [2, false], 'the parent’s own');
    assert.deepEqual(disallowedOf(s.ws.startArgs.find((a) => a.includes(inherits.id))!), [...SUBAGENT_TOOLS]);
    const narrower = await worker(s, s.id, { maxWorkers: 0 });
    assert.deepEqual([narrower.maxWorkers, narrower.subagents], [0, false]);
    assert.deepEqual(s.controller.audit({ kind: 'agent.spawned' })[0]!.detail.limits, { maxWorkers: 0, subagents: false });
  } finally {
    await s.done();
  }
});

/* ---------- The launch ---------- */

test('sub-agents off: the process starts with --disallowedTools Agent Task; on (the default) without it; a change waits for the next start', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    assert.equal(disallowedOf(lastStart(s)), null, 'on by default: no flag');
    const off = await worker(s, s.id, { subagents: false });
    const args = s.ws.startArgs.find((a) => a.includes(off.id))!;
    assert.deepEqual(disallowedOf(args), ['Agent', 'Task']);
    assert.ok(args.indexOf('--disallowedTools') > args.indexOf('--'), 'a flag of claude, after the host’s own arguments');
    const on = await worker(s, s.id, { subagents: true });
    assert.equal(disallowedOf(s.ws.startArgs.find((a) => a.includes(on.id))!), null);

    // Turned off on a live session: said, and it applies at its next start (a Restart).
    await until(() => s.controller.get(s.id)!.process === 'live');
    const res = s.controller.setLimits(s.id, { subagents: false }, { actor: 'ui' });
    assert.equal(res.restartNeeded, true);
    assert.equal(res.session.subagents, false);
    assert.ok(s.controller.history(s.id).some((e) => e.kind === 'system' && e.text === 'Sub-agents off from the next restart.'));
    const starts = s.ws.startArgs.length;
    await answered(s, s.controller.restart(s.id, { why: 'mcp' }));
    assert.equal(s.ws.startArgs.length, starts + 1);
    assert.deepEqual(disallowedOf(lastStart(s)), ['Agent', 'Task'], 'restart');
    // And on again.
    assert.equal(s.controller.setLimits(s.id, { subagents: true }, { actor: 'ui' }).restartNeeded, true);
    await answered(s, s.controller.restart(s.id, { why: 'mcp' }));
    assert.equal(disallowedOf(lastStart(s)), null);
    // The same value again needs no restart.
    assert.equal(s.controller.setLimits(s.id, { subagents: true }, { actor: 'ui' }).restartNeeded, false);
  } finally {
    await s.done();
  }
});

test('sub-agents off is kept at every relaunch: a resume after the process went away, and a wake from sleep', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    s.controller.controlTimeoutMs = 150;
    s.controller.setLimits(s.id, { subagents: false }, { actor: 'ui' });
    s.tail.push(init(s.id));
    await until(() => s.controller.get(s.id)!.process === 'asleep', 4000);
    let starts = s.ws.startArgs.length;
    const waking = s.controller.control(s.id, 'resume');
    await until(() => s.controller.get(s.id)!.process === 'live' && s.ws.startArgs.length === starts + 1);
    await answered(s, waking).catch(() => undefined);
    assert.deepEqual(disallowedOf(lastStart(s)), ['Agent', 'Task'], 'wake');

    // The process goes away; the next resume relaunches it.
    await until(() => s.controller.get(s.id)!.state === 'idle');
    s.ws.alive = false;
    s.ws.tails.at(-1)!.exit(0);
    await until(() => s.controller.get(s.id)!.process !== 'live');
    s.ws.alive = true;
    starts = s.ws.startArgs.length;
    const resuming = s.controller.control(s.id, 'resume');
    await until(() => s.controller.get(s.id)!.process === 'live' && s.ws.startArgs.length === starts + 1);
    await answered(s, resuming).catch(() => undefined);
    assert.ok(lastStart(s).includes('--resume'), 'resumed');
    assert.deepEqual(disallowedOf(lastStart(s)), ['Agent', 'Task'], 'resume');
  } finally {
    await s.done();
  }
});

test('a Move keeps the limits: the new Claude Code session on the other Claude starts with sub-agents off, and the workers limit stays', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    s.controller.setLimits(s.id, { subagents: false, maxWorkers: 2 }, { actor: 'ui' });
    const work = await s.controller.createClaude('docker/ws1', 'Work');
    const moving = s.controller.switchClaude(s.id, work.id, { handoff: 'skip' });
    await until(() => s.ws.tails.length >= 2 && csidOf(s) !== s.id);
    const newId = csidOf(s);
    const tail = s.ws.tails.at(-1)!;
    await until(() => s.ws.sends.some((x) => x.args[1] === newId && x.line.includes('transferred_context')));
    tail.push(init(newId));
    tail.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Got it.' }] }, parent_tool_use_id: null, uuid: randomUUID() }));
    tail.push(resultLine(newId));
    await until(() => controlsOf(s).some((c) => c.request.subtype === 'get_usage'));
    tail.push(ok(controlsOf(s).findLast((c) => c.request.subtype === 'get_usage')!.id, USAGE_API_KEY));
    const moved = await moving;
    assert.equal(moved.claudeName, 'Work');
    assert.deepEqual([moved.subagents, moved.maxWorkers], [false, 2], 'the session keeps its limits');
    const started = s.ws.startArgs.find((a) => a.includes(newId))!;
    assert.ok(started.includes('--session-id'), 'a new Claude Code session there');
    assert.deepEqual(disallowedOf(started), ['Agent', 'Task']);
  } finally {
    await s.done();
  }
});

/* ---------- The route ---------- */

test('PATCH /api/chat/sessions/:id/limits: manage on the session (another user: the same 404; a session’s own token: refused); 422 for a bad value', async () => {
  const s = await liveSession();
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    assert.deepEqual(declaredPolicies().get('PATCH /api/chat/sessions/:id/limits'), { kind: 'objects', checks: [{ type: 'session', verb: 'manage', from: 'path', param: 'id' }], audit: 'session.limits' });
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
    const patch = (who: unknown, body: unknown, id = s.id) => app(who).request(`/${id}/limits`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await patch({ kind: 'user', userId: 'u_a', loginSessionId: 'l1', via: 'ui' }, { maxWorkers: 0 })).status, 404, 'another user: the same 404');
    assert.equal((await patch('owner', { maxWorkers: 0 }, 'no-such-session')).status, 404, 'as a session that does not exist');
    assert.equal((await patch({ kind: 'agent', userId: 'u_owner', tokenId: 't1', sessionId: s.id, workspaceId: 'docker/ws1' }, { maxWorkers: 9 })).status, 403, 'the session itself');
    assert.equal((await patch({ kind: 'token', userId: 'u_owner', tokenId: 't2', scope: 'operate' }, { maxWorkers: 9 })).status, 403, 'an operate token: not enough');
    assert.equal((await patch(null, { maxWorkers: 9 })).status, 401, 'nobody signed in');
    assert.equal(s.controller.get(s.id)!.maxWorkers, null, 'nothing changed');
    assert.equal((await patch('owner', { maxWorkers: 99 })).status, 422);
    assert.equal((await patch('owner', { subagents: 'no' })).status, 422);

    await until(() => s.controller.get(s.id)!.process === 'live');
    const done = await patch('owner', { maxWorkers: 2, subagents: false });
    assert.equal(done.status, 200);
    const out = ((await done.json()) as { data: { session: { maxWorkers: number; subagents: boolean }; restartNeeded: boolean } }).data;
    assert.deepEqual([out.session.maxWorkers, out.session.subagents, out.restartNeeded], [2, false, true]);
    assert.equal(s.controller.audit({ kind: 'session.limits' })[0]!.actor, 'ui');
    const admin = await patch({ kind: 'token', userId: 'u_owner', tokenId: 't3', scope: 'admin' }, { maxWorkers: null });
    assert.equal(admin.status, 200, 'an admin token');
    assert.equal(s.controller.get(s.id)!.maxWorkers, null);
    assert.equal(s.controller.audit({ kind: 'session.limits' })[0]!.actor, 'portal-mcp:t3');
  } finally {
    await s.done();
  }
});

/* ---------- Portal MCP: session_spawn ---------- */

test('session_spawn with max_workers and subagents: the worker gets them, never wider than its parent; its own limit holds over MCP', async () => {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const s = await liveSession();
  try {
    s.controller.agentCaps = () => CAPS;
    registerChatTools(s.controller, registry);
    h.alive.add(s.id);
    const a = await h.agentToken('docker/ws1', s.id);
    s.controller.setLimits(s.id, { maxWorkers: 2 }, { actor: 'ui' });

    const wide = await h.call(a.secret, 'session_spawn', { prompt: 'Do a slice.', max_workers: 3 });
    assert.equal(wide.result?.structuredContent.error.code, 'VALIDATION_FAILED', 'wider than its own 2');
    const before = s.ws.startArgs.length;
    const started = await h.call(a.secret, 'session_spawn', { prompt: 'Do a slice.', max_workers: 1, subagents: false });
    assert.equal(started.result?.isError, undefined, JSON.stringify(started.raw));
    const w = started.result!.structuredContent.session as { id: string; max_workers: number; subagents: boolean };
    assert.deepEqual([w.max_workers, w.subagents], [1, false]);
    await until(() => s.ws.startArgs.length === before + 1);
    assert.deepEqual([s.controller.get(w.id)!.maxWorkers, s.controller.get(w.id)!.subagents], [1, false]);
    assert.deepEqual(disallowedOf(s.ws.startArgs.find((x) => x.includes(w.id))!), ['Agent', 'Task']);

    // Its own limit (2) holds over MCP too: the second is fine, the third refused as its own.
    h.alive.add(w.id);
    assert.equal((await h.call(a.secret, 'session_spawn', { prompt: 'Another slice.' })).result?.isError, undefined);
    assert.deepEqual(
      [(await h.call(a.secret, 'session_spawn', { prompt: 'One too many.' })).result?.structuredContent.error.code, s.controller.audit({ kind: 'agent.refused' })[0]!.detail.scope],
      [SESSION_CAP, 'session_workers'],
    );

  } finally {
    h.done();
    await s.done();
  }
});
