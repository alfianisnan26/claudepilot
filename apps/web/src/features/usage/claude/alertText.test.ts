import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaudeUsageAlert } from '@portal/contracts';
import { alertsTab, alertsToast, alertToast, alertWords } from './alertText.js';

const clock = (iso: string | null) => (iso ? iso.slice(11, 16) : '');
const base = { claudeId: 'c1', claudeName: 'Satria', workspaceName: 'api', at: '2026-10-12T05:26:00Z' };
const level = (over: Partial<ClaudeUsageAlert>): ClaudeUsageAlert => ({ ...base, id: 'x', window: 'week', label: 'Week', level: 'high', usedPct: 95.4, resetsAt: '2026-10-16T05:26:00Z', ...over });

test('a threshold alert reads as the percent, a window that stops the Claude as out', () => {
  assert.equal(alertWords(level({}), clock), 'Satria: week 95 %');
  assert.equal(alertWords(level({ window: 'session', label: 'Session', level: 'exhausted', usedPct: 100, resetsAt: '2026-10-12T14:20:00Z' }), clock), 'Satria: out until 14:20');
  assert.equal(alertWords(level({ window: 'week_opus', label: 'Opus', level: 'exhausted', usedPct: 100 }), clock), 'Satria: opus used up');
});

test('a projection alert is worded from its estimate, never as a threshold', () => {
  const projection = level({ kind: 'projection', window: 'session', label: 'Session', level: 'near', usedPct: 70, etaAt: '2026-10-12T06:56:00Z', projectedPct: 110, resetsAt: '2026-10-12T07:26:00Z' });
  assert.equal(alertWords(projection, clock), 'Satria: session out ~06:56 · resets 07:26');
  assert.ok(!alertWords(projection, clock).includes('70 %'));
  assert.equal(alertWords({ ...projection, etaAt: null, resetsAt: null }, clock), 'Satria: session out');
});

test('a toast names the first two and counts the rest', () => {
  const a = level({});
  const b = level({ claudeName: 'Kresna', usedPct: 82, level: 'near' });
  const c = level({ claudeName: 'Arjuna' });
  assert.equal(alertToast([a], clock), 'Satria: week 95 %');
  assert.equal(alertToast([a, b], clock), 'Satria: week 95 % · Kresna: week 82 %');
  assert.equal(alertToast([a, b, c, c], clock), 'Satria: week 95 % · Kresna: week 82 % · +2');
});

test('budget and spike alerts join the toast in the portal’s own words, after the plan alerts', () => {
  const plan = level({});
  const budget = { kind: 'budget' as const, summary: 'Everything daily: 95 %' };
  const spike = { kind: 'spike' as const, summary: 'Satria: 24 requests in 10 min' };
  assert.equal(alertsToast([plan], [budget], clock), 'Satria: week 95 % · Everything daily: 95 %');
  assert.equal(alertsToast([], [spike], clock), 'Satria: 24 requests in 10 min');
  assert.equal(alertsToast([plan], [budget, spike], clock), 'Satria: week 95 % · Everything daily: 95 % · +1');
  assert.equal(alertsToast([], [], clock), '');
});

test('the toast opens the tab of the first alert it names', () => {
  assert.equal(alertsTab([level({})], [{ kind: 'budget' }]), 'claudes');
  assert.equal(alertsTab([], [{ kind: 'budget' }, { kind: 'spike' }]), 'budgets');
  assert.equal(alertsTab([], [{ kind: 'spike' }]), 'spikes');
  assert.equal(alertsTab([], []), 'claudes');
});
