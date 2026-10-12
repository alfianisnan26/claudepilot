import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forbiddenReason } from './access.js';

test('only a 403 is a refusal for lack of rights, and it keeps the portal’s reason', () => {
  assert.equal(forbiddenReason({ status: 403, message: 'Only an admin can add built-in servers.' }), 'Only an admin can add built-in servers.');
  assert.equal(forbiddenReason({ status: 403, message: 'Forbidden' }), 'You don’t have access to this.');
  assert.equal(forbiddenReason({ status: 403, message: '' }), 'You don’t have access to this.');
});

test('other failures are not refusals', () => {
  assert.equal(forbiddenReason({ status: 422, message: 'Fill this in.' }), null);
  assert.equal(forbiddenReason({ status: 401, message: 'Sign in.' }), null);
  assert.equal(forbiddenReason(new Error('boom')), null);
  assert.equal(forbiddenReason(null), null);
  assert.equal(forbiddenReason('403'), null);
});
