// The flow watchdog (T-1966): every condition, the rate limit, successor resolution, no message to an ended session, the owner told only
// after a stall persists, and the switches. On the fake clock; the chat and the tickets are in memory.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLOW_ACTOR, FLOW_PREFIX } from '@portal/contracts';
import { headOf } from './engine.js';
import { parsePrograms } from './programs.js';
import { LEAD_A, LEAD_B, LEAD_C, rig, sha } from './testkit.js';

const MIN = 60_000;
const ago = (r: ReturnType<typeof rig>, min: number) => new Date(r.clock.now() - min * MIN).toISOString();

/** Three live leads (A merges), each with a worker. */
function crew(r: ReturnType<typeof rig>) {
  for (const id of [LEAD_A, LEAD_B, LEAD_C]) r.chat.put(id, { state: 'working', lastActivityAt: ago(r, 1) });
  r.chat.put('wa', { parentId: LEAD_A, state: 'ended' });
  r.chat.put('wb', { parentId: LEAD_B, state: 'ended' });
  r.chat.put('wc', { parentId: LEAD_C, state: 'ended' });
}

test('(a) a QA PASS on the head not merged after 20 min: the merge-gate lead gets the exact list, queued, as portal:flow', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(12, { holder: 'wb' });
  r.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(r, 25) });
  r.tickets.add(13, { holder: 'wb' });
  r.tickets.verdict('T-13', { role: 'qa', verdict: 'pass', commit: sha('b'), at: ago(r, 10) }); // too fresh
  await r.engine.round();
  assert.equal(r.chat.sent.length, 1);
  const m = r.chat.sent[0]!;
  assert.equal(m.id, LEAD_A);
  assert.equal(m.priority, 'later');
  assert.equal(m.actor, FLOW_ACTOR);
  assert.ok(m.text.startsWith(FLOW_PREFIX));
  assert.match(m.text, new RegExp(`- T-12 \\(KONF-12\\) QA PASS on ${sha('a')} \\(newest seen\\)`));
  assert.match(m.text, /Check that commit is still the branch head/);
  assert.doesNotMatch(m.text, /T-13/);
  assert.doesNotMatch(m.text, /CANARY/); // no ticket or session text in a message
  assert.equal(r.engine.snapshot().programs[0]!.counts.merge, 1);
  assert.ok(r.audits.some((a) => a.kind === 'flow.told' && a.actor === FLOW_ACTOR));
});

test('(a) a PASS on an older commit is stale: a newer CI check moved the head, so it is not ready to merge', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(12, { holder: 'wb', updatedAt: ago(r, 5) });
  r.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(r, 40) });
  r.tickets.checksOf.set('T-12', [{ name: 'gate', state: 'passed', runId: null, commit: sha('c').slice(0, 12), link: null, updatedAt: ago(r, 30) }]);
  await r.engine.round();
  assert.equal(r.chat.sent.length, 0);
  assert.equal(r.engine.snapshot().programs[0]!.counts.merge, 0);
});

test('headOf: the newest commit heard of; a short sha widens to the verdict it begins', () => {
  const v = (c: string, at: string) => ({ id: 1, role: 'qa' as const, verdict: 'pass' as const, commit: c, actor: 'x', at });
  const chk = (c: string, at: string) => ({ name: 'gate', state: 'passed' as const, runId: null, commit: c, link: null, updatedAt: at });
  assert.equal(headOf([], []), null);
  assert.equal(headOf([v(sha('a'), '2026-01-01T00:00:00Z')], [chk(sha('a').slice(0, 9), '2026-01-01T01:00:00Z')]), sha('a'));
  assert.equal(headOf([v(sha('a'), '2026-01-01T00:00:00Z')], [chk('1234567', '2026-01-01T01:00:00Z')]), '1234567');
  assert.equal(headOf([v(sha('a'), '2026-01-01T02:00:00Z')], [chk(sha('b'), '2026-01-01T01:00:00Z')]), sha('a'));
});

test('(b) no verdict and nobody on it for 60 min: QA-ASK to peer leads round robin, never the author’s lead', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(20, { holder: 'wb' }); // B's unit: asked of A or C
  r.tickets.add(21, { holder: 'wb' });
  r.tickets.add(22, { holder: 'wa' }); // A's unit
  await r.engine.round();
  const asks = r.chat.sent.filter((m) => m.text.includes('QA-ASK'));
  assert.ok(asks.length >= 1);
  for (const m of asks) {
    if (m.text.includes('T-20') || m.text.includes('T-21')) assert.notEqual(m.id, LEAD_B);
    if (m.text.includes('T-22')) assert.notEqual(m.id, LEAD_A);
  }
  // T-20 and T-21 went to different leads (round robin), each ticket to exactly one lead.
  const holderOf = (t: string) => asks.filter((m) => m.text.includes(`${t} (`)).map((m) => m.id);
  assert.equal(holderOf('T-20').length, 1);
  assert.equal(holderOf('T-21').length, 1);
  assert.equal(holderOf('T-22').length, 1);
  assert.notEqual(holderOf('T-20')[0], holderOf('T-21')[0]);
  assert.equal(r.engine.snapshot().programs[0]!.counts.qa, 3);
});

test('(b) the author’s lineage is skipped: a worker of a CONTINUED lead belongs to its live continuation', async () => {
  const r = rig({ settings: { 'tickets.leadPeerGroups': `${LEAD_A},${LEAD_B}` } });
  r.chat.put(LEAD_A, { state: 'working' });
  r.chat.put(LEAD_B, { state: 'ended' });
  r.chat.put('b2', { continuedFrom: LEAD_B, state: 'working' });
  r.chat.put('wold', { parentId: LEAD_B, state: 'ended' }); // started by B before it was continued
  r.tickets.add(30, { holder: 'wold' });
  await r.engine.round();
  const asks = r.chat.sent.filter((m) => m.text.includes('QA-ASK'));
  assert.equal(asks.length, 1);
  assert.equal(asks[0]!.id, LEAD_A);
});

test('(b) a live session working on the ticket, a verdict on the head, or a recent update: nobody is asked', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(40, { holder: 'wb' });
  r.chat.put('qa40', { ticketId: 'T-40', state: 'working', parentId: LEAD_A });
  r.tickets.add(41, { holder: 'wb' });
  r.tickets.verdict('T-41', { role: 'qa', verdict: 'fail', commit: sha('d'), at: ago(r, 90) });
  r.tickets.add(42, { holder: 'wb', updatedAt: ago(r, 30) });
  await r.engine.round();
  assert.equal(r.chat.sent.filter((m) => m.text.includes('QA-ASK')).length, 0);
});

test('(c) an idle lead with open work in its unit and room under its cap gets its next tickets, oldest high priority first', async () => {
  const r = rig();
  crew(r);
  r.chat.patch(LEAD_B, { state: 'idle', lastActivityAt: ago(r, 45) });
  r.chat.put('wb2', { parentId: LEAD_B, state: 'working' });
  r.tickets.add(50, { holder: 'wb', status: 'open', priority: 'normal', createdAt: ago(r, 500) });
  r.tickets.add(51, { holder: LEAD_B, status: 'open', priority: 'urgent', createdAt: ago(r, 100) });
  r.tickets.add(52, { holder: 'wb', status: 'in_progress', priority: 'urgent', createdAt: ago(r, 300) });
  r.tickets.add(53, { holder: 'wa', status: 'open', priority: 'urgent' }); // A's unit, not B's
  await r.engine.round();
  const m = r.chat.sent.find((x) => x.id === LEAD_B);
  assert.ok(m, 'the idle lead is told');
  assert.match(m.text, /idle 45 min/);
  assert.match(m.text, /runs 1 of 4 workers/);
  const order = [...m.text.matchAll(/- (T-\d+) /g)].map((x) => x[1]);
  assert.deepEqual(order, ['T-52', 'T-51', 'T-50']);
  assert.equal(r.engine.snapshot().programs[0]!.counts.idle, 1);
});

test('(c) not told: working, waiting on a person, idle under the threshold, at its cap, or no open work', async () => {
  for (const setup of [
    (r: ReturnType<typeof rig>) => r.chat.patch(LEAD_B, { state: 'working', lastActivityAt: ago(r, 45) }),
    (r: ReturnType<typeof rig>) => r.chat.patch(LEAD_B, { state: 'idle', waiting: 1, lastActivityAt: ago(r, 45) }),
    (r: ReturnType<typeof rig>) => r.chat.patch(LEAD_B, { state: 'idle', lastActivityAt: ago(r, 20) }),
    (r: ReturnType<typeof rig>) => {
      r.chat.patch(LEAD_B, { state: 'idle', lastActivityAt: ago(r, 45) });
      r.chat.cap = 1;
      r.chat.put('wb2', { parentId: LEAD_B, state: 'working' });
    },
    (r: ReturnType<typeof rig>) => {
      r.chat.patch(LEAD_B, { state: 'idle', lastActivityAt: ago(r, 45) });
      r.tickets.items.splice(0);
    },
  ]) {
    const r = rig();
    crew(r);
    r.tickets.add(50, { holder: 'wb', status: 'open' });
    setup(r);
    await r.engine.round();
    assert.equal(r.chat.sent.filter((x) => x.id === LEAD_B).length, 0);
  }
});

test('rate limit: one message per lead per condition per 30 min, across rounds and restarts', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(12, { holder: 'wb' });
  r.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(r, 25) });
  await r.engine.round();
  r.clock.advance(5);
  await r.engine.round();
  r.restart(); // the limit is stored: a restart does not reset it
  r.clock.advance(20);
  await r.engine.round();
  assert.equal(r.chat.sent.length, 1);
  r.clock.advance(6); // 31 min after the first
  await r.engine.round();
  assert.equal(r.chat.sent.length, 2);
  // A merge message does not hold back an idle message to the same lead: the limit is per condition.
  r.chat.patch(LEAD_A, { state: 'idle', lastActivityAt: ago(r, 40) });
  r.tickets.add(60, { holder: 'wa', status: 'open' });
  await r.engine.round();
  assert.equal(r.chat.sent.filter((m) => m.id === LEAD_A && m.text.includes('Your next tickets')).length, 1);
});

test('successor resolution: an ended lead is followed to its live continuation (and a Move’s successor)', async () => {
  const r = rig();
  crew(r);
  r.chat.patch(LEAD_A, { state: 'ended' });
  r.chat.put('a2', { continuedFrom: LEAD_A, state: 'ended', successorId: 'a3', createdAt: ago(r, 60) });
  r.chat.put('a3', { predecessorId: 'a2', state: 'working', createdAt: ago(r, 30) });
  r.tickets.add(12, { holder: 'wb' });
  r.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(r, 25) });
  await r.engine.round();
  assert.deepEqual(
    r.chat.sent.map((m) => m.id),
    ['a3'],
  );
  assert.equal(r.engine.snapshot().programs[0]!.mergeGateLive, 'a3');
});

test('never a message to an ended session: a lead with no live continuation is skipped and recorded once', async () => {
  const r = rig();
  crew(r);
  r.chat.patch(LEAD_A, { state: 'ended' });
  r.tickets.add(12, { holder: 'wb' });
  r.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(r, 25) });
  await r.engine.round();
  r.clock.advance(5);
  await r.engine.round();
  assert.equal(r.chat.sent.filter((m) => m.id === LEAD_A).length, 0);
  const skipped = r.engine.snapshot().actions.filter((a) => a.condition === 'merge' && a.kind === 'skipped');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0]!.note, /no live session/);
});

test('the owner must be able to operate the session; a refused send is recorded as failed', async () => {
  const r = rig({ ownerCan: false });
  crew(r);
  r.tickets.add(12, { holder: 'wb' });
  r.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(r, 25) });
  await r.engine.round();
  assert.equal(r.chat.sent.length, 0);
  assert.equal(r.engine.snapshot().actions[0]!.kind, 'skipped');

  const f = rig();
  crew(f);
  f.chat.failSend = 'busy';
  f.tickets.add(12, { holder: 'wb' });
  f.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(f, 25) });
  await f.engine.round();
  assert.ok(f.engine.snapshot().actions.some((a) => a.kind === 'failed' && a.condition === 'merge'));
  assert.ok(f.audits.some((a) => a.kind === 'flow.failed'));
});

test('(d) a lead out of Bypass is reported, never messaged; a person’s own exit and a kept sleep are not', async () => {
  const r = rig();
  crew(r);
  r.chat.bypass.set(LEAD_B, { sessionId: LEAD_B, kind: 'bypass.left', actor: 'portal', at: ago(r, 10), detail: { why: 'restart' } });
  r.chat.bypass.set(LEAD_C, { sessionId: LEAD_C, kind: 'bypass.left', actor: 'ui', at: ago(r, 10), detail: {} });
  r.chat.patch(LEAD_A, { process: 'asleep' });
  r.chat.bypass.set(LEAD_A, { sessionId: LEAD_A, kind: 'bypass.left', actor: 'portal', at: ago(r, 10), detail: { why: 'sleep', kept: true } });
  await r.engine.round();
  assert.equal(r.chat.sent.length, 0);
  const rep = r.engine.snapshot().actions.filter((a) => a.condition === 'bypass');
  assert.deepEqual(
    rep.map((a) => [a.kind, a.sessionId]),
    [['reported', LEAD_B]],
  );
  assert.equal(r.engine.snapshot().programs[0]!.counts.bypass, 1);
  // A continuation started without Bypass after an ended Bypass lead counts as lost too.
  const c = rig();
  crew(c);
  c.chat.patch(LEAD_B, { state: 'ended' });
  c.chat.put('b2', { continuedFrom: LEAD_B, state: 'working' });
  c.chat.bypass.set(LEAD_B, { sessionId: LEAD_B, kind: 'bypass.entered', actor: 'ui', at: ago(c, 100), detail: {} });
  await c.engine.round();
  assert.equal(c.engine.snapshot().programs[0]!.counts.bypass, 1);
  assert.equal(c.engine.snapshot().actions.find((a) => a.condition === 'bypass')!.sessionId, 'b2');
});

test('(e) a stall tells the owner only once it lasts 3 h after the first nudge, and only once', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(70, { holder: 'wb' });
  r.tickets.add(71, { holder: 'wb', status: 'done', closedAt: ago(r, 200) }); // outside the 3 h window
  await r.engine.round(); // the QA-ASK is the first nudge
  assert.ok(r.chat.sent.length >= 1);
  assert.equal(r.engine.snapshot().programs[0]!.counts.stall, 1);
  r.clock.advance(175);
  await r.engine.round();
  assert.equal(r.notes.length, 0);
  r.clock.advance(5); // 3 h after the nudge
  await r.engine.round();
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0]!.facts.what, 'flow_stalled');
  assert.equal(r.notes[0]!.facts.inReview, 1);
  assert.deepEqual(r.notes[0]!.audience, ['u_a']);
  r.clock.advance(120);
  await r.engine.round();
  assert.equal(r.notes.length, 1);
  // A ticket done clears the stall; a new stall starts over.
  r.tickets.items.find((t) => t.id === 'T-71')!.closedAt = new Date(r.clock.now()).toISOString();
  await r.engine.round();
  assert.equal(r.engine.snapshot().programs[0]!.stallSince, null);
});

test('(e) no stall while something was done recently, or nothing waits in review', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(70, { holder: 'wb' });
  r.tickets.add(71, { holder: 'wb', status: 'done', closedAt: ago(r, 60) });
  await r.engine.round();
  r.clock.advance(400);
  r.tickets.items.find((t) => t.id === 'T-71')!.closedAt = new Date(r.clock.now()).toISOString();
  await r.engine.round();
  assert.equal(r.notes.length, 0);
  assert.equal(r.engine.snapshot().programs[0]!.counts.stall, 0);
});

test('switches: off, a program set off, or a read-only store: nothing is looked at or sent', async () => {
  const off = rig({ settings: { 'flow.enabled': false } });
  crew(off);
  off.tickets.add(12, { holder: 'wb' });
  off.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(off, 25) });
  assert.equal(await off.engine.round(), 0);
  assert.equal(off.chat.sent.length, 0);
  assert.equal(off.engine.snapshot().enabled, false);

  const prog = rig({ settings: { 'flow.programs': 'konfersi|konfersi-migration|||off' } });
  crew(prog);
  prog.tickets.add(12, { holder: 'wb' });
  prog.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(prog, 25) });
  await prog.engine.round();
  assert.equal(prog.chat.sent.length, 0);
  assert.equal(prog.engine.snapshot().programs[0]!.enabled, false);

  const ro = rig();
  crew(ro);
  ro.store.writable = false;
  ro.tickets.add(12, { holder: 'wb' });
  ro.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(ro, 25) });
  await ro.engine.round();
  assert.equal(ro.chat.sent.length, 0);
});

test('the program’s leads: an explicit group, else the first group whose leads hold its tickets', async () => {
  const D = 'dddddddd-0000-0000-0000-00000000000d';
  const E = 'eeeeeeee-0000-0000-0000-00000000000e';
  const r = rig({ settings: { 'tickets.leadPeerGroups': `${LEAD_A},${LEAD_B};${D},${E}` } });
  for (const id of [LEAD_A, LEAD_B, D, E]) r.chat.put(id, { state: 'working' });
  r.chat.put('we', { parentId: E, state: 'ended' });
  r.tickets.add(12, { holder: 'we' });
  r.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(r, 25) });
  await r.engine.round();
  assert.deepEqual(r.engine.snapshot().programs[0]!.leads, [D, E]);
  assert.equal(r.chat.sent[0]!.id, D); // the first lead of the matching group is the merge gate

  const g = rig({ settings: { 'tickets.leadPeerGroups': `${LEAD_A},${LEAD_B};${D},${E}`, 'flow.programs': `konfersi|konfersi-migration|1|${LEAD_B}` } });
  for (const id of [LEAD_A, LEAD_B, D, E]) g.chat.put(id, { state: 'working' });
  g.tickets.add(12, { holder: D });
  g.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(g, 25) });
  await g.engine.round();
  assert.deepEqual(g.engine.snapshot().programs[0]!.leads, [LEAD_A, LEAD_B]);
  assert.equal(g.chat.sent[0]!.id, LEAD_B);
});

test('parsePrograms: fields checked, malformed ones dropped (fail closed)', () => {
  assert.deepEqual(parsePrograms('konfersi|konfersi-migration||'), [{ name: 'konfersi', tag: 'konfersi-migration', group: null, mergeGate: null, enabled: true }]);
  assert.deepEqual(parsePrograms(`a|t1|2|${LEAD_A}|off; b|t2`), [
    { name: 'a', tag: 't1', group: 2, mergeGate: LEAD_A, enabled: false },
    { name: 'b', tag: 't2', group: null, mergeGate: null, enabled: true },
  ]);
  for (const bad of ['', 'Bad|tag', 'a|Tag!', 'a|t|x', 'a|t||not an id', 'a|t|||maybe', 'a|t|||on|extra']) assert.deepEqual(parsePrograms(bad), [], bad);
  assert.deepEqual(parsePrograms(42), []);
});

/** A merge-ready ticket of B's unit (A is the merge gate). */
function mergeReady(r: ReturnType<typeof rig>) {
  crew(r);
  r.tickets.add(12, { holder: 'wb' });
  r.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(r, 25) });
}

test('a lead a person stopped is never messaged: skipped and recorded once per window; QA goes to another peer', async () => {
  const r = rig();
  mergeReady(r);
  r.chat.stopped.add(LEAD_A);
  r.tickets.add(20, { holder: 'wb' }); // QA-ASK: A or C, A is stopped
  r.tickets.add(21, { holder: 'wb' });
  await r.engine.round();
  r.clock.advance(5);
  await r.engine.round();
  assert.equal(r.chat.sent.filter((m) => m.id === LEAD_A).length, 0);
  const skips = r.engine.snapshot().actions.filter((a) => a.kind === 'skipped' && a.condition === 'merge');
  assert.equal(skips.length, 1);
  assert.match(skips[0]!.note, /A person stopped this lead/);
  const asks = r.chat.sent.filter((m) => m.text.includes('QA-ASK'));
  assert.ok(asks.length >= 1);
  assert.ok(asks.every((m) => m.id === LEAD_C));
});

test('a lead a person closed is not raised through a portal-made continuation; one a person started is followed', async () => {
  const r = rig();
  mergeReady(r);
  r.chat.patch(LEAD_A, { state: 'ended', endedReason: 'Closed by operator' });
  r.chat.put('a2', { continuedFrom: LEAD_A, state: 'working', startedBy: 'portal:keepgoing' });
  await r.engine.round();
  assert.equal(r.chat.sent.length, 0);
  assert.match(r.engine.snapshot().actions.find((a) => a.condition === 'merge')!.note, /A person closed the lead/);

  const p = rig();
  mergeReady(p);
  p.chat.patch(LEAD_A, { state: 'ended', endedReason: 'Closed by operator' });
  p.chat.put('a2', { continuedFrom: LEAD_A, state: 'working', startedBy: 'ui' });
  await p.engine.round();
  assert.deepEqual(
    p.chat.sent.map((m) => m.id),
    ['a2'],
  );
});

test('Keep going’s pause for a lead’s own program skips that lead (recorded)', async () => {
  const r = rig();
  mergeReady(r);
  r.kg.programs.set(LEAD_A, 'orchestrator');
  r.kg.pauses.push({ program: 'orchestrator' });
  await r.engine.round();
  assert.equal(r.chat.sent.length, 0);
  assert.match(r.engine.snapshot().actions[0]!.note, /Keep going is paused for this lead/);
  assert.equal(r.engine.snapshot().programs[0]!.paused, null); // the program itself is not held
});

test('the program pause holds the watchdog: Flow’s own (by name or *) and Keep going’s (all, or the program’s name)', async () => {
  const holds: [string, (r: ReturnType<typeof rig>) => void, string][] = [
    ['flow by name', (r) => r.settings.set('flow.paused', 'konfersi'), 'flow'],
    ['flow all', (r) => r.settings.set('flow.paused', '*'), 'flow'],
    ['keepgoing all', (r) => r.kg.pauses.push({ program: null }), 'keepgoing'],
    ['keepgoing by name', (r) => r.kg.pauses.push({ program: 'konfersi' }), 'keepgoing'],
  ];
  for (const [what, hold, by] of holds) {
    const r = rig();
    mergeReady(r);
    r.tickets.add(20, { holder: 'wb' });
    r.chat.bypass.set(LEAD_B, { sessionId: LEAD_B, kind: 'bypass.left', actor: 'portal', at: ago(r, 10), detail: {} });
    hold(r);
    await r.engine.round();
    r.clock.advance(300); // a stall that outlasts the notify window
    await r.engine.round();
    assert.equal(r.chat.sent.length, 0, what);
    assert.equal(r.notes.length, 0, what);
    assert.equal(r.engine.snapshot().actions.length, 0, what);
    const v = r.engine.snapshot().programs[0]!;
    assert.equal(v.paused, by, what);
    assert.equal(v.counts.qa, 1, `${what}: still counted`);
    assert.equal(v.counts.bypass, 1, what);
  }
  // Another program's Flow pause does not hold this one.
  const o = rig({ settings: { 'flow.paused': 'other' } });
  mergeReady(o);
  await o.engine.round();
  assert.equal(o.chat.sent.length, 1);
});

test('the card’s live topic is told after every round', async () => {
  const r = rig();
  await r.engine.round();
  r.clock.advance(5);
  await r.engine.round();
  assert.equal(r.published.length, 2);
});

test('D1: a gone or interrupted lead is never messaged (a send would relaunch it); an asleep one is woken by the message', async () => {
  for (const over of [{ process: 'gone' as const }, { state: 'interrupted' as const }]) {
    const r = rig();
    mergeReady(r);
    r.chat.patch(LEAD_A, over);
    await r.engine.round();
    assert.equal(r.chat.sent.length, 0, JSON.stringify(over));
    assert.match(r.engine.snapshot().actions[0]!.note, /never relaunches/);
  }
  const a = rig();
  mergeReady(a);
  a.chat.patch(LEAD_A, { process: 'asleep', state: 'idle' });
  await a.engine.round();
  assert.deepEqual(
    a.chat.sent.map((m) => m.id),
    [LEAD_A],
  );
});

test('D1: a lead a person stopped stays unmessaged across a portal restart (the hold is read each round)', async () => {
  const r = rig();
  mergeReady(r);
  r.chat.stopped.add(LEAD_A); // the controller answers from its record, which a restart keeps
  await r.engine.round();
  r.restart();
  r.clock.advance(31);
  await r.engine.round();
  assert.equal(r.chat.sent.length, 0);
  assert.equal(r.engine.snapshot().actions.filter((x) => /A person stopped/.test(x.note)).length, 2);
});

test('a merge gate that is not a lead of the group falls back to the first lead', async () => {
  const r = rig({ settings: { 'flow.programs': 'konfersi|konfersi-migration||dddddddd-0000-0000-0000-00000000000d' } });
  mergeReady(r);
  await r.engine.round();
  assert.equal(r.chat.sent[0]!.id, LEAD_A);
});
