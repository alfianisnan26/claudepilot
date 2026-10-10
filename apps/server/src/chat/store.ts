// Chat sessions: the database layer (chat-sessions PRD §9). Synchronous over `node:sqlite`, redacted,
// and never a secret — only allowlisted fields of each event are kept, every stored text passes the
// credential redactor (redact.ts), and large text is truncated.

import type {
  ChatEvent,
  ChatEventKind,
  ChatImage,
  ChatInputState,
  ChatOrigin,
  ChatPermissionMode,
  ChatRequest,
  ChatSession,
  ChatSessionState,
  ChatTask,
} from '@portal/contracts';
import type { Store } from '../store/store.js';
import type { StoredEvent, TaskPatch } from './protocol.js';
import { redact, redactMaybe } from './redact.js';

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
  created_at: string;
  last_activity_at: string;
  ended_reason: string | null;
  archived_at: string | null;
};

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
  status: string | null;
  tokens: number | null;
  tool_uses: number | null;
  duration_ms: number | null;
  summary: string | null;
  started_at: string | null;
  ended_at: string | null;
};

type RequestRow = {
  request_id: string;
  tool_use_id: string | null;
  kind: string;
  tool_name: string | null;
  agent_label: string | null;
  title: string;
  detail: string | null;
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
  segment?: number;
  byteOffset?: number;
  parentPid?: number | null;
  processStartedAt?: string | null;
  process?: 'live' | 'asleep' | 'gone';
  endedReason?: string | null;
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
const MAX_TEXT = 16_000;

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
  return ref;
}

/** The chat tables (migrations v6–v7), wrapped around the portal {@link Store}. All methods are synchronous. */
export class ChatStore {
  readonly #store: Store;
  readonly #now: () => Date;
  /** Nesting depth of {@link transaction} (SQLite has no nested BEGIN). */
  #txDepth = 0;

  constructor(store: Store, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
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

  create(opts: { id: string; workspaceId: string; cwd: string; title: string; origin: ChatOrigin }): ChatSession {
    const now = this.#stamp();
    this.#writable()
      .prepare(
        `INSERT INTO chat_sessions (id, workspace_id, cwd, title, origin, state, state_since, created_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, 'starting', ?, ?, ?)`,
      )
      .run(opts.id, opts.workspaceId, opts.cwd, opts.title, opts.origin, now, now, now);
    return this.get(opts.id)!;
  }

  get(id: string): ChatSession | null {
    const row = this.#db().prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as ChatSessionRow | undefined;
    return row ? this.toSession(row) : null;
  }

  /** The raw session row (for the controller's segment/offset/cwd/process bookkeeping). */
  row(id: string): ChatSessionRow | null {
    return (this.#db().prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as ChatSessionRow | undefined) ?? null;
  }

  list(): ChatSession[] {
    const rows = this.#db().prepare('SELECT * FROM chat_sessions ORDER BY last_activity_at DESC, created_at DESC').all() as ChatSessionRow[];
    return rows.map((r) => this.toSession(r));
  }

  /** Sessions whose process should be running (for liveness checks and reattaching after a restart). */
  liveRows(): ChatSessionRow[] {
    return this.#db().prepare(`SELECT * FROM chat_sessions WHERE process = 'live' AND state != 'ended'`).all() as ChatSessionRow[];
  }

  toSession(row: ChatSessionRow): ChatSession {
    const waiting = (this.#db().prepare('SELECT count(*) AS n FROM chat_requests WHERE session_id = ? AND answered_at IS NULL').get(row.id) as { n: number }).n;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      state: row.state as ChatSessionState,
      origin: row.origin as ChatOrigin,
      model: row.model ?? null,
      mode: row.mode as ChatPermissionMode,
      effort: row.effort ?? null,
      ultracode: row.ultracode === 1,
      ultracodeAvailable: row.ultracode_available === 1,
      process: PROCESS_STATES.has(row.process) ? (row.process as ChatSession['process']) : 'gone',
      costUsd: row.cost_est_usd,
      turns: row.turns,
      lastSeq: row.last_seq,
      waiting,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      endedReason: row.ended_reason ?? null,
    };
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
      .prepare(`SELECT 1 FROM chat_events WHERE session_id = ? AND kind = 'system' AND json_extract(payload, '$.text') = 'Ready' LIMIT 1`)
      .get(sessionId);
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
    if (patch.cost !== undefined) set('cost_est_usd', patch.cost);
    if (patch.turnsDelta !== undefined) {
      sets.push('turns = turns + ?');
      vals.push(patch.turnsDelta);
    }
    if (patch.segment !== undefined) set('segment', patch.segment);
    if (patch.byteOffset !== undefined) set('byte_offset', patch.byteOffset);
    if (patch.parentPid !== undefined) set('parent_pid', patch.parentPid);
    if (patch.processStartedAt !== undefined) set('process_started_at', patch.processStartedAt);
    if (patch.process !== undefined) set('process', patch.process);
    if (patch.endedReason !== undefined) set('ended_reason', redactMaybe(patch.endedReason));
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

  setControlState(sessionId: string, key: string, state: ControlLineState): void {
    this.#writable().prepare(`UPDATE chat_inputs SET state = ? WHERE session_id = ? AND uuid = ? AND kind = 'control'`).run(state, sessionId, key);
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
        'SELECT task_id, tool_use_id, label, subagent_type, status, tokens, tool_uses, duration_ms, summary, started_at, ended_at FROM chat_tasks WHERE session_id = ? ORDER BY started_at, task_id',
      )
      .all(sessionId) as TaskRow[];
    return rows.map((r) => ({
      taskId: r.task_id,
      toolUseId: r.tool_use_id,
      description: r.label ?? '',
      subagentType: r.subagent_type,
      status: r.status && TASK_STATUSES.has(r.status) ? (r.status as ChatTask['status']) : 'running',
      tokens: r.tokens,
      toolUses: r.tool_uses,
      durationMs: r.duration_ms,
      summary: r.summary,
      startedAt: r.started_at ?? '',
      endedAt: r.ended_at,
    }));
  }

  /** Whether a sub-agent or background task is still running. */
  hasRunningTasks(sessionId: string): boolean {
    return !!this.#db().prepare(`SELECT 1 FROM chat_tasks WHERE session_id = ? AND (status IS NULL OR status = 'running') LIMIT 1`).get(sessionId);
  }

  /** Its process is gone, and its sub-agents and background tasks with it: they read `killed`. Says whether any did. */
  endRunningTasks(sessionId: string): boolean {
    const result = this.#writable()
      .prepare(`UPDATE chat_tasks SET status = 'killed', ended_at = coalesce(ended_at, ?) WHERE session_id = ? AND (status IS NULL OR status = 'running')`)
      .run(this.#stamp(), sessionId);
    return Number(result.changes) > 0;
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
    this.#writable()
      .prepare(`INSERT INTO chat_requests (session_id, request_id, tool_use_id, kind, tool_name, agent_label, title, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, req.requestId, req.toolUseId ?? null, req.kind, req.toolName ?? null, req.agentLabel ?? null, req.title, detail, createdAt);
    return { requestId: req.requestId, kind: req.kind, toolName: req.toolName ?? null, agentLabel: req.agentLabel ?? null, title: req.title, detail, createdAt };
  }

  /** Its process is gone: requests nobody can answer any more read `expired`. Returns their ids. */
  expireOpenRequests(sessionId: string): string[] {
    const db = this.#writable();
    const rows = db.prepare('SELECT request_id FROM chat_requests WHERE session_id = ? AND answered_at IS NULL ORDER BY created_at').all(sessionId) as { request_id: string }[];
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

  openRequests(sessionId: string): ChatRequest[] {
    const rows = this.#db()
      .prepare('SELECT request_id, tool_use_id, kind, tool_name, agent_label, title, detail, created_at FROM chat_requests WHERE session_id = ? AND answered_at IS NULL ORDER BY created_at')
      .all(sessionId) as RequestRow[];
    return rows.map((r) => ({
      requestId: r.request_id,
      kind: r.kind as ChatRequest['kind'],
      toolName: r.tool_name,
      agentLabel: r.agent_label,
      title: r.title,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }

  /** Only the allowlisted display fields of an event (never a raw tool input blob), with credentials redacted. */
  #payload(ev: StoredEvent): Record<string, unknown> {
    const p: Record<string, unknown> = {};
    if (ev.text !== undefined) {
      const text = redact(ev.text); // whole, before truncating, so a cut never splits a credential
      p.text = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
    }
    if (ev.toolName !== undefined) p.toolName = ev.toolName;
    if (ev.request !== undefined) p.request = { ...ev.request, detail: redactMaybe(ev.request.detail) };
    if (ev.outcome !== undefined) p.outcome = ev.outcome;
    if (ev.costUsd !== undefined) p.costUsd = ev.costUsd;
    // A call's id, kept (not shown) so a result read after a restart can still be named.
    if (ev.kind === 'tool_use' && ev.toolUseId) p.toolUseId = ev.toolUseId;
    // The readable sub-agent label, when it isn't just the raw parent_tool_use_id kept in its column.
    if (ev.agentLabel && ev.agentLabel !== ev.parentToolUseId) p.agentLabel = redact(ev.agentLabel);
    // Blob references only: base64 never reaches a row (the controller moves it to the blob store).
    const images = (ev.images ?? []).map(imageRef).filter((i): i is ChatImage => i !== null);
    if (images.length) p.images = images;
    return p;
  }

  #toEvent(row: EventRow): ChatEvent {
    const payload = this.#parsePayload(row.payload);
    const ev: ChatEvent = { seq: row.seq, at: row.at, kind: row.kind as ChatEventKind };
    if (typeof payload.text === 'string') ev.text = payload.text;
    const agentLabel = typeof payload.agentLabel === 'string' ? payload.agentLabel : row.parent_tool_use_id;
    if (agentLabel !== null) ev.agentLabel = agentLabel;
    if (typeof payload.toolName === 'string') ev.toolName = payload.toolName;
    if (row.request_id !== null) ev.requestId = row.request_id;
    if (payload.request && typeof payload.request === 'object') ev.request = payload.request as ChatRequest;
    if (typeof payload.outcome === 'string') ev.outcome = payload.outcome;
    if (typeof payload.costUsd === 'number') ev.costUsd = payload.costUsd;
    if (Array.isArray(payload.images)) {
      const images = payload.images.map(imageRef).filter((i): i is ChatImage => i !== null);
      if (images.length) ev.images = images;
    }
    if (row.kind === 'user' && row.uuid !== null) ev.uuid = row.uuid;
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
