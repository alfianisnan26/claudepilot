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
];

/**
 * Every column that holds sealed values. `portal rotate-key` re-seals them and `portal
 * forget-secrets` clears them, so a migration that adds one must list it here.
 */
export const ENCRYPTED_COLUMNS: EncryptedColumn[] = [{ table: 'accounts', column: 'secret', idColumn: 'id' }];
