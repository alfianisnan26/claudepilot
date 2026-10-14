// The Keep going sweep on a fake clock (T-259 slice 1): a nudge after N idle minutes and not before, once per idle period; a question is
// answered, a tool approval never is and is reported once; wake then nudge; the caps; the kill switch; a portal restart in the middle
// resumes from the stored state; an ended chat is reported once with one ticket; out of Bypass is reported, not re-entered.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEEPGOING_ACTOR, KEEPGOING_DEFAULT_STATUS_FILE, KEEPGOING_SETTING_KEYS as K } from '@portal/contracts';
import { render } from '../notify/templates.js';
import { fakeOwner } from '../notify/testkit.js';
import { rig, settingsMap } from './testkit.js';

test('an idle chat is nudged after nudgeAfterMin and not before, with the prompt at priority later, as the portal; one trail row, one audit row', async () => {
  const r = await rig();
  r.chat.put('s1');
  r.on('s1');
  await r.engine.round(); // at 0 min: idle 0
  await r.after(1);
  await r.after(1);
  await r.after(1); // 3 min
  assert.equal(r.chat.sent.length, 0, 'not before 4 minutes');
  await r.after(1); // 4 min
  assert.equal(r.chat.sent.length, 1);
  const [sent] = r.chat.sent;
  assert.equal(sent!.priority, 'later');
  assert.equal(sent!.actor, KEEPGOING_ACTOR);
  assert.ok(sent!.text.includes(KEEPGOING_DEFAULT_STATUS_FILE), 'the {status} placeholder is filled');
  assert.ok(!sent!.text.includes('{status}'));
  const view = r.engine.view('s1')!;
  assert.equal(view.nudgesToday, 1);
  assert.equal(view.last?.kind, 'nudged');
  assert.equal(view.last?.reason, 'Idle for 4 min: told to continue.');
  assert.equal(r.auditRows('keepgoing.nudged').length, 1);
  assert.ok(!JSON.stringify(r.auditRows()).includes('CANARY'), 'no title or message text in the audit');
});

test('once per idle period: a nudge that started no turn is not repeated; the next idle period is nudged again (10 minutes apart at least)', async () => {
  const r = await rig();
  r.chat.put('s1');
  r.chat.sendStartsTurn = false;
  r.on('s1', { nudgeAfterMin: 2 });
  await r.after(2);
  assert.equal(r.chat.sent.length, 1);
  for (let i = 0; i < 20; i++) await r.after(1);
  assert.equal(r.chat.sent.length, 1, 'the same idle period is not nudged twice');
  r.chat.turnEnds('s1'); // the chat did something: a new idle period
  await r.after(2);
  assert.equal(r.chat.sent.length, 2);
  await r.after(1);
  r.chat.turnEnds('s1'); // the turn the nudge started ends a minute later
  await r.after(3);
  assert.equal(r.chat.sent.length, 2, 'at least 10 minutes between two nudges');
  await r.after(7);
  assert.equal(r.chat.sent.length, 3);
});

test('a tool approval is never answered: reported once after 10 minutes (one ticket, one notification); again later as a comment on the open ticket', async () => {
  const r = await rig();
  r.chat.put('s1');
  r.on('s1');
  r.chat.waitFor('s1', { requestId: 'r1' });
  for (let i = 0; i < 9; i++) await r.after(1);
  assert.equal(r.tickets.made.length, 0, 'not before 10 minutes');
  await r.after(1);
  for (let i = 0; i < 30; i++) await r.after(1);
  assert.equal(r.chat.answers.length, 0, 'never answered');
  assert.equal(r.chat.sent.length, 0, 'never nudged while it waits');
  assert.equal(r.tickets.made.length, 1);
  const [t] = r.tickets.made;
  assert.equal(t!.type, 'bug');
  assert.equal(t!.priority, 'high');
  assert.deepEqual(t!.tags, ['watchdog']);
  assert.match(t!.summary, /^CANARY-TITLE chat: a tool approval waits since \d\d:\d\d UTC$/);
  assert.ok(t!.description.includes('mode default'));
  assert.ok(t!.description.includes('Bash: Run a command'));
  assert.ok(!t!.description.includes('CANARY-COMMAND'), 'never what the command is');
  assert.equal(r.emitted.length, 1);
  const n = r.emitted[0]!;
  assert.equal(n.kind, 'keepgoing_attention');
  assert.deepEqual(n.facts, { workspace: 'api-dev', what: 'approval', ticket: 'T-1' });
  assert.deepEqual(n.audience, ['u_a']);
  const shown = render(n as never);
  assert.equal(shown.title, 'Keep going');
  assert.equal(shown.body, 'api-dev · a tool approval waits · T-1');
  assert.ok(!shown.body.includes('CANARY'), 'the title is detail, only where a destination asked');
  // A person answers; later another approval waits 10 minutes: the cause had cleared, so it is reported again, on the open ticket.
  r.chat.open.set('s1', []);
  r.chat.turnEnds('s1');
  r.chat.patch('s1', { state: 'working' });
  await r.after(1);
  r.chat.waitFor('s1', { requestId: 'r2' });
  for (let i = 0; i < 10; i++) await r.after(1);
  assert.equal(r.tickets.made.length, 1, 'still one ticket');
  assert.equal(r.tickets.comments.length, 1);
  assert.equal(r.tickets.comments[0]!.id, 'T-1');
  assert.equal(r.emitted.length, 2);
});

test('a question is answered "decide yourself" (a deny with the note, as the portal), once', async () => {
  const r = await rig();
  r.chat.put('s1');
  r.on('s1');
  r.chat.waitFor('s1', { requestId: 'q1', kind: 'question', toolName: 'AskUserQuestion', title: 'Answer a question' });
  await r.engine.round();
  assert.deepEqual(r.chat.answers, [{ id: 's1', requestId: 'q1', decision: 'deny', actor: KEEPGOING_ACTOR }]);
  assert.equal(r.engine.view('s1')!.last?.kind, 'answered');
  await r.after(1);
  assert.equal(r.chat.answers.length, 1);
  assert.equal(r.tickets.made.length, 0, 'a question is not a report');
});

test('an interrupted chat is woken, then told to continue at once on the next round', async () => {
  const r = await rig();
  r.chat.put('s1', { state: 'interrupted', process: 'gone', endedReason: 'Claude Code stopped' });
  r.on('s1');
  await r.engine.round();
  assert.deepEqual(r.chat.resumed, ['s1']);
  assert.equal(r.chat.sent.length, 0, 'one decision per round');
  assert.equal(r.engine.view('s1')!.wakesToday, 1);
  await r.after(1);
  assert.equal(r.chat.sent.length, 1, 'continued without waiting for the idle minutes');
  assert.equal(r.engine.view('s1')!.last?.reason, 'Woken: told to continue.');
});

test('an asleep chat is woken only when a nudge is due', async () => {
  const r = await rig();
  r.chat.put('s1', { process: 'asleep' });
  r.on('s1');
  await r.after(1);
  assert.equal(r.chat.resumed.length, 0);
  await r.after(3);
  assert.deepEqual(r.chat.resumed, ['s1']);
  await r.after(1);
  assert.equal(r.chat.sent.length, 1);
});

test('the caps: at most maxNudgesPerDay nudges in 24 h, then one capped row and one report; a failed wake backs off and is reported once', async () => {
  const r = await rig();
  r.chat.put('s1');
  r.on('s1', { maxNudgesPerDay: 2, nudgeAfterMin: 1 });
  for (let i = 0; i < 6; i++) {
    await r.after(10);
    r.chat.turnEnds('s1');
  }
  assert.equal(r.chat.sent.length, 2);
  assert.equal(r.kg.count('s1', 'capped', '1970-01-01T00:00:00.000Z'), 1, 'one capped row');
  assert.equal(r.tickets.made.length, 1);
  assert.match(r.tickets.made[0]!.summary, /cap reached/);
  // A day later the nudges count again.
  await r.after(24 * 60);
  r.chat.turnEnds('s1');
  await r.after(10);
  assert.equal(r.chat.sent.length, 3);

  const w = await rig();
  w.chat.put('s2', { state: 'interrupted', process: 'gone' });
  w.chat.failResume = 'the workspace is down';
  w.on('s2');
  await w.engine.round();
  assert.equal(w.chat.resumed.length, 1);
  for (let i = 0; i < 14; i++) await w.after(1);
  assert.equal(w.chat.resumed.length, 1, 'backed off for 15 minutes');
  await w.after(1);
  assert.equal(w.chat.resumed.length, 2);
  assert.equal(w.tickets.made.length, 1, 'could not wake: reported once');
  assert.match(w.tickets.made[0]!.summary, /could not wake/);
});

test('the kill switch: keepgoing.enabled off stops every round; on again resumes', async () => {
  const settings = settingsMap({ [K.enabled]: false });
  const r = await rig({ settings });
  r.chat.put('s1');
  r.on('s1');
  assert.equal(r.engine.view('s1')!.paused, true);
  for (let i = 0; i < 10; i++) assert.equal(await r.after(1), 0);
  assert.equal(r.chat.sent.length, 0);
  settings.set(K.enabled, true);
  await r.after(1);
  assert.equal(r.chat.sent.length, 1);
  assert.equal(r.engine.view('s1')!.paused, false);
});

test('a portal restart in the middle resumes from the stored state: the nudged period, the owed continue, the reports', async () => {
  const first = await rig();
  first.chat.put('s1');
  first.chat.sendStartsTurn = false;
  first.chat.put('s2', { state: 'interrupted', process: 'gone' });
  first.chat.put('s3', { state: 'ended', endedReason: 'integrity: a second control response' });
  first.on('s1');
  first.on('s2');
  first.on('s3');
  await first.after(4);
  assert.equal(first.chat.sent.length, 1, 's1 nudged');
  assert.deepEqual(first.chat.resumed, ['s2'], 's2 woken');
  assert.equal(first.tickets.made.length, 1, 's3 reported');
  first.engine.stop();
  // A new engine over the same database (the portal restarted), the same chats, tickets and clock.
  const again = await rig({ store: first.store, clock: first.clock, chat: first.chat, tickets: first.tickets });
  await again.after(1);
  assert.equal(first.chat.sent.filter((x) => x.id === 's2').length, 1, 's2: the continue owed after the wake goes out');
  for (let i = 0; i < 10; i++) await again.after(1);
  assert.equal(first.chat.sent.filter((x) => x.id === 's1').length, 1, 's1: the same idle period is not nudged again');
  assert.equal(first.tickets.made.length, 1, 's3: not reported again');
});

test('an ended chat is reported once with one ticket; down after 15 minutes is a comment on it; a person’s close turns the policy off', async () => {
  const r = await rig();
  r.chat.put('s1', { state: 'ended', process: 'gone', endedReason: 'integrity: origin peer after a sub-agent message' });
  r.on('s1');
  await r.engine.round();
  for (let i = 0; i < 14; i++) await r.after(1);
  assert.equal(r.tickets.made.length, 1);
  assert.match(r.tickets.made[0]!.summary, /: ended since/);
  assert.ok(r.tickets.made[0]!.description.includes('- Ended: integrity: origin peer'));
  assert.equal(r.emitted.length, 1);
  await r.after(1); // 15 minutes
  assert.equal(r.tickets.made.length, 1, 'down is not a second ticket');
  assert.equal(r.tickets.comments.length, 1);
  assert.match(r.tickets.comments[0]!.text, /^Still not running: down since/);
  assert.equal(r.emitted.length, 2);
  for (let i = 0; i < 30; i++) await r.after(1);
  assert.equal(r.emitted.length, 2, 'not repeated while it stands');

  const p = await rig();
  p.chat.put('s2', { state: 'ended', process: 'gone', endedReason: 'closed by operator' });
  p.on('s2');
  await p.engine.round();
  assert.equal(p.tickets.made.length, 0);
  assert.equal(p.emitted.length, 0);
  assert.equal(p.engine.view('s2')!.enabled, false);
  assert.equal(p.engine.view('s2')!.last?.kind, 'stood_down');
});

test('out of Bypass on a bypass-capable chat is reported once, never re-entered; the chat is still nudged', async () => {
  const r = await rig();
  r.chat.put('s1', { bypassCapable: true, mode: 'default' });
  r.on('s1');
  await r.engine.round();
  assert.equal(r.tickets.made.length, 1);
  assert.match(r.tickets.made[0]!.summary, /out of Bypass/);
  await r.after(4);
  assert.equal(r.chat.sent.length, 1);
  assert.equal(r.chat.get('s1')!.mode, 'default', 'Keep going never changes the mode');
  for (let i = 0; i < 5; i++) await r.after(1);
  assert.equal(r.tickets.made.length, 1);
  // Back in Bypass: the cause clears.
  r.chat.patch('s1', { mode: 'bypassPermissions' });
  await r.after(1);
  assert.equal(r.kg.standing('s1').length, 0);
});

test('nothing happens to a chat whose owner may no longer operate it, nor to one a move or a restart is busy with', async () => {
  const owner = fakeOwner({}, { fallback: 'u_a', disabled: ['u_a'] });
  const r = await rig({ owner });
  r.chat.put('s1');
  r.on('s1');
  for (let i = 0; i < 6; i++) await r.after(1);
  assert.equal(r.chat.sent.length, 0);

  const m = await rig();
  m.chat.put('s1', { switching: { toClaude: 'Home', step: 'starting' } });
  m.on('s1');
  for (let i = 0; i < 6; i++) await m.after(1);
  assert.equal(m.chat.sent.length, 0);
  m.chat.patch('s1', { switching: null, restarting: true });
  await m.after(1);
  assert.equal(m.chat.sent.length, 0);
});

test('a policy that is off is never looked at; a chat that is gone turns its policy off', async () => {
  const r = await rig();
  r.chat.put('s1');
  r.engine.set('s1', 'u_a', 'user:u_a', { enabled: false });
  for (let i = 0; i < 6; i++) assert.equal(await r.after(1), 0);
  r.on('gone');
  await r.after(1);
  assert.equal(r.engine.view('gone')!.enabled, false);
});
