// Chat sessions: the database layer (chat-sessions PRD §9). Synchronous over `node:sqlite`, redacted,
// and never a secret — only allowlisted fields of each event are kept, every stored text passes the
// credential redactor (redact.ts), and large text is truncated.

import type { WorkspaceRefs } from '../workspaces/identity.js';
import type {
  WorkspaceClaude,
  ChatAuditEntry,
  ChatEndedFor,
  ChatEvent,
  ChatEventKind,
  ChatImage,
  ChatInputState,
  ChatOrigin,
  ChatPermissionMode,
  ChatPinnedBtw,
  ChatRequest,
  ChatSession,
  ChatSegment,
  ChatSessionState,
  ChatTask,
  ChatWorktree,
} from '@portal/contracts';
import { TASK_EVENTS_MAX } from '@portal/contracts';
import { createHash, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { Store } from '../store/store.js';
import { HOME } from '../workspaces/runtime.js';
import { mapInputStrings, type ModelTotals, type StoredEvent, type TaskPatch } from './protocol.js';
import { fileRefs } from './artifacts/records.js';
import { lineageOf, type Lineage } from './lineage.js';
import { readEnding } from './integrity.js';
import { redact, redactMaybe } from './redact.js';

/**
 * The folder a session runs in: its stored folder made absolute (from the home folder) and tidied, or
 * the home folder when none is stored. The same folder Files opens (files.ts `sessionFolder`), the trust
 * check scans and the process starts in.
 */
export function sessionCwd(stored: string | null | undefined): string {
  const cwd = typeof stored === 'string' ? stored.trim() : '';
  return cwd ? posix.resolve(HOME, cwd) : HOME;
}

/** A raw `chat_sessions` row; the controller reads `segment`/`byte_offset`/`cwd`/`process` from it. */
export type ChatSessionRow = {
  id: string;
  workspace_id: string;
  cwd: string;
  title: string;
  origin: string;
  state: string;
  state_since: string;
  process: string;
  parent_pid: number | null;
  process_started_at: string | null;
  segment: number;
  byte_offset: number;
  last_seq: number;
  model: string | null;
  mode: string;
  effort: string | null;
  ultracode: number;
  ultracode_available: number;
  cost_est_usd: number;
  budget_usd: number | null;
  turns: number;
  context_used: number | null;
  context_window: number | null;
  created_at: string;
  last_activity_at: string;
  ended_reason: string | null;
  /** T-136 slice 2: what an integrity ending was for (an `EndingRecord` as JSON); null otherwise and for rows ended before migration 805. */
  ended_for?: string | null;
  archived_at: string | null;
  pinned_at?: string | null;
  /** T-102: the hint hidden until a change newer than this; null: shown. */
  config_hidden_at?: string | null;
  /** T-102: "Apply tool changes at the next turn end" as the person set it (1 on, 0 off); null: the default. */
  auto_apply?: number | null;
  claude_id?: string | null;
  predecessor_id?: string | null;
  successor_id?: string | null;
  continued_from?: string | null;
  ticket_id?: string | null;
  parent_id?: string | null;
  started_by?: string | null;
  worktree_path?: string | null;
  worktree_branch?: string | null;
  worktree_repo?: string | null;
  bypass_capable?: number | null;
  claude_session_id?: string | null;
  cost_base_usd?: number | null;
  segment_seq?: number | null;
};

/** The Claude Code session id of the run that is going now: the session's own id for every session before Claudes could be switched. */
export const claudeSessionOf = (row: Pick<ChatSessionRow, 'id' | 'claude_session_id'>): string => row.claude_session_id || row.id;

type EventRow = {
  seq: number;
  at: string;
  kind: string;
  uuid: string | null;
  parent_tool_use_id: string | null;
  request_id: string | null;
  payload: string;
};

type TaskRow = {
  task_id: string;
  tool_use_id: string | null;
  label: string | null;
  subagent_type: string | null;
  model: string | null;
  status: string | null;
  tokens: number | null;
  tool_uses: number | null;
  duration_ms: number | null;
  summary: string | null;
  started_at: string | null;
  ended_at: string | null;
};

const TASK_COLUMNS = 'task_id, tool_use_id, label, subagent_type, model, status, tokens, tool_uses, duration_ms, summary, started_at, ended_at';

function taskOut(r: TaskRow): ChatTask {
  return {
    taskId: r.task_id,
    toolUseId: r.tool_use_id,
    description: r.label ?? '',
    subagentType: r.subagent_type,
    model: r.model,
    status: r.status && TASK_STATUSES.has(r.status) ? (r.status as ChatTask['status']) : 'running',
    tokens: r.tokens,
    toolUses: r.tool_uses,
    durationMs: r.duration_ms,
    summary: r.summary,
    startedAt: r.started_at ?? '',
    endedAt: r.ended_at,
  };
}

type RequestRow = {
  request_id: string;
  tool_use_id: string | null;
  kind: string;
  tool_name: string | null;
  agent_label: string | null;
  title: string;
  detail: string | null;
  full: string | null;
  full_cut: number;
  created_at: string;
};

/** Fields `patchSession` can change. `cost` is absolute; `turnsDelta` is added to the current count. */
export interface ChatSessionPatch {
  model?: string | null;
  mode?: string;
  effort?: string | null;
  ultracode?: boolean;
  ultracodeAvailable?: boolean;
  state?: ChatSessionState;
  cost?: number;
  turnsDelta?: number;
  /** How full the context window was after the last turn (tokens), and the window's size. */
  contextUsed?: number | null;
  contextWindow?: number | null;
  segment?: number;
  byteOffset?: number;
  parentPid?: number | null;
  processStartedAt?: string | null;
  process?: 'live' | 'asleep' | 'gone';
  endedReason?: string | null;
  /** T-136: what an integrity ending was for (JSON), or null to clear it. */
  endedFor?: string | null;
  successorId?: string | null;
  predecessorId?: string | null;
  archivedAt?: string | null;
  pinnedAt?: string | null;
  /** T-102: the restart hint's memory. */
  configHiddenAt?: string | null;
  autoApply?: boolean | null;
  title?: string;
  ticketId?: string | null;
  /** Sets or clears the session's worktree (its three columns together). */
  worktree?: ChatWorktree | null;
  claudeId?: string;
  bypassCapable?: boolean;
  claudeSessionId?: string;
  /** What the closed runs cost; `cost` (a process's running total) is added to it. */
  costBase?: number;
  segmentSeq?: number;
}

/** One model's share of a finished turn, as recorded. */
export interface UsageRow extends ModelTotals {
  requests: number;
  agents: number;
  durationMs: number;
}

/** A stored usage row, as Usage reads it. */
export interface UsageRecord extends UsageRow {
  atMs: number;
  workspaceId: string;
  claudeId: string | null;
}

/** The lifecycle states a sent line moves through (chat-sessions PRD §9): the contract's, plus `refused`. */
export type InputState = ChatInputState | 'refused';

/** How far along each state is; a line only ever moves forward (terminal states rank last). */
const INPUT_RANK_SQL = `CASE state WHEN 'sending' THEN 0 WHEN 'queued' THEN 1 WHEN 'started' THEN 2 ELSE 3 END`;
const inputRank = (state: InputState): number => ({ sending: 0, queued: 1, started: 2 })[state as string] ?? 3;

/** States a reconnecting tab can't tell from the transcript, so the socket replays them on subscribe. */
const REPLAYED_INPUT_STATES: ChatInputState[] = ['queued', 'cancelled', 'discarded', 'failed'];

/** States of a sent message that Claude Code hasn't finished with. */
const OPEN_INPUT_STATES = `('sending', 'queued', 'started')`;

/** Where one of the portal's own control lines is: written (`sending`), echoed or answered (`completed`), or not delivered (`failed`). */
export type ControlLineState = 'sending' | 'completed' | 'failed';

const PROCESS_STATES = new Set<string>(['live', 'asleep', 'gone']);

/** Whole, redacted event text over this many characters is truncated before it reaches the row. */
export const EVENT_TEXT_MAX = 16_000;

const TASK_STATUSES = new Set<string>(['running', 'completed', 'failed', 'killed']);

/** An epoch-ms instant as ISO-8601, or null when it isn't a plausible one. */
function isoFromMs(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0 || ms > 8.64e15) return null;
  return new Date(ms).toISOString();
}

/** Only the reference fields of an image (never anything else that might ride along). */
function imageRef(v: unknown): ChatImage | null {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  if (!o || typeof o.blobId !== 'string' || typeof o.mediaType !== 'string') return null;
  const ref: ChatImage = { blobId: o.blobId, mediaType: o.mediaType };
  if (typeof o.name === 'string' && o.name) ref.name = o.name;
  // The picture's size (uploads), so its box is laid out before it loads.
  if (typeof o.width === 'number' && typeof o.height === 'number' && Number.isInteger(o.width) && Number.isInteger(o.height) && o.width > 0 && o.height > 0 && o.width <= 100_000 && o.height <= 100_000) {
    ref.width = o.width;
    ref.height = o.height;
  }
  return ref;
}

/** A pinned side question as it is stored (chat PRD §20): its allow-listed fields, text redacted. */
function pinnedBtwOut(b: ChatPinnedBtw): ChatPinnedBtw {
  const out: ChatPinnedBtw = { id: b.id, question: redact(b.question), answer: redact(b.answer), askedAt: b.askedAt, askedBy: redact(b.askedBy) };
  if (b.model) out.model = b.model;
  if (b.usage) out.usage = b.usage;
  return out;
}

/** The same read back, from JSON that may be anything: nothing but well-formed fields comes out. */
function pinnedBtwIn(v: unknown): ChatPinnedBtw | null {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  if (!o || typeof o.id !== 'string' || typeof o.question !== 'string' || typeof o.answer !== 'string' || typeof o.askedAt !== 'string') return null;
  const out: ChatPinnedBtw = { id: o.id, question: o.question, answer: o.answer, askedAt: o.askedAt, askedBy: typeof o.askedBy === 'string' ? o.askedBy : '' };
  if (typeof o.model === 'string' && o.model) out.model = o.model;
  const u = o.usage && typeof o.usage === 'object' ? (o.usage as Record<string, unknown>) : null;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
  if (u && (u.basis === 'reported' || u.basis === 'estimated')) out.usage = { input: n(u.input), output: n(u.output), cacheRead: n(u.cacheRead), cacheWrite: n(u.cacheWrite), costUsd: typeof u.costUsd === 'number' ? u.costUsd : null, estimate: true, basis: u.basis };
  return out;
}

/** The chat tables (migrations v6–v8), wrapped around the portal {@link Store}. All methods are synchronous. */
export class ChatStore {
  readonly #store: Store;
  readonly #now: () => Date;
  /** Nesting depth of {@link transaction} (SQLite has no nested BEGIN). */
  #txDepth = 0;

  /** The workspaces' registry (T-42 slice 3): a session's workspace is stored as the stable id and read back as the key. Absent: as given. */
  readonly #refs: WorkspaceRefs | undefined;

  constructor(store: Store, now: () => Date = () => new Date(), workspaceRefs?: WorkspaceRefs) {
    this.#store = store;
    this.#now = now;
    this.#refs = workspaceRefs;
  }

  /* ---------- chat_sessions.workspace_id (T-42 slice 3): written as the stable id, read as the key, matched in either form ---------- */

  /**
   * A session row with its workspace as the key, whichever form it is stored in. Everything past these queries (the controller, which keys
   * live processes and runtime calls by the key) sees what it saw before.
   */
  #keyed<R extends ChatSessionRow | undefined>(row: R): R {
    if (!row || !this.#refs) return row;
    const key = this.#refs.keyOf(row.workspace_id);
    return key === row.workspace_id ? row : ({ ...row, workspace_id: key } as R);
  }

  /** `workspace_id IN (…)`: every form one workspace's rows may hold while the move runs. */
  #inWorkspace(key: string): { sql: string; args: string[] } {
    const forms = this.#refs ? this.#refs.storedForms(key) : [key];
    return { sql: `workspace_id IN (${forms.map(() => '?').join(', ')})`, args: forms };
  }

  /**
   * Runs `fn` in one transaction. When `fn` changed any row, `ifChanged` runs inside it too — the reader
   * moves its byte offset this way, so a line's effects and "this line was read" commit together and a
   * restart never applies a line twice. Lines that change nothing (live deltas) write nothing.
   */
  transaction(fn: () => void, ifChanged?: () => void): void {
    const db = this.#writable();
    if (this.#txDepth > 0) {
      fn();
      ifChanged?.();
      return;
    }
    const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    db.exec('BEGIN');
    this.#txDepth++;
    try {
      const before = changes();
      fn();
      if (ifChanged && changes() > before) ifChanged();
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw e;
    } finally {
      this.#txDepth--;
    }
  }

  /** The database, for reads. Throws when the store has no usable database. */
  #db() {
    const db = this.#store.db;
    if (!db) throw new Error('The chat store has no database.');
    return db;
  }

  /** The database, for writes. Throws when the store is read-only (frozen / from a newer portal). */
  #writable() {
    const db = this.#db();
    if (!this.#store.writable) throw new Error('The chat store is read-only.');
    return db;
  }

  #stamp() {
    return this.#now().toISOString();
  }

  create(opts: {
    id: string;
    workspaceId: string;
    cwd: string;
    title: string;
    origin: ChatOrigin;
    claudeId?: string;
    predecessorId?: string | null;
    ticketId?: string | null;
    parentId?: string | null;
    startedBy?: string | null;
    worktree?: ChatWorktree | null;
    bypassCapable?: boolean;
    /** The ended session it continues (T-270). */
    continuedFrom?: string | null;
  }): ChatSession {
    const now = this.#stamp();
    const db = this.#writable();
    db
      .prepare(
        `INSERT INTO chat_sessions (id, workspace_id, cwd, title, origin, state, state_since, created_at, last_activity_at, claude_id, predecessor_id,
           ticket_id, parent_id, started_by, worktree_path, worktree_branch, worktree_repo, claude_session_id, bypass_capable, continued_from)
         VALUES (?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.id,
        this.#refs ? this.#refs.storedRef(opts.workspaceId) : opts.workspaceId,
        opts.cwd,
        opts.title,
        opts.origin,
        now,
        now,
        now,
        opts.claudeId ?? '',
        opts.predecessorId ?? null,
        opts.ticketId ?? null,
        opts.parentId ?? null,
        opts.startedBy ?? null,
        opts.worktree?.path ?? null,
        opts.worktree?.branch ?? null,
        opts.worktree?.repo ?? null,
        opts.id,
        opts.bypassCapable ? 1 : 0,
        opts.continuedFrom ?? null,
      );
    // Its first run: on its Claude, under its own id.
    db.prepare(`INSERT INTO chat_segments (session_id, n, claude_id, claude_session_id, cwd, started_at) VALUES (?, 1, ?, ?, ?, ?)`).run(opts.id, opts.claudeId ?? '', opts.id, opts.cwd, now);
    return this.get(opts.id)!;
  }

  /** The id a chat goes by now: a folded session's old id (an alias) resolves to the chat that took it in. */
  resolveId(id: string): string {
    if (typeof id !== 'string' || !id) return id;
    const own = this.#db().prepare('SELECT 1 FROM chat_sessions WHERE id = ?').get(id);
    if (own) return id;
    const alias = this.#db().prepare('SELECT session_id FROM chat_session_aliases WHERE alias_id = ?').get(id) as { session_id: string } | undefined;
    return alias?.session_id ?? id;
  }

  get(id: string): ChatSession | null {
    const row = this.#keyed(this.#db().prepare('SELECT * FROM chat_sessions WHERE id = ?').get(this.resolveId(id)) as ChatSessionRow | undefined);
    return row ? this.toSession(row) : null;
  }

  /** The raw session row (for the controller's segment/offset/cwd/process bookkeeping). */
  row(id: string): ChatSessionRow | null {
    return this.#keyed(this.#db().prepare('SELECT * FROM chat_sessions WHERE id = ?').get(this.resolveId(id)) as ChatSessionRow | undefined) ?? null;
  }

  /** Sessions, newest activity first; optionally one workspace's, one ticket's, or one parent's children. */
  list(filter: { workspaceId?: string; ticketId?: string; parentId?: string } = {}): ChatSession[] {
    const where: string[] = [];
    const vals: string[] = [];
    if (filter.workspaceId) {
      const one = this.#inWorkspace(filter.workspaceId);
      where.push(one.sql);
      vals.push(...one.args);
    }
    if (filter.ticketId) (where.push('ticket_id = ?'), vals.push(filter.ticketId));
    if (filter.parentId) (where.push('parent_id = ?'), vals.push(filter.parentId));
    const rows = this.#db()
      .prepare(`SELECT * FROM chat_sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_activity_at DESC, created_at DESC`)
      .all(...vals) as ChatSessionRow[];
    return rows.map((r) => this.toSession(this.#keyed(r)));
  }

  /** Sessions that report to `from` report to `to` instead (a transfer: the successor carries on as the parent). */
  reparentChildren(from: string, to: string): void {
    this.#writable().prepare('UPDATE chat_sessions SET parent_id = ? WHERE parent_id = ?').run(to, from);
  }

  /** Sessions whose process should be running (for liveness checks and reattaching after a restart). */
  liveRows(): ChatSessionRow[] {
    return (this.#db().prepare(`SELECT * FROM chat_sessions WHERE process = 'live' AND state != 'ended'`).all() as ChatSessionRow[]).map((r) => this.#keyed(r));
  }

  /** One workspace's sessions that haven't ended (whatever their process), oldest first. */
  workspaceRows(workspaceId: string): ChatSessionRow[] {
    const one = this.#inWorkspace(workspaceId);
    return (this.#db().prepare(`SELECT * FROM chat_sessions WHERE ${one.sql} AND state != 'ended' ORDER BY created_at, id`).all(...one.args) as ChatSessionRow[]).map((r) => this.#keyed(r));
  }

  toSession(row: ChatSessionRow): ChatSession {
    const waiting = (this.#db().prepare('SELECT count(*) AS n FROM chat_requests WHERE session_id = ? AND answered_at IS NULL').get(row.id) as { n: number }).n;
    let waitingFor: string | null = null;
    if (waiting > 0) {
      const ask = this.#db().prepare('SELECT title, detail FROM chat_requests WHERE session_id = ? AND answered_at IS NULL ORDER BY created_at, rowid LIMIT 1').get(row.id) as { title: string; detail: string | null } | undefined;
      if (ask) {
        const detail = ask.detail?.replace(/\s+/g, ' ').trim();
        waitingFor = detail ? `${ask.title}: ${detail.length > 80 ? `${detail.slice(0, 79)}…` : detail}` : ask.title;
      }
    }
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      cwd: sessionCwd(row.cwd),
      title: row.title,
      state: row.state as ChatSessionState,
      origin: row.origin as ChatOrigin,
      model: row.model ?? null,
      mode: row.mode as ChatPermissionMode,
      effort: row.effort ?? null,
      ultracode: row.ultracode === 1,
      ultracodeAvailable: row.ultracode_available === 1,
      process: PROCESS_STATES.has(row.process) ? (row.process as ChatSession['process']) : 'gone',
      context: row.context_used === null || row.context_used === undefined ? null : { usedTokens: row.context_used, windowTokens: row.context_window ?? null },
      costUsd: row.cost_est_usd,
      turns: row.turns,
      lastSeq: row.last_seq,
      waiting,
      waitingFor,
      agentsRunning: (this.#db().prepare(`SELECT count(*) AS n FROM chat_tasks WHERE session_id = ? AND (status IS NULL OR status = 'running')`).get(row.id) as { n: number }).n,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      endedReason: row.ended_reason ?? null,
      endedFor: endedForOf(row),
      claudeId: row.claude_id ?? '',
      claudeName: this.claudeName(row.workspace_id, row.claude_id ?? ''),
      predecessorId: row.predecessor_id ?? null,
      successorId: row.successor_id ?? null,
      continuedFrom: row.continued_from ?? null,
      archivedAt: row.archived_at ?? null,
      pinnedAt: row.pinned_at ?? null,
      bypassCapable: row.bypass_capable === 1,
      claudeSessionId: claudeSessionOf(row),
      previousClaudes: this.#previousClaudes(row),
      switching: null,
      ticketId: row.ticket_id ?? null,
      parentId: row.parent_id ?? null,
      worktree: row.worktree_path ? { path: row.worktree_path, branch: row.worktree_branch ?? '', repo: row.worktree_repo ?? '' } : null,
      startedBy: row.started_by ?? null,
    };
  }

  /** The chain this session belongs to (T-136): every row from the root to the head, each one's cost, and their sum. Null when unknown. */
  lineage(sessionId: string): Lineage | null {
    return lineageOf(this.#db(), sessionId);
  }

  /** The other Claudes this chat ran on before its current one, oldest first, each once. */
  #previousClaudes(row: ChatSessionRow): { claudeId: string; name: string }[] {
    const rows = this.#db().prepare('SELECT DISTINCT claude_id FROM chat_segments WHERE session_id = ? AND claude_id != ? ORDER BY n').all(row.id, row.claude_id ?? '') as { claude_id: string }[];
    const out: { claudeId: string; name: string }[] = [];
    for (const r of rows) {
      const name = this.claudeName(row.workspace_id, r.claude_id);
      if (name) out.push({ claudeId: r.claude_id, name });
    }
    return out;
  }

  /** The runs of a chat on Claudes, oldest first. The one going now shows what it has cost and how many turns so far. */
  segments(sessionId: string): ChatSegment[] {
    const id = this.resolveId(sessionId);
    const session = this.row(id);
    if (!session) return [];
    const rows = this.#db().prepare('SELECT * FROM chat_segments WHERE session_id = ? ORDER BY n').all(id) as SegmentRow[];
    const closedTurns = rows.filter((r) => r.ended_at !== null).reduce((n, r) => n + r.turns, 0);
    return rows.map((r) => {
      const open = r.ended_at === null;
      return {
        n: r.n,
        claudeId: r.claude_id,
        claudeName: this.claudeName(session.workspace_id, r.claude_id) ?? 'Claude',
        claudeSessionId: r.claude_session_id,
        cwd: r.cwd,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        endedReason: r.ended_reason,
        costUsd: open ? Math.max(0, session.cost_est_usd - (session.cost_base_usd ?? 0)) : r.cost_usd,
        turns: open ? Math.max(0, session.turns - closedTurns) : r.turns,
      };
    });
  }

  /** Every Claude Code session id this chat has used: each has its own host folder to clean up on delete. */
  claudeSessionIds(sessionId: string): string[] {
    const id = this.resolveId(sessionId);
    const rows = this.#db().prepare('SELECT DISTINCT claude_session_id AS c FROM chat_segments WHERE session_id = ?').all(id) as { c: string }[];
    return [...new Set([id, ...rows.map((r) => r.c)])];
  }

  /**
   * The chat moves to another Claude: its running segment closes (`switched`, with what it cost and how many
   * turns) and a new one opens on `claudeId` under `claudeSessionId`. The row follows the new run: its Claude,
   * Claude Code session, log segment and offset restart, the closed runs' cost becomes the base the new
   * process's running total is added to, and the events so far belong to the earlier runs. Returns what
   * {@link restoreSegment} needs to undo it.
   */
  switchSegment(
    sessionId: string,
    next: { claudeId: string; claudeSessionId: string; pid: number | null; startedAt: string | null },
  ): { row: ChatSessionRow; segment: number } {
    const db = this.#writable();
    const before = this.row(sessionId)!;
    let n = 0;
    this.transaction(() => {
      const now = this.#stamp();
      const open = db.prepare('SELECT n FROM chat_segments WHERE session_id = ? AND ended_at IS NULL ORDER BY n DESC LIMIT 1').get(before.id) as { n: number } | undefined;
      const closedTurns = (db.prepare('SELECT coalesce(sum(turns), 0) AS t FROM chat_segments WHERE session_id = ? AND ended_at IS NOT NULL').get(before.id) as { t: number }).t;
      if (open)
        db.prepare(`UPDATE chat_segments SET ended_at = ?, ended_reason = 'switched', cost_usd = ?, turns = ? WHERE session_id = ? AND n = ?`).run(
          now,
          Math.max(0, before.cost_est_usd - (before.cost_base_usd ?? 0)),
          Math.max(0, before.turns - closedTurns),
          before.id,
          open.n,
        );
      n = ((db.prepare('SELECT coalesce(max(n), 0) AS n FROM chat_segments WHERE session_id = ?').get(before.id) as { n: number }).n ?? 0) + 1;
      db.prepare(`INSERT INTO chat_segments (session_id, n, claude_id, claude_session_id, cwd, started_at) VALUES (?, ?, ?, ?, ?, ?)`).run(before.id, n, next.claudeId, next.claudeSessionId, before.cwd, now);
      db.prepare(
        `UPDATE chat_sessions SET claude_id = ?, claude_session_id = ?, segment = 0, byte_offset = 0, parent_pid = ?, process_started_at = ?, process = 'live',
           cost_base_usd = cost_est_usd, segment_seq = last_seq, ended_reason = NULL WHERE id = ?`,
      ).run(next.claudeId, next.claudeSessionId, next.pid, next.startedAt, before.id);
    });
    return { row: before, segment: n };
  }

  /** The switch didn't finish: the chat is back on the run it had (its row as it was, the new segment gone, the old one open again). */
  restoreSegment(undo: { row: ChatSessionRow; segment: number }): void {
    const db = this.#writable();
    const b = undo.row;
    this.transaction(() => {
      db.prepare('DELETE FROM chat_segments WHERE session_id = ? AND n = ?').run(b.id, undo.segment);
      db.prepare(`UPDATE chat_segments SET ended_at = NULL, ended_reason = NULL WHERE session_id = ? AND n = ?`).run(b.id, undo.segment - 1);
      db.prepare(
        `UPDATE chat_sessions SET claude_id = ?, claude_session_id = ?, segment = ?, byte_offset = ?, parent_pid = ?, process_started_at = ?, process = ?, state = ?, state_since = ?,
           model = ?, mode = ?, effort = ?, ultracode = ?, ultracode_available = ?, context_used = ?, context_window = ?, cost_base_usd = ?, segment_seq = ?, ended_reason = ? WHERE id = ?`,
      ).run(
        b.claude_id ?? '',
        claudeSessionOf(b),
        b.segment,
        b.byte_offset,
        b.parent_pid,
        b.process_started_at,
        b.process,
        b.state,
        b.state_since,
        b.model,
        b.mode,
        b.effort,
        b.ultracode,
        b.ultracode_available,
        b.context_used,
        b.context_window,
        b.cost_base_usd ?? 0,
        b.segment_seq ?? 0,
        b.ended_reason,
        b.id,
      );
    });
  }

  /** Appends an event with the next gap-free seq, bumps the session's last_seq and activity time. */
  appendEvent(sessionId: string, ev: StoredEvent): ChatEvent {
    const db = this.#writable();
    const at = this.#stamp();
    const payload = JSON.stringify(this.#payload(ev));
    const seq = ((db.prepare('SELECT max(seq) AS m FROM chat_events WHERE session_id = ?').get(sessionId) as { m: number | null }).m ?? 0) + 1;
    db.prepare(`INSERT INTO chat_events (session_id, seq, at, kind, uuid, parent_tool_use_id, request_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sessionId,
      seq,
      at,
      ev.kind,
      ev.uuid ?? null,
      ev.parentToolUseId ?? null,
      ev.requestId ?? null,
      payload,
    );
    db.prepare('UPDATE chat_sessions SET last_seq = ?, last_activity_at = ? WHERE id = ?').run(seq, at, sessionId);
    return this.#toEvent({ seq, at, kind: ev.kind, uuid: ev.uuid ?? null, parent_tool_use_id: ev.parentToolUseId ?? null, request_id: ev.requestId ?? null, payload });
  }

  history(sessionId: string, after = 0): ChatEvent[] {
    const rows = this.#db().prepare('SELECT seq, at, kind, uuid, parent_tool_use_id, request_id, payload FROM chat_events WHERE session_id = ? AND seq > ? ORDER BY seq').all(sessionId, after) as EventRow[];
    return rows.map((r) => this.#toEvent(r));
  }

  /** The running cost the session's newest `result` reported, or null before the first. */
  lastResultCost(sessionId: string): number | null {
    const row = this.#db()
      .prepare(`SELECT payload FROM chat_events WHERE session_id = ? AND kind = 'result' AND seq > ? ORDER BY seq DESC LIMIT 1`)
      .get(sessionId, this.#segmentSeq(sessionId)) as { payload: string } | undefined;
    const cost = row ? this.#parsePayload(row.payload).costUsd : undefined;
    return typeof cost === 'number' ? cost : null;
  }

  /** Each model's running totals the session's newest `result` reported, or null. */
  lastResultModelTotals(sessionId: string): ModelTotals[] | null {
    const row = this.#db()
      .prepare(`SELECT payload FROM chat_events WHERE session_id = ? AND kind = 'result' AND seq > ? ORDER BY seq DESC LIMIT 1`)
      .get(sessionId, this.#segmentSeq(sessionId)) as { payload: string } | undefined;
    const totals = row ? this.#parsePayload(row.payload).modelTotals : undefined;
    return Array.isArray(totals) ? (totals as ModelTotals[]) : null;
  }

  /** Sub-agents started (by any agent) since the session's newest stored `result`. */
  agentsSinceLastResult(sessionId: string): number {
    const row = this.#db()
      .prepare(
        `SELECT count(*) AS n FROM chat_events WHERE session_id = ? AND kind = 'tool_use'
           AND json_extract(payload, '$.toolName') IN ('Task', 'Agent')
           AND seq > coalesce((SELECT max(seq) FROM chat_events WHERE session_id = ? AND kind = 'result'), 0)`,
      )
      .get(sessionId, sessionId) as { n: number };
    return row.n;
  }

  /** A finished turn's usage, one row per model; the first carries the request, sub-agents and time. */
  recordUsage(turn: { atMs: number; sessionId: string; workspaceId: string; claudeId: string | null }, rows: UsageRow[]): void {
    const db = this.#writable();
    const insert = db.prepare(
      `INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, requests, agents, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const at = new Date(turn.atMs).toISOString();
    for (const r of rows) {
      insert.run(at, turn.atMs, turn.sessionId, turn.workspaceId, turn.claudeId, r.model, r.input, r.output, r.cacheRead, r.cacheWrite, r.costUsd, r.requests, r.agents, r.durationMs);
    }
  }

  /** Usage rows from `fromMs` on, oldest first, optionally for one Claude. */
  usageSince(fromMs: number, claudeId?: string): UsageRecord[] {
    const cols = `at_ms AS atMs, workspace_id AS workspaceId, claude_id AS claudeId, model, input_tokens AS input, output_tokens AS output,
      cache_read_tokens AS cacheRead, cache_write_tokens AS cacheWrite, cost_usd AS costUsd, requests, agents, duration_ms AS durationMs`;
    return (
      claudeId
        ? this.#db().prepare(`SELECT ${cols} FROM chat_usage WHERE at_ms >= ? AND claude_id = ? ORDER BY at_ms`).all(fromMs, claudeId)
        : this.#db().prepare(`SELECT ${cols} FROM chat_usage WHERE at_ms >= ? ORDER BY at_ms`).all(fromMs)
    ) as unknown as UsageRecord[];
  }

  /** The session's newest stored event, or null before the first. */
  lastEvent(sessionId: string): ChatEvent | null {
    const row = this.#db().prepare('SELECT seq, at, kind, uuid, parent_tool_use_id, request_id, payload FROM chat_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1').get(sessionId) as
      | EventRow
      | undefined;
    return row ? this.#toEvent(row) : null;
  }

  /** The tool a stored `tool_use` called, by its id; for naming a result whose call was read earlier. */
  toolName(sessionId: string, toolUseId: string): string | null {
    const row = this.#db()
      .prepare(
        `SELECT json_extract(payload, '$.toolName') AS name FROM chat_events
         WHERE session_id = ? AND kind = 'tool_use' AND json_extract(payload, '$.toolUseId') = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(sessionId, toolUseId) as { name: string | null } | undefined;
    return typeof row?.name === 'string' ? row.name : null;
  }

  /** Whether the one-time "Ready" note (from the first `system/init`) is stored; other system notes don't count. */
  hasReady(sessionId: string): boolean {
    return !!this.#db()
      .prepare(`SELECT 1 FROM chat_events WHERE session_id = ? AND seq > ? AND kind = 'system' AND json_extract(payload, '$.text') = 'Ready' LIMIT 1`)
      .get(sessionId, this.#segmentSeq(sessionId));
  }

  /** The seq the current run of Claude Code started after: what came before belongs to its earlier runs. */
  #segmentSeq(sessionId: string): number {
    return (this.#db().prepare('SELECT segment_seq AS s FROM chat_sessions WHERE id = ?').get(sessionId) as { s: number } | undefined)?.s ?? 0;
  }

  patchSession(id: string, patch: ChatSessionPatch): void {
    const db = this.#writable();
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.model !== undefined) set('model', patch.model);
    if (patch.mode !== undefined) set('mode', patch.mode);
    if (patch.effort !== undefined) set('effort', patch.effort);
    if (patch.ultracode !== undefined) set('ultracode', patch.ultracode ? 1 : 0);
    if (patch.ultracodeAvailable !== undefined) set('ultracode_available', patch.ultracodeAvailable ? 1 : 0);
    if (patch.state !== undefined) {
      const now = this.#stamp();
      set('state', patch.state);
      set('state_since', now);
      set('last_activity_at', now);
    }
    if (patch.cost !== undefined) {
      sets.push('cost_est_usd = cost_base_usd + ?'); // a process's running total on top of what the closed runs cost
      vals.push(patch.cost);
    }
    if (patch.costBase !== undefined) set('cost_base_usd', patch.costBase);
    if (patch.segmentSeq !== undefined) set('segment_seq', patch.segmentSeq);
    if (patch.claudeId !== undefined) set('claude_id', patch.claudeId);
    if (patch.bypassCapable !== undefined) set('bypass_capable', patch.bypassCapable ? 1 : 0);
    if (patch.claudeSessionId !== undefined) set('claude_session_id', patch.claudeSessionId);
    if (patch.turnsDelta !== undefined) {
      sets.push('turns = turns + ?');
      vals.push(patch.turnsDelta);
    }
    if (patch.contextUsed !== undefined) set('context_used', patch.contextUsed);
    if (patch.contextWindow !== undefined) set('context_window', patch.contextWindow);
    if (patch.segment !== undefined) set('segment', patch.segment);
    if (patch.byteOffset !== undefined) set('byte_offset', patch.byteOffset);
    if (patch.parentPid !== undefined) set('parent_pid', patch.parentPid);
    if (patch.processStartedAt !== undefined) set('process_started_at', patch.processStartedAt);
    if (patch.process !== undefined) set('process', patch.process);
    if (patch.archivedAt !== undefined) set('archived_at', patch.archivedAt);
    if (patch.pinnedAt !== undefined) set('pinned_at', patch.pinnedAt);
    if (patch.configHiddenAt !== undefined) set('config_hidden_at', patch.configHiddenAt);
    if (patch.autoApply !== undefined) set('auto_apply', patch.autoApply === null ? null : patch.autoApply ? 1 : 0);
    if (patch.title !== undefined) set('title', patch.title);
    if (patch.endedReason !== undefined) set('ended_reason', redactMaybe(patch.endedReason));
    if (patch.endedFor !== undefined) set('ended_for', patch.endedFor);
    if (patch.successorId !== undefined) set('successor_id', patch.successorId);
    if (patch.predecessorId !== undefined) set('predecessor_id', patch.predecessorId);
    if (patch.ticketId !== undefined) set('ticket_id', patch.ticketId);
    if (patch.worktree !== undefined) {
      set('worktree_path', patch.worktree?.path ?? null);
      set('worktree_branch', patch.worktree?.branch ?? null);
      set('worktree_repo', patch.worktree?.repo ?? null);
    }
    if (!sets.length) return;
    db.prepare(`UPDATE chat_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  addInput(sessionId: string, uuid: string, actor: string | null, kind: 'message' | 'control', priority: string | null): void {
    this.#writable()
      .prepare(`INSERT INTO chat_inputs (session_id, uuid, actor, kind, priority, state, created_at) VALUES (?, ?, ?, ?, ?, 'sending', ?)`)
      .run(sessionId, uuid, actor, kind, priority, this.#stamp());
  }

  /**
   * Moves a sent line forward (sending → queued → started → completed, or to a terminal state) and says
   * whether it changed; a stale or repeated report never moves it back. `failed` applies only to a line
   * Claude Code hasn't reported on yet. Unknown uuids change nothing.
   */
  setInputState(sessionId: string, uuid: string, state: InputState): boolean {
    const db = this.#writable();
    const result =
      state === 'failed'
        ? db.prepare(`UPDATE chat_inputs SET state = 'failed' WHERE session_id = ? AND uuid = ? AND state = 'sending'`).run(sessionId, uuid)
        : db.prepare(`UPDATE chat_inputs SET state = ? WHERE session_id = ? AND uuid = ? AND ${INPUT_RANK_SQL} < ?`).run(state, sessionId, uuid, inputRank(state));
    return Number(result.changes) > 0;
  }

  inputState(sessionId: string, uuid: string): InputState | null {
    const row = this.#db().prepare('SELECT state FROM chat_inputs WHERE session_id = ? AND uuid = ?').get(sessionId, uuid) as { state: string } | undefined;
    return row ? (row.state as InputState) : null;
  }

  /** Sent messages that are queued, withdrawn or failed — what a reconnecting tab needs beyond the transcript. */
  inputStates(sessionId: string): { uuid: string; state: ChatInputState }[] {
    const marks = REPLAYED_INPUT_STATES.map(() => '?').join(', ');
    const rows = this.#db()
      .prepare(`SELECT uuid, state FROM chat_inputs WHERE session_id = ? AND kind = 'message' AND state IN (${marks}) ORDER BY created_at`)
      .all(sessionId, ...REPLAYED_INPUT_STATES) as { uuid: string; state: ChatInputState }[];
    return rows.map((r) => ({ uuid: r.uuid, state: r.state }));
  }

  hasInput(sessionId: string, uuid: string): boolean {
    return !!this.#db().prepare('SELECT 1 FROM chat_inputs WHERE session_id = ? AND uuid = ?').get(sessionId, uuid);
  }

  /** Whether the portal sent a message under this uuid in this session (whatever became of it). */
  isMessage(sessionId: string, uuid: string): boolean {
    return !!this.#db().prepare(`SELECT 1 FROM chat_inputs WHERE session_id = ? AND uuid = ? AND kind = 'message'`).get(sessionId, uuid);
  }

  /** How many sent messages Claude Code hasn't read yet (sending or queued). */
  queuedMessages(sessionId: string): number {
    return (this.#db().prepare(`SELECT count(*) AS n FROM chat_inputs WHERE session_id = ? AND kind = 'message' AND state IN ('sending', 'queued')`).get(sessionId) as { n: number }).n;
  }

  /** Whether a sent message is still with Claude Code (sending, queued or started). */
  hasOpenInputs(sessionId: string): boolean {
    return !!this.#db().prepare(`SELECT 1 FROM chat_inputs WHERE session_id = ? AND kind = 'message' AND state IN ${OPEN_INPUT_STATES} LIMIT 1`).get(sessionId);
  }

  /** Its process is gone: messages it never finished become `discarded`. Returns their uuids. */
  discardOpenInputs(sessionId: string): string[] {
    const db = this.#writable();
    const rows = db.prepare(`SELECT uuid FROM chat_inputs WHERE session_id = ? AND kind = 'message' AND state IN ${OPEN_INPUT_STATES} ORDER BY created_at`).all(sessionId) as { uuid: string }[];
    if (rows.length) db.prepare(`UPDATE chat_inputs SET state = 'discarded' WHERE session_id = ? AND kind = 'message' AND state IN ${OPEN_INPUT_STATES}`).run(sessionId);
    return rows.map((r) => r.uuid);
  }

  /**
   * Whether one of the portal's own slash commands (`/compact`, …) is running: Claude Code echoes local
   * command output as a replayed line under an id of its own while it does.
   */
  slashCommandRunning(sessionId: string): boolean {
    return !!this.#db()
      .prepare(
        `SELECT 1 FROM chat_inputs i JOIN chat_events e ON e.session_id = i.session_id AND e.uuid = i.uuid AND e.kind = 'user'
         WHERE i.session_id = ? AND i.kind = 'message' AND i.state = 'started' AND substr(ltrim(json_extract(e.payload, '$.text')), 1, 1) = '/' LIMIT 1`,
      )
      .get(sessionId);
  }

  /* ---------- The portal's own control lines (integrity, PRD §10.4) ---------- */

  /**
   * Records a control line before it's written: a request the portal asks (`req/<id>`) or an answer it
   * gives (`ans/<id>`). Keys carry a `/`, which client message ids never do. Writing an answer again after
   * a failed delivery puts it back to `sending`.
   */
  addControl(sessionId: string, key: string): void {
    this.#writable()
      .prepare(
        `INSERT INTO chat_inputs (session_id, uuid, actor, kind, priority, state, created_at) VALUES (?, ?, NULL, 'control', NULL, 'sending', ?)
         ON CONFLICT (session_id, uuid) DO UPDATE SET state = 'sending' WHERE state = 'failed'`,
      )
      .run(sessionId, key, this.#stamp());
  }

  controlState(sessionId: string, key: string): ControlLineState | null {
    const row = this.#db().prepare(`SELECT state FROM chat_inputs WHERE session_id = ? AND uuid = ? AND kind = 'control'`).get(sessionId, key) as { state: string } | undefined;
    return row ? (row.state as ControlLineState) : null;
  }

  /** Sets a control line's state; `digest` (T-136) records the first response read for it, so a second copy can be told apart. */
  setControlState(sessionId: string, key: string, state: ControlLineState, digest?: string): void {
    if (digest === undefined) this.#writable().prepare(`UPDATE chat_inputs SET state = ? WHERE session_id = ? AND uuid = ? AND kind = 'control'`).run(state, sessionId, key);
    else this.#writable().prepare(`UPDATE chat_inputs SET state = ?, digest = ? WHERE session_id = ? AND uuid = ? AND kind = 'control'`).run(state, digest, sessionId, key);
  }

  /** The digest of the first response read for a control line, or null (none read, or read before T-136). */
  controlDigest(sessionId: string, key: string): string | null {
    const row = this.#db().prepare(`SELECT digest FROM chat_inputs WHERE session_id = ? AND uuid = ? AND kind = 'control'`).get(sessionId, key) as { digest: string | null } | undefined;
    return row?.digest ?? null;
  }

  /* ---------- Sub-agents and background tasks ---------- */

  /**
   * Applies one task line: inserts the task (running, started now) the first time it's seen, otherwise
   * changes only the fields the line carries. A terminal status stamps `ended_at` once; a later
   * running set (`background_tasks_changed`) never revives a finished task.
   */
  upsertTask(sessionId: string, patch: TaskPatch): void {
    const db = this.#writable();
    const now = this.#stamp();
    const t: TaskPatch = { ...patch, description: redactMaybe(patch.description), summary: redactMaybe(patch.summary) };
    const status = t.status && TASK_STATUSES.has(t.status) ? t.status : undefined;
    const existing = db.prepare('SELECT status, ended_at FROM chat_tasks WHERE session_id = ? AND task_id = ?').get(sessionId, t.taskId) as
      | { status: string | null; ended_at: string | null }
      | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO chat_tasks (session_id, task_id, tool_use_id, type, label, background, status, tokens, tool_uses, started_at, ended_at, subagent_type, summary, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sessionId,
        t.taskId,
        t.toolUseId ?? null,
        t.taskType ?? null,
        t.description ?? null,
        t.background ? 1 : 0,
        status ?? 'running',
        t.tokens ?? null,
        t.toolUses ?? null,
        now,
        status && status !== 'running' ? (isoFromMs(t.endedAtMs) ?? now) : null,
        t.subagentType ?? null,
        t.summary ?? null,
        t.durationMs ?? null,
      );
      return;
    }
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (t.toolUseId !== undefined) set('tool_use_id', t.toolUseId);
    if (t.taskType !== undefined) set('type', t.taskType);
    if (t.description !== undefined) set('label', t.description);
    if (t.subagentType !== undefined) set('subagent_type', t.subagentType);
    if (t.background !== undefined) set('background', t.background ? 1 : 0);
    if (status) set('status', status);
    if ((status ?? existing.status ?? 'running') === 'running') {
      if (status && existing.ended_at !== null) set('ended_at', null); // started again
    } else {
      // An explicit end time wins; otherwise the first terminal report stamps it.
      const explicit = isoFromMs(t.endedAtMs);
      if (explicit) set('ended_at', explicit);
      else if (existing.ended_at === null) set('ended_at', now);
    }
    if (t.summary !== undefined) set('summary', t.summary);
    if (t.tokens !== undefined) set('tokens', t.tokens);
    if (t.toolUses !== undefined) set('tool_uses', t.toolUses);
    if (t.durationMs !== undefined) set('duration_ms', t.durationMs);
    if (!sets.length) return;
    db.prepare(`UPDATE chat_tasks SET ${sets.join(', ')} WHERE session_id = ? AND task_id = ?`).run(...vals, sessionId, t.taskId);
  }

  /** The session's sub-agents and background tasks, oldest first. */
  tasks(sessionId: string): ChatTask[] {
    const rows = this.#db()
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM chat_tasks WHERE session_id = ? ORDER BY started_at, task_id`,
      )
      .all(sessionId) as TaskRow[];
    return rows.map(taskOut);
  }

  /** One sub-agent or background task, or null. */
  task(sessionId: string, taskId: string): ChatTask | null {
    const row = this.#db().prepare(`SELECT ${TASK_COLUMNS} FROM chat_tasks WHERE session_id = ? AND task_id = ?`).get(sessionId, taskId) as TaskRow | undefined;
    return row ? taskOut(row) : null;
  }

  /**
   * The model a sub-agent runs on, by the Task call that started it. `ifUnknown` (what Claude Code launched it on) only fills a gap; what its
   * own lines report (`message.model`) always wins. Says whether a row changed.
   */
  setTaskModel(sessionId: string, toolUseId: string, model: string, opts: { ifUnknown?: boolean } = {}): boolean {
    const result = this.#writable()
      .prepare(`UPDATE chat_tasks SET model = ? WHERE session_id = ? AND tool_use_id = ? AND (model IS NULL OR (? = 0 AND model <> ?))`)
      .run(model, sessionId, toolUseId, opts.ifUnknown ? 1 : 0, model);
    return Number(result.changes) > 0;
  }

  /**
   * A sub-agent's own transcript: the events of the lines that carry its Task call as their parent, after `after`, oldest first. At most
   * `limit` (the newest of them); `truncated` says older ones were left out. Payloads are stored redacted, as for `history`.
   */
  taskEvents(sessionId: string, toolUseId: string, after = 0, limit = TASK_EVENTS_MAX): { events: ChatEvent[]; truncated: boolean } {
    const rows = this.#db()
      .prepare('SELECT seq, at, kind, uuid, parent_tool_use_id, request_id, payload FROM chat_events WHERE session_id = ? AND parent_tool_use_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?')
      .all(sessionId, toolUseId, after, limit + 1) as EventRow[];
    const truncated = rows.length > limit;
    return { events: rows.slice(0, limit).reverse().map((r) => this.#toEvent(r)), truncated };
  }

  /** Whether a sub-agent or background task is still running. */
  /**
   * Whether a sub-agent or background task ran in the session's current process: one still running, or one started or ended since
   * `since` (the process start; null when the portal attached to a process it didn't start: then any task of the session counts). T-99.
   */
  hasTaskActivitySince(sessionId: string, since: string | null): boolean {
    if (since === null) return !!this.#db().prepare('SELECT 1 FROM chat_tasks WHERE session_id = ? LIMIT 1').get(sessionId);
    return !!this.#db()
      .prepare(`SELECT 1 FROM chat_tasks WHERE session_id = ? AND (status IS NULL OR status = 'running' OR started_at >= ? OR ended_at >= ?) LIMIT 1`)
      .get(sessionId, since, since);
  }

  /** Whether this one task ran in the session's current process (as {@link hasTaskActivitySince}, for one task id). T-136. */
  taskRanSince(sessionId: string, taskId: string, since: string | null): boolean {
    if (since === null) return !!this.#db().prepare('SELECT 1 FROM chat_tasks WHERE session_id = ? AND task_id = ? LIMIT 1').get(sessionId, taskId);
    return !!this.#db()
      .prepare(`SELECT 1 FROM chat_tasks WHERE session_id = ? AND task_id = ? AND (status IS NULL OR status = 'running' OR started_at >= ? OR ended_at >= ?) LIMIT 1`)
      .get(sessionId, taskId, since, since);
  }

  hasRunningTasks(sessionId: string): boolean {
    return !!this.#db().prepare(`SELECT 1 FROM chat_tasks WHERE session_id = ? AND (status IS NULL OR status = 'running') LIMIT 1`).get(sessionId);
  }

  /**
   * Its process is gone, and its sub-agents and background tasks with it: they read `killed`, ended now. `only` limits it to those tasks
   * (a move: the old run's, while the new run may already have its own). Says whether any did.
   */
  endRunningTasks(sessionId: string, only?: readonly string[]): boolean {
    if (only && !only.length) return false;
    const pick = only ? ` AND task_id IN (${only.map(() => '?').join(', ')})` : '';
    const result = this.#writable()
      .prepare(`UPDATE chat_tasks SET status = 'killed', ended_at = coalesce(ended_at, ?) WHERE session_id = ? AND (status IS NULL OR status = 'running')${pick}`)
      .run(this.#stamp(), sessionId, ...(only ?? []));
    return Number(result.changes) > 0;
  }

  /** The tasks of a session still running, by id. */
  runningTaskIds(sessionId: string): string[] {
    return (
      this.#db().prepare(`SELECT task_id FROM chat_tasks WHERE session_id = ? AND (status IS NULL OR status = 'running') ORDER BY task_id`).all(sessionId) as {
        task_id: string;
      }[]
    ).map((r) => r.task_id);
  }

  /**
   * At a portal start: a session whose process isn't live (asleep, gone, ended) has nothing running, whatever its tasks last said (a
   * portal that stopped mid-move or mid-restart never closed them). They read `killed`, ended now. Returns the sessions it changed.
   */
  endOrphanTasks(): string[] {
    const db = this.#writable();
    const where = `(status IS NULL OR status = 'running') AND session_id IN (SELECT id FROM chat_sessions WHERE coalesce(process, '') != 'live' OR state = 'ended')`;
    const ids = (db.prepare(`SELECT DISTINCT session_id FROM chat_tasks WHERE ${where}`).all() as { session_id: string }[]).map((r) => r.session_id);
    if (ids.length) db.prepare(`UPDATE chat_tasks SET status = 'killed', ended_at = coalesce(ended_at, ?) WHERE ${where}`).run(this.#stamp());
    return ids;
  }

  /** The description of the task a `Task` tool_use started, to label its sub-agent's lines. */
  taskLabel(sessionId: string, toolUseId: string): string | null {
    const row = this.#db().prepare('SELECT label FROM chat_tasks WHERE session_id = ? AND tool_use_id = ? AND label IS NOT NULL LIMIT 1').get(sessionId, toolUseId) as
      | { label: string }
      | undefined;
    return row?.label ?? null;
  }

  /** Records a request the agent raised and returns it with its stored timestamp. Throws on a duplicate id. */
  addRequest(sessionId: string, req: ChatRequest & { toolUseId?: string }): ChatRequest {
    const createdAt = this.#stamp();
    const detail = redactMaybe(req.detail ?? null);
    // What is being allowed, whole (the card and the widget show it): redacted here too, whoever built the request.
    const full = redactMaybe(req.full ?? null);
    const fullCut = req.fullCut === true;
    this.#writable()
      .prepare(`INSERT INTO chat_requests (session_id, request_id, tool_use_id, kind, tool_name, agent_label, title, detail, full, full_cut, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, req.requestId, req.toolUseId ?? null, req.kind, req.toolName ?? null, req.agentLabel ?? null, req.title, detail, full, fullCut ? 1 : 0, createdAt);
    return { requestId: req.requestId, kind: req.kind, toolName: req.toolName ?? null, agentLabel: req.agentLabel ?? null, title: req.title, detail, full, fullCut, createdAt };
  }

  /** Its process is gone: requests nobody can answer any more read `expired`. Returns their ids. */
  expireOpenRequests(sessionId: string): string[] {
    const db = this.#writable();
    const rows = db.prepare('SELECT request_id FROM chat_requests WHERE session_id = ? AND answered_at IS NULL ORDER BY created_at, rowid').all(sessionId) as { request_id: string }[];
    if (rows.length) db.prepare(`UPDATE chat_requests SET answered_at = ?, outcome = 'expired' WHERE session_id = ? AND answered_at IS NULL`).run(this.#stamp(), sessionId);
    return rows.map((r) => r.request_id);
  }

  answerRequest(sessionId: string, requestId: string, outcome: string, actor: string | null): void {
    this.#writable()
      .prepare('UPDATE chat_requests SET answered_at = ?, outcome = ?, actor = ? WHERE session_id = ? AND request_id = ?')
      .run(this.#stamp(), outcome, actor, sessionId, requestId);
  }

  /** An answer that never reached Claude Code: the request is open again. */
  reopenRequest(sessionId: string, requestId: string): void {
    this.#writable()
      .prepare('UPDATE chat_requests SET answered_at = NULL, outcome = NULL, actor = NULL WHERE session_id = ? AND request_id = ?')
      .run(sessionId, requestId);
  }

  /** How the portal answered a request Claude Code raised (allowed_once, allowed_session, denied, …), or null while open or unknown. */
  requestOutcome(sessionId: string, requestId: string): string | null {
    const row = this.#db().prepare('SELECT outcome FROM chat_requests WHERE session_id = ? AND request_id = ?').get(sessionId, requestId) as { outcome: string | null } | undefined;
    return row?.outcome ?? null;
  }

  openRequests(sessionId: string): ChatRequest[] {
    const rows = this.#db()
      .prepare('SELECT request_id, tool_use_id, kind, tool_name, agent_label, title, detail, full, full_cut, created_at FROM chat_requests WHERE session_id = ? AND answered_at IS NULL ORDER BY created_at, rowid')
      .all(sessionId) as RequestRow[];
    return rows.map((r) => ({
      requestId: r.request_id,
      kind: r.kind as ChatRequest['kind'],
      toolName: r.tool_name,
      agentLabel: r.agent_label,
      title: r.title,
      detail: r.detail,
      full: r.full,
      fullCut: r.full_cut === 1,
      createdAt: r.created_at,
    }));
  }

  /* ---------- Folder trust (FR43) ---------- */

  /** The trust a person gave a folder: the scan hash it holds for, or null when the folder was never trusted. */
  folderTrust(workspaceId: string, folder: string): { hash: string | null; trustedAt: string } | null {
    const row = this.#db().prepare('SELECT scan_hash, trusted_at FROM chat_folder_trust WHERE workspace_id = ? AND folder = ?').get(workspaceId, folder) as
      | { scan_hash: string | null; trusted_at: string }
      | undefined;
    return row ? { hash: row.scan_hash, trustedAt: row.trusted_at } : null;
  }

  /** Trusts a folder as scanned: its hash, what the scan named (names only, never values), when and by whom. */
  saveFolderTrust(workspaceId: string, folder: string, hash: string, scan: Record<string, unknown>, actor: string | null): void {
    this.#writable()
      .prepare(
        `INSERT INTO chat_folder_trust (workspace_id, folder, scan_hash, scan, trusted_at, actor) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, folder) DO UPDATE SET scan_hash = excluded.scan_hash, scan = excluded.scan, trusted_at = excluded.trusted_at, actor = excluded.actor`,
      )
      .run(workspaceId, folder, hash, JSON.stringify(scan), this.#stamp(), actor);
  }

  /* ---------- Worktrees (chat-sessions PRD, Git worktrees per session) ---------- */

  /** A worktree made for a chat that hasn't started yet (waiting on folder trust): the retry reuses it, a sweep removes it if nobody did. */
  reserveWorktree(w: { workspaceId: string; path: string; repo: string; branch: string; base: string | null }): void {
    this.#writable()
      .prepare(
        `INSERT INTO chat_worktrees (workspace_id, path, repo, branch, base, session_id, state, created_at) VALUES (?, ?, ?, ?, ?, NULL, 'reserved', ?)
         ON CONFLICT (workspace_id, path) DO UPDATE SET repo = excluded.repo, branch = excluded.branch, base = excluded.base, session_id = NULL, state = 'reserved', created_at = excluded.created_at, removed_at = NULL`,
      )
      .run(w.workspaceId, w.path, w.repo, w.branch, w.base, this.#stamp());
  }

  worktreeAt(workspaceId: string, path: string): WorktreeRow | null {
    const row = this.#db().prepare(`SELECT * FROM chat_worktrees WHERE workspace_id = ? AND path = ? AND state != 'removed'`).get(workspaceId, path) as WorktreeRecord | undefined;
    return row ? toWorktree(row) : null;
  }

  /** A reserved worktree a retry found (by the branch it names): its repository and path, so the same request makes no second one. */
  reservedWorktree(workspaceId: string, branch: string): WorktreeRow | null {
    const row = this.#db()
      .prepare(`SELECT * FROM chat_worktrees WHERE workspace_id = ? AND branch = ? AND state = 'reserved' ORDER BY created_at DESC LIMIT 1`)
      .get(workspaceId, branch) as WorktreeRecord | undefined;
    return row ? toWorktree(row) : null;
  }

  /** The chat now runs in it. */
  activateWorktree(workspaceId: string, path: string, sessionId: string): void {
    this.#writable().prepare(`UPDATE chat_worktrees SET session_id = ?, state = 'active' WHERE workspace_id = ? AND path = ?`).run(sessionId, workspaceId, path);
  }

  /** Its chat is gone and the folder stays (`kept`), or the folder is gone (`removed`). */
  releaseWorktree(workspaceId: string, path: string, state: 'kept' | 'removed'): void {
    this.#writable()
      .prepare(`UPDATE chat_worktrees SET state = ?, session_id = NULL, removed_at = ? WHERE workspace_id = ? AND path = ?`)
      .run(state, state === 'removed' ? this.#stamp() : null, workspaceId, path);
  }

  /** The worktrees the portal made in a workspace, none of them removed, newest first. */
  worktrees(workspaceId: string): WorktreeRow[] {
    const rows = this.#db().prepare(`SELECT * FROM chat_worktrees WHERE workspace_id = ? AND state != 'removed' ORDER BY created_at DESC`).all(workspaceId) as unknown as WorktreeRecord[];
    return rows.map(toWorktree);
  }

  /** Worktrees reserved for a start that never came through, made before `before`. */
  staleReservations(before: string): WorktreeRow[] {
    const rows = this.#db().prepare(`SELECT * FROM chat_worktrees WHERE state = 'reserved' AND created_at < ?`).all(before) as unknown as WorktreeRecord[];
    return rows.map(toWorktree);
  }

  /** Only the allowlisted display fields of an event (never a raw tool input blob), with credentials redacted. */
  /** The workspace's Claudes, creating Default on first use. Default keeps the original home (no extra directory). */
  /** Whether a Claude row exists for the workspace (a read never makes one). */
  hasClaudes(workspaceId: string): boolean {
    return !!this.#db().prepare('SELECT 1 FROM workspace_claudes WHERE workspace_id = ? LIMIT 1').get(workspaceId);
  }

  listClaudes(workspaceId: string): WorkspaceClaude[] {
    this.ensureDefault(workspaceId);
    const rows = this.#db().prepare('SELECT * FROM workspace_claudes WHERE workspace_id = ? ORDER BY created_at, name').all(workspaceId) as ClaudeRow[];
    return rows.map(toClaude);
  }

  ensureDefault(workspaceId: string): WorkspaceClaude {
    const existing = this.#db().prepare(`SELECT * FROM workspace_claudes WHERE workspace_id = ? AND directory = ''`).get(workspaceId) as ClaudeRow | undefined;
    if (existing) return toClaude(existing);
    const now = this.#stamp();
    const id = `d_${createHash('sha256').update(workspaceId).digest('hex').slice(0, 16)}`;
    this.#writable().prepare(`INSERT INTO workspace_claudes (id, workspace_id, name, directory, created_at) VALUES (?, ?, 'Default', '', ?)`).run(id, workspaceId, now);
    return toClaude(this.#db().prepare('SELECT * FROM workspace_claudes WHERE id = ?').get(id) as ClaudeRow);
  }

  claude(id: string): WorkspaceClaude | null {
    const row = this.#db().prepare('SELECT * FROM workspace_claudes WHERE id = ?').get(id) as ClaudeRow | undefined;
    return row ? toClaude(row) : null;
  }

  claudeName(workspaceId: string, claudeId: string): string | null {
    if (!claudeId) return 'Default';
    const row = this.#db().prepare('SELECT name FROM workspace_claudes WHERE id = ? AND workspace_id = ?').get(claudeId, workspaceId) as { name: string } | undefined;
    return row?.name ?? null;
  }

  /** Absolute config directory for a non-default Claude, or null to leave Claude Code on the workspace home. */
  configDir(claudeId: string): string | null {
    if (!claudeId) return null;
    const row = this.#db().prepare('SELECT directory FROM workspace_claudes WHERE id = ?').get(claudeId) as { directory: string } | undefined;
    if (!row || !row.directory) return null;
    if (!/^claudes\/[a-f0-9]{16}$/.test(row.directory)) return null;
    return `${HOME}/.claudepilot/${row.directory}`;
  }

  addClaude(workspaceId: string, name: string): { id: string; directory: string } {
    const id = randomBytes(8).toString('hex');
    const directory = `claudes/${id}`;
    const now = this.#stamp();
    this.#writable().prepare(`INSERT INTO workspace_claudes (id, workspace_id, name, directory, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, workspaceId, name, directory, now);
    return { id, directory };
  }

  removeClaudeRow(id: string): void {
    this.#writable().prepare('DELETE FROM workspace_claudes WHERE id = ?').run(id);
  }

  /** A new label (Workspace Claudes FR3); the directory doesn't change. */
  renameClaude(id: string, name: string): void {
    this.#writable().prepare('UPDATE workspace_claudes SET name = ? WHERE id = ? AND removed_at IS NULL').run(name, id);
  }

  /** Marks a Claude removed; its row and its sessions' rows stay, and so does its directory (FR3). */
  markClaudeRemoved(id: string): void {
    this.#writable().prepare('UPDATE workspace_claudes SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(this.#stamp(), id);
  }

  /** Sessions on that Claude that haven't ended (Default's include rows from before Claudes, with no claude_id). */
  openSessionsOnClaude(workspaceId: string, claudeId: string, isDefault: boolean): number {
    const one = this.#inWorkspace(workspaceId);
    const row = this.#db()
      .prepare(`SELECT COUNT(*) AS n FROM chat_sessions WHERE ${one.sql} AND state != 'ended' AND (claude_id = ? OR (? AND claude_id = ''))`)
      .get(...one.args, claudeId, isDefault ? 1 : 0) as { n: number };
    return row.n;
  }


  /**
   * Deletes a session (FR4): its row, and with it (cascade) its events, inputs, requests, tasks and file
   * links. Usage rows stay (FR49) and so do handoff rows; a predecessor or successor no longer points
   * at it. Returns the blobs it linked, for the caller to prune once nothing else links them.
   */
  deleteSession(id: string): string[] {
    const db = this.#writable();
    let blobs: string[] = [];
    this.transaction(() => {
      blobs = (db.prepare('SELECT DISTINCT blob_sha256 AS b FROM chat_files WHERE session_id = ? AND blob_sha256 IS NOT NULL').all(id) as { b: string }[]).map((r) => r.b);
      db.prepare('UPDATE chat_sessions SET successor_id = NULL WHERE successor_id = ?').run(id);
      db.prepare('UPDATE chat_sessions SET predecessor_id = NULL WHERE predecessor_id = ?').run(id);
      db.prepare('UPDATE chat_sessions SET parent_id = NULL WHERE parent_id = ?').run(id);
      // The row that continued it now starts its chain (T-136): what it cost is gone with it.
      db.prepare('UPDATE chat_sessions SET continued_from = NULL WHERE continued_from = ?').run(id);
      db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
    });
    return blobs;
  }

  /* ---------- Audit ---------- */

  /** One entry of the audit trail. `detail` holds names and ids only, redacted: never a secret or a message. */
  addAudit(entry: { severity: ChatAuditEntry['severity']; kind: string; sessionId?: string | null; workspaceId?: string | null; actor?: string | null; actorLabel?: string | null; detail?: Record<string, unknown> }): void {
    // A Portal MCP token's label as it was when it acted, kept in the row's detail (redacted with the rest) so a later rename changes nothing.
    const detail = entry.actorLabel ? { ...entry.detail, actorLabel: entry.actorLabel.replace(/\s+/g, ' ').trim().slice(0, 60) } : entry.detail;
    this.#writable()
      .prepare('INSERT INTO chat_audit (at, severity, kind, session_id, workspace_id, actor, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(this.#stamp(), entry.severity, entry.kind, entry.sessionId ?? null, entry.workspaceId ?? null, entry.actor ?? null, redact(JSON.stringify(detail ?? {})));
  }

  /** The audit trail, newest first; optionally one kind (a prefix such as `bypass`) or one session's. */
  audit(filter: { kind?: string; sessionId?: string; limit?: number } = {}): ChatAuditEntry[] {
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (filter.kind) (where.push('(kind = ? OR kind LIKE ?)'), vals.push(filter.kind, `${filter.kind}.%`));
    if (filter.sessionId) (where.push('session_id = ?'), vals.push(this.resolveId(filter.sessionId)));
    const rows = this.#db()
      .prepare(`SELECT * FROM chat_audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...vals, Math.min(Math.max(filter.limit ?? 100, 1), 500)) as { id: number; at: string; severity: string; kind: string; session_id: string | null; workspace_id: string | null; actor: string | null; detail: string }[];
    return rows.map((r) => {
      let detail: Record<string, unknown> = {};
      try {
        const v: unknown = JSON.parse(r.detail);
        if (v && typeof v === 'object') detail = v as Record<string, unknown>;
      } catch {
        // a row that can't be read shows without detail
      }
      return { id: r.id, at: r.at, severity: r.severity as ChatAuditEntry['severity'], kind: r.kind, sessionId: r.session_id, workspaceId: r.workspace_id, actor: r.actor, detail };
    });
  }

  saveHandoff(row: { id: string; workspaceId: string; sourceSessionId: string; sourceClaudeId: string; destClaudeId: string; path: string }): void {
    this.#writable()
      .prepare(
        `INSERT INTO claude_handoffs (id, workspace_id, source_session_id, successor_session_id, source_claude_id, dest_claude_id, path, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(row.id, row.workspaceId, row.sourceSessionId, row.sourceClaudeId, row.destClaudeId, row.path, this.#stamp());
  }

  /** The move didn't finish: the handoff has no successor after all. */
  clearHandoffSuccessor(id: string): void {
    this.#writable().prepare('UPDATE claude_handoffs SET successor_session_id = NULL WHERE id = ?').run(id);
  }

  setHandoffSuccessor(id: string, successorId: string): void {
    this.#writable().prepare('UPDATE claude_handoffs SET successor_session_id = ? WHERE id = ?').run(successorId, id);
  }

  #payload(ev: StoredEvent): Record<string, unknown> {
    const p: Record<string, unknown> = {};
    if (ev.text !== undefined) {
      const text = redact(ev.text); // whole, before truncating, so a cut never splits a credential
      p.text = text.length > EVENT_TEXT_MAX ? `${text.slice(0, EVENT_TEXT_MAX)}…` : text;
    }
    if (ev.toolName !== undefined) p.toolName = ev.toolName;
    if (ev.request !== undefined) p.request = { ...ev.request, detail: redactMaybe(ev.request.detail), ...(ev.request.full ? { full: redactMaybe(ev.request.full) } : {}) };
    if (ev.outcome !== undefined) p.outcome = ev.outcome;
    if (ev.costUsd !== undefined) p.costUsd = ev.costUsd;
    // A call's id, on the call and its result: a result read after a restart can still be named, and the
    // transcript pairs each call with its result.
    if ((ev.kind === 'tool_use' || ev.kind === 'tool_result') && ev.toolUseId) p.toolUseId = ev.toolUseId;
    // What a call was given (its row's Input block): redacted again here, as `request.full` is.
    if (ev.kind === 'tool_use' && ev.toolInput) p.toolInput = mapInputStrings(ev.toolInput, redact);
    if (ev.kind === 'tool_use' && ev.toolInputCut) p.toolInputCut = true;
    if (ev.kind === 'tool_result' && ev.isError) p.isError = true;
    if ((ev.kind === 'thinking' || ev.kind === 'result') && ev.durationMs !== undefined) p.durationMs = ev.durationMs;
    if (ev.kind === 'result' && ev.turnCostUsd !== undefined) p.turnCostUsd = ev.turnCostUsd;
    if (ev.kind === 'result' && ev.tokens) p.tokens = ev.tokens;
    if (ev.kind === 'result' && ev.modelTotals?.length) p.modelTotals = ev.modelTotals;
    if (ev.handoffId) p.handoffId = ev.handoffId;
    if ((ev.kind === 'user' || ev.kind === 'system') && ev.transfer) p.transfer = { ...ev.transfer, fromClaude: redact(ev.transfer.fromClaude), toClaude: redact(ev.transfer.toClaude) };
    // A pinned side question (chat PRD §20): a `system` event with its card.
    if (ev.kind === 'system' && ev.btw) p.btw = pinnedBtwOut(ev.btw);
    // A Restart's divider (chat PRD, Restart).
    if (ev.kind === 'system' && ev.restart === true) p.restart = true;
    if (ev.kind === 'system' && ev.recovered === true) p.recovered = true;
    if (ev.kind === 'user' && ev.actor) {
      p.actor = redact(ev.actor);
      if (ev.actorLabel) p.actorLabel = redact(ev.actorLabel);
    }
    // The readable sub-agent label, when it isn't just the raw parent_tool_use_id kept in its column.
    if (ev.agentLabel && ev.agentLabel !== ev.parentToolUseId) p.agentLabel = redact(ev.agentLabel);
    // Blob references only: base64 never reaches a row (the controller moves it to the blob store).
    const images = (ev.images ?? []).map(imageRef).filter((i): i is ChatImage => i !== null);
    if (images.length) p.images = images;
    // Files you attached, or the agent produced (chat content): the allow-listed reference fields only.
    const files = fileRefs(ev.files);
    if (files.length) p.files = files;
    return p;
  }

  #toEvent(row: EventRow): ChatEvent {
    const payload = this.#parsePayload(row.payload);
    const ev: ChatEvent = { seq: row.seq, at: row.at, kind: row.kind as ChatEventKind };
    if (typeof payload.text === 'string') ev.text = payload.text;
    const agentLabel = typeof payload.agentLabel === 'string' ? payload.agentLabel : row.parent_tool_use_id;
    if (agentLabel !== null) ev.agentLabel = agentLabel;
    if (row.parent_tool_use_id) ev.parentToolUseId = row.parent_tool_use_id;
    if (typeof payload.toolName === 'string') ev.toolName = payload.toolName;
    if (row.request_id !== null) ev.requestId = row.request_id;
    if (payload.request && typeof payload.request === 'object') ev.request = payload.request as ChatRequest;
    if (typeof payload.outcome === 'string') ev.outcome = payload.outcome;
    if (typeof payload.costUsd === 'number') ev.costUsd = payload.costUsd;
    if (typeof payload.toolUseId === 'string') ev.toolUseId = payload.toolUseId;
    if (payload.toolInput && typeof payload.toolInput === 'object' && !Array.isArray(payload.toolInput)) ev.toolInput = payload.toolInput as NonNullable<ChatEvent['toolInput']>;
    if (payload.toolInputCut === true) ev.toolInputCut = true;
    if (payload.isError === true) ev.isError = true;
    if (typeof payload.durationMs === 'number') ev.durationMs = payload.durationMs;
    if (typeof payload.turnCostUsd === 'number') ev.turnCostUsd = payload.turnCostUsd;
    const t = payload.tokens as Record<string, unknown> | undefined;
    if (t && typeof t === 'object') {
      const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
      ev.tokens = { input: n(t.input), output: n(t.output), cacheRead: n(t.cacheRead), cacheWrite: n(t.cacheWrite) };
    }
    if (Array.isArray(payload.images)) {
      const images = payload.images.map(imageRef).filter((i): i is ChatImage => i !== null);
      if (images.length) ev.images = images;
    }
    if (Array.isArray(payload.files)) {
      const files = fileRefs(payload.files);
      if (files.length) ev.files = files;
    }
    if (row.kind === 'user' && row.uuid !== null) ev.uuid = row.uuid;
    if (typeof payload.handoffId === 'string') ev.handoffId = payload.handoffId;
    if (row.kind === 'user' && typeof payload.actor === 'string') {
      ev.actor = payload.actor;
      if (typeof payload.actorLabel === 'string') ev.actorLabel = payload.actorLabel;
    }
    const tr = payload.transfer as Record<string, unknown> | undefined;
    if ((row.kind === 'user' || row.kind === 'system') && tr && typeof tr === 'object') {
      const str = (v: unknown) => (typeof v === 'string' ? v : '');
      ev.transfer = {
        fromClaude: str(tr.fromClaude),
        toClaude: str(tr.toClaude),
        sourceSessionId: str(tr.sourceSessionId),
        path: str(tr.path),
        messages: typeof tr.messages === 'number' ? tr.messages : 0,
        truncated: tr.truncated === true,
        ...(tr.handoff === true ? { handoff: true } : {}),
        ...(typeof tr.handoffId === 'string' ? { handoffId: tr.handoffId } : {}),
      };
    }
    if (row.kind === 'system' && payload.restart === true) ev.restart = true;
    if (row.kind === 'system' && payload.recovered === true) ev.recovered = true;
    if (row.kind === 'system' && payload.btw) {
      const btw = pinnedBtwIn(payload.btw);
      if (btw) ev.btw = btw;
    }
    return ev;
  }

  #parsePayload(s: string): Record<string, unknown> {
    try {
      const v: unknown = JSON.parse(s);
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}

type SegmentRow = {
  session_id: string;
  n: number;
  claude_id: string;
  claude_session_id: string;
  cwd: string;
  started_at: string;
  ended_at: string | null;
  ended_reason: string | null;
  cost_usd: number;
  turns: number;
};

/** One row of `chat_worktrees`. */
type WorktreeRecord = {
  workspace_id: string;
  path: string;
  repo: string;
  branch: string;
  base: string | null;
  session_id: string | null;
  state: string;
  created_at: string;
  removed_at: string | null;
};

/** A worktree the portal made, as the controller reads it. */
export interface WorktreeRow {
  workspaceId: string;
  path: string;
  repo: string;
  branch: string;
  base: string | null;
  sessionId: string | null;
  state: 'reserved' | 'active' | 'kept' | 'removed';
  createdAt: string;
}

const toWorktree = (r: WorktreeRecord): WorktreeRow => ({
  workspaceId: r.workspace_id,
  path: r.path,
  repo: r.repo,
  branch: r.branch,
  base: r.base,
  sessionId: r.session_id,
  state: r.state === 'active' || r.state === 'kept' || r.state === 'removed' ? r.state : 'reserved',
  createdAt: r.created_at,
});

type ClaudeRow = {
  id: string;
  workspace_id: string;
  name: string;
  directory: string;
  removed_at: string | null;
  created_at: string;
};

function toClaude(row: ClaudeRow): WorkspaceClaude {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    directory: row.directory,
    removedAt: row.removed_at,
    createdAt: row.created_at,
  };
}

/** T-136: an ended-for-integrity session's classification as the payload carries it; null for any other session. */
function endedForOf(row: ChatSessionRow): ChatEndedFor | null {
  if (row.state !== 'ended') return null;
  const e = readEnding(row.ended_reason, row.ended_for);
  return e ? { reason: (row.ended_reason ?? '').slice('integrity: '.length), classified: e.classified, case: e.case, origin: e.origin } : null;
}
