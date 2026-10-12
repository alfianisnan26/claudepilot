// Bypass permissions in chat (chat-sessions PRD FR20, §6 rule 5, C5). Everything has to hold before the portal
// sends the one request that may turn it on: the policy allows it, the session is bypass-capable (a person's own
// opt-in), the confirmation was ticked and the server code was checked again; every refusal and every entry is
// audited, and anything else that reports Bypass still ends the session for integrity.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { BYPASS_BLOCKED, BYPASS_NOT_CAPABLE, REAUTH_REQUIRED } from '@portal/contracts';
import { Reauth } from './reauth.js';
import { init, line, liveSession, ok, sleep, until, type Live } from './testkit.js';

const FLAG = '--allow-dangerously-skip-permissions';
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (isAppError(e) ? e.code : String(e)));

/** A policy and a re-check the test controls. */
function policy(s: Live, allowed: boolean) {
  const state = { allowed, fresh: true };
  s.controller.bypassAllowed = () => state.allowed;
  s.controller.reauth = { fresh: (token) => token === 'tok' && state.fresh };
  return state;
}

/** Starts a second session for the person, with or without the opt-in; its reader is the newest tail. */
async function second(s: Live, optIn: boolean) {
  const before = s.ws.tails.length;
  const created = await s.controller.create({ workspaceId: 'docker/ws1' }, optIn ? { bypassOptIn: true } : {});
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(created.id)?.state === 'idle');
  await sleep(20);
  return { id: created.id, tail: s.ws.tails.at(-1)! };
}

/** The flags of the newest `start` the fake host saw. */
const lastStart = (s: Live) => s.ws.startArgs.at(-1)!;

test('opt-in: only a person’s own opt-in, only where the policy allows, makes a session bypass-capable; its process then starts with the flag', async () => {
  const s = await liveSession();
  try {
    const state = policy(s, false);
    // Blocked by policy: refused and audited, nothing created.
    const count = s.controller.list().length;
    assert.equal(await code(s.controller.create({ workspaceId: 'docker/ws1' }, { bypassOptIn: true })), BYPASS_BLOCKED);
    assert.equal(s.controller.list().length, count);
    assert.deepEqual(s.controller.audit({ kind: 'bypass' }).map((a) => [a.kind, a.severity, a.detail.why]), [['bypass.refused', 'medium', 'policy']]);

    // Allowed: capable, audited, and started with the flag. A session without the opt-in never is, policy or not.
    state.allowed = true;
    const yes = await second(s, true);
    assert.equal(s.controller.get(yes.id)!.bypassCapable, true);
    assert.ok(lastStart(s).includes(FLAG), 'the flag is how Claude Code allows the switch at all');
    const no = await second(s, false);
    assert.equal(s.controller.get(no.id)!.bypassCapable, false);
    assert.ok(!lastStart(s).includes(FLAG));
    assert.ok(!s.ws.startArgs[0]!.includes(FLAG), 'the first session, started with no policy, has no flag either');
    assert.ok(s.controller.audit({ kind: 'bypass.capable' }).length === 1);
  } finally {
    await s.done();
  }
});

test('opt-in: no other caller can make a session bypass-capable: MCP, tickets, a session starting another, or a flag in the request body', async () => {
  const s = await liveSession();
  try {
    policy(s, true);
    const refused = async (opts: Parameters<typeof s.controller.create>[1], req: Parameters<typeof s.controller.create>[0] = { workspaceId: 'docker/ws1' }) =>
      code(s.controller.create(req, { ...opts, bypassOptIn: true }));
    assert.equal(await refused({ actor: 'portal-mcp:tok1' }), BYPASS_BLOCKED);
    assert.equal(await refused({ actor: 'ticket:T-1' }), BYPASS_BLOCKED);
    assert.equal(await refused({ actor: `session:${s.id}`, parentId: s.id }), BYPASS_BLOCKED);
    assert.equal(await refused({ parentId: s.id }), BYPASS_BLOCKED, 'a session another one starts is never capable, whoever it says is asking');
    // The request body's own field is a request, not a grant: the controller ignores it.
    const viaBody = await s.controller.create({ workspaceId: 'docker/ws1', allowBypass: true });
    assert.equal(viaBody.bypassCapable, false);
    // And what it started from (a transfer's or a move's successor) doesn't inherit it either: capability is per session.
    assert.equal(s.controller.get(s.id)!.bypassCapable, false);
  } finally {
    await s.done();
  }
});

test('entering Bypass: every refusal is audited and writes nothing to Claude Code; the control that sets a mode never enters it', async () => {
  const s = await liveSession();
  try {
    const state = policy(s, true);
    const b = await second(s, true);
    const nothing = () => s.ws.sends.filter((x) => x.line.includes('set_permission_mode')).length;
    const before = nothing();

    state.allowed = false;
    assert.equal(await code(s.controller.enterBypass(b.id, { acknowledged: true, sessionToken: 'tok' })), BYPASS_BLOCKED);
    state.allowed = true;
    const plain = await second(s, false);
    assert.equal(await code(s.controller.enterBypass(plain.id, { acknowledged: true, sessionToken: 'tok' })), BYPASS_NOT_CAPABLE);
    assert.equal(await code(s.controller.enterBypass(b.id, { acknowledged: false, sessionToken: 'tok' })), 'VALIDATION_FAILED');
    state.fresh = false;
    assert.equal(await code(s.controller.enterBypass(b.id, { acknowledged: true, sessionToken: 'tok' })), REAUTH_REQUIRED);
    state.fresh = true;
    assert.equal(await code(s.controller.enterBypass(b.id, { acknowledged: true, sessionToken: 'someone else' })), REAUTH_REQUIRED, 'the check belongs to the sign-in that made it');
    s.controller.reauth = undefined;
    assert.equal(await code(s.controller.enterBypass(b.id, { acknowledged: true, sessionToken: 'tok' })), REAUTH_REQUIRED, 'no re-check configured: nothing enters Bypass');
    assert.equal(await code(s.controller.control(b.id, 'mode', { mode: 'bypassPermissions' })), 'FORBIDDEN');

    assert.equal(nothing(), before, 'not one set_permission_mode was written');
    const refusals = s.controller.audit({ kind: 'bypass.refused' }).map((a) => a.detail.why).sort();
    assert.deepEqual(refusals, ['control', 'no_acknowledgement', 'no_reauth', 'no_reauth', 'no_reauth', 'not_capable', 'policy']);
    assert.equal(s.controller.get(b.id)!.mode, 'default');
  } finally {
    await s.done();
  }
});

test('entering Bypass: once everything holds the portal asks Claude Code, accepts its answer, shows it, and audits a High event; leaving is one tap', async () => {
  const s = await liveSession();
  try {
    policy(s, true);
    const b = await second(s, true);
    const entering = s.controller.enterBypass(b.id, { acknowledged: true, sessionToken: 'tok' });
    const req = await s.take('set_permission_mode');
    assert.equal(req.request.mode, 'bypassPermissions');
    b.tail.push(ok(req.id, { mode: 'bypassPermissions' }));
    const on = await entering;
    assert.equal(on.mode, 'bypassPermissions');
    assert.equal(s.controller.get(b.id)!.state, 'idle', 'not an integrity end');
    assert.ok(s.controller.history(b.id).some((e) => e.kind === 'system' && /^Bypass on/.test(e.text ?? '')));
    const entered = s.controller.audit({ kind: 'bypass.entered' });
    assert.equal(entered.length, 1);
    assert.deepEqual([entered[0]!.severity, entered[0]!.sessionId, entered[0]!.workspaceId, entered[0]!.actor], ['high', b.id, 'docker/ws1', 'ui']);
    assert.deepEqual(entered[0]!.detail, { claude: 'Default', policy: 'allowed', capable: true, acknowledged: true, reauth: 'fresh' });
    assert.equal(s.controller.bypassState(b.id, 'tok').active, true);

    // Claude Code now reports Bypass on every turn: that is what the portal expects, no integrity end.
    b.tail.push(init(b.id, 'bypassPermissions'));
    await sleep(60);
    assert.notEqual(s.controller.get(b.id)!.state, 'ended');

    // Leaving: the mode control, one tap.
    const leaving = s.controller.control(b.id, 'mode', { mode: 'default' });
    const back = await s.take('set_permission_mode');
    b.tail.push(ok(back.id, { mode: 'default' }));
    await leaving;
    assert.equal(s.controller.get(b.id)!.mode, 'default');
    assert.deepEqual(s.controller.audit({ kind: 'bypass.left' }).map((a) => a.detail.to), ['default']);
    // After leaving, a report of Bypass is a forgery again.
    b.tail.push(init(b.id, 'bypassPermissions'));
    await until(() => s.controller.get(b.id)!.state === 'ended');
    assert.match(s.controller.get(b.id)!.endedReason ?? '', /^integrity: the agent reported Bypass permissions/);
  } finally {
    await s.done();
  }
});

test('integrity: a report of Bypass the portal didn’t enter ends the session, however the session was started', async () => {
  const s = await liveSession();
  try {
    policy(s, true);
    const b = await second(s, true); // capable, but nobody confirmed anything
    b.tail.push(init(b.id, 'bypassPermissions'));
    await until(() => s.controller.get(b.id)!.state === 'ended');
    assert.match(s.controller.get(b.id)!.endedReason ?? '', /^integrity: the agent reported Bypass permissions/);
    const c = await second(s, true);
    // A reply to a mode request the portal made for another mode can't smuggle it in either.
    const pending = s.controller.control(c.id, 'mode', { mode: 'plan' });
    const req = await s.take('set_permission_mode');
    c.tail.push(ok(req.id, { mode: 'bypassPermissions' }));
    await assert.rejects(pending);
    await until(() => s.controller.get(c.id)!.state === 'ended');
    assert.match(s.controller.get(c.id)!.endedReason ?? '', /integrity/);
  } finally {
    await s.done();
  }
});

test('sleep: an idle session in Bypass goes to sleep out of it ("Bypass turned off after sleep"), and its wake starts on the start mode', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    s.controller.controlTimeoutMs = 150;
    policy(s, true);
    const b = await second(s, true);
    b.tail.push(init(b.id));
    const entering = s.controller.enterBypass(b.id, { acknowledged: true, sessionToken: 'tok' });
    b.tail.push(ok((await s.take('set_permission_mode')).id, { mode: 'bypassPermissions' }));
    await entering;
    assert.equal(s.controller.get(b.id)!.mode, 'bypassPermissions');
    await until(() => s.controller.get(b.id)!.process === 'asleep', 4000);
    assert.equal(s.controller.get(b.id)!.mode, 'default', 'a sleeping session is not in Bypass');
    assert.ok(s.controller.history(b.id).some((e) => e.kind === 'system' && e.text === 'Bypass turned off after sleep.'));
    assert.deepEqual(s.controller.audit({ kind: 'bypass.left' }).map((a) => a.detail.why), ['sleep']);
    const resuming = s.controller.control(b.id, 'resume');
    await until(() => s.controller.get(b.id)!.process === 'live');
    await resuming.catch(() => undefined);
    assert.equal(s.controller.get(b.id)!.mode, 'default');
    assert.ok(lastStart(s).includes(FLAG), 'the wake still allows entering it again, with a new confirmation');
  } finally {
    await s.done();
  }
});

test('wake and resume never restore Bypass: it is off after a restart, said so, audited, and nothing asks for it again', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150; // putting back the model and effort isn't answered here
    policy(s, true);
    const b = await second(s, true);
    // A first turn, so there is a transcript to resume.
    b.tail.push(init(b.id));
    b.tail.push(ok((await s.take('get_settings')).id, { applied: { model: 'claude-opus-5-5', effort: 'medium', ultracode: false, ultracodeAvailable: true } }));
    await until(() => s.controller.get(b.id)!.effort === 'medium');
    const entering = s.controller.enterBypass(b.id, { acknowledged: true, sessionToken: 'tok' });
    b.tail.push(ok((await s.take('set_permission_mode')).id, { mode: 'bypassPermissions' }));
    await entering;
    assert.equal(s.controller.get(b.id)!.mode, 'bypassPermissions');

    // The process goes away (a restart, or a sleep) and the session resumes.
    s.ws.alive = false;
    b.tail.exit(0);
    await until(() => s.controller.get(b.id)!.state === 'interrupted');
    assert.equal(s.controller.get(b.id)!.mode, 'default', 'off as soon as its process is over, not only at the next launch');
    s.ws.alive = true;
    const requests = () => s.ws.sends.filter((x) => x.line.includes('"bypassPermissions"') && x.line.includes('set_permission_mode')).length;
    const asked = requests();
    const resuming = s.controller.control(b.id, 'resume');
    await until(() => s.controller.get(b.id)!.process === 'live' && s.ws.startArgs.length >= 3);
    await resuming.catch(() => undefined);
    const now = s.controller.get(b.id)!;
    assert.equal(now.mode, 'default', 'off after the restart');
    assert.ok(lastStart(s).includes(FLAG) && lastStart(s).includes('--resume'), 'still able to enter it again, with a new confirmation');
    assert.ok(s.controller.history(b.id).some((e) => e.kind === 'system' && e.text === 'Bypass turned off: Claude Code stopped.'));
    assert.equal(requests(), asked, 'no request to enter Bypass was sent by the relaunch');
    assert.deepEqual(s.controller.audit({ kind: 'bypass.left' }).map((a) => a.detail.why), ['stopped']);
  } finally {
    await s.done();
  }
});

test('policy: turning it off takes a session out of Bypass at once, and its next launch has no flag', async () => {
  const s = await liveSession();
  try {
    const state = policy(s, true);
    const b = await second(s, true);
    const entering = s.controller.enterBypass(b.id, { acknowledged: true, sessionToken: 'tok' });
    b.tail.push(ok((await s.take('set_permission_mode')).id, { mode: 'bypassPermissions' }));
    await entering;
    state.allowed = false;
    const changed = s.controller.bypassPolicyChanged();
    const req = await s.take('set_permission_mode');
    assert.equal(req.request.mode, 'default');
    b.tail.push(ok(req.id, { mode: 'default' }));
    await changed;
    assert.equal(s.controller.get(b.id)!.mode, 'default');
    assert.ok(s.controller.history(b.id).some((e) => e.text === 'Bypass turned off: the policy no longer allows it.'));
    assert.equal(s.controller.audit({ kind: 'bypass.left' }).filter((a) => a.detail.why === 'policy').length, 1);
    assert.equal(await code(s.controller.enterBypass(b.id, { acknowledged: true, sessionToken: 'tok' })), BYPASS_BLOCKED);
  } finally {
    await s.done();
  }
});

test('restart to allow Bypass: an idle session becomes capable and relaunches with the flag; a busy one waits; the policy must allow it', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    const state = policy(s, false);
    assert.equal(await code(s.controller.allowBypass(s.id)), BYPASS_BLOCKED);
    state.allowed = true;
    // A turn has run, so Claude Code has a transcript to resume.
    s.tail.push(init(s.id));
    s.tail.push(ok((await s.take('get_settings')).id, { applied: { model: 'claude-opus-5-5', effort: 'medium', ultracode: false, ultracodeAvailable: true } }));
    await until(() => s.controller.get(s.id)!.effort === 'medium');
    // Busy: wait for the turn.
    await s.controller.send(s.id, 'm1', 'working on it');
    assert.equal(await code(s.controller.allowBypass(s.id)), 'CONFLICT');
    s.tail.push(line({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false, session_id: s.id }));
    await until(() => s.state() === 'idle');
    const starts = s.ws.startArgs.length;
    const restarting = s.controller.allowBypass(s.id);
    await until(() => s.ws.startArgs.length > starts);
    await restarting.catch(() => undefined);
    assert.equal(s.controller.get(s.id)!.bypassCapable, true);
    assert.ok(lastStart(s).includes(FLAG) && lastStart(s).includes('--resume'));
    assert.equal(s.controller.get(s.id)!.mode, 'default', 'allowing it doesn’t turn it on');
    assert.deepEqual(s.controller.audit({ kind: 'bypass.capable' }).map((a) => a.detail.how), ['restart']);
  } finally {
    await s.done();
  }
});

test('re-auth: the server code, checked again, counts for ten minutes for that sign-in only', () => {
  let now = 1_000_000;
  const sessions = new Map<string, object>([['a', {}], ['b', {}]]);
  const portal = { session: (t: string | undefined) => (t ? (sessions.get(t) as never) : undefined), matches: (c: string) => c === '12345678' };
  const reauth = new Reauth(portal, 600_000, () => now);
  assert.equal(reauth.fresh('a'), false);
  assert.equal(reauth.confirm('a', 'nope'), false, 'a wrong code starts nothing');
  assert.equal(reauth.confirm(undefined, '12345678'), false);
  assert.equal(reauth.confirm('gone', '12345678'), false, 'no sign-in, no check');
  assert.equal(reauth.confirm('a', '12345678'), true);
  assert.equal(reauth.fresh('a'), true);
  assert.equal(reauth.fresh('b'), false, 'another sign-in has its own');
  now += 599_000;
  assert.equal(reauth.fresh('a'), true);
  now += 2_000;
  assert.equal(reauth.fresh('a'), false, 'ten minutes');
  sessions.delete('a');
  assert.equal(reauth.fresh('a'), false, 'signing out ends it');
});

