// T-102: the "Tools changed" hint that can be acted on at any time. What changed (by area), a restart queued for the turn's end and fired at
// the boundary (no turn and no task running, T-41), cancelled, "Restart now" that interrupts the turn, the hidden memory, the automatic restart
// of an autonomous session, and the coordinator's Bypass rule: a queued or automatic restart keeps Bypass where a restart can, and where it
// can't, the portal does not restart by itself.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { BYPASS_NOT_KEPT } from '@portal/contracts';
import { APPLIED, controls, init, line, liveSession, ok, sleep, until, USAGE_API_KEY, type Live } from './testkit.js';

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (isAppError(e) ? e.code : String(e)));
const result = (sessionId: string) =>
  line({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false, session_id: sessionId });
const taskStarted = (taskId: string) =>
  line({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: `toolu_${taskId}`, description: `task ${taskId}`, task_type: 'local_agent', is_backgrounded: true });
const taskDone = (taskId: string) => line({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: `toolu_${taskId}`, status: 'completed', summary: 'ok' });

/** A first turn read, and a delivery that landed after the process started (areas from the reconciler's events). */
async function changed(s: Live, areas: string[] = ['mcpset', 'settings']) {
  s.tail.push(init(s.id));
  s.tail.push(ok((await s.take('get_settings')).id, APPLIED));
  await until(() => s.controller.get(s.id)!.effort === 'medium');
  const landed = new Date(Date.now() + 1000).toISOString();
  s.controller.deliveredAt = () => landed;
  s.controller.configChanges = () => areas;
  s.controller.deliveryChanged('docker/ws1');
  return landed;
}

/** A turn runs: a message was sent and Claude Code started on it. */
async function working(s: Live, uuid = randomUUID()) {
  await s.controller.send(s.id, uuid, 'keep going');
  await until(() => s.state() === 'working');
  return uuid;
}

const usageAnswered = new Set<string>();
/** The turn ends: its message completes and the result arrives; the subscription check a process asks after a result is answered. */
async function turnEnds(s: Live, uuid: string, tail = s.ws.tails.at(-1)!) {
  tail.push(line({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' }));
  tail.push(result(s.controller.get(s.id)!.claudeSessionId));
  const end = Date.now() + 600;
  while (Date.now() < end) {
    for (const c of controls(s.ws)) {
      if (c.request.subtype !== 'get_usage' || usageAnswered.has(c.id)) continue;
      usageAnswered.add(c.id);
      tail.push(ok(c.id, USAGE_API_KEY));
    }
    await sleep(10);
  }
}

const restarts = (s: Live) => s.controller.audit({ kind: 'session.restart' });

test('T-102: the hint names what changed (the areas, portal tools), its time is the newest change, and a bad area is left out', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    const landed = await changed(s, ['mcpset', 'secrets', 'not-an-area']);
    let shown = s.controller.get(s.id)!;
    assert.deepEqual(shown.configChanged, { at: landed, reasons: ['mcpset', 'secrets'] });
    assert.equal(shown.configChangedAt, landed, 'the old field stays');
    assert.equal(shown.autonomous, false, 'a person’s own session in Manual');
    assert.equal(shown.autoApply, false);
    assert.equal(shown.restartQueued, undefined);

    s.controller.configChanges = () => {
      throw new Error('db gone');
    };
    assert.deepEqual(s.controller.get(s.id)!.configChanged?.reasons, ['other'], 'a failing reader still shows that something changed');

    await sleep(1100);
    s.controller.portalToolsChanged('docker/ws1');
    shown = s.controller.get(s.id)!;
    assert.ok(shown.configChanged!.reasons.includes('portal_tools'));
    assert.ok(Date.parse(shown.configChanged!.at) > Date.parse(landed), 'the newest change is the time');
  } finally {
    await s.done();
  }
});

test('T-102: Restart after this turn waits for the boundary (the turn AND its tasks), then restarts by itself; audited as queued', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    await changed(s);
    const m = await working(s);
    const queued = await s.controller.restart(s.id, { why: 'mcp', when: 'turn_end' });
    assert.equal(queued.restartQueued, 'person');
    assert.ok(queued.busySince, 'a working session says since when');
    const stops = s.ws.stops;
    s.tail.push(taskStarted('a1'));
    await until(() => (s.controller.get(s.id)!.agentsRunning ?? 0) === 1);
    await turnEnds(s, m);
    await sleep(700);
    assert.equal(s.ws.stops, stops, 'a running sub-agent keeps it waiting: a queued restart never kills it');
    assert.equal(s.controller.get(s.id)!.restartQueued, 'person');
    s.tail.push(taskDone('a1'));
    await s.answering(until(() => restarts(s).length === 1, 5000));
    assert.equal(s.ws.stops, stops + 1);
    const [audit] = restarts(s);
    assert.deepEqual([audit!.actor, audit!.detail.how, audit!.detail.agents], ['ui', 'queue', 0]);
    await until(() => !s.controller.get(s.id)!.restarting);
    const after = s.controller.get(s.id)!;
    assert.equal(after.restartQueued, undefined, 'done: nothing waits');
    assert.equal(after.configChanged, undefined, 'the new process read it');
  } finally {
    await s.done();
  }
});

test('T-102: a queued restart can be cancelled; at the boundary already it restarts at once', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    await changed(s);
    const m = await working(s);
    await s.controller.restart(s.id, { why: 'mcp', when: 'turn_end' });
    assert.equal(s.controller.cancelRestart(s.id).restartQueued, undefined);
    const stops = s.ws.stops;
    await turnEnds(s, m);
    await sleep(700);
    assert.equal(s.ws.stops, stops, 'cancelled: no restart');
    // Idle now: "after this turn" is now.
    await s.answering(s.controller.restart(s.id, { why: 'mcp', when: 'turn_end' }));
    assert.equal(s.ws.stops, stops + 1);
    assert.equal(await code(s.controller.restart(s.id, { when: 'later' })), 'VALIDATION_FAILED');
  } finally {
    await s.done();
  }
});

test('T-102: Restart now while a turn runs interrupts it (the person confirmed): the turn stops, open approvals expire, the conversation resumes', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    await changed(s);
    await working(s);
    s.tail.push(line({ type: 'control_request', request_id: 'R1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' } }));
    await until(() => s.controller.get(s.id)!.waiting === 1);
    assert.equal(await code(s.controller.restart(s.id)), 'CONFLICT', 'without interrupt it still waits for the boundary');
    const before = s.controller.get(s.id)!;
    const restarting = s.answering(s.controller.restart(s.id, { why: 'mcp', interrupt: true }));
    const ask = await s.take('interrupt');
    s.tail.push(ok(ask.id));
    const after = await restarting;
    assert.equal(after.process, 'live');
    assert.equal(after.claudeSessionId, before.claudeSessionId, 'the same conversation');
    assert.equal(after.waiting, 0, 'the approval expired with the old process');
    assert.ok(s.ws.startArgs.at(-1)!.includes('--resume'));
    assert.equal(restarts(s)[0]!.detail.how, 'interrupt');
  } finally {
    await s.done();
  }
});

test('T-102: hide until the next change is stored on the session; a newer change shows it again', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    const landed = await changed(s);
    const hidden = s.controller.setRestartHint(s.id, { hidden: true });
    assert.equal(hidden.configHiddenAt, landed, 'hidden for this change');
    assert.equal(s.store.db!.prepare('SELECT config_hidden_at AS h FROM chat_sessions WHERE id = ?').get(s.id)!.h, landed, 'remembered in the database');
    const newer = new Date(Date.parse(landed) + 5000).toISOString();
    s.controller.deliveredAt = () => newer;
    const shown = s.controller.get(s.id)!;
    assert.ok(Date.parse(shown.configChanged!.at) > Date.parse(shown.configHiddenAt!), 'the newer change is past what was hidden');
    assert.equal(s.controller.setRestartHint(s.id, { hidden: false }).configHiddenAt, undefined);
    assert.throws(() => s.controller.setRestartHint(s.id, { hidden: 'yes' }), (e: unknown) => isAppError(e) && e.code === 'VALIDATION_FAILED');
    assert.throws(() => s.controller.setRestartHint(s.id, { autoApply: 1 }), (e: unknown) => isAppError(e) && e.code === 'VALIDATION_FAILED');
  } finally {
    await s.done();
  }
});

test('T-102: Apply tool changes at the next turn end: the portal queues the restart itself, once per change, and the setting is remembered', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    s.controller.autoRestartSettleMs = 0; // T-472's quiet time has its own test
    const m = await (async () => {
      await changed(s);
      return working(s);
    })();
    assert.equal(s.controller.get(s.id)!.restartQueued, undefined, 'off by default for a person’s own session');
    const on = s.controller.setRestartHint(s.id, { autoApply: true });
    assert.equal(on.autoApply, true);
    assert.equal(on.restartQueued, 'auto');
    assert.equal(s.store.db!.prepare('SELECT auto_apply AS a FROM chat_sessions WHERE id = ?').get(s.id)!.a, 1);
    await turnEnds(s, m);
    await s.answering(until(() => restarts(s).length === 1, 5000));
    assert.deepEqual([restarts(s)[0]!.actor, restarts(s)[0]!.detail.how], ['portal', 'auto']);
    await until(() => !s.controller.get(s.id)!.restarting);
    assert.equal(s.controller.get(s.id)!.restartQueued, undefined);
    // Cancelling the automatic one skips that change only.
    const m2 = await working(s);
    const newer = new Date(Date.now() + 2000).toISOString();
    s.controller.deliveredAt = () => newer;
    assert.equal(s.controller.get(s.id)!.restartQueued, 'auto');
    assert.equal(s.controller.cancelRestart(s.id).restartQueued, undefined);
    await turnEnds(s, m2);
    await sleep(700);
    assert.equal(restarts(s).length, 1, 'cancelled for this change');
    assert.equal(s.controller.setRestartHint(s.id, { autoApply: null }).autoApply, false, 'back to the default');
  } finally {
    await s.done();
  }
});

test('T-102: a session a portal actor started is autonomous: the setting is on by default', async () => {
  const s = await liveSession();
  try {
    const other = await s.controller.create({ workspaceId: 'docker/ws1' }, { actor: 'portal-mcp:tok1' });
    const shown = s.controller.get(other.id)!;
    assert.equal(shown.autonomous, true);
    assert.equal(shown.autoApply, true);
    await s.controller.end(other.id).catch(() => undefined);
  } finally {
    await s.done();
  }
});

/* ---------- T-472: context deliveries restart nothing; the rest settle into one restart ---------- */

/**
 * The reconciler as production wires it: one log of deliveries (newest first), and the older readers over the same log (the latest
 * delivery's time, every area since), so the code before T-472 sees the same deliveries.
 */
function deliveries(s: Live) {
  const log: { at: string; areas: string[] }[] = [];
  s.controller.configChangeLog = (_ws, since) => log.filter((e) => Date.parse(e.at) > since);
  s.controller.deliveredAt = () => log[0]?.at ?? null;
  s.controller.configChanges = (_ws, since) => [...new Set(log.filter((e) => Date.parse(e.at) > since).flatMap((e) => e.areas))];
  return (areas: string[]) => {
    log.unshift({ at: new Date().toISOString(), areas });
    s.controller.deliveryChanged('docker/ws1');
  };
}

/** A first turn read, the session set to apply changes by itself; idle, so the boundary is now. */
async function autoApplying(s: Live) {
  s.tail.push(init(s.id));
  s.tail.push(ok((await s.take('get_settings')).id, APPLIED));
  await until(() => s.controller.get(s.id)!.effort === 'medium');
  s.controller.setRestartHint(s.id, { autoApply: true });
  await sleep(20); // a delivery lands after the process started
}

test('T-472: a context-only delivery shows no hint and restarts nothing; an MCP delivery after it still restarts, once', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    s.controller.autoRestartSettleMs = 0;
    const deliver = deliveries(s);
    await autoApplying(s);
    const stops = s.ws.stops;
    deliver(['context']);
    deliver(['context']);
    await sleep(700);
    const shown = s.controller.get(s.id)!;
    assert.equal(shown.configChanged, undefined, 'the running process re-read the rules (drop-in stamp): nothing to restart for');
    assert.equal(shown.restartQueued, undefined);
    assert.equal(s.ws.stops, stops, 'no restart');
    assert.equal(restarts(s).length, 0);

    deliver(['mcpset']);
    assert.deepEqual(s.controller.get(s.id)!.configChanged?.reasons, ['mcpset'], 'the hint names only what the process has not read');
    await s.answering(until(() => restarts(s).length === 1, 5000));
    assert.deepEqual([restarts(s)[0]!.actor, restarts(s)[0]!.detail.how], ['portal', 'auto']);
    await until(() => !s.controller.get(s.id)!.restarting);
    deliver(['context']);
    await sleep(700);
    assert.equal(restarts(s).length, 1, 'a context delivery after the restart restarts nothing either');
    assert.equal(s.controller.get(s.id)!.configChanged, undefined);
  } finally {
    await s.done();
  }
});

test('T-472: three MCP and settings deliveries in a burst give one automatic restart, after the newest has been quiet', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    s.controller.autoRestartSettleMs = 600;
    const deliver = deliveries(s);
    await autoApplying(s);
    deliver(['mcpset']);
    await sleep(250);
    deliver(['settings']);
    await sleep(250);
    deliver(['mcpset']);
    const last = Date.now();
    assert.equal(s.controller.get(s.id)!.restartQueued, 'auto', 'queued, waiting for the burst to settle');
    await sleep(300);
    assert.equal(restarts(s).length, 0, 'still settling: no restart inside the burst');
    await s.answering(until(() => restarts(s).length === 1, 5000));
    assert.ok(Date.now() - last >= 600, 'it waited for the newest delivery to be quiet');
    await until(() => !s.controller.get(s.id)!.restarting);
    await sleep(900);
    assert.equal(restarts(s).length, 1, 'one restart for the burst');
    assert.equal(s.controller.get(s.id)!.configChanged, undefined, 'the new process read all three');
  } finally {
    await s.done();
  }
});

/* ---------- The Bypass rule ---------- */

function policy(s: Live, allowed: boolean) {
  const state = { allowed, fresh: true };
  s.controller.bypassAllowed = () => state.allowed;
  s.controller.reauth = { fresh: (token) => token === 'tok' && state.fresh };
  return state;
}

/** A bypass-capable session past its first turn, in Bypass, with a delivery after its start; its reader is the newest tail. */
async function inBypassChanged(s: Live) {
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
  const landed = new Date(Date.now() + 1000).toISOString();
  s.controller.deliveredAt = () => landed;
  s.controller.configChanges = () => ['mcpset'];
  return { id, tail };
}

/** Answers every `set_permission_mode` the newest process is asked with the mode asked, until `p` settles. */
async function modesAnswered<T>(s: Live, p: Promise<T>): Promise<T> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  const seen = new Set<string>();
  const asks = () =>
    s.ws.sends.flatMap((x) => {
      try {
        const o = JSON.parse(x.line) as { type?: string; request_id?: string; request?: Record<string, unknown> };
        return o.type === 'control_request' && o.request_id && o.request?.subtype === 'set_permission_mode' ? [{ id: o.request_id, mode: String(o.request.mode) }] : [];
      } catch {
        return [];
      }
    });
  for (const a of asks()) seen.add(a.id);
  while (!settled) {
    for (const a of asks()) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      s.ws.tails.at(-1)!.push(ok(a.id, { mode: a.mode }));
    }
    await sleep(5);
  }
  return p;
}

test('T-102 Bypass rule: an autonomous Bypass session restarts by itself at the turn end and KEEPS Bypass while the policy allows it', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    s.controller.autoRestartSettleMs = 0; // T-472's quiet time has its own test
    policy(s, true);
    const { id, tail } = await inBypassChanged(s);
    const shown = s.controller.get(id)!;
    assert.equal(shown.autonomous, true, 'Bypass: nobody may be watching');
    assert.equal(shown.restartQueued, 'auto', 'on by default');
    assert.equal(shown.restartHeld, undefined);
    // It was idle when the change landed: the restart starts at once (the boundary is now).
    s.controller.deliveryChanged('docker/ws1');
    await modesAnswered(s, s.answering(until(() => s.controller.audit({ kind: 'session.restart' }).length === 1, 5000)));
    await until(() => !s.controller.get(id)!.restarting && s.controller.get(id)!.mode === 'bypassPermissions', 5000);
    await sleep(600);
    assert.equal(s.controller.audit({ kind: 'session.restart' }).length, 1, 'once for the change');
    const [audit] = s.controller.audit({ kind: 'session.restart' });
    assert.deepEqual([audit!.actor, audit!.detail.how, audit!.detail.bypass], ['portal', 'auto', 'kept']);
    assert.notEqual(s.ws.tails.at(-1), tail, 'a new process');
  } finally {
    await s.done();
  }
});

test('T-102 Bypass rule: where a restart could not keep Bypass, the portal does NOT restart by itself; the hint says so and a queue is refused', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    const state = policy(s, true);
    const { id } = await inBypassChanged(s);
    state.allowed = false; // the policy no longer allows it (before the portal has switched the session out)
    const shown = s.controller.get(id)!;
    assert.equal(shown.mode, 'bypassPermissions');
    assert.equal(shown.restartHeld, 'bypass');
    assert.equal(shown.restartQueued, undefined, 'not queued: it would come back in Manual and wait for approvals');
    const stops = s.ws.stops;
    s.controller.deliveryChanged('docker/ws1');
    await sleep(700);
    assert.equal(s.ws.stops, stops, 'no automatic restart');
    assert.equal(s.controller.audit({ kind: 'session.restart' }).length, 0);
    assert.equal(await code(s.controller.restart(id, { why: 'mcp', when: 'turn_end' })), BYPASS_NOT_KEPT);
  } finally {
    await s.done();
  }
});
