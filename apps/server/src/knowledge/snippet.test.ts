import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDate, timeIn, todayIn, validTimezone } from './daily.js';
import { makeSnippet } from './snippet.js';

test('snippet: a window around the first match, every match marked, accents and case ignored, no markup', () => {
  const body = `${'filler words '.repeat(40)}The Café has the best crème brûlée in town. ${'more filler '.repeat(40)}`;
  const s = makeSnippet(body, ['cafe', 'creme', 'brulee']);
  assert.ok(s.text.startsWith('… '));
  assert.ok(s.text.endsWith(' …'));
  assert.deepEqual(s.marks.map(([a, b]) => s.text.slice(a, b)), ['Café', 'crème', 'brûlée']);
  assert.ok(s.text.length < 260);
  const html = makeSnippet('<img src=x onerror=alert(1)> hello <script>', ['hello']);
  assert.ok(html.text.includes('<img'), 'text is returned as text; the page renders it as text');
  assert.deepEqual(html.marks.map(([a, b]) => html.text.slice(a, b)), ['hello']);
});

test('snippet: no match in the body gives the opening, past headings; short text is whole', () => {
  assert.deepEqual(makeSnippet('# Title\n\nFirst paragraph here.\n\nSecond.', ['zzz']), { text: 'First paragraph here. Second.', marks: [] });
  assert.deepEqual(makeSnippet('tiny note', ['tiny']), { text: 'tiny note', marks: [[0, 4]] });
  assert.deepEqual(makeSnippet('', ['x']), { text: '', marks: [] });
});

test('daily: dates, time zones', () => {
  assert.equal(isDate('2026-10-12'), true);
  for (const d of ['2026-13-01', '2026-02-30', '26-10-12', '2026-10-12T00:00', '', 'today']) assert.equal(isDate(d), false, d);
  assert.equal(isDate('2024-02-29'), true);
  const now = new Date('2026-10-12T23:30:00Z');
  assert.equal(todayIn('UTC', now), '2026-10-12');
  assert.equal(todayIn('Asia/Jakarta', now), '2026-10-13');
  assert.equal(timeIn('Asia/Jakarta', now), '06:30');
  assert.equal(validTimezone('Nope/Zone'), false);
  assert.equal(validTimezone('Europe/Berlin'), true);
});
