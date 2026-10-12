// P5: the DDL of the multi-user data model, run in node:sqlite on top of the REAL current migrations (apps/server/src/store/migrations.ts), with the
// invariants the PRDs rely on exercised (last admin, a team's last owner, append-only audit, one pending invite, the level query, the retrofit ALTERs and
// the root_id backfill). Run: cd /workspaces/claudepilot/apps/server && NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx <this file>
// The strings below ARE the SQL quoted in docs/prd/{identity-onboarding,authorization,sharing,teams}.md; change them together.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '/workspaces/claudepilot/apps/server/src/store/migrations.ts';

export const IDENTITY_DDL = `
CREATE TABLE users (
  id TEXT PRIMARY KEY CHECK (id GLOB 'u_*'),
  username TEXT NOT NULL CHECK (length(username) BETWEEN 3 AND 32),
  username_key TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  state TEXT NOT NULL CHECK (state IN ('active', 'pending', 'disabled')),
  password_hash TEXT NOT NULL,
  password_changed_at TEXT NOT NULL,
  avatar_sha256 TEXT,
  token_epoch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  last_login_at TEXT,
  disabled_at TEXT,
  disabled_by TEXT,
  disabled_reason TEXT
) STRICT;
CREATE UNIQUE INDEX users_username_key ON users (username_key);
CREATE INDEX users_state ON users (state, role);

-- The last active admin can be neither demoted, disabled nor deleted (M5).
CREATE TRIGGER users_keep_admin_update BEFORE UPDATE OF role, state ON users
WHEN OLD.role = 'admin' AND OLD.state = 'active' AND (NEW.role <> 'admin' OR NEW.state <> 'active')
  AND (SELECT count(*) FROM users WHERE role = 'admin' AND state = 'active' AND id <> OLD.id) = 0
BEGIN SELECT RAISE(ABORT, 'LAST_ADMIN'); END;
CREATE TRIGGER users_keep_admin_delete BEFORE DELETE ON users
WHEN OLD.role = 'admin' AND OLD.state = 'active'
  AND (SELECT count(*) FROM users WHERE role = 'admin' AND state = 'active' AND id <> OLD.id) = 0
BEGIN SELECT RAISE(ABORT, 'LAST_ADMIN'); END;

-- A sign-in on a device. id is shown in the device list; the cookie carries a 256-bit token of which only the SHA-256 is kept.
CREATE TABLE login_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  kept INTEGER NOT NULL DEFAULT 0 CHECK (kept IN (0, 1)),
  reauth_at TEXT,
  ip TEXT,
  user_agent TEXT,
  device TEXT,
  client TEXT,
  token_epoch INTEGER NOT NULL
) STRICT;
CREATE INDEX login_sessions_user ON login_sessions (user_id);
CREATE INDEX login_sessions_expiry ON login_sessions (expires_at);

-- Attempt counters that survive a restart: per username, per address, and for the other throttled doors (registration, invitations, lookups, shares).
CREATE TABLE auth_throttle (
  scope TEXT NOT NULL CHECK (scope IN ('user', 'ip', 'register', 'invitation', 'reauth', 'lookup', 'share', 'team_invite')),
  key TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  window_start_ms INTEGER NOT NULL,
  locked_until_ms INTEGER NOT NULL DEFAULT 0,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
) STRICT;

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'invite' CHECK (kind IN ('invite', 'reset')),
  user_id TEXT,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  username_key TEXT,
  note TEXT,
  used_at TEXT,
  used_by TEXT,
  revoked_at TEXT
) STRICT;
CREATE INDEX invitations_state ON invitations (used_at, revoked_at, expires_at);

-- One row: the admin's choices, readable before anyone signs in.
CREATE TABLE identity_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  registration TEXT NOT NULL DEFAULT 'invitation' CHECK (registration IN ('closed', 'invitation', 'open')),
  members_may_invite INTEGER NOT NULL DEFAULT 0 CHECK (members_may_invite IN (0, 1)),
  invitation_ttl_days INTEGER NOT NULL DEFAULT 7 CHECK (invitation_ttl_days BETWEEN 1 AND 30),
  sign_in_enabled INTEGER NOT NULL DEFAULT 1 CHECK (sign_in_enabled IN (0, 1)),
  sharing_acceptance TEXT NOT NULL DEFAULT 'operate' CHECK (sharing_acceptance IN ('always', 'operate', 'never')),
  updated_at TEXT NOT NULL
) STRICT;

`;

/** The platform audit is the table the platform track made (migration 200). Identity adds what a security row needs; security rows are protected for a year. */
export const AUDIT_ALTER = `
ALTER TABLE platform_audit ADD COLUMN outcome TEXT NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'denied', 'failed'));
ALTER TABLE platform_audit ADD COLUMN ip TEXT;
ALTER TABLE platform_audit ADD COLUMN protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0, 1));
CREATE INDEX platform_audit_object ON platform_audit (subject, id);
-- No row is ever rewritten.
CREATE TRIGGER platform_audit_no_update BEFORE UPDATE ON platform_audit BEGIN SELECT RAISE(ABORT, 'audit rows are append-only'); END;
-- A protected (security) row younger than a year is never deleted: the statement skips it, so the platform track's own 90-day prune of its rows is unaffected.
CREATE TRIGGER platform_audit_keep BEFORE DELETE ON platform_audit
WHEN OLD.protected = 1 AND OLD.at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days')
BEGIN SELECT RAISE(IGNORE); END;
`;

export const AUTHZ_DDL = `
-- Who owns a workspace. A workspace lives in a runtime, not in the database, so ownership is a row of its own; no row = unowned = denied.
CREATE TABLE workspace_owners (
  workspace_id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,                       -- fresh at every creation: a name reused later is a different workspace, and grants made for the old one are void
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user', 'team')),
  owner_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('created', 'claimed', 'migrated'))
) STRICT;
CREATE INDEX workspace_owners_owner ON workspace_owners (owner_kind, owner_id);

-- A share is one consented act; its grants are made when the person accepts (or at once for a team) and removed when it ends.
CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_pool_type TEXT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user', 'team')),
  subject_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('view', 'operate', 'manage')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'declined', 'revoked', 'expired')),
  items TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  expires_at TEXT,
  ended_at TEXT,
  ended_by TEXT,
  ended_note TEXT
) STRICT;
CREATE INDEX shares_subject ON shares (subject_kind, subject_id, state);
CREATE INDEX shares_target ON shares (target_type, target_id, state);

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_uid TEXT,                         -- for a workspace: workspace_owners.uid at the time; a grant with another uid is ignored
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user', 'team')),
  subject_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('view', 'operate', 'manage')),
  share_id TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;
CREATE UNIQUE INDEX grants_unique ON grants (object_type, object_id, subject_kind, subject_id, share_id);
CREATE INDEX grants_object ON grants (object_type, object_id);
CREATE INDEX grants_subject ON grants (subject_kind, subject_id);
CREATE INDEX grants_share ON grants (share_id);

-- Who made a terminal (tmux sessions have no row of their own). Private to the creator in the UI; not a boundary: operate is a shell.
CREATE TABLE terminal_owners (
  workspace_id TEXT NOT NULL,
  workspace_uid TEXT NOT NULL,
  term_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, term_id)
) STRICT;
`;

export const TEAMS_DDL = `
CREATE TABLE teams (
  id TEXT PRIMARY KEY CHECK (id GLOB 'tm_*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  description TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
) STRICT;
CREATE TABLE team_members (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
) STRICT;
CREATE INDEX team_members_user ON team_members (user_id);

-- A team always keeps an owner. (To delete a team, delete the teams row first, then its members.)
CREATE TRIGGER team_members_keep_owner_delete BEFORE DELETE ON team_members
WHEN OLD.role = 'owner' AND EXISTS (SELECT 1 FROM teams WHERE id = OLD.team_id)
  AND (SELECT count(*) FROM team_members WHERE team_id = OLD.team_id AND role = 'owner' AND user_id <> OLD.user_id) = 0
BEGIN SELECT RAISE(ABORT, 'TEAM_NEEDS_OWNER'); END;
CREATE TRIGGER team_members_keep_owner_update BEFORE UPDATE OF role ON team_members
WHEN OLD.role = 'owner' AND NEW.role <> 'owner'
  AND (SELECT count(*) FROM team_members WHERE team_id = OLD.team_id AND role = 'owner' AND user_id <> OLD.user_id) = 0
BEGIN SELECT RAISE(ABORT, 'TEAM_NEEDS_OWNER'); END;

CREATE TABLE team_invites (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  invited_user TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT
) STRICT;
CREATE UNIQUE INDEX team_invites_one_pending ON team_invites (team_id, invited_user) WHERE state = 'pending';
CREATE INDEX team_invites_user ON team_invites (invited_user, state);
`;

/** The retrofit: an owner on what exists, the creator of a session for usage, and the cutover. Everything that exists becomes the founding user's FOR ACCESS. */
export const RETROFIT_SQL = `
ALTER TABLE chat_sessions ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'u_owner';
ALTER TABLE chat_sessions ADD COLUMN created_by_user TEXT;
ALTER TABLE chat_sessions ADD COLUMN root_id TEXT;
ALTER TABLE chat_usage ADD COLUMN user_id TEXT;
ALTER TABLE chat_requests ADD COLUMN decided_by_user TEXT;
ALTER TABLE chat_requests ADD COLUMN decided_via TEXT;
ALTER TABLE workspace_claudes ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'u_owner';
ALTER TABLE tickets ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'user';
ALTER TABLE tickets ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'u_owner';
ALTER TABLE pools ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'user';
ALTER TABLE pools ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'u_owner';
ALTER TABLE accounts ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'user';
ALTER TABLE accounts ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'u_owner';
ALTER TABLE endpoints ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'user';
ALTER TABLE endpoints ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'u_owner';
ALTER TABLE kg_vaults ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'user';
ALTER TABLE kg_vaults ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'u_owner';
ALTER TABLE pmcp_tokens ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'u_owner';
ALTER TABLE pmcp_tokens ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pmcp_agent_tokens ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pmcp_audit ADD COLUMN actor_user TEXT;
-- A session's root: the session at the top of its parent_id chain (itself when it has no parent). Computed once; new sessions copy their parent's.
UPDATE chat_sessions SET root_id = id WHERE parent_id IS NULL;
WITH RECURSIVE chain(id, root) AS (
  SELECT id, id FROM chat_sessions WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, chain.root FROM chat_sessions c JOIN chain ON c.parent_id = chain.id
)
UPDATE chat_sessions SET root_id = (SELECT root FROM chain WHERE chain.id = chat_sessions.id) WHERE root_id IS NULL;
UPDATE chat_sessions SET root_id = id WHERE root_id IS NULL;
INSERT INTO portal_meta (key, value) VALUES ('multi_user_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT (key) DO NOTHING;
`;

/** The level of one user on one object, from ownership, grants and teams (3 manage, 2 operate, 1 view, NULL none). ?1 user, ?2 object type, ?3 object id, ?4 now (ISO), ?5 owner kind, ?6 owner id, ?7 the object's uid (workspaces; NULL for the others). */
export const LEVEL_SQL = `
SELECT max(rank) AS rank FROM (
  SELECT 3 AS rank WHERE ?5 = 'user' AND ?6 = ?1
  UNION ALL
  SELECT CASE m.role WHEN 'owner' THEN 3 ELSE 2 END FROM team_members m WHERE ?5 = 'team' AND m.team_id = ?6 AND m.user_id = ?1
  UNION ALL
  SELECT CASE g.level WHEN 'manage' THEN 3 WHEN 'operate' THEN 2 ELSE 1 END FROM grants g
    WHERE g.object_type = ?2 AND g.object_id = ?3 AND g.subject_kind = 'user' AND g.subject_id = ?1 AND (g.expires_at IS NULL OR g.expires_at > ?4)
      AND (g.object_uid IS NULL OR g.object_uid = ?7)
  UNION ALL
  SELECT CASE g.level WHEN 'manage' THEN 3 WHEN 'operate' THEN 2 ELSE 1 END FROM grants g JOIN team_members m ON g.subject_kind = 'team' AND g.subject_id = m.team_id AND m.user_id = ?1
    WHERE g.object_type = ?2 AND g.object_id = ?3 AND (g.expires_at IS NULL OR g.expires_at > ?4)
      AND (g.object_uid IS NULL OR g.object_uid = ?7)
)`;

function aborts(db: DatabaseSync, sql: string, message: string) {
  assert.throws(() => db.exec(sql), (e: Error) => e.message.includes(message), `expected "${message}" from: ${sql.slice(0, 80)}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const db = new DatabaseSync(':memory:');
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    db.exec('BEGIN');
    m.up(db);
    db.exec('COMMIT');
  }
  // Seed a legacy database: sessions with a parent chain, a usage row, a request, a ticket, a pool.
  db.exec(`
    INSERT INTO chat_sessions (id, workspace_id, state_since, created_at, last_activity_at, parent_id) VALUES
      ('S1','docker/api','t','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z',NULL),
      ('S2','docker/api','t','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z','S1'),
      ('S3','docker/api','t','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z','S2'),
      ('S4','docker/web','t','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z',NULL);
    INSERT INTO pools (id, type, name, description, current_revision, created_at, updated_at) VALUES ('P1','secrets','keys','',1,'t','t');
  `);
  const before = (db.prepare('SELECT count(*) AS n FROM chat_sessions').get() as { n: number }).n;
  db.exec('BEGIN');
  db.exec(IDENTITY_DDL);
  db.exec(AUDIT_ALTER);
  db.exec(AUTHZ_DDL);
  db.exec(TEAMS_DDL);
  db.exec(RETROFIT_SQL);
  db.exec('COMMIT');

  // The retrofit gave everything that exists to u_owner for access and left the creator unknown.
  const s = db.prepare('SELECT id, owner_id, created_by_user, root_id FROM chat_sessions ORDER BY id').all() as Record<string, string | null>[];
  assert.equal(s.length, before);
  assert.deepEqual(s.map((r) => [r.id, r.owner_id, r.created_by_user, r.root_id]), [['S1', 'u_owner', null, 'S1'], ['S2', 'u_owner', null, 'S1'], ['S3', 'u_owner', null, 'S1'], ['S4', 'u_owner', null, 'S4']]);
  assert.equal((db.prepare("SELECT owner_id FROM pools WHERE id = 'P1'").get() as { owner_id: string }).owner_id, 'u_owner');
  assert.ok((db.prepare("SELECT value FROM portal_meta WHERE key = 'multi_user_since'").get() as { value: string }).value.endsWith('Z'));

  // Users: the last active admin is protected.
  const user = (id: string, role: string, state = 'active') =>
    db.prepare("INSERT INTO users (id, username, username_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, 'h', 't', 't', 'setup')").run(id, id.slice(2), id.slice(2), id, role, state);
  user('u_owner', 'admin');
  aborts(db, "UPDATE users SET state = 'disabled' WHERE id = 'u_owner'", 'LAST_ADMIN');
  aborts(db, "UPDATE users SET role = 'member' WHERE id = 'u_owner'", 'LAST_ADMIN');
  aborts(db, "DELETE FROM users WHERE id = 'u_owner'", 'LAST_ADMIN');
  user('u_bob', 'member');
  user('u_pending', 'member', 'pending');
  db.exec("UPDATE users SET state = 'disabled' WHERE id = 'u_bob'"); // a member may be disabled
  user('u_ann', 'admin');
  db.exec("UPDATE users SET role = 'member' WHERE id = 'u_owner'"); // with a second admin the first may step down
  aborts(db, "UPDATE users SET state = 'disabled' WHERE id = 'u_ann'", 'LAST_ADMIN');
  assert.throws(() => user('u_dup', 'member') && db.prepare("INSERT INTO users (id, username, username_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES ('u_dup2','dup','dup','x','member','active','h','t','t','x')").run(), /UNIQUE/, 'one username, case-folded');
  assert.throws(() => db.exec("INSERT INTO users (id, username, username_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES ('x1','abc','abc','x','member','active','h','t','t','x')"), /CHECK/, 'ids start with u_');
  db.exec("UPDATE users SET role = 'admin' WHERE id = 'u_owner'");

  // Teams: never without an owner; a team is deleted by removing the team row first.
  db.exec("INSERT INTO teams (id, name, created_at, created_by) VALUES ('tm_alpha1', 'Alpha', 't', 'u_owner')");
  db.exec("INSERT INTO team_members VALUES ('tm_alpha1','u_owner','owner','t'), ('tm_alpha1','u_ann','member','t')");
  aborts(db, "DELETE FROM team_members WHERE team_id='tm_alpha1' AND user_id='u_owner'", 'TEAM_NEEDS_OWNER');
  aborts(db, "UPDATE team_members SET role='member' WHERE team_id='tm_alpha1' AND user_id='u_owner'", 'TEAM_NEEDS_OWNER');
  db.exec("UPDATE team_members SET role='owner' WHERE team_id='tm_alpha1' AND user_id='u_ann'");
  db.exec("DELETE FROM team_members WHERE team_id='tm_alpha1' AND user_id='u_owner'"); // another owner exists now
  aborts(db, "DELETE FROM team_members WHERE team_id='tm_alpha1' AND user_id='u_ann'", 'TEAM_NEEDS_OWNER');
  db.exec("DELETE FROM teams WHERE id='tm_alpha1'");
  db.exec("DELETE FROM team_members WHERE team_id='tm_alpha1'");
  assert.equal((db.prepare('SELECT count(*) AS n FROM team_members').get() as { n: number }).n, 0, 'team deleted with its members');

  // One pending invitation per team and person; a decided one frees the slot.
  db.exec("INSERT INTO teams (id, name, created_at, created_by) VALUES ('tm_beta11', 'Beta', 't', 'u_owner')");
  const invite = (id: string) => db.prepare("INSERT INTO team_invites (id, team_id, invited_user, invited_by, role, state, created_at, expires_at) VALUES (?, 'tm_beta11', 'u_bob', 'u_owner', 'member', 'pending', 't', 't2')").run(id);
  invite('i1');
  assert.throws(() => invite('i2'), /UNIQUE/);
  db.exec("UPDATE team_invites SET state='declined' WHERE id='i1'");
  invite('i3');

  // The platform audit (migration 200's table, extended): rows are never rewritten, a protected row younger than a year survives a DELETE
  // (the statement skips it), an old one can be pruned, and the platform track's own rows are pruned as they always were.
  const row = (at: string, kind: string, protectedRow: number) =>
    db.prepare("INSERT INTO platform_audit (at, severity, kind, actor, user_id, detail, protected, outcome) VALUES (?, 'info', ?, 'user:u_owner', 'u_owner', '{}', ?, 'ok')").run(at, kind, protectedRow);
  const now = new Date().toISOString();
  const old = '2024-01-01T00:00:00.000Z';
  row(now, 'auth.login', 1);
  row(old, 'auth.login', 1);
  row(old, 'notify.channel', 0);
  row(now, 'notify.channel', 0);
  aborts(db, "UPDATE platform_audit SET kind = 'x' WHERE id = 1", 'append-only');
  const removed = Number(db.prepare("DELETE FROM platform_audit WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')").run().changes);
  assert.equal(removed, 2, 'the platform track prune still removes its old row, and a protected row older than a year too');
  const left = db.prepare('SELECT kind, protected FROM platform_audit ORDER BY id').all() as { kind: string; protected: number }[];
  assert.deepEqual(left.map((r) => r.kind), ['auth.login', 'notify.channel'], 'the recent protected row and the recent platform row remain');
  assert.equal(Number(db.prepare("DELETE FROM platform_audit WHERE kind = 'auth.login'").run().changes), 0, 'a recent protected row cannot be deleted (skipped, no error)');
  assert.equal(Number(db.prepare("DELETE FROM platform_audit WHERE kind = 'notify.channel'").run().changes), 1, 'an unprotected row can');

  // The level query: owner, team owner/member of an owning team, direct grant, team grant, expiry.
  db.exec("INSERT INTO teams (id, name, created_at, created_by) VALUES ('tm_gamma1','Gamma','t','u_owner')");
  db.exec("INSERT INTO team_members VALUES ('tm_gamma1','u_owner','owner','t'),('tm_gamma1','u_ann','member','t'),('tm_beta11','u_owner','owner','t')");
  const grant = (id: string, subjectKind: string, subject: string, level: string, share: string, expires: string | null = null) =>
    db.prepare("INSERT INTO grants (id, object_type, object_id, object_uid, subject_kind, subject_id, level, share_id, granted_by, created_at, expires_at) VALUES (?, 'workspace', 'docker/api', 'uid-1', ?, ?, ?, ?, 'u_owner', 't', ?)").run(id, subjectKind, subject, level, share, expires);
  const level = (u: string, ownerKind: string, ownerId: string, now = '2026-10-12T00:00:00.000Z', uid: string | null = 'uid-1') =>
    (db.prepare(`${LEVEL_SQL}`).get(u, 'workspace', 'docker/api', now, ownerKind, ownerId, uid) as { rank: number | null }).rank;
  assert.equal(level('u_owner', 'user', 'u_owner'), 3, 'the owner');
  assert.equal(level('u_bob', 'user', 'u_owner'), null, 'nobody else: no right at all');
  assert.equal(level('u_owner', 'team', 'tm_gamma1'), 3, 'a team owner manages what the team owns');
  assert.equal(level('u_ann', 'team', 'tm_gamma1'), 2, 'a team member operates what the team owns');
  assert.equal(level('u_bob', 'team', 'tm_gamma1'), null);
  grant('g1', 'user', 'u_bob', 'view', 'sh1');
  assert.equal(level('u_bob', 'user', 'u_owner'), 1);
  grant('g2', 'team', 'tm_gamma1', 'operate', 'sh2');
  assert.equal(level('u_ann', 'user', 'u_owner'), 2, 'a team grant reaches a member');
  grant('g3', 'user', 'u_bob', 'manage', 'sh3', '2026-10-11T00:00:00.000Z');
  assert.equal(level('u_bob', 'user', 'u_owner', '2026-10-12T00:00:00.000Z'), 1, 'an expired grant counts for nothing');
  assert.equal(level('u_bob', 'user', 'u_owner', '2026-10-10T00:00:00.000Z'), 3, 'and counts before it expires');
  db.exec("DELETE FROM team_members WHERE team_id='tm_gamma1' AND user_id='u_ann'");
  assert.equal(level('u_ann', 'user', 'u_owner'), null, 'leaving the team ends what it gave, at once');
  db.exec("DELETE FROM grants WHERE share_id='sh1'");
  assert.equal(level('u_bob', 'user', 'u_owner', '2026-10-12T00:00:00.000Z'), null, 'revoking a share removes exactly its grants');
  assert.throws(() => grant('g1b', 'user', 'u_bob', 'view', 'sh3'), /UNIQUE/, 'one grant per share, subject and object');

  // A workspace name reused after the old one went away is a NEW workspace (new uid): grants made for the old one are void, even if nothing cleaned them up.
  grant('g9', 'user', 'u_bob', 'manage', 'sh9');
  assert.equal(level('u_bob', 'user', 'u_owner', '2026-10-10T00:00:00.000Z', 'uid-1'), 3, 'a grant counts for the workspace it was made for');
  assert.equal(level('u_bob', 'user', 'u_owner', '2026-10-10T00:00:00.000Z', 'uid-2'), null, 'and for no other workspace that later got the same name');

  console.log('schema ok: identity, authz, teams DDL and retrofit ran on schema', MIGRATIONS.length, 'migrations; every invariant held');
}
