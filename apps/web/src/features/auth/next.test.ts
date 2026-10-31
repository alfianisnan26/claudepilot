import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectReturnPath } from './next';

test('login next: only the reporter connect popup, same origin, its query kept', () => {
  const ok = '/reporter/v1/connect?bucket=KONF&origin=https%3A%2F%2Fstg.konfersi.com&nonce=abcdefghijklmnop1234';
  assert.equal(connectReturnPath(ok), ok);
  for (const bad of [null, '', '/admin', '//evil.example/reporter/v1/connect?x=1', 'https://evil.example/reporter/v1/connect?x=1', '/reporter/v1/connect', '/reporter/v1/connect?x=1#frag', '/reporter/v1/connect?x=<script>', '/reporter/v1/connect/../../admin?x=1', '/\\evil.example/reporter/v1/connect?x=1'])
    assert.equal(connectReturnPath(bad), null, String(bad));
});
