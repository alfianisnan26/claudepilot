import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blindWindow, limitReportWords, unavailableWords } from './unknownWords.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');

test('unavailable usage says why, never 0 %', () => {
  assert.equal(unavailableWords({ unavailable: 'no_reset_time', runsOn: 'plan' })?.line, 'Unavailable: no reset time');
  assert.equal(unavailableWords({ unavailable: 'signed_out', runsOn: 'none' })?.line, 'Unavailable: not signed in');
  assert.equal(unavailableWords({ unavailable: 'no_usage_endpoint', runsOn: 'plan' })?.line, 'Unavailable: no usage endpoint');
  assert.match(unavailableWords({ unavailable: 'no_reading', runsOn: 'unknown' })!.tip, /never prefers it/);
  assert.equal(unavailableWords({ unavailable: null, runsOn: 'plan' }), null);
  assert.equal(blindWindow({ usedPct: 0, resetsAt: null }), true);
  assert.equal(blindWindow({ usedPct: 0, resetsAt: '2026-10-12T15:00:00Z' }), false);
  assert.equal(blindWindow({ usedPct: 40, resetsAt: null }), false);
});

test('a limit a chat reported: the line, its source, and gone after the reset', () => {
  const r = { window: 'session', label: 'Session', at: '2026-10-12T11:30:00Z', until: '2026-10-12T23:00:00Z', guessed: false, sessionId: 's1' };
  const w = limitReportWords({ limitReport: r }, NOW)!;
  assert.match(w.line, /^Limit hit · until \S+/);
  assert.match(w.tip, /^Limit reported by a chat at \S+, until \S+: Claude Code answered a turn with its limit message \(Session\)\. Until: the reset time that message stated\./);
  assert.match(limitReportWords({ limitReport: { ...r, guessed: true } }, NOW)!.tip, /a guess/);
  assert.equal(limitReportWords({ limitReport: r }, Date.parse('2026-10-12T23:01:00Z')), null);
  assert.equal(limitReportWords({ limitReport: null }, NOW), null);
});
