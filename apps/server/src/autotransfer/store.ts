// Auto transfer's rows (migration 220): a user's choices, a Claude's threshold, destinations and exclusion (881), a chat's state, the
// open card, the trail. Every read and write names the owner it is for (`owner_id`); a row of another owner is never returned. Kept 90
// days (events, answered suggestions). No secret and no message text is stored.

import { randomBytes } from 'node:crypto';
import {
  AUTO_MODES,
  type AutoClaudeRef,
  type AutoEventKind,
  type AutoFacts,
  type AutoMode,
  type AutoReason,
  type AutoRefusal,
  type AutoSuggestion,
  type AutoSuggestionState,
  type AutoTransferEvent,
  type AutoUserPrefs,
} from '@portal/contracts';
import type { Store } from '../store/store.js';

const DAY_MS = 86_400_000;
const RETENTION_MS = 90 * DAY_MS;

export interface SessionRow {
  sessionId: string;
  ownerId: string;
  mode: AutoMode | null;
  lastClaudeId: string | null;
  pausedUntil: string | null;
  deferSince: string | null;
  lastEvalAt: string | null;
  warnedPeriod: string | null;
  refusedKey: string | null;
  /** Waiting for quota (T-105 R3): since when and why; null when not waiting. */
  waitingSince: string | null;
  waitingCode: string | null;
  /** The source window period in which the chat was told to finish and stop (the steer, once per period), null when none. */
  steeredPeriod: string | null;
}

/** A Claude's own auto move settings (`autotransfer_claudes`). */
export interface ClaudeRow {
  thresholdPct: number | null;
  destinations: string[];
  /** T-2398: left out of auto move. */
  excluded: boolean;
}

export interface StoredSuggestion extends AutoSuggestion {
  ownerId: string;
  why: string | null;
}

export type NewEvent = Omit<AutoTransferEvent, 'id' | 'at'> & { at?: string };

const json = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : v === 1);
const asMode = (v: unknown): AutoMode | null => (AUTO_MODES as readonly unknown[]).includes(v) ? (v as AutoMode) : null;

export const newSuggestionId = () => `sug_${randomBytes(6).toString('hex')}`;

export class AutoStore {
  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get #db() {
    return this.store.db;
  }
  get #w() {
    return this.store.writable ? this.store.db : null;
  }
  #at() {
    return this.now().toISOString();
  }

  /* ---------- a user's choices ---------- */

  prefs(ownerId: string): AutoUserPrefs {
    const r = this.#db?.prepare('SELECT mode, threshold_pct, use_projection, same_model_only, allow_api_key FROM autotransfer_user WHERE owner_id = ?').get(ownerId) as Record<string, unknown> | undefined;
    return {
      mode: asMode(r?.mode),
      thresholdPct: typeof r?.threshold_pct === 'number' ? r.threshold_pct : null,
      useProjection: bool(r?.use_projection),
      sameModelOnly: bool(r?.same_model_only),
      allowApiKey: bool(r?.allow_api_key),
    };
  }

  setPrefs(ownerId: string, p: AutoUserPrefs): AutoUserPrefs {
    const b = (v: boolean | null) => (v === null ? null : v ? 1 : 0);
    this.#w
      ?.prepare(
        `INSERT INTO autotransfer_user (owner_id, created_by, mode, threshold_pct, use_projection, same_model_only, allow_api_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id) DO UPDATE SET mode = excluded.mode, threshold_pct = excluded.threshold_pct, use_projection = excluded.use_projection,
           same_model_only = excluded.same_model_only, allow_api_key = excluded.allow_api_key, updated_at = excluded.updated_at`,
      )
      .run(ownerId, ownerId, p.mode, p.thresholdPct, b(p.useProjection), b(p.sameModelOnly), b(p.allowApiKey), this.#at());
    return this.prefs(ownerId);
  }

  /* ---------- a Claude's own settings ---------- */

  /** A Claude's own settings for an owner; `excluded` (T-2398, migration 881): left out of auto move, false when it has no row. */
  claude(ownerId: string, claudeId: string): ClaudeRow {
    const sql = 'SELECT threshold_pct, destinations, excluded FROM autotransfer_claudes WHERE owner_id = ? AND claude_id = ?';
    const r = this.#db?.prepare(sql).get(ownerId, claudeId) as Record<string, unknown> | undefined;
    return {
      thresholdPct: typeof r?.threshold_pct === 'number' ? r.threshold_pct : null,
      destinations: json<string[]>(r?.destinations, []).filter((x) => typeof x === 'string'),
      excluded: r?.excluded === 1,
    };
  }

  claudes(ownerId: string): ({ claudeId: string } & ClaudeRow)[] {
    const sql = 'SELECT claude_id, threshold_pct, destinations, excluded FROM autotransfer_claudes WHERE owner_id = ? ORDER BY claude_id';
    const rows = (this.#db?.prepare(sql).all(ownerId) ?? []) as Record<string, unknown>[];
    return rows.map((r) => ({
      claudeId: String(r.claude_id),
      thresholdPct: typeof r.threshold_pct === 'number' ? r.threshold_pct : null,
      destinations: json<string[]>(r.destinations, []),
      excluded: r.excluded === 1,
    }));
  }

  /** The Claudes an owner left out of auto move (T-2398): never a destination, and their own chats are never moved off by themselves. */
  excludedClaudes(ownerId: string): Set<string> {
    const sql = 'SELECT claude_id FROM autotransfer_claudes WHERE owner_id = ? AND excluded = 1';
    const rows = (this.#db?.prepare(sql).all(ownerId) ?? []) as Record<string, unknown>[];
    return new Set(rows.map((r) => String(r.claude_id)));
  }

  setClaude(ownerId: string, claudeId: string, v: ClaudeRow): void {
    this.#w
      ?.prepare(
        `INSERT INTO autotransfer_claudes (owner_id, created_by, claude_id, threshold_pct, destinations, excluded, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, claude_id) DO UPDATE SET threshold_pct = excluded.threshold_pct, destinations = excluded.destinations, excluded = excluded.excluded, updated_at = excluded.updated_at`,
      )
      .run(ownerId, ownerId, claudeId, v.thresholdPct, JSON.stringify(v.destinations), v.excluded ? 1 : 0, this.#at());
  }

  /* ---------- a chat ---------- */

  session(sessionId: string): SessionRow | null {
    const r = this.#db?.prepare('SELECT * FROM autotransfer_sessions WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
    if (!r) return null;
    const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null);
    return {
      sessionId,
      ownerId: String(r.owner_id),
      mode: asMode(r.mode),
      lastClaudeId: s('last_claude_id'),
      pausedUntil: s('paused_until'),
      deferSince: s('defer_since'),
      lastEvalAt: s('last_eval_at'),
      warnedPeriod: s('warned_period'),
      refusedKey: s('refused_key'),
      waitingSince: s('waiting_since'),
      waitingCode: s('waiting_code'),
      steeredPeriod: s('steered_period'),
    };
  }

  /** Changes a chat's row, making it first (for its owner) when it has none. */
  patchSession(sessionId: string, ownerId: string, patch: Partial<Omit<SessionRow, 'sessionId' | 'ownerId'>>): SessionRow {
    const db = this.#w;
    if (db) {
      db.prepare('INSERT INTO autotransfer_sessions (session_id, owner_id, created_by) VALUES (?, ?, ?) ON CONFLICT (session_id) DO NOTHING').run(sessionId, ownerId, ownerId);
      const cols: Record<keyof typeof patch, string> = {
        mode: 'mode',
        lastClaudeId: 'last_claude_id',
        pausedUntil: 'paused_until',
        deferSince: 'defer_since',
        lastEvalAt: 'last_eval_at',
        warnedPeriod: 'warned_period',
        refusedKey: 'refused_key',
        waitingSince: 'waiting_since',
        waitingCode: 'waiting_code',
        steeredPeriod: 'steered_period',
      };
      const keys = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => k in cols);
      if (keys.length) db.prepare(`UPDATE autotransfer_sessions SET ${keys.map((k) => `${cols[k]} = ?`).join(', ')} WHERE session_id = ?`).run(...keys.map((k) => patch[k] ?? null), sessionId);
    }
    return this.session(sessionId) ?? { sessionId, ownerId, mode: null, lastClaudeId: null, pausedUntil: null, deferSince: null, lastEvalAt: null, warnedPeriod: null, refusedKey: null, waitingSince: null, waitingCode: null, steeredPeriod: null };
  }

  /** Sessions with a pause, a deferral or a wait for quota still to come (re-evaluated when it ends; a wait at once, a portal restart included: T-105). */
  pending(): { sessionId: string; at: string }[] {
    const rows = (this.#db?.prepare('SELECT session_id, paused_until, defer_since, waiting_since FROM autotransfer_sessions WHERE paused_until IS NOT NULL OR defer_since IS NOT NULL OR waiting_since IS NOT NULL').all() ?? []) as Record<string, string | null>[];
    return rows.map((r) => ({ sessionId: r.session_id!, at: r.waiting_since ? this.#at() : (r.paused_until ?? r.defer_since!) }));
  }

  /* ---------- the card ---------- */

  #suggestion(r: Record<string, unknown>): StoredSuggestion {
    return {
      id: String(r.id),
      ownerId: String(r.owner_id),
      sessionId: String(r.session_id),
      at: String(r.at),
      reason: r.reason as AutoReason,
      from: json<AutoClaudeRef>(r.from_claude, { id: '', name: '' }),
      to: json<AutoClaudeRef>(r.to_claude, { id: '', name: '' }),
      alternatives: json<AutoClaudeRef[]>(r.alternatives, []),
      facts: json<AutoFacts>(r.facts, {} as AutoFacts),
      handoff: r.handoff === 'skip' ? 'skip' : 'ask',
      dropped: json(r.dropped, { approvals: 0, queued: 0, agents: 0 }),
      state: r.state as AutoSuggestionState,
      why: typeof r.why === 'string' ? r.why : null,
    };
  }

  suggestion(id: string): StoredSuggestion | null {
    const r = this.#db?.prepare('SELECT * FROM autotransfer_suggestions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.#suggestion(r) : null;
  }

  openSuggestion(sessionId: string): StoredSuggestion | null {
    const r = this.#db?.prepare(`SELECT * FROM autotransfer_suggestions WHERE session_id = ? AND state = 'open' ORDER BY at DESC LIMIT 1`).get(sessionId) as Record<string, unknown> | undefined;
    return r ? this.#suggestion(r) : null;
  }

  /** An owner's open cards, newest first (one per chat at most; T-968 S2a). */
  openSuggestions(ownerId: string, limit = 50): StoredSuggestion[] {
    const rows = (this.#db?.prepare(`SELECT * FROM autotransfer_suggestions WHERE owner_id = ? AND state = 'open' ORDER BY at DESC, id LIMIT ?`).all(ownerId, limit) ?? []) as Record<string, unknown>[];
    return rows.map((r) => this.#suggestion(r));
  }

  addSuggestion(s: Omit<StoredSuggestion, 'id' | 'at' | 'state'>): StoredSuggestion {
    const id = newSuggestionId();
    this.#w
      ?.prepare(
        'INSERT INTO autotransfer_suggestions (id, owner_id, created_by, session_id, at, reason, from_claude, to_claude, alternatives, facts, handoff, dropped, why, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, s.ownerId, s.ownerId, s.sessionId, this.#at(), s.reason, JSON.stringify(s.from), JSON.stringify(s.to), JSON.stringify(s.alternatives), JSON.stringify(s.facts), s.handoff, JSON.stringify(s.dropped), s.why, 'open');
    return this.suggestion(id)!;
  }

  /** Refreshes an open card's numbers (the same destination and reason). */
  refreshSuggestion(id: string, s: Pick<StoredSuggestion, 'alternatives' | 'facts' | 'dropped' | 'handoff' | 'why'>): void {
    this.#w?.prepare(`UPDATE autotransfer_suggestions SET alternatives = ?, facts = ?, dropped = ?, handoff = ?, why = ? WHERE id = ? AND state = 'open'`).run(JSON.stringify(s.alternatives), JSON.stringify(s.facts), JSON.stringify(s.dropped), s.handoff, s.why, id);
  }

  /** Closes a card; true when it was open (only one answer wins). */
  closeSuggestion(id: string, state: Exclude<AutoSuggestionState, 'open'>): boolean {
    const r = this.#w?.prepare(`UPDATE autotransfer_suggestions SET state = ?, resolved_at = ? WHERE id = ? AND state = 'open'`).run(state, this.#at(), id);
    return Number(r?.changes ?? 0) > 0;
  }

  /* ---------- the trail ---------- */

  addEvent(e: NewEvent): AutoTransferEvent {
    const at = e.at ?? this.#at();
    const r = this.#w
      ?.prepare(
        'INSERT INTO autotransfer_events (at, owner_id, created_by, session_id, workspace_id, kind, mode, reason, from_claude, to_claude, facts, handoff, handoff_id, code, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(at, e.userId, e.userId, e.sessionId, e.workspaceId, e.kind, e.mode, e.reason, e.from ? JSON.stringify(e.from) : null, e.to ? JSON.stringify(e.to) : null, e.facts ? JSON.stringify(e.facts) : null, e.handoff, e.handoffId, e.code, e.actor.slice(0, 120));
    return { ...e, id: Number(r?.lastInsertRowid ?? 0), at };
  }

  #event(r: Record<string, unknown>): AutoTransferEvent {
    return {
      id: Number(r.id),
      at: String(r.at),
      userId: String(r.owner_id),
      sessionId: String(r.session_id),
      workspaceId: String(r.workspace_id),
      kind: r.kind as AutoEventKind,
      mode: (asMode(r.mode) ?? 'off') as AutoMode,
      reason: (r.reason as AutoReason | null) ?? null,
      from: json<AutoClaudeRef | null>(r.from_claude, null),
      to: json<AutoClaudeRef | null>(r.to_claude, null),
      facts: json<AutoFacts | null>(r.facts, null),
      handoff: r.handoff === 'ask' || r.handoff === 'skip' ? r.handoff : null,
      handoffId: typeof r.handoff_id === 'string' ? r.handoff_id : null,
      code: (r.code as AutoRefusal | null) ?? null,
      actor: String(r.actor),
    };
  }

  /** An owner's trail, newest first; `session` narrows it to one chat. */
  events(ownerId: string, f: { session?: string; limit?: number; before?: number; kinds?: AutoEventKind[]; sinceMs?: number } = {}): AutoTransferEvent[] {
    const where = ['owner_id = ?'];
    const args: (string | number)[] = [ownerId];
    if (f.session) (where.push('session_id = ?'), args.push(f.session));
    if (f.before) (where.push('id < ?'), args.push(f.before));
    if (f.kinds?.length) (where.push(`kind IN (${f.kinds.map(() => '?').join(', ')})`), args.push(...f.kinds));
    if (f.sinceMs !== undefined) (where.push('at >= ?'), args.push(new Date(f.sinceMs).toISOString()));
    const limit = Math.min(Math.max(1, Math.floor(f.limit ?? 50)), 200);
    const rows = (this.#db?.prepare(`SELECT * FROM autotransfer_events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args, limit) ?? []) as Record<string, unknown>[];
    return rows.map((r) => this.#event(r));
  }

  /** A chat's events since a time, any owner (the engine's counters: the chat's own history). */
  sessionEvents(sessionId: string, sinceMs: number, kinds: AutoEventKind[]): AutoTransferEvent[] {
    const rows = (this.#db
      ?.prepare(`SELECT * FROM autotransfer_events WHERE session_id = ? AND at >= ? AND kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT 200`)
      .all(sessionId, new Date(sinceMs).toISOString(), ...kinds) ?? []) as Record<string, unknown>[];
    return rows.map((r) => this.#event(r));
  }

  /** How many events of a kind an owner had since a time (the day cap); `excludeReason` leaves out, say, moves forced by exhaustion (T-105). */
  countOwner(ownerId: string, kind: AutoEventKind, sinceMs: number, excludeReason: AutoReason | null = null): number {
    const extra = excludeReason ? ' AND (reason IS NULL OR reason <> ?)' : '';
    const args: (string | number)[] = [ownerId, kind, new Date(sinceMs).toISOString()];
    if (excludeReason) args.push(excludeReason);
    return (this.#db?.prepare(`SELECT COUNT(*) AS n FROM autotransfer_events WHERE owner_id = ? AND kind = ? AND at >= ?${extra}`).get(...args) as { n: number } | undefined)?.n ?? 0;
  }

  /** Sessions that had an automatic move in the last day (the engine watches them for an Undo). */
  recentlyMoved(sinceMs: number): string[] {
    const rows = (this.#db?.prepare(`SELECT DISTINCT session_id FROM autotransfer_events WHERE kind = 'moved' AND at >= ?`).all(new Date(sinceMs).toISOString()) ?? []) as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }

  /** Drops events and answered cards older than 90 days, and open cards older than a day (they expire). */
  sweep(): void {
    const db = this.#w;
    if (!db) return;
    const now = this.now().getTime();
    const old = new Date(now - RETENTION_MS).toISOString();
    db.prepare('DELETE FROM autotransfer_events WHERE at < ?').run(old);
    db.prepare(`DELETE FROM autotransfer_suggestions WHERE state <> 'open' AND at < ?`).run(old);
    db.prepare(`UPDATE autotransfer_suggestions SET state = 'expired', resolved_at = ? WHERE state = 'open' AND at < ?`).run(new Date(now).toISOString(), new Date(now - DAY_MS).toISOString());
  }
}
