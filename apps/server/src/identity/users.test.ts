// Email accounts (T-118 MU1-min, owner 2026-10-17): create with the password policy, sign in, the same refusal for every wrong case, the
// throttle per email, disable, change the password, remove; no hash ever leaves the module.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import { PasswordHasher, TEST_PARAMS } from './passwords.js';
import { memoryDb } from './testkit.js';
import { PortalUsers } from './users.js';

const code = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return 'ok';
  } catch (e) {
    return e instanceof AppError ? e.code : String(e);
  }
};
const GOOD = ['correct', 'horse', 'battery', 'staple', 'pilot'].join('-');

function users() {
  const db = memoryDb();
  return { db, u: new PortalUsers(() => db, new PasswordHasher(TEST_PARAMS)) };
}

test('create an account and sign in with its email; the email is case-insensitive; no hash is shown', async () => {
  const { u } = users();
  assert.equal(u.any(), false);
  const a = await u.create({ email: 'Hasyim@Konfersi.com', displayName: 'Hasyim', password: GOOD }, 'ui');
  assert.equal(a.email, 'hasyim@konfersi.com');
  assert.equal(u.any(), true);
  assert.ok(!JSON.stringify(u.list()).includes('scrypt$'), 'no hash in the list');
  const signedIn = await u.verify('  HASYIM@konfersi.com ', GOOD, '10.0.0.1');
  assert.equal(signedIn.id, a.id);
  assert.ok(signedIn.lastLoginAt);
});

test('the same refusal for a wrong password, an unknown email and a disabled account; policy and duplicates refused', async () => {
  const { u } = users();
  const a = await u.create({ email: 'a@example.com', password: GOOD }, 'ui');
  assert.equal(await code(() => u.verify('a@example.com', GOOD + 'x', '10.0.0.2')), 'UNAUTHORIZED');
  assert.equal(await code(() => u.verify('nobody@example.com', GOOD, '10.0.0.2')), 'UNAUTHORIZED');
  await u.update(a.id, { state: 'disabled' });
  assert.equal(await code(() => u.verify('a@example.com', GOOD, '10.0.0.3')), 'UNAUTHORIZED', 'disabled reads as wrong');
  assert.equal(await code(() => u.create({ email: 'b@example.com', password: 'short' }, 'ui')), 'PASSWORD_REJECTED');
  assert.equal(await code(() => u.create({ email: 'not-an-email', password: GOOD }, 'ui')), 'VALIDATION_FAILED');
  assert.equal(await code(() => u.create({ email: 'A@example.com', password: GOOD }, 'ui')), 'CONFLICT', 'the email key is case-insensitive');
});

test('failures lock the email out (the right password too, until the lock ends); a password change and a removal work', async () => {
  const { u } = users();
  const a = await u.create({ email: 'c@example.com', password: GOOD }, 'ui');
  for (let i = 0; i < 5; i++) assert.equal(await code(() => u.verify('c@example.com', 'wrong-password-' + i, `10.0.1.${i}`)), 'UNAUTHORIZED');
  assert.equal(await code(() => u.verify('c@example.com', GOOD, '10.0.2.1')), 'LOCKED_OUT', 'locked per email, from any address');
  const { u: fresh } = users();
  const b = await fresh.create({ email: 'd@example.com', password: GOOD }, 'ui');
  const next = ['another', 'long', 'enough', 'pass', 'phrase'].join('-');
  await fresh.update(b.id, { password: next });
  assert.equal(await code(() => fresh.verify('d@example.com', GOOD, '10.0.3.1')), 'UNAUTHORIZED', 'the old password is gone');
  assert.equal((await fresh.verify('d@example.com', next, '10.0.3.1')).id, b.id);
  fresh.remove(b.id);
  assert.deepEqual(fresh.list(), []);
  assert.ok(a.id.startsWith('u_'));
});
