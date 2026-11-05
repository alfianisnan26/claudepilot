// PILOT-1185: the server sign-in code's strength. codeBits measures the characters a guesser can't predict (no runs, sequences or
// repeated blocks) times log2 of the alphabet the code actually uses (or of its few characters, when it has little variety); the boot
// check warns (or, strict, refuses to start) when code sign-in is on and the code is below MIN_CODE_BITS; a strict portal refuses a weak
// new code and turning code sign-in back on with one. No log line holds the code. Codes are made here at runtime.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODE_ALPHABET, CODE_LENGTH, codeBits, codeProblem, LONG_CODE_MAX, MIN_CODE_BITS } from '@portal/contracts';
import { generateCode, Portal } from './portal.js';
import { signinCodeCheck } from './signinCode.js';

/**
 * `n` characters of `alphabet` from a fixed seed: the same every run, so a test that needs an exact strength is never the odd random draw
 * that holds a run or a repeat (codeBits counts those for nothing).
 */
const seeded = (alphabet: string, n: number, seed: number) => {
  let s = seed;
  return Array.from({ length: n }, () => alphabet[((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 16) % alphabet.length]).join('');
};
/** A code of `n` characters from the generator's alphabet that holds a digit and a letter, so its alphabet is that one (31). */
const mixed = (n: number, seed = 1) => `2A${seeded(CODE_ALPHABET, n - 2, seed)}`;
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('codeBits: length times log2 of the alphabet actually used; case, spaces and dashes do not count', () => {
  near(codeBits('26489357'), 8 * Math.log2(8)); // digits 2-9 only: 24 bits
  near(codeBits('10293847'), 8 * Math.log2(10)); // any digits
  near(codeBits('HAZEMRUW'), 8 * Math.log2(23)); // the generator's letters only
  near(codeBits('ILOVEYOU'), 8 * Math.log2(26)); // letters with a look-alike
  near(codeBits(mixed(CODE_LENGTH)), 8 * Math.log2(31)); // a generated-style code: 39.6
  near(codeBits(`0I${seeded(CODE_ALPHABET, 6, 7)}`), 8 * Math.log2(36)); // letters and digits with look-alikes: 41.4, the most 8 can be
  near(codeBits('hazem-ruw'), codeBits('HAZEMRUW'));
  assert.equal(codeBits(''), 0);
  for (let i = 0; i < 50; i++)
    assert.ok(codeBits(generateCode()) >= MIN_CODE_BITS, 'slice 2: a generated code (28 characters) reaches the bar');
  assert.ok(codeBits(mixed(26)) >= MIN_CODE_BITS, '26 characters of the generator alphabet: 128.8 bits');
  assert.ok(codeBits(mixed(25)) < MIN_CODE_BITS, '25 are not enough: 123.9');
});

test('codeBits measures what is in the code: a repeated letter, a run, a sequence, a repeated block and low variety count little', () => {
  const same = 'A'.repeat(29); // the review's case: 29 of one letter, well-formed, 29 × log2(23) = 135.6 by its length alone
  assert.equal(codeProblem(same), null, 'well-formed: only its strength is the problem');
  assert.equal(codeBits(same), 0, 'one character, said 29 times');
  assert.equal(codeBits('7'.repeat(LONG_CODE_MAX)), 0);
  // A run inside an otherwise good code: its 4th character on counts nothing.
  const good = mixed(28, 3);
  near(codeBits(good), 28 * Math.log2(31));
  const withRun = `${good.slice(0, 14)}${'K'.repeat(12)}${good.slice(14)}`;
  assert.ok(codeBits(withRun) < codeBits(good) + 3 * Math.log2(31) + 1e-9, 'twelve Ks add at most three characters');
  // Sequences: the alphabet in order, backwards, every other letter.
  assert.ok(codeBits(CODE_ALPHABET) < 20, 'the generator alphabet in order: 3 characters worth');
  assert.ok(codeBits([...CODE_ALPHABET].reverse().join('')) < 20);
  assert.ok(codeBits('ACEGJMPRTVXZ'.repeat(3)) < MIN_CODE_BITS);
  // A repeated block: counted once (and two more for the seam).
  const block = seeded(CODE_ALPHABET, 7, 11);
  assert.ok(codeBits(block.repeat(5)) <= 9 * Math.log2(31), 'a block of 7 said 5 times: at most 9 characters');
  assert.ok(codeBits('AB'.repeat(16)) < 10, 'two letters in turn');
  // Low variety: no run, no sequence, few repeats of three, but only three different characters: measured as an alphabet of three.
  const three = seeded('2XQ', LONG_CODE_MAX, 5);
  assert.ok(codeBits(three) <= LONG_CODE_MAX * Math.log2(3) + 1e-9);
  assert.ok(codeBits(three) < MIN_CODE_BITS);
  // Every one of them is refused by a strict portal, and the boot check refuses to start with the review's case.
  const p = new Portal(mixed(CODE_LENGTH), 60_000);
  p.requireStrongCode = true;
  for (const weak of [same, CODE_ALPHABET, block.repeat(5), three])
    assert.throws(() => p.rotate('keep', weak), /at least 128 bits/, `${weak.length} characters`);
  p.rotate('keep', good);
  assert.ok(p.matches(good), 'a good long code is still taken');
  const boot = signinCodeCheck({ code: same, source: 'env', codeSignIn: true }, true);
  assert.deepEqual([boot.bits, boot.weak, boot.refuse], [0, true, true]);
  assert.ok(!boot.line!.includes(same), 'never the code');
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
    assert.deepEqual(
      signinCodeCheck({ code, source: 'env', codeSignIn: false }, strictOn),
      { bits: 39, weak: false, refuse: false, line: null },
      'code sign-in off: nothing to guess',
    );
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

  const envCode = mixed(CODE_LENGTH, 2);
  const p = new Portal(envCode, 60_000);
  p.requireStrongCode = true;
  assert.throws(
    () => p.rotate(token(), mixed(CODE_LENGTH, 4)),
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
