// The founder mark (owner request 2026-11-01: "replace current super admin user as alfian@isnan.me"): it moves to an active admin account in
// one transaction, the account then acts as `u_owner` (everything the founding user owns follows), what it owned under its own id goes to
// `u_owner` (org memberships merge), and moving it back works. And who can still sign in, for the server code's off switch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import { adminSignInPaths, currentFounder, transferFounder } from './founder.js';
import { PasswordHasher, TEST_PARAMS } from './passwords.js';
import { memoryDb } from './testkit.js';
import { PortalUsers } from './users.js';

const PASSWORD = ['amber', 'lantern', 'meadow', 'quartz', 'river'].join('-');
const AT = '2026-11-01T10:00:00.000Z';

async function setup() {
  const db = memoryDb();
  const users = new PortalUsers(() => db, new PasswordHasher(TEST_PARAMS));
  const old = await users.create({ email: 'first@example.com', password: PASSWORD, role: 'admin' }, 'ui');
  const next = await users.create({ email: 'alfian@example.com', password: PASSWORD, role: 'admin' }, 'ui');
  const member = await users.create({ email: 'mia@example.com', password: PASSWORD, role: 'member' }, 'ui');
  db.prepare('UPDATE users SET founder = 1 WHERE id = ?').run(old.id);
  for (const [id, slug] of [['org_isnan', 'isnan'], ['org_konfersi', 'konfersi']] as const)
    db.prepare('INSERT INTO orgs (id, slug, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, slug, slug, 'ui', AT);
  const member_ = db.prepare("INSERT INTO org_members (org_id, user_id, role, via, added_by, added_at) VALUES (?, ?, ?, 'created', 'ui', ?)");
  member_.run('org_isnan', 'u_owner', 'owner', AT);
  member_.run('org_isnan', next.id, 'member', AT); // both in isnan: the founding user's row stays
  member_.run('org_konfersi', next.id, 'admin', AT); // only the account in konfersi: it becomes the founding user's
  const ws = db.prepare("INSERT INTO workspace_owners (workspace_id, uid, owner_kind, owner_id, created_at, origin) VALUES (?, ?, ?, ?, ?, 'created')");
  ws.run('ws_founders', 'docker/a', 'user', 'u_owner', AT);
  ws.run('ws_alfians', 'docker/b', 'user', next.id, AT);
  ws.run('ws_teams', 'docker/c', 'team', next.id, AT); // not a person's: untouched
  return { db, users, old, next, member };
}

const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof AppError ? e.code : String(e);
  }
};

test('the mark moves to an active admin; it then acts as u_owner and the old founder as itself; its own objects become the founding user’s', async () => {
  const { db, users, old, next } = await setup();
  assert.equal(users.principalOf(old.id), 'u_owner');
  const r = transferFounder(db, next.id, AT);
  assert.deepEqual(r.from, { id: old.id, email: 'first@example.com' });
  assert.deepEqual(r.to, { id: next.id, email: 'alfian@example.com' });
  assert.equal(users.principalOf(next.id), 'u_owner', 'the new founder acts as the founding user');
  assert.equal(users.principalOf(old.id), old.id, 'the old founder acts as itself');
  assert.deepEqual(currentFounder(db), { id: next.id, email: 'alfian@example.com' });
  const owners = db.prepare('SELECT workspace_id, owner_kind, owner_id FROM workspace_owners ORDER BY workspace_id').all() as { workspace_id: string; owner_kind: string; owner_id: string }[];
  assert.deepEqual(
    owners.map((o) => [o.workspace_id, o.owner_kind, o.owner_id]),
    [
      ['ws_alfians', 'user', 'u_owner'],
      ['ws_founders', 'user', 'u_owner'],
      ['ws_teams', 'team', next.id],
    ],
  );
  const members = db.prepare('SELECT org_id, user_id, role FROM org_members ORDER BY org_id').all() as { org_id: string; user_id: string; role: string }[];
  assert.deepEqual(
    members.map((m) => [m.org_id, m.user_id, m.role]),
    [
      ['org_isnan', 'u_owner', 'owner'],
      ['org_konfersi', 'u_owner', 'admin'],
    ],
  );
  assert.equal(r.moved.workspace_owners, 1);
  assert.equal(r.moved.org_members, 2);
  assert.equal((db.prepare('SELECT count(*) AS n FROM users WHERE founder = 1').get() as { n: number }).n, 1, 'one founder');
});

test('a transfer back restores the mark (the founding user keeps what moved to it); nothing else changes', async () => {
  const { db, users, old, next } = await setup();
  transferFounder(db, next.id, AT);
  const back = transferFounder(db, old.id, AT);
  assert.equal(back.from?.id, next.id);
  assert.equal(users.principalOf(old.id), 'u_owner');
  assert.equal(users.principalOf(next.id), next.id);
  assert.deepEqual(back.moved, {}, 'the old founder owned nothing under its own id');
});

test('refused: a member, a disabled admin, the founder already, an unknown account; a refusal changes nothing', async () => {
  const { db, users, old, next, member } = await setup();
  assert.equal(code(() => transferFounder(db, member.id, AT)), 'CONFLICT');
  assert.equal(code(() => transferFounder(db, old.id, AT)), 'CONFLICT');
  assert.equal(code(() => transferFounder(db, 'u_nobody', AT)), 'NOT_FOUND');
  await users.update(next.id, { state: 'disabled' });
  assert.equal(code(() => transferFounder(db, next.id, AT)), 'CONFLICT');
  assert.equal(currentFounder(db)?.id, old.id);
  assert.equal((db.prepare('SELECT owner_id FROM workspace_owners WHERE workspace_id = ?').get('ws_alfians') as { owner_id: string }).owner_id, next.id);
});

test('with nobody marked (only the server code was the founding user) the first transfer marks the account', async () => {
  const { db, users, next } = await setup();
  db.exec('UPDATE users SET founder = 0');
  const r = transferFounder(db, next.id, AT);
  assert.equal(r.from, null);
  assert.equal(users.principalOf(next.id), 'u_owner');
});

test('who can sign in: a password (unless the domain is SSO only), a linked identity at an enabled provider; none for an SSO-made admin with no link', async () => {
  const { db, users, old, next } = await setup();
  const sso = await users.createExternal('sso@example.com', 'Sso', 'admin', 'sso:x');
  db.prepare("INSERT INTO sso_providers (id, name, issuer, client_id, domains, created_by, created_at, updated_at) VALUES ('sso_git', 'git.isnan.me', 'https://git.example', 'c', '[]', 'ui', ?, ?)").run(AT, AT);
  db.prepare('INSERT INTO sso_identities (provider_id, subject, user_id, email, linked_at) VALUES (?, ?, ?, ?, ?)').run('sso_git', '8', next.id, 'alfian@example.com', AT);
  const paths = adminSignInPaths(db, (email) => email === 'first@example.com');
  const of = (id: string) => paths.find((p) => p.id === id)?.methods;
  assert.deepEqual(of(old.id), [], 'its domain signs in by SSO only, and it has no link');
  assert.deepEqual(of(next.id), ['password', 'git.isnan.me']);
  assert.deepEqual(of(sso.id), [], 'no password anyone knows, no link');
  assert.equal(paths.length, 3, 'admins only');
  db.exec("UPDATE sso_providers SET enabled = 0 WHERE id = 'sso_git'");
  assert.deepEqual(adminSignInPaths(db, () => false).find((p) => p.id === next.id)?.methods, ['password'], 'a provider turned off is no way in');
});
