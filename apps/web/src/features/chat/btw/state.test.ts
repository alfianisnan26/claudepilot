import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatBtw } from '@portal/contracts';
import { foldBtw, refusedBtw } from './state';

const item = (over: Partial<ChatBtw> = {}): ChatBtw => ({ id: 'a', session: 's', question: 'q', status: 'running', answer: '', askedAt: '2026-01-01T00:00:00Z', ...over });

test('deltas append in order and ignore repeats', () => {
  let s = foldBtw(null, { type: 'btw', session: 's', item: item() });
  s = foldBtw(s, { type: 'btw_delta', session: 's', btw: 'a', text: 'He', seq: 1 });
  s = foldBtw(s, { type: 'btw_delta', session: 's', btw: 'a', text: 'He', seq: 1 });
  s = foldBtw(s, { type: 'btw_delta', session: 's', btw: 'a', text: 'llo', seq: 2 });
  assert.equal(s?.item.answer, 'Hello');
});

test('the whole state replaces, but a stale running state never shortens the answer', () => {
  let s = foldBtw(null, { type: 'btw', session: 's', item: item() });
  s = foldBtw(s, { type: 'btw_delta', session: 's', btw: 'a', text: 'Hello', seq: 1 });
  s = foldBtw(s, { type: 'btw', session: 's', item: item({ answer: 'He' }) });
  assert.equal(s?.item.answer, 'Hello');
  s = foldBtw(s, { type: 'btw', session: 's', item: item({ status: 'answered', answer: 'Hello world' }) });
  assert.equal(s?.item.answer, 'Hello world');
});

test('closed drops the card; an older btw does not replace a newer one', () => {
  let s = foldBtw(null, { type: 'btw', session: 's', item: item({ id: 'b', askedAt: '2026-01-01T00:00:05Z' }) });
  s = foldBtw(s, { type: 'btw', session: 's', item: item({ id: 'a' }) });
  assert.equal(s?.item.id, 'b');
  s = foldBtw(s, { type: 'btw', session: 's', item: item({ id: 'b', closed: true }) });
  assert.equal(s, null);
});

test('a refusal becomes a failed card with a known reason', () => {
  const r = refusedBtw({ id: 'a', session: 's', question: 'q', askedAt: 'x' }, 'busy', 'nope');
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'busy');
  assert.equal(refusedBtw({ id: 'a', session: 's', question: 'q', askedAt: 'x' }, 'X', 'boom').note, 'boom');
});
