import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attributionUrl } from './attribution.js';

const BASE = '/api/usage-spend/attribution';

test('the CSV export follows the Done filter on the ticket view (it used to write every row)', () => {
  const csv = attributionUrl(BASE, 'ticket', '7d', { done: true, csv: true });
  assert.match(csv, /[?&]done=1(&|$)/);
  assert.match(csv, /[?&]format=csv(&|$)/);
  // The rows request and the download carry the same filter.
  assert.equal(csv.replace('&format=csv', ''), attributionUrl(BASE, 'ticket', '7d', { done: true }));
});

test('without the filter, or outside the ticket view, no done parameter is sent', () => {
  assert.doesNotMatch(attributionUrl(BASE, 'ticket', '7d', { csv: true }), /done=/);
  assert.doesNotMatch(attributionUrl(BASE, 'session', '7d', { done: true, csv: true }), /done=/);
  assert.equal(attributionUrl(BASE, 'session', '1d'), `${BASE}?by=session&range=1d`);
});
