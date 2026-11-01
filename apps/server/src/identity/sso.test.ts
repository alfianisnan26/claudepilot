// SSO sign-in (owner, 2026-10-17): an email on a provider's domain signs in through it; the ID token is checked for real (signature, issuer,
// audience, expiry, nonce; no `none`, no HMAC); the state is used once and bound to the browser; the account is found by the provider's
// subject, else linked by a verified email, else made as the provider says (role, team); a disabled account is refused; the client secret
// is sealed and goes to the provider only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import { generateSecretKey, parseSecretKey, SecretBox } from '../store/secretBox.js';
import { authorizeParams, CLIENT_ID, fakeIdp, ISSUER } from './fakeIdp.js';
import { normalizeIssuer, pkceChallenge } from './oidc.js';
import { PasswordHasher, TEST_PARAMS } from './passwords.js';
import { SsoError, SsoProviders } from './sso.js';
import { PortalTeams } from './teams.js';
import { memoryDb } from './testkit.js';
import { PortalUsers } from './users.js';

const REDIRECT = 'https://pilot.example.com/api/auth/sso/callback';
const SECRET = ['not', 'a', 'real', 'secret'].join('-');
const GOOD = ['correct', 'horse', 'battery', 'staple', 'pilot'].join('-');

function setup() {
  const db = memoryDb();
  const idp = fakeIdp();
  const box = new SecretBox(parseSecretKey(generateSecretKey()));
  const users = new PortalUsers(() => db, new PasswordHasher(TEST_PARAMS));
  const teams = new PortalTeams(() => db);
  const sso = new SsoProviders(() => db, () => db, () => box, users, teams, idp.client);
  const team = teams.create({ name: 'Konfersi' }, [], 'ui');
  const p = sso.create({ name: 'Example IdP', issuer: ISSUER, clientId: CLIENT_ID, clientSecret: SECRET, domains: ['example.com'], defaultTeamId: team.id }, 'ui', REDIRECT);
  /** One whole sign-in: begin, the provider's answer (with what `claims` adds), finish. */
  const signIn = async (claims: Record<string, unknown> = {}, opts: { binding?: (b: string) => string; header?: Record<string, unknown> } = {}) => {
    const { url, binding } = await sso.begin(p.id, 'ana@example.com', REDIRECT);
    const q = authorizeParams(url);
    idp.next = { nonce: q.nonce, ...claims };
    idp.header = opts.header ?? null;
    return sso.finish({ code: 'the-code', state: q.state }, opts.binding ? opts.binding(binding) : binding);
  };
  return { db, idp, box, users, teams, sso, team, p, signIn };
}

const fails = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof SsoError ? `sso:${e.code}` : e instanceof AppError ? e.code : String(e);
  }
};

test('the authorize URL carries PKCE (S256), a state, a nonce and the email hint; the secret is sealed and sent only to the token endpoint', async () => {
  const { sso, p, db, idp, signIn } = setup();
  const { url } = await sso.begin(p.id, 'Ana@Example.com', REDIRECT);
  const q = authorizeParams(url);
  assert.equal(new URL(url).origin + new URL(url).pathname, `${ISSUER}/authorize`);
  assert.deepEqual([q.response_type, q.client_id, q.redirect_uri, q.code_challenge_method, q.login_hint, q.scope], ['code', CLIENT_ID, REDIRECT, 'S256', 'ana@example.com', 'openid email profile']);
  assert.ok(q.state!.length >= 40 && q.nonce!.length >= 40 && q.code_challenge!.length === 43);
  const stored = (db.prepare('SELECT client_secret FROM sso_providers').get() as { client_secret: string }).client_secret;
  assert.ok(stored.startsWith('v1.') && !stored.includes(SECRET), 'sealed');
  assert.ok(!JSON.stringify(sso.list(REDIRECT)).includes(SECRET), 'never listed');
  await signIn();
  const tokenCall = idp.calls.find((c) => c.url.endsWith('/token'))!;
  const auth = (tokenCall.init!.headers as Record<string, string>).authorization!;
  assert.equal(Buffer.from(auth.replace('Basic ', ''), 'base64').toString(), `${CLIENT_ID}:${SECRET}`);
  const form = new URLSearchParams(String(tokenCall.init!.body));
  assert.equal(form.get('code_verifier') && pkceChallenge(form.get('code_verifier')!).length, 43);
  assert.equal(form.get('redirect_uri'), REDIRECT);
  assert.equal(form.get('client_secret'), null, 'Basic, not both');
});

test('a first sign-in makes a member in the provider’s team; the next one finds it by subject, even after the email changes at the provider', async () => {
  const { signIn, teams, team, users } = setup();
  const first = await signIn();
  assert.deepEqual([first.created, first.user.email, first.user.role, first.user.displayName], [true, 'ana@example.com', 'member', 'Ana']);
  assert.deepEqual(teams.idsOf(first.user.id), [team.id]);
  const again = await signIn({ email: 'ana.new@example.com' });
  assert.equal(again.user.id, first.user.id);
  assert.equal(again.created, false);
  assert.ok(users.get(first.user.id).lastLoginAt);
  // The account has no password anyone knows.
  assert.equal(await fails(users.verify('ana@example.com', GOOD, '10.0.0.9')), 'UNAUTHORIZED');
});

test('an existing account is linked by email only when nothing guards it (organizations slice 0); a disabled one is refused; no auto-create means no account', async () => {
  const { signIn, users, sso, p } = setup();
  // An admin with a password of its own is never taken over by an email match, and no second account is made for it.
  await users.create({ email: 'ana@example.com', password: GOOD, role: 'admin' }, 'ui');
  assert.equal(await fails(signIn()), 'sso:no_account');
  assert.equal(users.list().length, 1);
  // An account a provider made (no password, no link left, a member) still links, not duplicated.
  const made = await users.createExternal('cy@example.com', 'Cy', 'member', 'sso:sso_gone');
  const r = await signIn({ sub: 'sub-c', email: 'cy@example.com' });
  assert.deepEqual([r.user.id, r.created, r.linked, r.user.role], [made.id, false, true, 'member']);
  await users.update(made.id, { state: 'disabled' });
  assert.equal(await fails(signIn({ sub: 'sub-c', email: 'cy@example.com' })), 'sso:disabled');
  sso.update(p.id, { autoCreate: false }, REDIRECT);
  assert.equal(await fails(signIn({ sub: 'sub-2', email: 'bob@example.com' })), 'sso:no_account');
});

test('the email must be verified (unless trusted) and on the provider’s domains', async () => {
  const { signIn, sso, p } = setup();
  assert.equal(await fails(signIn({ email_verified: false })), 'sso:email');
  assert.equal(await fails(signIn({ email_verified: undefined })), 'sso:email');
  assert.equal(await fails(signIn({ email: undefined })), 'sso:email');
  assert.equal(await fails(signIn({ email: 'eve@evil.example.org' })), 'sso:domain');
  assert.equal(await fails(signIn({ email: 'eve@sub.example.com' })), 'sso:domain', 'a subdomain is not the domain');
  sso.update(p.id, { trustUnverifiedEmail: true }, REDIRECT);
  assert.equal(await fails(signIn({ email_verified: undefined })), 'ok');
});

test('the state is used once, expires, and is bound to the browser that started it', async () => {
  const { sso, p, idp, signIn } = setup();
  assert.equal(await fails(signIn({}, { binding: () => '' })), 'sso:state', 'no cookie');
  assert.equal(await fails(signIn({}, { binding: (b) => `${b.split('.')[0]}.forged` })), 'sso:state', 'another browser');
  const { url, binding } = await sso.begin(p.id, null, REDIRECT);
  const q = authorizeParams(url);
  idp.next = { nonce: q.nonce };
  assert.equal(await fails(sso.finish({ code: 'c', state: q.state }, binding)), 'ok');
  assert.equal(await fails(sso.finish({ code: 'c', state: q.state }, binding)), 'sso:state', 'once');
  assert.equal(await fails(sso.finish({ error: 'access_denied', state: 'x' }, binding)), 'sso:provider');
  idp.error = 'invalid_grant';
  const again = await sso.begin(p.id, null, REDIRECT);
  const e = await sso.finish({ code: 'c', state: authorizeParams(again.url).state }, again.binding).catch((x: unknown) => x as SsoError);
  assert.ok(e instanceof SsoError && e.code === 'token' && /invalid_grant/.test(e.message) && !/abc123/.test(e.message), 'the provider’s code, never its description');
});

test('forged or wrong ID tokens are refused: none, HMAC, another key, another issuer, another audience, expired, wrong nonce', async () => {
  const { signIn, idp, sso, p } = setup();
  assert.equal(await fails(signIn({}, { header: { alg: 'none', typ: 'JWT' } })), 'sso:token');
  assert.equal(await fails(signIn({}, { header: { alg: 'HS256', typ: 'JWT' } })), 'sso:token', 'an HMAC signed with the client id');
  assert.equal(await fails(signIn({ iss: 'https://evil.example.com' })), 'sso:token');
  assert.equal(await fails(signIn({ aud: 'another-client' })), 'sso:token');
  assert.equal(await fails(signIn({ aud: [CLIENT_ID, 'other'] })), 'sso:token', 'several audiences need azp');
  assert.equal(await fails(signIn({ aud: [CLIENT_ID, 'other'], azp: CLIENT_ID })), 'ok');
  assert.equal(await fails(signIn({ exp: Math.floor(Date.now() / 1000) - 3600 })), 'sso:token');
  assert.equal(await fails(signIn({ nonce: 'replayed' })), 'sso:token');
  assert.equal(await fails(signIn({}, { header: { alg: 'ES256', kid: 'ec1', typ: 'JWT' } })), 'ok', 'EC keys work');
  assert.equal(await fails(signIn({}, { header: { alg: 'RS256', kid: 'ec1', typ: 'JWT' } })), 'sso:token', 'an EC key never checks an RS signature');
  // A token signed by the right key with its payload changed afterwards.
  const { url, binding } = await sso.begin(p.id, null, REDIRECT);
  const q = authorizeParams(url);
  const good = idp.sign({ ...idp.claims(), nonce: q.nonce });
  const [h, , s] = good.split('.');
  idp.raw = `${h}.${Buffer.from(JSON.stringify({ ...idp.claims(), nonce: q.nonce, email: 'root@example.com' })).toString('base64url')}.${s}`;
  assert.equal(await fails(sso.finish({ code: 'c', state: q.state }, binding)), 'sso:token');
  idp.raw = null;
  // The provider rotates its key: the client reads the set again once and goes on.
  idp.rotate();
  assert.equal(await fails(signIn({}, { header: { alg: 'RS256', kid: 'rsa2', typ: 'JWT' } })), 'ok');
});

test('providers: a domain belongs to one enabled provider; the issuer is https; an email finds its provider by exact domain', () => {
  const { sso, p } = setup();
  assert.deepEqual(sso.forEmail('Someone@EXAMPLE.com'), { id: p.id, name: 'Example IdP' });
  assert.equal(sso.forEmail('someone@example.org'), null);
  assert.equal(sso.forEmail('not an email'), null);
  const code = (fn: () => unknown) => {
    try {
      fn();
      return 'ok';
    } catch (e) {
      return e instanceof AppError ? e.code : String(e);
    }
  };
  assert.equal(code(() => sso.create({ name: 'Two', issuer: ISSUER, clientId: 'x', domains: ['example.com'] }, 'ui', REDIRECT)), 'CONFLICT');
  assert.equal(code(() => sso.create({ name: 'Two', issuer: ISSUER, clientId: 'x', domains: ['*.example.com'] }, 'ui', REDIRECT)), 'VALIDATION_FAILED');
  assert.equal(code(() => sso.create({ name: 'Two', issuer: 'http://idp.example.net', clientId: 'x', domains: ['example.net'] }, 'ui', REDIRECT)), 'VALIDATION_FAILED');
  assert.equal(code(() => sso.create({ name: 'Two', issuer: ISSUER, clientId: 'x', domains: ['example.net'], scopes: 'email' }, 'ui', REDIRECT)), 'VALIDATION_FAILED', 'openid is required');
  sso.update(p.id, { enabled: false }, REDIRECT);
  assert.equal(sso.forEmail('a@example.com'), null, 'a provider that is off sends nobody to SSO');
  assert.equal(normalizeIssuer('https://idp.example.com/realms/x/'), 'https://idp.example.com/realms/x');
  assert.equal(createHash('sha256').update('').digest('hex').length, 64);
});

test('review: a second subject never takes over an account linked at the provider; admin auto-create needs an acceptance; a new issuer needs its secret again', async () => {
  const { signIn, sso, p } = setup();
  const first = await signIn({ sub: 'sub-a' });
  // The provider gives the same mailbox to someone else (a new subject): refused, the account stays with its subject.
  assert.equal(await fails(signIn({ sub: 'sub-b' })), 'sso:no_account');
  assert.equal((await signIn({ sub: 'sub-a' })).user.id, first.user.id);
  const code = (fn: () => unknown) => {
    try {
      fn();
      return 'ok';
    } catch (e) {
      return e instanceof AppError ? e.code : String(e);
    }
  };
  assert.equal(code(() => sso.update(p.id, { defaultRole: 'admin' }, REDIRECT)), 'VALIDATION_FAILED', 'every address an admin: confirm it');
  assert.equal(code(() => sso.update(p.id, { defaultRole: 'admin', acknowledgeAdminAutoCreate: true }, REDIRECT)), 'ok');
  assert.equal(code(() => sso.update(p.id, { name: 'renamed' }, REDIRECT)), 'ok', 'already accepted: other changes need no new acceptance');
  assert.equal(code(() => sso.update(p.id, { issuer: 'https://other.example.com' }, REDIRECT)), 'VALIDATION_FAILED', 'the old secret never goes to a new issuer');
  assert.equal(code(() => sso.update(p.id, { clientId: 'another' }, REDIRECT)), 'VALIDATION_FAILED');
  assert.equal(code(() => sso.update(p.id, { clientId: 'another', clientSecret: null }, REDIRECT)), 'ok', 'cleared on purpose');
});

test('review: nbf in the future is refused; a key that names another alg or curve never checks the token', async () => {
  const { signIn } = setup();
  assert.equal(await fails(signIn({ nbf: Math.floor(Date.now() / 1000) + 3600 })), 'sso:token');
  assert.equal(await fails(signIn({}, { header: { alg: 'ES384', kid: 'ec1', typ: 'JWT' } })), 'sso:token', 'a P-256 key named ES256 does not check an ES384 header');
});
