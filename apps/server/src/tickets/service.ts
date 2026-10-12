import { AppError } from '@isnanme/core';
import {
  TICKET_CHECK_STATES,
  TICKET_CLOSED_STATUSES,
  TICKET_DEFAULT_USER,
  TICKET_LIMITS,
  TICKET_OPEN_STATUSES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  isTicketClosed,
  parseTicketBranch,
  parseTicketId,
  parseTicketTrailers,
  ticketIdOf,
  type CloseTicketRequest,
  type CreateTicketRequest,
  type PortalScope,
  type StartTicketSessionRequest,
  type StartTicketSessionResult,
  type TicketCheck,
  type TicketCheckState,
  type Ticket,
  type TicketAssignee,
  type TicketCounts,
  type TicketDetail,
  type TicketEvent,
  type TicketEventKind,
  type TicketFilter,
  type TicketItem,
  type TicketList,
  type TicketPriority,
  type TicketSession,
  type TicketStatus,
  type TicketTag,
  type TicketType,
  type UpdateTicketRequest,
} from '@portal/contracts';
import { cleanText } from '../portalmcp/sanitize.js';
import type { Store } from '../store/store.js';
import './errors.js';
import { openingMessage } from './opening.js';
import type { TicketSessionInfo, TicketSessions } from './sessions.js';
import { cleanLine, cleanMarkdown, cleanTags } from './text.js';

// The tickets service (tickets PRD): one queue of work for people and agents. Every change is a timeline entry
// in the transaction that makes it. Who may change what is decided here (FR9 to FR11), from the caller the
// route or the tool built, never from what a request says about itself.

/**
 * Who is acting. A person in the portal and the portal itself may do anything. An admin's token (`token`) is limited by its
 * scope. An agent's per-session token (`agent`, interface I8) is the session it was minted for, in the workspace it was
 * minted for: both verified from the token, never from what a call says.
 */
export type Caller =
  | { kind: 'ui' }
  | { kind: 'system' }
  | { kind: 'token'; tokenId: string; label: string; scope: PortalScope }
  | { kind: 'agent'; tokenId: string; label: string; workspaceId: string; sessionId: string };

/** The identity a change is recorded under. */
interface Writer {
  actor: string;
  label: string;
  fromAgent: boolean;
  /** The session the caller is: an agent's own (verified from its token) or the one an admin's token named (FR11). */
  session: TicketSessionInfo | null;
}

interface Row {
  number: number;
  type: TicketType;
  priority: TicketPriority;
  priority_rank: number;
  status: TicketStatus;
  summary: string;
  description: string;
  source: 'human' | 'agent' | 'system';
  reporter_kind: 'ui' | 'token' | 'system';
  reporter_ref: string | null;
  reporter_label: string;
  reporter_workspace: string | null;
  assignee_kind: 'session' | 'user' | null;
  assignee_ref: string | null;
  workspace_id: string | null;
  worktree_branch: string | null;
  worktree_path: string | null;
  closing_summary: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface EventRow {
  id: number;
  ticket_number: number;
  at: string;
  kind: TicketEventKind;
  actor: string;
  actor_label: string;
  body: string | null;
  data: string | null;
}

const RANK: Record<TicketPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const HOUR_MS = 60 * 60_000;
/** FR20: what one token, and one workspace's agents, may add to the queue. */
/** Where a check points: a web address, or a page of this portal (shown as an in-app link). No spaces, no control characters. */
const CHECK_LINK = /^(?:https?:\/\/[^\s\u0000-\u001f]{1,480}|\/admin\/[A-Za-z0-9._~/?=&%#:-]{0,200})$/i;

export const CREATE_PER_HOUR = 50;
export const OPEN_PER_WORKSPACE = 200;
/** How an agent session is named as a ticket's reporter (the table's kinds are fixed): its token ids change at every launch, its session id doesn't. */
const reporterRef = (c: { sessionId: string }) => `session:${c.sessionId}`;
const LIST_MAX = 500;
const USER_LABEL_MAX = 40;
const OPEN_SQL = TICKET_OPEN_STATUSES.map((s) => `'${s}'`).join(', ');
const CLOSED_SQL = TICKET_CLOSED_STATUSES.map((s) => `'${s}'`).join(', ');

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const notFound = () => new AppError('NOT_FOUND', 'No such ticket.');
const oneOf = <T extends string>(v: unknown, all: readonly T[], field: string): T => {
  if (typeof v !== 'string' || !(all as readonly string[]).includes(v)) throw invalid(field, `Use one of: ${all.join(', ')}.`);
  return v as T;
};
const workspaceIdOf = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(v.trim())) throw invalid('workspaceId', 'A workspace is `<target>/<name>`.');
  return v.trim();
};
/** `%` and `_` in a search are literal text. */
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export interface TicketsOptions {
  now?: () => Date;
}

export class Tickets {
  /** Called after any change, for the live page. */
  onChange?: () => void;
  readonly #now: () => Date;
  #off: (() => void) | undefined;

  constructor(
    private readonly store: Store,
    private readonly sessions: TicketSessions,
    opts: TicketsOptions = {},
  ) {
    this.#now = opts.now ?? (() => new Date());
  }

  /** Follows sessions: one that ends under its ticket leaves an entry on it (FR18). */
  start(): void {
    // Not on a database the portal can't trust or write: its tables may not exist (a frozen portal must still start).
    if (!this.store.writable || !this.store.deliveryAllowed) return;
    this.#off ??= this.sessions.onSession((s) => {
      if (s.state === 'ended') this.#sessionEnded(s);
    });
  }

  stop(): void {
    this.#off?.();
    this.#off = undefined;
  }

  get #db() {
    const db = this.store.db;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is not available.');
    return db;
  }

  get #writableDb() {
    const db = this.store.writable ? this.store.db : null;
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now, so tickets can’t be changed.');
    return db;
  }

  #tx<T>(fn: () => T): T {
    const db = this.#writableDb;
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /* ---------- Who is calling ---------- */

  /**
   * The identity a call is recorded under. An agent is the session its token was minted for (verified). An admin's token
   * may act for a session (a script working on its behalf): `sessionId` names which, and must be a live one.
   */
  #writer(caller: Caller, sessionId?: string | null): Writer {
    if (caller.kind === 'ui') return { actor: 'ui', label: 'Admin', fromAgent: false, session: null };
    if (caller.kind === 'system') return { actor: 'system', label: 'Portal', fromAgent: false, session: null };
    if (caller.kind === 'agent') {
      if (sessionId && sessionId !== caller.sessionId) throw new AppError('FORBIDDEN', 'Agents can act only as their own session.');
      const s = this.sessions.get(caller.sessionId);
      if (!s) throw new AppError('FORBIDDEN', 'Your session no longer exists.');
      if (s.state === 'ended') throw new AppError('FORBIDDEN', 'Your session has ended.');
      return { actor: `session:${caller.sessionId}`, label: cleanText(s.title, 60) || caller.label, fromAgent: true, session: s };
    }
    const base = { actor: `portal-mcp:${caller.tokenId}`, fromAgent: true };
    if (sessionId) {
      const s = this.sessions.get(sessionId);
      if (!s) throw invalid('session_id', 'No such session.');
      if (s.state === 'ended') throw invalid('session_id', 'That session has ended.');
      return { ...base, label: cleanText(s.title, 60) || caller.label, session: s };
    }
    return { ...base, label: caller.label, session: null };
  }

  /** A write needs a token that can write. */
  #assertWrites(caller: Caller) {
    if (caller.kind === 'token' && caller.scope === 'read') throw new AppError('FORBIDDEN', 'This token can only read. Writing needs the operate scope.');
  }

  /** The session a call means by "me" or a claim: an agent's own, or the one an admin's token named. */
  #needSession(w: Writer, why: string): TicketSessionInfo {
    if (w.session) return w.session;
    throw new AppError('SESSION_REQUIRED', `${why}: pass session_id, the id of the chat session you act for.`);
  }

  /** The session a caller means by "me": its own (an agent), or the one an admin's token names. */
  meSession(caller: Caller, sessionId?: string | null): string {
    return this.#needSession(this.#writer(caller, sessionId), 'To say “me”').id;
  }

  /** Whether the caller may see a ticket: an agent sees its workspace's tickets and the shared queue. */
  #visible(caller: Caller, row: Row): boolean {
    if (caller.kind !== 'agent') return true;
    return row.workspace_id === null || row.workspace_id === caller.workspaceId;
  }

  /** FR9: what an agent may change. People, the portal and an admin's operate token may change anything. */
  #assertCanModify(caller: Caller, row: Row, w: Writer) {
    if (caller.kind === 'token') return this.#assertWrites(caller);
    if (caller.kind !== 'agent') return;
    const id = ticketIdOf(row.number);
    if (isTicketClosed(row.status)) throw new AppError('FORBIDDEN', `${id} is closed. A person can reopen it.`);
    if (row.assignee_kind === 'session') {
      if (row.assignee_ref !== w.session!.id) throw new AppError('FORBIDDEN', `${id} is assigned to another session. Only the session it is assigned to can change it.`);
      return;
    }
    // Nobody, or a person, holds it: only the session that made it may still change it.
    if (!(row.reporter_kind === 'token' && row.reporter_ref === reporterRef(caller)))
      throw new AppError('FORBIDDEN', row.assignee_kind === 'user' ? `${id} is assigned to a person.` : `${id} is not assigned to you. Claim it with ticket_claim_next first.`);
  }

  /* ---------- Reading ---------- */

  #row(number: number): Row | undefined {
    return this.#db.prepare('SELECT * FROM tickets WHERE number = ?').get(number) as unknown as Row | undefined;
  }

  #need(caller: Caller, idOrNumber: string | number): Row {
    const n = typeof idOrNumber === 'number' ? idOrNumber : parseTicketId(idOrNumber);
    const row = n === null ? undefined : this.#row(n);
    if (!row || !this.#visible(caller, row)) throw notFound();
    return row;
  }

  exists(id: string): boolean {
    const n = parseTicketId(id);
    return n !== null && !!this.#row(n);
  }

  #tagsOf(numbers: number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    if (!numbers.length) return out;
    const rows = this.#db.prepare(`SELECT ticket_number, tag FROM ticket_tags WHERE ticket_number IN (${numbers.map(() => '?').join(',')}) ORDER BY tag`).all(...numbers) as { ticket_number: number; tag: string }[];
    for (const r of rows) out.set(r.ticket_number, [...(out.get(r.ticket_number) ?? []), r.tag]);
    return out;
  }

  #sessionView(s: TicketSessionInfo): TicketSession {
    return { id: s.id, title: s.title, state: s.state, workspaceId: s.workspaceId, lastActivityAt: s.lastActivityAt, endedReason: s.endedReason, worktree: s.worktree };
  }

  #item(r: Row, tags: string[]): TicketItem {
    const assignee: TicketAssignee | null = r.assignee_kind === 'session' ? { kind: 'session', sessionId: r.assignee_ref! } : r.assignee_kind === 'user' ? { kind: 'user', name: r.assignee_ref! } : null;
    const session = assignee?.kind === 'session' ? this.sessions.get(assignee.sessionId) : null;
    const ticket: Ticket = {
      id: ticketIdOf(r.number),
      number: r.number,
      type: r.type,
      priority: r.priority,
      status: r.status,
      summary: r.summary,
      description: r.description,
      tags,
      source: r.source,
      reporter: { kind: r.reporter_kind, ref: r.reporter_ref, label: r.reporter_label, workspaceId: r.reporter_workspace },
      assignee,
      workspaceId: r.workspace_id,
      worktree: r.worktree_branch && r.worktree_path ? { branch: r.worktree_branch, path: r.worktree_path } : null,
      closingSummary: r.closing_summary,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      closedAt: r.closed_at,
    };
    return { ...ticket, assigneeSession: session ? this.#sessionView(session) : null, sessionEnded: !!session && session.state === 'ended' && !isTicketClosed(r.status) };
  }

  #items(rows: Row[]): TicketItem[] {
    const tags = this.#tagsOf(rows.map((r) => r.number));
    return rows.map((r) => this.#item(r, tags.get(r.number) ?? []));
  }

  /** The SQL a caller's filters and visibility come to. */
  #where(caller: Caller, f: TicketFilter, forCounts = false): { sql: string; args: (string | number)[] } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (caller.kind === 'agent') (where.push('(t.workspace_id IS NULL OR t.workspace_id = ?)'), args.push(caller.workspaceId));
    if (forCounts) return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
    const statuses = f.status?.filter((s) => (TICKET_STATUSES as readonly string[]).includes(s));
    if (statuses?.length) (where.push(`t.status IN (${statuses.map(() => '?').join(',')})`), args.push(...statuses));
    else if (!f.includeClosed) where.push(`t.status NOT IN (${CLOSED_SQL})`);
    const priorities = f.priority?.filter((p) => (TICKET_PRIORITIES as readonly string[]).includes(p));
    if (priorities?.length) (where.push(`t.priority IN (${priorities.map(() => '?').join(',')})`), args.push(...priorities));
    const types = f.type?.filter((t) => (TICKET_TYPES as readonly string[]).includes(t));
    if (types?.length) (where.push(`t.type IN (${types.map(() => '?').join(',')})`), args.push(...types));
    if (f.tag) (where.push('EXISTS (SELECT 1 FROM ticket_tags g WHERE g.ticket_number = t.number AND g.tag = ?)'), args.push(f.tag.toLowerCase()));
    if (f.assignee === 'unassigned') where.push('t.assignee_kind IS NULL');
    else if (f.assignee === 'user') where.push("t.assignee_kind = 'user'");
    else if (f.assignee?.startsWith('session:')) (where.push("t.assignee_kind = 'session' AND t.assignee_ref = ?"), args.push(f.assignee.slice(8)));
    if (f.workspaceId) (where.push('t.workspace_id = ?'), args.push(f.workspaceId));
    if (f.query?.trim()) {
      const q = like(f.query.trim().slice(0, 100));
      where.push("(t.summary LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM ticket_tags g WHERE g.ticket_number = t.number AND g.tag LIKE ? ESCAPE '\\'))");
      args.push(q, q, q);
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
  }

  counts(caller: Caller): TicketCounts {
    const { sql, args } = this.#where(caller, {}, true);
    const byStatus = Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0])) as Record<TicketStatus, number>;
    for (const r of this.#db.prepare(`SELECT t.status AS status, count(*) AS n FROM tickets t ${sql} GROUP BY t.status`).all(...args) as { status: TicketStatus; n: number }[]) byStatus[r.status] = r.n;
    const and = sql ? `${sql} AND` : 'WHERE';
    const needsYou = (this.#db.prepare(`SELECT count(*) AS n FROM tickets t ${and} t.assignee_kind = 'user' AND t.status IN (${OPEN_SQL})`).get(...args) as { n: number }).n;
    const unassigned = (this.#db.prepare(`SELECT count(*) AS n FROM tickets t ${and} t.assignee_kind IS NULL AND t.status = 'open'`).get(...args) as { n: number }).n;
    return { byStatus, needsYou, unassigned, total: Object.values(byStatus).reduce((a, b) => a + b, 0) };
  }

  list(caller: Caller, filter: TicketFilter = {}): TicketList {
    const { sql, args } = this.#where(caller, filter);
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), LIST_MAX);
    const offset = Math.max(Math.trunc(filter.offset ?? 0), 0);
    const closedOnly = !!filter.status?.length && filter.status.every((s) => isTicketClosed(s));
    const order = closedOnly ? 't.closed_at DESC, t.number DESC' : 't.priority_rank ASC, t.updated_at DESC, t.number DESC';
    const rows = this.#db.prepare(`SELECT t.* FROM tickets t ${sql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`).all(...args) as unknown as Row[];
    const total = (this.#db.prepare(`SELECT count(*) AS n FROM tickets t ${sql}`).get(...args) as { n: number }).n;
    return { items: this.#items(rows), total, counts: this.counts(caller) };
  }

  #events(number: number, opts: { limit?: number } = {}): TicketEvent[] {
    const limit = opts.limit ? `LIMIT ${Math.trunc(opts.limit)}` : '';
    // The latest `limit` entries, oldest first.
    const rows = this.#db
      .prepare(`SELECT * FROM (SELECT * FROM ticket_events WHERE ticket_number = ? ORDER BY id DESC ${limit}) ORDER BY id ASC`)
      .all(number) as unknown as EventRow[];
    return rows.map((e) => {
      let data: Record<string, unknown> | null = null;
      try {
        data = e.data ? (JSON.parse(e.data) as Record<string, unknown>) : null;
      } catch {
        // an unreadable entry still shows
      }
      return { id: e.id, ticketId: ticketIdOf(e.ticket_number), at: e.at, kind: e.kind, actor: e.actor, actorLabel: e.actor_label, body: e.body, data, fromAgent: /^(portal-mcp|session|ci):/.test(e.actor) };
    });
  }

  get(caller: Caller, id: string, opts: { eventsLimit?: number } = {}): TicketDetail {
    const row = this.#need(caller, id);
    const [ticket] = this.#items([row]);
    const sessions = this.sessions
      .list({ ticketId: ticketIdOf(row.number) })
      .filter((s) => caller.kind !== 'agent' || s.workspaceId === caller.workspaceId)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .map((s) => this.#sessionView(s));
    return { ticket: ticket!, events: this.#events(row.number, { limit: opts.eventsLimit }), sessions, checks: this.#checks(row.number) };
  }

  #checks(number: number): TicketCheck[] {
    const rows = this.#db.prepare('SELECT name, state, run_id, commit_sha, link, updated_at FROM ticket_checks WHERE ticket_number = ? ORDER BY name').all(number) as {
      name: string;
      state: TicketCheckState;
      run_id: string | null;
      commit_sha: string | null;
      link: string | null;
      updated_at: string;
    }[];
    return rows.map((r) => ({ name: r.name, state: r.state, runId: r.run_id, commit: r.commit_sha, link: r.link, updatedAt: r.updated_at }));
  }

  /** A ticket's id and summary, for a link to it. */
  brief(id: string): { id: string; summary: string; status: TicketStatus } | null {
    const n = parseTicketId(id);
    const row = n === null ? undefined : this.#row(n);
    return row ? { id: ticketIdOf(row.number), summary: row.summary, status: row.status } : null;
  }

  /** The message a session started for this ticket would open with, for the dialog's preview (its session id is not known yet). */
  opening(caller: Caller, id: string): string {
    const [item] = this.#items([this.#need(caller, id)]);
    return openingMessage(item!, '(its id, once it starts)');
  }

  tags(caller: Caller): TicketTag[] {
    const { sql, args } = this.#where(caller, {}, true);
    const rows = this.#db
      .prepare(`SELECT g.tag AS tag, count(*) AS count FROM ticket_tags g JOIN tickets t ON t.number = g.ticket_number ${sql} GROUP BY g.tag ORDER BY count DESC, g.tag ASC`)
      .all(...args) as { tag: string; count: number }[];
    return rows.map((r) => ({ tag: r.tag, count: r.count }));
  }

  /* ---------- Writing ---------- */

  #addEvent(number: number, kind: TicketEventKind, w: Pick<Writer, 'actor' | 'label'>, body: string | null, data: Record<string, unknown> | null) {
    this.#db
      .prepare('INSERT INTO ticket_events (ticket_number, at, kind, actor, actor_label, body, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(number, this.#now().toISOString(), kind, w.actor, w.label, body, data ? JSON.stringify(data) : null);
  }

  #setTags(number: number, tags: string[]) {
    this.#db.prepare('DELETE FROM ticket_tags WHERE ticket_number = ?').run(number);
    const add = this.#db.prepare('INSERT INTO ticket_tags (ticket_number, tag) VALUES (?, ?)');
    for (const t of tags) add.run(number, t);
  }

  /** Who a change assigns to, checked: a person, or a live session (an agent's only in its own workspace). */
  #assignee(caller: Caller, input: TicketAssignee | null | undefined): { kind: 'session'; session: TicketSessionInfo } | { kind: 'user'; name: string } | null {
    if (input === null || input === undefined) return null;
    if (input.kind === 'user') return { kind: 'user', name: cleanLine(input.name || TICKET_DEFAULT_USER, 'assignee', USER_LABEL_MAX) };
    if (input.kind !== 'session' || typeof input.sessionId !== 'string') throw invalid('assignee', 'Assign to a session or a person.');
    const s = this.sessions.get(input.sessionId);
    if (!s) throw invalid('assignee', 'No such session.');
    if (s.state === 'ended') throw invalid('assignee', 'That session has ended.');
    if (caller.kind === 'agent' && s.workspaceId !== caller.workspaceId) throw new AppError('FORBIDDEN', `That session is not in workspace ${caller.workspaceId}.`);
    return { kind: 'session', session: s };
  }

  /** FR20: the queue is protected from a looping agent. */
  #createLimit(caller: Caller) {
    if (caller.kind === 'ui' || caller.kind === 'system') return;
    const ref = caller.kind === 'agent' ? reporterRef(caller) : caller.tokenId;
    const since = new Date(this.#now().getTime() - HOUR_MS).toISOString();
    const recent = (this.#db.prepare("SELECT count(*) AS n FROM tickets WHERE reporter_kind = 'token' AND reporter_ref = ? AND created_at > ?").get(ref, since) as { n: number }).n;
    if (recent >= CREATE_PER_HOUR) throw new AppError('RATE_LIMITED', `${caller.kind === 'agent' ? 'This session' : 'This token'} has made ${CREATE_PER_HOUR} tickets in the last hour. Wait, or ask a person to look at the queue.`);
    if (caller.kind === 'agent') {
      const open = (this.#db.prepare(`SELECT count(*) AS n FROM tickets WHERE source = 'agent' AND workspace_id = ? AND status IN (${OPEN_SQL})`).get(caller.workspaceId) as { n: number }).n;
      if (open >= OPEN_PER_WORKSPACE) throw new AppError('RATE_LIMITED', `${caller.workspaceId} already has ${OPEN_PER_WORKSPACE} open tickets made by agents. Close some first.`);
    }
  }

  create(caller: Caller, req: Partial<CreateTicketRequest>, opts: { sessionId?: string | null } = {}): TicketItem {
    this.#assertWrites(caller);
    const w = this.#writer(caller, opts.sessionId);
    const summary = cleanLine(req.summary, 'summary', TICKET_LIMITS.summary);
    const description = cleanMarkdown(req.description, 'description', TICKET_LIMITS.description);
    const type = req.type === undefined ? 'task' : oneOf(req.type, TICKET_TYPES, 'type');
    const priority = req.priority === undefined ? 'normal' : oneOf(req.priority, TICKET_PRIORITIES, 'priority');
    const tags = cleanTags(req.tags);
    const assignee = this.#assignee(caller, req.assignee);
    // An agent's ticket concerns its own workspace; a session assignee's workspace is where the work is.
    let workspaceId = caller.kind === 'agent' ? caller.workspaceId : workspaceIdOf(req.workspaceId);
    if (assignee?.kind === 'session') workspaceId = assignee.session.workspaceId;
    const source = caller.kind === 'ui' ? 'human' : caller.kind === 'system' ? 'system' : 'agent';
    const reporter =
      caller.kind === 'ui'
        ? { kind: 'ui' as const, ref: null, label: 'Admin', workspace: null }
        : caller.kind === 'system'
          ? { kind: 'system' as const, ref: null, label: 'Portal', workspace: null }
          : caller.kind === 'agent'
            ? { kind: 'token' as const, ref: reporterRef(caller), label: cleanText(w.label, 60), workspace: caller.workspaceId }
            : { kind: 'token' as const, ref: caller.tokenId, label: cleanText(caller.label, 60), workspace: null };
    const at = this.#now().toISOString();
    const number = this.#tx(() => {
      this.#createLimit(caller);
      const r = this.#db
        .prepare(
          `INSERT INTO tickets (type, priority, priority_rank, status, summary, description, source, reporter_kind, reporter_ref, reporter_label, reporter_workspace,
             assignee_kind, assignee_ref, workspace_id, created_at, updated_at)
           VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(type, priority, RANK[priority], summary, description, source, reporter.kind, reporter.ref, reporter.label, reporter.workspace, assignee ? assignee.kind : null, assignee ? (assignee.kind === 'session' ? assignee.session.id : assignee.name) : null, workspaceId, at, at);
      const n = Number(r.lastInsertRowid);
      this.#setTags(n, tags);
      this.#addEvent(n, 'created', w, null, { type, priority, tags, workspaceId, source });
      if (assignee) this.#addEvent(n, 'assigned', w, null, { from: null, to: assignee.kind === 'session' ? { kind: 'session', sessionId: assignee.session.id } : { kind: 'user', name: assignee.name } });
      return n;
    });
    this.onChange?.();
    return this.#items([this.#row(number)!])[0]!;
  }

  update(caller: Caller, id: string, req: Partial<UpdateTicketRequest>, opts: { sessionId?: string | null } = {}): TicketItem {
    const row = this.#need(caller, id); // visibility first: a ticket it can't see doesn't exist for it
    const w = this.#writer(caller, opts.sessionId);
    this.#assertCanModify(caller, row, w);
    const agent = caller.kind === 'agent';
    const tags = this.#tagsOf([row.number]).get(row.number) ?? [];
    const sets: Record<string, string | number | null> = {};
    const entries: { kind: TicketEventKind; body?: string | null; data: Record<string, unknown> }[] = [];
    const next = { ...row };

    if (req.summary !== undefined) {
      const v = cleanLine(req.summary, 'summary', TICKET_LIMITS.summary);
      if (v !== row.summary) (sets.summary = v, next.summary = v, entries.push({ kind: 'summary', data: { from: row.summary, to: v } }));
    }
    if (req.description !== undefined) {
      const v = cleanMarkdown(req.description, 'description', TICKET_LIMITS.description);
      if (v !== row.description) (sets.description = v, next.description = v, entries.push({ kind: 'description', data: { from: row.description.length, to: v.length } }));
    }
    if (req.type !== undefined) {
      const v = oneOf(req.type, TICKET_TYPES, 'type');
      if (v !== row.type) (sets.type = v, next.type = v, entries.push({ kind: 'type', data: { from: row.type, to: v } }));
    }
    if (req.priority !== undefined) {
      const v = oneOf(req.priority, TICKET_PRIORITIES, 'priority');
      if (v !== row.priority) (sets.priority = v, sets.priority_rank = RANK[v], next.priority = v, entries.push({ kind: 'priority', data: { from: row.priority, to: v } }));
    }
    let newTags: string[] | null = null;
    if (req.tags !== undefined) {
      const v = cleanTags(req.tags);
      if ([...v].sort().join(',') !== [...tags].sort().join(',')) (newTags = v, entries.push({ kind: 'tags', data: { from: tags, to: v } }));
    }

    // Assignee first: it can move the status (unassigning an in-progress ticket puts it back in the queue) and the workspace.
    let status = row.status;
    if (req.assignee !== undefined) {
      const a = this.#assignee(caller, req.assignee);
      const before = row.assignee_kind ? `${row.assignee_kind}:${row.assignee_ref}` : null;
      const after = a ? (a.kind === 'session' ? `session:${a.session.id}` : `user:${a.name}`) : null;
      if (before !== after) {
        sets.assignee_kind = a ? a.kind : null;
        sets.assignee_ref = a ? (a.kind === 'session' ? a.session.id : a.name) : null;
        entries.push({
          kind: 'assigned',
          data: {
            from: row.assignee_kind ? { kind: row.assignee_kind, ...(row.assignee_kind === 'session' ? { sessionId: row.assignee_ref } : { name: row.assignee_ref }) } : null,
            to: a ? (a.kind === 'session' ? { kind: 'session', sessionId: a.session.id } : { kind: 'user', name: a.name }) : null,
          },
        });
        if (a?.kind === 'session' && row.workspace_id !== a.session.workspaceId) (sets.workspace_id = a.session.workspaceId, entries.push({ kind: 'workspace', data: { from: row.workspace_id, to: a.session.workspaceId } }));
        if (!a && status === 'in_progress') status = 'open';
      }
    }
    if (req.workspaceId !== undefined && !('workspace_id' in sets)) {
      if (agent) throw new AppError('FORBIDDEN', 'An agent’s tickets stay in its own workspace.');
      const v = workspaceIdOf(req.workspaceId);
      if (v !== row.workspace_id) (sets.workspace_id = v, entries.push({ kind: 'workspace', data: { from: row.workspace_id, to: v } }));
    }
    if (req.status !== undefined) {
      const v = oneOf(req.status, TICKET_STATUSES, 'status');
      if (isTicketClosed(v) && agent) throw invalid('status', 'Close a ticket with ticket_close, which records what was done.');
      if (isTicketClosed(row.status) && agent) throw new AppError('FORBIDDEN', `${ticketIdOf(row.number)} is closed. A person can reopen it.`);
      status = v;
    }
    if (status !== row.status) {
      sets.status = status;
      const reopening = isTicketClosed(row.status) && !isTicketClosed(status);
      const closing = !isTicketClosed(row.status) && isTicketClosed(status);
      if (closing) {
        sets.closed_at = this.#now().toISOString();
        entries.push({ kind: 'closed', data: { from: row.status, to: status } });
      } else if (reopening) {
        sets.closed_at = null;
        sets.closing_summary = null;
        entries.push({ kind: 'reopened', data: { from: row.status, to: status } });
      } else entries.push({ kind: 'status', data: { from: row.status, to: status } });
    }

    if (!entries.length) return this.#items([row])[0]!;
    this.#tx(() => {
      sets.updated_at = this.#now().toISOString();
      const cols = Object.keys(sets);
      this.#db.prepare(`UPDATE tickets SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE number = ?`).run(...cols.map((c) => sets[c]!), row.number);
      if (newTags) this.#setTags(row.number, newTags);
      for (const e of entries) this.#addEvent(row.number, e.kind, w, e.body ?? null, e.data);
    });
    this.onChange?.();
    return this.#items([this.#row(row.number)!])[0]!;
  }

  comment(caller: Caller, id: string, text: unknown, opts: { sessionId?: string | null } = {}): TicketEvent {
    const row = this.#need(caller, id);
    const w = this.#writer(caller, opts.sessionId);
    this.#assertCanModify(caller, row, w);
    const body = cleanMarkdown(text, 'text', TICKET_LIMITS.comment, { required: true });
    const eventId = this.#tx(() => {
      this.#db.prepare('UPDATE tickets SET updated_at = ? WHERE number = ?').run(this.#now().toISOString(), row.number);
      this.#addEvent(row.number, 'comment', w, body, w.session ? { session: w.session.id } : null);
      return Number((this.#db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    });
    this.onChange?.();
    return this.#events(row.number).find((e) => e.id === eventId)!;
  }

  close(caller: Caller, id: string, req: Partial<CloseTicketRequest> = {}, opts: { sessionId?: string | null } = {}): TicketItem {
    const row = this.#need(caller, id);
    const w = this.#writer(caller, opts.sessionId);
    this.#assertCanModify(caller, row, w);
    if (isTicketClosed(row.status)) throw new AppError('CONFLICT', `${ticketIdOf(row.number)} is already closed.`);
    const outcome = req.outcome === undefined ? 'done' : oneOf(req.outcome, TICKET_CLOSED_STATUSES, 'outcome');
    const summary = cleanMarkdown(req.summary, 'summary', TICKET_LIMITS.closing, { required: caller.kind === 'token' || caller.kind === 'agent' });
    const at = this.#now().toISOString();
    this.#tx(() => {
      this.#db.prepare('UPDATE tickets SET status = ?, closed_at = ?, closing_summary = ?, updated_at = ? WHERE number = ?').run(outcome, at, summary || null, at, row.number);
      this.#addEvent(row.number, 'closed', w, summary || null, { from: row.status, to: outcome, ...(w.session ? { session: w.session.id } : {}) });
    });
    this.onChange?.();
    return this.#items([this.#row(row.number)!])[0]!;
  }

  /**
   * FR13: hands the most urgent claimable ticket to a session. Claimable: open, unassigned, visible to the caller, in
   * the session's workspace or the shared queue, and not an approval (a person answers those). All the tags asked for,
   * one of the types asked for; most urgent first, then oldest. One transaction, so two callers never get the same one.
   */
  claimNext(caller: Caller, req: { id?: string; tags?: unknown; types?: unknown; sessionId?: string | null } = {}): TicketItem | null {
    this.#assertWrites(caller);
    const w = this.#writer(caller, req.sessionId);
    const session = this.#needSession(w, 'To claim a ticket');
    if (session.state === 'ended') throw invalid('session_id', 'That session has ended.');
    const tags = cleanTags(req.tags);
    const types = Array.isArray(req.types) ? req.types.map((t) => oneOf(t, TICKET_TYPES, 'types')) : [];
    let wantedNumber: number | null = null;
    if (req.id !== undefined) {
      wantedNumber = parseTicketId(String(req.id));
      if (wantedNumber === null) throw invalid('id', 'Not a ticket id.');
    }
    const claimed = this.#tx(() => {
      const where = [
        "t.status = 'open'",
        't.assignee_kind IS NULL',
        "t.type <> 'approval'",
        '(t.workspace_id IS NULL OR t.workspace_id = ?)',
      ];
      const args: (string | number)[] = [session.workspaceId];
      if (wantedNumber !== null) (where.push('t.number = ?'), args.push(wantedNumber));
      for (const tag of tags) (where.push('EXISTS (SELECT 1 FROM ticket_tags g WHERE g.ticket_number = t.number AND g.tag = ?)'), args.push(tag));
      if (types.length) (where.push(`t.type IN (${types.map(() => '?').join(',')})`), args.push(...types));
      const row = this.#db.prepare(`SELECT t.* FROM tickets t WHERE ${where.join(' AND ')} ORDER BY t.priority_rank ASC, t.created_at ASC, t.number ASC LIMIT 1`).get(...args) as unknown as Row | undefined;
      if (!row) return null;
      const at = this.#now().toISOString();
      this.#db.prepare("UPDATE tickets SET assignee_kind = 'session', assignee_ref = ?, status = 'in_progress', workspace_id = ?, updated_at = ? WHERE number = ?").run(session.id, session.workspaceId, at, row.number);
      this.#addEvent(row.number, 'assigned', w, null, { from: null, to: { kind: 'session', sessionId: session.id }, claimed: true });
      this.#addEvent(row.number, 'status', w, null, { from: 'open', to: 'in_progress' });
      if (row.workspace_id !== session.workspaceId) this.#addEvent(row.number, 'workspace', w, null, { from: row.workspace_id, to: session.workspaceId });
      return row.number;
    });
    if (claimed === null) return null;
    this.onChange?.();
    return this.#items([this.#row(claimed)!])[0]!;
  }

  remove(caller: Caller, id: string): void {
    if (caller.kind !== 'ui') throw new AppError('FORBIDDEN', 'Only a person can delete a ticket.');
    const row = this.#need(caller, id);
    this.#writableDb.prepare('DELETE FROM tickets WHERE number = ?').run(row.number);
    this.onChange?.();
  }

  /* ---------- CI (interface I10) ---------- */

  /**
   * The existing tickets a git ref names: a branch (`ticket/T-12-fix-login`) and the `Ticket: T-12` trailers of a
   * commit message, in that order, without repeats. Ids that name no ticket are left out.
   */
  find(refs: { branch?: string; message?: string }): string[] {
    const ids = [refs.branch ? parseTicketBranch(refs.branch) : null, ...(refs.message ? parseTicketTrailers(refs.message) : [])].filter((x): x is string => !!x);
    return [...new Set(ids)].filter((id) => this.exists(id));
  }

  /** The checks CI attached to a ticket. */
  checks(id: string): TicketCheck[] {
    const n = parseTicketId(id);
    return n !== null && this.#row(n) ? this.#checks(n) : [];
  }

  /**
   * CI attaches a pipeline's status to a ticket (one check per name; its latest state), with a timeline entry when it
   * changed. `by` is the run: `{ actor: 'ci:<run id>', label: 'CI' }`. Null when there is no such ticket. The text is
   * untrusted like any other: cleaned, and credential-shaped values are refused.
   */
  attachCheck(id: string, check: { name: string; state: TicketCheckState; runId?: string | null; commit?: string | null; link?: string | null }, by: { actor: string; label?: string }): TicketCheck | null {
    const n = parseTicketId(id);
    const row = n === null ? undefined : this.#row(n);
    if (!row) return null;
    if (!/^[a-z][a-z0-9-]{1,24}:[A-Za-z0-9._~:-]{1,80}$/.test(by.actor)) throw invalid('actor', 'An actor is like ci:<run id>.');
    const name = cleanLine(check.name, 'name', 60);
    if (!(TICKET_CHECK_STATES as readonly string[]).includes(check.state)) throw invalid('state', `Use one of: ${TICKET_CHECK_STATES.join(', ')}.`);
    const runId = check.runId ? cleanLine(check.runId, 'runId', 80) : null;
    const commit = check.commit ? (/^[0-9a-f]{7,64}$/i.test(check.commit) ? check.commit.toLowerCase() : (() => { throw invalid('commit', 'A commit is 7 to 64 hex digits.'); })()) : null;
    const link = check.link ? (CHECK_LINK.test(check.link) && !/(^|\/)\.\.(\/|$)/.test(check.link) ? check.link : (() => { throw invalid('link', 'A link is an http(s) address or a portal page like /admin/ci/runs/41.'); })()) : null;
    const label = cleanLine(by.label ?? 'CI', 'label', 40);
    const before = this.#db.prepare('SELECT state FROM ticket_checks WHERE ticket_number = ? AND name = ?').get(row.number, name) as { state: TicketCheckState } | undefined;
    const at = this.#now().toISOString();
    this.#tx(() => {
      this.#db
        .prepare(
          `INSERT INTO ticket_checks (ticket_number, name, state, run_id, commit_sha, link, actor, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (ticket_number, name) DO UPDATE SET state = excluded.state, run_id = excluded.run_id, commit_sha = excluded.commit_sha, link = excluded.link, actor = excluded.actor, updated_at = excluded.updated_at`,
        )
        .run(row.number, name, check.state, runId, commit, link, by.actor, at);
      if (before?.state !== check.state) {
        this.#db.prepare('UPDATE tickets SET updated_at = ? WHERE number = ?').run(at, row.number);
        this.#addEvent(row.number, 'ci', { actor: by.actor, label }, null, { name, state: check.state, from: before?.state ?? null, runId, commit, link });
      }
    });
    this.onChange?.();
    return { name, state: check.state, runId, commit, link, updatedAt: at };
  }

  /** A note on a ticket's timeline from another module (a run's summary, say). False when there is no such ticket. */
  note(id: string, text: string, by: { actor: string; label?: string }): boolean {
    const n = parseTicketId(id);
    const row = n === null ? undefined : this.#row(n);
    if (!row) return false;
    if (!/^[a-z][a-z0-9-]{1,24}:[A-Za-z0-9._~:-]{1,80}$/.test(by.actor)) throw invalid('actor', 'An actor is like ci:<run id>.');
    const body = cleanMarkdown(text, 'text', TICKET_LIMITS.comment, { required: true });
    const label = cleanLine(by.label ?? 'CI', 'label', 40);
    this.#tx(() => {
      this.#db.prepare('UPDATE tickets SET updated_at = ? WHERE number = ?').run(this.#now().toISOString(), row.number);
      this.#addEvent(row.number, 'comment', { actor: by.actor, label }, body, null);
    });
    this.onChange?.();
    return true;
  }

  /* ---------- Sessions ---------- */

  /**
   * FR15 (people only): creates a session for the ticket, assigns it and moves it to in progress, then sends the ticket
   * as the opening message from `ticket:<id>`. The assignment lands before the message, so the agent's first tool call
   * already finds the ticket assigned to it.
   */
  async startSession(caller: Caller, id: string, req: Partial<StartTicketSessionRequest>): Promise<StartTicketSessionResult> {
    // A person, or an admin's token (not an agent's: an agent can't start sessions) when session control is on.
    if (!(caller.kind === 'ui' || (caller.kind === 'token' && caller.scope === 'admin'))) throw new AppError('FORBIDDEN', 'Only a person starts a session for a ticket.');
    const row = this.#need(caller, id);
    if (isTicketClosed(row.status)) throw new AppError('CONFLICT', `${ticketIdOf(row.number)} is closed. Reopen it first.`);
    const workspaceId = typeof req.workspaceId === 'string' ? req.workspaceId.trim() : '';
    if (!workspaceId) throw invalid('workspaceId', 'Pick a workspace.');
    const ticketId = ticketIdOf(row.number);
    const worktree = req.worktree === true ? {} : req.worktree && typeof req.worktree === 'object' ? req.worktree : undefined;
    const title = `${ticketId}: ${row.summary}`.slice(0, 80);
    const session = await this.sessions.create({ ticketId, workspaceId, claudeId: req.claudeId, cwd: req.cwd, title, worktree });

    const w: Writer = { ...this.#writer(caller), session: null };
    this.#tx(() => {
      const cur = this.#row(row.number)!;
      const at = this.#now().toISOString();
      const sets: Record<string, string | number | null> = { assignee_kind: 'session', assignee_ref: session.id, status: 'in_progress', workspace_id: session.workspaceId, updated_at: at };
      if (session.worktree) (sets.worktree_branch = session.worktree.branch, sets.worktree_path = session.worktree.path);
      const cols = Object.keys(sets);
      this.#db.prepare(`UPDATE tickets SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE number = ?`).run(...cols.map((c) => sets[c]!), row.number);
      this.#addEvent(row.number, 'session_started', w, null, { sessionId: session.id, workspaceId: session.workspaceId, worktree: session.worktree });
      if (cur.assignee_kind !== 'session' || cur.assignee_ref !== session.id) this.#addEvent(row.number, 'assigned', w, null, { from: cur.assignee_kind ? { kind: cur.assignee_kind, ...(cur.assignee_kind === 'session' ? { sessionId: cur.assignee_ref } : { name: cur.assignee_ref }) } : null, to: { kind: 'session', sessionId: session.id } });
      if (cur.status !== 'in_progress') this.#addEvent(row.number, 'status', w, null, { from: cur.status, to: 'in_progress' });
      if (cur.workspace_id !== session.workspaceId) this.#addEvent(row.number, 'workspace', w, null, { from: cur.workspace_id, to: session.workspaceId });
    });
    this.onChange?.();

    const item = this.#items([this.#row(row.number)!])[0]!;
    try {
      // The transcript names the sender by the ticket's number ("From ticket T-1"); the ticket's words are in the message itself.
      await this.sessions.send(session.id, ticketId, openingMessage(item, session.id), ticketId);
    } catch (e) {
      const message = cleanText((e as Error).message, 300);
      this.#tx(() => this.#addEvent(row.number, 'comment', { actor: 'system', label: 'Portal' }, `The session started, but its opening message could not be sent: ${message}. Send it a message by hand.`, null));
      this.onChange?.();
      throw e instanceof AppError ? e : new AppError('SERVICE_UNAVAILABLE', `The session started, but the ticket could not be sent to it: ${message}`);
    }
    return { ticket: this.#items([this.#row(row.number)!])[0]!, session: this.#sessionView(this.sessions.get(session.id) ?? session) };
  }

  /** A session ended: any unfinished ticket assigned to it says so, once (FR18). */
  #sessionEnded(s: TicketSessionInfo) {
    if (!this.store.writable) return;
    try {
      const rows = this.#db.prepare(`SELECT number FROM tickets WHERE assignee_kind = 'session' AND assignee_ref = ? AND status IN (${OPEN_SQL})`).all(s.id) as { number: number }[];
      let changed = false;
      for (const { number } of rows) {
        const last = this.#db.prepare("SELECT kind, data FROM ticket_events WHERE ticket_number = ? AND kind IN ('session_ended', 'session_started', 'assigned') ORDER BY id DESC LIMIT 1").get(number) as { kind: string; data: string | null } | undefined;
        if (last?.kind === 'session_ended' && last.data?.includes(s.id)) continue;
        this.#addEvent(number, 'session_ended', { actor: 'system', label: 'Portal' }, null, { sessionId: s.id, reason: s.endedReason ? cleanText(s.endedReason, 200) : null });
        changed = true;
      }
      if (changed) this.onChange?.();
    } catch (e) {
      console.error(`[tickets] noting an ended session failed: ${(e as Error).message}`);
    }
  }
}
