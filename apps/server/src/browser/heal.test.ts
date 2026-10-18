/**
 * T-921: the browser image's heal tests (images/browser/cpb/heal.test.mjs) under the gate. The gate collects only
 * apps/server/src/**\/*.test.ts (scripts/gate.sh), so this file imports that one: its `test()` calls register here and run
 * in this file's process, the same as cpbview.test.ts and headers.test.ts reach images/browser/cpb.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const heal: { registered: number } = await import(new URL('../../../../images/browser/cpb/heal.test.mjs', import.meta.url).href);

test('the heal tests of the browser image are registered here (all 14, so none is lost by a wrong path or an empty import)', () => {
  assert.equal(heal.registered, 14);
});
