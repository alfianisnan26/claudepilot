// PILOT-1185 slice 2: the server-code field with a short code (the 8 boxes, sent at the 8th) and a long one (one field, sent with Enter or
// the button), and what the session answer tells the app. Codes are made here at runtime.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODE_ALPHABET, CODE_LENGTH, LONG_CODE_MAX, LONG_CODE_MIN } from '@portal/contracts';
import { authStateOf, longCodeOf } from '../../lib/authState';
import { cleanCode, codeTooShort, sendsItself } from './codeField';

const code = (n: number) => Array.from({ length: n }, (_, i) => CODE_ALPHABET[(i * 7) % CODE_ALPHABET.length]).join('');

test('a short field: cleaned to 8, sent at the 8th character once; today’s codes work as before', () => {
  const c = code(CODE_LENGTH);
  assert.deepEqual(cleanCode(`${c.slice(0, 4).toLowerCase()}-${c.slice(4)}`, false), { value: c, long: false });
  assert.deepEqual(cleanCode('ab!c', false), { value: 'ABC', long: false });
  assert.equal(sendsItself(c, c.slice(0, 7), false), true);
  assert.equal(sendsItself(c, c, false), false, 'not twice');
  assert.equal(sendsItself(c.slice(0, 7), c.slice(0, 6), false), false);
  assert.equal(codeTooShort(c.slice(0, 7), false), `Enter all ${CODE_LENGTH} characters.`);
  assert.equal(codeTooShort(c, false), null);
});

test('a long field: never sends itself, takes up to 64, and says what is missing; a pasted long code turns a short field long', () => {
  const c = code(28);
  assert.equal(sendsItself(c.slice(0, CODE_LENGTH), c.slice(0, 7), true), false, 'a long code typed by hand is not sent at its 8th');
  assert.equal(sendsItself(c, c.slice(0, 27), true), false);
  assert.deepEqual(cleanCode(c.match(/.{1,4}/g)!.join('-'), true), { value: c, long: true }, 'the shown form, pasted');
  assert.equal(cleanCode(code(LONG_CODE_MAX + 5), true).value.length, LONG_CODE_MAX);
  assert.deepEqual(cleanCode(c, false), { value: c, long: true }, 'pasted into the boxes: kept whole, and the field goes long');
  assert.equal(sendsItself(cleanCode(c, false).value, '', cleanCode(c, false).long), false);
  assert.match(codeTooShort(c.slice(0, 20), true) ?? '', new RegExp(`${LONG_CODE_MIN} to ${LONG_CODE_MAX}`));
  assert.match(codeTooShort(c.slice(0, 12), false) ?? '', /whole code/, 'more than 8 in a short field: a long code, not finished');
  assert.equal(codeTooShort(c, true), null);
  assert.equal(codeTooShort(code(CODE_LENGTH), true), null, 'a new 8-character code still goes from a long field');
});

test('the session answer: longCode reaches the app signed out and signed in; an older server (no field) keeps the boxes', () => {
  const out = authStateOf({ authenticated: false, enabled: true, longCode: true });
  assert.deepEqual(out, { status: 'out', enabled: true, emailSignIn: false, longCode: true });
  assert.equal(longCodeOf(out), true);
  assert.equal(longCodeOf(authStateOf({ authenticated: true, enabled: true, longCode: true })), true);
  assert.equal(longCodeOf(authStateOf({ authenticated: false, enabled: true })), false);
  assert.equal(longCodeOf(authStateOf({ authenticated: true, enabled: true, longCode: false })), false);
  assert.equal(longCodeOf({ status: 'loading' }), false);
  assert.equal(longCodeOf({ status: 'unreachable' }), false);
});
