// Organizations slice 0 (docs/prd/organizations.md §13 P1, P2, P6): the founding account and the token owners backfilled by migrations 460
// and 461; an SSO provider that makes admins makes each one as THEMSELVES (never the founder); an email match never links an account that
// has a password, is an admin, or is held by another SSO identity.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { FOUNDING_USER_ID } from '@portal/contracts';
import { generateSecretKey, parseSecretKey, SecretBox } from '../store/secretBox.js';
import { MIGRATIONS } from '../store/migrations.js';
import { authorizeParams, CLIENT_ID, fakeIdp, ISSUER } from './fakeIdp.js';
import { PasswordHasher, TEST_PARAMS } from './passwords.js';
import { SsoError, SsoProviders } from './sso.js';
import { PortalTeams } from './teams.js';
import { memoryDb } from './testkit.js';
import { PortalUsers } from './users.js';

const REDIRECT = 'https://pilot.example.com/api/auth/sso/callback';
const GOOD = ['correct', 'horse', 'battery', 'staple', 'pilot'].join('-');

/** A database at every migration before `below`, so a test can write rows as an older portal did, then run the rest. */
function dbBefore(below: number): { db: DatabaseSync; rest: () => void } {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  const sorted = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  for (const m of sorted.filter((x) => x.version < below)) m.up(db);
  return { db, rest: () => sorted.filter((x) => x.version >= below).forEach((m) => m.up(db)) };
}
const addUser = (db: DatabaseSync, id: string, o: { role?: string; by?: string; at: string; changed?: string }) =>
  db
    .prepare('INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `${id}@example.com`, `${id}@example.com`, id, o.role ?? 'admin', 'active', 'x', o.changed ?? o.at, o.at, o.by ?? 'ui');

test('migration 460: the earliest admin made in the portal is the founder (one only); SSO-made accounts have no password of their own', () => {
  const { db, rest } = dbBefore(460);
  addUser(db, 'u_sso1', { by: 'sso:sso_x', at: '2026-10-17T01:00:00.000Z' }); // first, but made by a provider
  addUser(db, 'u_memb', { role: 'member', at: '2026-10-17T02:00:00.000Z' });
  addUser(db, 'u_Fnd3r', { at: '2026-10-17T03:00:00.000Z' });
  addUser(db, 'u_admin2', { at: '2026-10-18T00:00:00.000Z' });
  addUser(db, 'u_sso2', { by: 'sso:sso_x', at: '2026-10-19T00:00:00.000Z', changed: '2026-10-20T00:00:00.000Z' }); // an admin set a password
  rest();
  const rows = db.prepare('SELECT id, founder, password_set FROM users ORDER BY id').all() as { id: string; founder: number; password_set: number }[];
  assert.deepEqual(
    Object.fromEntries(rows.map((r) => [r.id, [r.founder, r.password_set]])),
    { u_Fnd3r: [1, 1], u_admin2: [0, 1], u_memb: [0, 1], u_sso1: [0, 0], u_sso2: [0, 1] },
  );
  assert.throws(() => db.prepare('UPDATE users SET founder = 1 WHERE id = ?').run('u_admin2'), /UNIQUE/, 'one founder at most');
  const users = new PortalUsers(() => db);
  assert.equal(users.principalOf('u_Fnd3r'), FOUNDING_USER_ID);
  assert.equal(users.principalOf('u_admin2'), 'u_admin2', 'every other admin is itself');
  db.prepare("UPDATE users SET role = 'member' WHERE id = 'u_Fnd3r'").run();
  assert.equal(users.principalOf('u_Fnd3r'), 'u_Fnd3r', 'the founder mark counts only while it is an active admin');
});

test('migration 460 with no account at all marks nobody (the server code stays the founding user)', () => {
  const { db, rest } = dbBefore(460);
  rest();
  assert.equal((db.prepare('SELECT count(*) AS n FROM users WHERE founder = 1').get() as { n: number }).n, 0);
});

test('migration 461: every existing Portal MCP token is the founding user’s; a reporter token with no user id is backfilled', () => {
  const { db, rest } = dbBefore(461);
  const at = new Date().toISOString();
  db.prepare("INSERT INTO pmcp_tokens (id, label, token_hash, last4, scope, created_at, expires_at) VALUES ('ptk_old', 'old', 'h1', 'abcd', 'admin', ?, ?)").run(at, at);
  rest(); // a new database: reporter_tokens comes later (900) and there was nothing to backfill
  assert.equal((db.prepare("SELECT owner_id FROM pmcp_tokens WHERE id = 'ptk_old'").get() as { owner_id: string }).owner_id, FOUNDING_USER_ID);

  // An existing portal whose reporter tables were made before 461 ran (900 runs before 461 there).
  const old = new DatabaseSync(':memory:');
  const sorted = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  for (const m of sorted.filter((x) => x.version !== 461)) m.up(old);
  const ins = old.prepare('INSERT INTO reporter_tokens (id, token_hash, bucket_key, origin, actor_user, actor_label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run('rpt_ui', 'h1', 'B', 'https://a.example', 'ui', 'Owner', at, at);
  ins.run('rpt_ok', 'h2', 'B', 'https://a.example', 'u_Someone_1', 'Someone', at, at);
  sorted.find((x) => x.version === 461)!.up(old);
  const owners = Object.fromEntries((old.prepare('SELECT id, actor_user FROM reporter_tokens').all() as { id: string; actor_user: string }[]).map((r) => [r.id, r.actor_user]));
  assert.deepEqual(owners, { rpt_ui: FOUNDING_USER_ID, rpt_ok: 'u_Someone_1' });
});

function sso(defaultRole: 'admin' | 'member') {
  const db = memoryDb();
  const idp = fakeIdp();
  const box = new SecretBox(parseSecretKey(generateSecretKey()));
  const users = new PortalUsers(() => db, new PasswordHasher(TEST_PARAMS));
  const teams = new PortalTeams(() => db);
  const providers = new SsoProviders(() => db, () => db, () => box, users, teams, idp.client);
  const p = providers.create(
    { name: 'IdP', issuer: ISSUER, clientId: CLIENT_ID, clientSecret: null, domains: ['example.com'], defaultRole, acknowledgeAdminAutoCreate: true } as never,
    'ui',
    REDIRECT,
  );
  const signIn = async (claims: Record<string, unknown>) => {
    const { url, binding } = await providers.begin(p.id, String(claims.email), REDIRECT);
    idp.next = { nonce: authorizeParams(url).nonce, ...claims };
    return providers.finish({ code: 'the-code', state: authorizeParams(url).state }, binding);
  };
  const code = async (p2: Promise<unknown>) => p2.then(() => 'ok', (e) => (e instanceof SsoError ? `sso:${e.code}` : String(e)));
  return { db, users, providers, p, signIn, code };
}

test('an SSO provider that makes admins makes each one as themselves: their own id, the admin role, never the founder', async () => {
  const { users, signIn } = sso('admin');
  const a = await signIn({ sub: 'sub-a', email: 'ana@example.com' });
  const b = await signIn({ sub: 'sub-b', email: 'bob@example.com' });
  assert.deepEqual([a.created, a.user.role, b.created, b.user.role], [true, 'admin', true, 'admin']);
  assert.notEqual(a.user.id, b.user.id);
  for (const u of [a.user, b.user]) {
    assert.notEqual(u.id, FOUNDING_USER_ID);
    assert.equal(users.principalOf(u.id), u.id, 'a provider never makes the founder');
  }
});

test('an email match never links an account with a password, an admin, the founder, or one another SSO identity holds', async () => {
  const { db, users, signIn, code } = sso('member');
  const withPassword = await users.create({ email: 'pw@example.com', password: GOOD, role: 'member' }, 'ui');
  const admin = await users.createExternal('boss@example.com', 'Boss', 'admin', 'sso:sso_other');
  const founder = await users.createExternal('founder@example.com', 'F', 'member', 'sso:sso_other');
  db.prepare('UPDATE users SET founder = 1 WHERE id = ?').run(founder.id);
  const held = await users.createExternal('held@example.com', 'Held', 'member', 'sso:sso_other');
  db.prepare("INSERT INTO sso_providers (id, name, issuer, client_id, domains, created_by, created_at, updated_at) VALUES ('sso_other', 'o', 'https://o.example', 'c', '[]', 'ui', 'x', 'x')").run();
  db.prepare("INSERT INTO sso_identities (provider_id, subject, user_id, email, linked_at) VALUES ('sso_other', 'other-sub', ?, 'held@example.com', 'x')").run(held.id);
  for (const [u, email] of [[withPassword, 'pw@example.com'], [admin, 'boss@example.com'], [founder, 'founder@example.com'], [held, 'held@example.com']] as const) {
    assert.equal(await code(signIn({ sub: `new-${email}`, email })), 'sso:no_account', email);
    assert.equal(users.linkableByEmail(u.id), false, email);
  }
  assert.equal((db.prepare('SELECT count(*) AS n FROM sso_identities').get() as { n: number }).n, 1, 'no new link was made');
  assert.equal(users.list().length, 4, 'and no duplicate account');
  // An admin setting a password makes an SSO-made account unlinkable by email too.
  const plain = await users.createExternal('plain@example.com', 'P', 'member', 'sso:sso_other');
  assert.equal(users.linkableByEmail(plain.id), true);
  await users.update(plain.id, { password: GOOD });
  assert.equal(users.linkableByEmail(plain.id), false);
});
