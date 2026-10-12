import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyComplete, safeHref } from './signIn.js';

test('only web addresses become links: https, or http on this machine', () => {
  assert.equal(safeHref('https://git.example.com/login/oauth/authorize?client_id=x&state=y'), 'https://git.example.com/login/oauth/authorize?client_id=x&state=y');
  assert.equal(safeHref('http://localhost:7701/authorize?a=b'), 'http://localhost:7701/authorize?a=b');
  assert.equal(safeHref('http://127.0.0.1:9/x'), 'http://127.0.0.1:9/x');
  assert.equal(safeHref('http://evil.example.com/x'), null);
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,<b>x</b>'), null);
  assert.equal(safeHref('not a url'), null);
  assert.equal(safeHref(''), null);
});

test('a refused address leaves the sign-in open and says why', () => {
  const failure = classifyComplete({ status: 422, message: 'Claude Code doesn’t accept that address.', details: { redirectUrl: 'Not the address of this sign-in.' } });
  assert.deepEqual(failure, { retry: true, message: 'Not the address of this sign-in.' });
  assert.deepEqual(classifyComplete({ status: 422, message: 'Paste the address.' }), { retry: true, message: 'Paste the address.' });
});

test('an address still being checked can be pasted again', () => {
  assert.deepEqual(classifyComplete({ status: 409, message: 'An address is being checked. Wait a moment.' }), { retry: true, message: 'An address is being checked. Wait a moment.' });
});

test('a sign-in that ended, expired or was closed by Claude Code is over', () => {
  assert.deepEqual(classifyComplete({ status: 409, message: 'That sign-in has ended. Start it again.' }), { retry: false, message: 'That sign-in has ended. Start it again.' });
  assert.deepEqual(classifyComplete({ status: 503, message: 'Sign-in ended: the provider refused. Start again.' }), { retry: false, message: 'Sign-in ended: the provider refused. Start again.' });
  assert.deepEqual(classifyComplete({ status: 404, message: '' }), { retry: false, message: 'The sign-in ended. Start again.' });
});
