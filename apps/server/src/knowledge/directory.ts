// Knowledge: what the graphs know of the rest of the portal (Knowledge PRD §12). Sessions, tickets, workspaces, Claudes
// and pools belong to other areas of the portal; this reads them and nothing more. It is read-only and tolerant of what
// is missing: a table or column that isn't there (an older database, a feature not built yet) means "none", never an
// error, so a graph shows what exists. Anything else that goes wrong is a bug and is thrown.

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export interface SessionInfo {
  id: string;
  workspaceId: string;
  title: string;
  state: string;
  claudeId: string;
  ticketId: string | null;
  parentId: string | null;
  startedBy: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  at: string;
}

export interface TicketInfo {
  /** `T-12`. */
  id: string;
  summary: string;
  status: string;
  assigneeKind: string | null;
  assigneeRef: string | null;
  workspaceId: string | null;
  worktreeBranch: string | null;
  at: string;
}

export interface ClaudeInfo {
  id: string;
  workspaceId: string;
  name: string;
}

export interface PoolUse {
  workspaceId: string;
  poolId: string;
  type: string;
  name: string;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const orNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const CHUNK = 400;
const chunked = (ids: string[]): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));
  return out;
};

/** The error SQLite gives for a table or a column an older or newer database doesn't have. */
const isMissing = (e: unknown) => /no such (table|column)/i.test((e as Error)?.message ?? '');

/** The pool types a workspace can be seen using (secrets are not drawn). */
export const GRAPH_POOL_TYPES = ['persona', 'skillset', 'mcpset', 'context'] as const;

export class Directory {
  constructor(private readonly dbOf: () => DatabaseSync | null) {}

  /**
   * A ticket's stored workspace as the `<target>/<name>` key the graphs link by (T-42 slice 3: tickets store the stable id). index.ts sets it
   * to the workspaces' registry; as it is, a stored value is taken as it is.
   */
  workspaceKeyOf: (stored: string | null) => string | null = (stored) => stored;

  /** Runs the first query that the database can answer (later ones are for databases with fewer columns). */
  #all(variants: string[], params: SQLInputValue[] = []): Row[] {
    const db = this.dbOf();
    if (!db) return [];
    for (const sql of variants) {
      try {
        return db.prepare(sql).all(...params) as unknown as Row[];
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    }
    return [];
  }

  static #session(r: Row): SessionInfo {
    return {
      id: str(r.id),
      workspaceId: str(r.workspace_id),
      title: str(r.title),
      state: str(r.state),
      claudeId: str(r.claude_id),
      ticketId: orNull(r.ticket_id),
      parentId: orNull(r.parent_id),
      startedBy: orNull(r.started_by),
      worktreePath: orNull(r.worktree_path),
      worktreeBranch: orNull(r.worktree_branch),
      at: str(r.last_activity_at),
    };
  }

  static readonly #FULL = 'id, workspace_id, title, state, claude_id, ticket_id, parent_id, started_by, worktree_path, worktree_branch, last_activity_at';
  static readonly #BASIC = "id, workspace_id, title, state, '' AS claude_id, NULL AS ticket_id, NULL AS parent_id, NULL AS started_by, NULL AS worktree_path, NULL AS worktree_branch, last_activity_at";

  /** The most recently active sessions that aren't archived. */
  recentSessions(limit: number, since: string | null): SessionInfo[] {
    const where = `archived_at IS NULL${since ? ' AND last_activity_at >= ?' : ''}`;
    const params: SQLInputValue[] = since ? [since, limit] : [limit];
    return this.#all(
      [`SELECT ${Directory.#FULL} FROM chat_sessions WHERE ${where} ORDER BY last_activity_at DESC LIMIT ?`, `SELECT ${Directory.#BASIC} FROM chat_sessions WHERE ${where} ORDER BY last_activity_at DESC LIMIT ?`],
      params,
    ).map(Directory.#session);
  }

  /**
   * Sessions by id, archived ones too. An id that was folded into another session (a chat that moved to another
   * Claude keeps its old ids as aliases) finds the session it became; the key stays the id asked for.
   */
  sessionsByIds(ids: string[]): Map<string, SessionInfo> {
    const out = new Map<string, SessionInfo>();
    for (const chunk of chunked([...new Set(ids)])) {
      const marks = chunk.map(() => '?').join(', ');
      for (const r of this.#all([`SELECT ${Directory.#FULL} FROM chat_sessions WHERE id IN (${marks})`, `SELECT ${Directory.#BASIC} FROM chat_sessions WHERE id IN (${marks})`], chunk)) out.set(str(r.id), Directory.#session(r));
      const missing = chunk.filter((id) => !out.has(id));
      if (!missing.length) continue;
      const m2 = missing.map(() => '?').join(', ');
      const aliases = this.#all([`SELECT alias_id, session_id FROM chat_session_aliases WHERE alias_id IN (${m2})`], missing);
      const targets = [...new Set(aliases.map((a) => str(a.session_id)))];
      if (!targets.length) continue;
      const m3 = targets.map(() => '?').join(', ');
      const found = new Map(this.#all([`SELECT ${Directory.#FULL} FROM chat_sessions WHERE id IN (${m3})`, `SELECT ${Directory.#BASIC} FROM chat_sessions WHERE id IN (${m3})`], targets).map((r) => [str(r.id), Directory.#session(r)]));
      for (const a of aliases) {
        const s = found.get(str(a.session_id));
        if (s) out.set(str(a.alias_id), s);
      }
    }
    return out;
  }

  static #ticket(r: Row): TicketInfo {
    return {
      id: `T-${Number(r.number)}`,
      summary: str(r.summary),
      status: str(r.status),
      assigneeKind: orNull(r.assignee_kind),
      assigneeRef: orNull(r.assignee_ref),
      workspaceId: orNull(r.workspace_id),
      worktreeBranch: orNull(r.worktree_branch),
      at: str(r.updated_at),
    };
  }

  static readonly #TICKET = 'number, summary, status, assignee_kind, assignee_ref, workspace_id, worktree_branch, updated_at';

  /** Tickets still open, and those changed since `since`. */
  recentTickets(limit: number, since: string): TicketInfo[] {
    return this.#all(
      [`SELECT ${Directory.#TICKET} FROM tickets WHERE status NOT IN ('done', 'wont_do') OR updated_at >= ? ORDER BY updated_at DESC LIMIT ?`],
      [since, limit],
    ).map((r) => this.#ticketKeyed(r));
  }

  #ticketKeyed(r: Row): TicketInfo {
    const t = Directory.#ticket(r);
    return { ...t, workspaceId: this.workspaceKeyOf(t.workspaceId) };
  }

  /** Tickets by id (`T-12`; anything else is ignored). */
  ticketsByIds(ids: string[]): Map<string, TicketInfo> {
    const numbers = [...new Set(ids.map((id) => /^T-(\d{1,9})$/i.exec(id.trim())?.[1]).filter((n): n is string => !!n))];
    const out = new Map<string, TicketInfo>();
    for (const chunk of chunked(numbers)) {
      const marks = chunk.map(() => '?').join(', ');
      for (const r of this.#all([`SELECT ${Directory.#TICKET} FROM tickets WHERE number IN (${marks})`], chunk.map(Number))) {
        const t = this.#ticketKeyed(r);
        out.set(t.id, t);
      }
    }
    return out;
  }

  /** The Claudes of workspaces (a directory each), not the removed ones. */
  claudes(): ClaudeInfo[] {
    return this.#all(['SELECT id, workspace_id, name FROM workspace_claudes WHERE removed_at IS NULL ORDER BY workspace_id, name']).map((r) => ({ id: str(r.id), workspaceId: str(r.workspace_id), name: str(r.name) }));
  }

  /** The personas, skill sets, MCP sets and contexts assigned to workspaces. */
  poolUses(workspaceIds: string[] | null): PoolUse[] {
    const marks = GRAPH_POOL_TYPES.map(() => '?').join(', ');
    return this.#all(
      [`SELECT a.workspace_id, a.pool_id, p.type, p.name FROM assignments a JOIN pools p ON p.id = a.pool_id WHERE p.type IN (${marks}) ORDER BY p.type, p.name COLLATE NOCASE`],
      [...GRAPH_POOL_TYPES],
    )
      .map((r) => ({ workspaceId: str(r.workspace_id), poolId: str(r.pool_id), type: str(r.type), name: str(r.name) }))
      .filter((u) => !workspaceIds || workspaceIds.includes(u.workspaceId));
  }

  /** The labels of portal tokens (`portal-mcp:<id>` actors). */
  tokenLabels(ids: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const chunk of chunked([...new Set(ids)])) {
      const marks = chunk.map(() => '?').join(', ');
      for (const r of this.#all([`SELECT id, label FROM pmcp_tokens WHERE id IN (${marks})`], chunk)) out.set(str(r.id), str(r.label));
    }
    return out;
  }
}
