import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppOff, isHttpsUrl, runOpen } from './appOpen';

// T-948 QA fixes: the open route's answer is read one way by the frame and by "open in a new tab".
const apiError = (status: number) => Object.assign(new Error('x'), { status });
const fails = (status: number) => () => Promise.reject(apiError(status));

test('404 from the open route is the off state, for the frame and for a new tab alike; other errors stay errors', async () => {
  assert.deepEqual(await runOpen(fails(404)), { kind: 'off' });
  const other = await runOpen(fails(500));
  assert.equal(other.kind, 'error');
  assert.equal((await runOpen(() => Promise.reject(new Error('network')))).kind, 'error');
  assert.equal(isAppOff(apiError(404)), true);
  assert.equal(isAppOff(apiError(403)), false);
  assert.equal(isAppOff(null), false);
  assert.equal(isAppOff('404'), false);
});

test('re-open path: each call asks the route again and takes the new URL', async () => {
  let n = 0;
  const open = () => Promise.resolve({ url: `https://app-x-3000.example.test/__pilot/auth?code=c${++n}` });
  assert.deepEqual(await runOpen(open), { kind: 'url', url: 'https://app-x-3000.example.test/__pilot/auth?code=c1' });
  assert.deepEqual(await runOpen(open), { kind: 'url', url: 'https://app-x-3000.example.test/__pilot/auth?code=c2' });
  assert.equal(n, 2);
  // The feature is turned off between two opens: the second says off.
  assert.deepEqual(await runOpen(fails(404)), { kind: 'off' });
});

test('a URL that is not https is never used', async () => {
  for (const url of ['http://app-x-3000.example.test/', 'javascript:alert(1)', 'data:text/html,x', '//app-x.example.test/', 'not a url', '']) {
    assert.deepEqual(await runOpen(() => Promise.resolve({ url })), { kind: 'unsafe' }, url);
    assert.equal(isHttpsUrl(url), false, url);
  }
  assert.deepEqual(await runOpen(() => Promise.resolve({} as { url: string })), { kind: 'unsafe' });
  assert.equal(isHttpsUrl('https://app-x-3000.example.test/__pilot/auth?code=c'), true);
});
