import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CiRunReport } from '@portal/contracts';
import { reportLine } from './report';

const r = (state: CiRunReport['state'], outcome: CiRunReport['outcome']): CiRunReport => ({ state, outcome, sessionId: 's-now', at: '2026-01-01T00:00:00.000Z', note: null });

test('no report, no line', () => {
  assert.equal(reportLine([]), null);
  assert.equal(reportLine(undefined), null);
});

test('the latest report says where it went, with the chat it reached', () => {
  assert.deepEqual(reportLine([r('waiting', 'sent'), r('passed', 'sent')]), { text: 'Pass reported to the session', sessionId: 's-now' });
});

test('a report not sent says why, and links nowhere', () => {
  assert.deepEqual(reportLine([r('failed', 'ended')]), { text: 'Failure not reported, the session has ended', sessionId: null });
  assert.equal(reportLine([r('failed', 'capped')])!.text, 'Failure not reported, over the message cap');
  assert.equal(reportLine([r('failed', 'paused')])!.text, 'Failure not reported, paused after repeated failures');
  assert.equal(reportLine([r('cancelled', 'refused')])!.text, 'Cancel not reported, the session refused it');
});
