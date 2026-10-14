import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaudeUsage, ClaudeUsageWindow } from '@portal/contracts';
import { leadClaude, leadWindowKey, levelOfUsed, pickActive, quotaCompact, readClaude, recentClaudeOf, windowViews, type QuotaInput } from './quota.js';

// Fixtures with hand-computed expectations (PLAN-4 P5). "Now" is fixed: 2026-10-12T12:00:00Z.
const NOW = Date.parse('2026-10-12T12:00:00Z');
const TH = { warn: 80, critical: 95 };
const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

const win = (key: string, label: string, usedPct: number | null, resetsInH: number | null, level: ClaudeUsageWindow['level'] = 'ok'): ClaudeUsageWindow => ({ key, label, usedPct, resetsAt: resetsInH === null ? null : at(resetsInH), level });

function claude(over: Partial<ClaudeUsage> & { claudeId: string }): ClaudeUsage {
  return {
    claudeName: over.claudeId.toUpperCase(),
    workspaceId: 'w1',
    workspaceName: 'w1',
    runsOn: 'plan',
    state: 'ok',
    plan: 'max',
    windows: [],
    extra: null,
    checkedAt: at(-0.1),
    source: 'probe',
    stale: false,
    workspaceRunning: true,
    problem: null,
    unavailable: null,
    limitReport: null,
    snoozedUntil: null,
    projectionSnoozedUntil: null,
    slot: 0,
    outlook: { status: { value: null, basis: 'unavailable', reason: 'no_samples' }, window: null, etaAt: { value: null, basis: 'unavailable', reason: 'no_samples' }, projectedPct: { value: null, basis: 'unavailable', reason: 'no_samples' } },
    trend: null,
    ...over,
  };
}

// A: session 41 % (resets in 2 h), week 18 % (resets in 80 h). Leaves 59 % of the session and 82 % of the week: the session limits it.
const A = claude({ claudeId: 'a', windows: [win('session', 'Session', 41, 2), win('week', 'Week', 18, 80)] });
// B: session 96 % (resets in 1 h): left 4 %, critical at the 95 default.
const B = claude({ claudeId: 'b', state: 'near', windows: [win('session', 'Session', 96, 1, 'high'), win('week', 'Week', 30, 50)] });
// C: a pool (no plan limits). D: signed out.
const C = claude({ claudeId: 'c', runsOn: 'pool', state: 'no_limits' });
const D = claude({ claudeId: 'd', runsOn: 'none', state: 'signed_out' });

const input = (over: Partial<QuotaInput>): QuotaInput => ({ claudes: [A, B, C, D], failed: false, focusClaudeId: null, recentClaudeId: null, mode: 'active', nowMs: NOW, thresholds: TH, ...over });

test('levels follow the thresholds: 79 ok, 80 warn, 94 warn, 95 critical; custom thresholds move them', () => {
  assert.equal(levelOfUsed(79, TH), 'ok');
  assert.equal(levelOfUsed(80, TH), 'warn');
  assert.equal(levelOfUsed(94, TH), 'warn');
  assert.equal(levelOfUsed(95, TH), 'critical');
  assert.equal(levelOfUsed(60, { warn: 50, critical: 70 }), 'warn');
});

test('percent left of the active Claude is 100 minus the fullest window: A is 59 % (the session limits it, not the week at 82 %)', () => {
  const c = quotaCompact(input({ focusClaudeId: 'a' }));
  assert.equal(c.value, '59 %');
  assert.equal(c.level, 'ok');
  assert.match(c.title, /^Quota, A: 59 % left of Session, resets /);
  assert.match(c.title, /fine$/);
});

test('B at 96 % used has 4 % left and is critical; a custom pair of 40 and 60 makes A (41 %) warn', () => {
  assert.equal(quotaCompact(input({ focusClaudeId: 'b' })).value, '4 %');
  assert.equal(quotaCompact(input({ focusClaudeId: 'b' })).level, 'critical');
  assert.equal(quotaCompact(input({ focusClaudeId: 'a', thresholds: { warn: 40, critical: 60 } })).level, 'warn');
});

test('the active Claude: the open session’s, else the most recently used, else the first with plan limits', () => {
  assert.equal(pickActive([A, B, C, D], 'b', 'a')?.claudeId, 'b');
  assert.equal(pickActive([A, B, C, D], null, 'b')?.claudeId, 'b');
  assert.equal(pickActive([A, B, C, D], 'gone', 'gone-too')?.claudeId, 'a', 'unknown ids fall back');
  assert.equal(pickActive([C, D, B], null, null)?.claudeId, 'b', 'the first with plan limits, not the pool');
  assert.equal(pickActive([C, D], null, null)?.claudeId, 'c');
  assert.equal(pickActive([], null, null), null);
});

test('unavailable data is "-" or nothing, never a number: signed out, unreadable plan, a pool, no Claudes, loading, failed', () => {
  const signedOut = quotaCompact(input({ focusClaudeId: 'd' }));
  assert.equal(signedOut.value, '-');
  assert.equal(signedOut.level, 'unknown');
  assert.match(signedOut.title, /not signed in/);
  const pool = quotaCompact(input({ focusClaudeId: 'c' }));
  assert.equal(pool.value, null);
  assert.equal(pool.level, 'idle');
  assert.match(pool.title, /no plan limits/);
  const unread = quotaCompact(input({ claudes: [claude({ claudeId: 'u', windows: [] })], focusClaudeId: 'u' }));
  assert.equal(unread.value, '-');
  assert.match(unread.title, /not read yet/);
  assert.equal(quotaCompact(input({ claudes: [] })).value, '-');
  assert.equal(quotaCompact(input({ claudes: null })).loading, true);
  const failed = quotaCompact(input({ claudes: null, failed: true }));
  assert.equal(failed.value, '-');
  assert.match(failed.title, /could not load/);
});

test('T-255: a Claude whose usage is unavailable (0 % with no reset time) is "-", never 100 % left, and its windows have no number', () => {
  const blind = claude({ claudeId: 'z', state: 'unknown', unavailable: 'no_reset_time', windows: [win('session', 'Session', 0, null), win('week', 'Week', 0, null)] });
  const r = quotaCompact(input({ claudes: [blind, A], focusClaudeId: 'z' }));
  assert.equal(r.value, '-');
  assert.equal(r.level, 'unknown');
  assert.match(r.title, /usage unavailable \(no reset time to project to\)/);
  assert.deepEqual(windowViews(blind, NOW, TH).map((w) => w.usedPct), [null, null]);
});

test('a window whose reset time has passed is old: it no longer counts (A’s session reset an hour ago, so the week leads: 82 % left)', () => {
  const old = claude({ claudeId: 'o', windows: [win('session', 'Session', 90, -1, 'ok'), win('week', 'Week', 18, 80)] });
  const c = quotaCompact(input({ claudes: [old], focusClaudeId: 'o' }));
  assert.equal(c.value, '82 %');
  const views = windowViews(old, NOW, TH);
  assert.equal(views[0]!.reset, true);
  assert.equal(views[0]!.usedPct, null, 'the old number is not shown');
  assert.equal(views[0]!.level, 'unknown');
});

test('used up: 0 %, critical; a sliver left reads "<1 %" (not a rounded-up 1); a model window at 100 % is 0 % even though the Claude still runs other models', () => {
  const out = claude({ claudeId: 'x', state: 'exhausted', windows: [win('session', 'Session', 100, 2, 'exhausted')] });
  const o = quotaCompact(input({ claudes: [out], focusClaudeId: 'x' }));
  assert.equal(o.value, '0 %');
  assert.equal(o.level, 'critical');
  assert.match(o.title, /used up/);
  const nearly = claude({ claudeId: 'n', windows: [win('session', 'Session', 99.6, 2, 'high')] });
  assert.equal(quotaCompact(input({ claudes: [nearly], focusClaudeId: 'n' })).value, '<1 %', '100 - 99.6 = 0.4');
  const half = claude({ claudeId: 'h', windows: [win('session', 'Session', 99.5, 2, 'high')] });
  assert.equal(quotaCompact(input({ claudes: [half], focusClaudeId: 'h' })).value, '1 %', '0.5 left rounds to 1');
  const opus = claude({ claudeId: 'm', windows: [win('session', 'Session', 20, 2), win('week_opus', 'Opus', 100, 50, 'exhausted')] });
  const m = quotaCompact(input({ claudes: [opus], focusClaudeId: 'm' }));
  assert.equal(m.value, '0 %', 'the per-model window is the fullest: the Claude is not stopped (headroom.exhausted is false) but that window has nothing left');
  assert.equal(m.level, 'critical');
  assert.match(m.title, /0 % left of Opus/);
});

test('all-Claudes mode shows the Claude with the least left (B, 4 %), says so, and leaves a lone Claude alone', () => {
  const all = quotaCompact(input({ mode: 'all', focusClaudeId: 'a' }));
  assert.equal(all.value, '4 %');
  assert.equal(all.level, 'critical');
  assert.match(all.title, /^Quota, B \(least left of 2 plans\)/, 'A and B have plan limits; the pool and the signed-out Claude do not');
  assert.equal(quotaCompact(input({ mode: 'all', claudes: [A], focusClaudeId: 'a' })).value, '59 %');
  // No Claude with plan limits at all: the active one speaks.
  assert.equal(quotaCompact(input({ mode: 'all', claudes: [C, D], focusClaudeId: 'c' })).level, 'idle');
});

test('a projection that says "over" turns an ok dot to warn but never changes the number, and says est. in its title', () => {
  const projected = claude({
    claudeId: 'p',
    windows: [win('session', 'Session', 41, 2)],
    outlook: { status: { value: 'over', basis: 'estimate' }, window: { key: 'session', label: 'Session', usedPct: 41, resetsAt: at(2) }, etaAt: { value: at(1), basis: 'estimate' }, projectedPct: { value: 120, basis: 'estimate' } },
  });
  const c = quotaCompact(input({ claudes: [projected], focusClaudeId: 'p' }));
  assert.equal(c.value, '59 %', 'the measured number is untouched');
  assert.equal(c.level, 'warn');
  assert.match(c.title, /projected to run out before the reset \(est\.\)/);
  // Already critical stays critical; a projection that says "under" changes nothing.
  assert.equal(readClaude({ ...projected, windows: [win('session', 'Session', 97, 2, 'high')] }, NOW, TH).level, 'critical');
  assert.equal(readClaude({ ...projected, outlook: { ...projected.outlook, status: { value: 'under', basis: 'estimate' } } }, NOW, TH).level, 'ok');
  // An unavailable projection (no samples) is not a warning.
  assert.equal(readClaude(A, NOW, TH).over, false);
});

test('the full form opens the window the projection is about, else the fullest that has a number', () => {
  const views = windowViews(A, NOW, TH);
  assert.equal(leadWindowKey(A, views), 'session', 'the fullest: 41 against 18');
  const projected = { ...A, outlook: { ...A.outlook, window: { key: 'week', label: 'Week', usedPct: 18, resetsAt: at(80) } } };
  assert.equal(leadWindowKey(projected, views), 'week');
  assert.equal(leadWindowKey(claude({ claudeId: 'z', windows: [win('session', 'Session', null, 2, 'unknown')] }), windowViews(claude({ claudeId: 'z', windows: [win('session', 'Session', null, 2, 'unknown')] }), NOW, TH)), null);
});

test('the most recently used Claude is the one of the latest active session that has one; archived sessions and unreadable times do not count', () => {
  const s = (claudeId: string, lastActivityAt: string, archivedAt: string | null = null) => ({ claudeId, lastActivityAt, archivedAt });
  assert.equal(recentClaudeOf([s('a', '2026-10-12T10:00:00Z'), s('b', '2026-10-12T11:00:00Z'), s('c', '2026-10-12T09:00:00Z')]), 'b');
  assert.equal(recentClaudeOf([s('a', '2026-10-12T10:00:00Z'), s('b', '2026-10-12T11:00:00Z', '2026-10-12T11:30:00Z')]), 'a', 'an archived session is not use');
  assert.equal(recentClaudeOf([s('', '2026-10-12T12:00:00Z'), s('a', '2026-10-12T10:00:00Z')]), 'a', 'a session with no Claude recorded yet is skipped');
  assert.equal(recentClaudeOf([s('a', 'garbage')]), null);
  assert.equal(recentClaudeOf([]), null);
});

test('the full form leads with the Claude the chip is about: the active one, or the one with the least left in all-Claudes mode', () => {
  assert.equal(leadClaude(input({ focusClaudeId: 'a' }))?.reading.claude.claudeId, 'a');
  assert.equal(leadClaude(input({ focusClaudeId: 'a' }))?.scope, null);
  const all = leadClaude(input({ mode: 'all', focusClaudeId: 'a' }));
  assert.equal(all?.reading.claude.claudeId, 'b', 'B has 4 % left, A 59 %');
  assert.equal(all?.scope, 'least left of 2 plans');
  assert.equal(leadClaude(input({ claudes: null })), null);
  assert.equal(leadClaude(input({ claudes: [] })), null);
});
