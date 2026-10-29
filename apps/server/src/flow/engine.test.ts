// The flow watchdog (T-1966): every condition, the rate limit, successor resolution, no message to an ended session, the owner told only
// after a stall persists, and the switches. On the fake clock; the chat and the tickets are in memory.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLOW_ACTOR, FLOW_PREFIX } from '@portal/contracts';
import { headOf, selfTestAt, type FlowPrView } from './engine.js';
import { giteaPrPort } from './index.js';
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
  assert.match(m.text, new RegExp(`- T-12 \\(KONF-12\\) QA PASS on ${sha('a')} \\(newest seen, no PR status\\)`), 'T-2014: no PR recorded: the old heuristic, labelled');
  assert.match(m.text, /check it is the PR head and record the PR/);
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
  assert.match(m.text, /has 1 of 4 workers working \(1 live\)/);
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

test('(b) T-1987 (D-93): the QA-ASK is a batch: named so, at most 8 tickets per peer per message; the rest wait for the next window', async () => {
  const r = rig({ settings: { 'tickets.leadPeerGroups': `${LEAD_A},${LEAD_B}` } });
  r.chat.put(LEAD_A, { state: 'working', lastActivityAt: ago(r, 1) });
  r.chat.put(LEAD_B, { state: 'working', lastActivityAt: ago(r, 1) });
  r.chat.put('wb', { parentId: LEAD_B, state: 'ended' });
  for (let n = 100; n < 111; n++) r.tickets.add(n, { holder: 'wb' }); // 11 of B's tickets: only A may verify them
  await r.engine.round();
  const asks = r.chat.sent.filter((m) => m.text.includes('QA-ASK'));
  assert.equal(asks.length, 1);
  assert.equal(asks[0]!.id, LEAD_A);
  assert.match(asks[0]!.text, /QA-ASK batch: take these as one qa\/batch branch, one job run, a verdict per ticket \(D-93\)/);
  assert.match(asks[0]!.text, /ticket_verdict_batch/);
  const listed = [...asks[0]!.text.matchAll(/^- (T-\d+) /gm)].map((m) => m[1]);
  assert.deepEqual(listed, ['T-100', 'T-101', 'T-102', 'T-103', 'T-104', 'T-105', 'T-106', 'T-107'], 'eight, oldest first');
  assert.doesNotMatch(asks[0]!.text, /T-108|and \d+ more/);
  assert.equal(r.engine.snapshot().programs[0]!.counts.qa, 11, 'all eleven still counted');
  assert.ok(!r.audits.some((a) => a.kind === 'flow.skipped'), 'the three left over are not "nobody may verify": they wait');
  // The next window: the rest go out (the first eight are still unverified, so the lead gets eight again: the oldest).
  r.clock.advance(61);
  await r.engine.round();
  const next = r.chat.sent.filter((m) => m.text.includes('QA-ASK'));
  assert.equal(next.length, 2);
});

test('(b) T-1987: a ticket already in a live batch (a batch branch named after its newest verdict) is not asked; an old batch mention is', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(50, { holder: 'wb' });
  r.tickets.add(51, { holder: 'wb' });
  r.tickets.add(52, { holder: 'wb' });
  r.tickets.batches.set('T-50', { branch: 'qa/batch-2026-10-21-1', at: ago(r, 30) });
  r.tickets.batches.set('T-52', { branch: 'qa/batch-2026-10-20-4', at: ago(r, 200) }); // past batchLiveMin: that batch is not live
  await r.engine.round();
  const text = r.chat.sent.filter((m) => m.text.includes('QA-ASK')).map((m) => m.text).join('\n');
  assert.doesNotMatch(text, /T-50 /);
  assert.match(text, /T-51 /);
  assert.match(text, /T-52 /);
  assert.equal(r.engine.snapshot().programs[0]!.counts.qa, 2);
});

/* ---------- T-2014: the merge gate's PR record is the head ---------- */

test('T-2014: with a PR recorded, the QA PASS is judged on its pr_head, not on the newest commit seen', async () => {
  const r = rig();
  crew(r);
  // T-12: QA passed the PR head (a); the newest commit seen is a batch head (b) nobody passed. Counted, on the PR head.
  r.tickets.add(12, { holder: 'wb' });
  r.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(r, 40) });
  r.tickets.checksOf.set('T-12', [{ name: 'gate', state: 'passed', runId: null, commit: sha('b'), link: null, updatedAt: ago(r, 30) }]);
  r.tickets.merged('T-12', { repo: 'konfersi/api', pr: 7, prHead: sha('a'), state: 'ready', reason: null });
  // T-13: QA passed the newest commit seen (c), a batch head, but the PR head is (d): not counted (the old heuristic would have).
  r.tickets.add(13, { holder: 'wb', updatedAt: ago(r, 5) });
  r.tickets.verdict('T-13', { role: 'qa', verdict: 'pass', commit: sha('c'), at: ago(r, 40) });
  r.tickets.merged('T-13', { repo: 'konfersi/api', pr: 8, prHead: sha('d'), state: 'waiting', reason: null });
  await r.engine.round();
  const m = r.chat.sent.find((x) => x.id === LEAD_A)!;
  assert.match(m.text, new RegExp(`- T-12 \\(KONF-12\\) konfersi/api#7 QA PASS on the PR head ${sha('a')} \\(ready\\)`));
  assert.doesNotMatch(m.text, /T-13/);
  assert.doesNotMatch(m.text, new RegExp(sha('b')));
  assert.equal(r.engine.snapshot().programs[0]!.counts.merge, 1);
});

test('T-2014: with a PR recorded and any review verdict on the ticket, a review PASS on the PR head is needed too', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(12, { holder: 'wb', updatedAt: ago(r, 5) });
  r.tickets.verdict('T-12', { role: 'review', verdict: 'pass', commit: sha('e'), at: ago(r, 90) }); // reviewed, on an older commit
  r.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(r, 40) });
  r.tickets.merged('T-12', { repo: 'konfersi/api', pr: 7, prHead: sha('a'), state: 'ready', reason: null });
  await r.engine.round();
  assert.equal(r.engine.snapshot().programs[0]!.counts.merge, 0, 'QA PASS alone is not enough');
  r.tickets.verdict('T-12', { role: 'review', verdict: 'pass', commit: sha('a'), at: ago(r, 25) });
  r.clock.advance(31);
  await r.engine.round();
  assert.equal(r.engine.snapshot().programs[0]!.counts.merge, 1);
  assert.match(r.chat.sent.find((x) => x.id === LEAD_A)!.text, /konfersi\/api#7 QA PASS on the PR head/);
});

test('T-2014: a ticket recorded merged (in every repo it was recorded in) and a closed one are not counted', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(12, { holder: 'wb' });
  r.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(r, 40) });
  r.tickets.merged('T-12', { repo: 'konfersi/api', pr: 7, prHead: sha('a'), state: 'merged', reason: null });
  r.tickets.add(13, { holder: 'wb', status: 'done', closedAt: ago(r, 10) });
  r.tickets.verdict('T-13', { role: 'qa', verdict: 'pass', commit: sha('b'), at: ago(r, 40) });
  r.tickets.merged('T-13', { repo: 'konfersi/api', pr: 8, prHead: sha('b'), state: 'ready', reason: null });
  r.tickets.add(14, { holder: 'wb', status: 'wont_do', closedAt: ago(r, 10) });
  r.tickets.verdict('T-14', { role: 'qa', verdict: 'pass', commit: sha('c'), at: ago(r, 40) });
  // T-15: merged in one repo, still ready in another: counted on the open one.
  r.tickets.add(15, { holder: 'wb' });
  r.tickets.verdict('T-15', { role: 'qa', verdict: 'pass', commit: sha('d'), at: ago(r, 40) });
  r.tickets.merged('T-15', { repo: 'konfersi/web', pr: 2, prHead: sha('d'), state: 'ready', reason: null, min: 50 });
  r.tickets.merged('T-15', { repo: 'konfersi/api', pr: 9, prHead: sha('f'), state: 'merged', reason: null, min: 20 });
  await r.engine.round();
  const m = r.chat.sent.find((x) => x.id === LEAD_A)!;
  assert.doesNotMatch(m.text, /T-1[234]\b/);
  assert.match(m.text, /T-15 \(KONF-15\) konfersi\/web#2 QA PASS on the PR head/);
  assert.equal(r.engine.snapshot().programs[0]!.counts.merge, 1);
});

test('T-2014: conflict and no_pr are listed apart and go to the ticket\'s unit lead: rebase it, open the PR; T-2018: at once', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(12, { holder: 'wb' });
  r.tickets.verdict('T-12', { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(r, 40) });
  r.tickets.merged('T-12', { repo: 'konfersi/api', pr: 7, prHead: sha('a'), state: 'conflict', reason: null });
  r.tickets.add(13, { holder: 'wb' });
  r.tickets.verdict('T-13', { role: 'qa', verdict: 'pass', commit: sha('b'), at: ago(r, 40) });
  r.tickets.merged('T-13', { repo: 'konfersi/api', pr: null, prHead: null, state: 'no_pr', reason: null });
  r.tickets.add(14, { holder: 'wc' });
  r.tickets.merged('T-14', { repo: 'konfersi/api', pr: null, prHead: null, state: 'no_pr', reason: null, min: 0 }); // T-2018: fresh is told too
  await r.engine.round();
  assert.equal(r.chat.sent.filter((x) => x.id === LEAD_A).length, 0, 'the merge gate is not told about them');
  const toB = r.chat.sent.filter((x) => x.id === LEAD_B).map((x) => x.text);
  assert.equal(toB.length, 2, 'one message per condition to the unit lead');
  assert.match(toB.find((t) => /conflict/.test(t))!, new RegExp(`for a rebase[\\s\\S]*- T-12 \\(KONF-12\\) konfersi/api#7 head ${sha('a')}`));
  assert.match(toB.find((t) => /no pull request/.test(t))!, /Open the PR[\s\S]*- T-13 \(KONF-13\) konfersi\/api$/m);
  const toC = r.chat.sent.filter((x) => x.id === LEAD_C).map((x) => x.text);
  assert.equal(toC.length, 1, 'T-2018: a no_pr recorded this minute is told at once');
  assert.match(toC[0]!, /- T-14 \(KONF-14\) konfersi\/api$/m);
  assert.doesNotMatch(toC[0]!, /min or more/);
  const counts = r.engine.snapshot().programs[0]!.counts;
  assert.deepEqual([counts.merge, counts.conflict, counts.no_pr], [0, 1, 2]);
  assert.deepEqual(r.engine.snapshot().actions.filter((a) => a.kind === 'told').map((a) => a.condition).sort(), ['conflict', 'no_pr', 'no_pr']);
});

test('T-2018: a conflict recorded this minute is told at once, and still only once per lead per 30 min', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(12, { holder: 'wb' });
  r.tickets.merged('T-12', { repo: 'konfersi/api', pr: 7, prHead: sha('a'), state: 'conflict', reason: null, min: 0 });
  await r.engine.round();
  const told = () => r.chat.sent.filter((x) => x.id === LEAD_B && /for a rebase/.test(x.text)).length;
  assert.equal(told(), 1, 'no wait for flow.mergeAfterMin');
  r.clock.advance(10);
  await r.engine.round();
  assert.equal(told(), 1, 'rate limited');
  assert.equal(r.engine.snapshot().programs[0]!.counts.conflict, 1, 'still counted');
  r.clock.advance(21);
  await r.engine.round();
  assert.equal(told(), 2, 'the next window');
});

test('T-2016: every repo is judged: a conflict or a missing PR in one repo is not hidden behind a newer ready record of another', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(20, { holder: 'wb' });
  r.tickets.verdict('T-20', { role: 'qa', verdict: 'pass', commit: sha('b'), at: ago(r, 40) });
  r.tickets.merged('T-20', { repo: 'konfersi/api', pr: 7, prHead: sha('a'), state: 'conflict', reason: null, min: 50 });
  r.tickets.merged('T-20', { repo: 'konfersi/web', pr: null, prHead: null, state: 'no_pr', reason: null, min: 45 });
  r.tickets.merged('T-20', { repo: 'konfersi/lab', pr: 9, prHead: sha('b'), state: 'ready', reason: null, min: 40 });
  await r.engine.round();
  const counts = r.engine.snapshot().programs[0]!.counts;
  assert.deepEqual([counts.merge, counts.conflict, counts.no_pr], [0, 1, 1], 'the newer ready record in konfersi/lab hides nothing');
  const toB = r.chat.sent.filter((x) => x.id === LEAD_B).map((x) => x.text);
  assert.match(toB.find((t) => /for a rebase/.test(t))!, new RegExp(`- T-20 \\(KONF-20\\) konfersi/api#7 head ${sha('a')}`));
  assert.match(toB.find((t) => /no pull request/.test(t))!, /- T-20 \(KONF-20\) konfersi\/web$/m);
  assert.equal(r.chat.sent.filter((x) => /merge basis/.test(x.text)).length, 0, 'no merge nudge while a repo conflicts');
});

test('T-2016: two conflicting repos are two rows of one message; the ticket is named once', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(21, { holder: 'wb' });
  r.tickets.merged('T-21', { repo: 'konfersi/api', pr: 7, prHead: sha('a'), state: 'conflict', reason: null });
  r.tickets.merged('T-21', { repo: 'konfersi/web', pr: 8, prHead: sha('b'), state: 'conflict', reason: null });
  await r.engine.round();
  const m = r.chat.sent.filter((x) => x.id === LEAD_B && /for a rebase/.test(x.text));
  assert.equal(m.length, 1);
  assert.match(m[0]!.text, /konfersi\/api#7[\s\S]*konfersi\/web#8|konfersi\/web#8[\s\S]*konfersi\/api#7/);
  assert.match(m[0]!.text, /on 2 pull requests/);
  const told = r.engine.snapshot().actions.find((a) => a.condition === 'conflict' && a.kind === 'told')!;
  assert.deepEqual(told.tickets, ['T-21']);
});

test('T-2016: a second round within 30 min resends neither conflict nor no_pr; the card\'s actions carry the bucket keys', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(22, { holder: 'wb' });
  r.tickets.merged('T-22', { repo: 'konfersi/api', pr: 7, prHead: sha('a'), state: 'conflict', reason: null });
  r.tickets.add(23, { holder: 'wb' });
  r.tickets.merged('T-23', { repo: 'konfersi/api', pr: null, prHead: null, state: 'no_pr', reason: null });
  await r.engine.round();
  const sent = () => r.chat.sent.filter((x) => x.id === LEAD_B && /for a rebase|no pull request/.test(x.text)).length;
  assert.equal(sent(), 2);
  r.clock.advance(5);
  await r.engine.round();
  r.clock.advance(20);
  await r.engine.round();
  assert.equal(sent(), 2, 'not again inside the window');
  const told = r.engine.snapshot().actions.filter((a) => a.kind === 'told');
  assert.deepEqual(told.map((a) => [a.condition, a.tickets, a.keys]).sort(), [['conflict', ['T-22'], ['KONF-22']], ['no_pr', ['T-23'], ['KONF-23']]]);
});

test('T-2023: once the ticket is answered, the same conflict on the same record is not told again; a new record or a moved head is', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(24, { holder: 'wb' });
  r.tickets.merged('T-24', { repo: 'konfersi/api', pr: 7, prHead: sha('a'), state: 'conflict', reason: null });
  const told = () => r.chat.sent.filter((x) => x.id === LEAD_B && /for a rebase/.test(x.text));
  await r.engine.round();
  assert.equal(told().length, 1);
  assert.match(told()[0]!.text, /Say so on the ticket/);
  r.clock.advance(5);
  r.tickets.comment('T-24', 'contained in #154: not a conflict', 0);
  r.clock.advance(26);
  await r.engine.round();
  assert.equal(told().length, 1, 'answered on the ticket: held, though the window passed');
  assert.equal(r.engine.snapshot().programs[0]!.counts.conflict, 1, 'still counted on the card');
  r.restart();
  r.clock.advance(31);
  await r.engine.round();
  assert.equal(told().length, 1, 'the hold survives a portal restart');
  r.tickets.merged('T-24', { repo: 'konfersi/api', pr: 7, prHead: sha('a'), state: 'conflict', reason: 'still', min: 0 });
  r.clock.advance(1);
  await r.engine.round();
  assert.equal(told().length, 2, 'the gate recorded it again: told');
  r.clock.advance(5);
  r.tickets.comment('T-24', 'rebasing', 0);
  r.tickets.merged('T-24', { repo: 'konfersi/api', pr: 7, prHead: sha('b'), state: 'conflict', reason: null, min: 40 });
  r.clock.advance(26);
  await r.engine.round();
  assert.equal(told().length, 3, 'another head is another alert');
  assert.match(told()[2]!.text, new RegExp(`head ${sha('b')}`));
});

test('T-2023: silent tickets are still reminded each window (the answer, not the time, holds an alert)', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(25, { holder: 'wb' });
  r.tickets.merged('T-25', { repo: 'konfersi/api', pr: null, prHead: null, state: 'no_pr', reason: null });
  r.tickets.comment('T-25', 'an older comment, before any alert', 60);
  await r.engine.round();
  r.clock.advance(31);
  await r.engine.round();
  assert.equal(r.chat.sent.filter((x) => x.id === LEAD_B && /no pull request/.test(x.text)).length, 2);
});

test('T-2023: a recorded conflict on a head the PR has moved off is not a conflict while the forge has not judged the new head', async () => {
  const views = new Map<number, FlowPrView | null>();
  const r = rig({ prs: { pr: async (_repo, n) => views.get(n) ?? null } });
  crew(r);
  r.tickets.add(26, { holder: 'wb' });
  r.tickets.merged('T-26', { repo: 'konfersi/lab-plugin', pr: 156, prHead: sha('a'), state: 'conflict', reason: null });
  views.set(156, { state: 'open', merged: false, head: sha('f'), mergeable: null }); // pushed to (rebased); Gitea still computing
  r.tickets.add(27, { holder: 'wb' });
  r.tickets.merged('T-27', { repo: 'konfersi/compute', pr: 134, prHead: sha('c'), state: 'conflict', reason: null });
  views.set(134, { state: 'open', merged: false, head: sha('c'), mergeable: null }); // same head, not known: the record stands
  await r.engine.round();
  assert.equal(r.engine.snapshot().programs[0]!.counts.conflict, 1);
  const m = r.chat.sent.find((x) => x.id === LEAD_B && /for a rebase/.test(x.text))!;
  assert.doesNotMatch(m.text, /T-26 /, 'the moved PR is not told as a conflict');
  assert.match(m.text, /T-27 /);
});

// T-2018: idle builder lanes while the unit has work.

/** Lead B with two builder lanes idle 15 and 25 min; leads A and C working, no idle lanes. */
function lanes(r: ReturnType<typeof rig>) {
  crew(r);
  r.chat.put('b-impl', { parentId: LEAD_B, agent: 'implementer', state: 'idle', lastActivityAt: ago(r, 15) });
  r.chat.put('b-fe', { parentId: LEAD_B, agent: 'konfersi-lane-frontend', state: 'idle', lastActivityAt: ago(r, 25) });
}

test('T-2018 idle_lanes: idle builders and conflicts: the lead hears the lane ids and the items, conflicts first, then no_pr, then open', async () => {
  const r = rig();
  lanes(r);
  r.tickets.add(20, { holder: 'wb', status: 'open', priority: 'normal' });
  r.tickets.add(21, { holder: 'wb', status: 'in_progress', priority: 'high', createdAt: ago(r, 300) });
  r.tickets.add(22, { holder: 'b-impl' });
  r.tickets.merged('T-22', { repo: 'konfersi/api', pr: 9, prHead: sha('c'), state: 'conflict', reason: null, min: 0 });
  r.tickets.add(23, { holder: 'wb' });
  r.tickets.merged('T-23', { repo: 'konfersi/web', pr: null, prHead: null, state: 'no_pr', reason: null, min: 0 });
  await r.engine.round();
  const m = r.chat.sent.filter((x) => x.id === LEAD_B).map((x) => x.text).find((t) => /builder lane/.test(t));
  assert.ok(m, 'lead B is told about its idle lanes');
  assert.ok(m.startsWith(FLOW_PREFIX));
  assert.match(m, /2 builder lanes of yours have been idle 10 min or more/);
  assert.match(m, /- b-fe konfersi-lane-frontend idle 25 min\n- b-impl implementer idle 15 min/, 'the longest idle first');
  const order = ['T-22 (KONF-22) conflict konfersi/api#9', 'T-23 (KONF-23) no PR konfersi/web', 'T-21 (KONF-21) high in_progress', 'T-20 (KONF-20) normal open'].map((x) => m.indexOf(x));
  assert.ok(order.every((i) => i > 0), `every item named: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'conflicts, then no_pr, then the oldest high priority open');
  assert.doesNotMatch(m, /CANARY/);
  assert.equal(r.chat.sent.filter((x) => x.id === LEAD_A || x.id === LEAD_C).filter((x) => /builder lane/.test(x.text)).length, 0);
  assert.equal(r.engine.snapshot().programs[0]!.counts.idle_lanes, 2);
  const act = r.engine.snapshot().actions.find((a) => a.condition === 'idle_lanes')!;
  assert.equal(act.kind, 'told');
  assert.deepEqual(act.tickets, ['T-22', 'T-23', 'T-21', 'T-20']);
  assert.ok(r.audits.some((a) => a.kind === 'flow.told' && (a.detail as { condition: string }).condition === 'idle_lanes'), 'audited');
});

test('T-2018 idle_lanes: open work alone (no conflict, no no_pr) is enough; flow.laneIdleMin is read', async () => {
  const r = rig({ settings: { 'flow.laneIdleMin': 20 } });
  lanes(r);
  r.tickets.add(20, { holder: 'wb', status: 'open' });
  await r.engine.round();
  const m = r.chat.sent.find((x) => x.id === LEAD_B && /builder lane/.test(x.text));
  assert.ok(m);
  assert.match(m.text, /1 builder lane of yours has been idle 20 min or more/, 'b-impl (15 min) is under the threshold');
  assert.match(m.text, /- b-fe konfersi-lane-frontend idle 25 min/);
  assert.doesNotMatch(m.text, /b-impl/);
  assert.equal(r.engine.snapshot().programs[0]!.counts.idle_lanes, 1);
});

test('T-2018 idle_lanes: QA and review lanes, look-alike names, workers of a worker and fresh idle builders are not counted', async () => {
  const r = rig();
  crew(r);
  r.chat.put('b-qa', { parentId: LEAD_B, agent: 'qa-verifier', state: 'idle', lastActivityAt: ago(r, 60) });
  r.chat.put('b-rev', { parentId: LEAD_B, agent: 'reviewer', state: 'idle', lastActivityAt: ago(r, 60) });
  r.chat.put('b-odd', { parentId: LEAD_B, agent: 'builder-qa', state: 'idle', lastActivityAt: ago(r, 60) });
  r.chat.put('b-none', { parentId: LEAD_B, agent: null, state: 'idle', lastActivityAt: ago(r, 60) });
  r.chat.put('b-sub', { parentId: 'b-qa', agent: 'implementer', state: 'idle', lastActivityAt: ago(r, 60) });
  r.chat.put('b-fresh', { parentId: LEAD_B, agent: 'implementer', state: 'idle', lastActivityAt: ago(r, 5) });
  r.tickets.add(20, { holder: 'wb', status: 'open' });
  await r.engine.round();
  assert.equal(r.chat.sent.filter((x) => /builder lane/.test(x.text)).length, 0);
  assert.equal(r.engine.snapshot().programs[0]!.counts.idle_lanes, 0);
});

test('T-2018 idle_lanes: not while the builders work, or with no work in the unit, or for a lead a person stopped', async () => {
  const working = rig();
  crew(working);
  working.chat.put('b-impl', { parentId: LEAD_B, agent: 'implementer', state: 'working', lastActivityAt: ago(working, 15) });
  working.chat.put('b-be', { parentId: LEAD_B, agent: 'lane-backend', state: 'idle', busySince: ago(working, 20), lastActivityAt: ago(working, 20) });
  working.chat.put('b-gone', { parentId: LEAD_B, agent: 'lane-fullstack', state: 'idle', process: 'gone', lastActivityAt: ago(working, 20) });
  working.chat.put('b-wait', { parentId: LEAD_B, agent: 'lane-frontend', state: 'idle', waiting: 1, lastActivityAt: ago(working, 20) });
  working.chat.put('b-end', { parentId: LEAD_B, agent: 'builder', state: 'ended', lastActivityAt: ago(working, 20) });
  working.tickets.add(20, { holder: 'wb', status: 'open' });
  await working.engine.round();
  assert.equal(working.engine.snapshot().programs[0]!.counts.idle_lanes, 0);

  const nothing = rig();
  lanes(nothing);
  nothing.tickets.add(20, { holder: 'wa', status: 'open' }); // another unit's work
  nothing.tickets.add(21, { holder: 'wb', status: 'blocked' });
  await nothing.engine.round();
  assert.equal(nothing.engine.snapshot().programs[0]!.counts.idle_lanes, 0);
  assert.equal(nothing.chat.sent.filter((x) => /builder lane/.test(x.text)).length, 0);

  const stopped = rig();
  lanes(stopped);
  stopped.chat.stopped.add(LEAD_B);
  stopped.tickets.add(20, { holder: 'wb', status: 'open' });
  await stopped.engine.round();
  assert.equal(stopped.engine.snapshot().programs[0]!.counts.idle_lanes, 0);
  assert.equal(stopped.chat.sent.filter((x) => x.id === LEAD_B).length, 0);
});

test('T-2018 idle_lanes: one message per lead per 30 min; a builder of a continued lead counts for its live head', async () => {
  const r = rig();
  lanes(r);
  r.tickets.add(20, { holder: 'wb', status: 'open' });
  await r.engine.round();
  const told = () => r.chat.sent.filter((x) => x.id === LEAD_B && /builder lane/.test(x.text)).length;
  assert.equal(told(), 1);
  r.clock.advance(10);
  await r.engine.round();
  assert.equal(told(), 1, 'rate limited');
  assert.equal(r.engine.snapshot().programs[0]!.counts.idle_lanes, 2, 'still counted');
  r.clock.advance(25);
  await r.engine.round();
  assert.equal(told(), 2, 'the next window');

  const c = rig();
  crew(c);
  c.chat.patch(LEAD_B, { state: 'ended' });
  c.chat.put('b2', { continuedFrom: LEAD_B, state: 'working', lastActivityAt: ago(c, 1) });
  c.chat.put('b-impl', { parentId: LEAD_B, agent: 'implementer', state: 'idle', lastActivityAt: ago(c, 15) });
  c.tickets.add(20, { holder: 'b-impl', status: 'open' });
  await c.engine.round();
  const m = c.chat.sent.find((x) => x.id === 'b2' && /builder lane/.test(x.text));
  assert.ok(m, 'told to the live continuation');
  assert.match(m.text, /- b-impl implementer idle 15 min/);
});

test('T-2018 idle_lanes: the role is matched and printed lower-cased', async () => {
  const r = rig();
  crew(r);
  r.chat.put('b-impl', { parentId: LEAD_B, agent: 'IMPLEMENTER', state: 'idle', lastActivityAt: ago(r, 15) });
  r.tickets.add(20, { holder: 'wb', status: 'open' });
  await r.engine.round();
  const m = r.chat.sent.find((x) => x.id === LEAD_B && /builder lane/.test(x.text))!;
  assert.match(m.text, /- b-impl implementer idle 15 min/, 'lower-cased role word');
});

test('D-102: selfTestAt reads the gate\'s line form on the head (emphasis ignored, short sha prefixes), never another head or a loose mention', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 24, 12, min)).toISOString();
  const h = sha('a');
  assert.equal(selfTestAt([{ at: at(1), body: `notes\n**Self-test:** \`claudepilot-job-1f2e\` on ${h.slice(0, 12)} pass 42` }], h), Date.parse(at(1)));
  assert.equal(selfTestAt([{ at: at(1), body: `Self-test: npm test on ${h} pass 3 stg same failures: a.spec, b.spec` }], h), Date.parse(at(1)));
  assert.equal(selfTestAt([{ at: at(1), body: `Self-test: npm test on ${sha('b')} pass 3` }], h), null, 'another head');
  assert.equal(selfTestAt([{ at: at(1), body: `Self-test: npm test on ${h} pass 0` }], h), null, 'nothing passed');
  assert.equal(selfTestAt([{ at: at(1), body: `I will post the Self-test: later on ${h}` }], h), null);
  assert.equal(selfTestAt([{ at: at(1), body: `Self-test: npm test on ${h.slice(0, 8)} pass 3` }], h), null, 'too short a sha');
  assert.equal(
    selfTestAt([{ at: at(1), body: `Self-test: x on ${h} pass 1` }, { at: at(5), body: `Self-test: y on ${h} pass 2` }], h),
    Date.parse(at(5)),
    'the newest',
  );
});

test('D-102 + D-99: a NORMAL ticket self-tested on the PR head goes to its own unit lead to merge, not to the gate; never before the threshold', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(60, { holder: 'wb' });
  r.tickets.merged('T-60', { repo: 'konfersi/api', pr: 9, prHead: sha('a'), state: 'ready', reason: null });
  r.tickets.comment('T-60', `Self-test: claudepilot-job-9a on ${sha('a').slice(0, 12)} pass 12`, 25);
  r.tickets.add(61, { holder: 'wb' });
  r.tickets.merged('T-61', { repo: 'konfersi/api', pr: 10, prHead: sha('b'), state: 'ready', reason: null });
  r.tickets.comment('T-61', `Self-test: claudepilot-job-9b on ${sha('b')} pass 4`, 5); // too fresh
  r.tickets.add(62, { holder: 'wb' });
  r.tickets.merged('T-62', { repo: 'konfersi/api', pr: 11, prHead: sha('c'), state: 'ready', reason: null });
  r.tickets.comment('T-62', `Self-test: claudepilot-job-9c on ${sha('d')} pass 4`, 25); // an older head
  await r.engine.round();
  const m = r.chat.sent.find((x) => x.text.includes('T-60'));
  assert.ok(m);
  assert.equal(m.id, LEAD_B);
  assert.match(m.text, new RegExp(`- T-60 \\(KONF-60\\) konfersi/api#9 self-test on the PR head ${sha('a')} \\(ready\\)`));
  assert.doesNotMatch(m.text, /T-61|T-62/);
  // T-62's self-test names another head: it is asked of QA as before; the self-tested ones never are.
  assert.equal(r.chat.sent.filter((x) => x.text.includes('QA-ASK') && /T-6[01] /.test(x.text)).length, 0, 'a self-tested ticket is never asked of QA');
  assert.equal(r.engine.snapshot().programs[0]!.counts.merge, 1);
});

test('D-102: a HIGH ticket self-tested needs a blind review PASS; until then a peer lead (never the author\'s) gets a REVIEW-ASK; then the gate merges', async () => {
  const r = rig();
  crew(r);
  r.tickets.add(70, { holder: 'wb', tags: ['konfersi-migration', 'risk:high'] });
  r.tickets.merged('T-70', { repo: 'konfersi/api', pr: 12, prHead: sha('a'), state: 'ready', reason: null });
  r.tickets.comment('T-70', `Self-test: claudepilot-job-7a on ${sha('a')} pass 30`, 25);
  await r.engine.round();
  assert.equal(r.engine.snapshot().programs[0]!.counts.merge, 0, 'self-test alone is not enough for HIGH');
  const ask = r.chat.sent.find((x) => x.text.includes('REVIEW-ASK'));
  assert.ok(ask, 'a peer is asked to review');
  assert.notEqual(ask.id, LEAD_B);
  assert.match(ask.text, /- T-70 \(KONF-70\) head/);
  assert.doesNotMatch(ask.text, /QA-ASK/);
  r.tickets.verdict('T-70', { role: 'review', verdict: 'pass', commit: sha('a'), at: ago(r, 25) });
  r.clock.advance(31);
  await r.engine.round();
  const m = r.chat.sent.find((x) => x.text.includes('self-test + review PASS'));
  assert.ok(m);
  assert.equal(m.id, LEAD_A, 'HIGH rows go to the merge gate');
});

test('T-2250: a ticket tagged risk-high (the tag rule refuses risk:high) with only a self-test gets a REVIEW-ASK, never a merge nudge', async () => {
  for (const tag of ['risk-high', 'risk_high', 'Risk-High']) {
    const r = rig();
    crew(r);
    r.tickets.add(71, { holder: 'wb', tags: ['konfersi-migration', tag, 'security'] });
    r.tickets.merged('T-71', { repo: 'konfersi/api', pr: 13, prHead: sha('a'), state: 'ready', reason: null });
    r.tickets.comment('T-71', `Self-test: claudepilot-job-7b on ${sha('a')} pass 12`, 40);
    await r.engine.round();
    assert.equal(r.engine.snapshot().programs[0]!.counts.merge, 0, `${tag}: a self-test alone is no merge basis for HIGH`);
    assert.equal(r.chat.sent.filter((x) => /merge basis/.test(x.text)).length, 0, `${tag}: no merge nudge`);
    const ask = r.chat.sent.find((x) => x.text.includes('REVIEW-ASK'));
    assert.ok(ask, `${tag}: a peer is asked to review`);
    assert.notEqual(ask.id, LEAD_B);
    assert.match(ask.text, /- T-71 \(KONF-71\) head/);
  }
});

test('D-102: a HIGH ticket whose review failed, or whose author still works on it, is not asked again', async () => {
  for (const setup of [
    (r: ReturnType<typeof rig>) => r.tickets.verdict('T-70', { role: 'review', verdict: 'fail', commit: sha('a'), at: ago(r, 25) }),
    (r: ReturnType<typeof rig>) => r.chat.put('wb3', { parentId: LEAD_B, state: 'working', ticketId: 'T-70' }),
  ]) {
    const r = rig();
    crew(r);
    r.tickets.add(70, { holder: 'wb', tags: ['konfersi-migration', 'risk:high'] });
    r.tickets.merged('T-70', { repo: 'konfersi/api', pr: 12, prHead: sha('a'), state: 'ready', reason: null });
    r.tickets.comment('T-70', `Self-test: claudepilot-job-7a on ${sha('a')} pass 30`, 25);
    setup(r);
    await r.engine.round();
    assert.equal(r.chat.sent.filter((x) => x.text.includes('REVIEW-ASK')).length, 0);
    assert.equal(r.engine.snapshot().programs[0]!.counts.merge, 0);
  }
});

test('(c) a lead whose live workers all sit idle is told; a ticket its working worker holds is not "open work"', async () => {
  const r = rig();
  crew(r);
  r.chat.cap = 2;
  r.chat.patch(LEAD_B, { state: 'idle', lastActivityAt: ago(r, 45) });
  r.chat.put('wb2', { parentId: LEAD_B, state: 'idle', lastActivityAt: ago(r, 90) });
  r.chat.put('wb3', { parentId: LEAD_B, state: 'idle', lastActivityAt: ago(r, 90) });
  r.chat.put('wb4', { parentId: LEAD_B, state: 'working', lastActivityAt: ago(r, 1) });
  r.tickets.add(80, { holder: 'wb2', status: 'in_progress' }); // its holder sat idle 90 min
  r.tickets.add(81, { holder: 'wb4', status: 'in_progress' }); // being worked
  await r.engine.round();
  const m = r.chat.sent.find((x) => x.id === LEAD_B);
  assert.ok(m, 'two idle live workers under a cap of 2 no longer hide an idle unit');
  assert.match(m.text, /has 1 of 2 workers working \(3 live\)/);
  assert.match(m.text, /- T-80 /);
  assert.doesNotMatch(m.text, /T-81/);
});

test('#2: the forge\'s word corrects a stale record: merged there is skipped, closed is no_pr, an open PR is judged on its live head, unmergeable is a conflict', async () => {
  const views = new Map<number, FlowPrView | null>();
  const asked: string[] = [];
  const r = rig({ prs: { pr: async (repo, n) => (asked.push(`${repo}#${n}`), views.get(n) ?? null) } });
  crew(r);
  const ready = (n: number, head: string) => {
    r.tickets.add(n, { holder: 'wb' });
    r.tickets.verdict(`T-${n}`, { role: 'qa', verdict: 'pass', commit: sha('a'), at: ago(r, 40) });
    r.tickets.merged(`T-${n}`, { repo: 'konfersi/api', pr: n, prHead: head, state: 'ready', reason: null });
  };
  ready(90, sha('a')); views.set(90, { state: 'closed', merged: true, head: sha('a'), mergeable: null }); // merged outside the gate
  ready(91, sha('a')); views.set(91, { state: 'closed', merged: false, head: sha('a'), mergeable: null }); // closed: no PR now
  ready(92, sha('a')); views.set(92, { state: 'open', merged: false, head: sha('b'), mergeable: true }); // pushed to: the PASS is stale
  ready(93, sha('a')); views.set(93, { state: 'open', merged: false, head: sha('a'), mergeable: false }); // conflicts now
  ready(94, sha('a')); views.set(94, { state: 'open', merged: false, head: sha('a'), mergeable: true }); // as recorded
  ready(95, sha('a')); views.set(95, null); // the forge does not answer: the record stands
  await r.engine.round();
  assert.deepEqual(asked.sort(), [90, 91, 92, 93, 94, 95].map((n) => `konfersi/api#${n}`));
  const counts = r.engine.snapshot().programs[0]!.counts;
  assert.equal(counts.merge, 2, 'T-94 and T-95');
  assert.equal(counts.no_pr, 1);
  assert.equal(counts.conflict, 1);
  const all = r.chat.sent.map((m) => m.text).join('\n');
  assert.doesNotMatch(all, /T-90 /, 'merged on the forge: nobody is told');
  assert.match(all, /T-94 \(KONF-94\) konfersi\/api#94 QA PASS on the PR head/);
});

test('#2: giteaPrPort reads Gitea\'s pull request (token in a header only), and answers null for a bad repo, an error, or no config', async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization') });
    if (url.endsWith('/7')) return new Response(JSON.stringify({ state: 'open', merged: false, mergeable: false, head: { sha: sha('C') } }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  assert.equal(giteaPrPort(undefined, 'x', fake), undefined);
  assert.equal(giteaPrPort('https://git.example', undefined, fake), undefined);
  const p = giteaPrPort('https://git.example/', 'tok', fake)!;
  assert.deepEqual(await p.pr('konfersi/api', 7), { state: 'open', merged: false, head: sha('c'), mergeable: false });
  assert.equal(calls[0]!.url, 'https://git.example/api/v1/repos/konfersi/api/pulls/7');
  assert.equal(calls[0]!.auth, 'token tok');
  assert.equal(await p.pr('konfersi/api', 8), null);
  assert.equal(await p.pr('../etc', 7), null);
  assert.equal(await p.pr('konfersi/api', 0), null);
  assert.equal(calls.length, 2);
});
