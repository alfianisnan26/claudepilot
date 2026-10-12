import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { alertKey, levelOf, measure, parseBudget, type BudgetFields } from './budgets.js';

const fails = (fn: () => unknown, field: string) => {
  try {
    fn();
  } catch (e) {
    assert.ok(isAppError(e), `an AppError, got ${String(e)}`);
    assert.equal((e as { code: string }).code, 'VALIDATION_FAILED');
    assert.ok(field in ((e as { details?: Record<string, unknown> }).details ?? {}), `the error names ${field}`);
    return;
  }
  assert.fail('should have been refused');
};

test('levels: 80 near, 95 high, 100 used up, exactly on the line counts', () => {
  assert.deepEqual([0, 79.99, 80, 94.99, 95, 99.99, 100, 250].map(levelOf), ['ok', 'ok', 'near', 'near', 'high', 'high', 'exhausted', 'exhausted']);
});

test('measure: the fuller of the dollar and token ratios, dollars when they tie, and it can pass 100', () => {
  // $8 of $10 is 80 %.
  assert.deepEqual(measure({ usd: 8, tokens: 0 }, { usd: 10, tokens: null }), { pct: 80, limiting: 'usd' });
  // $2 of $10 is 20 %, 900,000 of 1,000,000 tokens is 90 %: the tokens are fuller.
  assert.deepEqual(measure({ usd: 2, tokens: 900_000 }, { usd: 10, tokens: 1_000_000 }), { pct: 90, limiting: 'tokens' });
  // A tie goes to dollars.
  assert.deepEqual(measure({ usd: 5, tokens: 500_000 }, { usd: 10, tokens: 1_000_000 }), { pct: 50, limiting: 'usd' });
  // Tokens only; over the limit.
  assert.deepEqual(measure({ usd: 99, tokens: 1_500_000 }, { usd: null, tokens: 1_000_000 }), { pct: 150, limiting: 'tokens' });
  // 8.5 of 10 has no floating-point dust at the 80 % line: 80 / 100 x 10 is exactly 8.
  assert.equal(levelOf(measure({ usd: 8, tokens: 0 }, { usd: 10, tokens: null }).pct), 'near');
  assert.equal(levelOf(measure({ usd: 0.58, tokens: 0 }, { usd: 1, tokens: null }).pct), 'ok', '58 % is not near');
});

test('a new budget needs a scope, a period and one limit; the rest has defaults (alert only, enabled)', () => {
  assert.deepEqual(parseBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: 10 }), {
    name: '',
    scope: { kind: 'all', id: null },
    period: 'day',
    limitUsd: 10,
    limitTokens: null,
    mode: 'alert',
    enabled: true,
  });
  const ws = parseBudget({ name: '  Team  ', scope: { kind: 'workspace', id: 'docker/api' }, period: 'month', limitTokens: 5_000_000.9, limitUsd: 12.345, mode: 'pause' });
  assert.deepEqual([ws.name, ws.scope, ws.limitTokens, ws.limitUsd, ws.mode], ['Team', { kind: 'workspace', id: 'docker/api' }, 5_000_000, 12.35, 'pause']);
  fails(() => parseBudget({ period: 'day', limitUsd: 1 }), 'scope');
  fails(() => parseBudget({ scope: { kind: 'team', id: 'x' }, period: 'day', limitUsd: 1 }), 'scope');
  fails(() => parseBudget({ scope: { kind: 'claude' }, period: 'day', limitUsd: 1 }), 'scope');
  fails(() => parseBudget({ scope: { kind: 'all', id: 'x' }, period: 'day', limitUsd: 1 }), 'scope');
  fails(() => parseBudget({ scope: { kind: 'all' }, period: 'week', limitUsd: 1 }), 'period');
  fails(() => parseBudget({ scope: { kind: 'all' }, period: 'day' }), 'limitUsd');
  fails(() => parseBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: 0 }), 'limitUsd');
  fails(() => parseBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: 0.001 }), 'limitUsd');
  fails(() => parseBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: -5 }), 'limitUsd');
  fails(() => parseBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: Number.NaN }), 'limitUsd');
  fails(() => parseBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: '10' }), 'limitUsd');
  fails(() => parseBudget({ scope: { kind: 'all' }, period: 'day', limitTokens: 0.5 }), 'limitTokens');
  fails(() => parseBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: 1, mode: 'stop' }), 'mode');
  fails(() => parseBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: 1, enabled: 'yes' }), 'enabled');
  fails(() => parseBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: 1, name: 'x'.repeat(61) }), 'name');
  fails(() => parseBudget({ scope: { kind: 'all' }, period: 'day', limitUsd: 1, name: 'a\nb' }), 'name');
  assert.throws(() => parseBudget('nope'), /JSON object/);
});

test('an update names only what changes; null clears a limit but one must remain', () => {
  const base: BudgetFields = { name: 'Team', scope: { kind: 'claude', id: 'c1' }, period: 'day', limitUsd: 10, limitTokens: 1_000_000, mode: 'alert', enabled: true };
  assert.deepEqual(parseBudget({ limitUsd: 20 }, base), { ...base, limitUsd: 20 });
  assert.deepEqual(parseBudget({ limitUsd: null }, base), { ...base, limitUsd: null });
  assert.deepEqual(parseBudget({ mode: 'pause', enabled: false }, base), { ...base, mode: 'pause', enabled: false });
  assert.deepEqual(parseBudget({}, base), base);
  fails(() => parseBudget({ limitUsd: null, limitTokens: null }, base), 'limitUsd');
  // Naming a scope again replaces it whole.
  assert.deepEqual(parseBudget({ scope: { kind: 'all' } }, base).scope, { kind: 'all', id: null });
});

test('what restarts a budget’s alerts: its scope, period or limits, not its name, mode or switch', () => {
  const a: BudgetFields = { name: 'A', scope: { kind: 'all', id: null }, period: 'day', limitUsd: 10, limitTokens: null, mode: 'alert', enabled: true };
  const renamed: BudgetFields = { ...a, name: 'B', mode: 'pause', enabled: false };
  assert.equal(alertKey(a), alertKey(renamed));
  assert.notEqual(alertKey(a), alertKey({ ...a, limitUsd: 11 }));
  assert.notEqual(alertKey(a), alertKey({ ...a, period: 'month' }));
  assert.notEqual(alertKey(a), alertKey({ ...a, scope: { kind: 'workspace', id: 'docker/api' } }));
});
