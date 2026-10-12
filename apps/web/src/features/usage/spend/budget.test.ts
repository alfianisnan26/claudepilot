import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatedFigure, measuredFigure, type Budget, type BudgetLevel, type BudgetState } from '@portal/contracts';
import { budgetName, EMPTY_FORM, formFrom, limitText, parseScope, pausedSentence, resetWords, scopeValue, sortBudgets, toInput, usedText } from './budget.js';

const budget = (over: Partial<Budget> = {}): Budget => ({ id: 'b1', name: '', scope: { kind: 'all', id: null }, period: 'day', limitUsd: 5, limitTokens: null, mode: 'alert', enabled: true, createdBy: 'u_owner', createdAt: '2026-10-12T05:40:00Z', updatedAt: '2026-10-12T05:40:00Z', ...over });
const state = (b: Budget, over: Partial<BudgetState> = {}): BudgetState => ({
  budget: b,
  scopeLabel: 'Everything',
  periodStart: '2026-10-12T00:00:00Z',
  periodEnd: '2026-10-13T00:00:00Z',
  timezone: 'UTC',
  usedUsd: estimatedFigure(2.77),
  usedTokens: measuredFigure(52_700),
  usedPct: estimatedFigure(55.4),
  limiting: 'usd',
  level: 'ok',
  paused: false,
  snoozedUntil: null,
  ...over,
});

// The seeded fixture, worked by hand: Everything per day $5 with $2.77 spent today (55.4 %); Satria per day $1.04 with $1.00 spent (96.2 %, over the
// 95 % mark); Kresna per month 500000 tokens with 17600 spent (3.5 %); the workspace per day $2 with $2.35 spent (117.5 %, used up).
test('names and limits read as a person would say them', () => {
  assert.equal(budgetName(state(budget())), 'Everything · day');
  assert.equal(budgetName(state(budget({ name: 'Kresna tokens' }), { scopeLabel: 'Kresna · uuws' })), 'Kresna tokens');
  assert.equal(budgetName(state(budget({ period: 'month' }), { scopeLabel: null })), 'Removed · month');
  assert.equal(limitText(budget({ limitUsd: 1.04, limitTokens: null })), '$1.04');
  assert.equal(limitText(budget({ limitUsd: null, limitTokens: 500_000 })), '500k tokens');
  assert.equal(limitText(budget({ limitUsd: 5, limitTokens: 2_000_000 })), '$5 · 2.0M tokens');
});

test('used of the limit that decides: dollars in dollars, tokens in tokens', () => {
  assert.equal(usedText(state(budget())), '$2.77 of $5');
  assert.equal(usedText(state(budget({ limitUsd: null, limitTokens: 500_000 }), { limiting: 'tokens', usedTokens: measuredFigure(17_600) })), '18k of 500k tokens');
  assert.equal(usedText(state(budget({ limitUsd: 1.04 }), { usedUsd: estimatedFigure(1) })), '$1 of $1.04');
});

test('the period end reads as a countdown', () => {
  // 05:40 to 00:00 the next day is 18 h 20 m.
  assert.equal(resetWords('2026-10-13T00:00:00Z', Date.parse('2026-10-12T05:40:00Z')), 'resets in 18 h 20 m');
  assert.equal(resetWords('2026-10-12T05:00:00Z', Date.parse('2026-10-12T05:40:00Z')), 'resets now');
});

test('the neediest budget first: used up, then 95 %, then 80 %, the fuller within a level, disabled last', () => {
  const pct = (v: number, level: BudgetLevel, id: string, enabled = true) => state(budget({ id, enabled, createdAt: `2026-10-12T05:4${id.length}:00Z` }), { usedPct: estimatedFigure(v), level });
  const rows = [pct(55.4, 'ok', 'everything'), pct(96.2, 'high', 'satria'), pct(3.5, 'ok', 'k'), pct(117.5, 'exhausted', 'ws'), pct(99, 'high', 'big'), pct(130, 'exhausted', 'off', false)];
  assert.deepEqual(sortBudgets(rows).map((r) => r.budget.id), ['ws', 'big', 'satria', 'everything', 'k', 'off']);
});

test('the scope travels as one string and back', () => {
  assert.equal(scopeValue({ kind: 'all', id: null }), 'all');
  assert.equal(scopeValue({ kind: 'claude', id: '8d20' }), 'claude:8d20');
  assert.deepEqual(parseScope('workspace:docker/uuws'), { kind: 'workspace', id: 'docker/uuws' });
  assert.deepEqual(parseScope('claude:8d20'), { kind: 'claude', id: '8d20' });
  assert.deepEqual(parseScope('all'), { kind: 'all', id: null });
});

test('the form: a dollar limit, a token limit or both; at least one; above zero; tokens whole', () => {
  const ok = toInput({ ...EMPTY_FORM, scope: 'claude:8d20', usd: '1.04' });
  assert.deepEqual(ok.input, { name: '', scope: { kind: 'claude', id: '8d20' }, period: 'day', limitUsd: 1.04, limitTokens: null, mode: 'alert' });
  assert.deepEqual(toInput({ ...EMPTY_FORM, tokens: '500,000', period: 'month', pause: true, name: ' Kresna tokens ' }).input, { name: 'Kresna tokens', scope: { kind: 'all', id: null }, period: 'month', limitUsd: null, limitTokens: 500_000, mode: 'pause' });
  assert.deepEqual(toInput(EMPTY_FORM).errors, { limits: 'Set a dollar or a token limit.' });
  assert.deepEqual(toInput({ ...EMPTY_FORM, usd: '0' }).errors, { usd: 'Above 0.' });
  assert.deepEqual(toInput({ ...EMPTY_FORM, usd: 'abc', tokens: '1.5' }).errors, { usd: 'Above 0.', tokens: 'A whole number above 0.' });
  assert.deepEqual(toInput({ ...EMPTY_FORM, usd: '1', name: 'x'.repeat(61) }).errors, { name: 'At most 60 characters.' });
});

test('editing starts from what the budget is', () => {
  const b = budget({ name: 'N', scope: { kind: 'workspace', id: 'docker/uuws' }, period: 'month', limitUsd: 2, limitTokens: 100, mode: 'pause' });
  assert.deepEqual(formFrom(b), { name: 'N', scope: 'workspace:docker/uuws', period: 'month', usd: '2', tokens: '100', pause: true });
  assert.deepEqual(toInput(formFrom(b)).input, { name: 'N', scope: b.scope, period: 'month', limitUsd: 2, limitTokens: 100, mode: 'pause' });
});

// The sentence a refused message carries, worded from the state: the workspace's daily budget of $2 with $2.35 spent ends at 00:00 on 13 Oct (UTC).
test('a budget that pauses says what the composer says when it refuses a message', () => {
  const b = budget({ scope: { kind: 'workspace', id: 'docker/uuws' }, limitUsd: 2, mode: 'pause' });
  const s = state(b, { scopeLabel: 'uuws', usedUsd: estimatedFigure(2.35), level: 'exhausted', paused: true });
  assert.equal(
    pausedSentence(s),
    'The uuws daily budget is used up ($2.35 of $2.00, estimated). New messages are paused until it resets on 13 Oct 2026, 00:00 (UTC), or until it is raised or set to alerts only (Usage › Budgets).',
  );
  const both = state(budget({ name: 'Kresna tokens', limitUsd: 1, limitTokens: 500_000, period: 'month', mode: 'pause' }), { usedUsd: estimatedFigure(0.4), usedTokens: measuredFigure(512_345), periodEnd: '2026-11-01T00:00:00Z' });
  assert.equal(
    pausedSentence(both),
    'The Kresna tokens budget is used up ($0.40 of $1.00, estimated; 512,345 of 500,000 tokens). New messages are paused until it resets on 1 Nov 2026, 00:00 (UTC), or until it is raised or set to alerts only (Usage › Budgets).',
  );
});
