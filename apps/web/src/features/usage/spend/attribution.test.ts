import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatedFigure, unavailableFigure, type AttributionRow, type ChatUsageTotals } from '@portal/contracts';
import { countsLine, coverageNote, maxTotal, rowName, sessionLine, shareText, ticketLine } from './attribution.js';

const totals = (costUsd: number, requests: number): ChatUsageTotals => ({ costUsd, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests, agents: 0 });
const row = (over: Partial<AttributionRow>): AttributionRow => ({ by: 'session', key: 'uus-1', label: 'Refactor billing', state: 'known', own: totals(0.5, 2), total: totals(1, 3), share: estimatedFigure(23.75), sessions: 2, firstAt: null, lastAt: null, ...over });
const session = (over: Partial<NonNullable<AttributionRow['session']>> = {}): NonNullable<AttributionRow['session']> => ({ sessionId: 'uus-1', title: 'Refactor billing', workspaceId: 'docker/uuws', workspaceName: 'uuws', claudeId: 'c1', claudeName: 'Satria', ticketId: 'T-12', parentId: null, continuedFrom: null, depth: 0, children: 1, exists: true, state: 'ended', ...over });

// The seeded fixture, by hand: "Refactor billing" ran two requests of its own ($0.30 + $0.20 = $0.50) and started "Write the tests" ($0.50), so its
// total is $1.00 of the window's $4.21 (23.75 %), and the child's own and total are both $0.50.
test('a session that started others shows its own dollars beside the total (which includes them)', () => {
  const parent = row({ session: session() });
  assert.deepEqual(sessionLine(parent), { claude: 'Satria', claudeId: 'c1', ticket: 'T-12', own: 'own $0.50', deleted: false });
  const child = row({ key: 'uus-2', label: 'Write the tests', own: totals(0.5, 1), total: totals(0.5, 1), session: session({ sessionId: 'uus-2', depth: 1, children: 0, ticketId: null }) });
  assert.deepEqual(sessionLine(child), { claude: 'Satria', claudeId: 'c1', ticket: null, own: null, deleted: false });
});

test('a deleted session is marked, and a row without session facts has no line', () => {
  assert.equal(sessionLine(row({ session: session({ exists: false, state: null }) }))!.deleted, true);
  assert.equal(sessionLine(row({ by: 'ticket' })), null);
});

test('shares are rounded percents, "-" where the server could not tell', () => {
  assert.equal(shareText(estimatedFigure(23.75)), '24 %');
  assert.equal(shareText(estimatedFigure(0.48)), '0 %');
  assert.equal(shareText(unavailableFigure('no_samples')), '-');
});

test('names: the server label, "Others" for the rest of the roots', () => {
  assert.equal(rowName(row({ label: 'No ticket', state: 'none', key: '' })), 'No ticket');
  assert.equal(rowName(row({ label: '', state: 'others', key: 'others' })), 'Others');
  assert.equal(rowName(row({ label: 'Not recorded', state: 'unknown', key: '', reason: 'not_recorded' })), 'Not recorded');
});

test('counts: sessions and requests behind a workspace, a ticket or a persona', () => {
  assert.equal(countsLine(row({ by: 'ticket', sessions: 2, total: totals(1, 3) })), '2 sessions · 3 requests');
  assert.equal(countsLine(row({ by: 'ticket', sessions: 1, total: totals(0.3, 1) })), '1 session · 1 request');
});

test('the biggest total sets the bars, not the "Others" row', () => {
  assert.equal(maxTotal([row({ total: totals(1.2, 1) }), row({ total: totals(0.5, 1) }), row({ state: 'others', total: totals(9, 9) })]), 1.2);
  assert.equal(maxTotal([]), 0);
});

// Persona by hand: Reviewer $0.50 and "No persona" $0.90 are known; $2.81 of the $4.21 was never recorded: (0.50 + 0.90) / 4.21 = 33.25 %.
test('coverage: said below 100 %, quiet at 100 % and when it cannot be told', () => {
  assert.deepEqual(coverageNote({ coverage: estimatedFigure(33.25) }), { pct: 33 });
  assert.equal(coverageNote({ coverage: estimatedFigure(100) }), null);
  assert.equal(coverageNote({ coverage: unavailableFigure('no_samples') }), null);
});

// T-449: a ticket row says its type and status and, when leads' dollars were apportioned to it, "via lead $x".
test('a ticket row shows type, status and via lead only when there is one', () => {
  const t = (viaLeadUsd: number) => row({ by: 'ticket', key: 'T-1', ticket: { type: 'feature', status: 'in_review', doneAt: null, viaLeadUsd, viaLeadWorkers: viaLeadUsd > 0 ? 2 : 0 } });
  assert.deepEqual(ticketLine(t(6.5)), { type: 'feature', status: 'in review', viaLead: 'via lead $6.50' });
  assert.deepEqual(ticketLine(t(0)), { type: 'feature', status: 'in review', viaLead: null });
  assert.equal(ticketLine(row({})), null);
});
