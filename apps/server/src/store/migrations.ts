import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { backfillSegments, foldTransferPairs } from '../chat/legacy.js';
import { repairSplitChains } from '../chat/lineage.js';
import { isWorkspaceId } from '../names.js';

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
  {
    version: 100,
    name: 'built-in MCP catalogue: instances',
    up(db) {
      db.exec(`
        -- Built-in MCP catalogue (docs/prd/mcp-builtin-catalogue.md §9). One row per instance made from a code-defined template:
        -- the non-secret params it was made with, the catalog entry behind each of its servers, the Secrets & env NAMES its token
        -- slots reference (names only, never a value) and the set (pool) it made. A set deleted in the Pools hub takes its row.
        CREATE TABLE mcp_builtin_instances (
          id TEXT PRIMARY KEY,
          template_id TEXT NOT NULL,
          template_version INTEGER NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          auth TEXT NOT NULL CHECK (auth IN ('oauth', 'token')),
          params TEXT NOT NULL DEFAULT '{}',
          servers TEXT NOT NULL DEFAULT '{}',
          secret_names TEXT NOT NULL DEFAULT '{}',
          allow_private_network INTEGER NOT NULL DEFAULT 0,
          fingerprint TEXT NOT NULL,
          pool_id TEXT NOT NULL REFERENCES pools (id) ON DELETE CASCADE,
          added_at TEXT NOT NULL,
          added_by TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX mcp_builtin_instances_name ON mcp_builtin_instances (template_id, name);
        CREATE UNIQUE INDEX mcp_builtin_instances_pool ON mcp_builtin_instances (pool_id);
      `);
    },
  },
  {
    version: 120,
    name: 'workspace git: tracked repositories, events, per-workspace settings',
    up(db) {
      db.exec(`
        -- Workspace git (docs/prd/workspace-git.md §13). Nothing here is a secret. Text that came from a workspace (branch names,
        -- commit subjects, authors, remote URLs, paths) is cleaned, clipped and redacted before it is stored; remote URLs carry no
        -- credentials.
        CREATE TABLE repo_workspaces (
          workspace_id TEXT PRIMARY KEY,
          -- JSON array of folders to scan; NULL: the default ones.
          roots TEXT,
          auto INTEGER NOT NULL DEFAULT 1,
          scan_at TEXT,
          scan_ms INTEGER,
          scan_error TEXT,
          scan_truncated INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        ) STRICT;

        -- The current state of each repository, submodule, worktree, nested repository and not-cloned submodule. A repository that is no
        -- longer there keeps its row (removed_at) for the retention period, so it can come back under the same id.
        CREATE TABLE repos (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          path TEXT NOT NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('repo', 'submodule', 'worktree', 'nested', 'missing')),
          parent_id TEXT,
          main_id TEXT,
          -- JSON RepoState; NULL for a not-cloned submodule and for one that could not be read.
          state TEXT,
          error TEXT,
          -- JSON: worktree flags, what a superproject records for a submodule, drifted count.
          extra TEXT NOT NULL DEFAULT '{}',
          -- "Keep synced" (opt in, worktrees only) and what the last sync did.
          sync_enabled INTEGER NOT NULL DEFAULT 0,
          sync_at TEXT,
          sync_outcome TEXT,
          sync_note TEXT,
          first_seen_at TEXT NOT NULL,
          scanned_at TEXT NOT NULL,
          removed_at TEXT
        ) STRICT;
        CREATE UNIQUE INDEX repos_path ON repos (workspace_id, path);
        CREATE INDEX repos_workspace ON repos (workspace_id, removed_at);

        -- The audit: what scans noticed and what the portal did when asked. Kept 90 days.
        CREATE TABLE repo_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          repo_id TEXT,
          repo TEXT,
          kind TEXT NOT NULL,
          -- ui, session:<id>, ticket:<id>, portal-mcp:<token id>, portal:<what>, workspace
          actor TEXT NOT NULL,
          session_id TEXT,
          summary TEXT NOT NULL,
          data TEXT NOT NULL DEFAULT '{}'
        ) STRICT;
        CREATE INDEX repo_events_workspace ON repo_events (workspace_id, id);
        CREATE INDEX repo_events_repo ON repo_events (repo_id, id);
        CREATE INDEX repo_events_at ON repo_events (at);
      `);
    },
  },
  {
    version: 180,
    name: 'usage spend: session facts and the persona at launch',
    up(db) {
      db.exec(`
        -- Claude usage PRD §21: what attribution needs that chat_sessions and chat_usage can't keep. The usage rows
        -- stay when a session is deleted (the history does too), so the session's title and its links are kept
        -- here, from its last request, and a child's cost still rolls up into its parent after either is gone.
        CREATE TABLE usage_sessions (
          session_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          claude_id TEXT NOT NULL DEFAULT '',
          parent_id TEXT,
          ticket_id TEXT,
          title TEXT NOT NULL DEFAULT '',
          first_at_ms INTEGER NOT NULL,
          last_at_ms INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX usage_sessions_parent ON usage_sessions (parent_id) WHERE parent_id IS NOT NULL;

        -- The persona a workspace had assigned when a session's process started (a persona is a pool assigned to the
        -- workspace, not recorded per session). One row per change, never per launch: a request is attributed to the newest
        -- row at or before it. persona_id NULL: none was assigned. Requests before a session's first row are "not recorded".
        CREATE TABLE usage_persona (
          session_id TEXT NOT NULL,
          at_ms INTEGER NOT NULL,
          persona_id TEXT,
          persona_name TEXT,
          revision INTEGER,
          PRIMARY KEY (session_id, at_ms)
        ) STRICT;
      `);
      // The sessions that exist now and have requests: their links are kept from here on.
      db.exec(`
        INSERT OR IGNORE INTO usage_sessions (session_id, workspace_id, claude_id, parent_id, ticket_id, title, first_at_ms, last_at_ms)
        SELECT s.id, s.workspace_id, s.claude_id, s.parent_id, s.ticket_id, s.title, u.first_ms, u.last_ms
        FROM chat_sessions s
        JOIN (SELECT session_id, MIN(at_ms) AS first_ms, MAX(at_ms) AS last_ms FROM chat_usage GROUP BY session_id) u ON u.session_id = s.id
      `);
    },
  },
  {
    version: 181,
    name: 'usage spend: budgets',
    up(db) {
      db.exec(`
        -- Claude usage PRD §23: a daily or monthly budget for everything, one Claude or one workspace, in estimated
        -- dollars and/or tokens. Alert-only unless mode is 'pause' (opt-in). alerted: the highest level told in the
        -- period it was told for ({level, periodStartMs, atMs, quiet?}); snoozed_until_ms mutes alerts, never a pause.
        CREATE TABLE usage_budgets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          scope_kind TEXT NOT NULL CHECK (scope_kind IN ('all', 'claude', 'workspace')),
          scope_id TEXT,
          period TEXT NOT NULL CHECK (period IN ('day', 'month')),
          limit_usd REAL,
          limit_tokens INTEGER,
          mode TEXT NOT NULL DEFAULT 'alert' CHECK (mode IN ('alert', 'pause')),
          enabled INTEGER NOT NULL DEFAULT 1,
          snoozed_until_ms INTEGER,
          alerted TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (limit_usd IS NOT NULL OR limit_tokens IS NOT NULL),
          CHECK ((scope_kind = 'all') = (scope_id IS NULL))
        ) STRICT;
      `);
    },
  },
  {
    version: 182,
    name: 'usage spend: spike events and snoozes',
    up(db) {
      db.exec(`
        -- Claude usage PRD §24: what the spike heuristics noticed, each with its evidence (JSON) and the subject a snooze
        -- and the de-duplication key on (a session id for burst and outlier, a Claude id for rate). Kept 90 days.
        CREATE TABLE usage_spikes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at_ms INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('rate', 'burst', 'outlier')),
          subject TEXT NOT NULL,
          session_id TEXT,
          workspace_id TEXT NOT NULL,
          claude_id TEXT NOT NULL DEFAULT '',
          evidence TEXT NOT NULL,
          alerted INTEGER NOT NULL DEFAULT 1
        ) STRICT;
        CREATE INDEX usage_spikes_at ON usage_spikes (at_ms);
        CREATE INDEX usage_spikes_subject ON usage_spikes (kind, subject, at_ms);

        CREATE TABLE usage_spike_snoozes (
          subject TEXT PRIMARY KEY,
          until_ms INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 183,
    name: 'usage spend: owners and the audit trail',
    up(db) {
      db.exec(`
        -- Claude usage PRD §26.4 (several users are coming): a budget and a spike have an owner, and what a person changed is audited with who.
        -- 'u_owner' is the one owner of today's portal. A budget per Claude is managed by admins, a budget per workspace by that workspace's
        -- managers; a spike alert goes to the manager of what it is about.
        ALTER TABLE usage_budgets ADD COLUMN created_by TEXT NOT NULL DEFAULT 'u_owner';
        ALTER TABLE usage_spikes ADD COLUMN owner TEXT NOT NULL DEFAULT 'u_owner';

        -- Budgets made, changed, snoozed and removed, and spike snoozes. actor: who (a user id); via: how ('ui', or 'portal-mcp:<token id>').
        -- Kept 90 days. No amounts or texts from workspaces: ids and what was done.
        CREATE TABLE usage_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          actor TEXT NOT NULL DEFAULT 'u_owner',
          via TEXT NOT NULL DEFAULT 'ui',
          action TEXT NOT NULL,
          object_kind TEXT NOT NULL,
          object_id TEXT NOT NULL,
          summary TEXT NOT NULL
        ) STRICT;
        CREATE INDEX usage_audit_at ON usage_audit (at);
      `);
    },
  },
  {
    version: 170,
    name: 'usage insight: palette slots',
    up(db) {
      db.exec(`
        -- Claude usage PRD §20.6: the colour each Claude and each model keeps, everywhere. A slot (0 to 7) is given on first sight and
        -- kept; one slot per kind is held by one key at a time. Keys are the portal's own ids (a Claude's id, 'default:<workspace>' for
        -- requests recorded without a Claude, a model's id): nothing names an account.
        CREATE TABLE usage_palette (
          kind TEXT NOT NULL CHECK (kind IN ('claude', 'model')),
          key TEXT NOT NULL,
          slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 7),
          first_seen_ms INTEGER NOT NULL,
          last_seen_ms INTEGER NOT NULL,
          PRIMARY KEY (kind, key)
        ) STRICT;
        CREATE UNIQUE INDEX usage_palette_slot ON usage_palette (kind, slot);
      `);
    },
  },
  {
    version: 171,
    name: 'claude usage: projection alert marks and snooze',
    up(db) {
      db.exec(`
        -- Claude usage PRD §20.4: the "will run out before reset" alert is told once per window and period, like the threshold alerts, and
        -- has its own snooze. proj_alerted is JSON: per window, the period (its reset time) it was told for, when, the estimate, and whether it was quiet.
        ALTER TABLE claude_usage_latest ADD COLUMN proj_alerted TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE claude_usage_latest ADD COLUMN proj_snoozed_until_ms INTEGER;
      `);
    },
  },
  {
    version: 190,
    name: 'chat requests: the whole text being allowed',
    up(db) {
      db.exec(`
        -- Chat sessions PRD (approvals): the command, path or input a person is asked to allow, whole (up to 8,000 characters, redacted),
        -- beside the 200-character summary in \`detail\`; full_cut says it was cut at the cap, and a cut request can only be denied.
        -- Requests asked before this column have no text (full is NULL): they can be denied, not allowed.
        ALTER TABLE chat_requests ADD COLUMN full TEXT;
        ALTER TABLE chat_requests ADD COLUMN full_cut INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 300,
    name: 'claude code versions: history, canary runs and audit',
    up(db) {
      db.exec(`
        -- Claude Code version pinning PRD §9. One row per applied (or failed) change of a workspace's image: what Rollback reads. The runtime
        -- is the record of what a workspace runs; this keeps only the small history that cannot be read from it. actor is the portal user
        -- who acted ('u_owner' while there is one user). from_image_id lets Rollback find the old image even when its tag has moved.
        CREATE TABLE claude_version_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('upgrade', 'rollback', 'repin')),
          from_version TEXT,
          to_version TEXT,
          from_image TEXT NOT NULL,
          from_image_id TEXT,
          to_image TEXT NOT NULL,
          canary_run_id INTEGER,
          canary TEXT NOT NULL DEFAULT 'none' CHECK (canary IN ('pass', 'partial', 'fail', 'none')),
          accepted TEXT NOT NULL DEFAULT '[]',
          outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'failed', 'restored')),
          detail TEXT,
          actor TEXT NOT NULL DEFAULT 'u_owner'
        ) STRICT;
        CREATE INDEX claude_version_history_workspace ON claude_version_history (workspace_id, id);

        -- One row per canary run (manual, scheduled or before an upgrade). results is JSON: one entry per check with the real output,
        -- redacted and clipped. suite is the check suite's revision when it ran (CLAUDE_CANARY_SUITE), so two runs can be compared or not.
        CREATE TABLE claude_canary_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'upgrade')),
          subject TEXT NOT NULL CHECK (subject IN ('installed', 'candidate', 'target')),
          version TEXT,
          reported TEXT,
          image TEXT,
          mode TEXT NOT NULL CHECK (mode IN ('image', 'scratch')),
          status TEXT NOT NULL CHECK (status IN ('running', 'done', 'error', 'unavailable')),
          note TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          suite INTEGER NOT NULL,
          results TEXT NOT NULL DEFAULT '[]',
          pass INTEGER NOT NULL DEFAULT 0,
          fail INTEGER NOT NULL DEFAULT 0,
          skipped INTEGER NOT NULL DEFAULT 0,
          actor TEXT NOT NULL DEFAULT 'u_owner'
        ) STRICT;
        CREATE INDEX claude_canary_runs_subject ON claude_canary_runs (subject, id);

        -- The audit trail of this area: builds, prunes, canary starts, applies, rollbacks, the default pin. detail never holds a secret.
        CREATE TABLE claude_version_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          actor TEXT NOT NULL DEFAULT 'u_owner',
          action TEXT NOT NULL,
          workspace_id TEXT,
          version TEXT,
          detail TEXT
        ) STRICT;
      `);
    },
  },
  {
    version: 301,
    name: 'claude code versions: owner and creator columns',
    up(db) {
      db.exec(`
        -- Multi-user, light touch (authorization PRD, adoption rule 4): every new table says whose the row is (owner_id: a user id, u_owner while
        -- there is one user) and who made it (created_by: a user id). The existing actor columns stay what they were: the audit string of whoever acted
        -- (user:u_owner, portal-mcp:<token>, system:claude-canary). Migration 300 had already run on a scratch database, so this is a second migration.
        ALTER TABLE claude_version_history ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'u_owner';
        ALTER TABLE claude_version_history ADD COLUMN created_by TEXT NOT NULL DEFAULT 'u_owner';
        ALTER TABLE claude_canary_runs ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'u_owner';
        ALTER TABLE claude_canary_runs ADD COLUMN created_by TEXT NOT NULL DEFAULT 'u_owner';
        ALTER TABLE claude_version_events ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'u_owner';
      `);
    },
  },
  {
    version: 130,
    name: 'connect: targets, nodes, enrollments',
    up(db) {
      db.exec(`
        -- Connect (docs/prd/targets-connect.md §14). The registry holds hashes and public keys only: nothing here is a secret, so nothing is
        -- added to ENCRYPTED_COLUMNS. Targets are platform-owned (admins manage them; who may place a workspace on one is a right granted later):
        -- owner_id and created_by name a user id (u_owner while there is one user).
        CREATE TABLE connect_targets (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('docker', 'swarm', 'kubernetes', 'container', 'host')),
          state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active')),
          portal_url TEXT NOT NULL,
          settings TEXT NOT NULL DEFAULT '{}',
          -- The last list() of its workspaces, for the unreachable view (JSON Workspace[]).
          snapshot TEXT,
          snapshot_at TEXT,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX connect_targets_label ON connect_targets (label COLLATE NOCASE);

        CREATE TABLE connect_nodes (
          id TEXT PRIMARY KEY,
          target_id TEXT NOT NULL REFERENCES connect_targets (id) ON DELETE CASCADE,
          -- The enrollment (token) it came from, so enroll/status can follow it; the row may go before the node does.
          enrollment_id TEXT,
          name TEXT NOT NULL,
          -- Ed25519, the raw 32 bytes, base64url; the private half never leaves the agent.
          public_key TEXT NOT NULL,
          key_fingerprint TEXT NOT NULL,
          prev_public_key TEXT,
          rotated_at TEXT,
          drained INTEGER NOT NULL DEFAULT 0,
          -- The last hello and status summary. Agent text: cleaned, clipped and redacted before it is stored.
          info TEXT NOT NULL DEFAULT '{}',
          agent_version TEXT,
          agent_build TEXT,
          protocol INTEGER,
          os TEXT,
          arch TEXT,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT,
          last_ip TEXT,
          revoked_at TEXT,
          revoked_reason TEXT,
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT 'u_owner'
        ) STRICT;
        CREATE UNIQUE INDEX connect_nodes_name ON connect_nodes (target_id, name COLLATE NOCASE) WHERE revoked_at IS NULL;
        CREATE INDEX connect_nodes_target ON connect_nodes (target_id);
        CREATE INDEX connect_nodes_enrollment ON connect_nodes (enrollment_id);

        CREATE TABLE connect_enrollments (
          id TEXT PRIMARY KEY,
          target_id TEXT NOT NULL REFERENCES connect_targets (id) ON DELETE CASCADE,
          -- SHA-256 of the token, hex. The token itself is shown once and never stored.
          token_hash TEXT NOT NULL UNIQUE,
          last4 TEXT NOT NULL,
          platform TEXT NOT NULL CHECK (platform IN ('linux', 'macos', 'windows')),
          -- ConnectInstallOptions (JSON).
          params TEXT NOT NULL DEFAULT '{}',
          max_uses INTEGER NOT NULL DEFAULT 1,
          uses INTEGER NOT NULL DEFAULT 0,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          first_used_at TEXT,
          last_used_at TEXT,
          revoked_at TEXT
        ) STRICT;
        CREATE INDEX connect_enrollments_target ON connect_enrollments (target_id);
      `);
    },
  },
  {
    version: 131,
    name: 'connect: audit events and settings',
    up(db) {
      db.exec(`
        -- The audit trail (PRD FR60): lifecycle and admin actions, with the client address and never a secret. The actor is the audit string of
        -- whoever acted (user:<id>, agent:<node id>, system); detail is flat and small by construction (connect/events.ts).
        CREATE TABLE connect_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          type TEXT NOT NULL,
          target_id TEXT,
          node_id TEXT,
          enrollment_id TEXT,
          actor TEXT NOT NULL,
          ip TEXT,
          detail TEXT NOT NULL DEFAULT '{}'
        ) STRICT;
        CREATE INDEX connect_events_target ON connect_events (target_id, id);

        -- Keys: public_url, token_ttl_minutes, default_target, hidden_scanned (JSON array of ids), removed_nodes (JSON: nodes of removed targets,
        -- so an agent that comes back is told "target removed" and not "unknown node").
        CREATE TABLE connect_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      `);
    },
  },
  {
    version: 200,
    name: 'notifications and the platform audit',
    up(db) {
      db.exec(`
        -- Notifications (docs/prd/web-app-pwa.md §11.8). Per-person tables carry owner_id and created_by (a user id; u_owner while there is one
        -- user: the authorization seam's adoption rule 4). notify_keys and platform_audit are platform-wide.
        -- A destination: a Web Push device, a webhook, a Discord or a Slack channel. config is SEALED (a push endpoint and its two keys, or a
        -- channel URL and signing secret): ENCRYPTED_COLUMNS lists it. hint is a host, safe to show. endpoint_hash (SHA-256 of a push endpoint)
        -- finds the same browser registering again: a push endpoint belongs to one user at a time.
        CREATE TABLE notify_destinations (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          type TEXT NOT NULL CHECK (type IN ('push', 'webhook', 'discord', 'slack')),
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          kinds TEXT NOT NULL DEFAULT '[]',
          quiet TEXT NOT NULL,
          include_shared INTEGER NOT NULL DEFAULT 0,
          include_detail INTEGER NOT NULL DEFAULT 0,
          allow_private INTEGER NOT NULL DEFAULT 0,
          signed INTEGER NOT NULL DEFAULT 0,
          tz TEXT NOT NULL DEFAULT 'UTC',
          hint TEXT,
          unrecognised INTEGER NOT NULL DEFAULT 0,
          endpoint_hash TEXT,
          state TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'failing', 'disabled')),
          failures INTEGER NOT NULL DEFAULT 0,
          last_ok_at TEXT,
          last_error_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          config TEXT
        ) STRICT;
        CREATE INDEX notify_destinations_owner ON notify_destinations (owner_id);
        CREATE UNIQUE INDEX notify_destinations_endpoint ON notify_destinations (endpoint_hash) WHERE endpoint_hash IS NOT NULL;

        -- Platform-wide: id 'vapid' (the P-256 private key, PKCS#8, sealed; public_key in clear) and 'topic' (32 random bytes, sealed).
        -- value is NULL after \`portal forget-secrets\`: new keys are made on next use (every browser subscribes again).
        CREATE TABLE notify_keys (
          id TEXT PRIMARY KEY,
          value TEXT,
          public_key TEXT,
          created_at TEXT NOT NULL
        ) STRICT;

        -- Each person's answer switches (§11.7): Deny on, the three Allow classes off until they turn them on.
        CREATE TABLE notify_user_prefs (
          owner_id TEXT PRIMARY KEY,
          deny INTEGER NOT NULL DEFAULT 1,
          allow_read INTEGER NOT NULL DEFAULT 0,
          allow_edit INTEGER NOT NULL DEFAULT 0,
          allow_command INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        ) STRICT;

        -- The Inbox, 30 days: what a destination without detail would have got (fixed templates over names and numbers).
        CREATE TABLE notify_history (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          event_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          at TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          path TEXT,
          subject_type TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          workspace_id TEXT,
          tag TEXT NOT NULL,
          read_at TEXT,
          resolved_at TEXT,
          resolution TEXT
        ) STRICT;
        CREATE INDEX notify_history_owner ON notify_history (owner_id, at);
        CREATE INDEX notify_history_tag ON notify_history (tag);

        -- The delivery log, 30 days: a status and a fixed code (NotifyError or NotifySuppression), never a URL, a path or a provider's reply.
        -- owner_id is copied from the destination, so a user reads only their own.
        CREATE TABLE notify_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          at TEXT NOT NULL,
          event_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          destination_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'suppressed', 'held')),
          code TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          http_status INTEGER
        ) STRICT;
        CREATE INDEX notify_log_owner ON notify_log (owner_id, id);

        -- What quiet hours kept back, per destination, until the one summary at the end of the window.
        CREATE TABLE notify_held (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          destination_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          tag TEXT NOT NULL,
          at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX notify_held_destination ON notify_held (destination_id);

        -- Single-use answer tokens (§11.7): only the SHA-256 of the token is kept, bound to its user, destination, event, session, request,
        -- the decisions offered, the tool class and what the request showed (detail_hash). 10 minutes; at most 200 pending.
        CREATE TABLE notify_action_tokens (
          hash TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          destination_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          decisions TEXT NOT NULL,
          tool_class TEXT NOT NULL,
          tool_name TEXT,
          detail_hash TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT
        ) STRICT;
        CREATE INDEX notify_action_tokens_destination ON notify_action_tokens (destination_id);

        -- "Notify when done", each user's own, per session.
        CREATE TABLE notify_session_flags (
          session_id TEXT NOT NULL,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          done INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (session_id, owner_id)
        ) STRICT;

        -- The platform audit (platform-wide): every automatic act of the platform track. user_id: the person a row concerns (null: the
        -- system). detail holds names, ids, numbers and fixed codes, never a secret, a URL or message text. 90 days.
        CREATE TABLE platform_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'medium', 'high')),
          kind TEXT NOT NULL,
          actor TEXT NOT NULL,
          user_id TEXT,
          subject TEXT,
          detail TEXT NOT NULL DEFAULT '{}'
        ) STRICT;
        CREATE INDEX platform_audit_user ON platform_audit (user_id, id);
        CREATE INDEX platform_audit_kind ON platform_audit (kind, id);
      `);
    },
  },
  {
    version: 380,
    name: 'chat side questions (btw)',
    up(db) {
      db.exec(`
        -- Chat sessions PRD §20: one row per side question that started a run. Private to the person who asked (user_id; created_by is the
        -- same until a question can be asked on someone's behalf); the answer stays so Pin can use the portal's copy and a reload can show the
        -- open card. Goes with its session. No sealed values; question and answer are redacted before they are stored.
        CREATE TABLE chat_btw (
          id TEXT NOT NULL,
          session_id TEXT NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
          user_id TEXT NOT NULL DEFAULT 'u_owner',
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          actor TEXT NOT NULL DEFAULT 'user:u_owner',
          workspace_id TEXT NOT NULL,
          claude_id TEXT NOT NULL DEFAULT '',
          question TEXT NOT NULL,
          answer TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('running', 'answered', 'failed', 'cancelled')),
          reason TEXT,
          note TEXT,
          retry_after_ms INTEGER,
          model TEXT,
          ctx_messages INTEGER,
          ctx_truncated INTEGER,
          ctx_last_seq INTEGER,
          ctx_chars INTEGER,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL,
          basis TEXT,
          pinned_seq INTEGER,
          closed INTEGER NOT NULL DEFAULT 0,
          asked_at TEXT NOT NULL,
          asked_ms INTEGER NOT NULL,
          settled_at TEXT,
          PRIMARY KEY (user_id, session_id, id)
        ) STRICT;
        CREATE INDEX chat_btw_session ON chat_btw (session_id, asked_ms);

        -- A side question's usage is a row of its own among the turns' (same columns, so every total counts it): kind says which, ref is
        -- the btw's id. Additive: existing rows and queries are 'turn' and unchanged.
        ALTER TABLE chat_usage ADD COLUMN kind TEXT NOT NULL DEFAULT 'turn';
        ALTER TABLE chat_usage ADD COLUMN ref TEXT;
      `);
    },
  },
  {
    version: 210,
    name: 'triggers and their runs',
    up(db) {
      db.exec(`
        -- Triggers (docs/prd/triggers.md §13). Per-person: owner_id and created_by (a user id; u_owner while there is one user). secret
        -- (the signing secret) and path_token (the receiver path's token) are SEALED: ENCRYPTED_COLUMNS lists both. token_hash, the
        -- SHA-256 of the path token, is how the public receiver finds a trigger, so the lookup's timing says nothing about the token.
        -- spec is the source's own part (cron, webhook filters or CI filters); action, limits and approval are JSON. paused is a code
        -- ('owner_denied', 'owner_disabled') when the portal paused it, else NULL. runs counts runs so a session is "#<n>".
        CREATE TABLE triggers (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          source TEXT NOT NULL CHECK (source IN ('cron', 'webhook', 'ci_failed')),
          spec TEXT NOT NULL,
          action TEXT NOT NULL,
          limits TEXT NOT NULL,
          approval TEXT NOT NULL,
          secret TEXT,
          secret_mode TEXT NOT NULL DEFAULT 'generated' CHECK (secret_mode IN ('generated', 'provided')),
          path_token TEXT,
          token_hash TEXT,
          paused TEXT,
          runs INTEGER NOT NULL DEFAULT 0,
          next_run_at TEXT,
          last_run_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        ) STRICT;
        CREATE INDEX triggers_owner ON triggers (owner_id);
        CREATE UNIQUE INDEX triggers_token ON triggers (token_hash) WHERE token_hash IS NOT NULL;
        CREATE INDEX triggers_next ON triggers (next_run_at) WHERE next_run_at IS NOT NULL;

        -- One row per run: what the event's validated facts were (never the payload; event is at most 4 KB), how it ended and why.
        -- Kept 90 days, also after its trigger is deleted.
        CREATE TABLE trigger_runs (
          id TEXT PRIMARY KEY,
          trigger_id TEXT NOT NULL,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          number INTEGER NOT NULL DEFAULT 0,
          at TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending_approval', 'starting', 'running', 'succeeded', 'failed', 'skipped', 'denied', 'expired', 'stopped')),
          reason TEXT,
          event TEXT NOT NULL,
          delivery_id TEXT,
          session_id TEXT,
          ticket_id TEXT,
          cost_usd REAL NOT NULL DEFAULT 0,
          started_at TEXT,
          ended_at TEXT,
          expires_at TEXT,
          approved_by TEXT,
          approved_at TEXT
        ) STRICT;
        CREATE INDEX trigger_runs_trigger ON trigger_runs (trigger_id, at);
        CREATE INDEX trigger_runs_owner ON trigger_runs (owner_id, at);
        CREATE INDEX trigger_runs_state ON trigger_runs (state);
        CREATE INDEX trigger_runs_session ON trigger_runs (session_id) WHERE session_id IS NOT NULL;

        -- Platform-wide (no personal data): a delivery id seen in the last 7 days is a duplicate.
        CREATE TABLE trigger_deliveries (
          trigger_id TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          at TEXT NOT NULL,
          PRIMARY KEY (trigger_id, delivery_id)
        ) STRICT;

        -- What is counted, not stored (FR7): deliveries that did not pass the filters, duplicates, and skips beyond 120 an hour.
        CREATE TABLE trigger_counts (
          trigger_id TEXT NOT NULL,
          day TEXT NOT NULL,
          kind TEXT NOT NULL,
          n INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (trigger_id, day, kind)
        ) STRICT;
      `);
    },
  },
  {
    version: 220,
    name: 'auto transfer',
    up(db) {
      db.exec(`
        -- Auto transfer (docs/prd/auto-transfer.md §10). Per-person: owner_id and created_by (a user id; u_owner while there is one user).
        -- No secret and no message text is stored: names, ids, numbers, fixed codes. A user's own choices: each NULL follows the platform.
        CREATE TABLE autotransfer_user (
          owner_id TEXT PRIMARY KEY DEFAULT 'u_owner',
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          mode TEXT CHECK (mode IN ('off', 'ask', 'auto')),
          threshold_pct INTEGER,
          use_projection INTEGER,
          same_model_only INTEGER,
          allow_api_key INTEGER,
          updated_at TEXT NOT NULL
        ) STRICT;

        -- A Claude's own threshold and its ordered destinations (a JSON list of Claude ids: an allowlist when not empty), per person.
        CREATE TABLE autotransfer_claudes (
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          claude_id TEXT NOT NULL,
          threshold_pct INTEGER,
          destinations TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL,
          PRIMARY KEY (owner_id, claude_id)
        ) STRICT;

        -- A chat's state: its own mode (NULL follows its owner), the pause, the deferral, the last warning's period and the last refusal
        -- recorded (each is recorded once per period). owner_id is the chat's owner when the row was made.
        CREATE TABLE autotransfer_sessions (
          session_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          mode TEXT CHECK (mode IN ('off', 'ask', 'auto')),
          last_claude_id TEXT,
          paused_until TEXT,
          defer_since TEXT,
          last_eval_at TEXT,
          warned_period TEXT,
          refused_key TEXT
        ) STRICT;

        -- The card of ask mode: one open per chat.
        CREATE TABLE autotransfer_suggestions (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          session_id TEXT NOT NULL,
          at TEXT NOT NULL,
          reason TEXT NOT NULL CHECK (reason IN ('low', 'exhausted', 'projection')),
          from_claude TEXT NOT NULL,
          to_claude TEXT NOT NULL,
          alternatives TEXT NOT NULL DEFAULT '[]',
          facts TEXT NOT NULL,
          handoff TEXT NOT NULL CHECK (handoff IN ('ask', 'skip')),
          dropped TEXT NOT NULL,
          why TEXT,
          state TEXT NOT NULL CHECK (state IN ('open', 'moved', 'later', 'always', 'expired', 'superseded')),
          resolved_at TEXT
        ) STRICT;
        CREATE INDEX autotransfer_suggestions_session ON autotransfer_suggestions (session_id, state);
        CREATE INDEX autotransfer_suggestions_owner ON autotransfer_suggestions (owner_id, at);

        -- The trail. Kept 90 days. from_claude / to_claude are JSON {id, name} (a Claude's name as it was then).
        CREATE TABLE autotransfer_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          session_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('suggested', 'moved', 'declined', 'deferred', 'warned', 'refused', 'failed', 'undone', 'mode_set')),
          mode TEXT NOT NULL,
          reason TEXT,
          from_claude TEXT,
          to_claude TEXT,
          facts TEXT,
          handoff TEXT,
          handoff_id TEXT,
          code TEXT,
          actor TEXT NOT NULL
        ) STRICT;
        CREATE INDEX autotransfer_events_session ON autotransfer_events (session_id, at);
        CREATE INDEX autotransfer_events_owner ON autotransfer_events (owner_id, at);
      `);
    },
  },
  {
    version: 610,
    name: 'CI environments and deployments (approval before a deployment)',
    up(db) {
      db.exec(`
        -- Environments and deployments (docs/prd/local-git-ci.md FR41, §12). An environment belongs to a CI remote and is made PROTECTED the
        -- first time a pipeline names it: a job that deploys there waits for a person's approval. A deployment is one run's job tied to an
        -- environment; run facts are copied in so the history outlives the run record. gate_key is the one-time key the runner needs to let
        -- that job start: random, useless outside its run, never shown or logged, and cleared as soon as the job is decided or the run is over.
        CREATE TABLE ci_environments (
          id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL,
          name TEXT NOT NULL,
          protected INTEGER NOT NULL DEFAULT 1 CHECK (protected IN (0, 1)),
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          updated_by TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX ci_environments_name ON ci_environments (repo_id, name);

        CREATE TABLE ci_deployments (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          run_number INTEGER NOT NULL,
          job TEXT NOT NULL,
          repo_id TEXT NOT NULL,
          environment TEXT NOT NULL,
          pipeline TEXT NOT NULL,
          sha TEXT NOT NULL,
          ref TEXT NOT NULL,
          actor TEXT NOT NULL,
          approval TEXT NOT NULL CHECK (approval IN ('pending', 'waiting', 'approved', 'rejected', 'auto', 'expired', 'skipped')),
          gate_key TEXT,
          decided_by TEXT,
          decided_at TEXT,
          outcome TEXT,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          created_at TEXT NOT NULL,
          UNIQUE (run_id, job)
        ) STRICT;
        CREATE INDEX ci_deployments_env ON ci_deployments (repo_id, environment, created_at);
      `);
    },
  },
  {
    version: 713,
    name: 'workspace labels and the aliases a rename leaves',
    up(db) {
      // T-42 slice 2 (docs/prd/targets-connect.md §24.3): the name becomes a label people can change. `label` is the name shown, null until a
      // first rename (the name it was made with). A rename also leaves an alias `<target>/<label>` that resolves to the workspace for as long
      // as it lives, so every form it was ever called by keeps working; the alias is released (released_at) when the workspace is removed,
      // never reused while it lives. The key name in `legacy_id` and the runtime name never change.
      db.exec(`
        ALTER TABLE workspace_identities ADD COLUMN label TEXT;
        CREATE TABLE workspace_aliases (
          alias TEXT NOT NULL,
          workspace_id TEXT NOT NULL REFERENCES workspace_identities (id),
          created_at TEXT NOT NULL,
          released_at TEXT
        ) STRICT;
        CREATE UNIQUE INDEX workspace_aliases_live ON workspace_aliases (lower(alias)) WHERE released_at IS NULL;
        CREATE INDEX workspace_aliases_workspace ON workspace_aliases (workspace_id);
      `);
    },
  },
  {
    version: 714,
    name: 'workspace references move to the stable id: the progress of the background rewrite',
    up(db) {
      // T-42 slice 3 (docs/prd/targets-connect.md §24.4): stored workspace references move from `<target>/<name>` to the stable id, lazily
      // (converted modules write the id on save and read either form) and by a one-time background rewrite, column by column. A row here
      // says a column was rewritten to the end (done_at) and how many rows changed; a run stopped half way leaves no row and starts again,
      // which is safe: only rows still holding a key are touched, one at a time, each only if it still holds that key.
      db.exec(`
        CREATE TABLE workspace_ref_rewrites (
          table_name TEXT NOT NULL,
          column_name TEXT NOT NULL,
          rewritten INTEGER NOT NULL DEFAULT 0,
          done_at TEXT NOT NULL,
          PRIMARY KEY (table_name, column_name)
        ) STRICT;
      `);
    },
  },
  {
    version: 716,
    name: 'workspace resources: the wanted CPU and memory on the workspace record',
    up(db) {
      // T-98 (docs/prd/targets-connect.md §25): the CPU and memory someone set for a Kubernetes workspace, kept on its record until they are
      // applied and after. `resources` is JSON `{ cpus, memoryMb, cpuRequest, memoryRequestMb }` (cores and MiB), null until a first change;
      // `resources_pending_at` is set while they wait for the workspace's next start; `resources_applied_at` is when they reached the
      // Deployment. Existing workspaces get nulls: they keep what they have until someone applies.
      db.exec(`
        ALTER TABLE workspace_identities ADD COLUMN resources TEXT;
        ALTER TABLE workspace_identities ADD COLUMN resources_pending_at TEXT;
        ALTER TABLE workspace_identities ADD COLUMN resources_applied_at TEXT;
      `);
    },
  },
  {
    version: 720,
    name: 'notify: ci_waiting (Deploy waits) for every destination that already hears CI failures',
    up(db) {
      // A destination keeps an explicit list of kinds, filled from the defaults when it is made (notify/destinations.ts), so a device
      // registered before the kind `ci_waiting` existed (docs/prd/local-git-ci.md FR41) would never hear "Deploy waits". Whoever hears
      // `ci_failed` hears deploys that wait too; a destination that opted out of CI stays out. Only the list changes; a list that already
      // has it is left alone, so running this twice is the same as once.
      const rows = db.prepare('SELECT id, kinds FROM notify_destinations').all() as { id: string; kinds: string }[];
      const write = db.prepare('UPDATE notify_destinations SET kinds = ? WHERE id = ?');
      for (const r of rows) {
        let kinds: unknown;
        try {
          kinds = JSON.parse(r.kinds);
        } catch {
          continue; // a list that cannot be read is not guessed at
        }
        if (!Array.isArray(kinds) || !kinds.includes('ci_failed') || kinds.includes('ci_waiting')) continue;
        write.run(JSON.stringify([...kinds, 'ci_waiting']), r.id);
      }
    },
  },
  {
    version: 711,
    name: 'actor label on CI runs and repository events',
    up(db) {
      // T-6: a Portal MCP token's label as it was when the token acted ("MCP client “relay”"), kept next to the actor string so a later
      // rename or revoke of the token changes nothing already stored. Null for everything so far and for every actor that is not a token.
      db.exec('ALTER TABLE ci_runs ADD COLUMN actor_label TEXT');
      db.exec('ALTER TABLE repo_events ADD COLUMN actor_label TEXT');
    },
  },
  {
    version: 712,
    name: 'workspace identities: a stable id per workspace, its alias and its stored runtime name',
    up(db) {
      // T-42 (docs/prd/targets-connect.md §24): an identity must not be a name. One row per workspace the portal has known: `id` is `ws_`
      // and 12 hex digits, never changed and never reused (a removed workspace keeps its row, `removed_at` set); `legacy_id` is the old
      // `<target>/<name>`, the alias that resolves for ever, held by at most one live workspace; `runtime_name` is what the runtime calls it
      // (container, Deployment; the volume is `<runtime_name>-home`), stored and never recomputed from the name.
      db.exec(`
        CREATE TABLE workspace_identities (
          id TEXT PRIMARY KEY,
          target TEXT NOT NULL,
          name TEXT NOT NULL,
          legacy_id TEXT NOT NULL,
          runtime_name TEXT,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          created_at TEXT NOT NULL,
          removed_at TEXT
        ) STRICT;
        CREATE UNIQUE INDEX workspace_identities_live ON workspace_identities (legacy_id) WHERE removed_at IS NULL;
        CREATE INDEX workspace_identities_alias ON workspace_identities (legacy_id, created_at);
      `);
      // The workspaces the portal already knows (delivery's rows and the pool assignments) get their id now. Only rows are added; nothing
      // existing changes. The runtime name stays null here, because only the runtime knows it: the manager fills it from the runtime's own
      // list the first time it sees the workspace (`kubernetes/kohi-event` -> `ws-kohi-event`), and until then the runtimes name it as before.
      const known = db
        .prepare('SELECT workspace_id FROM workspace_delivery UNION SELECT workspace_id FROM assignments UNION SELECT workspace_id FROM account_assignments')
        .all() as { workspace_id: string }[];
      const insert = db.prepare('INSERT INTO workspace_identities (id, target, name, legacy_id, created_at) VALUES (?, ?, ?, ?, ?)');
      const at = new Date().toISOString();
      const taken = new Set<string>();
      for (const { workspace_id: legacy } of known) {
        if (!isWorkspaceId(legacy)) continue; // not a workspace id (QA-032): nothing to give an identity
        let id = '';
        while (!id || taken.has(id)) id = `ws_${randomBytes(6).toString('hex')}`;
        taken.add(id);
        const slash = legacy.indexOf('/');
        insert.run(id, legacy.slice(0, slash), legacy.slice(slash + 1), legacy, at);
      }
    },
  },
  {
    version: 721,
    name: 'notify: mute rules ("Mute similar") and the muted mark on the history',
    up(db) {
      db.exec(`
        -- Mute rules (T-25, docs/prd/web-app-pwa.md §11.11): one person's rule hushes events of a kind, optionally narrowed to one scope
        -- (a subject, or a CI run's repository, pipeline or environment) and to one destination; it may expire. confirmed = 1 only for a rule
        -- on a guarded kind (approval, ci_waiting) the person picked in Settings and confirmed; the pipeline ignores a guarded rule without it.
        CREATE TABLE notify_mutes (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          kind TEXT NOT NULL,
          scope_type TEXT,
          scope_id TEXT,
          scope_label TEXT,
          destination_id TEXT,
          confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
          created_at TEXT NOT NULL,
          expires_at TEXT,
          hushed INTEGER NOT NULL DEFAULT 0,
          last_hushed_at TEXT
        ) STRICT;
        CREATE INDEX notify_mutes_owner ON notify_mutes (owner_id, kind);

        -- A muted event is still stored in the Inbox, marked, and left out of the list and the unread count by default. The narrowest scope
        -- of the event is kept with it, so "Mute similar" on an old item knows what to offer without the event's facts.
        ALTER TABLE notify_history ADD COLUMN muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1));
        ALTER TABLE notify_history ADD COLUMN scope_type TEXT;
        ALTER TABLE notify_history ADD COLUMN scope_id TEXT;
        ALTER TABLE notify_history ADD COLUMN scope_label TEXT;
      `);
    },
  },
  {
    version: 730,
    name: 'CI: the state each message to a session reports',
    up(db) {
      // T-32: CI now reports passed, cancelled and waiting runs too, each once per run and state, so a message row says which state it
      // was about. Rows written before it were all failures.
      db.exec('ALTER TABLE ci_messages ADD COLUMN state TEXT');
      db.exec("UPDATE ci_messages SET state = 'failed' WHERE state IS NULL");
      db.exec('CREATE INDEX ci_messages_run ON ci_messages (run_id, state)');
    },
  },
  {
    version: 731,
    name: 'CI: who cancelled a run, and why',
    up(db) {
      // T-95: a cancelled run said only "cancelled". Now the actor who cancelled it (as `actor` is stored), a token's label as it was, and a
      // short note (a stale run cancelled for a newer one says which). Null for every run so far and for runs nobody cancelled.
      db.exec('ALTER TABLE ci_runs ADD COLUMN cancelled_by TEXT');
      db.exec('ALTER TABLE ci_runs ADD COLUMN cancelled_by_label TEXT');
      db.exec('ALTER TABLE ci_runs ADD COLUMN cancel_note TEXT');
    },
  },
  {
    version: 381,
    name: 'chat sessions pinned',
    up(db) {
      // Chat sessions PRD FR2: a pinned session leads its group and the Pinned chip lists it. Null for everything so far.
      db.exec('ALTER TABLE chat_sessions ADD COLUMN pinned_at TEXT');
    },
  },
  {
    version: 382,
    name: 'chat sub-agents: the model, and their own transcript',
    up(db) {
      // Chat sessions PRD, the Agents panel: the model a sub-agent runs on as Claude Code reported it (null: unavailable), and an index for
      // reading one sub-agent's own lines (the events whose parent_tool_use_id is its Task call) without walking the whole transcript.
      db.exec(`
        ALTER TABLE chat_tasks ADD COLUMN model TEXT;
        CREATE INDEX chat_events_parent ON chat_events (session_id, parent_tool_use_id, seq) WHERE parent_tool_use_id IS NOT NULL;
      `);
    },
  },
  {
    version: 755,
    name: 'chat sessions: the restart hint, hidden until the next change, and applying tool changes by itself',
    up(db) {
      // T-102: "Hide until the next change" remembers the change it hid (null: shown); "Apply tool changes at the next turn end" is the
      // person's choice for this session (null: the default, on for an autonomous session). Null for every session so far.
      db.exec('ALTER TABLE chat_sessions ADD COLUMN config_hidden_at TEXT');
      db.exec('ALTER TABLE chat_sessions ADD COLUMN auto_apply INTEGER');
    },
  },
  {
    version: 760,
    name: 'auto move: the wait for quota and the steer, per chat (T-105)',
    up(db) {
      // T-105 (docs/prd/auto-transfer.md FR10a, FR4a): a chat at or under the threshold with nowhere to go keeps a waiting state the engine
      // re-evaluates by itself (restart-safe: `pending()` wakes it); a chat told mid-turn to finish and stop remembers the period, so it is told once.
      db.exec(`
        ALTER TABLE autotransfer_sessions ADD COLUMN waiting_since TEXT;
        ALTER TABLE autotransfer_sessions ADD COLUMN waiting_code TEXT;
        ALTER TABLE autotransfer_sessions ADD COLUMN steered_period TEXT;
      `);
      // The trail takes the new kinds (waiting, resumed, steered, continued, dry_run): SQLite can't change a CHECK, so the table is rebuilt
      // with every row and id kept (the migration runs in the store's transaction).
      db.exec(`
        CREATE TABLE autotransfer_events_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          session_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('suggested', 'moved', 'declined', 'deferred', 'warned', 'refused', 'failed', 'undone', 'mode_set', 'waiting', 'resumed', 'steered', 'continued', 'dry_run')),
          mode TEXT NOT NULL,
          reason TEXT,
          from_claude TEXT,
          to_claude TEXT,
          facts TEXT,
          handoff TEXT,
          handoff_id TEXT,
          code TEXT,
          actor TEXT NOT NULL
        ) STRICT;
        INSERT INTO autotransfer_events_new (id, at, owner_id, created_by, session_id, workspace_id, kind, mode, reason, from_claude, to_claude, facts, handoff, handoff_id, code, actor)
          SELECT id, at, owner_id, created_by, session_id, workspace_id, kind, mode, reason, from_claude, to_claude, facts, handoff, handoff_id, code, actor FROM autotransfer_events;
        DROP TABLE autotransfer_events;
        ALTER TABLE autotransfer_events_new RENAME TO autotransfer_events;
        CREATE INDEX autotransfer_events_session ON autotransfer_events (session_id, at);
        CREATE INDEX autotransfer_events_owner ON autotransfer_events (owner_id, at);
      `);
    },
  },
  {
    version: 761,
    name: 'chat sessions: the model a chat had before a move changed it (T-109)',
    up(db) {
      // T-109: a move to a Claude without the chat's model applies the best model it has; the row keeps what APPLIES (`model`) and what the
      // chat had before (`original_model`, null when they are the same family), so a later move can go back to it.
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN original_model TEXT;`);
    },
  },
  {
    version: 770,
    name: 'chat sessions: the session a row continues',
    up(db) {
      // T-136 part E (D-30): a chat that ended and went on in a NEW row is one logical unit; the later row names the one it continues.
      // Null for every row so far (migration 772 links the chains split on 2026-10-13).
      db.exec(`
        ALTER TABLE chat_sessions ADD COLUMN continued_from TEXT;
        CREATE INDEX chat_sessions_continued_from ON chat_sessions (continued_from) WHERE continued_from IS NOT NULL;
      `);
    },
  },
  {
    version: 771,
    name: 'chat control lines: a digest of the first response read',
    up(db) {
      // T-136 part A: a second control response for a request the portal asked or answered is ignored when it is the same as the first
      // (the same line read again) and ends the session otherwise; the first one's digest (sha256 of the parsed reply) tells them apart.
      // Null for the lines so far: a second response to one of them still ends the session.
      db.exec('ALTER TABLE chat_inputs ADD COLUMN digest TEXT');
    },
  },
  {
    version: 772,
    name: 'chat sessions: link the chains split on 2026-10-13',
    up(db) {
      // T-136 part E, the one-time repair the owner asked for on the ticket: fe3df8bc -> fdb140be -> 5c9fcb5f (the orchestrator) and
      // 541948a5 -> 929ae1e3 (Konfersi), matched by id prefix only when exactly one row matches; a no-op on any other database.
      repairSplitChains(db);
    },
  },
  {
    version: 780,
    name: 'CI: the auto-approve rule of an environment, and its verdict on each deployment',
    up(db) {
      // T-110 slice 1 (local-git-ci PRD FR41a): an environment's auto-approve mode, set only by a person ('off' for every environment so
      // far and for new ones; 'dry' says what the rule WOULD do and approves nothing; 'on' is reserved for slice 2 and the service treats it
      // as 'dry' until then), its allowed window (null: always) and its 'needs a person' path list (null: the defaults). Each deployment
      // keeps the rule's verdict and its one line (null: the rule did not look, as for every deployment so far).
      db.exec(`
        ALTER TABLE ci_environments ADD COLUMN auto_approve TEXT NOT NULL DEFAULT 'off' CHECK (auto_approve IN ('off', 'dry', 'on'));
        ALTER TABLE ci_environments ADD COLUMN auto_window TEXT;
        ALTER TABLE ci_environments ADD COLUMN auto_paths TEXT;
        ALTER TABLE ci_deployments ADD COLUMN auto_verdict TEXT CHECK (auto_verdict IN ('would', 'would_not'));
        ALTER TABLE ci_deployments ADD COLUMN auto_line TEXT;
        ALTER TABLE ci_deployments ADD COLUMN auto_at TEXT;
      `);
    },
  },
  {
    version: 790,
    name: 'keep going: a policy per chat, its trail and its reports',
    up(db) {
      // T-259 slice 1 (T-104, T-108 item 1): the watchdog inside the portal. `keepgoing_policies` is a person's choice for one chat (off by
      // default) and the sweep's own state (when the chat is next due, the idle period already nudged, a continue owed after a wake, a
      // back-off), so a portal restart resumes where it was. `keepgoing_events` is the trail (one row per action, fixed sentences, never message
      // text): the counts per 24 h are read from it. `keepgoing_reports` holds one row per chat and cause (`cleared_at` null while the cause
      // stands), so a cause is reported once (a notification and a ticket) and not again until it has cleared; when it comes back, its ticket
      // gets a comment while it is open.
      db.exec(`
        CREATE TABLE keepgoing_policies (
          session_id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          created_by TEXT NOT NULL DEFAULT 'u_owner',
          enabled INTEGER NOT NULL DEFAULT 0,
          nudge_after_min INTEGER NOT NULL DEFAULT 4,
          prompt TEXT,
          status_file TEXT,
          max_nudges INTEGER NOT NULL DEFAULT 60,
          max_wakes INTEGER NOT NULL DEFAULT 20,
          next_due_at TEXT,
          nudged_period TEXT,
          continue_owed INTEGER NOT NULL DEFAULT 0,
          backoff_until TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX keepgoing_policies_due ON keepgoing_policies (next_due_at) WHERE enabled = 1;
        CREATE TABLE keepgoing_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          at TEXT NOT NULL,
          kind TEXT NOT NULL,
          cause TEXT,
          reason TEXT NOT NULL,
          actor TEXT NOT NULL
        ) STRICT;
        CREATE INDEX keepgoing_events_session ON keepgoing_events (session_id, at);
        CREATE TABLE keepgoing_reports (
          session_id TEXT NOT NULL,
          cause TEXT NOT NULL,
          owner_id TEXT NOT NULL DEFAULT 'u_owner',
          since TEXT NOT NULL,
          reported_at TEXT NOT NULL,
          cleared_at TEXT,
          ticket_id TEXT,
          PRIMARY KEY (session_id, cause)
        ) STRICT;
      `);
    },
  },
  {
    version: 791,
    name: 'notify: keepgoing_attention (Keep going) for every destination that hears failed sessions',
    up(db) {
      // As migration 720 did for ci_waiting: a destination keeps an explicit list of kinds, so one made before `keepgoing_attention` existed
      // would never hear it. Whoever hears `session_failed` (a chat in trouble) hears Keep going's reports too; a destination that opted out
      // of failed sessions stays out. Only the list changes; a list that has it already is left alone (twice is once).
      const rows = db.prepare('SELECT id, kinds FROM notify_destinations').all() as { id: string; kinds: string }[];
      const write = db.prepare('UPDATE notify_destinations SET kinds = ? WHERE id = ?');
      for (const r of rows) {
        let kinds: unknown;
        try {
          kinds = JSON.parse(r.kinds);
        } catch {
          continue; // a list that cannot be read is not guessed at
        }
        if (!Array.isArray(kinds) || !kinds.includes('session_failed') || kinds.includes('keepgoing_attention')) continue;
        write.run(JSON.stringify([...kinds, 'keepgoing_attention']), r.id);
      }
    },
  },
  {
    version: 732,
    name: 'CI: the flaky tests a gate saw, and the ticket of each',
    up(db) {
      // T-95 item 4: a gate that passed only because a failing test passed when its file ran again alone writes `flaky, passed on rerun:
      // <file>;<test name>` in its log. One row per run and test (a run read twice counts once); the ticket of a test is the one its latest
      // sighting names, so a second sighting comments there instead of opening another. Not pruned with the runs: the count outlives them.
      db.exec(`
        CREATE TABLE ci_flaky (
          run_id TEXT NOT NULL,
          repo TEXT NOT NULL,
          job TEXT NOT NULL,
          file TEXT NOT NULL,
          test TEXT NOT NULL,
          ticket_id TEXT,
          at TEXT NOT NULL,
          PRIMARY KEY (run_id, repo, file, test)
        ) STRICT;
        CREATE INDEX ci_flaky_test ON ci_flaky (repo, file, test, at);
      `);
    },
  },
  {
    version: 805,
    name: 'chat sessions: what an integrity ending was for',
    up(db) {
      // T-136 slice 2 (recover in place): the case an integrity ending is recorded under, its classification (harmless or suspicious),
      // the line's origin in words and whether the session was in Bypass, as JSON (chat/integrity.ts EndingRecord). Never the line's text.
      // Null for every row so far: those are classified from their reason.
      db.exec('ALTER TABLE chat_sessions ADD COLUMN ended_for TEXT');
    },
  },
  {
    version: 810,
    name: 'claude usage: a limit reported by a chat',
    up(db) {
      // T-255: a chat answered with Claude Code's limit message ("You've hit your session limit · resets 11pm (UTC)"). JSON: the window, when,
      // until when (the stated reset, or the next 5-hour boundary when none could be read: guessed) and the chat. The Claude counts as used up
      // for that window until then, whatever a probe reads meanwhile.
      db.exec('ALTER TABLE claude_usage_latest ADD COLUMN limit_report TEXT');
    },
  },
  {
    version: 820,
    name: 'chat sessions: the control state that decides integrity',
    up(db) {
      // T-277 layer 2: after a portal restart the portal does not infer. The state the integrity checks decide by, for the process the row
      // follows, as JSON (chat/integrity.ts StoredControl): the process it belongs to, the expected mode and its transition flags (plan
      // entered or approved to leave, the mode before plan), the id of a Bypass request sent under the grant whose reply was not read yet,
      // and the sub-agent SendMessage causes a peer line may follow (ids and sha256 digests, never text). Written with the line that changes
      // it (one transaction with the byte offset), cleared when the process is over; null for every row so far (the row's mode is used).
      db.exec('ALTER TABLE chat_sessions ADD COLUMN control_state TEXT');
    },
  },
  {
    version: 830,
    name: 'chat requests: the process that raised each one',
    up(db) {
      // T-284: a request raised by a process that is no longer the live one (a move, a restart, a crash, a resume) can never be answered;
      // it is resolved `stale` instead of keeping the chat waiting. The process it belongs to, as integrity.ts controlProc (Claude Code
      // session id, segment, process start: ids only, never text). Null for every row so far: those are judged by their time against the
      // live process's start.
      db.exec('ALTER TABLE chat_requests ADD COLUMN proc TEXT');
    },
  },
  {
    version: 840,
    name: 'settings: the agent policy each workspace last received',
    up(db) {
      // T-285: the agent policy's env (sub-agent cache and caps, output caps; names and values, none secret) as it last
      // landed in each workspace's policy drop-in, so the page shows the value in effect, or "unavailable" when none landed.
      db.exec(`
        CREATE TABLE policy_env_state (
          workspace_id TEXT PRIMARY KEY,
          env TEXT NOT NULL,
          changed_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 850,
    name: 'efficiency lab: slices, requests and tool calls',
    up(db) {
      // T-287 slice 1 (docs/prd/claude-usage.md §28): what the session stream says about each SLICE (a sub-agent thread, or one main-thread
      // turn), in counts and ids only, never text. A request is one assistant message (deduplicated by its id, the last report wins, as in
      // docs/dev-sessions/overhaul/evidence/slice_metrics.py); a tool row is one tool call with its class and the size of its result.
      db.exec(`
        CREATE TABLE lab_slices (
          session_id TEXT NOT NULL,
          slice_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('agent', 'turn')),
          ticket TEXT,
          role TEXT,
          model TEXT,
          started_ms INTEGER,
          PRIMARY KEY (session_id, slice_id)
        ) STRICT;
        CREATE TABLE lab_requests (
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          slice_id TEXT NOT NULL,
          at_ms INTEGER,
          model TEXT,
          input INTEGER NOT NULL DEFAULT 0,
          cache_read INTEGER NOT NULL DEFAULT 0,
          cache_write_5m INTEGER NOT NULL DEFAULT 0,
          cache_write_1h INTEGER NOT NULL DEFAULT 0,
          cache_write INTEGER NOT NULL DEFAULT 0,
          output INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (session_id, message_id)
        ) STRICT;
        CREATE INDEX lab_requests_slice ON lab_requests (session_id, slice_id);
        CREATE INDEX lab_requests_at ON lab_requests (at_ms);
        CREATE TABLE lab_tools (
          session_id TEXT NOT NULL,
          tool_use_id TEXT NOT NULL,
          slice_id TEXT,
          tool TEXT,
          class TEXT,
          rtk INTEGER NOT NULL DEFAULT 0,
          at_ms INTEGER,
          results INTEGER NOT NULL DEFAULT 0,
          result_chars INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (session_id, tool_use_id)
        ) STRICT;
        CREATE INDEX lab_tools_slice ON lab_tools (session_id, slice_id);
      `);
    },
  },
  {
    version: 851,
    name: 'efficiency lab: experiments and arm assignments',
    up(db) {
      // T-287 slice 1: an experiment is a named change with its arms, a start, a stop and its rules written before the start; a randomized one
      // assigns each slice an arm when the slice starts (balanced per stratum), a before-and-after one splits its window at `switch_ms`.
      // `excluded` takes a slice out of the analysis with a reason (an outage). Thresholds and guardrails are JSON the person wrote.
      db.exec(`
        CREATE TABLE lab_experiments (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          hypothesis TEXT NOT NULL DEFAULT '',
          design TEXT NOT NULL CHECK (design IN ('randomized', 'before_after')),
          arms TEXT NOT NULL,
          primary_metric TEXT NOT NULL,
          guardrails TEXT NOT NULL DEFAULT '[]',
          thresholds TEXT NOT NULL DEFAULT '{}',
          min_n INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK (status IN ('running', 'stopped', 'decided')),
          start_ms INTEGER NOT NULL,
          stop_ms INTEGER,
          switch_ms INTEGER,
          decision TEXT CHECK (decision IN ('adopt', 'reject', 'iterate')),
          verdict TEXT,
          created_ms INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE lab_assignments (
          experiment_id TEXT NOT NULL REFERENCES lab_experiments(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL,
          slice_id TEXT NOT NULL,
          arm TEXT,
          stratum TEXT NOT NULL DEFAULT '',
          assigned_ms INTEGER NOT NULL,
          excluded TEXT,
          PRIMARY KEY (experiment_id, session_id, slice_id)
        ) STRICT;
        CREATE INDEX lab_assignments_stratum ON lab_assignments (experiment_id, stratum);
      `);
    },
  },
  {
    version: 792,
    name: 'keep going: a program per policy and the pause switch',
    up(db) {
      // T-259 slice 3 (the program pause switch): a policy may name its program (a slug like the supervisor's track keys), and
      // `keepgoing_pauses` holds the pauses that stand, one row per program (`*` for all) with a person's one-line reason, since when and
      // who. A paused chat is looked at but nothing is done for it; deleting the row resumes it.
      db.exec(`
        ALTER TABLE keepgoing_policies ADD COLUMN program TEXT;
        CREATE TABLE keepgoing_pauses (
          scope TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          since TEXT NOT NULL,
          by TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 781,
    name: 'CI: the mode the auto-approve rule judged in, on each deployment',
    up(db) {
      // T-110 slice 2 (local-git-ci PRD FR41a): the rule now approves for real in mode 'on'. Each deployment keeps the mode its verdict was
      // made in, so the run page and the audit never mistake a dry WOULD for a real approval. Null: the verdict was made before this column
      // (slice 1 knew only 'dry') or the rule did not look.
      db.exec(`ALTER TABLE ci_deployments ADD COLUMN auto_mode TEXT CHECK (auto_mode IN ('dry', 'on'));`);
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
  { table: 'notify_destinations', column: 'config', idColumn: 'id' },
  { table: 'notify_keys', column: 'value', idColumn: 'id' },
  { table: 'triggers', column: 'secret', idColumn: 'id' },
  { table: 'triggers', column: 'path_token', idColumn: 'id' },
];
