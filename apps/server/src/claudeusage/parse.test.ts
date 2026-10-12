import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanLabel, cleanPct, cleanPlan, cleanTime, parseAuthStatus, parseRateLimitInfo, parseUsageReply, windowLevel, type WindowReading } from './parse.js';
import { AUTH_KEY, AUTH_OUT, AUTH_PLAN, INFO_REJECTED, INFO_WARNING, NOW, REPLY_NO_LIMITS, REPLY_PLAN, REPLY_PLAN_ROWS, REPLY_UNAVAILABLE } from './fixtures.js';

const at = (iso: string) => Date.parse(iso);
const byKey = (windows: WindowReading[]) => Object.fromEntries(windows.map((w) => [w.key, w]));

test('the observed plan reply: named windows, plan tier, extra usage off', () => {
  const p = parseUsageReply(REPLY_PLAN);
  assert.equal(p.kind, 'plan');
  if (p.kind !== 'plan') return;
  assert.equal(p.plan, 'max');
  assert.deepEqual(
    p.windows.map((w) => [w.key, w.label, w.usedPct, w.resetsAtMs]),
    [
      ['session', 'Session', 41, at('2026-10-12T05:00:00Z')],
      ['week', 'Week', 63, at('2026-10-15T09:00:00Z')],
      ['week_opus', 'Opus', 12.5, at('2026-10-15T09:00:00Z')],
    ],
    'null windows (apps, sonnet) are no window',
  );
  assert.deepEqual(p.extra, { enabled: false, usedPct: null, limit: null, used: null, currency: null });
});

test('the observed reply with the server’s limits[] rows: rows win, a model the plan names gets its own window, extra usage in minor units', () => {
  const p = parseUsageReply(REPLY_PLAN_ROWS);
  assert.equal(p.kind, 'plan');
  if (p.kind !== 'plan') return;
  const w = byKey(p.windows);
  assert.deepEqual(p.windows.map((x) => x.key), ['session', 'week', 'week_opus', 'week_sonnet', 'model:fable']);
  assert.equal(w.week_opus!.usedPct, 12.5, 'Opus comes from the named field and the row alike, one window');
  assert.equal(w.week_sonnet!.usedPct, 3);
  assert.deepEqual([w['model:fable']!.label, w['model:fable']!.usedPct], ['Fable', 88]);
  assert.deepEqual(p.extra, { enabled: true, usedPct: 25, limit: 5000, used: 1250, currency: 'USD' });
});

test('model_scoped alone works, and rows override the named fields where both have a number', () => {
  const p = parseUsageReply({
    subscription_type: 'pro',
    rate_limits_available: true,
    rate_limits: {
      seven_day: { utilization: 10, resets_at: '2026-10-15T09:00:00Z' },
      model_scoped: [{ display_name: 'Sonnet', utilization: 30, resets_at: '2026-10-15T09:00:00Z' }, { display_name: 'Fable 2', utilization: null, resets_at: null }],
      limits: [{ kind: 'weekly_all', percent: 11, resets_at: null, scope: null }],
    },
  });
  assert.equal(p.kind, 'plan');
  if (p.kind !== 'plan') return;
  const w = byKey(p.windows);
  assert.equal(w.week!.usedPct, 11, 'the row’s number');
  assert.equal(w.week!.resetsAtMs, at('2026-10-15T09:00:00Z'), 'its null reset filled from the named field');
  assert.equal(w.week_sonnet!.usedPct, 30);
  assert.equal(w['model:fable-2']!.usedPct, null);
});

test('no plan limits: an API key, a pool or no login; and a plan Claude Code could not read', () => {
  assert.deepEqual(parseUsageReply(REPLY_NO_LIMITS), { kind: 'no_limits', plan: null });
  assert.deepEqual(parseUsageReply({ ...REPLY_NO_LIMITS, subscription_type: 'max' }), { kind: 'no_limits', plan: 'max' }, 'a login without the profile scope');
  assert.deepEqual(parseUsageReply(REPLY_UNAVAILABLE), { kind: 'unavailable', plan: 'max' });
});

test('malformed replies never throw and never pass as a plan', () => {
  for (const bad of [null, undefined, 7, 'x', [], {}, { rate_limits_available: 'true' }, { rate_limits_available: 1, rate_limits: {} }, { rate_limits: { five_hour: { utilization: 5 } } }]) {
    assert.deepEqual(parseUsageReply(bad), { kind: 'unreadable' }, JSON.stringify(bad));
  }
  const odd = parseUsageReply({
    subscription_type: { max: true },
    rate_limits_available: true,
    rate_limits: {
      five_hour: [1, 2],
      seven_day: { utilization: '41.5', resets_at: 'not a date' },
      seven_day_opus: { utilization: -5, resets_at: 7 },
      seven_day_sonnet: { utilization: 1e9, resets_at: '2026-10-15T09:00:00Z' },
      seven_day_oauth_apps: 'x',
      model_scoped: 'nope',
      extra_usage: [],
      limits: [null, 4, { kind: 'weekly_scoped', percent: 5 }, { kind: 'mystery_kind', percent: 9, resets_at: '2026-10-15T09:00:00Z' }],
    },
  });
  assert.equal(odd.kind, 'plan');
  if (odd.kind !== 'plan') return;
  assert.equal(odd.plan, null, 'an object is not a plan tier');
  const w = byKey(odd.windows);
  assert.deepEqual([w.week!.usedPct, w.week!.resetsAtMs], [41.5, null], 'a numeric string counts, a bad date does not');
  assert.equal(w.week_opus!.usedPct, 0, 'clamped at 0');
  assert.equal(w.week_sonnet!.usedPct, 1000, 'clamped at 1000');
  assert.equal(w['other:mystery-kind']!.usedPct, 9);
  assert.equal(odd.extra, null);
  assert.ok(!('session' in w), 'an array is no window');
});

test('at most 12 windows, and labels are cleaned', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ kind: 'weekly_scoped', percent: i, resets_at: '2026-10-15T09:00:00Z', scope: { model: { display_name: `Model ${i}` } } }));
  const p = parseUsageReply({ rate_limits_available: true, rate_limits: { limits: rows } });
  assert.equal(p.kind === 'plan' && p.windows.length, 12);
  assert.equal(cleanLabel(`  Fa${String.fromCharCode(0)}ble\n\t  ${String.fromCharCode(0x202e)}2 `, 'x'), 'Fa ble 2');
  assert.equal(cleanLabel('x'.repeat(80), 'y').length, 40);
  assert.equal(cleanLabel(`${String.fromCharCode(7)}${String.fromCharCode(0x200b)}`, 'fallback'), 'fallback');
});

test('numbers, times and plan names', () => {
  assert.equal(cleanPct(41.04), 41);
  assert.equal(cleanPct('12'), 12);
  assert.equal(cleanPct(NaN), null);
  assert.equal(cleanPct(Infinity), null);
  assert.equal(cleanPct('1e3'), null, 'only plain decimals as strings');
  assert.equal(cleanTime('2026-10-12T05:00:00.000000+00:00'), at('2026-10-12T05:00:00Z'));
  assert.equal(cleanTime(1791772512), 1791772512 * 1000, 'Unix seconds');
  assert.equal(cleanTime(1791772512000), 1791772512000, 'or milliseconds');
  assert.equal(cleanTime('1999-01-01T00:00:00Z'), null);
  assert.equal(cleanTime({}), null);
  assert.equal(cleanPlan('Max'), 'max');
  assert.equal(cleanPlan('<script>'), null);
  assert.equal(cleanPlan(''), null);
});

test('levels: thresholds at 80, 95 and 100; a passed reset time makes the number old', () => {
  const future = NOW + 3600_000;
  assert.equal(windowLevel(10, future, NOW), 'ok');
  assert.equal(windowLevel(79.9, future, NOW), 'ok');
  assert.equal(windowLevel(80, future, NOW), 'near');
  assert.equal(windowLevel(94.9, future, NOW), 'near');
  assert.equal(windowLevel(95, future, NOW), 'high');
  assert.equal(windowLevel(99.9, future, NOW), 'high');
  assert.equal(windowLevel(100, future, NOW), 'exhausted');
  assert.equal(windowLevel(140, future, NOW), 'exhausted');
  assert.equal(windowLevel(null, future, NOW), 'unknown');
  assert.equal(windowLevel(97, NOW - 1, NOW), 'reset');
  assert.equal(windowLevel(null, NOW - 1, NOW), 'reset');
  assert.equal(windowLevel(50, null, NOW), 'ok');
});

test('passive: the observed warning event becomes percents and times', () => {
  const p = parseRateLimitInfo(INFO_WARNING)!;
  assert.deepEqual(
    p.windows.map((w) => [w.key, w.usedPct, w.resetsAtMs]),
    [
      ['session', 82, 1791772512 * 1000],
      ['week', 63, 1791965312 * 1000],
    ],
  );
  assert.deepEqual(p.rejected, []);
  assert.equal(p.overageRejected, false);
});

test('passive: a rejected event makes its window exhausted and says which', () => {
  const p = parseRateLimitInfo(INFO_REJECTED)!;
  assert.deepEqual(p.rejected, ['session']);
  assert.equal(byKey(p.windows).session!.usedPct, 100);
  assert.equal(byKey(p.windows).week!.usedPct, 71);
  // Rejected on a window that no number backs: still exhausted.
  const bare = parseRateLimitInfo({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 1791965312 })!;
  assert.equal(byKey(bare.windows).week_opus!.usedPct, 100);
  assert.deepEqual(bare.rejected, ['week_opus']);
  // Extra usage refused: no plan window, but it is said.
  assert.deepEqual(parseRateLimitInfo({ status: 'rejected', rateLimitType: 'overage' }), { windows: [], rejected: [], overageRejected: true });
});

test('passive: a model bucket, values past a window’s cap, and everything that carries nothing', () => {
  const p = parseRateLimitInfo({ status: 'allowed', unifiedWindows: { seven_day_overage_included: { utilization: 0.4, resetsAt: 1791965312 }, five_hour: { utilization: 1.25, resetsAt: 1791772512 } } })!;
  assert.deepEqual(p.windows.map((w) => [w.key, w.label, w.usedPct]), [['session', 'Session', 125], ['week_models', 'Models', 40]]);
  for (const nothing of [null, undefined, 3, 'x', [], {}, { status: 'allowed' }, { status: 'bogus', rateLimitType: 'nonsense' }, { unifiedWindows: 'x' }, { unifiedWindows: { five_hour: { utilization: 'a', resetsAt: 'b' } } }]) {
    assert.equal(parseRateLimitInfo(nothing), null, JSON.stringify(nothing));
  }
});

test('auth status: loggedIn and the method, and not a word of the account', () => {
  assert.deepEqual(parseAuthStatus(AUTH_PLAN), { loggedIn: true, method: 'claude.ai' });
  assert.deepEqual(parseAuthStatus(AUTH_OUT), { loggedIn: false, method: 'none' });
  assert.deepEqual(parseAuthStatus(AUTH_KEY), { loggedIn: true, method: 'api_key' });
  assert.deepEqual(parseAuthStatus(`warning: something\n${AUTH_PLAN}\n`), { loggedIn: true, method: 'claude.ai' }, 'noise around it');
  assert.ok(!JSON.stringify(parseAuthStatus(AUTH_PLAN)).includes('canary'));
  assert.deepEqual(parseAuthStatus('{"loggedIn": true, "authMethod": "<b>x</b>"}'), { loggedIn: true, method: 'unknown' });
  for (const bad of ['', 'nope', '{', '{"loggedIn": "yes"}', '[]', '{"authMethod": "claude.ai"}']) assert.equal(parseAuthStatus(bad), null, bad);
});
