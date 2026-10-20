// T-325 S1: structured QA and review verdicts. A verdict is bound to one full commit; the author, the lead and any non-verifier are refused;
// a branch that moved after the PASS is never passing (the stale guard, with a mutation that proves the test would notice its removal).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIGRATIONS } from '../store/migrations.js';
import type { TicketAudit } from './service.js';
import { agent, ticketsHarness, token, UI } from './testkit.js';
import { canRecordVerdict, evaluateVerdicts, normalizeSha, verdictRoleOfAgent, type StoredVerdict } from './verdicts.js';

const WS = 'kubernetes/kohi-event';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const sv = (id: number, role: 'qa' | 'review', verdict: 'pass' | 'fail', commit: string): StoredVerdict => ({ id, role, verdict, commit, actor: 'session:x', at: '2026-01-01T00:00:00.000Z' });

test('normalizeSha and verdictRoleOfAgent: only a full sha, and only QA or review agents have a role', () => {
  assert.equal(normalizeSha(A.toUpperCase()), A);
  assert.equal(normalizeSha('abc1234'), null, 'an abbreviation is ambiguous');
  assert.equal(normalizeSha(`${A}0`), null);
  assert.equal(normalizeSha(undefined), null);
  assert.equal(verdictRoleOfAgent('qa-verifier'), 'qa');
  assert.equal(verdictRoleOfAgent('konfersi-qa'), 'qa');
  assert.equal(verdictRoleOfAgent('reviewer'), 'review');
  for (const a of ['implementer', 'orchestrator', 'scribe', '', null, undefined]) assert.equal(verdictRoleOfAgent(a), null, String(a));
});

test('canRecordVerdict: a person, or a QA/review session of its own role that is neither author nor lead', () => {
  const none = new Set<string>();
  const base = { callerKind: 'agent' as const, role: 'qa' as const, session: { id: 'q', agent: 'qa-verifier' }, authors: none, leads: none, commit: A, chain: [] as string[], leadHolders: none };
  assert.deepEqual(canRecordVerdict(base), { allow: true });
  assert.deepEqual(canRecordVerdict({ ...base, callerKind: 'ui', session: null }), { allow: true });
  assert.deepEqual(canRecordVerdict({ ...base, commit: null }), { allow: false, why: 'bad_commit' });
  assert.deepEqual(canRecordVerdict({ ...base, authors: new Set(['q']) }), { allow: false, why: 'is_author' });
  assert.deepEqual(canRecordVerdict({ ...base, leads: new Set(['q']) }), { allow: false, why: 'is_lead' });
  assert.deepEqual(canRecordVerdict({ ...base, role: 'review' }), { allow: false, why: 'wrong_role' });
  assert.deepEqual(canRecordVerdict({ ...base, session: { id: 'i', agent: 'implementer' } }), { allow: false, why: 'not_a_verifier' });
  assert.deepEqual(canRecordVerdict({ ...base, session: { id: 'l', agent: null } }), { allow: false, why: 'not_a_verifier' }, 'a lead is no verifier');
  for (const callerKind of ['system', 'token', 'trigger'] as const) assert.deepEqual(canRecordVerdict({ ...base, callerKind, session: null }), { allow: false, why: 'not_a_verifier' }, callerKind);
  // QA M4 (T-325 S1b): the caller kind is checked even when a QA session is passed in (a token acting for it is not it).
  for (const callerKind of ['system', 'token', 'trigger'] as const) assert.deepEqual(canRecordVerdict({ ...base, callerKind }), { allow: false, why: 'not_a_verifier' }, `${callerKind} with a QA session`);
});

test('canRecordVerdict (T-325 S1b, QA F1): a verifier whose spawn chain holds an author is refused; a holder that leads the work may be its parent', () => {
  const base = { callerKind: 'agent' as const, role: 'qa' as const, session: { id: 'q', agent: 'qa-verifier' }, authors: new Set(['impl']), leads: new Set(['lead']), commit: A, chain: ['lead'], leadHolders: new Set<string>() };
  assert.deepEqual(canRecordVerdict(base), { allow: true }, 'spawned by the lead, who is no author');
  assert.deepEqual(canRecordVerdict({ ...base, chain: ['impl', 'lead'] }), { allow: false, why: 'descends_from_author' }, 'the author’s child named qa-verifier');
  assert.deepEqual(canRecordVerdict({ ...base, session: { id: 'q', agent: 'my-verifier' }, chain: ['impl', 'lead'] }), { allow: false, why: 'descends_from_author' }, 'any QA-shaped name the author picks');
  assert.deepEqual(canRecordVerdict({ ...base, chain: ['x', 'impl', 'lead'] }), { allow: false, why: 'descends_from_author' }, 'a grandchild of the author');
  // The orchestrator holds the ticket (an author) and leads it: its own QA worker may verify.
  const held = { ...base, authors: new Set(['orch', 'impl']), leads: new Set(['orch']), chain: ['orch'] };
  assert.deepEqual(canRecordVerdict({ ...held, leadHolders: new Set(['orch']) }), { allow: true }, 'the holder that leads the work');
  assert.deepEqual(canRecordVerdict(held), { allow: false, why: 'descends_from_author' }, 'a holder that is not a lead is an author like any other');
  assert.deepEqual(canRecordVerdict({ ...held, leadHolders: new Set(['orch']), chain: ['impl', 'orch'] }), { allow: false, why: 'descends_from_author' }, 'the exemption covers the holder only, not its workers');
  assert.deepEqual(canRecordVerdict({ ...held, leadHolders: new Set(['orch']), session: { id: 'orch', agent: 'qa-verifier' }, chain: [] }), { allow: false, why: 'is_author' }, 'the holder itself still cannot');
});

test('evaluateVerdicts: the latest verdict of each role ON THE HEAD decides; another commit’s verdict is stale', () => {
  assert.deepEqual(evaluateVerdicts([], A), { pass: false, roles: { qa: 'missing' } });
  assert.equal(evaluateVerdicts([sv(1, 'qa', 'pass', A)], A).pass, true);
  assert.deepEqual(evaluateVerdicts([sv(1, 'qa', 'pass', A)], B), { pass: false, roles: { qa: 'stale' } }, 'the branch moved after the PASS: void');
  assert.equal(evaluateVerdicts([sv(1, 'qa', 'pass', A), sv(2, 'qa', 'fail', A)], A).pass, false, 'a later fail on the same commit wins');
  assert.equal(evaluateVerdicts([sv(1, 'qa', 'fail', A), sv(2, 'qa', 'pass', A)], A).pass, true, 'and a later pass wins over an earlier fail');
  assert.equal(evaluateVerdicts([sv(1, 'qa', 'pass', B), sv(2, 'qa', 'fail', A)], B).pass, true, 'a verdict on another commit does not override');
  assert.equal(evaluateVerdicts([sv(1, 'qa', 'pass', A)], A, ['qa', 'review']).pass, false, 'review is needed too');
  assert.equal(evaluateVerdicts([sv(1, 'qa', 'pass', A), sv(2, 'review', 'pass', A)], A, ['qa', 'review']).pass, true);
  assert.equal(evaluateVerdicts([sv(1, 'qa', 'pass', A)], A, []).pass, false, 'nothing needed is not a pass');
});

test('MUTATION: with the commit comparison removed the stale-PASS test fails, so the guard is tested', () => {
  const stale = [sv(1, 'qa', 'pass', A)];
  const guarded = evaluateVerdicts(stale, B).pass;
  const mutant = evaluateVerdicts(stale, B, ['qa'], () => true).pass;
  assert.equal(guarded, false);
  assert.equal(mutant, true, 'the mutant (any commit matches) passes a stale verdict: the assertion above would fail on it');
  assert.notEqual(guarded, mutant);
});

async function rig() {
  const h = await ticketsHarness();
  const audits: TicketAudit[] = [];
  h.tickets.onAudit = (e) => void audits.push(e);
  const s = h.sessions;
  s.add({ id: 'lead', workspaceId: WS, agent: null });
  s.add({ id: 'impl', workspaceId: WS, agent: 'implementer', parentId: 'lead' });
  s.add({ id: 'qa1', workspaceId: WS, agent: 'qa-verifier', parentId: 'lead' });
  s.add({ id: 'rev1', workspaceId: WS, agent: 'reviewer', parentId: 'lead' });
  s.add({ id: 'qaX', workspaceId: 'docker/other', agent: 'qa-verifier' });
  const t = h.tickets.create(UI, { summary: 'the work', workspaceId: WS });
  h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: 'impl' }, status: 'in_progress' });
  s.sessions.get('impl')!.ticketId = t.id;
  return { ...h, audits, id: t.id };
}

const record = (r: Awaited<ReturnType<typeof rig>>, who: string, role: string, verdict: string, commit: unknown) =>
  r.tickets.recordVerdict(agent(r.sessions.sessions.get(who)!.workspaceId, who), r.id, { role, verdict, commit });

test('recordVerdict: QA and review sessions record on a full commit; a person too; rows, timeline and audit say who and what', async () => {
  const r = await rig();
  try {
    const v = record(r, 'qa1', 'qa', 'pass', A.toUpperCase());
    assert.deepEqual([v.role, v.verdict, v.commit, v.actor], ['qa', 'pass', A, 'session:qa1']);
    record(r, 'rev1', 'review', 'pass', A);
    const byPerson = r.tickets.recordVerdict(UI, r.id, { role: 'qa', verdict: 'fail', commit: B });
    assert.equal(byPerson.actor, 'ui');
    assert.equal(r.tickets.verdicts(UI, r.id).length, 3);
    assert.deepEqual(r.tickets.verdictStatus(UI, r.id, A, ['qa', 'review']).pass, true);
    assert.equal(r.tickets.verdictStatus(UI, r.id, B, ['qa']).pass, false);
    const entry = r.tickets.get(UI, r.id).events.filter((e) => e.kind === 'comment')[0]!;
    assert.match(entry.body!, new RegExp(`QA PASS recorded on commit ${A}`));
    assert.equal(entry.actor, 'session:qa1');
    const rows = r.audits.filter((a) => a.kind === 'ticket.verdict');
    assert.equal(rows.length, 3);
    assert.deepEqual([rows[0]!.detail!.role, rows[0]!.detail!.verdict, rows[0]!.detail!.commit], ['qa', 'pass', A]);
  } finally {
    r.done();
  }
});

test('recordVerdict refuses: an abbreviation, the author, the lead, a non-verifier, the wrong role, a token; each leaves no row', async () => {
  const r = await rig();
  try {
    const refuse = (fn: () => unknown, code: string, why?: string) => {
      assert.throws(fn, (e: any) => e.code === code, why);
    };
    refuse(() => record(r, 'qa1', 'qa', 'pass', 'abc1234'), 'VALIDATION_FAILED', 'short sha');
    refuse(() => record(r, 'impl', 'qa', 'pass', A), 'FORBIDDEN', 'the author (an implementer) cannot verify');
    refuse(() => record(r, 'lead', 'qa', 'pass', A), 'FORBIDDEN', 'the lead cannot');
    refuse(() => record(r, 'qa1', 'review', 'pass', A), 'FORBIDDEN', 'a QA session cannot record a review');
    refuse(() => r.tickets.recordVerdict(token('t1', 'admin'), r.id, { role: 'qa', verdict: 'pass', commit: A }), 'FORBIDDEN', 'an admin token has no identity to compare');
    refuse(() => r.tickets.recordVerdict(token('t1', 'admin'), r.id, { role: 'qa', verdict: 'pass', commit: A }, { sessionId: 'qa1' }), 'FORBIDDEN', 'a token acting for QA is not QA');
    refuse(() => r.tickets.recordVerdict({ kind: 'system' }, r.id, { role: 'qa', verdict: 'pass', commit: A }), 'FORBIDDEN', 'the portal itself');
    refuse(() => record(r, 'qa1', 'qa', 'maybe', A), 'VALIDATION_FAILED', 'unknown verdict');
    assert.equal(r.tickets.verdicts(UI, r.id).length, 0);
    assert.equal(r.audits.filter((a) => a.kind === 'ticket.verdict_refused').length, 7, 'every refusal that reached the rule is audited');
  } finally {
    r.done();
  }
});

test('a QA session that held the ticket, or leads its holder, is refused as author or lead; a lineage ancestor of the holder too', async () => {
  const r = await rig();
  try {
    // A QA-named session that was ever assigned the ticket is an author: it cannot grade it.
    r.sessions.add({ id: 'qaHeld', workspaceId: WS, agent: 'qa-verifier' });
    r.tickets.update(UI, r.id, { assignee: { kind: 'session', sessionId: 'qaHeld' } });
    r.tickets.update(UI, r.id, { assignee: { kind: 'session', sessionId: 'impl' } });
    assert.throws(() => record(r, 'qaHeld', 'qa', 'pass', A), (e: any) => e.code === 'FORBIDDEN' && /author/.test(e.message));
    // A QA-named session that is the parent of the author is the lead.
    r.sessions.add({ id: 'qaLead', workspaceId: WS, agent: 'qa-verifier' });
    r.sessions.sessions.get('impl')!.parentId = 'qaLead';
    assert.throws(() => record(r, 'qaLead', 'qa', 'pass', A), (e: any) => e.code === 'FORBIDDEN' && /lead/.test(e.message));
    // An ancestor of the holder (the session it continues) is an author.
    r.sessions.add({ id: 'qaOld', workspaceId: WS, agent: 'qa-verifier', state: 'ended' });
    r.sessions.sessions.get('impl')!.continuedFrom = 'qaOld';
    assert.throws(() => record(r, 'qaOld', 'qa', 'pass', A), (e: any) => e.code === 'FORBIDDEN');
    assert.equal(r.tickets.verdicts(UI, r.id).length, 0);
  } finally {
    r.done();
  }
});

test('QA F1 (T-325 S1b): the author’s child or grandchild with a QA name, and its successor, are refused; nothing is written', async () => {
  const r = await rig();
  try {
    const refusedAsDescendant = (who: string) => assert.throws(() => record(r, who, 'qa', 'pass', A), (e: any) => e.code === 'FORBIDDEN' && /descends from/.test(e.message), who);
    r.sessions.add({ id: 'fakeQa', workspaceId: WS, agent: 'qa-verifier', parentId: 'impl' });
    refusedAsDescendant('fakeQa');
    r.sessions.add({ id: 'renamed', workspaceId: WS, agent: 'konfersi-qa', parentId: 'impl' });
    refusedAsDescendant('renamed');
    r.sessions.add({ id: 'helper', workspaceId: WS, agent: 'implementer', parentId: 'impl' });
    r.sessions.add({ id: 'grandQa', workspaceId: WS, agent: 'reviewer', parentId: 'helper' });
    assert.throws(() => record(r, 'grandQa', 'review', 'pass', A), (e: any) => e.code === 'FORBIDDEN' && /descends from/.test(e.message));
    r.sessions.add({ id: 'movedQa', workspaceId: WS, agent: 'qa-verifier', continuedFrom: 'fakeQa' });
    refusedAsDescendant('movedQa');
    assert.equal(r.tickets.verdicts(UI, r.id).length, 0);
    const why = r.audits.filter((a) => a.kind === 'ticket.verdict_refused').map((a) => a.detail!.why);
    assert.deepEqual(why, ['descends_from_author', 'descends_from_author', 'descends_from_author', 'descends_from_author']);
    record(r, 'qa1', 'qa', 'pass', A); // the lead's own QA still may
  } finally {
    r.done();
  }
});

test('QA F1: when the orchestrator holds the ticket and leads its implementer, its QA worker verifies; a holder that leads nobody cannot spawn one', async () => {
  const h = await ticketsHarness();
  try {
    const s = h.sessions;
    s.add({ id: 'orch', workspaceId: WS, agent: null });
    const t = h.tickets.create(UI, { summary: 'held by the lead', workspaceId: WS });
    h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: 'orch' }, status: 'in_progress' });
    s.add({ id: 'qaW', workspaceId: WS, agent: 'qa-verifier', parentId: 'orch' });
    const rec = (who: string) => h.tickets.recordVerdict(agent(WS, who), t.id, { role: 'qa', verdict: 'pass', commit: A });
    assert.throws(() => rec('qaW'), (e: any) => e.code === 'FORBIDDEN' && /descends from/.test(e.message), 'a holder with no worker on the ticket is the author');
    s.add({ id: 'impl', workspaceId: WS, agent: 'implementer', parentId: 'orch', ticketId: t.id });
    assert.equal(rec('qaW').actor, 'session:qaW', 'the holder leads the implementer: its QA is independent');
    s.add({ id: 'implQa', workspaceId: WS, agent: 'qa-verifier', parentId: 'impl' });
    assert.throws(() => rec('implQa'), (e: any) => e.code === 'FORBIDDEN', 'the implementer’s child is not');
  } finally {
    h.done();
  }
});

test('QA N3 (T-325 S1c): a holder that was itself started on the ticket is an author, even with a worker: its QA child is refused', async () => {
  const h = await ticketsHarness();
  try {
    const s = h.sessions;
    s.add({ id: 'orch', workspaceId: WS, agent: null });
    const t = h.tickets.create(UI, { summary: 'held by a session started on it', workspaceId: WS });
    h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: 'orch' }, status: 'in_progress' });
    s.sessions.get('orch')!.ticketId = t.id;
    s.add({ id: 'impl', workspaceId: WS, agent: 'implementer', parentId: 'orch', ticketId: t.id });
    s.add({ id: 'qaW', workspaceId: WS, agent: 'qa-verifier', parentId: 'orch' });
    assert.throws(() => h.tickets.recordVerdict(agent(WS, 'qaW'), t.id, { role: 'qa', verdict: 'pass', commit: A }), (e: any) => e.code === 'FORBIDDEN' && /descends from/.test(e.message));
    assert.equal(h.tickets.verdicts(UI, t.id).length, 0);
  } finally {
    h.done();
  }
});

test('QA N5 (T-325 S1c): a lineage ancestor of a lead holder (the session it continues) may be the parent of a QA worker', async () => {
  const h = await ticketsHarness();
  try {
    const s = h.sessions;
    s.add({ id: 'orchOld', workspaceId: WS, agent: null, state: 'ended' });
    s.add({ id: 'orch', workspaceId: WS, agent: null, continuedFrom: 'orchOld' });
    const t = h.tickets.create(UI, { summary: 'held by a continued lead', workspaceId: WS });
    h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: 'orch' }, status: 'in_progress' });
    s.add({ id: 'impl', workspaceId: WS, agent: 'implementer', parentId: 'orch', ticketId: t.id });
    s.add({ id: 'qaOldKid', workspaceId: WS, agent: 'qa-verifier', parentId: 'orchOld' });
    const v = h.tickets.recordVerdict(agent(WS, 'qaOldKid'), t.id, { role: 'qa', verdict: 'pass', commit: A });
    assert.equal(v.actor, 'session:qaOldKid');
  } finally {
    h.done();
  }
});

test('T-1603: a continued lead leads the workers its predecessor started: its QA worker verifies; a continued implementer still does not', async () => {
  const h = await ticketsHarness();
  try {
    const s = h.sessions;
    s.add({ id: 'leadOld', workspaceId: WS, agent: null });
    const t = h.tickets.create(UI, { summary: 'built under the ended lead', workspaceId: WS });
    h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: 'leadOld' }, status: 'in_progress' });
    s.add({ id: 'impl', workspaceId: WS, agent: 'implementer', parentId: 'leadOld', ticketId: t.id });
    s.sessions.get('leadOld')!.state = 'ended';
    s.add({ id: 'lead', workspaceId: WS, agent: null, continuedFrom: 'leadOld' });
    h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: 'lead' } });
    s.add({ id: 'qaNew', workspaceId: WS, agent: 'qa-verifier', parentId: 'lead' });
    const v = h.tickets.recordVerdict(agent(WS, 'qaNew'), t.id, { role: 'qa', verdict: 'pass', commit: A });
    assert.equal(v.actor, 'session:qaNew', 'the continuation leads its predecessor’s implementer');
    s.add({ id: 'implQa', workspaceId: WS, agent: 'qa-verifier', parentId: 'impl' });
    assert.throws(() => h.tickets.recordVerdict(agent(WS, 'implQa'), t.id, { role: 'qa', verdict: 'pass', commit: A }), (e: any) => e.code === 'FORBIDDEN');

    // A session started on the ticket, continued: its continuation holds it and its QA child is still refused (it is the author's line).
    s.add({ id: 'workerOld', workspaceId: WS, agent: 'implementer', state: 'ended', ticketId: t.id }); // never held it: started on it
    s.add({ id: 'worker', workspaceId: WS, agent: 'implementer', continuedFrom: 'workerOld' });
    s.add({ id: 'helper', workspaceId: WS, agent: 'implementer', parentId: 'workerOld', ticketId: t.id });
    h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: 'worker' } });
    s.add({ id: 'workerQa', workspaceId: WS, agent: 'qa-verifier', parentId: 'worker' });
    assert.throws(() => h.tickets.recordVerdict(agent(WS, 'workerQa'), t.id, { role: 'qa', verdict: 'pass', commit: A }), (e: any) => e.code === 'FORBIDDEN' && /descends from/.test(e.message));
  } finally {
    h.done();
  }
});

test('T-1603 review: a holder continuing a session nobody can look up does not lead; a continued implementer’s QA child is refused', async () => {
  const h = await ticketsHarness();
  try {
    const s = h.sessions;
    s.add({ id: 'lead', workspaceId: WS, agent: null, continuedFrom: 'ghost' });
    const t = h.tickets.create(UI, { summary: 'line with a missing session', workspaceId: WS });
    h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: 'lead' }, status: 'in_progress' });
    s.add({ id: 'impl', workspaceId: WS, agent: 'implementer', parentId: 'ghost', ticketId: t.id });
    s.add({ id: 'qa', workspaceId: WS, agent: 'qa-verifier', parentId: 'lead' });
    const rec = (who: string) => h.tickets.recordVerdict(agent(WS, who), t.id, { role: 'qa', verdict: 'pass', commit: A });
    assert.throws(() => rec('qa'), (e: any) => e.code === 'FORBIDDEN' && /descends from/.test(e.message), 'fail closed on the ghost');

    s.sessions.get('impl')!.state = 'ended';
    s.add({ id: 'impl2', workspaceId: WS, agent: 'implementer', continuedFrom: 'impl' });
    s.add({ id: 'impl2Qa', workspaceId: WS, agent: 'qa-verifier', parentId: 'impl2' });
    assert.throws(() => rec('impl2Qa'), (e: any) => e.code === 'FORBIDDEN', 'the continued implementer’s child');
    assert.equal(h.tickets.verdicts(UI, t.id).length, 0);
  } finally {
    h.done();
  }
});

test('QA M7 (T-325 S1b): a QA-named session started with this ticket_id is an author', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'qaOn', workspaceId: WS, agent: 'qa-verifier', parentId: 'lead', ticketId: r.id });
    assert.throws(() => record(r, 'qaOn', 'qa', 'pass', A), (e: any) => e.code === 'FORBIDDEN' && /author of this ticket/.test(e.message));
    assert.equal(r.tickets.verdicts(UI, r.id).length, 0);
  } finally {
    r.done();
  }
});

test('another workspace’s agent gets the same not found as for a missing ticket, and a closed-over ticket still takes no verdict from it', async () => {
  const r = await rig();
  try {
    const seen = (fn: () => unknown) => assert.throws(fn, (e: any) => e.code === 'NOT_FOUND');
    seen(() => record(r, 'qaX', 'qa', 'pass', A));
    seen(() => r.tickets.verdicts(agent('docker/other', 'qaX'), r.id));
    seen(() => r.tickets.recordVerdict(agent(WS, 'qa1'), 'T-9999', { role: 'qa', verdict: 'pass', commit: A }));
    assert.equal(r.tickets.verdicts(UI, r.id).length, 0);
  } finally {
    r.done();
  }
});

test('FR36c (T-1608): an agent putting a ticket on a QA or review session goes through, with one Portal note on the timeline; a person, an implementer: no note', async () => {
  const r = await rig();
  try {
    const lead = agent(WS, 'lead');
    const notes = (id: string) => r.tickets.get(UI, id).events.filter((e) => e.kind === 'comment' && e.data?.verdictLane);
    const warned = (id: string, who: string) => {
      const n = notes(id).filter((e) => e.data?.verdictLane === who);
      assert.equal(n.length, 1, `one note for ${who} on ${id}`);
      assert.equal(n[0]!.actor, 'system');
      assert.match(n[0]!.body!, new RegExp(`^${who} is a QA/review session: holding this ticket makes it an author of its work, so it can never record a verdict on it\\. If you meant it to verify, keep the ticket and brief the lane by ticket id\\.$`));
    };
    // The lead hands the ticket on (FR9d) to its QA lane, then to its review lane: both stick (a QA lane may hold QA work).
    assert.deepEqual(r.tickets.update(lead, r.id, { assignee: { kind: 'session', sessionId: 'qa1' } }).assignee, { kind: 'session', sessionId: 'qa1' });
    warned(r.id, 'qa1');
    assert.deepEqual(r.tickets.update(lead, r.id, { assignee: { kind: 'session', sessionId: 'rev1' } }).assignee, { kind: 'session', sessionId: 'rev1' });
    warned(r.id, 'rev1');
    const made = r.tickets.create(lead, { summary: 'QA plan', assignee: { kind: 'session', sessionId: 'qa1' } });
    warned(made.id, 'qa1');
    assert.equal(r.tickets.holderWarning(made)?.startsWith('qa1 is a QA/review session'), true);
    // A QA session claiming QA work for itself: claimed, and noted.
    const open = r.tickets.create(UI, { summary: 'perf suite', workspaceId: WS });
    assert.deepEqual(r.tickets.claimNext(agent(WS, 'qa1'), { id: open.id })!.assignee, { kind: 'session', sessionId: 'qa1' });
    warned(open.id, 'qa1');
    // The consequence is real: the lane that held the ticket can no longer record its verdict.
    assert.throws(() => record(r, 'qa1', 'qa', 'pass', A), (e: any) => e.code === 'FORBIDDEN' && /author/.test(e.message));
    // An implementer holder: no note, no warning. A person putting a ticket on a QA session: no note (the portal is the owner).
    r.sessions.add({ id: 'impl2', workspaceId: WS, agent: 'implementer', parentId: 'lead' });
    const toImpl = r.tickets.update(lead, r.id, { assignee: { kind: 'session', sessionId: 'impl2' } });
    assert.equal(r.tickets.holderWarning(toImpl), null);
    const byPerson = r.tickets.create(UI, { summary: 'by a person', workspaceId: WS });
    r.tickets.update(UI, byPerson.id, { assignee: { kind: 'session', sessionId: 'rev1' } });
    assert.equal(notes(byPerson.id).length, 0);
    assert.equal(notes(r.id).length, 2, 'the implementer hand-off added none');
  } finally {
    r.done();
  }
});

test('the stale-PASS guard on the stored rows: a PASS on the old head does not make the moved head pass', async () => {
  const r = await rig();
  try {
    record(r, 'qa1', 'qa', 'pass', A);
    assert.equal(r.tickets.verdictStatus(UI, r.id, A).pass, true);
    assert.deepEqual(r.tickets.verdictStatus(UI, r.id, B), { pass: false, roles: { qa: 'stale' } });
    record(r, 'qa1', 'qa', 'fail', A);
    assert.equal(r.tickets.verdictStatus(UI, r.id, A).pass, false, 'a later FAIL on the same commit voids the PASS');
    assert.throws(() => r.tickets.verdictStatus(UI, r.id, 'abc1234'), (e: any) => e.code === 'VALIDATION_FAILED');
  } finally {
    r.done();
  }
});

test('verdictsHeldBy (T-1613): the verdicts since a time on the open tickets a session holds, oldest first; none for another session or a closed ticket', async () => {
  const r = await rig();
  try {
    const before = Date.now() - 1000;
    record(r, 'qa1', 'qa', 'pass', A);
    record(r, 'rev1', 'review', 'fail', A);
    const held = r.tickets.verdictsHeldBy('impl', before);
    assert.deepEqual(held.map((v) => [v.ticket, v.role, v.verdict]), [[r.id, 'qa', 'pass'], [r.id, 'review', 'fail']]);
    assert.ok(held[0]!.id < held[1]!.id, 'oldest first, by row id');
    assert.deepEqual(r.tickets.verdictsHeldBy('lead', before), [], 'the lead does not hold it');
    assert.deepEqual(r.tickets.verdictsHeldBy('impl', Date.now() + 60_000), [], 'nothing after a later time');
    r.tickets.close(UI, r.id, { summary: 'done' });
    assert.deepEqual(r.tickets.verdictsHeldBy('impl', before), [], 'a closed ticket is not news');
  } finally {
    r.done();
  }
});

test('readyToCloseHeldBy (T-1616): held, in review, and the latest verdict a pass; a later fail, another holder or another status is not listed', async () => {
  const r = await rig();
  try {
    record(r, 'qa1', 'qa', 'pass', A);
    assert.deepEqual(r.tickets.readyToCloseHeldBy('impl'), [], 'in progress, not in review');
    r.tickets.update(UI, r.id, { status: 'in_review' });
    assert.deepEqual(r.tickets.readyToCloseHeldBy('impl'), [{ ticket: r.id, role: 'qa' }], 'held, in review, passed');
    assert.deepEqual(r.tickets.readyToCloseHeldBy('lead'), [], 'held by someone else');

    // A second ticket, held by the lead, in review: a QA pass then a review fail. The latest verdict decides.
    const t2 = r.tickets.create(UI, { summary: 'second', workspaceId: WS });
    r.tickets.update(UI, t2.id, { assignee: { kind: 'session', sessionId: 'impl' }, status: 'in_review' });
    const rec2 = (who: string, role: string, verdict: string) =>
      r.tickets.recordVerdict(agent(WS, who), t2.id, { role, verdict, commit: A });
    rec2('qa1', 'qa', 'fail');
    assert.deepEqual(r.tickets.readyToCloseHeldBy('impl').map((x) => x.ticket), [r.id], 'a fail is not listed');
    rec2('qa1', 'qa', 'pass');
    assert.deepEqual(r.tickets.readyToCloseHeldBy('impl').map((x) => x.ticket), [r.id, t2.id], 'a pass after it is');
    rec2('rev1', 'review', 'fail');
    assert.deepEqual(r.tickets.readyToCloseHeldBy('impl').map((x) => x.ticket), [r.id], 'a later fail of another role takes it off');
    r.tickets.update(UI, r.id, { assignee: { kind: 'session', sessionId: 'lead' } });
    assert.deepEqual(r.tickets.readyToCloseHeldBy('impl'), [], 'handed to another holder');
    assert.deepEqual(r.tickets.readyToCloseHeldBy('lead'), [{ ticket: r.id, role: 'qa' }]);
  } finally {
    r.done();
  }
});

test('migration 785: a ticket_verdicts table, a unique version, and the table itself refuses a short sha', async () => {
  assert.equal(MIGRATIONS.filter((m) => m.version === 785).length, 1);
  assert.equal(new Set(MIGRATIONS.map((m) => m.version)).size, MIGRATIONS.length, 'versions are unique');
  const r = await rig();
  try {
    const db = r.store.db!;
    assert.throws(() => db.prepare("INSERT INTO ticket_verdicts (ticket_number, role, verdict, commit_sha, actor, actor_label, at) VALUES (1, 'qa', 'pass', 'abc', 'ui', 'x', 'now')").run());
    assert.throws(() => db.prepare("INSERT INTO ticket_verdicts (ticket_number, role, verdict, commit_sha, actor, actor_label, at) VALUES (1, 'lead', 'pass', ?, 'ui', 'x', 'now')").run(A));
  } finally {
    r.done();
  }
});

test('T-1652: a lead that handed the ticket to its own worker leads the work: its QA verifies; QA under the builder still does not', async () => {
  const h = await ticketsHarness();
  try {
    const s = h.sessions;
    s.add({ id: 'orch', workspaceId: WS, agent: null });
    s.add({ id: 'lead', workspaceId: WS, agent: null, parentId: 'orch' });
    const t = h.tickets.create(UI, { summary: 'lead hands to its worker', workspaceId: WS });
    h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: 'orch' }, status: 'in_progress' });
    h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: 'lead' } });
    s.add({ id: 'fe2', workspaceId: WS, agent: 'implementer', parentId: 'lead', ticketId: t.id });
    h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: 'fe2' } });
    const rec = (who: string) => h.tickets.recordVerdict(agent(WS, who), t.id, { role: 'qa', verdict: 'pass', commit: A });
    const refused = (who: string, why: RegExp, msg: string) => assert.throws(() => rec(who), (e: any) => e.code === 'FORBIDDEN' && why.test(e.message), msg);

    s.add({ id: 'qaLead', workspaceId: WS, agent: 'qa-verifier', parentId: 'lead' });
    assert.equal(rec('qaLead').actor, 'session:qaLead', 'the past-holder lead’s QA child');
    s.add({ id: 'qaOrch', workspaceId: WS, agent: 'qa-verifier', parentId: 'orch' });
    assert.equal(rec('qaOrch').actor, 'session:qaOrch', 'a past holder further up the parent chain leads too');

    s.add({ id: 'qaFe', workspaceId: WS, agent: 'qa-verifier', parentId: 'fe2' });
    refused('qaFe', /descends from/, 'QA under the builder');
    s.add({ id: 'qaDeep', workspaceId: WS, agent: 'qa-verifier', parentId: 'qaFe' });
    refused('qaDeep', /descends from/, 'QA under the builder, two levels down');
    refused('fe2', /./, 'the builder itself (not a QA agent either)');
    refused('lead', /./, 'the lead itself is no verifier');
    s.sessions.get('fe2')!.agent = 'qa-verifier';
    refused('fe2', /author of this ticket/, 'a builder named as QA is a self-verdict');
    s.sessions.get('fe2')!.agent = 'implementer';
    assert.equal(h.tickets.verdicts(UI, t.id).length, 2);
  } finally {
    h.done();
  }
});

test('T-1652: a past holder started on the ticket is still an author: its QA child, and its continuation’s, are refused', async () => {
  const h = await ticketsHarness();
  try {
    const s = h.sessions;
    const t = h.tickets.create(UI, { summary: 'coding lead hands over', workspaceId: WS });
    // The lead was started on the ticket and coded, then handed it to a worker of its own.
    s.add({ id: 'lead', workspaceId: WS, agent: 'implementer', ticketId: t.id });
    h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: 'lead' }, status: 'in_progress' });
    s.add({ id: 'w', workspaceId: WS, agent: 'implementer', parentId: 'lead', ticketId: t.id });
    h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId: 'w' } });
    const rec = (who: string) => h.tickets.recordVerdict(agent(WS, who), t.id, { role: 'qa', verdict: 'pass', commit: A });
    s.add({ id: 'qaLead', workspaceId: WS, agent: 'qa-verifier', parentId: 'lead' });
    assert.throws(() => rec('qaLead'), (e: any) => e.code === 'FORBIDDEN' && /descends from/.test(e.message), 'the coding lead’s QA');

    // A past holder whose predecessor was started on the ticket: the line is the author's, refused.
    const t2 = h.tickets.create(UI, { summary: 'continued coder hands over', workspaceId: WS });
    s.add({ id: 'coderOld', workspaceId: WS, agent: 'implementer', state: 'ended', ticketId: t2.id });
    s.add({ id: 'coder', workspaceId: WS, agent: null, continuedFrom: 'coderOld' });
    h.tickets.update(UI, t2.id, { assignee: { kind: 'session', sessionId: 'coder' }, status: 'in_progress' });
    s.add({ id: 'w2', workspaceId: WS, agent: 'implementer', parentId: 'coder', ticketId: t2.id });
    h.tickets.update(UI, t2.id, { assignee: { kind: 'session', sessionId: 'w2' } });
    s.add({ id: 'qaCoder', workspaceId: WS, agent: 'qa-verifier', parentId: 'coder' });
    assert.throws(() => h.tickets.recordVerdict(agent(WS, 'qaCoder'), t2.id, { role: 'qa', verdict: 'pass', commit: A }), (e: any) => e.code === 'FORBIDDEN' && /descends from/.test(e.message));

    // A past holder that is not an ancestor of the holder (a sibling it was handed to) is no lead: its QA is refused.
    const t3 = h.tickets.create(UI, { summary: 'sideways hand-off', workspaceId: WS });
    s.add({ id: 'peer', workspaceId: WS, agent: null });
    h.tickets.update(UI, t3.id, { assignee: { kind: 'session', sessionId: 'peer' }, status: 'in_progress' });
    s.add({ id: 'other', workspaceId: WS, agent: null });
    s.add({ id: 'w3', workspaceId: WS, agent: 'implementer', parentId: 'other', ticketId: t3.id });
    h.tickets.update(UI, t3.id, { assignee: { kind: 'session', sessionId: 'w3' } });
    s.add({ id: 'qaPeer', workspaceId: WS, agent: 'qa-verifier', parentId: 'peer' });
    assert.throws(() => h.tickets.recordVerdict(agent(WS, 'qaPeer'), t3.id, { role: 'qa', verdict: 'pass', commit: A }), (e: any) => e.code === 'FORBIDDEN' && /descends from/.test(e.message));

    // A gap in the parent chain (a session nobody can look up) fails closed.
    const t4 = h.tickets.create(UI, { summary: 'ghost between', workspaceId: WS });
    s.add({ id: 'top', workspaceId: WS, agent: null });
    h.tickets.update(UI, t4.id, { assignee: { kind: 'session', sessionId: 'top' }, status: 'in_progress' });
    s.add({ id: 'w4', workspaceId: WS, agent: 'implementer', parentId: 'ghost', ticketId: t4.id });
    h.tickets.update(UI, t4.id, { assignee: { kind: 'session', sessionId: 'w4' } });
    s.add({ id: 'qaTop', workspaceId: WS, agent: 'qa-verifier', parentId: 'top' });
    assert.throws(() => h.tickets.recordVerdict(agent(WS, 'qaTop'), t4.id, { role: 'qa', verdict: 'pass', commit: A }), (e: any) => e.code === 'FORBIDDEN');
    for (const id of [t.id, t2.id, t3.id, t4.id]) assert.equal(h.tickets.verdicts(UI, id).length, 0);
  } finally {
    h.done();
  }
});
