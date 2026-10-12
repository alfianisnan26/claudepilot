// Side questions (btw): the table behind them (migration 380, chat-sessions PRD §20.6) and the usage rows they leave. Synchronous, like ChatStore.
// Every read and write names the person (`user_id`): a btw is private to the one who asked, so nothing here finds one by id alone.

import { BTW_USAGE_KIND, type BtwContext, type BtwReason, type BtwStatus, type BtwUsage, type ChatBtw } from '@portal/contracts';
import type { Store } from '../store/store.js';

/** A btw as the engine holds it: the wire state plus who asked and where. */
export interface BtwRecord extends ChatBtw {
  userId: string;
  /** `actorString(actor)` of whoever asked, for the audit trail. */
  actor: string;
  workspaceId: string;
  claudeId: string;
  askedMs: number;
}

interface Row {
  id: string;
  session_id: string;
  user_id: string;
  actor: string;
  workspace_id: string;
  claude_id: string;
  question: string;
  answer: string;
  status: string;
  reason: string | null;
  note: string | null;
  retry_after_ms: number | null;
  model: string | null;
  ctx_messages: number | null;
  ctx_truncated: number | null;
  ctx_last_seq: number | null;
  ctx_chars: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  basis: string | null;
  pinned_seq: number | null;
  closed: number;
  asked_at: string;
  asked_ms: number;
  settled_at: string | null;
}

function toRecord(r: Row): BtwRecord {
  const rec: BtwRecord = {
    id: r.id,
    session: r.session_id,
    question: r.question,
    status: r.status as BtwStatus,
    answer: r.answer,
    askedAt: r.asked_at,
    userId: r.user_id,
    actor: r.actor,
    workspaceId: r.workspace_id,
    claudeId: r.claude_id,
    askedMs: r.asked_ms,
  };
  if (r.reason) rec.reason = r.reason as BtwReason;
  if (r.note) rec.note = r.note;
  if (r.retry_after_ms !== null) rec.retryAfterMs = r.retry_after_ms;
  if (r.settled_at) rec.settledAt = r.settled_at;
  if (r.model) rec.model = r.model;
  if (r.ctx_messages !== null) {
    const context: BtwContext = { messages: r.ctx_messages, truncated: r.ctx_truncated === 1, lastSeq: r.ctx_last_seq ?? 0, chars: r.ctx_chars ?? 0 };
    rec.context = context;
  }
  if (r.basis === 'reported' || r.basis === 'estimated') {
    const usage: BtwUsage = { input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens, cacheWrite: r.cache_write_tokens, costUsd: r.cost_usd, estimate: true, basis: r.basis };
    rec.usage = usage;
  }
  if (r.pinned_seq !== null) rec.pinnedSeq = r.pinned_seq;
  if (r.closed === 1) rec.closed = true;
  return rec;
}

/** The wire state of a record: nothing about who asked. */
export function snapshot(rec: BtwRecord): ChatBtw {
  const { userId: _u, actor: _a, workspaceId: _w, claudeId: _c, askedMs: _m, ...wire } = rec;
  void [_u, _a, _w, _c, _m];
  return wire;
}

export class BtwStore {
  readonly #store: Store;
  readonly #now: () => Date;

  constructor(store: Store, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  #db() {
    const db = this.#store.db;
    if (!db) throw new Error('The chat store has no database.');
    return db;
  }

  #writable() {
    const db = this.#db();
    if (!this.#store.writable) throw new Error('The chat store is read-only.');
    return db;
  }

  /** A new record, `running`. The caller has chosen the id (the tab's UUID): a second insert of the same (person, session, id) is a no-op that returns false. */
  insert(rec: BtwRecord): boolean {
    const r = this.#writable()
      .prepare(
        `INSERT OR IGNORE INTO chat_btw (id, session_id, user_id, created_by, actor, workspace_id, claude_id, question, answer, status, model,
           ctx_messages, ctx_truncated, ctx_last_seq, ctx_chars, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, basis, asked_at, asked_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.session,
        rec.userId,
        rec.userId,
        rec.actor,
        rec.workspaceId,
        rec.claudeId,
        rec.question,
        rec.answer,
        rec.status,
        rec.model ?? null,
        rec.context?.messages ?? null,
        rec.context ? (rec.context.truncated ? 1 : 0) : null,
        rec.context?.lastSeq ?? null,
        rec.context?.chars ?? null,
        rec.usage?.input ?? 0,
        rec.usage?.output ?? 0,
        rec.usage?.cacheRead ?? 0,
        rec.usage?.cacheWrite ?? 0,
        rec.usage?.costUsd ?? null,
        rec.usage?.basis ?? null,
        rec.askedAt,
        rec.askedMs,
      );
    return Number(r.changes) > 0;
  }

  get(userId: string, sessionId: string, id: string): BtwRecord | null {
    const row = this.#db().prepare('SELECT * FROM chat_btw WHERE user_id = ? AND session_id = ? AND id = ?').get(userId, sessionId, id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /** Writes the parts of a record that change over its life. */
  save(rec: BtwRecord): void {
    this.#writable()
      .prepare(
        `UPDATE chat_btw SET answer = ?, status = ?, reason = ?, note = ?, retry_after_ms = ?, model = ?, ctx_messages = ?, ctx_truncated = ?, ctx_last_seq = ?, ctx_chars = ?,
           input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?, basis = ?, pinned_seq = ?, closed = ?, settled_at = ?
         WHERE user_id = ? AND session_id = ? AND id = ?`,
      )
      .run(
        rec.answer,
        rec.status,
        rec.reason ?? null,
        rec.note ?? null,
        rec.retryAfterMs ?? null,
        rec.model ?? null,
        rec.context?.messages ?? null,
        rec.context ? (rec.context.truncated ? 1 : 0) : null,
        rec.context?.lastSeq ?? null,
        rec.context?.chars ?? null,
        rec.usage?.input ?? 0,
        rec.usage?.output ?? 0,
        rec.usage?.cacheRead ?? 0,
        rec.usage?.cacheWrite ?? 0,
        rec.usage?.costUsd ?? null,
        rec.usage?.basis ?? null,
        rec.pinnedSeq ?? null,
        rec.closed ? 1 : 0,
        rec.settledAt ?? null,
        rec.userId,
        rec.session,
        rec.id,
      );
  }

  /** The person's btws on a session that are still open (not closed) and were asked at or after `sinceMs`, newest first. */
  open(userId: string, sessionId: string, sinceMs: number, limit: number): BtwRecord[] {
    const rows = this.#db()
      .prepare('SELECT * FROM chat_btw WHERE user_id = ? AND session_id = ? AND closed = 0 AND asked_ms >= ? ORDER BY asked_ms DESC LIMIT ?')
      .all(userId, sessionId, sinceMs, limit) as unknown as Row[];
    return rows.map(toRecord);
  }

  /** How many runs a session started at or after `sinceMs` (any person's), and when the oldest of them did: the rate limit reads both. */
  startedSince(sessionId: string, sinceMs: number): { count: number; oldestMs: number | null } {
    const row = this.#db().prepare('SELECT COUNT(*) AS n, MIN(asked_ms) AS oldest FROM chat_btw WHERE session_id = ? AND asked_ms >= ?').get(sessionId, sinceMs) as { n: number; oldest: number | null };
    return { count: row.n, oldestMs: row.oldest };
  }

  /** Records left `running` by a restart can never finish: they end as failed. Returns how many. */
  failRunning(note: string): number {
    const r = this.#writable()
      .prepare(`UPDATE chat_btw SET status = 'failed', reason = 'error', note = ?, settled_at = ? WHERE status = 'running'`)
      .run(note, this.#now().toISOString());
    return Number(r.changes);
  }

  /**
   * A side question's usage as one row among the turns' (`kind = 'side'`, `ref` = the btw): the same columns, so every total, budget and report that
   * adds rows up counts it, and one that splits by `kind` can show it apart. The row stays when the session is deleted, like every usage row.
   */
  recordSideUsage(turn: { atMs: number; sessionId: string; workspaceId: string; claudeId: string | null; btwId: string; model: string; durationMs: number }, u: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }): void {
    this.#writable()
      .prepare(
        `INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, requests, agents, duration_ms, kind, ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
      )
      .run(new Date(turn.atMs).toISOString(), turn.atMs, turn.sessionId, turn.workspaceId, turn.claudeId, turn.model, u.input, u.output, u.cacheRead, u.cacheWrite, u.costUsd, turn.durationMs, BTW_USAGE_KIND, turn.btwId);
  }
}
