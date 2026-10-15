// Usage spend: the SQL (docs/prd/claude-usage.md §21 to §24). It reads the portal's own `chat_usage`, `chat_sessions` and
// `workspace_claudes` tables (so the totals here are the totals of the Requests report) and keeps four small tables of its own
// (migrations 180 to 182). Every read is tolerant: a missing table or a locked store reads as nothing, because the portal must start and
// explain itself on a database it cannot use (foundation PRD §6.5). Writes need a writable store.

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { BudgetMode, BudgetPeriod, BudgetScope, BudgetScopeKind, ChatSessionState, ChatUsageTotals, SpendAuditEntry, SpikeEvidence, SpikeKind, UsageAlertLevel } from '@portal/contracts';
import type { Store } from '../store/store.js';
import { OWNER_ACTOR } from './actor.js';
import { zeroTotals, type PersonaRecord, type SessionInfo, type UsageRow } from './model.js';

/**
 * The highest level a budget has told in one period, with the percent it stood at then (`quiet`: it crossed while the budget was snoozed,
 * kept so it is not told later, never shown).
 */
export interface BudgetMark {
  level: UsageAlertLevel;
  periodStartMs: number;
  atMs: number;
  usedPct: number;
  quiet?: boolean;
}

export interface BudgetRow {
  id: string;
  name: string;
  scope: BudgetScope;
  period: BudgetPeriod;
  limitUsd: number | null;
  limitTokens: number | null;
  mode: BudgetMode;
  enabled: boolean;
  snoozedUntilMs: number | null;
  mark: BudgetMark | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpikeRow {
  id: number;
  atMs: number;
  kind: SpikeKind;
  subject: string;
  sessionId: string | null;
  workspaceId: string;
  claudeId: string;
  evidence: SpikeEvidence;
  alerted: boolean;
  /** Who the event is for (a user id). */
  owner: string;
}

/** Which requests a sum counts: everything, one workspace, or one Claude (with the requests recorded without a Claude, for a Default one). */
export type ScopeFilter = BudgetScope;

const SESSION_STATES: readonly string[] = ['starting', 'idle', 'working', 'waiting', 'interrupted', 'ended'];
const CHUNK = 400;

function json<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const marks = (v: unknown): BudgetMark | null => {
  const m = v as Partial<BudgetMark> | null;
  return m && typeof m === 'object' && (m.level === 'near' || m.level === 'high' || m.level === 'exhausted') && typeof m.periodStartMs === 'number' && typeof m.atMs === 'number'
    ? { level: m.level, periodStartMs: m.periodStartMs, atMs: m.atMs, usedPct: typeof m.usedPct === 'number' ? m.usedPct : 0, ...(m.quiet ? { quiet: true } : {}) }
    : null;
};

interface BudgetSql {
  id: string;
  name: string;
  scope_kind: string;
  scope_id: string | null;
  period: string;
  limit_usd: number | null;
  limit_tokens: number | null;
  mode: string;
  enabled: number;
  snoozed_until_ms: number | null;
  alerted: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

function toBudget(r: BudgetSql): BudgetRow {
  return {
    id: r.id,
    name: r.name,
    scope: { kind: r.scope_kind as BudgetScopeKind, id: r.scope_id },
    period: r.period as BudgetPeriod,
    limitUsd: r.limit_usd,
    limitTokens: r.limit_tokens,
    mode: r.mode as BudgetMode,
    enabled: r.enabled === 1,
    snoozedUntilMs: r.snoozed_until_ms,
    mark: marks(json<unknown>(r.alerted, null)),
    createdBy: r.created_by || OWNER_ACTOR,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const inList = (n: number): string => `(${Array.from({ length: n }, () => '?').join(',')})`;

export class SpendStore {
  constructor(private readonly store: Store) {}

  /**
   * A session's stored workspace as the `<target>/<name>` key usage is grouped and filtered by (T-42 slice 3: `chat_sessions` stores the
   * stable id). index.ts sets it to the workspaces' registry; as it is, a stored value is taken as it is.
   */
  workspaceKeyOf: (stored: string) => string = (stored) => stored;

  get writable(): boolean {
    return this.store.writable;
  }

  #db(): DatabaseSync | null {
    return this.store.db;
  }

  /** Runs a read; a store that can't answer reads as `fallback`. */
  #read<T>(fallback: T, fn: (db: DatabaseSync) => T): T {
    const db = this.#db();
    if (!db) return fallback;
    try {
      return fn(db);
    } catch {
      return fallback;
    }
  }

  /* ---------- What the portal already keeps ---------- */

  /** Each workspace's Default Claude (its directory is ''), for the requests recorded without a Claude. */
  defaultClaudes(): Map<string, string> {
    return this.#read(new Map<string, string>(), (db) => {
      const rows = db.prepare(`SELECT workspace_id, id FROM workspace_claudes WHERE directory = '' AND removed_at IS NULL ORDER BY created_at`).all() as unknown as { workspace_id: string; id: string }[];
      const out = new Map<string, string>();
      for (const r of rows) if (!out.has(r.workspace_id)) out.set(r.workspace_id, r.id);
      return out;
    });
  }

  /** Every Claude the portal has a record of (removed ones too: their old requests keep their name). */
  claudes(): Map<string, { name: string; workspaceId: string }> {
    return this.#read(new Map<string, { name: string; workspaceId: string }>(), (db) => {
      const rows = db.prepare('SELECT id, workspace_id, name FROM workspace_claudes').all() as unknown as { id: string; workspace_id: string; name: string }[];
      return new Map(rows.map((r) => [r.id, { name: r.name, workspaceId: r.workspace_id }]));
    });
  }

  /** `claude_id` as the report names it: a request recorded without one is under its workspace's Default Claude, else `default:<workspace>`. */
  claudeKey(claudeId: string | null | undefined, workspaceId: string, defaults: ReadonlyMap<string, string> = this.defaultClaudes()): string {
    return claudeId || defaults.get(workspaceId) || `default:${workspaceId}`;
  }

  #scope(scope: ScopeFilter, defaults: ReadonlyMap<string, string>): { sql: string; args: SQLInputValue[] } {
    if (scope.kind === 'all' || !scope.id) return { sql: '1 = 1', args: [] };
    if (scope.kind === 'workspace') return { sql: 'workspace_id = ?', args: [scope.id] };
    if (scope.id.startsWith('default:')) return { sql: `(COALESCE(claude_id, '') = '' AND workspace_id = ?)`, args: [scope.id.slice('default:'.length)] };
    for (const [workspaceId, id] of defaults) if (id === scope.id) return { sql: `(claude_id = ? OR (COALESCE(claude_id, '') = '' AND workspace_id = ?))`, args: [scope.id, workspaceId] };
    return { sql: 'claude_id = ?', args: [scope.id] };
  }

  /** The window's rows, oldest first; `claudeId` and `workspaceId` narrow them, `sessionIds` keeps only those sessions. */
  usageRows(fromMs: number, toMs: number, f: { claudeId?: string; workspaceId?: string; sessionIds?: ReadonlySet<string> } = {}): UsageRow[] {
    return this.#read<UsageRow[]>([], (db) => {
      const defaults = this.defaultClaudes();
      const where = ['at_ms >= ?', 'at_ms < ?'];
      const args: SQLInputValue[] = [fromMs, toMs];
      if (f.workspaceId) (where.push('workspace_id = ?'), args.push(f.workspaceId));
      if (f.claudeId) {
        const s = this.#scope({ kind: 'claude', id: f.claudeId }, defaults);
        where.push(s.sql);
        args.push(...s.args);
      }
      const rows = db
        .prepare(
          `SELECT at_ms, session_id, workspace_id, claude_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, requests, agents, kind
           FROM chat_usage WHERE ${where.join(' AND ')} ORDER BY at_ms, id`,
        )
        .all(...args) as unknown as {
        at_ms: number;
        session_id: string;
        workspace_id: string;
        claude_id: string | null;
        model: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        cost_usd: number;
        requests: number;
        agents: number;
        kind: string;
      }[];
      const out: UsageRow[] = [];
      for (const r of rows) {
        if (f.sessionIds && !f.sessionIds.has(r.session_id)) continue;
        out.push({
          atMs: r.at_ms,
          sessionId: r.session_id,
          workspaceId: r.workspace_id,
          claudeId: this.claudeKey(r.claude_id, r.workspace_id, defaults),
          model: r.model,
          input: r.input_tokens,
          output: r.output_tokens,
          cacheRead: r.cache_read_tokens,
          cacheWrite: r.cache_write_tokens,
          costUsd: r.cost_usd,
          requests: r.requests,
          agents: r.agents,
          kind: r.kind === 'side' ? 'side' : 'turn',
        });
      }
      return out;
    });
  }

  /** What the scope used over [fromMs, toMs): the Requests report's own sums. */
  sum(scope: ScopeFilter, fromMs: number, toMs: number): ChatUsageTotals {
    return this.#read(zeroTotals(), (db) => {
      const s = this.#scope(scope, this.defaultClaudes());
      const r = db
        .prepare(
          `SELECT COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o, COALESCE(SUM(cache_read_tokens), 0) AS cr,
                  COALESCE(SUM(cache_write_tokens), 0) AS cw, COALESCE(SUM(requests), 0) AS n, COALESCE(SUM(agents), 0) AS a
           FROM chat_usage WHERE at_ms >= ? AND at_ms < ? AND ${s.sql}`,
        )
        .get(fromMs, toMs, ...s.args) as unknown as { usd: number; i: number; o: number; cr: number; cw: number; n: number; a: number };
      return { costUsd: r.usd, input: r.i, output: r.o, cacheRead: r.cr, cacheWrite: r.cw, requests: r.n, agents: r.a };
    });
  }

  /** Finished requests of these sessions (one session, or the rows of a continued chain) in (fromMs, toMs], and what they cost. */
  sessionWindow(sessionIds: readonly string[], fromMs: number, toMs: number): { requests: number; costUsd: number } {
    return this.#read({ requests: 0, costUsd: 0 }, (db) => {
      const ids = sessionIds.slice(0, CHUNK);
      const r = db
        .prepare(`SELECT COALESCE(SUM(requests), 0) AS n, COALESCE(SUM(cost_usd), 0) AS usd FROM chat_usage WHERE session_id IN ${inList(ids.length)} AND at_ms > ? AND at_ms <= ?`)
        .get(...ids, fromMs, toMs) as unknown as { n: number; usd: number };
      return { requests: r.n, costUsd: r.usd };
    });
  }

  /** Dollars of the Claude's requests since `fromMs` (to `toMs`, exclusive), and what each session spent of them, most first. */
  claudeWindow(claudeId: string, fromMs: number, toMs: number): { costUsd: number; bySession: { sessionId: string; costUsd: number }[] } {
    return this.#read<{ costUsd: number; bySession: { sessionId: string; costUsd: number }[] }>({ costUsd: 0, bySession: [] }, (db) => {
      const s = this.#scope({ kind: 'claude', id: claudeId }, this.defaultClaudes());
      const rows = db.prepare(`SELECT session_id, SUM(cost_usd) AS usd FROM chat_usage WHERE at_ms >= ? AND at_ms < ? AND ${s.sql} GROUP BY session_id ORDER BY usd DESC`).all(fromMs, toMs, ...s.args) as unknown as { session_id: string; usd: number }[];
      const total = rows.reduce((t, r) => t + r.usd, 0);
      return { costUsd: total, bySession: rows.map((r) => ({ sessionId: r.session_id, costUsd: r.usd })) };
    });
  }

  /** What each earlier ACTIVE 15-minute period of the Claude cost: periods run back from `windowStart`, `periodMs` each, as far as `fromMs`. */
  activePeriods(claudeId: string, windowStart: number, fromMs: number, periodMs: number): number[] {
    return this.#read<number[]>([], (db) => {
      const s = this.#scope({ kind: 'claude', id: claudeId }, this.defaultClaudes());
      const rows = db
        .prepare(
          `SELECT CAST((? - 1 - at_ms) / ? AS INTEGER) AS slot, SUM(cost_usd) AS usd FROM chat_usage
           WHERE at_ms >= ? AND at_ms < ? AND ${s.sql} GROUP BY slot HAVING SUM(cost_usd) > 0`,
        )
        .all(windowStart, periodMs, fromMs, windowStart, ...s.args) as unknown as { usd: number }[];
      return rows.map((r) => r.usd);
    });
  }

  /** What each request of the Claude cost in [fromMs, toMs), those that cost something. */
  requestCosts(claudeId: string, fromMs: number, toMs: number): number[] {
    return this.#read<number[]>([], (db) => {
      const s = this.#scope({ kind: 'claude', id: claudeId }, this.defaultClaudes());
      const rows = db
        .prepare(`SELECT SUM(cost_usd) AS usd FROM chat_usage WHERE at_ms >= ? AND at_ms < ? AND ${s.sql} GROUP BY session_id, at_ms HAVING SUM(cost_usd) > 0`)
        .all(fromMs, toMs, ...s.args) as unknown as { usd: number }[];
      return rows.map((r) => r.usd);
    });
  }

  /** The type, status and done time (ms, when closed as done) of tickets (`T-n`); a ticket that does not exist is not in the map (T-449). */
  ticketFacts(ticketIds: Iterable<string>): Map<string, { type: string; status: string; doneAtMs: number | null }> {
    return this.#read(new Map<string, { type: string; status: string; doneAtMs: number | null }>(), (db) => {
      const out = new Map<string, { type: string; status: string; doneAtMs: number | null }>();
      const numbers = [...new Set(ticketIds)].map((t) => /^T-(\d{1,9})$/.exec(t)?.[1]).filter((n): n is string => !!n).map(Number);
      for (let i = 0; i < numbers.length; i += CHUNK) {
        const part = numbers.slice(i, i + CHUNK);
        const rows = db.prepare(`SELECT number, type, status, closed_at FROM tickets WHERE number IN ${inList(part.length)}`).all(...part) as unknown as { number: number; type: string; status: string; closed_at: string | null }[];
        for (const r of rows) {
          const ms = r.status === 'done' && r.closed_at ? Date.parse(r.closed_at) : NaN;
          out.set(`T-${r.number}`, { type: r.type, status: r.status, doneAtMs: Number.isFinite(ms) ? ms : null });
        }
      }
      return out;
    });
  }

  /* ---------- Sessions ---------- */

  /**
   * The sessions, with the ancestors of each as far as they are known: the live row if the session exists, else what was kept from its last
   * request. A session in neither is not in the map.
   */
  sessions(ids: Iterable<string>): Map<string, SessionInfo> {
    return this.#read(new Map<string, SessionInfo>(), (db) => {
      const defaults = this.defaultClaudes();
      const out = new Map<string, SessionInfo>();
      let want = [...new Set(ids)];
      for (let depth = 0; want.length && depth < 32; depth++) {
        const next = new Set<string>();
        for (let i = 0; i < want.length; i += CHUNK) {
          const part = want.slice(i, i + CHUNK);
          const live = db
            .prepare(`SELECT id, workspace_id, claude_id, parent_id, continued_from, ticket_id, title, state FROM chat_sessions WHERE id IN ${inList(part.length)}`)
            .all(...part) as unknown as {
            id: string;
            workspace_id: string;
            claude_id: string;
            parent_id: string | null;
            continued_from: string | null;
            ticket_id: string | null;
            title: string;
            state: string;
          }[];
          for (const r of live) {
            r.workspace_id = this.workspaceKeyOf(r.workspace_id);
            out.set(r.id, {
              sessionId: r.id,
              workspaceId: r.workspace_id,
              claudeId: this.claudeKey(r.claude_id, r.workspace_id, defaults),
              parentId: r.parent_id,
              continuedFrom: r.continued_from,
              ticketId: r.ticket_id,
              title: r.title,
              state: SESSION_STATES.includes(r.state) ? (r.state as ChatSessionState) : null,
              exists: true,
            });
          }
          const rest = part.filter((id) => !out.has(id));
          if (rest.length) {
            const kept = db
              .prepare(`SELECT session_id, workspace_id, claude_id, parent_id, ticket_id, title FROM usage_sessions WHERE session_id IN ${inList(rest.length)}`)
              .all(...rest) as unknown as { session_id: string; workspace_id: string; claude_id: string; parent_id: string | null; ticket_id: string | null; title: string }[];
            for (const r of kept) {
              out.set(r.session_id, {
                sessionId: r.session_id,
                workspaceId: r.workspace_id,
                claudeId: this.claudeKey(r.claude_id, r.workspace_id, defaults),
                parentId: r.parent_id,
                ticketId: r.ticket_id,
                title: r.title,
                state: null,
                exists: false,
              });
            }
          }
        }
        // The ancestors not yet loaded: the parent, and the session it continues (T-312: its chain rolls up to the root).
        for (const id of want) {
          const s = out.get(id);
          for (const p of [s?.parentId, s?.continuedFrom]) if (p && !out.has(p)) next.add(p);
        }
        want = [...next];
      }
      return out;
    });
  }

  /** Every session below `rootId` (started by it, or by one it started, ...), live or kept; not the root itself. */
  descendants(rootId: string): Set<string> {
    return this.#read(new Set<string>(), (db) => {
      const out = new Set<string>();
      let level = [rootId];
      for (let depth = 0; level.length && depth < 32 && out.size < 5000; depth++) {
        const next: string[] = [];
        for (let i = 0; i < level.length; i += CHUNK) {
          const part = level.slice(i, i + CHUNK);
          const live = db.prepare(`SELECT id FROM chat_sessions WHERE parent_id IN ${inList(part.length)}`).all(...part) as unknown as { id: string }[];
          const kept = db.prepare(`SELECT session_id AS id FROM usage_sessions WHERE parent_id IN ${inList(part.length)}`).all(...part) as unknown as { id: string }[];
          for (const r of [...live, ...kept]) if (r.id !== rootId && !out.has(r.id)) (out.add(r.id), next.push(r.id));
        }
        level = next;
      }
      return out;
    });
  }

  /** The live row of one session (what a request's links are kept from), or null. */
  liveSession(sessionId: string): { workspaceId: string; claudeId: string; parentId: string | null; ticketId: string | null; title: string } | null {
    return this.#read(null, (db) => {
      const r = db.prepare('SELECT workspace_id, claude_id, parent_id, ticket_id, title FROM chat_sessions WHERE id = ?').get(sessionId) as unknown as
        | { workspace_id: string; claude_id: string; parent_id: string | null; ticket_id: string | null; title: string }
        | undefined;
      if (r) r.workspace_id = this.workspaceKeyOf(r.workspace_id);
      return r ? { workspaceId: r.workspace_id, claudeId: this.claudeKey(r.claude_id, r.workspace_id), parentId: r.parent_id, ticketId: r.ticket_id, title: r.title } : null;
    });
  }

  /** Keeps a session's title and links as of its latest request, so they outlive the session. */
  keepSession(s: { sessionId: string; workspaceId: string; claudeId: string; parentId: string | null; ticketId: string | null; title: string }, atMs: number): void {
    const db = this.#db();
    if (!db || !this.writable) return;
    db.prepare(
      `INSERT INTO usage_sessions (session_id, workspace_id, claude_id, parent_id, ticket_id, title, first_at_ms, last_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET workspace_id = excluded.workspace_id, claude_id = excluded.claude_id, parent_id = excluded.parent_id,
         ticket_id = excluded.ticket_id, title = excluded.title, last_at_ms = excluded.last_at_ms`,
    ).run(s.sessionId, s.workspaceId, s.claudeId, s.parentId, s.ticketId, s.title, atMs, atMs);
  }

  /* ---------- Personas ---------- */

  personaRecords(sessionIds: Iterable<string>): Map<string, PersonaRecord[]> {
    return this.#read(new Map<string, PersonaRecord[]>(), (db) => {
      const out = new Map<string, PersonaRecord[]>();
      const ids = [...new Set(sessionIds)];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const part = ids.slice(i, i + CHUNK);
        const rows = db
          .prepare(`SELECT session_id, at_ms, persona_id, persona_name, revision FROM usage_persona WHERE session_id IN ${inList(part.length)} ORDER BY at_ms`)
          .all(...part) as unknown as { session_id: string; at_ms: number; persona_id: string | null; persona_name: string | null; revision: number | null }[];
        for (const r of rows) {
          const list = out.get(r.session_id) ?? [];
          list.push({ atMs: r.at_ms, personaId: r.persona_id, name: r.persona_name, revision: r.revision });
          out.set(r.session_id, list);
        }
      }
      return out;
    });
  }

  lastPersona(sessionId: string): PersonaRecord | null {
    return this.#read(null, (db) => {
      const r = db.prepare('SELECT at_ms, persona_id, persona_name, revision FROM usage_persona WHERE session_id = ? ORDER BY at_ms DESC LIMIT 1').get(sessionId) as unknown as
        | { at_ms: number; persona_id: string | null; persona_name: string | null; revision: number | null }
        | undefined;
      return r ? { atMs: r.at_ms, personaId: r.persona_id, name: r.persona_name, revision: r.revision } : null;
    });
  }

  addPersona(sessionId: string, rec: PersonaRecord): void {
    const db = this.#db();
    if (!db || !this.writable) return;
    db.prepare('INSERT OR REPLACE INTO usage_persona (session_id, at_ms, persona_id, persona_name, revision) VALUES (?, ?, ?, ?, ?)').run(sessionId, rec.atMs, rec.personaId, rec.name, rec.revision);
  }

  /* ---------- Budgets ---------- */

  budgets(): BudgetRow[] {
    return this.#read<BudgetRow[]>([], (db) => (db.prepare('SELECT * FROM usage_budgets ORDER BY created_at, rowid').all() as unknown as BudgetSql[]).map(toBudget));
  }

  budget(id: string): BudgetRow | null {
    return this.#read(null, (db) => {
      const r = db.prepare('SELECT * FROM usage_budgets WHERE id = ?').get(id) as unknown as BudgetSql | undefined;
      return r ? toBudget(r) : null;
    });
  }

  insertBudget(b: Omit<BudgetRow, 'mark' | 'snoozedUntilMs'>): void {
    const db = this.#db();
    if (!db || !this.writable) throw new Error('not writable');
    db.prepare(
      `INSERT INTO usage_budgets (id, name, scope_kind, scope_id, period, limit_usd, limit_tokens, mode, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(b.id, b.name, b.scope.kind, b.scope.id, b.period, b.limitUsd, b.limitTokens, b.mode, b.enabled ? 1 : 0, b.createdBy, b.createdAt, b.updatedAt);
  }

  /** Replaces a budget's fields. `resetAlerts` forgets what it told (its numbers changed, so its alerts follow the new ones). */
  updateBudget(b: Omit<BudgetRow, 'mark' | 'snoozedUntilMs' | 'createdAt' | 'createdBy'>, resetAlerts: boolean): void {
    const db = this.#db();
    if (!db || !this.writable) throw new Error('not writable');
    db.prepare(
      `UPDATE usage_budgets SET name = ?, scope_kind = ?, scope_id = ?, period = ?, limit_usd = ?, limit_tokens = ?, mode = ?, enabled = ?, updated_at = ?${resetAlerts ? `, alerted = '{}'` : ''} WHERE id = ?`,
    ).run(b.name, b.scope.kind, b.scope.id, b.period, b.limitUsd, b.limitTokens, b.mode, b.enabled ? 1 : 0, b.updatedAt, b.id);
  }

  deleteBudget(id: string): boolean {
    const db = this.#db();
    if (!db || !this.writable) throw new Error('not writable');
    return Number(db.prepare('DELETE FROM usage_budgets WHERE id = ?').run(id).changes) > 0;
  }

  saveMark(id: string, mark: BudgetMark | null): void {
    const db = this.#db();
    if (!db || !this.writable) return;
    db.prepare('UPDATE usage_budgets SET alerted = ? WHERE id = ?').run(mark ? JSON.stringify(mark) : '{}', id);
  }

  setBudgetSnooze(id: string, untilMs: number | null): void {
    const db = this.#db();
    if (!db || !this.writable) throw new Error('not writable');
    db.prepare('UPDATE usage_budgets SET snoozed_until_ms = ? WHERE id = ?').run(untilMs, id);
  }

  /* ---------- Spikes ---------- */

  insertSpike(e: Omit<SpikeRow, 'id'>): number {
    const db = this.#db();
    if (!db || !this.writable) return 0;
    const r = db
      .prepare('INSERT INTO usage_spikes (at_ms, kind, subject, session_id, workspace_id, claude_id, evidence, alerted, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.atMs, e.kind, e.subject, e.sessionId, e.workspaceId, e.claudeId, JSON.stringify(e.evidence), e.alerted ? 1 : 0, e.owner);
    return Number(r.lastInsertRowid);
  }

  spikesSince(sinceMs: number): SpikeRow[] {
    return this.#read<SpikeRow[]>([], (db) => {
      const rows = db.prepare('SELECT id, at_ms, kind, subject, session_id, workspace_id, claude_id, evidence, alerted, owner FROM usage_spikes WHERE at_ms >= ? ORDER BY at_ms DESC, id DESC').all(sinceMs) as unknown as {
        id: number;
        at_ms: number;
        kind: string;
        subject: string;
        session_id: string | null;
        workspace_id: string;
        claude_id: string;
        evidence: string;
        alerted: number;
        owner: string;
      }[];
      const out: SpikeRow[] = [];
      for (const r of rows) {
        const evidence = json<SpikeEvidence | null>(r.evidence, null);
        if (!evidence || evidence.kind !== r.kind) continue; // a damaged row is skipped, never shown half-read
        out.push({ id: r.id, atMs: r.at_ms, kind: r.kind as SpikeKind, subject: r.subject, sessionId: r.session_id, workspaceId: r.workspace_id, claudeId: r.claude_id, evidence, alerted: r.alerted === 1, owner: r.owner || OWNER_ACTOR });
      }
      return out;
    });
  }

  lastSpikeAt(kind: SpikeKind, subject: string): number | null {
    return this.#read(null, (db) => {
      const r = db.prepare('SELECT MAX(at_ms) AS at FROM usage_spikes WHERE kind = ? AND subject = ?').get(kind, subject) as unknown as { at: number | null };
      return r.at;
    });
  }

  spikeSnoozes(nowMs: number): Map<string, number> {
    return this.#read(new Map<string, number>(), (db) => {
      const rows = db.prepare('SELECT subject, until_ms FROM usage_spike_snoozes WHERE until_ms > ?').all(nowMs) as unknown as { subject: string; until_ms: number }[];
      return new Map(rows.map((r) => [r.subject, r.until_ms]));
    });
  }

  setSpikeSnooze(subject: string, untilMs: number | null): void {
    const db = this.#db();
    if (!db || !this.writable) throw new Error('not writable');
    if (untilMs === null) db.prepare('DELETE FROM usage_spike_snoozes WHERE subject = ?').run(subject);
    else db.prepare('INSERT INTO usage_spike_snoozes (subject, until_ms) VALUES (?, ?) ON CONFLICT (subject) DO UPDATE SET until_ms = excluded.until_ms').run(subject, untilMs);
  }

  /** Spike events and audit entries older than `beforeMs`, and snoozes that have run out. */
  prune(beforeMs: number, nowMs: number): void {
    const db = this.#db();
    if (!db || !this.writable) return;
    db.prepare('DELETE FROM usage_spikes WHERE at_ms < ?').run(beforeMs);
    db.prepare('DELETE FROM usage_spike_snoozes WHERE until_ms <= ?').run(nowMs);
    db.prepare('DELETE FROM usage_audit WHERE at < ?').run(new Date(beforeMs).toISOString());
  }

  /* ---------- Audit ---------- */

  addAudit(e: Omit<SpendAuditEntry, 'id'>): void {
    const db = this.#db();
    if (!db || !this.writable) return;
    db.prepare('INSERT INTO usage_audit (at, actor, via, action, object_kind, object_id, summary) VALUES (?, ?, ?, ?, ?, ?, ?)').run(e.at, e.actor, e.via, e.action, e.objectKind, e.objectId, e.summary);
  }

  /** The audit trail, newest first. */
  audit(limit: number): SpendAuditEntry[] {
    return this.#read<SpendAuditEntry[]>([], (db) => {
      const rows = db.prepare('SELECT id, at, actor, via, action, object_kind, object_id, summary FROM usage_audit ORDER BY id DESC LIMIT ?').all(limit) as unknown as {
        id: number;
        at: string;
        actor: string;
        via: string;
        action: SpendAuditEntry['action'];
        object_kind: SpendAuditEntry['objectKind'];
        object_id: string;
        summary: string;
      }[];
      return rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, via: r.via, action: r.action, objectKind: r.object_kind, objectId: r.object_id, summary: r.summary }));
    });
  }
}
