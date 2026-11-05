// PILOT-1185: the server sign-in code's strength. codeBits measures length times log2 of the alphabet the code actually uses; the boot
// check warns (or, strict, refuses to start) when code sign-in is on and the code is below MIN_CODE_BITS; a strict portal refuses a weak
// new code and turning code sign-in back on with one. No log line holds the code. Codes are made here at runtime.
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { test } from 'node:test';
import { CODE_ALPHABET, CODE_LENGTH, codeBits, MIN_CODE_BITS } from '@portal/contracts';
import { generateCode, Portal } from './portal.js';
import { signinCodeCheck } from './signinCode.js';

const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');
/** A code of `n` characters from the generator's alphabet that holds a digit and a letter, so its alphabet is that one (31). */
const mixed = (n: number) => `2A${pick(CODE_ALPHABET, n - 2)}`;
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('codeBits: length times log2 of the alphabet actually used; case, spaces and dashes do not count', () => {
  near(codeBits('24689357'), 8 * Math.log2(8)); // digits 2-9 only: 24 bits
  near(codeBits('10293847'), 8 * Math.log2(10)); // any digits
  near(codeBits('ABCDEFGH'), 8 * Math.log2(23)); // the generator's letters only
  near(codeBits('ILOVEYOU'), 8 * Math.log2(26)); // letters with a look-alike
  near(codeBits(mixed(CODE_LENGTH)), 8 * Math.log2(31)); // a generated-style code: 39.6
  near(codeBits(`0I${pick(CODE_ALPHABET, 6)}`), 8 * Math.log2(36)); // letters and digits with look-alikes: 41.4, the most 8 can be
  near(codeBits('abcd-efgh'), codeBits('ABCDEFGH'));
  assert.equal(codeBits(''), 0);
  for (let i = 0; i < 50; i++) assert.ok(codeBits(generateCode()) >= MIN_CODE_BITS, 'slice 2: a generated code (28 characters) reaches the bar');
  assert.ok(codeBits(mixed(26)) >= MIN_CODE_BITS, '26 characters of the generator alphabet: 128.8 bits');
  assert.ok(codeBits(mixed(25)) < MIN_CODE_BITS, '25 are not enough: 123.9');
});

test('boot check: a weak code with code sign-in on warns (never the code); strict refuses; code sign-in off or a strong code says nothing', () => {
  const code = mixed(CODE_LENGTH);
  const warn = signinCodeCheck({ code, source: 'env', codeSignIn: true }, false);
  assert.deepEqual([warn.weak, warn.refuse, warn.bits], [true, false, 39]);
  assert.match(warn.line ?? '', /server sign-in code \(env\) has about 39 bits, below 128.*PORTAL_SIGNIN_CODE_STRICT=true/);
  const strict = signinCodeCheck({ code, source: 'env', codeSignIn: true }, true);
  assert.deepEqual([strict.weak, strict.refuse], [true, true]);
  assert.match(strict.line ?? '', /^refusing to start: .* about 39 bits/);
  for (const c of [warn, strict]) {
    assert.ok(!c.line!.includes(code), 'the code is never in the line');
    assert.ok(!c.line!.includes(`${code.slice(0, 4)}-${code.slice(4)}`), 'nor its shown form');
  }
  for (const strictOn of [false, true]) {
    assert.deepEqual(signinCodeCheck({ code, source: 'env', codeSignIn: false }, strictOn), { bits: 39, weak: false, refuse: false, line: null }, 'code sign-in off: nothing to guess');
    const strong = signinCodeCheck({ code: mixed(26), source: 'custom', codeSignIn: true }, strictOn);
    assert.deepEqual([strong.weak, strong.refuse, strong.line], [false, false, null]);
  }
});

test('a strict portal refuses a weak new code and turning code sign-in on with one, takes a long one; not strict, any well-formed code', () => {
  const token = () => 'session-of-the-caller';
  const lax = new Portal(mixed(CODE_LENGTH), 60_000);
  lax.rotate(token());
  lax.rotate(token(), mixed(CODE_LENGTH));
  assert.equal(lax.source, 'custom', 'not strict: any well-formed code is taken');

  const envCode = mixed(CODE_LENGTH);
  const p = new Portal(envCode, 60_000);
  p.requireStrongCode = true;
  assert.throws(
    () => p.rotate(token(), mixed(CODE_LENGTH)),
    (e: unknown) => (e as { code?: string }).code === 'VALIDATION_FAILED' && /at least 128 bits/.test((e as Error).message),
  );
  assert.ok(p.matches(envCode), 'a refused rotation leaves the code as it was');
  assert.equal(p.source, 'env');

  p.setCodeSignIn(false);
  p.rotate(token(), mixed(CODE_LENGTH));
  assert.equal(p.source, 'custom', 'code sign-in off: the code only confirms actions, any code is taken');
  assert.throws(() => p.setCodeSignIn(true), /at least 128 bits/);
  assert.equal(p.codeSignIn, false, 'it stays off');
  p.setCodeSignIn(false); // turning it off is never refused

  // Slice 2: a long code is strong, so strict takes it, generated or by hand, and code sign-in goes back on with it.
  const longCode = mixed(26);
  p.rotate(token(), longCode);
  assert.ok(p.matches(longCode));
  p.setCodeSignIn(true);
  assert.equal(p.codeSignIn, true, 'with a long code it turns back on');
  p.rotate(token());
  assert.equal(p.source, 'generated');
  assert.ok(codeBits(p.code) >= MIN_CODE_BITS);
});
