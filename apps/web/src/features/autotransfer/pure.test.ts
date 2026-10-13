import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AutoTransferEvent } from '@portal/contracts';
import { autoMarks, droppedText, headline, inPlace, modeChoices, moveItem, offer, parseThreshold, pctText, reasonText, toggleItem, undoFor, whyText } from './pure';

const m = (value: number) => ({ value, basis: 'measured' as const });

test('numbers keep their basis', () => {
  assert.equal(pctText(m(8)), '8 %');
  assert.equal(pctText({ value: 12.34, basis: 'estimate' }), '12.3 % est.');
  assert.equal(pctText({ value: null, basis: 'unavailable', reason: 'no_reading' }), '–');
});

test('the card lines', () => {
  const s = { from: { id: 'w', name: 'Work' }, to: { id: 'h', name: 'Home' }, reason: 'low' as const, facts: { leftPct: m(8), thresholdPct: 10, resetsAt: { value: '2026-10-12T15:00:00Z', basis: 'measured' as const }, destLeftPct: m(40) } };
  assert.equal(headline(s), 'Work has 8 % left');
  assert.equal(offer(s), 'Move to Home (40 % left)');
  assert.equal(headline({ ...s, reason: 'exhausted' }), 'Work is used up');
  assert.equal(offer({ ...s, facts: { ...s.facts, destLeftPct: undefined } }), 'Move to Home');
  assert.equal(droppedText({ approvals: 1, queued: 0, agents: 2 }), 'Drops 1 approval, 2 agents');
  assert.equal(droppedText({ approvals: 0, queued: 0, agents: 0 }), null);
  assert.equal(
    reasonText({ ...s, handoff: 'ask' }),
    'Its fullest limit has 8 % left (measured), at or under the threshold of 10 %. Home has 40 % left (measured). It writes a handoff first.',
  );
  assert.equal(
    reasonText({ reason: 'exhausted', facts: s.facts, handoff: 'skip' }, true),
    'Its session or week limit is used up (measured). The stored conversation carries over; it can\u2019t write a handoff now. Bypass stays on after the move while the policy allows it.',
  );
  assert.equal(reasonText({ reason: 'exhausted', facts: s.facts, handoff: 'skip' }), 'Its session or week limit is used up (measured). The stored conversation carries over; it can\u2019t write a handoff now.');
});

test('auto marks: automatic moves of the last day, not undone', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const ev = (id: number, kind: AutoTransferEvent['kind'], handoffId: string, at: string, actor = 'portal:autotransfer') => ({ id, kind, handoffId, at, actor }) as AutoTransferEvent;
  const marks = autoMarks(
    [
      ev(5, 'undone', 'h2', '2026-10-12T11:50:00Z', 'ui'),
      ev(4, 'moved', 'h2', '2026-10-12T11:40:00Z'),
      ev(3, 'moved', 'h1', '2026-10-12T11:00:00Z'),
      ev(2, 'moved', 'h0', '2026-10-11T11:00:00Z'),
      ev(1, 'moved', 'hp', '2026-10-12T11:00:00Z', 'user:u_owner'),
    ],
    now,
  );
  assert.deepEqual([...marks.keys()], ['h1']);
});

test('destinations: pick and order', () => {
  assert.deepEqual(toggleItem(['a', 'b'], 'c'), ['a', 'b', 'c']);
  assert.deepEqual(toggleItem(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(moveItem(['a', 'b'], 0, -1), ['a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 1, 1), ['a', 'b']);
});

test('a Claude\u2019s threshold: empty follows the default, else a whole number from 1 to 50', () => {
  assert.equal(parseThreshold(''), null);
  assert.equal(parseThreshold('  '), null);
  assert.equal(parseThreshold('12'), 12);
  assert.equal(parseThreshold('1'), 1);
  assert.equal(parseThreshold('50'), 50);
  assert.equal(parseThreshold('0'), 'invalid');
  assert.equal(parseThreshold('51'), 'invalid');
  assert.equal(parseThreshold('7.5'), 'invalid');
  assert.equal(parseThreshold('x'), 'invalid');
});

test('undo goes with the divider of the last automatic move only', () => {
  const event = { handoffId: 'h1' } as AutoTransferEvent;
  const last = { event, undo: { ok: false, reason: 'Work is out until 15:00' } };
  assert.deepEqual(undoFor(last, 'h1'), { ok: false, reason: 'Work is out until 15:00' });
  assert.equal(undoFor(last, 'h0'), null);
  assert.equal(undoFor(null, 'h1'), null);
});

test('why nothing happens, in a few words; nothing to say for the ordinary codes', () => {
  assert.equal(whyText('pooled'), 'Not used on an account pool');
  assert.equal(whyText('stale_reading'), 'The reading is old');
  assert.equal(whyText('folder_untrusted'), 'The folder needs trusting again');
  assert.equal(whyText('mode_off'), null);
  assert.equal(whyText('above_threshold'), null);
  assert.equal(whyText(null), null);
});

test('a chat may choose Automatic only when the platform allows it', () => {
  assert.deepEqual(modeChoices('auto'), ['default', 'off', 'ask', 'auto']);
  assert.deepEqual(modeChoices('ask'), ['default', 'off', 'ask']);
});

test('T-29: the card names the limit that is low and offers a model change in words', () => {
  const facts = { leftPct: m(5), thresholdPct: 10, resetsAt: { value: '2026-10-12T15:00:00Z', basis: 'measured' as const }, destLeftPct: m(50), limit: { key: 'week_opus', label: 'Opus', kind: 'model' as const } };
  const here = { from: { id: 'w', name: 'Work' }, to: { id: 'w', name: 'Work', model: 'sonnet' }, reason: 'low' as const, facts, handoff: 'skip' as const };
  assert.equal(headline(here), 'Work: Opus limit has 5 % left');
  assert.equal(offer(here), 'Use Sonnet here (50 % left)');
  assert.ok(inPlace(here));
  assert.equal(
    reasonText(here, true),
    'Its Opus limit, which stops only this model, has 5 % left (measured), at or under the threshold of 10 %. Sonnet here has 50 % left (measured). The chat stays on this Claude and changes to Sonnet: the conversation stays as it is, nothing is handed off.',
  );
  const away = { ...here, to: { id: 'h', name: 'Home', model: 'sonnet' }, handoff: 'ask' as const };
  assert.equal(offer(away), 'Move to Home on Sonnet (50 % left)');
  assert.ok(!inPlace(away));
  assert.equal(headline({ ...here, reason: 'exhausted' }), 'Work: Opus limit is used up');
});
