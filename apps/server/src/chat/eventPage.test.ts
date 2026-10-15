// Transcript pages (T-376): the pure rules in eventPage.ts. What the events route reads from its query (the `after` form exactly as before,
// a page with `before` or `limit`), the tool_result preview that keeps the whole length, and a page: at most `limit`, oldest first, `more`
// when older events were left out, stopped early by the byte cap but never empty.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { EVENT_PAGE_LIMIT, EVENT_PAGE_LIMIT_MAX, EVENT_PREVIEW_CHARS, type ChatEvent } from '@portal/contracts';
import { eventPage, eventsQuery, previewEvent } from './eventPage.js';

const ev = (seq: number, kind: ChatEvent['kind'] = 'assistant', text = `event ${seq}`): ChatEvent => ({ seq, at: '2026-01-01T00:00:00.000Z', kind, text });
/** Events 1..n, newest first (what the store reads for a page). */
const newestFirst = (n: number, from = n) => Array.from({ length: n }, (_, i) => ev(from - i));
const invalid = (e: unknown) => isAppError(e) && e.status === 422;

test('query: neither before nor limit is the after form, read exactly as before (no parameter: the whole transcript)', () => {
  assert.deepEqual(eventsQuery({}), { kind: 'after', after: 0 });
  assert.deepEqual(eventsQuery({ after: '42' }), { kind: 'after', after: 42 });
  assert.deepEqual(eventsQuery({ after: 'nonsense' }), { kind: 'after', after: 0 }, 'not a number reads as 0, as the route always did');
});

test('query: before or limit asks for a page; limit defaults and is capped; before absent or empty is the newest', () => {
  assert.deepEqual(eventsQuery({ limit: '50' }), { kind: 'page', before: null, limit: 50 });
  assert.deepEqual(eventsQuery({ before: '' }), { kind: 'page', before: null, limit: EVENT_PAGE_LIMIT });
  assert.deepEqual(eventsQuery({ before: '900', limit: '10' }), { kind: 'page', before: 900, limit: 10 });
  assert.deepEqual(eventsQuery({ limit: String(EVENT_PAGE_LIMIT_MAX * 10) }), { kind: 'page', before: null, limit: EVENT_PAGE_LIMIT_MAX });
});

test('query: a page with a bad number, or with after, is refused (422)', () => {
  for (const bad of [{ limit: '0' }, { limit: '-3' }, { limit: '2.5' }, { limit: 'x' }, { before: '0' }, { before: '1e3' }, { before: 'abc' }]) {
    assert.throws(() => eventsQuery(bad), invalid, JSON.stringify(bad));
  }
  assert.throws(() => eventsQuery({ after: '5', limit: '10' }), invalid);
  assert.throws(() => eventsQuery({ after: '5', before: '10' }), invalid);
});

test('preview: a long tool_result is cut to its first characters and keeps its whole length; anything else is left alone', () => {
  const whole = 'line of tool output\n'.repeat(500);
  const cut = previewEvent(ev(7, 'tool_result', whole));
  assert.equal(cut.text, whole.slice(0, EVENT_PREVIEW_CHARS));
  assert.equal(cut.textLength, whole.length);
  assert.equal(cut.seq, 7);

  const short = ev(8, 'tool_result', 'x'.repeat(EVENT_PREVIEW_CHARS));
  assert.equal(previewEvent(short), short, 'at the bound: whole, no textLength');
  assert.equal(previewEvent(short).textLength, undefined);
  const assistant = ev(9, 'assistant', whole);
  assert.equal(previewEvent(assistant), assistant, 'only tool_result bodies are cut');
});

test('preview: never cuts a surrogate pair in half', () => {
  const text = `${'a'.repeat(9)}😀tail`; // the emoji's two halves are at 9 and 10
  const cut = previewEvent(ev(1, 'tool_result', text), 10);
  assert.equal(cut.text, 'a'.repeat(9));
  assert.equal(cut.textLength, text.length);
});

test('page: at most limit, oldest first, more when older ones exist, before is the first seq', () => {
  const page = eventPage(newestFirst(11, 100), 10); // the store read limit + 1: seqs 100..90
  assert.deepEqual(
    page.events.map((e) => e.seq),
    [91, 92, 93, 94, 95, 96, 97, 98, 99, 100],
  );
  assert.equal(page.more, true);
  assert.equal(page.before, 91);

  const last = eventPage(newestFirst(3), 10);
  assert.deepEqual(
    last.events.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.equal(last.more, false);
  assert.equal(last.before, null);
  assert.deepEqual(eventPage([], 10), { events: [], more: false, before: null });
});

test('page: the byte cap stops it early (more stays true), but a page always holds at least one event', () => {
  const big = (seq: number) => ev(seq, 'assistant', 'y'.repeat(1000));
  const page = eventPage([big(5), big(4), big(3), big(2), big(1)], 10, { maxBytes: 2500 });
  assert.deepEqual(
    page.events.map((e) => e.seq),
    [4, 5],
  );
  assert.equal(page.more, true);
  assert.equal(page.before, 4);
  const one = eventPage([big(2), big(1)], 10, { maxBytes: 10 });
  assert.deepEqual(
    one.events.map((e) => e.seq),
    [2],
  );
  assert.equal(one.more, true);
});

test('page: tool_result bodies in it are previews with their whole length, measured after the cut', () => {
  const whole = 'z'.repeat(EVENT_PREVIEW_CHARS * 5);
  const page = eventPage([ev(3, 'tool_result', whole), ev(2), ev(1)], 10, { maxBytes: EVENT_PREVIEW_CHARS * 2 });
  assert.equal(page.events.length, 3, 'the cut body fits where the whole would not');
  assert.equal(page.events[2]!.text!.length, EVENT_PREVIEW_CHARS);
  assert.equal(page.events[2]!.textLength, whole.length);
});
