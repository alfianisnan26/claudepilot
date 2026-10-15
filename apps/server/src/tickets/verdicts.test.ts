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
  const base = { callerKind: 'agent' as const, role: 'qa' as const, session: { id: 'q', agent: 'qa-verifier' }, authors: none, leads: none, commit: A };
  assert.deepEqual(canRecordVerdict(base), { allow: true });
  assert.deepEqual(canRecordVerdict({ ...base, callerKind: 'ui', session: null }), { allow: true });
  assert.deepEqual(canRecordVerdict({ ...base, commit: null }), { allow: false, why: 'bad_commit' });
  assert.deepEqual(canRecordVerdict({ ...base, authors: new Set(['q']) }), { allow: false, why: 'is_author' });
  assert.deepEqual(canRecordVerdict({ ...base, leads: new Set(['q']) }), { allow: false, why: 'is_lead' });
  assert.deepEqual(canRecordVerdict({ ...base, role: 'review' }), { allow: false, why: 'wrong_role' });
  assert.deepEqual(canRecordVerdict({ ...base, session: { id: 'i', agent: 'implementer' } }), { allow: false, why: 'not_a_verifier' });
  assert.deepEqual(canRecordVerdict({ ...base, session: { id: 'l', agent: null } }), { allow: false, why: 'not_a_verifier' }, 'a lead is no verifier');
  for (const callerKind of ['system', 'token', 'trigger'] as const) assert.deepEqual(canRecordVerdict({ ...base, callerKind, session: null }), { allow: false, why: 'not_a_verifier' }, callerKind);
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
