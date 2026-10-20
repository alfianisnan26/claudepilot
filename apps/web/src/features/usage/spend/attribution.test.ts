import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatedFigure, unavailableFigure, type AttributionRow, type ChatUsageTotals } from '@portal/contracts';
import { ATTRIBUTION_PAGE, countsLine, coverageNote, foldRows, maxTotal, nestedText, pageItems, rowName, sessionLine, shareText, ticketLine } from './attribution.js';

const totals = (costUsd: number, requests: number): ChatUsageTotals => ({ costUsd, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests, agents: 0 });
const row = (over: Partial<AttributionRow>): AttributionRow => ({ by: 'session', key: 'uus-1', label: 'Refactor billing', state: 'known', own: totals(0.5, 2), total: totals(1, 3), share: estimatedFigure(23.75), sessions: 2, firstAt: null, lastAt: null, ...over });
const session = (over: Partial<NonNullable<AttributionRow['session']>> = {}): NonNullable<AttributionRow['session']> => ({ sessionId: 'uus-1', title: 'Refactor billing', workspaceId: 'docker/uuws', workspaceName: 'uuws', claudeId: 'c1', claudeName: 'Satria', ticketId: 'T-12', parentId: null, continuedFrom: null, depth: 0, children: 1, exists: true, state: 'ended', ...over });

// The seeded fixture, by hand: "Refactor billing" ran two requests of its own ($0.30 + $0.20 = $0.50) and started "Write the tests" ($0.50), so its
// total is $1.00 of the window's $4.21 (23.75 %), and the child's own and total are both $0.50.
test('a session that started others shows its own dollars beside the total (which includes them)', () => {
  const parent = row({ session: session() });
  assert.deepEqual(sessionLine(parent), { claude: 'Satria', claudeId: 'c1', ticket: 'T-12', own: 'own $0.50', deleted: false, continued: false });
  const child = row({ key: 'uus-2', label: 'Write the tests', own: totals(0.5, 1), total: totals(0.5, 1), session: session({ sessionId: 'uus-2', depth: 1, children: 0, ticketId: null }) });
  assert.deepEqual(sessionLine(child), { claude: 'Satria', claudeId: 'c1', ticket: null, own: null, deleted: false, continued: false });
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
  assert.deepEqual(ticketLine(t(6.5)), { type: 'feature', status: 'in review', viaLead: 'via lead $6.5' });
  assert.deepEqual(ticketLine(t(0)), { type: 'feature', status: 'in review', viaLead: null });
  assert.equal(ticketLine(row({})), null);
});

test('a ticket the portal does not know says "unknown" in words, not a dash', () => {
  const line = ticketLine(row({ by: 'ticket', key: 'T-9199', ticket: { type: null, status: null, doneAt: null, viaLeadUsd: 0, viaLeadWorkers: 0 } }));
  assert.deepEqual(line, { type: 'unknown', status: 'unknown', viaLead: null });
});

test('a later row of a continued chat says so, the chain root does not', () => {
  assert.equal(sessionLine(row({ session: session({ continuedFrom: 'uus-0', depth: 1, children: 0 }) }))!.continued, true);
  assert.equal(sessionLine(row({ session: session({ continuedFrom: null, depth: 1 }) }))!.continued, false);
});

// T-377 / T-955: a tree of two leads. Lead A ($3) started W1 ($1, which started W1a $0.4) and W2 ($0.5); lead B ($2) started nothing. The
// server sends it in tree order; a buggy feed repeats lead A at the top level.
const s = (key: string, depth: number, cost: number, children = 0): AttributionRow =>
  row({ key, label: key, own: totals(cost, 1), total: totals(cost, 1), session: session({ sessionId: key, depth, children }) });

test('fold: agents nest under their lead, in tree order, others and unrecorded rows apart', () => {
  const others = row({ key: 'others', label: 'Others', state: 'others', session: undefined });
  const none = row({ key: '', label: 'No ticket', state: 'none', session: undefined });
  const f = foldRows([s('A', 0, 3, 2), s('W1', 1, 1, 1), s('W1a', 2, 0.4), s('W2', 1, 0.5), s('B', 0, 2), others, none]);
  assert.deepEqual(f.items.map((i) => [i.row.key, i.nested.map((n) => n.key)]), [['A', ['W1', 'W1a', 'W2']], ['B', []]]);
  assert.equal(f.others, others);
  assert.deepEqual(f.tail, [none]);
  assert.equal(nestedText(f.items[0]!.nested.length), '3 agents');
  assert.equal(nestedText(1), '1 agent');
});

test('fold: a lead that comes twice is listed once (T-955), its agents still under it', () => {
  const f = foldRows([s('A', 0, 3, 1), s('W1', 1, 1), s('A', 0, 3, 1), s('W1', 1, 1), s('B', 0, 2)]);
  assert.deepEqual(f.items.map((i) => [i.row.key, i.nested.map((n) => n.key)]), [['A', ['W1']], ['B', []]]);
  // A lead seen once as a nested row is not listed again at the top level either.
  const g = foldRows([s('A', 0, 3, 1), s('L', 1, 1), s('L', 0, 1)]);
  assert.deepEqual(g.items.map((i) => i.row.key), ['A']);
});

test('fold: a flat dimension (no session facts) is one item per row; a nested row with no lead before it stands alone', () => {
  const f = foldRows([row({ by: 'ticket', key: 'T-1', session: undefined }), row({ by: 'ticket', key: 'T-2', session: undefined })]);
  assert.deepEqual(f.items.map((i) => [i.row.key, i.nested.length]), [['T-1', 0], ['T-2', 0]]);
  assert.deepEqual(foldRows([s('W', 1, 1)]).items.map((i) => i.row.key), ['W']);
});

test('paging: the first page, then each Load more adds a page, never past the end', () => {
  const items = Array.from({ length: 23 }, (_, i) => i);
  assert.equal(ATTRIBUTION_PAGE, 10);
  assert.deepEqual(pageItems(items, ATTRIBUTION_PAGE), { visible: items.slice(0, 10), left: 13 });
  assert.deepEqual(pageItems(items, 20).left, 3);
  assert.deepEqual(pageItems(items, 30), { visible: items, left: 0 });
  assert.deepEqual(pageItems([], 10), { visible: [], left: 0 });
});
