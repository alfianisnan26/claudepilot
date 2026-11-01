// Profile → Link (owner request 2026-11-01: "i will log in via git.isnan.me sso"). The signed-in account links the provider its own email
// signs in through: the identity is attached to THAT account only when the provider vouches for the account's own email and nobody holds the
// identity yet. An email match alone at sign-in still never takes over an admin or an account with a password (P6), and a link starts only
// for a provider the account's email routes to (an instance provider included, unlike the org step-up).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import { generateSecretKey, parseSecretKey, SecretBox } from '../store/secretBox.js';
import { authorizeParams, CLIENT_ID, fakeIdp, ISSUER } from './fakeIdp.js';
import { PasswordHasher, TEST_PARAMS } from './passwords.js';
import { SsoError, SsoProviders } from './sso.js';
import { PortalTeams } from './teams.js';
import { memoryDb } from './testkit.js';
import { PortalUsers } from './users.js';

const REDIRECT = 'https://pilot.example.com/api/auth/sso/callback';
const SECRET = ['not', 'a', 'real', 'secret'].join('-');
const PASSWORD = ['correct', 'horse', 'battery', 'staple', 'pilot'].join('-');

async function setup() {
  const db = memoryDb();
  const idp = fakeIdp();
  const box = new SecretBox(parseSecretKey(generateSecretKey()));
  const users = new PortalUsers(() => db, new PasswordHasher(TEST_PARAMS));
  const teams = new PortalTeams(() => db);
  const sso = new SsoProviders(() => db, () => db, () => box, users, teams, idp.client);
  // Like git.isnan.me for the owner: an instance provider that makes no accounts.
  const p = sso.create({ name: 'git.example', issuer: ISSUER, clientId: CLIENT_ID, clientSecret: SECRET, domains: ['example.com'], autoCreate: false }, 'ui', REDIRECT);
  const admin = await users.create({ email: 'ana@example.com', password: PASSWORD, role: 'admin' }, 'ui');
  /** A link of `account` (begin with `link`, the provider's answer with `claims`, finish). */
  const link = async (account: string, claims: Record<string, unknown> = {}) => {
    const { url, binding } = await sso.begin(p.id, null, REDIRECT, { account, sessionHash: 'h'.repeat(64), returnTo: '/profile?linked=1', link: true });
    const q = authorizeParams(url);
    idp.next = { nonce: q.nonce, ...claims };
    return sso.finish({ code: 'the-code', state: q.state }, binding);
  };
  const signIn = async (claims: Record<string, unknown> = {}) => {
    const { url, binding } = await sso.begin(p.id, 'ana@example.com', REDIRECT);
    const q = authorizeParams(url);
    idp.next = { nonce: q.nonce, ...claims };
    return sso.finish({ code: 'the-code', state: q.state }, binding);
  };
  return { db, users, sso, p, admin, link, signIn };
}

const fails = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof SsoError ? `sso:${e.code}${e.link ? ':link' : ''}` : e instanceof AppError ? e.code : String(e);
  }
};

test('before the link the admin cannot sign in by SSO (P6 holds); after it, the same identity signs it in', async () => {
  const { sso, p, admin, link, signIn } = await setup();
  assert.equal(await fails(signIn({ sub: '8' })), 'sso:no_account', 'an email match never takes an admin with a password');
  assert.deepEqual(sso.linkOffer(admin.id, admin.email), { id: p.id, name: 'git.example' });
  const r = await link(admin.id, { sub: '8' });
  assert.deepEqual([r.link, r.stepUp, r.linked, r.user.id, r.returnTo, r.stepUpSession], [true, true, true, admin.id, '/profile?linked=1', 'h'.repeat(64)]);
  assert.equal(sso.linkOffer(admin.id, admin.email), null, 'nothing left to link');
  const again = await signIn({ sub: '8' });
  assert.equal(again.user.id, admin.id);
  assert.equal(again.created, false);
});

test('refused: the provider gives another email; the identity belongs to another account; the account holds another identity there', async () => {
  const { db, users, p, admin, link } = await setup();
  assert.equal(await fails(link(admin.id, { sub: '8', email: 'mallory@example.com' })), 'sso:no_account:link', 'another email than the account’s');
  assert.equal(await fails(link(admin.id, { sub: '8', email_verified: false })), 'sso:email:link', 'an email the provider does not vouch for');
  const other = await users.create({ email: 'bo@example.com', password: PASSWORD, role: 'member' }, 'ui');
  db.prepare('INSERT INTO sso_identities (provider_id, subject, user_id, email, linked_at) VALUES (?, ?, ?, ?, ?)').run(p.id, '9', other.id, 'bo@example.com', 'x');
  assert.equal(await fails(link(admin.id, { sub: '9' })), 'sso:no_account:link', 'an identity another account holds');
  db.prepare('INSERT INTO sso_identities (provider_id, subject, user_id, email, linked_at) VALUES (?, ?, ?, ?, ?)').run(p.id, '10', admin.id, 'ana@example.com', 'x');
  assert.equal(await fails(link(admin.id, { sub: '8' })), 'sso:no_account:link', 'the account holds another identity at this provider');
  const rows = db.prepare('SELECT subject, user_id FROM sso_identities ORDER BY subject').all() as { subject: string; user_id: string }[];
  assert.deepEqual(rows.map((r) => [r.subject, r.user_id]), [['10', admin.id], ['9', other.id]], 'nothing was linked by a refusal');
});

test('a disabled account cannot link; a link offer only for the provider of the account’s own email domain', async () => {
  const { users, sso, admin, link } = await setup();
  const outsider = await users.create({ email: 'cy@elsewhere.org', password: PASSWORD, role: 'admin' }, 'ui');
  assert.equal(sso.linkOffer(outsider.id, outsider.email), null);
  await users.update(admin.id, { state: 'disabled' });
  assert.equal(await fails(link(admin.id, { sub: '8' })), 'sso:disabled:link');
});

test('the org step-up still refuses an instance provider without the link intent', async () => {
  const { sso, p, admin } = await setup();
  await assert.rejects(sso.begin(p.id, null, REDIRECT, { account: admin.id, sessionHash: 'h'.repeat(64), returnTo: '/' }), (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND');
});
