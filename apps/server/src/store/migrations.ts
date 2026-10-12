import type { DatabaseSync } from 'node:sqlite';
import { backfillSegments, foldTransferPairs } from '../chat/legacy.js';

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
    name: 'workspace claudes',
    up(db) {
      db.exec(`
        -- One directory per Claude on a workspace volume (Workspace Claudes PRD). No credentials.
        CREATE TABLE workspace_claudes (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          directory TEXT NOT NULL DEFAULT '',
          removed_at TEXT,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX workspace_claudes_name ON workspace_claudes (workspace_id, name);
        CREATE INDEX workspace_claudes_workspace ON workspace_claudes (workspace_id);

        ALTER TABLE chat_sessions ADD COLUMN claude_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE chat_sessions ADD COLUMN predecessor_id TEXT;
        ALTER TABLE chat_sessions ADD COLUMN successor_id TEXT;

        CREATE TABLE claude_handoffs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          source_session_id TEXT NOT NULL,
          successor_session_id TEXT,
          source_claude_id TEXT NOT NULL,
          dest_claude_id TEXT NOT NULL,
          path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          actor TEXT
        ) STRICT;
      `);
    },
  },
  {
    version: 10,
    name: 'claude names unique among live claudes',
    up(db) {
      db.exec(`
        -- A removed Claude keeps its row (Workspace Claudes FR3), so its name is free again.
        DROP INDEX workspace_claudes_name;
        CREATE UNIQUE INDEX workspace_claudes_name ON workspace_claudes (workspace_id, name) WHERE removed_at IS NULL;
      `);
    },
  },
  {
    version: 11,
    name: 'chat usage metrics',
    up(db) {
      db.exec(`
        -- What each finished turn used, as metrics (Usage charts): one row per model the turn used, the
        -- main agent and its sub-agents together. The turn's request, sub-agents and time count on its
        -- first row. Rows stay when their session is deleted, so the history does too.
        CREATE TABLE chat_usage (
          id INTEGER PRIMARY KEY,
          at TEXT NOT NULL,
          at_ms INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          claude_id TEXT,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          requests INTEGER NOT NULL DEFAULT 0,
          agents INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE INDEX chat_usage_at ON chat_usage (at_ms);
      `);
      // Turns finished before this: one row each, from what their result kept. A result's cost is the
      // process's running total, so a turn's is the change from the one before (lower: a new process).
      const insert = db.prepare(
        `INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, requests, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      );
      const results = db.prepare(`SELECT at, payload FROM chat_events WHERE session_id = ? AND kind = 'result' ORDER BY seq`);
      const sessions = db.prepare('SELECT id, workspace_id, claude_id, model FROM chat_sessions').all() as {
        id: string;
        workspace_id: string;
        claude_id: string | null;
        model: string | null;
      }[];
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
      for (const s of sessions) {
        let last = 0;
        for (const r of results.all(s.id) as { at: string; payload: string }[]) {
          let p: Record<string, unknown> = {};
          try {
            p = JSON.parse(r.payload) as Record<string, unknown>;
          } catch {
            // a row that can't be read counts as a request with nothing known
          }
          const total = typeof p.costUsd === 'number' ? p.costUsd : null;
          const cost = typeof p.turnCostUsd === 'number' ? p.turnCostUsd : total === null ? 0 : total >= last ? total - last : total;
          if (total !== null) last = total;
          const t = (p.tokens && typeof p.tokens === 'object' ? p.tokens : {}) as Record<string, unknown>;
          const at = Date.parse(r.at);
          insert.run(r.at, Number.isFinite(at) ? at : 0, s.id, s.workspace_id, s.claude_id, s.model ?? 'unknown', num(t.input), num(t.output), num(t.cacheRead), num(t.cacheWrite), num(cost), num(p.durationMs));
        }
      }
    },
  },
  {
    version: 12,
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
    version: 13,
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
    version: 15,
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
    version: 14,
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
  {
    version: 16,
    name: 'chat sessions: tickets, parents and worktrees',
    up(db) {
      db.exec(`
        -- Ticket and multi-agent work (chat-sessions PRD, I1): who started a session, the ticket and the parent
        -- session it belongs to, and the git worktree it runs in (which is also its cwd).
        ALTER TABLE chat_sessions ADD COLUMN ticket_id TEXT;
        ALTER TABLE chat_sessions ADD COLUMN parent_id TEXT;
        ALTER TABLE chat_sessions ADD COLUMN started_by TEXT;
        ALTER TABLE chat_sessions ADD COLUMN worktree_path TEXT;
        ALTER TABLE chat_sessions ADD COLUMN worktree_branch TEXT;
        ALTER TABLE chat_sessions ADD COLUMN worktree_repo TEXT;
        CREATE INDEX chat_sessions_parent ON chat_sessions (parent_id) WHERE parent_id IS NOT NULL;
        CREATE INDEX chat_sessions_ticket ON chat_sessions (ticket_id) WHERE ticket_id IS NOT NULL;
      `);
    },
  },
  {
    version: 17,
    name: 'chat sessions: one chat across Claudes',
    up(db) {
      db.exec(`
        -- Workspace Claudes, owner's correction (2026-10-12): moving a chat to another Claude doesn't make a
        -- second session. chat_sessions.id is the stable portal id; claude_session_id is the Claude Code session
        -- of the run that is going now (NULL: the portal id was Claude Code's id, as for every session before).
        ALTER TABLE chat_sessions ADD COLUMN claude_session_id TEXT;
        -- What the closed runs cost (Claude Code reports a running total per process), so a session's cost is the sum.
        ALTER TABLE chat_sessions ADD COLUMN cost_base_usd REAL NOT NULL DEFAULT 0;
        -- last_seq when the current run began: what belongs to its Claude Code session starts after it.
        ALTER TABLE chat_sessions ADD COLUMN segment_seq INTEGER NOT NULL DEFAULT 0;

        -- One row per run of a chat on a Claude. Events, inputs, requests, tasks, files and usage stay keyed by
        -- the portal id; usage rows carry the Claude of each turn.
        CREATE TABLE chat_segments (
          session_id TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
          n INTEGER NOT NULL,
          claude_id TEXT NOT NULL,
          claude_session_id TEXT NOT NULL,
          cwd TEXT NOT NULL DEFAULT '',
          started_at TEXT NOT NULL,
          ended_at TEXT,
          ended_reason TEXT,
          cost_usd REAL NOT NULL DEFAULT 0,
          turns INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (session_id, n)
        ) STRICT;

        -- A folded session's old id still finds the chat: links, ticket references, tools.
        CREATE TABLE chat_session_aliases (
          alias_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX chat_session_aliases_session ON chat_session_aliases (session_id);
      `);
      backfillSegments(db);
      // The two rows an old move left (a session ended as transferred, and its successor) become one chat.
      foldTransferPairs(db);
    },
  },
  {
    version: 18,
    name: 'chat audit',
    up(db) {
      db.exec(`
        -- What a person should be able to look back on (chat-sessions PRD §14): Bypass entered and left, and what was
        -- refused. Severity: info, medium, high. Detail is JSON of names and ids, never a secret or message text.
        CREATE TABLE chat_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          severity TEXT NOT NULL,
          kind TEXT NOT NULL,
          session_id TEXT,
          workspace_id TEXT,
          actor TEXT,
          detail TEXT NOT NULL DEFAULT '{}'
        ) STRICT;
        CREATE INDEX chat_audit_at ON chat_audit (at);
        CREATE INDEX chat_audit_session ON chat_audit (session_id) WHERE session_id IS NOT NULL;
      `);
    },
  },
  {
    version: 19,
    name: 'chat worktrees',
    up(db) {
      db.exec(`
        -- Git worktrees the portal made for chats (chat-sessions PRD, Git worktrees per session). A row is reserved while the
        -- worktree exists but its chat doesn't yet (a start waiting on folder trust), active while a chat runs in it, kept when
        -- the chat is over and the folder stays, and removed once the folder is gone. The chat's own folder and branch are
        -- on chat_sessions; this is the portal's record of what it made, so it can be listed, reused and swept.
        CREATE TABLE chat_worktrees (
          workspace_id TEXT NOT NULL,
          path TEXT NOT NULL,
          repo TEXT NOT NULL,
          branch TEXT NOT NULL,
          base TEXT,
          session_id TEXT,
          state TEXT NOT NULL DEFAULT 'reserved',
          created_at TEXT NOT NULL,
          removed_at TEXT,
          PRIMARY KEY (workspace_id, path)
        ) STRICT;
        CREATE INDEX chat_worktrees_session ON chat_worktrees (session_id) WHERE session_id IS NOT NULL;
      `);
    },
  },
  {
    version: 20,
    name: 'mcp catalog: proposals by agents and tokens',
    up(db) {
      db.exec(`
        -- I3 (the global "add MCP" flow): an agent or a token can only PROPOSE a catalog version. It is a
        -- draft like any other, so no set can use it and nothing is delivered until a person approves it in
        -- the portal; these columns say who asked, when and why (plain text for the reviewer).
        ALTER TABLE mcp_catalog_versions ADD COLUMN proposed_by TEXT;
        ALTER TABLE mcp_catalog_versions ADD COLUMN proposed_at TEXT;
        ALTER TABLE mcp_catalog_versions ADD COLUMN proposal_reason TEXT;
        CREATE INDEX mcp_catalog_versions_proposed ON mcp_catalog_versions (proposed_by) WHERE proposed_by IS NOT NULL;
      `);
    },
  },
  {
    version: 21,
    name: 'secrets: rotations and the event trail',
    up(db) {
      db.exec(`
        -- Secrets & env PRD §9, FR16 and FR17: each rotation of a secret, with the tracker's outcome. An
        -- urgent one (A14) also moves the workspaces pinned to an older revision to the new value.
        CREATE TABLE secret_rotations (
          id TEXT PRIMARY KEY,
          pool_id TEXT NOT NULL REFERENCES pools (id) ON DELETE CASCADE,
          entry_id TEXT NOT NULL,
          field TEXT NOT NULL DEFAULT 'value',
          -- NULL when the entry had no value before.
          from_value_id TEXT,
          to_value_id TEXT NOT NULL,
          urgent INTEGER NOT NULL DEFAULT 0,
          started_at TEXT NOT NULL,
          -- When every workspace that gets the pool had the new value (the old one is safe to revoke at its provider).
          safe_at TEXT,
          note TEXT NOT NULL DEFAULT ''
        ) STRICT;
        CREATE INDEX secret_rotations_pool ON secret_rotations (pool_id, started_at);
        CREATE INDEX secret_rotations_urgent ON secret_rotations (from_value_id) WHERE urgent = 1;

        -- What happened to secrets (PRD §14): rotations, revocations, purges, expiry warnings, checks. Never a value.
        CREATE TABLE secret_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          type TEXT NOT NULL,
          pool_id TEXT,
          entry_id TEXT,
          value_id TEXT,
          details TEXT NOT NULL DEFAULT '{}'
        ) STRICT;
        CREATE INDEX secret_events_at ON secret_events (at);
        CREATE INDEX secret_events_pool ON secret_events (pool_id, id);
      `);
    },
  },
  {
    version: 22,
    name: 'settings: audit trail and per-workspace lockdown state',
    up(db) {
      db.exec(`
        -- The shared settings store keeps each value in portal_meta ('setting:<key>', as JSON); every change is
        -- recorded here with who made it and what it was (settings-policies.md, the MCP lockdown). Never a secret.
        CREATE TABLE setting_changes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          key TEXT NOT NULL,
          old_value TEXT,
          new_value TEXT NOT NULL,
          actor TEXT NOT NULL
        ) STRICT;
        CREATE INDEX setting_changes_at ON setting_changes (at);

        -- What the MCP lockdown delivered to each workspace last, and the sessions that started before it:
        -- Claude Code doesn't apply a change to a session that started before the managed folder existed, so
        -- a workspace with such sessions is "Pending", never "Locked".
        CREATE TABLE lockdown_state (
          workspace_id TEXT PRIMARY KEY,
          hash TEXT NOT NULL,
          changed_at TEXT NOT NULL,
          old_sessions INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 23,
    name: 'skillsets: agent proposals',
    up(db) {
      db.exec(`
        -- A skill version an agent or a token proposed (Skillset FR-P, interface I11): who, for which workspace
        -- (verified from the agent's token), why. The version itself is an ordinary unreviewed library version:
        -- nothing here approves it, and no set accepts it until a person does.
        CREATE TABLE skill_proposals (
          version_id TEXT PRIMARY KEY REFERENCES skill_versions (id) ON DELETE CASCADE,
          actor TEXT NOT NULL,
          workspace_id TEXT,
          reason TEXT NOT NULL DEFAULT '',
          replaces TEXT,
          proposed_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX skill_proposals_actor ON skill_proposals (actor, proposed_at);
        CREATE INDEX skill_proposals_workspace ON skill_proposals (workspace_id, proposed_at);
      `);
    },
  },
  {
    version: 40,
    name: 'portal mcp: settings, access tokens, audit',
    up(db) {
      db.exec(`
        -- Portal MCP (portal-mcp PRD §9). Prefixed pmcp_ so it never meets the MCP set pool's mcp_* tables.
        CREATE TABLE pmcp_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          -- While off, /mcp answers 404 (FR2): an admin turns it on in Access → MCP.
          enabled INTEGER NOT NULL DEFAULT 0,
          -- FR15: the session write tools are listed only while this is on.
          session_control INTEGER NOT NULL DEFAULT 0,
          audit_days INTEGER NOT NULL DEFAULT 90,
          updated_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO pmcp_settings (id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

        -- Personal access tokens: only the SHA-256 hash is kept, so a token is shown once and never recovered.
        CREATE TABLE pmcp_tokens (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          last4 TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('read', 'operate', 'admin')),
          -- An inside token: limited to this workspace and to the tools made for agents.
          workspace_id TEXT,
          -- Reserved: a token for one session of that workspace.
          session_id TEXT,
          purpose TEXT NOT NULL DEFAULT 'user' CHECK (purpose IN ('user', 'workspace')),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_used_at TEXT,
          last_used_ip TEXT,
          revoked_at TEXT,
          revoked_reason TEXT
        ) STRICT;
        CREATE INDEX pmcp_tokens_workspace ON pmcp_tokens (workspace_id) WHERE workspace_id IS NOT NULL;

        -- Every authenticated request (§17): what was asked and what came of it. Arguments are redacted and capped.
        CREATE TABLE pmcp_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          request_id TEXT NOT NULL,
          token_id TEXT,
          token_label TEXT,
          client TEXT,
          ip TEXT,
          user_agent TEXT,
          method TEXT NOT NULL,
          tool TEXT,
          args TEXT,
          outcome TEXT NOT NULL,
          error_code TEXT,
          duration_ms INTEGER,
          affected TEXT NOT NULL DEFAULT '[]'
        ) STRICT;
        CREATE INDEX pmcp_audit_at ON pmcp_audit (at);
        CREATE INDEX pmcp_audit_tool ON pmcp_audit (tool, at);
        CREATE INDEX pmcp_audit_token ON pmcp_audit (token_id, at);

        -- Requests turned away before a token was known (no token, a wrong one, too many) are counted per
        -- address and minute; token and lockdown events are single rows.
        CREATE TABLE pmcp_auth_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          ip TEXT NOT NULL DEFAULT '',
          bucket TEXT NOT NULL,
          token_id TEXT,
          count INTEGER NOT NULL DEFAULT 1,
          first_at TEXT NOT NULL,
          last_at TEXT NOT NULL,
          details TEXT NOT NULL DEFAULT '{}'
        ) STRICT;
        CREATE UNIQUE INDEX pmcp_auth_events_bucket ON pmcp_auth_events (kind, ip, bucket) WHERE kind = 'rejected';
        CREATE INDEX pmcp_auth_events_at ON pmcp_auth_events (last_at);
      `);
    },
  },
  {
    version: 50,
    name: 'knowledge: vaults, note history, context edges and audit',
    up(db) {
      db.exec(`
        -- Knowledge PRD §11. A vault's notes are files on disk (the truth); these are the durable parts that
        -- must ride in database backups: its settings, the text of every changed version, who touched which
        -- note, and the audit. The search index lives in its own rebuildable file. No secrets, no note
        -- text outside kg_versions.content.
        CREATE TABLE kg_vaults (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          -- 'vault': a folder under <dataDir>/knowledge/vaults. 'folder': an operator-allowed directory (root = "<key>/<subpath>").
          kind TEXT NOT NULL CHECK (kind IN ('vault', 'folder')),
          root TEXT NOT NULL,
          read_only INTEGER NOT NULL DEFAULT 0,
          agents TEXT NOT NULL DEFAULT 'write-own' CHECK (agents IN ('off', 'read', 'write-own', 'write')),
          daily_folder TEXT NOT NULL DEFAULT 'Daily',
          timezone TEXT NOT NULL DEFAULT 'UTC',
          settings TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        ) STRICT;
        CREATE UNIQUE INDEX kg_vaults_name ON kg_vaults (name COLLATE NOCASE) WHERE deleted_at IS NULL;

        -- One row per change to a note. The first row of a note is the text it had before the portal first
        -- changed it; delete rows carry no content (the row before holds it). state 'pending' marks a write
        -- whose file rename hadn't finished (settled by hash at start).
        CREATE TABLE kg_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vault_id TEXT NOT NULL REFERENCES kg_vaults (id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          op TEXT NOT NULL CHECK (op IN ('create', 'edit', 'append', 'rename', 'delete', 'restore', 'import', 'sync', 'external')),
          actor TEXT NOT NULL,
          actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'system', 'external')),
          base_hash TEXT,
          hash TEXT,
          size INTEGER NOT NULL DEFAULT 0,
          content BLOB,
          from_path TEXT,
          note TEXT NOT NULL DEFAULT '',
          state TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('pending', 'ok')),
          at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX kg_versions_path ON kg_versions (vault_id, path, id);
        CREATE INDEX kg_versions_vault ON kg_versions (vault_id, id);

        -- Which session, ticket, token or person read or wrote which note (the context graph), as counters.
        CREATE TABLE kg_edges (
          vault_id TEXT NOT NULL REFERENCES kg_vaults (id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('session', 'ticket', 'token', 'user', 'workspace')),
          source_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('read', 'created', 'edited', 'appended', 'deleted')),
          count INTEGER NOT NULL DEFAULT 1,
          first_at TEXT NOT NULL,
          last_at TEXT NOT NULL,
          PRIMARY KEY (vault_id, path, source_kind, source_id, kind)
        ) STRICT;
        CREATE INDEX kg_edges_source ON kg_edges (source_kind, source_id, last_at);
        CREATE INDEX kg_edges_recent ON kg_edges (vault_id, last_at);

        -- What was refused or done that a version row doesn't show (conflicts, denials, imports, exports,
        -- setting changes). Never note text. Kept 90 days.
        CREATE TABLE kg_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          vault_id TEXT,
          actor TEXT NOT NULL,
          op TEXT NOT NULL,
          path TEXT,
          outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'conflict', 'denied', 'refused', 'error')),
          detail TEXT NOT NULL DEFAULT '',
          bytes INTEGER
        ) STRICT;
        CREATE INDEX kg_audit_at ON kg_audit (at);
        CREATE INDEX kg_audit_vault ON kg_audit (vault_id, at);
      `);
    },
  },
  {
    version: 41,
    name: 'portal mcp: portal tools for the agents in a workspace',
    up(db) {
      db.exec(`
        -- Portal MCP, the inside audience: a workspace that was given portal tools has a token bound to it, installed
        -- in its Claude Code configuration. The token's value is never kept here (only its hash, in pmcp_tokens).
        CREATE TABLE pmcp_workspace_access (
          workspace_id TEXT PRIMARY KEY,
          token_id TEXT NOT NULL,
          -- The /mcp URL as the workspace reaches the portal.
          url TEXT NOT NULL,
          -- Which Claude configuration folders it was installed in (JSON: "" is the default).
          installed TEXT NOT NULL DEFAULT '[]',
          enabled_at TEXT NOT NULL,
          last_error TEXT
        ) STRICT;
      `);
    },
  },
  {
    version: 42,
    name: 'tickets: one queue of work for people and agents',
    up(db) {
      db.exec(`
        -- Tickets PRD §9. The id shown everywhere is T-<number>; AUTOINCREMENT, so a deleted number is never reused.
        CREATE TABLE tickets (
          number INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK (type IN ('task', 'bug', 'feature', 'question', 'request', 'incident', 'approval', 'chore')),
          priority TEXT NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
          -- 0 urgent … 3 low: the queue's order.
          priority_rank INTEGER NOT NULL CHECK (priority_rank BETWEEN 0 AND 3),
          status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'blocked', 'in_review', 'done', 'wont_do')),
          summary TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          -- Who it came from, which never changes.
          source TEXT NOT NULL CHECK (source IN ('human', 'agent', 'system')),
          reporter_kind TEXT NOT NULL CHECK (reporter_kind IN ('ui', 'token', 'system')),
          reporter_ref TEXT,
          reporter_label TEXT NOT NULL,
          reporter_workspace TEXT,
          -- Nobody (the agents' queue), a chat session id, or a person's label.
          assignee_kind TEXT CHECK (assignee_kind IN ('session', 'user')),
          assignee_ref TEXT,
          workspace_id TEXT,
          worktree_branch TEXT,
          worktree_path TEXT,
          closing_summary TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          closed_at TEXT,
          CHECK ((assignee_kind IS NULL) = (assignee_ref IS NULL))
        ) STRICT;
        CREATE INDEX tickets_queue ON tickets (status, priority_rank, created_at);
        CREATE INDEX tickets_assignee ON tickets (assignee_kind, assignee_ref);
        CREATE INDEX tickets_workspace ON tickets (workspace_id);

        CREATE TABLE ticket_tags (
          ticket_number INTEGER NOT NULL REFERENCES tickets (number) ON DELETE CASCADE,
          tag TEXT NOT NULL,
          PRIMARY KEY (ticket_number, tag)
        ) STRICT;
        CREATE INDEX ticket_tags_tag ON ticket_tags (tag);

        -- The timeline: every change, in the transaction that made it. Entries are never edited.
        CREATE TABLE ticket_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ticket_number INTEGER NOT NULL REFERENCES tickets (number) ON DELETE CASCADE,
          at TEXT NOT NULL,
          kind TEXT NOT NULL,
          -- ui, session:<id>, portal-mcp:<token id>, ticket:<id> or system.
          actor TEXT NOT NULL,
          actor_label TEXT NOT NULL,
          body TEXT,
          data TEXT
        ) STRICT;
        CREATE INDEX ticket_events_ticket ON ticket_events (ticket_number, id);
      `);
    },
  },
  {
    version: 43,
    name: 'portal mcp: per-session agent tokens and the per-workspace opt-in',
    up(db) {
      db.exec(`
        -- Interface I8: an agent inside a workspace reaches the portal with a token minted for ONE chat session, passed
        -- only in that session's process environment. This replaces the workspace-bound access table of migration 41.
        DROP TABLE pmcp_workspace_access;

        -- "Agent access to portal tools": off until a workspace is listed here.
        CREATE TABLE pmcp_agent_access (
          workspace_id TEXT PRIMARY KEY,
          enabled_at TEXT NOT NULL
        ) STRICT;

        -- cpst_ tokens: hashed like the others, bound to a workspace AND a session, alive as long as the session.
        CREATE TABLE pmcp_agent_tokens (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          -- JSON list of the knowledge vaults it may use; null: whatever the vault's own policy allows.
          vaults TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_used_at TEXT,
          revoked_at TEXT,
          revoked_reason TEXT
        ) STRICT;
        CREATE INDEX pmcp_agent_tokens_session ON pmcp_agent_tokens (session_id) WHERE revoked_at IS NULL;
        CREATE INDEX pmcp_agent_tokens_workspace ON pmcp_agent_tokens (workspace_id, created_at);

        -- Who acted, as the tools saw it (session:<id> for an agent, portal-mcp:<token id> otherwise).
        ALTER TABLE pmcp_audit ADD COLUMN actor TEXT;
        -- The same allow-list for the admin's own tokens.
        ALTER TABLE pmcp_tokens ADD COLUMN vaults TEXT;
      `);
    },
  },
  {
    version: 44,
    name: 'tickets: checks attached by CI',
    up(db) {
      db.exec(`
        -- Interface I10: the CI runner attaches a pipeline's status to a ticket (one row per check name, the latest state).
        CREATE TABLE ticket_checks (
          ticket_number INTEGER NOT NULL REFERENCES tickets (number) ON DELETE CASCADE,
          name TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'passed', 'failed', 'cancelled')),
          run_id TEXT,
          commit_sha TEXT,
          link TEXT,
          actor TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (ticket_number, name)
        ) STRICT;
      `);
    },
  },
  {
    version: 45,
    name: 'tickets: a check waiting to start is queued, and CI entries are kind ci',
    up(db) {
      // CI (A5) names the waiting state "queued" and wants its timeline entries told apart from comments: rebuild the
      // table with the new word and rename what migration 44's code wrote.
      db.exec(`
        ALTER TABLE ticket_checks RENAME TO ticket_checks_old;
        CREATE TABLE ticket_checks (
          ticket_number INTEGER NOT NULL REFERENCES tickets (number) ON DELETE CASCADE,
          name TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'passed', 'failed', 'cancelled')),
          run_id TEXT,
          commit_sha TEXT,
          link TEXT,
          actor TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (ticket_number, name)
        ) STRICT;
        INSERT INTO ticket_checks (ticket_number, name, state, run_id, commit_sha, link, actor, updated_at)
          SELECT ticket_number, name, CASE state WHEN 'pending' THEN 'queued' ELSE state END, run_id, commit_sha, link, actor, updated_at
          FROM ticket_checks_old;
        DROP TABLE ticket_checks_old;
        UPDATE ticket_events SET kind = 'ci' WHERE kind = 'check';
      `);
    },
  },
  {
    version: 30,
    name: 'browser pool: instances, installs, events',
    up(db) {
      db.exec(`
        -- Browser & desktop pool (browser PRD §9): the pool is a foundation pool of type 'browser'; these are what the
        -- runtime can't tell the portal. The container itself is the record (labels on it); these keep the portal's
        -- own view across restarts. No frames, keystrokes, clipboard text or cookies are ever stored.
        CREATE TABLE browser_instances (
          workspace_id TEXT PRIMARY KEY,
          pool_id TEXT,
          revision INTEGER,
          -- none, workspace_stopped, starting, running, error: the container, as the portal last converged it.
          container TEXT NOT NULL DEFAULT 'none',
          sandbox TEXT,
          spec TEXT,
          image_id TEXT,
          restarts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;

        -- The pinned MCP servers installed in the workspace (the run-in-workspace step), by lockfile hash.
        CREATE TABLE browser_installs (
          workspace_id TEXT PRIMARY KEY,
          lock_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('installing', 'installed', 'failed')),
          error TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;

        -- §16: starts, stops, crashes, take-overs and handoff answers, with the device that did it; kept 90 days.
        CREATE TABLE browser_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          details TEXT NOT NULL DEFAULT '{}'
        ) STRICT;
        CREATE INDEX browser_events_workspace ON browser_events (workspace_id, id);
      `);
    },
  },
  {
    version: 31,
    name: 'browser pool: profile wipe on a stopped workspace',
    up(db) {
      db.exec(`
        -- Unassigning a browser deletes its sign-ins; on a stopped workspace that waits for the next start (PRD §13 Profile).
        ALTER TABLE browser_instances ADD COLUMN wipe_profile INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 60,
    name: 'chat content: uploads and artifacts',
    up(db) {
      db.exec(`
        -- Chat content (chat-sessions PRD FR30-FR33, §9): what a file in a chat is, which transcript event it
        -- belongs to, and the uploads still waiting for the message they go with. The bytes stay in the blob store.
        ALTER TABLE chat_files ADD COLUMN event_seq INTEGER;
        ALTER TABLE chat_files ADD COLUMN width INTEGER;
        ALTER TABLE chat_files ADD COLUMN height INTEGER;
        -- Allow-listed keys only (preview, reach, source, redacted).
        ALTER TABLE chat_files ADD COLUMN meta TEXT;
        CREATE INDEX chat_files_event ON chat_files (session_id, event_seq) WHERE event_seq IS NOT NULL;

        CREATE TABLE chat_uploads (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
          blob_sha256 TEXT NOT NULL,
          name TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          meta TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX chat_uploads_session ON chat_uploads (session_id, created_at);
        CREATE INDEX chat_uploads_blob ON chat_uploads (blob_sha256);
      `);
    },
  },
  {
    version: 90,
    name: 'claude usage: plan limit readings',
    up(db) {
      db.exec(`
        -- Claude usage (claude-usage PRD §9): the plan windows of each Claude, as Claude Code itself reported them.
        -- Numbers, times and a coarse plan tier only; no login, token, email, organization or account id.
        CREATE TABLE claude_usage_samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at_ms INTEGER NOT NULL,
          claude_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          win TEXT NOT NULL,
          used_pct REAL,
          resets_at_ms INTEGER,
          level TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('probe', 'live'))
        ) STRICT;
        CREATE INDEX claude_usage_samples_claude ON claude_usage_samples (claude_id, win, at_ms);
        CREATE INDEX claude_usage_samples_at ON claude_usage_samples (at_ms);

        -- The newest reading of each Claude, so a restart still has something to show, plus the probe schedule and
        -- the alert state (which crossings were already told, per window and period).
        CREATE TABLE claude_usage_latest (
          claude_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          checked_at_ms INTEGER,
          last_probe_at_ms INTEGER NOT NULL DEFAULT 0,
          runs_on TEXT NOT NULL DEFAULT 'unknown',
          plan TEXT,
          windows TEXT NOT NULL DEFAULT '[]',
          extra TEXT,
          source TEXT,
          problem TEXT,
          fails INTEGER NOT NULL DEFAULT 0,
          snoozed_until_ms INTEGER,
          alerted TEXT NOT NULL DEFAULT '{}'
        ) STRICT;
      `);
    },
  },
  {
    version: 80,
    name: 'local git and CI: workspaces, remotes, events, runs, logs, merges',
    up(db) {
      db.exec(`
        -- Local git and CI/CD (docs/prd/local-git-ci.md §12). Nothing here is a secret; text that came from a workspace
        -- (logs, commit subjects) is redacted before it is stored.
        CREATE TABLE ci_workspaces (
          workspace_id TEXT PRIMARY KEY,
          max_runs INTEGER,
          runner_hash TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;

        -- A bare repository on a workspace's volume. Removed ones stay (soft delete) so their runs keep a home.
        CREATE TABLE ci_repos (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          default_branch TEXT NOT NULL,
          protected TEXT NOT NULL DEFAULT '[]',
          required_checks TEXT NOT NULL DEFAULT '[]',
          merge_only INTEGER NOT NULL DEFAULT 0,
          source_path TEXT,
          connected TEXT NOT NULL DEFAULT '[]',
          hook_state TEXT NOT NULL DEFAULT 'unknown',
          created_at TEXT NOT NULL,
          removed_at TEXT
        ) STRICT;
        CREATE UNIQUE INDEX ci_repos_name ON ci_repos (workspace_id, name) WHERE removed_at IS NULL;

        -- What each ref update did, so "why did nothing run" has an answer. Kept 14 days.
        CREATE TABLE ci_events (
          workspace_id TEXT NOT NULL,
          id TEXT NOT NULL,
          repo_id TEXT,
          repo TEXT NOT NULL,
          kind TEXT NOT NULL,
          ref TEXT NOT NULL,
          old_sha TEXT NOT NULL,
          new_sha TEXT NOT NULL,
          via TEXT NOT NULL,
          at TEXT NOT NULL,
          outcome TEXT NOT NULL,
          note TEXT,
          PRIMARY KEY (workspace_id, id)
        ) STRICT;

        CREATE TABLE ci_runs (
          id TEXT PRIMARY KEY,
          number INTEGER NOT NULL,
          workspace_id TEXT NOT NULL,
          repo_id TEXT NOT NULL,
          repo TEXT NOT NULL,
          pipeline TEXT NOT NULL,
          trigger TEXT NOT NULL,
          event_id TEXT,
          ref TEXT NOT NULL,
          branch TEXT,
          tag TEXT,
          sha TEXT NOT NULL,
          base_sha TEXT,
          subject TEXT,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'cancelled')),
          reason TEXT,
          actor TEXT NOT NULL,
          inputs TEXT NOT NULL DEFAULT '{}',
          ticket_id TEXT,
          ticket_source TEXT,
          session_id TEXT,
          rerun_of TEXT,
          concurrency_group TEXT,
          cancel_in_progress INTEGER NOT NULL DEFAULT 0,
          plan TEXT,
          state TEXT,
          diagnostics TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          duration_ms INTEGER,
          archived INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE UNIQUE INDEX ci_runs_number ON ci_runs (repo_id, number);
        CREATE INDEX ci_runs_created ON ci_runs (workspace_id, created_at);
        CREATE INDEX ci_runs_status ON ci_runs (workspace_id, status);
        CREATE INDEX ci_runs_ticket ON ci_runs (ticket_id) WHERE ticket_id IS NOT NULL;
        CREATE INDEX ci_runs_session ON ci_runs (session_id) WHERE session_id IS NOT NULL;
        CREATE INDEX ci_runs_branch ON ci_runs (repo_id, branch);
        -- One run per pipeline per event, however many times an event is delivered.
        CREATE UNIQUE INDEX ci_runs_event ON ci_runs (workspace_id, event_id, pipeline) WHERE event_id IS NOT NULL;

        -- A finished run's logs: per step the head and the tail, redacted (PRD FR30).
        CREATE TABLE ci_logs (
          run_id TEXT NOT NULL REFERENCES ci_runs (id) ON DELETE CASCADE,
          job TEXT NOT NULL,
          step INTEGER NOT NULL,
          bytes INTEGER NOT NULL,
          omitted INTEGER NOT NULL DEFAULT 0,
          text TEXT NOT NULL,
          PRIMARY KEY (run_id, job, step)
        ) STRICT;

        -- Merges the portal made on a remote.
        CREATE TABLE ci_merges (
          id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL,
          source TEXT NOT NULL,
          target TEXT NOT NULL,
          strategy TEXT NOT NULL,
          result_sha TEXT,
          actor TEXT NOT NULL,
          at TEXT NOT NULL,
          outcome TEXT NOT NULL,
          note TEXT
        ) STRICT;
        CREATE INDEX ci_merges_repo ON ci_merges (repo_id, at);
      `);
    },
  },
  {
    version: 81,
    name: 'CI: messages to sessions (the loop caps)',
    up(db) {
      db.exec(`
        -- Every failure message CI sent (or decided not to send) to a session: what the per-ticket caps and the circuit breaker count.
        CREATE TABLE ci_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          ticket_id TEXT,
          at TEXT NOT NULL,
          -- sent, refused (the session said no), capped (over the hourly or daily cap), paused (repeated failures)
          outcome TEXT NOT NULL,
          note TEXT
        ) STRICT;
        CREATE INDEX ci_messages_ticket ON ci_messages (ticket_id, at) WHERE ticket_id IS NOT NULL;
        CREATE INDEX ci_messages_session ON ci_messages (session_id, at);
      `);
    },
  },
  {
    version: 70,
    name: 'personas: identity, self-edit switches, avatars and proposals',
    up(db) {
      db.exec(`
        -- Persona PRD I11 and A10: what belongs to a persona as a whole, not to one of its revisions.
        CREATE TABLE persona_meta (
          pool_id TEXT PRIMARY KEY REFERENCES pools (id) ON DELETE CASCADE,
          -- sha256 of a persona_avatars row; none is valid (the UI shows initials).
          avatar TEXT,
          agents_may_propose INTEGER NOT NULL DEFAULT 0,
          auto_approve_cosmetic INTEGER NOT NULL DEFAULT 0,
          -- The persona new workspaces start with; at most one.
          is_default INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX persona_meta_default ON persona_meta (is_default) WHERE is_default = 1;

        -- Avatars, content-addressed: the PNG the portal re-encoded from an upload, never the upload itself.
        CREATE TABLE persona_avatars (
          sha256 TEXT PRIMARY KEY,
          png BLOB NOT NULL,
          size INTEGER NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        -- What sessions asked to change about their own persona, and what a person decided (I11). A proposal is a
        -- record, not a revision: approving one publishes a revision, so a rejected or stale one never reaches the history.
        CREATE TABLE persona_proposals (
          id TEXT PRIMARY KEY,
          pool_id TEXT NOT NULL REFERENCES pools (id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('name', 'avatar', 'instructions')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'stale')),
          -- session:<id>, from the agent token; workspace and session are verified, never taken from arguments.
          actor TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          -- JSON: { name } | { avatar } | { edits, after }
          payload TEXT NOT NULL,
          -- A retry of the same call is the same proposal.
          fingerprint TEXT NOT NULL,
          base_revision INTEGER,
          created_at TEXT NOT NULL,
          decided_at TEXT,
          decided_by TEXT
        ) STRICT;
        CREATE INDEX persona_proposals_pool ON persona_proposals (pool_id, status, created_at);
        CREATE INDEX persona_proposals_actor ON persona_proposals (actor, created_at);
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
