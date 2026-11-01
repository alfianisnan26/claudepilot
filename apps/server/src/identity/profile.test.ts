// The person's own profile (owner request 2026-11-01): name and username with their rules, a picture through the persona pipeline, and an
// SSO sign-in that fills what the person has not set without ever overwriting what they changed. Also the device label of a sign-in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import sharp from 'sharp';
import { deviceLabel } from './device.js';
import { PasswordHasher, TEST_PARAMS } from './passwords.js';
import { PortalProfiles, type ImageFetch } from './profile.js';
import { memoryDb } from './testkit.js';
import { PortalUsers } from './users.js';

const GOOD = ['profile', 'test', 'long', 'pass', 'phrase'].join('-');
const codeOf = async (fn: () => unknown): Promise<string> => {
  try {
    await fn();
    return 'ok';
  } catch (e) {
    return e instanceof AppError ? e.code : String(e);
  }
};
/** A real picture, made at run time (no fixture file). */
const png = (r: number, g: number, b: number) => sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g, b } } }).png().toBuffer();

function setup(fetchImage: ImageFetch | null = null) {
  const db = memoryDb();
  const users = new PortalUsers(() => db, new PasswordHasher(TEST_PARAMS));
  return { db, users, profiles: new PortalProfiles(() => db, () => db, fetchImage) };
}

test('a person changes their own name and username; the rules and the uniqueness hold; the same answer for taken and reserved', async () => {
  const { users, profiles } = setup();
  const a = await users.create({ email: 'a@example.com', displayName: 'Ann', password: GOOD }, 'ui');
  const b = await users.create({ email: 'b@example.com', password: GOOD }, 'ui');
  const p0 = profiles.profile(a.id);
  assert.deepEqual([p0.displayName, p0.username, p0.avatar, p0.passwordSet, p0.founder, p0.signIns], ['Ann', null, null, true, false, []]);
  assert.equal(profiles.update(a.id, { displayName: '  Ann Lee ', username: 'Ann.Lee' }).username, 'ann.lee', 'kept lowercase');
  assert.equal(profiles.profile(a.id).displayName, 'Ann Lee');
  assert.equal(await codeOf(() => profiles.update(b.id, { username: 'ANN.LEE' })), 'CONFLICT', 'one account per username, any case');
  assert.equal(await codeOf(() => profiles.update(b.id, { username: 'admin' })), 'CONFLICT', 'reserved reads as taken');
  assert.equal(await codeOf(() => profiles.update(b.id, { username: 'x' })), 'VALIDATION_FAILED');
  assert.equal(await codeOf(() => profiles.update(b.id, { displayName: '   ' })), 'VALIDATION_FAILED');
  assert.equal(await codeOf(() => profiles.update(b.id, { displayName: 'n'.repeat(61) })), 'VALIDATION_FAILED');
  // A refused change writes nothing, not even the valid half.
  assert.equal(await codeOf(() => profiles.update(b.id, { displayName: 'Bee', username: 'admin' })), 'CONFLICT');
  assert.equal(profiles.profile(b.id).displayName, 'b');
  assert.equal(profiles.update(a.id, { username: null }).username, null, 'cleared');
  assert.equal(profiles.profile(b.id).username, null, 'the other account is untouched');
});

test('a picture is re-encoded and served by its hash; removing it goes back to initials and sweeps the stored image', async () => {
  const { db, users, profiles } = setup();
  const a = await users.create({ email: 'pic@example.com', password: GOOD }, 'ui');
  const url = await profiles.setAvatar(a.id, await png(200, 30, 30));
  const sha = url.split('/').pop()!;
  assert.match(url, /^\/api\/users\/avatars\/[0-9a-f]{64}$/);
  assert.equal(profiles.profile(a.id).avatar, url);
  assert.ok(profiles.avatarPng(sha)?.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'a PNG');
  assert.equal(profiles.avatarPng('../../etc/passwd'), null);
  assert.equal(await codeOf(() => profiles.setAvatar(a.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))), 'VALIDATION_FAILED', 'only PNG, JPEG, WebP');
  profiles.clearAvatar(a.id);
  assert.equal(profiles.profile(a.id).avatar, null);
  assert.equal((db.prepare('SELECT count(*) AS n FROM user_avatars').get() as { n: number }).n, 0, 'nothing refers to it: gone');
});

test('SSO claims fill the name, username and picture of a new account, and never what the person changed afterwards', async () => {
  const pictures: string[] = [];
  const fetched = await png(10, 120, 200);
  const { users, profiles } = setup(async (url) => (pictures.push(url), fetched));
  const u = await users.createExternal('sso@konfersi.example', 'From IdP', 'member', 'sso:sso_x');
  await profiles.adoptClaims(u.id, { name: 'Sari Dewi', preferredUsername: 'sari', picture: 'https://idp.example/pic.png', allowPrivate: false });
  let p = profiles.profile(u.id);
  assert.deepEqual([p.displayName, p.username, !!p.avatar, p.passwordSet], ['Sari Dewi', 'sari', true, false]);
  assert.deepEqual(pictures, ['https://idp.example/pic.png']);
  // The same picture URL is not fetched again on the next sign-in.
  await profiles.adoptClaims(u.id, { name: 'Sari Dewi', preferredUsername: 'sari', picture: 'https://idp.example/pic.png', allowPrivate: false });
  assert.equal(pictures.length, 1);
  // The person changes their name, username and picture; the next sign-in leaves all three alone.
  profiles.update(u.id, { displayName: 'Sari', username: 'sari.d' });
  const mine = await profiles.setAvatar(u.id, await png(1, 2, 3));
  await profiles.adoptClaims(u.id, { name: 'Sari Dewi (IdP)', preferredUsername: 'sari2', picture: 'https://idp.example/new.png', allowPrivate: false });
  p = profiles.profile(u.id);
  assert.deepEqual([p.displayName, p.username, p.avatar], ['Sari', 'sari.d', mine]);
  assert.equal(pictures.length, 1, 'a picture the person chose is never replaced, so the new URL is not even fetched');
  // A removal is a choice too: the provider's picture does not come back.
  profiles.clearAvatar(u.id);
  await profiles.adoptClaims(u.id, { picture: 'https://idp.example/third.png', allowPrivate: false });
  assert.equal(profiles.profile(u.id).avatar, null);
});

test('SSO claims: a name an admin gave or a password account’s own name is kept; bad usernames and non-https pictures are skipped', async () => {
  const pictures: string[] = [];
  const { users, profiles } = setup(async (url) => (pictures.push(url), Buffer.from('not an image')));
  const owner = await users.create({ email: 'owner@example.com', displayName: 'Owner', password: GOOD }, 'ui');
  const taken = await users.create({ email: 't@example.com', password: GOOD }, 'ui');
  profiles.update(taken.id, { username: 'taken' });
  await profiles.adoptClaims(owner.id, { name: 'Somebody Else', preferredUsername: 'taken', picture: 'http://idp.example/p.png', allowPrivate: false });
  let p = profiles.profile(owner.id);
  assert.deepEqual([p.displayName, p.username, p.avatar], ['Owner', null, null], 'the name was given at creation; the username is taken');
  assert.deepEqual(pictures, [], 'http is never fetched');
  const ext = await users.createExternal('ext@konfersi.example', '', 'member', 'sso:sso_x');
  await users.update(ext.id, { displayName: 'Named by admin' });
  await profiles.adoptClaims(ext.id, { name: 'IdP name', preferredUsername: 'Not Valid!', picture: 'https://idp.example/broken.png', allowPrivate: false });
  p = profiles.profile(ext.id);
  assert.deepEqual([p.displayName, p.username, p.avatar], ['Named by admin', null, null], 'an unreadable picture is skipped, the sign-in is not failed');
  assert.deepEqual(pictures, ['https://idp.example/broken.png']);
});

test('the founder account is what a server-code session shows; none when there is no founder', async () => {
  const { db, users, profiles } = setup();
  assert.equal(profiles.founder(), null);
  const f = await users.create({ email: 'alfian@example.com', displayName: 'Alfian', password: GOOD, role: 'admin' }, 'ui');
  db.prepare('UPDATE users SET founder = 1 WHERE id = ?').run(f.id);
  assert.deepEqual(profiles.founder(), { displayName: 'Alfian', email: 'alfian@example.com', username: null, avatar: null });
  assert.equal(profiles.profile(f.id).founder, true);
});

test('a sign-in’s device is a short label, never the raw header', () => {
  const iphonePwa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const iphoneSafari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
  const macChrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const winEdge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
  const androidFirefox = 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0';
  assert.equal(deviceLabel(iphonePwa), 'iPhone');
  assert.equal(deviceLabel(iphoneSafari), 'Safari on iPhone');
  assert.equal(deviceLabel(macChrome), 'Chrome on Mac');
  assert.equal(deviceLabel(winEdge), 'Edge on Windows');
  assert.equal(deviceLabel(androidFirefox), 'Firefox on Android');
  assert.equal(deviceLabel('curl/8.5.0'), null);
  assert.equal(deviceLabel(undefined), null);
});
