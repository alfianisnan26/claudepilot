// T-3189: Keep going does not nudge a chat that has nothing to act on. A drained chat (it holds tickets, none open or in progress, nothing
// changed on them since its last activity, no worker of it runs) is not nudged and not woken, its cap is not spent, and one `drained` trail
// row per idle period says so. A comment, a verdict, a status change or a new assignment on its tickets nudges it again; an open ticket, a
// live worker or a chat that never held a ticket keeps today's behaviour.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rig } from './testkit.js';

const ago = (r: Awaited<ReturnType<typeof rig>>, min: number) => new Date(r.clock.now() - min * 60_000).toISOString();
const nowIso = (r: Awaited<ReturnType<typeof rig>>) => new Date(r.clock.now()).toISOString();
const drainedRows = (r: Awaited<ReturnType<typeof rig>>, id: string) => r.kg.events(id, 500).filter((e) => e.kind === 'drained');

/** A lead whose tickets all wait on others (in review, blocked, one done), changed before its last activity. */
async function drainedLead() {
  const r = await rig();
  const t1 = r.tickets.hold('lead', 'in_review', ago(r, 30));
  const t2 = r.tickets.hold('lead', 'blocked', ago(r, 20));
  r.tickets.hold('lead', 'done', ago(r, 10));
  r.chat.put('lead');
  r.on('lead', { nudgeAfterMin: 4 });
  return { r, t1, t2 };
}

test('(a) all tickets in review or blocked: no nudge for 6 hours, the cap count stays 0, one drained row (info) per idle period, no report', async () => {
  const { r } = await drainedLead();
  for (let i = 0; i < 6 * 60; i++) await r.after(1);
  assert.equal(r.chat.sent.length, 0, 'never nudged');
  assert.equal(r.engine.view('lead')!.nudgesToday, 0, 'the cap is not spent');
  assert.deepEqual(r.engine.last.get('lead'), { act: 'none', why: 'drained' });
  assert.equal(drainedRows(r, 'lead').length, 1, 'once per drained period, not every loop');
  assert.equal(r.engine.view('lead')!.last?.kind, 'drained');
  const audit = r.auditRows('keepgoing.drained');
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.severity, 'info');
  assert.equal(r.auditRows('keepgoing.capped').length, 0);
  assert.equal(r.tickets.made.length, 0, 'no watchdog ticket');
  assert.equal(r.emitted.length, 0, 'no notification');

  // The chat did something by itself (a message from elsewhere), still nothing new on its tickets: a new idle period, one more row.
  r.chat.turnEnds('lead');
  for (let i = 0; i < 30; i++) await r.after(1);
  assert.equal(r.chat.sent.length, 0);
  assert.equal(drainedRows(r, 'lead').length, 2);
});

test('(b) a comment or verdict, a status change, or a new assignment on its tickets nudges it again at the next loop', async () => {
  const { r, t1, t2 } = await drainedLead();
  for (let i = 0; i < 10; i++) await r.after(1);
  assert.equal(r.chat.sent.length, 0);

  // A comment or a verdict lands on an in-review ticket (it moves updated_at): nudged at the next loop.
  r.tickets.touch(t1, nowIso(r));
  await r.after(1);
  assert.equal(r.chat.sent.length, 1, 'nudged after the comment');
  assert.equal(r.engine.view('lead')!.nudgesToday, 1);

  // The turn the nudge started ends; nothing new since: drained again, no second nudge.
  await r.after(2);
  r.chat.turnEnds('lead');
  for (let i = 0; i < 30; i++) await r.after(1);
  assert.equal(r.chat.sent.length, 1, 'the chat saw it: drained again');

  // A status change (blocked to in review) on another of its tickets: nudged again.
  r.tickets.touch(t2, nowIso(r), 'in_review');
  await r.after(1);
  assert.equal(r.chat.sent.length, 2, 'nudged after the status change');
  await r.after(2);
  r.chat.turnEnds('lead');
  for (let i = 0; i < 30; i++) await r.after(1);
  assert.equal(r.chat.sent.length, 2);

  // A ticket newly assigned to it, even one put straight in review: nudged.
  r.tickets.hold('lead', 'in_review', nowIso(r));
  await r.after(1);
  assert.equal(r.chat.sent.length, 3, 'nudged after the new assignment');
});

test('(c) a chat with an open or in-progress ticket is still nudged; so is one with a live worker, or a sub-agent; an ended worker does not count', async () => {
  const r = await rig();
  r.tickets.hold('open', 'in_review', ago(r, 30));
  r.tickets.hold('open', 'open', ago(r, 30));
  r.chat.put('open');
  r.on('open', { nudgeAfterMin: 4 });

  r.tickets.hold('crew', 'in_review', ago(r, 30));
  r.chat.put('crew');
  r.chat.put('crew-w1', { parentId: 'crew', state: 'idle' });
  r.on('crew', { nudgeAfterMin: 4 });

  r.tickets.hold('gone', 'blocked', ago(r, 30));
  r.chat.put('gone');
  r.chat.put('gone-w1', { parentId: 'gone', state: 'ended' });
  r.on('gone', { nudgeAfterMin: 4 });

  for (let i = 0; i < 4; i++) await r.after(1);
  const nudged = r.chat.sent.map((x) => x.id).sort();
  assert.deepEqual(nudged, ['crew', 'open'], 'the open ticket and the live worker are nudged; the chat whose worker ended is drained');
  assert.deepEqual(r.engine.last.get('gone'), { act: 'none', why: 'drained' });
});

test('(d) a chat that never held a ticket keeps today’s behaviour: nudged after nudgeAfterMin, every idle period, up to the cap', async () => {
  const r = await rig();
  r.chat.put('s1');
  r.on('s1', { nudgeAfterMin: 4, maxNudgesPerDay: 2 });
  for (let i = 0; i < 4; i++) await r.after(1);
  assert.equal(r.chat.sent.length, 1);
  await r.after(1);
  r.chat.turnEnds('s1');
  for (let i = 0; i < 10; i++) await r.after(1);
  assert.equal(r.chat.sent.length, 2);
  await r.after(1);
  r.chat.turnEnds('s1');
  for (let i = 0; i < 10; i++) await r.after(1);
  assert.equal(r.chat.sent.length, 2, 'capped as before');
  assert.equal(r.auditRows('keepgoing.capped').length, 1);
  assert.equal(r.kg.events('s1', 100).filter((e) => e.kind === 'drained').length, 0);
});

test('a drained chat that is asleep is not woken (nor the wake counted); an interrupted one still is', async () => {
  const r = await rig();
  r.tickets.hold('sleepy', 'in_review', ago(r, 30));
  r.chat.put('sleepy', { process: 'asleep' });
  r.on('sleepy', { nudgeAfterMin: 4 });
  r.tickets.hold('cut', 'in_review', ago(r, 30));
  r.chat.put('cut', { state: 'interrupted' });
  r.on('cut', { nudgeAfterMin: 4 });
  for (let i = 0; i < 20; i++) await r.after(1);
  assert.deepEqual(r.chat.resumed, ['cut'], 'only the interrupted chat is woken');
  assert.equal(r.engine.view('sleepy')!.wakesToday, 0);
  assert.equal(r.engine.view('sleepy')!.nudgesToday, 0);
});
