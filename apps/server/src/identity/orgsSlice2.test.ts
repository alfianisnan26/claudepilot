// Organizations slice 2 (docs/prd/organizations.md §9.4, §9.8, §13 P6): SSO hardening, on the fake IdP (identity/fakeIdp.ts).
// - The §9.4 linking matrix, one row per situation: linked subject; linkable account (no password, no other link); an account with a
//   password, another SSO link, an admin role or the founder mark (never linked); no account with and without "Make accounts".
// - JIT never makes an instance admin without the recorded confirmation (migration 420), and never from an organization's provider.
// - An address the provider does not vouch for (a provider set to trust unverified emails) never takes an existing account.
// - The discovery and JWKS caches are keyed by (url, allowPrivate).
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import { generateSecretKey, parseSecretKey, SecretBox } from '../store/secretBox.js';
import { MIGRATIONS } from '../store/migrations.js';
import { authorizeParams, CLIENT_ID, fakeIdp, ISSUER } from './fakeIdp.js';
import { OidcClient } from './oidc.js';
import { PasswordHasher, TEST_PARAMS } from './passwords.js';
import { jitRole, SsoError, SsoProviders } from './sso.js';
import { PortalTeams } from './teams.js';
import { memoryDb } from './testkit.js';
import { PortalUsers } from './users.js';

const REDIRECT = 'https://pilot.example.com/api/auth/sso/callback';
const GOOD = ['correct', 'horse', 'battery', 'staple', 'pilot'].join('-');

function rig(o: { defaultRole?: 'admin' | 'member'; autoCreate?: boolean; trustUnverifiedEmail?: boolean } = {}) {
  const db = memoryDb();
  const idp = fakeIdp();
  const box = new SecretBox(parseSecretKey(generateSecretKey()));
  const users = new PortalUsers(() => db, new PasswordHasher(TEST_PARAMS));
  const teams = new PortalTeams(() => db);
  const providers = new SsoProviders(() => db, () => db, () => box, users, teams, idp.client);
  const p = providers.create(
    {
      name: 'IdP',
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: null,
      domains: ['example.com'],
      defaultRole: o.defaultRole ?? 'member',
      autoCreate: o.autoCreate ?? true,
      trustUnverifiedEmail: o.trustUnverifiedEmail ?? false,
      acknowledgeAdminAutoCreate: o.defaultRole === 'admin' ? true : undefined,
    } as never,
    'user:u_owner',
    REDIRECT,
  );
  const signIn = async (claims: Record<string, unknown>) => {
    const { url, binding } = await providers.begin(p.id, String(claims.email), REDIRECT);
    idp.next = { nonce: authorizeParams(url).nonce, ...claims };
    return providers.finish({ code: 'the-code', state: authorizeParams(url).state }, binding);
  };
  const outcome = (pr: Promise<{ user: { id: string }; created: boolean; linked: boolean }>) =>
    pr.then(
      (r) => ({ result: r.created ? 'created' : r.linked ? 'linked' : 'signed-in', userId: r.user.id }),
      (e) => ({ result: e instanceof SsoError ? `refused:${e.code}` : String(e), userId: null as string | null }),
    );
  const links = () => (db.prepare('SELECT count(*) AS n FROM sso_identities').get() as { n: number }).n;
  return { db, idp, users, providers, p, signIn, outcome, links };
}

test('§9.4 matrix: every situation of a callback with a verified email on the provider’s domain', async () => {
  const t = rig();
  const otherProvider = "INSERT INTO sso_providers (id, name, issuer, client_id, domains, created_by, created_at, updated_at) VALUES ('sso_other', 'o', 'https://o.example', 'c', '[]', 'ui', 'x', 'x')";
  t.db.prepare(otherProvider).run();
  // The accounts, one per row.
  const linkedBefore = await t.users.createExternal('linked@example.com', 'L', 'member', `sso:${t.p.id}`);
  t.db.prepare('INSERT INTO sso_identities (provider_id, subject, user_id, email, linked_at) VALUES (?, ?, ?, ?, ?)').run(t.p.id, 'sub-linked', linkedBefore.id, 'linked@example.com', 'x');
  const plain = await t.users.createExternal('plain@example.com', 'P', 'member', 'sso:sso_other'); // SSO-made earlier, no link left
  const withPassword = await t.users.create({ email: 'pw@example.com', password: GOOD, role: 'member' }, 'ui');
  const otherLink = await t.users.createExternal('held@example.com', 'H', 'member', 'sso:sso_other');
  t.db.prepare("INSERT INTO sso_identities (provider_id, subject, user_id, email, linked_at) VALUES ('sso_other', 'other-sub', ?, 'held@example.com', 'x')").run(otherLink.id);
  const admin = await t.users.createExternal('boss@example.com', 'B', 'admin', 'sso:sso_other');
  const founder = await t.users.createExternal('founder@example.com', 'F', 'member', 'sso:sso_other');
  t.db.prepare('UPDATE users SET founder = 1 WHERE id = ?').run(founder.id);

  const rows: [string, Record<string, unknown>, string, string | null][] = [
    ['(provider, sub) already linked', { sub: 'sub-linked', email: 'linked@example.com' }, 'signed-in', linkedBefore.id],
    ['no link; account with no password and no other link', { sub: 'sub-plain', email: 'plain@example.com' }, 'linked', plain.id],
    ['no link; account with a password', { sub: 'sub-pw', email: 'pw@example.com' }, 'refused:no_account', null],
    ['no link; account held by another SSO link', { sub: 'sub-held', email: 'held@example.com' }, 'refused:no_account', null],
    ['no link; account is a platform admin', { sub: 'sub-boss', email: 'boss@example.com' }, 'refused:no_account', null],
    ['no link; the founding account', { sub: 'sub-founder', email: 'founder@example.com' }, 'refused:no_account', null],
  ];
  for (const [name, claims, want, userId] of rows) {
    const got = await t.outcome(t.signIn(claims));
    assert.equal(got.result, want, name);
    if (userId) assert.equal(got.userId, userId, name);
  }
  // No account, Make accounts on: a new member (the matrix's JIT row), its own id.
  const fresh = await t.outcome(t.signIn({ sub: 'sub-new', email: 'new@example.com' }));
  assert.equal(fresh.result, 'created');
  assert.equal(t.users.get(fresh.userId!).role, 'member');
  // No account, Make accounts off: refused, nothing made.
  const closed = rig({ autoCreate: false });
  assert.equal((await closed.outcome(closed.signIn({ sub: 'sub-x', email: 'x@example.com' }))).result, 'refused:no_account');
  assert.equal(closed.users.list().length, 0);
  // The guarded accounts got no link and no duplicate.
  for (const u of [withPassword, otherLink, admin, founder])
    assert.equal((t.db.prepare('SELECT count(*) AS n FROM sso_identities WHERE user_id = ? AND provider_id = ?').get(u.id, t.p.id) as { n: number }).n, 0, u.email);
});

test('an address the provider does not vouch for never takes an existing account by email, even a linkable one; it may make a new one', async () => {
  const t = rig({ trustUnverifiedEmail: true });
  const plain = await t.users.createExternal('plain@example.com', 'P', 'member', 'sso:sso_elsewhere');
  assert.equal(t.users.linkableByEmail(plain.id), true, 'verified, it would link (the matrix row above)');
  assert.equal((await t.outcome(t.signIn({ sub: 'sub-u1', email: 'plain@example.com', email_verified: false }))).result, 'refused:no_account');
  assert.equal(t.links(), 0);
  const made = await t.outcome(t.signIn({ sub: 'sub-u2', email: 'someone@example.com', email_verified: false }));
  assert.equal(made.result, 'created', 'the provider’s choice to trust unverified addresses still makes new accounts');
});

test('JIT makes an instance admin only with the recorded confirmation; clearing it (or a row that never had it) makes members', async () => {
  const t = rig({ defaultRole: 'admin' });
  const row = () => t.db.prepare('SELECT default_role, auto_create, admin_ack_at, admin_ack_by FROM sso_providers WHERE id = ?').get(t.p.id) as { admin_ack_at: string | null; admin_ack_by: string | null };
  assert.ok(row().admin_ack_at, 'the confirmation is recorded');
  assert.equal(row().admin_ack_by, 'user:u_owner', 'with who gave it');
  const first = await t.outcome(t.signIn({ sub: 's1', email: 'one@example.com' }));
  assert.equal(t.users.get(first.userId!).role, 'admin');
  // A row that makes admins with no recorded confirmation (an old row, a database edit) makes members.
  t.db.prepare('UPDATE sso_providers SET admin_ack_at = NULL WHERE id = ?').run(t.p.id);
  const second = await t.outcome(t.signIn({ sub: 's2', email: 'two@example.com' }));
  assert.equal(t.users.get(second.userId!).role, 'member');
  // Saving it again without confirming is refused; with it, recorded again.
  assert.throws(() => t.providers.update(t.p.id, { name: 'Renamed' } as never, REDIRECT, 'user:u_owner'), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED');
  t.providers.update(t.p.id, { acknowledgeAdminAutoCreate: true } as never, REDIRECT, 'user:u_Adm1n_00001');
  assert.equal(row().admin_ack_by, 'user:u_Adm1n_00001');
  // A rename keeps it (no new confirmation needed); turning it to member clears it, and turning back needs it again.
  t.providers.update(t.p.id, { name: 'Renamed again' } as never, REDIRECT);
  assert.equal(row().admin_ack_by, 'user:u_Adm1n_00001');
  t.providers.update(t.p.id, { defaultRole: 'member' } as never, REDIRECT);
  assert.equal(row().admin_ack_at, null);
  assert.throws(() => t.providers.update(t.p.id, { defaultRole: 'admin' } as never, REDIRECT), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED');
});

test('an organization’s provider never makes an instance admin, confirmed or not', () => {
  const base = { default_role: 'admin' as const, auto_create: 1, admin_ack_at: '2026-11-01T00:00:00.000Z' };
  assert.equal(jitRole({ ...base, org_id: null }), 'admin', 'an instance provider with the confirmation');
  assert.equal(jitRole({ ...base }), 'admin', 'no org column yet: instance-wide');
  assert.equal(jitRole({ ...base, org_id: 'org_konfersi' }), 'member');
  assert.equal(jitRole({ ...base, admin_ack_at: null }), 'member');
  assert.equal(jitRole({ ...base, auto_create: 0 }), 'member');
  assert.equal(jitRole({ ...base, default_role: 'member' }), 'member');
});

test('an organization’s provider row (the org column a later slice adds) makes members at sign-in', async () => {
  const t = rig({ defaultRole: 'admin' });
  t.db.exec('ALTER TABLE sso_providers ADD COLUMN org_id TEXT');
  t.db.prepare("UPDATE sso_providers SET org_id = 'org_konfersi' WHERE id = ?").run(t.p.id);
  const made = await t.outcome(t.signIn({ sub: 's-org', email: 'staff@example.com' }));
  assert.equal(made.result, 'created');
  assert.equal(t.users.get(made.userId!).role, 'member');
});

test('migration 420: providers that make admins today keep their confirmation (audited as the migration); others have none', () => {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  const sorted = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  for (const m of sorted.filter((x) => x.version < 420)) m.up(db);
  const ins = db.prepare("INSERT INTO sso_providers (id, name, issuer, client_id, domains, default_role, auto_create, created_by, created_at, updated_at) VALUES (?, ?, 'https://i.example', 'c', '[]', ?, ?, 'ui', 'c', ?)");
  ins.run('sso_admin', 'a', 'admin', 1, '2026-10-20T00:00:00.000Z');
  ins.run('sso_admin_off', 'b', 'admin', 0, '2026-10-21T00:00:00.000Z');
  ins.run('sso_member', 'c', 'member', 1, '2026-10-22T00:00:00.000Z');
  for (const m of sorted.filter((x) => x.version >= 420)) m.up(db);
  const rows = Object.fromEntries((db.prepare('SELECT id, admin_ack_at, admin_ack_by FROM sso_providers').all() as { id: string; admin_ack_at: string | null; admin_ack_by: string | null }[]).map((r) => [r.id, [r.admin_ack_at, r.admin_ack_by]]));
  assert.deepEqual(rows, { sso_admin: ['2026-10-20T00:00:00.000Z', 'system:migration-420'], sso_admin_off: [null, null], sso_member: [null, null] });
});

test('§9.8: the discovery and JWKS caches are keyed by (url, allowPrivate): a document read under "private allowed" is never served to a provider that may not', async () => {
  const idp = fakeIdp();
  const guarded: boolean[] = [];
  const fetches: string[] = [];
  // The fake IdP's own fetch, behind a guard that records the rule and refuses private when it is not allowed (the issuer is "private").
  const client = new OidcClient(
    async (url, init) => {
      fetches.push(url);
      return idp.fetch(url, init);
    },
    async (_url, allowPrivate) => {
      guarded.push(allowPrivate);
      if (!allowPrivate) throw new AppError('VALIDATION_FAILED', 'private address');
    },
  );
  await client.discover(ISSUER, true);
  assert.equal(fetches.length, 1);
  await client.discover(ISSUER, true);
  assert.equal(fetches.length, 1, 'cached for the same rule');
  await assert.rejects(client.discover(ISSUER, false), /private address/, 'the other rule reads again, through its own guard');
  assert.deepEqual(guarded, [true, false]);
});
