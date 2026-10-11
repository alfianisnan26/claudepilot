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
  {
    version: 6,
    name: 'chat sessions',
    up(db) {
      db.exec(`
        -- Chat sessions PRD §9. Redacted, no secrets.
        CREATE TABLE chat_sessions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          cwd TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          origin TEXT NOT NULL DEFAULT 'ui',
          state TEXT NOT NULL DEFAULT 'starting',
          state_since TEXT NOT NULL,
          process TEXT NOT NULL DEFAULT 'live',
          parent_pid INTEGER,
          process_started_at TEXT,
          segment INTEGER NOT NULL DEFAULT 1,
          byte_offset INTEGER NOT NULL DEFAULT 0,
          last_seq INTEGER NOT NULL DEFAULT 0,
          model TEXT,
          mode TEXT NOT NULL DEFAULT 'default',
          bypass_capable INTEGER NOT NULL DEFAULT 0,
          cost_est_usd REAL NOT NULL DEFAULT 0,
          budget_usd REAL,
          turns INTEGER NOT NULL DEFAULT 0,
          launch TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          ended_reason TEXT,
          archived_at TEXT
        ) STRICT;
        CREATE INDEX chat_sessions_activity ON chat_sessions (last_activity_at);
        CREATE INDEX chat_sessions_workspace ON chat_sessions (workspace_id);

        -- One row per stored transcript event; seq is per session and gap-free.
        CREATE TABLE chat_events (
          session_id TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          at TEXT NOT NULL,
          kind TEXT NOT NULL,
          uuid TEXT,
          parent_tool_use_id TEXT,
          request_id TEXT,
          payload TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY (session_id, seq)
        ) STRICT;

        -- Every line the controller sends, and its lifecycle (integrity checks read this).
        CREATE TABLE chat_inputs (
          session_id TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
          uuid TEXT NOT NULL,
          actor TEXT,
          kind TEXT NOT NULL,
          priority TEXT,
          state TEXT NOT NULL DEFAULT 'sending',
          created_at TEXT NOT NULL,
          PRIMARY KEY (session_id, uuid)
        ) STRICT;

        -- Requests the agent raised (tools, questions, plans) and how they were answered.
        CREATE TABLE chat_requests (
          session_id TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
          request_id TEXT NOT NULL,
          tool_use_id TEXT,
          kind TEXT NOT NULL,
          tool_name TEXT,
          agent_label TEXT,
          title TEXT NOT NULL DEFAULT '',
          detail TEXT,
          created_at TEXT NOT NULL,
          answered_at TEXT,
          outcome TEXT,
          actor TEXT,
          PRIMARY KEY (session_id, request_id)
        ) STRICT;

        -- Sub-agents and background tasks within a session (multi-agent view).
        CREATE TABLE chat_tasks (
          session_id TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
          task_id TEXT NOT NULL,
          parent_task_id TEXT,
          tool_use_id TEXT,
          type TEXT,
          label TEXT,
          background INTEGER NOT NULL DEFAULT 0,
          status TEXT,
          tokens INTEGER,
          tool_uses INTEGER,
          started_at TEXT,
          ended_at TEXT,
          PRIMARY KEY (session_id, task_id)
        ) STRICT;

        -- Attachments, tool images and downloads (blob refs).
        CREATE TABLE chat_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          blob_sha256 TEXT,
          name TEXT,
          workspace_path TEXT,
          size INTEGER,
          media_type TEXT,
          at TEXT NOT NULL
        ) STRICT;

        -- Folders the agent is trusted to run in (FR43).
        CREATE TABLE chat_folder_trust (
          workspace_id TEXT NOT NULL,
          folder TEXT NOT NULL,
          scan_hash TEXT,
          scan TEXT NOT NULL DEFAULT '{}',
          trusted_at TEXT NOT NULL,
          actor TEXT,
          PRIMARY KEY (workspace_id, folder)
        ) STRICT;
      `);
    },
  },
  {
    version: 7,
    name: 'chat controls and tasks',
    up(db) {
      db.exec(`
        -- What applies now (Claude Code's get_settings.applied; never the rest of that response).
        ALTER TABLE chat_sessions ADD COLUMN effort TEXT;
        ALTER TABLE chat_sessions ADD COLUMN ultracode INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE chat_sessions ADD COLUMN ultracode_available INTEGER NOT NULL DEFAULT 0;
        -- Sub-agents: what system/task_* events report.
        ALTER TABLE chat_tasks ADD COLUMN subagent_type TEXT;
        ALTER TABLE chat_tasks ADD COLUMN summary TEXT;
        ALTER TABLE chat_tasks ADD COLUMN duration_ms INTEGER;
        CREATE INDEX chat_files_blob ON chat_files (session_id, blob_sha256);
      `);
    },
  },
  {
    version: 8,
    name: 'chat context usage',
    up(db) {
      db.exec(`
        -- How full the context window was after the last turn (from Claude Code's result line).
        ALTER TABLE chat_sessions ADD COLUMN context_used INTEGER;
        ALTER TABLE chat_sessions ADD COLUMN context_window INTEGER;
      `);
    },
  },
  {
    version: 9,
    name: 'pool revision status and assignment options',
    up(db) {
      db.exec(`
        -- Skillset PRD §18 A3: only deliverable revisions reach workspaces, and pools.current_revision
        -- moves only to one. Revisions so far (account pools) were all delivered, so they stay deliverable.
        ALTER TABLE pool_revisions ADD COLUMN status TEXT NOT NULL DEFAULT 'deliverable'
          CHECK (status IN ('draft', 'waiting_review', 'deliverable'));
        -- A paused rollout (FR23): the revision reaches no more workspaces until resumed.
        ALTER TABLE pool_revisions ADD COLUMN rollout_paused_at TEXT;
        ALTER TABLE pool_revisions ADD COLUMN rollout_paused_reason TEXT;
        -- A4: the pool type's own settings for one workspace (per-skill overrides and the like), as JSON.
        ALTER TABLE assignments ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
        -- The revision the workspace last received, so a paused rollout holds back only the workspaces
        -- it hasn't reached yet.
        ALTER TABLE assignments ADD COLUMN delivered_revision INTEGER;
      `);
    },
  },
  {
    version: 10,
    name: 'secret values',
    up(db) {
      db.exec(`
        -- Secrets & env PRD §9, A8: secret values as immutable, encrypted versions, referenced by ID from
        -- revision content, which never holds ciphertext. A set's values go with it.
        CREATE TABLE secret_values (
          id TEXT PRIMARY KEY,
          pool_id TEXT NOT NULL REFERENCES pools (id) ON DELETE CASCADE,
          entry_id TEXT NOT NULL,
          -- Which of the entry's secret fields: 'value' for a secret; a tool login (S2) has several.
          field TEXT NOT NULL DEFAULT 'value',
          version INTEGER NOT NULL,
          -- Sealed for secret_values|<id>|ciphertext; NULL once portal forget-secrets cleared it.
          ciphertext TEXT,
          -- A11: 8 hex of an HMAC under a key derived from the portal's secret key, and that key's ID.
          fingerprint TEXT NOT NULL,
          fingerprint_key_id TEXT NOT NULL,
          prev_fingerprint TEXT,
          hint TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          detected_type TEXT,
          expires_at TEXT,
          check_status TEXT,
          checked_at TEXT,
          source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'github_app', 'k8s_token')),
          revoked_at TEXT,
          created_at TEXT NOT NULL,
          purge_after TEXT
        ) STRICT;
        CREATE UNIQUE INDEX secret_values_version ON secret_values (pool_id, entry_id, field, version);
      `);
    },
  },
  {
    version: 12,
    name: 'mcp sets: catalog, delivery, installs and verify',
    up(db) {
      db.exec(`
        -- MCP set PRD §9. The catalog: one entry per server, with pinned versions that are reviewed before
        -- any set can use them (FR1–FR5).
        CREATE TABLE mcp_catalog (
          id TEXT PRIMARY KEY,
          -- The server key sets suggest: [a-z0-9-], at most 16 characters (FR5).
          key TEXT NOT NULL,
          display_name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL CHECK (kind IN ('npm', 'pypi', 'remote', 'command')),
          -- The npm or PyPI package, or the command's path. One entry each, so the processes a revocation
          -- stops (found by their launcher target) are only ever that entry's.
          package TEXT,
          -- M3: the MCP Registry name it was imported from.
          registry_name TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX mcp_catalog_key ON mcp_catalog (key);
        CREATE UNIQUE INDEX mcp_catalog_package ON mcp_catalog (kind, package) WHERE package IS NOT NULL;

        -- Approved versions never change (FR4); a change is a new draft. Spec and slots are JSON.
        CREATE TABLE mcp_catalog_versions (
          id TEXT PRIMARY KEY,
          entry_id TEXT NOT NULL REFERENCES mcp_catalog (id) ON DELETE CASCADE,
          version TEXT NOT NULL,
          spec TEXT NOT NULL,
          slots TEXT NOT NULL DEFAULT '[]',
          review_state TEXT NOT NULL DEFAULT 'draft' CHECK (review_state IN ('draft', 'approved', 'deprecated', 'revoked')),
          reviewed_at TEXT,
          reviewed_by TEXT,
          review_note TEXT,
          revoked_at TEXT,
          revoke_reason TEXT,
          -- M2 and M3: the registry's status for it, and its tool snapshot and hash (FR18).
          registry_status TEXT,
          tools TEXT,
          tools_hash TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX mcp_catalog_versions_entry ON mcp_catalog_versions (entry_id, version);

        -- What the last compile did with each server of each set in each workspace (FR14, FR17).
        CREATE TABLE mcp_delivery (
          workspace_id TEXT NOT NULL,
          pool_id TEXT NOT NULL,
          server_key TEXT NOT NULL,
          -- cpm-<slug>: deny rules for a revoked server outlive its set's next revision.
          plugin TEXT NOT NULL,
          version_id TEXT,
          -- The launcher target, or the URL.
          target TEXT,
          state TEXT NOT NULL,
          reason TEXT,
          -- M2: why a delivered server is absent in the workspace, and the user's server hiding it (name only).
          absent_cause TEXT,
          matching_server TEXT,
          observed_at TEXT,
          -- FR13b: when a revocation took it out here (its tools stay denied 14 days), and when its
          -- processes were stopped.
          revoked_at TEXT,
          killed_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, pool_id, server_key)
        ) STRICT;
        CREATE INDEX mcp_delivery_version ON mcp_delivery (version_id);

        -- Pre-installed packages (§12): once per version per workspace, kept in the home volume.
        CREATE TABLE mcp_installs (
          workspace_id TEXT NOT NULL,
          -- npm:<package>@<version>
          package_ref TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('installing', 'installed', 'failed')),
          installed_at TEXT,
          last_used_at TEXT,
          -- Redacted, capped.
          error TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, package_ref)
        ) STRICT;

        -- FR16: the last \`claude plugin details\` of each set's plugin in each workspace.
        CREATE TABLE mcp_verify (
          workspace_id TEXT NOT NULL,
          plugin TEXT NOT NULL,
          -- The version folder verified.
          hash12 TEXT NOT NULL,
          result TEXT NOT NULL,
          servers TEXT NOT NULL DEFAULT '[]',
          detail TEXT,
          at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, plugin)
        ) STRICT;

        -- Which catalog versions each plugin version folder holds (FR13b). Folder names are content
        -- hashes, so a revoked version's folders can be named in every workspace that still has them.
        CREATE TABLE mcp_plugin_folders (
          plugin TEXT NOT NULL,
          hash12 TEXT NOT NULL,
          version_ids TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (plugin, hash12)
        ) STRICT;

        -- Catalog changes, approvals, revocations and launcher events (§17): what and when, never values.
        -- Kept 90 days.
        CREATE TABLE mcp_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          type TEXT NOT NULL,
          entry_id TEXT,
          version_id TEXT,
          workspace_id TEXT,
          details TEXT NOT NULL DEFAULT '{}'
        ) STRICT;
        CREATE INDEX mcp_events_at ON mcp_events (at);
        CREATE INDEX mcp_events_workspace ON mcp_events (workspace_id, type, at);
      `);
    },
  },
  {
    version: 11,
    name: 'skillsets: library, reviews, inventory and blobs',
    up(db) {
      db.exec(`
        -- Where skill versions come from. Upload sources hold only a label; git and marketplace sources
        -- (M3, M4) add a URL, ref and the resolved commit. token is sealed (SecretBox) and write-only.
        CREATE TABLE skill_sources (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('upload', 'git', 'anthropic', 'marketplace')),
          label TEXT NOT NULL,
          url TEXT,
          ref TEXT,
          subpath TEXT,
          marketplace_name TEXT,
          plugin_name TEXT,
          token TEXT,
          resolved TEXT,
          checked_at TEXT,
          latest_seen TEXT,
          created_at TEXT NOT NULL,
          removed_at TEXT
        ) STRICT;

        -- Immutable skill versions, identified by their FR6 tree hash. Identical content under the same
        -- name is one version, so it keeps its review.
        CREATE TABLE skill_versions (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES skill_sources (id) ON DELETE RESTRICT,
          name TEXT NOT NULL,
          path_in_source TEXT NOT NULL,
          tree_hash TEXT NOT NULL,
          frontmatter TEXT NOT NULL DEFAULT '{}',
          description TEXT NOT NULL DEFAULT '',
          license TEXT,
          size_bytes INTEGER NOT NULL,
          file_count INTEGER NOT NULL,
          scripted INTEGER NOT NULL DEFAULT 0,
          risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
          findings TEXT NOT NULL DEFAULT '[]',
          listing_chars INTEGER NOT NULL DEFAULT 0,
          -- Converted command, requirements, license files, badges: what the review page shows besides findings.
          details TEXT NOT NULL DEFAULT '{}',
          imported_at TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX skill_versions_hash_name ON skill_versions (tree_hash, name);
        CREATE INDEX skill_versions_source ON skill_versions (source_id);

        -- A version's files; their bytes live in the blob store. mode is 0644 (420) or 0755 (493).
        CREATE TABLE skill_files (
          version_id TEXT NOT NULL REFERENCES skill_versions (id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          blob_sha256 TEXT NOT NULL,
          size INTEGER NOT NULL,
          mode INTEGER NOT NULL CHECK (mode IN (420, 493)),
          kind TEXT NOT NULL CHECK (kind IN ('skill_md', 'markdown', 'text', 'script', 'asset')),
          interpreter TEXT,
          PRIMARY KEY (version_id, path)
        ) STRICT;
        CREATE INDEX skill_files_blob ON skill_files (blob_sha256);

        -- Review decisions per tree hash. Never edited: a new decision is a new row, and the latest decides.
        CREATE TABLE skill_reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tree_hash TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'revoked')),
          note TEXT NOT NULL DEFAULT '',
          -- {"findings": [ids], "license": bool}
          acknowledged TEXT NOT NULL DEFAULT '{}',
          -- A short hash of the signed-in session (one shared admin sign-in), never the token.
          session TEXT,
          at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX skill_reviews_hash ON skill_reviews (tree_hash, id);

        -- FR21: per workspace, what its last delivery shipped and what verification last saw (delivered
        -- names only, never file content).
        CREATE TABLE skill_inventory (
          workspace_id TEXT PRIMARY KEY,
          observed_at TEXT,
          method TEXT CHECK (method IN ('details', 'init')),
          status TEXT CHECK (status IN ('verified', 'mismatch', 'error', 'not_verified')),
          plugins TEXT NOT NULL DEFAULT '[]',
          skills TEXT NOT NULL DEFAULT '[]',
          hand_copied TEXT NOT NULL DEFAULT '[]',
          detail TEXT,
          -- Consecutive mismatches or timeouts: reported only on the second (FR23).
          attempts INTEGER NOT NULL DEFAULT 0,
          -- What the last delivery shipped: [{poolId, revision, prefix, folder, skills}], and its hash.
          expected TEXT NOT NULL DEFAULT '[]',
          expected_hash TEXT,
          -- When the shipped skills last changed, for the reload notice (§10.4).
          changed_at TEXT,
          -- Skillset plugin version folders still in the workspace, as the engine reports them: plugin → [hash12].
          folders TEXT NOT NULL DEFAULT '{}'
        ) STRICT;

        -- Which skill versions each compiled version folder holds, so revoking one finds every folder to
        -- delete at once (§11.3), retained ones included.
        CREATE TABLE skill_plugin_folders (
          plugin TEXT NOT NULL,
          hash12 TEXT NOT NULL,
          tree_hashes TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (plugin, hash12)
        ) STRICT;

        -- A5: the blob store's files (<dataDir>/blobs/sha256/<aa>/<sha256>), for garbage collection.
        CREATE TABLE blobs (
          sha256 TEXT PRIMARY KEY,
          size INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          unreferenced_since TEXT
        ) STRICT;
      `);
    },
  },
];

/**
 * Every column that holds sealed values. `portal rotate-key` re-seals them and `portal
 * forget-secrets` clears them, so a migration that adds one must list it here.
 */
export const ENCRYPTED_COLUMNS: EncryptedColumn[] = [
  { table: 'accounts', column: 'secret', idColumn: 'id' },
  { table: 'secret_values', column: 'ciphertext', idColumn: 'id' },
  { table: 'skill_sources', column: 'token', idColumn: 'id' },
];
