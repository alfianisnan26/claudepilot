// Organizations slice 10 (docs/prd/organizations.md §9, §13.2 row 10) against a real migrated database, a DNS fake and the fake IdP
// (identity/fakeIdp.ts): domains verified by TXT (refused public domains, unique across orgs and instance providers, lost after 7 failed
// checks, the check rate limited per org), the org's provider (no private network, no unverified email, owner never mapped, team rules only
// for the org's teams), every §9.4 row through an org provider, group rules at each sign-in, requireSso (the lock-out guard, password
// sessions and stale tokens lose the org's objects, members outside the verified domains count as guests unless excepted), and step-up.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AppError } from '@isnanme/core';
import { objectRef, orgRef, type Actor, type OrgId, type UserId } from '@portal/contracts';
import { registerOwnerResolvers } from '../authz/owners.js';
import { can, clearResolvers, useAccountRoles, useOrgAuthority, type AccountRoleOf } from '../authz/seam.js';
import { authorizeParams, CLIENT_ID, fakeIdp, ISSUER } from '../identity/fakeIdp.js';
import { PasswordHasher, TEST_PARAMS } from '../identity/passwords.js';
import { SsoError, SsoProviders } from '../identity/sso.js';
import { PortalTeams } from '../identity/teams.js';
import { PortalUsers } from '../identity/users.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { createOrgs, normalizeOrgDomain, type OrgsModule } from './index.js';

const REDIRECT = 'https://pilot.example.com/api/auth/sso/callback';
const GOOD = ['correct', 'horse', 'battery', 'staple', 'pilot'].join('-');

let store: Store;
let m: OrgsModule;
let users: PortalUsers;
let sso: SsoProviders;
let restoreRoles: AccountRoleOf;
let clock = Date.now();
const idp = fakeIdp();
/** The DNS fake: name -> TXT records (each a list of strings). */
const dns = new Map<string, string[][]>();
let dnsCalls = 0;

let ADMIN: UserId; // instance admin, creates the orgs, then leaves Acme
let ALICE: UserId; // Acme owner, alice@acme.test, has a password
let BOB: UserId; // Acme admin, bob@acme.test, made by SSO earlier (no password)
let CONTRACTOR: UserId; // Acme admin outside the domain, cora@outside.test
let acme: OrgId;
let beta: OrgId;

const person = (userId: string, session = 'legacy'): Actor => ({ kind: 'user', userId: userId as UserId, loginSessionId: session, via: 'ui' });
const token = (userId: string): Actor => ({ kind: 'token', userId: userId as UserId, tokenId: 'ptk_x', scope: 'admin' });
const code = (c: string, reason?: string) => (e: unknown) => {
  assert.ok(e instanceof AppError, `an AppError, got ${String(e)}`);
  assert.equal(e.code, c, e.message);
  if (reason) assert.equal((e.details as { reason?: string } | undefined)?.reason, reason);
  return true;
};
const level = (actor: Actor, ref = objectRef('vault', 'v_acme')) =>
  can(actor, 'manage', ref).allow ? 'manage' : can(actor, 'operate', ref).allow ? 'operate' : can(actor, 'view', ref).allow ? 'view' : 'none';
const publish = (domain: string, orgId: OrgId) => {
  const d = m.sso!.settings(person(ADMIN_OR_OWNER(orgId)), orgId, REDIRECT).domains.find((x) => x.domain === domain)!;
  dns.set(d.record.name, [['unrelated'], [d.record.value.slice(0, 10), d.record.value.slice(10)]]); // TXT strings are joined
};
const ADMIN_OR_OWNER = (orgId: OrgId) => (orgId === acme ? ALICE : ADMIN);
const memberRow = (orgId: string, userId: string) =>
  store.db!.prepare('SELECT role, state, via FROM org_members WHERE org_id = ? AND user_id = ?').get(orgId, userId) as { role: string; state: string; via: string } | undefined;

/** One sign-in through a provider, as identity/routes.ts runs it (finish, then the org's sync with the session's hash). */
async function signIn(providerId: string, claims: Record<string, unknown>, opts: { session?: string; stepUp?: { account: string; sessionHash: string } } = {}) {
  const { url, binding } = await sso.begin(providerId, String(claims.email), REDIRECT, opts.stepUp ? { ...opts.stepUp, returnTo: '/x' } : undefined);
  idp.next = { nonce: authorizeParams(url).nonce, ...claims };
  const r = await sso.finish({ code: 'the-code', state: authorizeParams(url).state }, binding);
  if (r.orgId)
    m.sso!.onSignIn({ orgId: r.orgId, providerId: r.providerId, userId: users.principalOf(r.user.id), groups: r.groups, created: r.created, sessionHash: r.stepUpSession ?? opts.session ?? null });
  return r;
}
const outcome = (p: Promise<{ user: { id: string }; created: boolean; linked: boolean }>) =>
  p.then(
    (r) => ({ result: r.created ? 'created' : r.linked ? 'linked' : 'signed-in', userId: r.user.id as string | null }),
    (e: unknown) => ({ result: e instanceof SsoError ? `refused:${e.code}` : String(e), userId: null }),
  );

let acmeProvider = '';

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-orgs10-'), secretKey: null });
  const db = store.db!;
  users = new PortalUsers(() => db, new PasswordHasher(TEST_PARAMS));
  const teams = new PortalTeams(() => db);
  sso = new SsoProviders(() => db, () => db, () => null, users, teams, idp.client);
  restoreRoles = useAccountRoles((id) => {
    const r = db.prepare('SELECT role, state FROM users WHERE id = ?').get(id) as { role: 'admin' | 'member'; state: string } | undefined;
    return r ? (r.state === 'active' ? r.role : 'disabled') : null;
  });
  m = createOrgs({
    store,
    now: () => new Date(clock),
    ssoProviders: sso,
    resolveTxt: async (name) => {
      dnsCalls++;
      const r = dns.get(name);
      if (!r) throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
      return r;
    },
  });
  registerOwnerResolvers({ db: () => db, workspace: () => null });
  ADMIN = (await users.create({ email: 'root@portal.test', password: GOOD, role: 'admin' }, 'ui')).id as UserId;
  ALICE = (await users.create({ email: 'alice@acme.test', password: GOOD, role: 'member' }, 'ui')).id as UserId;
  BOB = (await users.createExternal('bob@acme.test', 'Bob', 'member', 'sso:sso_gone')).id as UserId;
  CONTRACTOR = (await users.create({ email: 'cora@outside.test', password: GOOD, role: 'member' }, 'ui')).id as UserId;
  acme = m.orgs.create(person(ADMIN), { name: 'Acme', slug: 'acme' }).id;
  m.orgs.admit(acme, ALICE, 'owner', 'invite', 'test');
  m.orgs.admit(acme, BOB, 'admin', 'invite', 'test');
  m.orgs.admit(acme, CONTRACTOR, 'admin', 'invite', 'test');
  m.orgs.leave(person(ADMIN), acme);
  beta = m.orgs.create(person(ADMIN), { name: 'Beta', slug: 'beta' }).id;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at, owner_kind, owner_id) VALUES ('v_acme', 'Acme', 'vault', '/a', 0, ?, ?, 'org', ?)").run(now, now, acme);
});

after(() => {
  useAccountRoles(restoreRoles);
  useOrgAuthority(null);
  clearResolvers();
});

test('refused domains: public mail, hosting suffixes and names under them, public suffixes; a domain is normalized', () => {
  for (const d of ['gmail.com', 'Outlook.com', 'someone.github.io', 'vercel.app', 'co.uk', 'co.id', 'not a domain', 'localhost'])
    assert.throws(() => normalizeOrgDomain(d), code('VALIDATION_FAILED'), d);
  assert.throws(() => normalizeOrgDomain('gmail.com'), code('VALIDATION_FAILED', 'DOMAIN_REFUSED'));
  assert.equal(normalizeOrgDomain(' @Acme.Test. '), 'acme.test');
});

test('domain verification by TXT (DNS fake): pending until the record is there, then verified; members cannot, admins can', async () => {
  assert.throws(() => m.sso!.addDomain(person(ADMIN), acme, 'acme.test'), code('NOT_FOUND'), 'the instance admin is not in Acme: the same 404');
  const d = m.sso!.addDomain(person(BOB), acme, 'acme.test');
  assert.equal(d.state, 'pending');
  assert.equal(d.record.name, '_claudepilot-challenge.acme.test');
  assert.match(d.record.value, /^cp-verify=[A-Za-z0-9_-]{20,}$/);
  const first = await m.sso!.checkDomain(person(BOB), acme, 'acme.test');
  assert.deepEqual([first.state, first.failures], ['pending', 1], 'no record yet');
  publish('acme.test', acme);
  const ok = await m.sso!.checkDomain(person(BOB), acme, 'acme.test');
  assert.deepEqual([ok.state, ok.failures], ['verified', 0]);
  const row = store.db!.prepare("SELECT detail FROM platform_audit WHERE kind = 'org.domain_verified' ORDER BY id DESC").get() as { detail: string };
  assert.match(row.detail, /acme\.test/);
});

test('a domain is unique across orgs and instance providers', async () => {
  // Another org: adding a domain Acme holds verified is refused; a pending claim that later finds the record is refused too.
  assert.throws(() => m.sso!.addDomain(person(ADMIN), beta, 'acme.test'), code('CONFLICT', 'DOMAIN_TAKEN'));
  // An instance provider cannot take a domain an org verified …
  assert.throws(
    () => sso.create({ name: 'Inst', issuer: ISSUER, clientId: CLIENT_ID, domains: ['acme.test'] } as never, 'ui', REDIRECT),
    (e: unknown) => e instanceof AppError && e.code === 'CONFLICT',
  );
  // … and an org cannot add or verify a domain an instance provider serves.
  sso.create({ name: 'Inst', issuer: ISSUER, clientId: CLIENT_ID, domains: ['instance.test'] } as never, 'ui', REDIRECT);
  assert.throws(() => m.sso!.addDomain(person(ADMIN), beta, 'instance.test'), code('CONFLICT', 'DOMAIN_TAKEN'));
  // Two orgs may both claim a pending domain; the first to verify wins, the second is refused by the unique index.
  m.sso!.addDomain(person(ADMIN), beta, 'shared.test');
  m.sso!.addDomain(person(BOB), acme, 'shared.test');
  publish('shared.test', beta);
  assert.equal((await m.sso!.checkDomain(person(ADMIN), beta, 'shared.test')).state, 'verified');
  const acmeRecord = m.sso!.settings(person(ALICE), acme, REDIRECT).domains.find((x) => x.domain === 'shared.test')!.record;
  dns.set(acmeRecord.name, [[acmeRecord.value]]);
  await assert.rejects(m.sso!.checkDomain(person(BOB), acme, 'shared.test'), code('CONFLICT', 'DOMAIN_TAKEN'));
  m.sso!.removeDomain(person(BOB), acme, 'shared.test');
});

test('seven failed daily checks in a row make a verified domain lost (it stops routing); the record back makes it verified again', async () => {
  m.sso!.addDomain(person(ADMIN), beta, 'fleeting.test');
  publish('fleeting.test', beta);
  await m.sso!.recheckAll();
  const state = () => (store.db!.prepare("SELECT state, failures FROM org_domains WHERE domain = 'fleeting.test'").get() as { state: string; failures: number });
  assert.equal(state().state, 'verified');
  const rec = m.sso!.settings(person(ADMIN), beta, REDIRECT).domains.find((x) => x.domain === 'fleeting.test')!.record;
  dns.delete(rec.name);
  for (let i = 0; i < 6; i++) await m.sso!.recheckAll();
  assert.deepEqual({ ...state() }, { state: 'verified', failures: 6 });
  await m.sso!.recheckAll();
  assert.equal(state().state, 'lost');
  assert.ok(store.db!.prepare("SELECT 1 FROM platform_audit WHERE kind = 'org.domain_lost'").get());
  dns.set(rec.name, [[rec.value]]);
  await m.sso!.recheckAll();
  assert.equal(state().state, 'verified');
});

test('"Check now" is rate limited per org; a DNS that hangs or errors reads as no record', async () => {
  const org = m.orgs.create(person(ADMIN), { name: 'Limit', slug: 'limit' }).id;
  m.sso!.addDomain(person(ADMIN), org, 'limit.test');
  for (let i = 0; i < 10; i++) await m.sso!.checkDomain(person(ADMIN), org, 'limit.test');
  await assert.rejects(m.sso!.checkDomain(person(ADMIN), org, 'limit.test'), code('RATE_LIMITED'));
  const before = dnsCalls;
  await assert.rejects(m.sso!.checkDomain(person(ADMIN), org, 'limit.test'), code('RATE_LIMITED'));
  assert.equal(dnsCalls, before, 'refused before any lookup');
});

test('the org provider: never a private network or an unverified email, not in the instance list; owner never mapped; teams only of the org', () => {
  assert.throws(() => m.sso!.putProvider(person(BOB), acme, { name: 'Acme ID', issuer: ISSUER, clientId: CLIENT_ID, groupRules: [{ group: 'x', role: 'owner' as never }] }, REDIRECT), code('VALIDATION_FAILED'));
  assert.throws(() => m.sso!.putProvider(person(BOB), acme, { name: 'Acme ID', issuer: ISSUER, clientId: CLIENT_ID, groupRules: [{ group: 'x', team: 't_any' }] }, REDIRECT), code('VALIDATION_FAILED'));
  const p = m.sso!.putProvider(
    person(BOB),
    acme,
    { name: 'Acme ID', issuer: ISSUER, clientId: CLIENT_ID, groupsClaim: 'groups', groupRules: [{ group: 'admins', role: 'admin' }, { group: 'staff', role: 'member' }], allowPrivateNetwork: true, trustUnverifiedEmail: true } as never,
    REDIRECT,
  );
  acmeProvider = p.id;
  const row = store.db!.prepare('SELECT org_id, allow_private_network, trust_unverified_email, default_role FROM sso_providers WHERE id = ?').get(p.id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { org_id: acme, allow_private_network: 0, trust_unverified_email: 0, default_role: 'member' });
  assert.ok(!sso.list(REDIRECT).some((x) => x.id === p.id), 'the platform admin’s list holds instance providers only');
  assert.throws(() => sso.get(p.id, REDIRECT), (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND');
  assert.ok(!JSON.stringify(m.sso!.settings(person(ALICE), acme, REDIRECT)).includes('client_secret'));
});

test('routing: a verified org domain goes to the org’s provider (password still allowed until requireSso); a pending one does not', () => {
  assert.deepEqual(sso.forEmail('anyone@acme.test'), { id: acmeProvider, name: 'Acme ID', orgId: acme, passwordToo: true });
  assert.equal(sso.passwordRefused('alice@acme.test'), false);
  assert.equal(sso.forEmail('x@limit.test'), null, 'pending: no route (and no provider)');
});

test('§9.4 every row through an org provider (verified email on a verified domain), and the refusals around it', async () => {
  const db = store.db!;
  // (provider, sub) already linked: that account; its membership is created if missing.
  const linkedUser = await users.createExternal('lin@acme.test', 'Lin', 'member', `sso:${acmeProvider}`);
  db.prepare('INSERT INTO sso_identities (provider_id, subject, user_id, email, linked_at) VALUES (?, ?, ?, ?, ?)').run(acmeProvider, 'sub-lin', linkedUser.id, 'lin@acme.test', 'x');
  const founder = await users.createExternal('founder@acme.test', 'F', 'member', 'sso:elsewhere');
  db.prepare('UPDATE users SET founder = 1 WHERE id = ?').run(founder.id);
  const boss = await users.createExternal('boss@acme.test', 'Boss', 'admin', 'sso:elsewhere'); // an instance admin with no password
  const rows: [string, Record<string, unknown>, string, string | null][] = [
    ['linked', { sub: 'sub-lin', email: 'lin@acme.test' }, 'signed-in', linkedUser.id],
    ['no link; no password, no other link (made by SSO earlier)', { sub: 'sub-bob', email: 'bob@acme.test' }, 'linked', BOB],
    ['no link; has a password', { sub: 'sub-alice', email: 'alice@acme.test' }, 'refused:no_account', null],
    ['no link; a platform admin (an IdP minting an admin’s email)', { sub: 'sub-boss', email: 'boss@acme.test' }, 'refused:no_account', null],
    ['no link; the founder', { sub: 'sub-f', email: 'founder@acme.test' }, 'refused:no_account', null],
    ['no account, autoCreate on', { sub: 'sub-new', email: 'newbie@acme.test' }, 'created', null],
    ['unverified email', { sub: 'sub-u', email: 'u@acme.test', email_verified: false }, 'refused:email', null],
    ['a domain the org has not verified', { sub: 'sub-o', email: 'o@outside.test' }, 'refused:domain', null],
    ['another org’s verified domain (JIT into another org)', { sub: 'sub-beta', email: 'b@shared.test' }, 'refused:domain', null],
  ];
  for (const [name, claims, want, userId] of rows) {
    const got = await outcome(signIn(acmeProvider, claims));
    assert.equal(got.result, want, name);
    if (userId) assert.equal(got.userId, userId, name);
  }
  assert.equal(memberRow(acme, linkedUser.id)?.state, 'active', 'membership created for the linked account');
  const newbie = users.byEmail('newbie@acme.test')!;
  assert.equal(newbie.role, 'member', 'never an instance admin');
  assert.deepEqual({ ...memberRow(acme, newbie.id)! }, { role: 'member', state: 'active', via: 'sso_jit' }, 'defaultJoinRole, via sso_jit');
  const guardedLinks = db.prepare('SELECT count(*) AS n FROM sso_identities WHERE user_id IN (?, ?, ?)').get(ALICE, founder.id, boss.id) as { n: number };
  assert.equal(guardedLinks.n, 0, 'no link for the guarded accounts');
  assert.equal(memberRow(acme, boss.id), undefined, 'nor a membership');
  // autoCreate off: refused with the invitation message, nothing made. (Bob's sign-in above followed the role rules: no group, member.)
  assert.equal(memberRow(acme, BOB)?.role, 'member');
  m.sso!.putProvider(person(ALICE), acme, { autoCreate: false }, REDIRECT);
  const e = await signIn(acmeProvider, { sub: 'sub-closed', email: 'closed@acme.test' }).catch((x: unknown) => x);
  assert.ok(e instanceof SsoError && e.code === 'no_account' && /invitation/.test(e.message));
  assert.equal(users.byEmail('closed@acme.test'), null);
  m.sso!.putProvider(person(ALICE), acme, { autoCreate: true }, REDIRECT);
});

test('a member an admin removed is not brought back by a sign-in (removal sticks)', async () => {
  const lin = users.byEmail('lin@acme.test')!;
  m.orgs.removeMember(person(ALICE), acme, lin.id as UserId);
  await signIn(acmeProvider, { sub: 'sub-lin', email: 'lin@acme.test' });
  assert.equal(memberRow(acme, lin.id)?.state, 'removed');
});

test('group rules at every sign-in: highest mapped role wins, demotion applies, no match is defaultJoinRole, an owner is never touched', async () => {
  await signIn(acmeProvider, { sub: 'sub-bob', email: 'bob@acme.test', groups: ['staff', 'admins', 7] });
  assert.equal(memberRow(acme, BOB)?.role, 'admin');
  await signIn(acmeProvider, { sub: 'sub-bob', email: 'bob@acme.test', groups: ['staff'] });
  assert.equal(memberRow(acme, BOB)?.role, 'member', 'demoted by groups');
  m.orgs.setRole(person(ALICE), acme, BOB, 'guest');
  await signIn(acmeProvider, { sub: 'sub-bob', email: 'bob@acme.test', groups: [] });
  assert.equal(memberRow(acme, BOB)?.role, 'member', 'no match: defaultJoinRole');
  const audit = store.db!.prepare("SELECT detail FROM platform_audit WHERE kind = 'org.sso_signin' ORDER BY id DESC").get() as { detail: string };
  assert.ok(!audit.detail.includes('"groups"'), 'only the matched names are written');
  // Alice links by a step-up (she has a password), with admin groups: she stays owner.
  await signIn(acmeProvider, { sub: 'sub-alice', email: 'alice@acme.test', groups: ['staff'] }, { stepUp: { account: ALICE, sessionHash: 'h-alice' } });
  assert.equal(memberRow(acme, ALICE)?.role, 'owner');
  m.orgs.setRole(person(ALICE), acme, BOB, 'admin'); // for the tests below
  m.sso!.putProvider(person(ALICE), acme, { groupRules: [] }, REDIRECT);
});

test('step-up: links only a free identity with the account’s own email; another account’s identity is refused', async () => {
  const r = await sso.begin(acmeProvider, null, REDIRECT, { account: CONTRACTOR, sessionHash: 'h-c', returnTo: '/x' });
  idp.next = { nonce: authorizeParams(r.url).nonce, sub: 'sub-cora', email: 'cora@acme.test' };
  await assert.rejects(sso.finish({ code: 'c', state: authorizeParams(r.url).state }, r.binding), (e: unknown) => e instanceof SsoError && e.code === 'no_account', 'another email than the account’s');
  const again = await sso.begin(acmeProvider, null, REDIRECT, { account: CONTRACTOR, sessionHash: 'h-c', returnTo: '/x' });
  idp.next = { nonce: authorizeParams(again.url).nonce, sub: 'sub-bob', email: 'bob@acme.test' };
  await assert.rejects(sso.finish({ code: 'c', state: authorizeParams(again.url).state }, again.binding), (e: unknown) => e instanceof SsoError && e.code === 'no_account', 'Bob’s identity');
  assert.equal((store.db!.prepare("SELECT user_id FROM sso_identities WHERE subject = 'sub-alice'").get() as { user_id: string }).user_id, ALICE, 'Alice’s step-up linked her');
});

test('requireSso: owner only, and only after an owner signed in through the provider (the lock-out guard); the provider stays while it is on', async () => {
  const fresh = m.orgs.create(person(ADMIN), { name: 'Fresh', slug: 'fresh' }).id;
  m.sso!.putProvider(person(ADMIN), fresh, { name: 'F', issuer: ISSUER, clientId: CLIENT_ID }, REDIRECT);
  assert.throws(() => m.sso!.setPolicy(person(ADMIN), fresh, { requireSso: true }, REDIRECT), code('CONFLICT', 'SSO_LOCKOUT_GUARD'), 'no owner has signed in through it');
  assert.throws(() => m.sso!.setPolicy(person(BOB), acme, { requireSso: true }, REDIRECT), code('FORBIDDEN'), 'an admin is not an owner');
  const s = m.sso!.setPolicy(person(ALICE), acme, { requireSso: true, ssoFreshnessDays: 7 }, REDIRECT);
  assert.deepEqual([s.requireSso, s.ssoFreshnessDays, s.ownerSignedIn], [true, 7, true]);
  assert.throws(() => m.sso!.putProvider(person(ALICE), acme, { enabled: false }, REDIRECT), code('CONFLICT', 'SSO_LOCKOUT_GUARD'));
  assert.throws(() => m.sso!.removeProvider(person(ALICE), acme), code('CONFLICT', 'SSO_LOCKOUT_GUARD'));
  assert.equal(sso.passwordRefused('alice@acme.test'), true, 'a password is refused for the org’s domain now');
  assert.equal(sso.forEmail('alice@acme.test')?.passwordToo, undefined);
});

test('requireSso enforcement: a password session and a stale token lose the org’s objects; a marked session and a fresh token keep them', async () => {
  // Bob (admin, in the domain): his last sign-in marked the session 'h-bob'.
  await signIn(acmeProvider, { sub: 'sub-bob', email: 'bob@acme.test' }, { session: 'h-bob' });
  assert.equal(level(person(BOB, 'ws:h-other')), 'none', 'a session the provider did not mark: the same 404 as a missing vault');
  const missing = can(person(BOB, 'ws:h-other'), 'view', objectRef('vault', 'v_nosuch'));
  const gated = can(person(BOB, 'ws:h-other'), 'view', objectRef('vault', 'v_acme'));
  assert.equal(gated.allow === false && gated.reason, missing.allow === false && missing.reason);
  assert.equal(level(person(BOB, 'legacy')), 'none');
  assert.equal(level(person(BOB, 'ws:h-bob')), 'manage', 'the marked session');
  assert.equal(level(person(ALICE, 'ws:h-alice')), 'manage', 'the owner’s step-up session');
  assert.equal(level(token(BOB)), 'manage', 'a token within 7 days of his last sign-in');
  clock += 8 * 24 * 60 * 60_000;
  assert.equal(level(token(BOB)), 'none', 'stale: past ssoFreshnessDays');
  m.sso!.setPolicy(person(ALICE), acme, { ssoFreshnessDays: null }, REDIRECT);
  assert.equal(level(token(BOB)), 'manage', 'freshness off: one sign-in ever is enough');
  // The org itself stays visible (Org settings offers the step-up).
  assert.equal(can(person(BOB, 'ws:h-other'), 'view', orgRef(acme)).allow, true);
});

test('requireSso: a member outside the verified domains counts as a guest unless an owner lists them; an owner is never capped', () => {
  assert.equal(m.orgs.roleOf(acme, CONTRACTOR), 'admin', 'the stored role is kept');
  assert.equal(m.orgs.effectiveRoleOf(acme, CONTRACTOR), 'guest');
  assert.equal(level(person(CONTRACTOR, 'ws:x')), 'none', 'no manage on the org’s objects as a guest');
  assert.equal(can(person(CONTRACTOR, 'ws:x'), 'manage', orgRef(acme)).allow, false);
  m.sso!.setPolicy(person(ALICE), acme, { exceptions: [CONTRACTOR] }, REDIRECT);
  assert.equal(m.orgs.effectiveRoleOf(acme, CONTRACTOR), 'admin', 'an exception');
  assert.equal(level(person(CONTRACTOR, 'ws:x')), 'manage', 'outside the domains, requireSso does not gate the session');
  assert.throws(() => m.sso!.setPolicy(person(ALICE), acme, { exceptions: [ADMIN] }, REDIRECT), code('VALIDATION_FAILED'), 'exceptions are members');
  m.sso!.setPolicy(person(ALICE), acme, { requireSso: false }, REDIRECT);
  assert.equal(level(person(BOB, 'legacy')), 'manage', 'off again: the password session reaches it');
  assert.equal(sso.passwordRefused('alice@acme.test'), false);
});
