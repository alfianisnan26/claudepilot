import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { PASSWORD_HASH } from '@portal/contracts';
import { DEFAULT_PARAMS, PasswordHasher, TEST_PARAMS, UNMATCHABLE_HASH, acceptNewPassword, formatHash, isCommonPassword, normalizePassword, parseHash, passwordPolicy } from './passwords.js';

// Built at runtime: no password value is written in the repository (T-118 rule).
const GOOD = `${randomBytes(12).toString('hex')} ${randomBytes(6).toString('hex')}`;

test('a hash carries its parameters, a 16-byte salt and a 32-byte key, and verifies in constant time', async () => {
  const hasher = new PasswordHasher(TEST_PARAMS);
  const stored = await hasher.hash(GOOD);
  assert.match(stored, /^scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  const parsed = parseHash(stored)!;
  assert.equal(parsed.salt.length, PASSWORD_HASH.saltBytes);
  assert.equal(parsed.key.length, PASSWORD_HASH.keyBytes);
  assert.deepEqual(await hasher.verify(GOOD, stored), { ok: true, rehash: false });
  assert.deepEqual(await hasher.verify(`${GOOD}!`, stored), { ok: false, rehash: false });
  assert.notEqual(await hasher.hash(GOOD), stored, 'a fresh salt every time');
});

test('the default profile is OWASP’s minimum and fits in maxmem (N=2^17 would fail with the 32 MiB default)', async () => {
  assert.deepEqual(DEFAULT_PARAMS, { logN: 17, r: 8, p: 1 });
  const hasher = new PasswordHasher();
  const t0 = performance.now();
  const stored = await hasher.hash(GOOD);
  const ms = performance.now() - t0;
  assert.match(stored, /^scrypt\$ln=17,r=8,p=1\$/);
  assert.ok(ms > 20, `a real hash takes time (${ms.toFixed(0)} ms)`);
  assert.equal((await hasher.verify(GOOD, stored)).ok, true);
});

test('a hash made with weaker parameters still verifies and asks for a rehash', async () => {
  const weak = new PasswordHasher(TEST_PARAMS);
  const stored = await weak.hash(GOOD);
  const strong = new PasswordHasher({ logN: 11, r: 8, p: 1 });
  assert.deepEqual(await strong.verify(GOOD, stored), { ok: true, rehash: true });
  assert.deepEqual(await strong.verify('wrong wrong wrong wrong', stored), { ok: false, rehash: false });
});

test('the unmatchable hash and a malformed one cost a full hash and never match', async () => {
  const hasher = new PasswordHasher(TEST_PARAMS);
  assert.ok(parseHash(UNMATCHABLE_HASH), 'it parses, so the verify runs scrypt');
  assert.equal((await hasher.verify(GOOD, UNMATCHABLE_HASH)).ok, false);
  assert.equal((await hasher.verify(GOOD, 'not-a-hash')).ok, false);
  assert.equal((await hasher.verify(GOOD, '')).ok, false);
  assert.equal(parseHash(formatHash(TEST_PARAMS, Buffer.alloc(16), Buffer.alloc(32)))?.params.logN, 10);
  assert.equal(parseHash('bcrypt$2b$10$abc'), null);
});

test('the dummy hash is made once and is a real hash of this profile', async () => {
  const hasher = new PasswordHasher(TEST_PARAMS);
  const a = await hasher.dummy();
  assert.equal(await hasher.dummy(), a);
  assert.match(a, /^scrypt\$ln=10,/);
});

test('at most two hashes run at once; twenty wait; the rest get a 503 at once (I17)', async () => {
  const hasher = new PasswordHasher({ logN: 14, r: 8, p: 1 });
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => hasher.hash(GOOD)));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const refused = results.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'SERVICE_UNAVAILABLE').length;
  assert.equal(ok, 22, 'two in flight plus twenty queued');
  assert.equal(refused, 28);
  assert.equal(hasher.inFlight, 0);
  assert.equal(hasher.queued, 0);
});

test('a refused request is refused immediately, not after waiting', async () => {
  const hasher = new PasswordHasher({ logN: 14, r: 8, p: 1 }, { maxConcurrent: 1, maxQueue: 0 });
  const first = hasher.hash(GOOD);
  const t0 = performance.now();
  await assert.rejects(hasher.hash(GOOD), (e: { code?: string }) => e.code === 'SERVICE_UNAVAILABLE');
  assert.ok(performance.now() - t0 < 50);
  await first;
});

test('normalisation: NFKC, no NUL, 128 characters at most, checked before hashing', () => {
  assert.equal(normalizePassword('ﬁancée password here'), 'fiancée password here');
  assert.equal(normalizePassword('a\u0000b'), null);
  assert.equal(normalizePassword('x'.repeat(129)), null);
  assert.equal(normalizePassword('x'.repeat(128)), 'x'.repeat(128));
  assert.equal(normalizePassword(''), null);
  assert.equal(normalizePassword(42), null);
  assert.equal(normalizePassword('é'.repeat(128).normalize('NFD')), 'é'.repeat(128), 'counted in code points after NFKC');
});

test('the policy: 15 characters, not the name, not repeated, not a sequence, not on the block list', () => {
  assert.deepEqual(passwordPolicy(GOOD), []);
  assert.deepEqual(passwordPolicy('short'), ['too_short']);
  assert.deepEqual(passwordPolicy('x'.repeat(129)), ['too_long', 'repeated', 'common'], '43 times the listed xxx');
  assert.deepEqual(passwordPolicy('alice is my username', { username: 'Alice' }), ['same_as_username']);
  assert.deepEqual(passwordPolicy('Alice Liddell forever', { displayName: 'Alice Liddell' }), ['same_as_name']);
  assert.deepEqual(passwordPolicy('abababababababab'), ['repeated']);
  assert.deepEqual(passwordPolicy('abcdefghijklmnopq'), ['common'], 'the contract’s sequence rule only knows fixed prefixes; the list catches this');
  assert.deepEqual(passwordPolicy('passwordpassword'), ['common']);
  assert.deepEqual(passwordPolicy('correct horse battery staple'), ['common']);
  assert.deepEqual(passwordPolicy('Password12345678!'), ['common']);
  assert.deepEqual(passwordPolicy('1234567890123456'), ['sequence', 'common']);
  assert.deepEqual(passwordPolicy('iloveyouiloveyou'), ['common']);
  assert.deepEqual(passwordPolicy('mijn kat heet Pluis 1998'), []);
  assert.deepEqual(passwordPolicy('    spaces are fine too    '), []);
  assert.deepEqual(passwordPolicy('日本語のパスワードはとても長いです'), []);
});

test('the block list catches padding and repetition, and nothing else', () => {
  assert.equal(isCommonPassword('letmein'), true);
  assert.equal(isCommonPassword('LetMeIn123!!'), true);
  assert.equal(isCommonPassword('letmeinletmeinletmein'), true);
  assert.equal(isCommonPassword('123!letmein'), true);
  assert.equal(isCommonPassword('letmeinthisisnotcommon'), false);
  assert.equal(isCommonPassword('the cat sat on the mat'), false);
});

test('acceptNewPassword normalises and throws PASSWORD_REJECTED with the problems', () => {
  assert.equal(acceptNewPassword('ﬁne long passphrase here'), 'fine long passphrase here');
  assert.throws(() => acceptNewPassword('short'), (e: { code: string; status: number; details?: { problems: string[] } }) => e.code === 'PASSWORD_REJECTED' && e.status === 422 && e.details?.problems[0] === 'too_short');
  assert.throws(() => acceptNewPassword(''), (e: { details?: { problems: string[] } }) => e.details?.problems[0] === 'too_short');
  assert.throws(() => acceptNewPassword(undefined), (e: { code: string }) => e.code === 'PASSWORD_REJECTED');
  assert.throws(() => acceptNewPassword('has a NUL \u0000 in it here'), (e: { code: string }) => e.code === 'VALIDATION_FAILED');
});
