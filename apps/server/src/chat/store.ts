// Chat sessions: the database layer (chat-sessions PRD §9). Synchronous over `node:sqlite`, redacted,
// and never a secret — only allowlisted fields of each event are kept, and large text is truncated.

import type { ChatEvent, ChatEventKind, ChatOrigin, ChatPermissionMode, ChatRequest, ChatSession, ChatSessionState } from '@portal/contracts';
import type { Store } from '../store/store.js';
import type { StoredEvent } from './protocol.js';

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

/** The lifecycle states a sent line moves through (chat-sessions PRD §9). */
export type ChatInputState = 'sending' | 'queued' | 'started' | 'completed' | 'cancelled' | 'discarded' | 'refused' | 'failed';

/** Whole, redacted event text over this many characters is truncated before it reaches the row. */
const MAX_TEXT = 16_000;

/** The chat tables (migration v6), wrapped around the portal {@link Store}. All methods are synchronous. */
export class ChatStore {
  readonly #store: Store;
  readonly #now: () => Date;

  constructor(store: Store, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
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

  /** Whether the session already has an event of this kind (e.g. the one-time `system` "Ready"). */
  hasEventKind(sessionId: string, kind: ChatEventKind): boolean {
    return !!this.#db().prepare('SELECT 1 FROM chat_events WHERE session_id = ? AND kind = ? LIMIT 1').get(sessionId, kind);
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
    if (patch.endedReason !== undefined) set('ended_reason', patch.endedReason);
    if (!sets.length) return;
    db.prepare(`UPDATE chat_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  addInput(sessionId: string, uuid: string, actor: string | null, kind: 'message' | 'control', priority: string | null): void {
    this.#writable()
      .prepare(`INSERT INTO chat_inputs (session_id, uuid, actor, kind, priority, state, created_at) VALUES (?, ?, ?, ?, ?, 'sending', ?)`)
      .run(sessionId, uuid, actor, kind, priority, this.#stamp());
  }

  setInputState(sessionId: string, uuid: string, state: ChatInputState): void {
    this.#writable().prepare('UPDATE chat_inputs SET state = ? WHERE session_id = ? AND uuid = ?').run(state, sessionId, uuid);
  }

  hasInput(sessionId: string, uuid: string): boolean {
    return !!this.#db().prepare('SELECT 1 FROM chat_inputs WHERE session_id = ? AND uuid = ?').get(sessionId, uuid);
  }

  /** Records a request the agent raised and returns it with its stored timestamp. Throws on a duplicate id. */
  addRequest(sessionId: string, req: ChatRequest & { toolUseId?: string }): ChatRequest {
    const createdAt = this.#stamp();
    this.#writable()
      .prepare(`INSERT INTO chat_requests (session_id, request_id, tool_use_id, kind, tool_name, agent_label, title, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, req.requestId, req.toolUseId ?? null, req.kind, req.toolName ?? null, req.agentLabel ?? null, req.title, req.detail ?? null, createdAt);
    return { requestId: req.requestId, kind: req.kind, toolName: req.toolName ?? null, agentLabel: req.agentLabel ?? null, title: req.title, detail: req.detail ?? null, createdAt };
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

  /** Only the allowlisted display fields of an event (never a raw tool input blob). */
  #payload(ev: StoredEvent): Record<string, unknown> {
    const p: Record<string, unknown> = {};
    if (ev.text !== undefined) p.text = ev.text.length > MAX_TEXT ? `${ev.text.slice(0, MAX_TEXT)}…` : ev.text;
    if (ev.toolName !== undefined) p.toolName = ev.toolName;
    if (ev.request !== undefined) p.request = ev.request;
    if (ev.outcome !== undefined) p.outcome = ev.outcome;
    if (ev.costUsd !== undefined) p.costUsd = ev.costUsd;
    return p;
  }

  #toEvent(row: EventRow): ChatEvent {
    const payload = this.#parsePayload(row.payload);
    const ev: ChatEvent = { seq: row.seq, at: row.at, kind: row.kind as ChatEventKind };
    if (typeof payload.text === 'string') ev.text = payload.text;
    if (row.parent_tool_use_id !== null) ev.agentLabel = row.parent_tool_use_id;
    if (typeof payload.toolName === 'string') ev.toolName = payload.toolName;
    if (row.request_id !== null) ev.requestId = row.request_id;
    if (payload.request && typeof payload.request === 'object') ev.request = payload.request as ChatRequest;
    if (typeof payload.outcome === 'string') ev.outcome = payload.outcome;
    if (typeof payload.costUsd === 'number') ev.costUsd = payload.costUsd;
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
