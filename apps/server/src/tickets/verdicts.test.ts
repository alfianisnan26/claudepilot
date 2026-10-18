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

test('FR36c (T-1608): an agent never puts a ticket on a QA or review session, itself included; a person may; an implementer still takes one', async () => {
  const r = await rig();
  try {
    const lead = agent(WS, 'lead');
    const lane = (fn: () => unknown, who: string) =>
      assert.throws(fn, (e: any) => e.code === 'CONFLICT' && e.message.startsWith(`${who} is a QA/review session`) && /brief the lane by ticket id/.test(e.message));
    // The lead hands the ticket on (FR9d): to its QA lane and to its review lane it is refused, the ticket stays where it was.
    lane(() => r.tickets.update(lead, r.id, { assignee: { kind: 'session', sessionId: 'qa1' } }), 'qa1');
    lane(() => r.tickets.update(lead, r.id, { assignee: { kind: 'session', sessionId: 'rev1' } }), 'rev1');
    lane(() => r.tickets.create(lead, { summary: 'for QA', assignee: { kind: 'session', sessionId: 'qa1' } }), 'qa1');
    assert.deepEqual(r.tickets.get(UI, r.id).ticket.assignee, { kind: 'session', sessionId: 'impl' });
    // A QA or review session claiming a ticket for itself.
    const open = r.tickets.create(UI, { summary: 'queue work', workspaceId: WS });
    lane(() => r.tickets.claimNext(agent(WS, 'qa1'), { id: open.id }), 'qa1');
    lane(() => r.tickets.claimNext(agent(WS, 'rev1'), {}), 'rev1');
    assert.equal(r.tickets.get(UI, open.id).ticket.assignee, null, 'still in the queue');
    // The lane can still record its verdict: it never became an author.
    assert.equal(record(r, 'qa1', 'qa', 'pass', A).verdict, 'pass');
    // An implementer still takes work from the lead; a person may still put a ticket on a QA session (the portal is the owner).
    r.sessions.add({ id: 'impl2', workspaceId: WS, agent: 'implementer', parentId: 'lead' });
    assert.equal((r.tickets.update(lead, r.id, { assignee: { kind: 'session', sessionId: 'impl2' } }).assignee as any).sessionId, 'impl2');
    assert.equal((r.tickets.update(UI, open.id, { assignee: { kind: 'session', sessionId: 'qa1' } }).assignee as any).sessionId, 'qa1');
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
