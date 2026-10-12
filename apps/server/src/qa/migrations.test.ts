// QA-033: several people add migrations to one file at the same time. A version used twice means one of them never runs (the applied set
// says it already did), and an edit to one that has run somewhere leaves that database with the old shape. The second can't be tested
// without history; the first can.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIGRATIONS } from '../store/migrations.js';

test('every migration has its own version and its own name', () => {
  const versions = MIGRATIONS.map((m) => m.version);
  const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
  assert.deepEqual(dupes, [], `versions used twice: ${dupes.join(', ')}. Pick a free number; a duplicate is silently skipped on every database that has the other one.`);
  assert.ok(versions.every((v) => Number.isInteger(v) && v > 0), 'versions are positive integers');
  const names = MIGRATIONS.map((m) => m.name.trim().toLowerCase());
  assert.ok(names.every(Boolean), 'every migration has a name');
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], 'names are unique');
});
