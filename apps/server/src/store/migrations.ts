import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

/** A column holding sealed values (SecretBox envelopes), keyed by `idColumn` for the slot's row. */
export interface EncryptedColumn {
  table: string;
  column: string;
  idColumn: string;
}

/**
 * Schema history, oldest first. Each runs once, in its own transaction, and bumps `user_version`.
 * Never edit a released migration; add a new one.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'portal meta',
    up(db) {
      db.exec(`CREATE TABLE portal_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`);
    },
  },
  {
    version: 2,
    name: 'accounts and endpoints',
    up(db) {
      db.exec(`
        CREATE TABLE endpoints (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('anthropic', 'custom')),
          name TEXT NOT NULL,
          base_url TEXT NOT NULL,
          model_names TEXT NOT NULL DEFAULT '{}',
          context_tokens INTEGER,
          max_output_tokens INTEGER,
          disable_betas INTEGER NOT NULL DEFAULT 0,
          allow_private_network INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX endpoints_name ON endpoints (name COLLATE NOCASE);

        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          endpoint_id TEXT NOT NULL REFERENCES endpoints (id) ON DELETE RESTRICT,
          name TEXT NOT NULL,
          secret TEXT,
          fingerprint TEXT NOT NULL,
          masked TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          notes TEXT NOT NULL DEFAULT '',
          organization_id TEXT,
          anthropic_workspace_id TEXT,
          check_result TEXT NOT NULL DEFAULT 'unknown',
          check_status INTEGER,
          check_detail TEXT,
          checked_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX accounts_name ON accounts (name COLLATE NOCASE);
        CREATE UNIQUE INDEX accounts_fingerprint ON accounts (fingerprint);
        CREATE INDEX accounts_endpoint ON accounts (endpoint_id);

        CREATE TABLE account_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          type TEXT NOT NULL,
          account_id TEXT,
          workspace_id TEXT,
          details TEXT NOT NULL DEFAULT '{}'
        ) STRICT;
        CREATE INDEX account_events_at ON account_events (at);

        INSERT INTO endpoints (id, kind, name, base_url, created_at, updated_at)
        VALUES ('anthropic', 'anthropic', 'Anthropic API', 'https://api.anthropic.com',
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      `);
    },
  },
  {
    version: 3,
    name: 'pools, assignments and delivery',
    up(db) {
      db.exec(`
        -- Foundation PRD §5: one model for every pool type.
        CREATE TABLE pools (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          current_revision INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX pools_type_name ON pools (type, name COLLATE NOCASE);

        CREATE TABLE pool_revisions (
          pool_id TEXT NOT NULL REFERENCES pools (id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          content TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          PRIMARY KEY (pool_id, revision)
        ) STRICT;

        CREATE TABLE assignments (
          workspace_id TEXT NOT NULL,
          pool_id TEXT NOT NULL REFERENCES pools (id) ON DELETE RESTRICT,
          pool_type TEXT NOT NULL,
          pinned_revision INTEGER,
          assigned_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, pool_id)
        ) STRICT;
        CREATE INDEX assignments_pool ON assignments (pool_id);

        -- The only thing that lets the reconciler remove or blank delivered files (§6.5).
        CREATE TABLE removals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL,
          pool_type TEXT NOT NULL,
          pool_id TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          -- 0: requested; 1: safe values written (stage_at), files removed at least a reload later.
          stage INTEGER NOT NULL DEFAULT 0,
          stage_at TEXT
        ) STRICT;
        CREATE INDEX removals_workspace ON removals (workspace_id);

        CREATE TABLE workspace_delivery (
          workspace_id TEXT PRIMARY KEY,
          generation INTEGER NOT NULL DEFAULT 0,
          desired_hash TEXT,
          applied_hash TEXT,
          applied_at TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          reason TEXT,
          claude_version TEXT,
          checked_at TEXT,
          -- Files no longer wanted: [{path, since}], deleted once they've been unreferenced for a reload
          -- interval, or at the next start (they're written empty while the workspace is stopped).
          pending_deletes TEXT NOT NULL DEFAULT '[]',
          -- path → secret_ref of delivered secret files, to mark exposures removed when they go.
          secret_paths TEXT NOT NULL DEFAULT '{}'
        ) STRICT;

        CREATE TABLE delivery_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          details TEXT NOT NULL DEFAULT '{}'
        ) STRICT;
        CREATE INDEX delivery_events_at ON delivery_events (at);
        CREATE INDEX delivery_events_workspace ON delivery_events (workspace_id, at);

        -- Every workspace a secret ever reached, for the portal's lifetime.
        CREATE TABLE exposures (
          secret_ref TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          first_delivered_at TEXT NOT NULL,
          last_delivered_at TEXT NOT NULL,
          removed_at TEXT,
          PRIMARY KEY (secret_ref, workspace_id)
        ) STRICT;

        -- Account Pool: which account each assigned workspace uses now (changes on failover).
        CREATE TABLE account_assignments (
          workspace_id TEXT PRIMARY KEY,
          pool_id TEXT NOT NULL REFERENCES pools (id) ON DELETE CASCADE,
          active_account_id TEXT REFERENCES accounts (id) ON DELETE SET NULL,
          pinned_account_id TEXT REFERENCES accounts (id) ON DELETE SET NULL,
          state TEXT NOT NULL DEFAULT 'active',
          waiting_until TEXT,
          changed_at TEXT NOT NULL,
          reason TEXT
        ) STRICT;
      `);
    },
  },
  {
    version: 4,
    name: 'account health and outbox',
    up(db) {
      db.exec(`
        -- Account Pool §11.3: what failover acts on. cooling and exhausted end at health_until.
        ALTER TABLE accounts ADD COLUMN health TEXT NOT NULL DEFAULT 'ok';
        ALTER TABLE accounts ADD COLUMN health_until TEXT;
        ALTER TABLE accounts ADD COLUMN health_detail TEXT;
        ALTER TABLE accounts ADD COLUMN health_at TEXT;
        -- A 429 with no retry hint backs off 2 s, doubling to 5 min (§11.3).
        ALTER TABLE accounts ADD COLUMN backoff_ms INTEGER;

        -- Foundation §8: outbox event IDs stored in the last 24 hours, so a re-read file counts once.
        CREATE TABLE outbox_seen (
          workspace_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, event_id)
        ) STRICT;
        CREATE INDEX outbox_seen_at ON outbox_seen (at);
      `);
    },
  },
  {
    version: 5,
    name: 'web sessions',
    up(db) {
      db.exec(`
        -- Signed-in browsers, so a restart doesn't sign everyone out. Only a hash of each token is kept.
        CREATE TABLE web_sessions (
          token_hash TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX web_sessions_expires ON web_sessions (expires_at);
      `);
    },
  },
];

/**
 * Every column that holds sealed values. `portal rotate-key` re-seals them and `portal
 * forget-secrets` clears them, so a migration that adds one must list it here.
 */
export const ENCRYPTED_COLUMNS: EncryptedColumn[] = [{ table: 'accounts', column: 'secret', idColumn: 'id' }];
