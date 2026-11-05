// PILOT-1185 slice 2: long server codes end to end. A code is 8 characters (today's, kept working) or 26 to 64; the generator makes 28
// (138.7 bits); the env code, a custom code and sign-in take a long one; the public session answer says only short or long. Codes are
// made here at runtime.
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { test } from 'node:test';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  codeBits,
  codeProblem,
  formatCode,
  GENERATED_CODE_LENGTH,
  isLongCode,
  LONG_CODE_MAX,
  LONG_CODE_MIN,
  MIN_CODE_BITS,
} from '@portal/contracts';
import { createApp } from './app.js';
import { generateCode, Portal } from './portal.js';
import { signinCodeCheck } from './signinCode.js';

const pick = (n: number) => Array.from({ length: n }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
const code = (n: number) => `2A${pick(n - 2)}`;

test('codeProblem: 8 characters, or 26 to 64; nothing between, nothing longer; dashes, spaces and case do not count', () => {
  for (const n of [CODE_LENGTH, LONG_CODE_MIN, 28, LONG_CODE_MAX]) assert.equal(codeProblem(code(n)), null, `${n} characters`);
  for (const n of [1, 7, 9, 16, LONG_CODE_MIN - 1, LONG_CODE_MAX + 1]) assert.match(codeProblem(code(n)) ?? '', /Use 8 characters, or 26 to 64\./, `${n}`);
  const long = code(28);
  assert.equal(codeProblem(formatCode(long).toLowerCase()), null, 'the shown form, typed in lower case');
  assert.equal(codeProblem(`${long.slice(0, 10)} ${long.slice(10)}`), null);
  assert.equal(codeProblem(`${code(27)}!`), 'Use letters and digits only.');
});

test('the generator: 28 characters of the look-alike-free alphabet, above the bar, shown as 7 groups of 4', () => {
  assert.equal(GENERATED_CODE_LENGTH, 28);
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const c = generateCode();
    seen.add(c);
    assert.equal(c.length, 28);
    assert.ok([...c].every((ch) => CODE_ALPHABET.includes(ch)), c.length.toString());
    assert.equal(codeProblem(c), null);
    assert.ok(codeBits(c) >= MIN_CODE_BITS);
    assert.ok(isLongCode(c));
    assert.match(formatCode(c), /^([A-Z0-9]{4}-){6}[A-Z0-9]{4}$/);
  }
  assert.equal(seen.size, 100, 'no repeats');
  // A fresh portal (no PORTAL_SERVER_CODE) starts on a generated, strong code: the boot check says nothing.
  const p = new Portal(undefined, 60_000);
  assert.equal(p.source, 'generated');
  assert.equal(signinCodeCheck(p, true).line, null);
});

test('formatCode: an 8-character code 4-4, a long one in groups of 4, anything else as it is', () => {
  assert.equal(formatCode('ABCDEFGH'), 'ABCD-EFGH');
  const c26 = code(26);
  assert.equal(formatCode(c26), `${c26.match(/.{1,4}/g)!.join('-')}`);
  assert.match(formatCode(c26), /-[A-Z0-9]{2}$/);
  for (const odd of ['ABCDEFGHJ', 'ABC', '']) assert.equal(formatCode(odd), odd);
});

/** Answers every property, call and construction with itself: enough for createApp to wire its routes (as qa/auth.test.ts). */
const stub: object = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
  set: () => true,
});
const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
const same = { host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/json' };
const build = (envCode: string) => {
  const portal = new Portal(envCode, 60_000);
  return { portal, app: make(portal, stub, stub, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub, mcp: stub, skills: stub }) };
};
const longCodeFlag = async (app: import('hono').Hono) => ((await (await app.request('/api/session')).json()) as { data: { longCode?: boolean } }).data.longCode;

test('sign-in with a long env code, typed in its shown form; the session answer says long, and short for an 8-character code', async () => {
  const envCode = code(30);
  const { app, portal } = build(envCode);
  assert.equal(portal.source, 'env');
  assert.equal(await longCodeFlag(app), true);

  const wrong = await app.request('/api/login', { method: 'POST', headers: same, body: JSON.stringify({ code: code(30) }) });
  assert.equal(wrong.status, 401, 'another long code is refused');
  const right = await app.request('/api/login', { method: 'POST', headers: same, body: JSON.stringify({ code: formatCode(envCode).toLowerCase() }) });
  assert.equal(right.status, 200);
  assert.match(right.headers.get('set-cookie') ?? '', /portal_session=/);
  const prefix = await app.request('/api/login', { method: 'POST', headers: same, body: JSON.stringify({ code: envCode.slice(0, CODE_LENGTH) }) });
  assert.equal(prefix.status, 401, 'its first 8 characters are not the code');

  const short = build(code(CODE_LENGTH));
  assert.equal(await longCodeFlag(short.app), false, 'an 8-character code keeps the boxes');
  const body = JSON.stringify(await (await short.app.request('/api/session')).json());
  assert.ok(!body.includes(short.portal.code), 'the answer never holds the code');
});

test('a long custom code: taken, matched in any case or grouping, and a code of 9 to 25 refused', () => {
  const p = new Portal(code(CODE_LENGTH), 60_000);
  const next = code(LONG_CODE_MAX);
  p.rotate('keep', next.toLowerCase());
  assert.equal(p.source, 'custom');
  assert.equal(p.code, next);
  assert.ok(p.matches(formatCode(next)));
  assert.ok(!p.matches(next.slice(0, -1)));
  assert.throws(() => p.rotate('keep', code(20)), (e: unknown) => (e as { code?: string }).code === 'VALIDATION_FAILED');
  assert.equal(p.code, next, 'a refused code leaves the code as it was');
  assert.throws(() => new Portal(code(12), 60_000), /PORTAL_SERVER_CODE is not usable: Use 8 characters, or 26 to 64\./);
});
