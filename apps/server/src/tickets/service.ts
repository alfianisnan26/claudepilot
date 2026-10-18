import { AppError } from '@isnanme/core';
import type { WorkspaceRefs } from '../workspaces/identity.js';
import {
  BUMP_PRIORITY,
  TICKET_ATTACHMENT_LIMITS,
  type TicketAttachment,
  FOUNDING_USER_ID,
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
  type BumpRequest,
  type BumpTarget,
  type CloseTicketRequest,
  type CreateTicketRequest,
  type PortalScope,
  type StartTicketSessionRequest,
  type StartTicketSessionResult,
  type TicketCheck,
  type TicketCheckState,
  type Ticket,
  type TicketAssignee,
  type TicketBumped,
  type TicketBumpResult,
  type TicketCounts,
  type TicketDetail,
  type TicketEvent,
  type TicketEventKind,
  type TicketFilter,
  type TicketItem,
  type TicketList,
  type TicketPage,
  CURSOR_MAX_LIMIT,
  TICKET_LIST_TEXT,
  type TicketOrphan,
  type TicketOrphanWhy,
  type TicketPriority,
  type TicketSession,
  type TicketStatus,
  type TicketTag,
  type TicketType,
  type UpdateTicketRequest,
} from '@portal/contracts';
import { assertBumpable, bumpMode, bumpNote, bumpTargets as targetsFor } from '../chat/bump.js';
import { cleanText } from '../portalmcp/sanitize.js';
import { clampLimit, cursorAfter, decodeCursor, SCAN_FACTOR } from '../store/keyset.js';
import type { Store } from '../store/store.js';
import {
  AGENT_ASSIGN_USER_TAGS_DEFAULT,
  allowedAssignTags,
  canActForEnded,
  canAgentAssignUser,
  canAgentTagChecklist,
  OWNER_CHECKLIST_TAG,
  canWorkerComment,
  D62_ASSIGN_REFUSAL,
  D62_CHECKLIST_REFUSAL,
  type EndedGrantReason,
  type WorkerCommentReason,
} from './authz.js';
import './errors.js';
import { bumpTicketMessage, openingMessage } from './opening.js';
import type { TicketSessionInfo, TicketSessions } from './sessions.js';
import { cleanLine, cleanMarkdown, cleanTags } from './text.js';
import { putTicketFile, readTicketFile, removeTicketFile } from './files.js';
import {
  canRecordVerdict,
  evaluateVerdicts,
  normalizeSha,
  VERDICT_REFUSAL_TEXT,
  VERDICT_ROLES,
  VERDICTS,
  type StoredVerdict,
  type Verdict,
  type VerdictEvaluation,
  type VerdictRole,
} from './verdicts.js';

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
  /** `manager`: the General Manager's `cpmt_` token (T-968): it may not close a ticket nor record a verdict (#11136 b, PRD §9.4). */
  | { kind: 'token'; tokenId: string; label: string; scope: PortalScope; manager?: true }
  | { kind: 'agent'; tokenId: string; label: string; workspaceId: string; sessionId: string }
  /**
   * A trigger a person made (triggers PRD FR17, owner decision O8): no more rights than `system` plus starting a session; recorded as
   * actor `trigger:<id>`, and its text (an event's words) is untrusted. The session it starts carries `portal:trigger-<id>`.
   */
  | { kind: 'trigger'; triggerId: string; ownerId: string; label: string };

/** FR9a (T-270): an agent acts on a ticket an ENDED session holds, and why it may. */
interface EndedGrant {
  forSession: string;
  why: EndedGrantReason;
}

/** What the audit row for an owner-checklist tag added by an admin's token for a session (`ticket.agent_checklist_tagged`) says. */
interface ChecklistTaggedAudit {
  action: 'create' | 'update';
  actor: string;
  sessionId: string | null;
  leadId: string | null;
  allowedTag: string | null;
}

/** What the audit row for an allowed assignment to a person (`ticket.agent_assigned_person`) says; the ticket id is added once it exists. */
interface AssignedPersonAudit {
  action: 'create' | 'update';
  actor: string;
  actorKind: 'agent' | 'token';
  sessionId: string | null;
  leadId: string | null;
  allowedTag: string | null;
}

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
  /** The workspace column as stored (T-42 slice 3: a stable id or a key), set by `#keyed`; `workspace_id` is then the key. */
  stored_workspace?: string | null;
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
/** FR30: bumps of one ticket, and bumps into one session, in an hour. */
export const BUMP_PER_HOUR_TICKET = 10;
export const BUMP_PER_HOUR_SESSION = 20;
/** FR29: how long a session asked about a ticket (Ask) may answer on it with ticket_comment. */
export const ASK_ANSWER_MS = 24 * HOUR_MS;
/** How an agent session is named as a ticket's reporter (the table's kinds are fixed): its token ids change at every launch, its session id doesn't. */
const reporterRef = (c: { sessionId: string }) => `session:${c.sessionId}`;
const LIST_MAX = 500;
const USER_LABEL_MAX = 40;
const OPEN_SQL = TICKET_OPEN_STATUSES.map((s) => `'${s}'`).join(', ');
/** The refusal for a General Manager token that would close or reopen a ticket (close() and update(); #11136 b). */
const MANAGER_NO_CLOSE = 'The General Manager does not close tickets: QA closes a ticket on its pass.';
const CLOSED_SQL =TICKET_CLOSED_STATUSES.map((s) => `'${s}'`).join(', ');

const invalid = (field: string, message: string) => new AppError('VALIDATION_FAILED', message, { details: { [field]: message } });
const notFound = () => new AppError('NOT_FOUND', 'No such ticket.');
const oneOf = <T extends string>(v: unknown, all: readonly T[], field: string): T => {
  if (typeof v !== 'string' || !(all as readonly string[]).includes(v)) throw invalid(field, `Use one of: ${all.join(', ')}.`);
  return v as T;
};
const workspaceIdOf = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(v.trim()))
    throw invalid('workspaceId', 'A workspace is `<target>/<name>`.');
  return v.trim();
};
/** `%` and `_` in a search are literal text. */
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export interface TicketsOptions {
  now?: () => Date;
  /** Where a person sees a ticket, for the messages the portal sends (a bump's link). Default: the portal's own path. */
  link?: (ticketId: string) => string;
  /**
   * The workspaces' identity registry (T-42 slice 3): a ticket's workspace is stored as the stable id and read back as the `<target>/<name>`
   * key the rest of the portal speaks; rows written before (a key) read as they are. Absent (tests): stored as given.
   */
  workspaceRefs?: WorkspaceRefs;
  /** T-270: minutes a ticket's session must be dead before the orphan sweep moves the ticket (`tickets.orphanAfterMin`). Default 3. */
  orphanAfterMin?: () => number;
  /** FR20: open agent-made tickets a workspace may hold (`tickets.agentOpenPerWorkspace`). Default {@link OPEN_PER_WORKSPACE}. */
  agentOpenPerWorkspace?: () => number;
  /** FR9c (D-62, T-483): the tags that let an agent put a ticket on a person (`tickets.agentAssignUserTags`). Default `production`. */
  agentAssignUserTags?: () => string;
}

/** One move the orphan sweep made (T-270 layer 3): where the ticket went and why. `to` null: back in the agents' queue. */
export interface OrphanMove {
  ticketId: string;
  from: string;
  to: string | null;
  reason: 'lineage' | 'title' | 'queue';
  holder: TicketOrphanWhy;
}

/** The sweep's state in `portal_meta` (restart safe): its last pass and, per dead holder, when the portal first saw it dead. */
const ORPHAN_META = 'tickets:orphans';
const ORPHAN_DEFAULT_MIN = 3;
/** At most this many tickets move in one pass (the rest wait for the next minute). */
export const ORPHAN_MOVES_PER_PASS = 200;
export const ORPHAN_QUEUE_COMMENT = 'Its session ended: back in the queue.';

/** Dead for the sweep: the portal no longer has the session, it was archived, or it ended. `interrupted` can be woken: it is live. */
export function deadWhy(s: TicketSessionInfo | null): TicketOrphanWhy | null {
  if (!s) return 'missing';
  if (s.archivedAt) return 'archived';
  return s.state === 'ended' ? 'ended' : null;
}

/** A title's track, the text before its first ":" ("Orchestrator: ClaudePilot dev" is "Orchestrator"); null without a ":" (no match). */
export function titlePrefix(title: string | null | undefined): string | null {
  const i = title ? title.indexOf(':') : -1;
  if (i <= 0) return null;
  const p = title!.slice(0, i).trim();
  return p || null;
}

/** One row of the platform audit (platform/audit.ts `AuditInput`): ids, labels and fixed codes only, never the note. */
export interface TicketAudit {
  kind: string;
  actor: string;
  actorLabel?: string | null;
  userId: string | null;
  subject?: string | null;
  detail?: Record<string, unknown>;
}

export class Tickets {
  /** Called after any change, for the live page. */
  onChange?: () => void;
  /**
   * Each timeline entry, after its transaction committed (a microtask later): the notifications' bus reads `assigned` here (platform
   * work breakdown H4). `actor` is the stored actor string; `data` is the entry's own (no description, no body).
   */
  onEvent?: (e: {
    ticketId: string;
    kind: TicketEventKind;
    actor: string;
    fromAgent: boolean;
    data: Record<string, unknown> | null;
  }) => void;
  /** A person's or a script's act that reaches into a session (a bump) is written to the platform audit here (index.ts wires it). */
  onAudit?: (e: TicketAudit) => void;
  #told: { ticketId: string; kind: TicketEventKind; actor: string; fromAgent: boolean; data: Record<string, unknown> | null }[] = [];
  #inTx = false;
  readonly #now: () => Date;
  readonly #link: (ticketId: string) => string;
  #off: (() => void) | undefined;

  readonly #refs: TicketsOptions['workspaceRefs'];
  readonly #orphanAfterMin: () => number;
  readonly #agentOpenPerWorkspace: () => number;
  readonly #agentAssignUserTags: () => string;
  #orphans: { lastRunAt: string | null; dead: Record<string, string> } | null = null;

  constructor(
    private readonly store: Store,
    private readonly sessions: TicketSessions,
    opts: TicketsOptions = {},
  ) {
    this.#now = opts.now ?? (() => new Date());
    this.#link = opts.link ?? ((id) => `/admin/tickets/${id}`);
    this.#refs = opts.workspaceRefs;
    this.#orphanAfterMin = opts.orphanAfterMin ?? (() => ORPHAN_DEFAULT_MIN);
    this.#agentOpenPerWorkspace = opts.agentOpenPerWorkspace ?? (() => OPEN_PER_WORKSPACE);
    this.#agentAssignUserTags = opts.agentAssignUserTags ?? (() => AGENT_ASSIGN_USER_TAGS_DEFAULT);
  }

  /* ---------- The workspace column (T-42 slice 3): written as the stable id, read as the key, matched in either form ---------- */

  /** A row with its workspace as the key, whichever form it is stored in: everything past the query compares keys. */
  #keyed<R extends Row | undefined>(row: R): R {
    if (!row || !this.#refs || row.workspace_id === null) return row;
    return { ...row, workspace_id: this.#refs.keyOf(row.workspace_id), stored_workspace: row.workspace_id } as R;
  }

  /** What a write stores for a workspace: its stable id when it has one. */
  #stored(key: string | null): string | null {
    return this.#refs ? this.#refs.storedRef(key) : key;
  }

  /** `t.workspace_id IN (…)` for one workspace, in every form its rows may hold while the move runs. */
  #inWorkspace(column: string, key: string): { sql: string; args: string[] } {
    const forms = this.#refs ? this.#refs.storedForms(key) : [key];
    return { sql: `${column} IN (${forms.map(() => '?').join(', ')})`, args: forms };
  }

  /**
   * Whether a row is in this workspace, on what is STORED, not on the key it reads as: a ticket of a REMOVED workspace (its id) is not in a
   * new workspace that took the name, though both read as the same key. `null` is the shared queue.
   */
  #isIn(row: Row, key: string | null): boolean {
    const stored = row.stored_workspace ?? row.workspace_id;
    if (key === null || stored === null) return key === stored;
    return this.#refs ? this.#refs.storedForms(key).includes(stored) : stored === key;
  }

  /**
   * The workspace a bump must stay in: the ticket's key while its workspace lives; for a REMOVED workspace's ticket its stored id, which no
   * session's workspace is, so no session of a new workspace that took the name is offered or bumped into.
   */
  #bumpWorkspace(row: Row): string | null {
    if (row.workspace_id === null || this.#isIn(row, row.workspace_id)) return row.workspace_id;
    return row.stored_workspace ?? row.workspace_id;
  }

  /** Follows sessions: one that ends under its ticket leaves an entry on it (FR18). */
  start(): void {
    // Not on a database the portal can't trust or write: its tables may not exist (a frozen portal must still start).
    if (!this.store.writable || !this.store.deliveryAllowed) return;
    this.#off ??= this.sessions.onSession((s) => {
      if (s.state === 'ended') this.#sessionEnded(s);
      // Back to live within the delay (in-place recovery, T-136 keeps the id): its tickets stay where they are (T-270).
      else if (!s.archivedAt) this.#markAlive(s.id);
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
    // Inside a transaction someone else opened (a continuation's, T-270: the chat row and the tickets commit together): join it.
    if (db.isTransaction && !this.#inTx) {
      this.#inTx = true;
      try {
        return fn();
      } finally {
        this.#inTx = false;
        queueMicrotask(() => this.#tell());
      }
    }
    db.exec('BEGIN IMMEDIATE');
    this.#inTx = true;
    try {
      const out = fn();
      db.exec('COMMIT');
      this.#inTx = false;
      this.#tell();
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      this.#inTx = false;
      this.#told = [];
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
    if (caller.kind === 'trigger')
      return { actor: `trigger:${caller.triggerId}`, label: cleanText(caller.label, 60) || 'Trigger', fromAgent: true, session: null };
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
      // The actor is the token, so it is named by the token's label (not the session it acts for): "MCP client “relay”" on the timeline.
      return { ...base, label: caller.label, session: s };
    }
    return { ...base, label: caller.label, session: null };
  }

  /** A write needs a token that can write. */
  #assertWrites(caller: Caller) {
    if (caller.kind === 'token' && caller.scope === 'read')
      throw new AppError('FORBIDDEN', 'This token can only read. Writing needs the operate scope.');
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
    return row.workspace_id === null || this.#isIn(row, caller.workspaceId);
  }

  /**
   * FR9: what an agent may change. People, the portal and an admin's operate token may change anything. Returns the grant when the agent
   * acts on a ticket an ENDED session holds (FR9a, T-270): the caller writes the audit row for it once the write is done.
   */
  #assertCanModify(caller: Caller, row: Row, w: Writer): EndedGrant | null {
    if (caller.kind === 'token') return (this.#assertWrites(caller), null);
    if (caller.kind !== 'agent') return null;
    const id = ticketIdOf(row.number);
    if (isTicketClosed(row.status)) throw new AppError('FORBIDDEN', `${id} is closed. A person can reopen it.`);
    if (row.assignee_kind === 'session') {
      if (row.assignee_ref === w.session!.id) return null;
      const grant = this.#forEnded(w.session!, row.assignee_ref!);
      if (grant) return grant;
      throw new AppError(
        'FORBIDDEN',
        `${id} is assigned to another session. Only the session it is assigned to can change it (one that ended is taken over with ticket_adopt).`,
      );
    }
    // Nobody, or a person, holds it: only the session that made it may still change it.
    if (!(row.reporter_kind === 'token' && row.reporter_ref === reporterRef(caller)))
      throw new AppError(
        'FORBIDDEN',
        row.assignee_kind === 'user'
          ? `${id} is assigned to a person.`
          : `${id} is not assigned to you. Claim it with ticket_claim_next first.`,
      );
    return null;
  }

  /**
   * A crew LEAD may hand a ticket of its own workspace to one of its workers (or take it itself): the ticket is open, held by nobody, by the
   * lead, by one of its workers, or by a session that ended; the new holder is the lead or a live worker whose parent is the lead; and the
   * change is the assignee (with status or priority at most). Anything else keeps the usual refusal. Each use leaves `ticket.lead_assigned`.
   */
  #leadMayAssign(caller: Caller, row: Row, w: Writer, req: Partial<UpdateTicketRequest>): boolean {
    if (caller.kind !== 'agent' || !w.session || isTicketClosed(row.status) || req.assignee === undefined) return false;
    const extra = Object.keys(req).filter((k) => (req as Record<string, unknown>)[k] !== undefined && !['assignee', 'status', 'priority'].includes(k));
    if (extra.length) return false;
    const lead = w.session;
    if (!row.workspace_id || row.workspace_id !== lead.workspaceId) return false;
    if (row.assignee_kind === 'user') return false;
    if (row.assignee_kind === 'session' && row.assignee_ref && row.assignee_ref !== lead.id) {
      const holder = this.sessions.get(row.assignee_ref);
      const crew = holder?.parentId === lead.id;
      const gone = !holder || holder.state === 'ended' || !!holder.archivedAt;
      if (!crew && !gone) return false;
    }
    const to = req.assignee;
    if (to !== null) {
      if (to.kind !== 'session' || typeof to.sessionId !== 'string') return false;
      const target = to.sessionId === lead.id ? lead : this.sessions.get(to.sessionId);
      if (!target || target.state === 'ended' || (target.id !== lead.id && target.parentId !== lead.id)) return false;
    }
    this.onAudit?.({
      kind: 'ticket.lead_assigned',
      actor: w.actor,
      actorLabel: null,
      userId: FOUNDING_USER_ID,
      subject: `ticket:${ticketIdOf(row.number)}`,
      detail: { ticketId: ticketIdOf(row.number), lead: lead.id, from: row.assignee_ref ?? null, to: to ? to.sessionId : null },
    });
    return true;
  }

  /** The actor's predecessors, nearest first (`continued_from` back; bounded, cycle safe). */
  #ancestors(s: TicketSessionInfo): string[] {
    const out: string[] = [];
    let cur: TicketSessionInfo | null = s;
    while (cur?.continuedFrom && out.length < 100 && !out.includes(cur.continuedFrom) && cur.continuedFrom !== s.id) {
      out.push(cur.continuedFrom);
      cur = this.sessions.get(cur.continuedFrom);
    }
    return out;
  }

  /** Whether a live session continues `id`, directly or down its chain (in its workspace). */
  #hasLiveSuccessor(id: string, workspaceId: string): boolean {
    const all = this.sessions.list({ workspaceId });
    const seen = new Set<string>([id]);
    let frontier = [id];
    while (frontier.length && seen.size < 500) {
      const next = all.filter((s) => s.continuedFrom && frontier.includes(s.continuedFrom) && !seen.has(s.id));
      if (next.some((s) => s.state !== 'ended')) return true;
      for (const s of next) seen.add(s.id);
      frontier = next.map((s) => s.id);
    }
    return false;
  }

  /** FR9a (T-270): the ended-session rule (authz.ts `canActForEnded`) for a ticket `holderId` holds; null when it refuses. */
  #forEnded(actor: TicketSessionInfo, holderId: string): EndedGrant | null {
    const holder = this.sessions.get(holderId);
    const d = canActForEnded({
      actor,
      holder,
      holderKind: 'session',
      actorAncestors: this.#ancestors(actor),
      holderHasLiveSuccessor: holder ? this.#hasLiveSuccessor(holder.id, holder.workspaceId) : false,
    });
    return d.allow ? { forSession: holderId, why: d.why } : null;
  }

  /** The audit row of a write made under FR9a: which session acted for which ended one, and why. */
  #auditForEnded(grant: EndedGrant | null, w: Writer, row: Row, action: 'update' | 'comment' | 'close') {
    if (!grant) return;
    const ticketId = ticketIdOf(row.number);
    this.onAudit?.({
      kind: 'ticket.acted_for_ended',
      actor: w.actor,
      actorLabel: null,
      userId: FOUNDING_USER_ID,
      subject: `ticket:${ticketId}`,
      detail: { ticketId, action, sessionId: w.session?.id ?? null, forSession: grant.forSession, why: grant.why },
    });
  }

  /**
   * FR29: commenting is what FR9 allows, and also the answer of a session a person asked about the ticket (Ask) in the last day. FR9b
   * (T-294, T-397): a crew worker's comment on its spawn's ticket or its lead's (authz.ts `canWorkerComment`). A refusal keeps FR9's text.
   */
  #assertCanComment(caller: Caller, row: Row, w: Writer): { ended: EndedGrant | null; worker: WorkerCommentReason | null } {
    try {
      return { ended: this.#assertCanModify(caller, row, w), worker: null };
    } catch (e) {
      if (caller.kind === 'agent' && !isTicketClosed(row.status) && this.#bumpedInto(row.number, caller.sessionId, ASK_ANSWER_MS))
        return { ended: null, worker: null };
      if (caller.kind === 'agent' && !isTicketClosed(row.status)) {
        const why = this.#workerComment(w.session!, row);
        if (why) return { ended: null, worker: why };
      }
      throw e;
    }
  }

  /** FR9b: why the worker `s` may comment on `row` (authz.ts `canWorkerComment`), or null. */
  #workerComment(s: TicketSessionInfo, row: Row): WorkerCommentReason | null {
    const holder = row.assignee_kind === 'session' && row.assignee_ref ? this.sessions.get(row.assignee_ref) : null;
    const d = canWorkerComment({
      worker: s,
      ticketId: ticketIdOf(row.number),
      holderKind: row.assignee_kind,
      holderId: row.assignee_ref,
      holderAncestors: holder ? this.#ancestors(holder) : [],
      holderLead: holder?.parentId ?? null,
    });
    return d.allow ? d.why : null;
  }

  /** The audit row of a worker's comment under FR9b: the worker that wrote it, its lead and why. */
  #auditWorkerComment(why: WorkerCommentReason | null, w: Writer, row: Row) {
    if (!why) return;
    const ticketId = ticketIdOf(row.number);
    this.onAudit?.({
      kind: 'ticket.worker_commented',
      actor: w.actor,
      actorLabel: null,
      userId: FOUNDING_USER_ID,
      subject: `ticket:${ticketId}`,
      detail: { ticketId, sessionId: w.session?.id ?? null, leadId: w.session?.parentId ?? null, holder: row.assignee_ref ?? null, why },
    });
  }

  /** Whether the ticket was bumped into the session within `withinMs`. */
  #bumpedInto(number: number, sessionId: string, withinMs: number): boolean {
    const since = new Date(this.#now().getTime() - withinMs).toISOString();
    return !!this.#db
      .prepare(
        "SELECT 1 FROM ticket_events WHERE ticket_number = ? AND kind = 'bumped' AND json_extract(data, '$.sessionId') = ? AND at > ? LIMIT 1",
      )
      .get(number, sessionId, since);
  }

  /* ---------- Reading ---------- */

  #row(number: number): Row | undefined {
    return this.#keyed(this.#db.prepare('SELECT * FROM tickets WHERE number = ?').get(number) as unknown as Row | undefined);
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
    const rows = this.#db
      .prepare(`SELECT ticket_number, tag FROM ticket_tags WHERE ticket_number IN (${numbers.map(() => '?').join(',')}) ORDER BY tag`)
      .all(...numbers) as { ticket_number: number; tag: string }[];
    for (const r of rows) out.set(r.ticket_number, [...(out.get(r.ticket_number) ?? []), r.tag]);
    return out;
  }

  #sessionView(s: TicketSessionInfo): TicketSession {
    return {
      id: s.id,
      title: s.title,
      state: s.state,
      workspaceId: s.workspaceId,
      lastActivityAt: s.lastActivityAt,
      endedReason: s.endedReason,
      worktree: s.worktree,
    };
  }

  #item(r: Row, tags: string[]): TicketItem {
    const assignee: TicketAssignee | null =
      r.assignee_kind === 'session'
        ? { kind: 'session', sessionId: r.assignee_ref! }
        : r.assignee_kind === 'user'
          ? { kind: 'user', name: r.assignee_ref! }
          : null;
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
    const why = r.assignee_kind === 'session' && !isTicketClosed(r.status) ? deadWhy(session ?? null) : null;
    const orphan: TicketOrphan | null = why
      ? { since: this.#orphanState().dead[r.assignee_ref!] ?? null, sessionId: r.assignee_ref!, why }
      : null;
    return {
      ...ticket,
      assigneeSession: session ? this.#sessionView(session) : null,
      sessionEnded: !!session && session.state === 'ended' && !isTicketClosed(r.status),
      orphan,
    };
  }

  #items(rows: Row[]): TicketItem[] {
    const tags = this.#tagsOf(rows.map((r) => r.number));
    return rows.map((r) => this.#item(r, tags.get(r.number) ?? []));
  }

  /** The SQL a caller's filters and visibility come to. */
  #where(caller: Caller, f: TicketFilter, forCounts = false): { sql: string; args: (string | number)[] } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (caller.kind === 'agent') {
      const mine = this.#inWorkspace('t.workspace_id', caller.workspaceId);
      where.push(`(t.workspace_id IS NULL OR ${mine.sql})`);
      args.push(...mine.args);
    }
    if (forCounts) return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
    const statuses = f.status?.filter((s) => (TICKET_STATUSES as readonly string[]).includes(s));
    if (statuses?.length) (where.push(`t.status IN (${statuses.map(() => '?').join(',')})`), args.push(...statuses));
    else if (!f.includeClosed) where.push(`t.status NOT IN (${CLOSED_SQL})`);
    const priorities = f.priority?.filter((p) => (TICKET_PRIORITIES as readonly string[]).includes(p));
    if (priorities?.length) (where.push(`t.priority IN (${priorities.map(() => '?').join(',')})`), args.push(...priorities));
    const types = f.type?.filter((t) => (TICKET_TYPES as readonly string[]).includes(t));
    if (types?.length) (where.push(`t.type IN (${types.map(() => '?').join(',')})`), args.push(...types));
    if (f.tag)
      (where.push('EXISTS (SELECT 1 FROM ticket_tags g WHERE g.ticket_number = t.number AND g.tag = ?)'), args.push(f.tag.toLowerCase()));
    if (f.assignee === 'unassigned') where.push('t.assignee_kind IS NULL');
    else if (f.assignee === 'user') where.push("t.assignee_kind = 'user'");
    else if (f.assignee?.startsWith('session:'))
      (where.push("t.assignee_kind = 'session' AND t.assignee_ref = ?"), args.push(f.assignee.slice(8)));
    if (f.orphan) {
      const o = this.#orphanSql();
      where.push(o.sql);
      args.push(...o.args);
    }
    if (f.workspaceId) {
      const one = this.#inWorkspace('t.workspace_id', f.workspaceId);
      where.push(one.sql);
      args.push(...one.args);
    }
    if (f.query?.trim()) {
      const q = like(f.query.trim().slice(0, 100));
      where.push(
        "(t.summary LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM ticket_tags g WHERE g.ticket_number = t.number AND g.tag LIKE ? ESCAPE '\\'))",
      );
      args.push(q, q, q);
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
  }

  counts(caller: Caller): TicketCounts {
    const { sql, args } = this.#where(caller, {}, true);
    const byStatus = Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0])) as Record<TicketStatus, number>;
    for (const r of this.#db.prepare(`SELECT t.status AS status, count(*) AS n FROM tickets t ${sql} GROUP BY t.status`).all(...args) as {
      status: TicketStatus;
      n: number;
    }[])
      byStatus[r.status] = r.n;
    const and = sql ? `${sql} AND` : 'WHERE';
    const needsYou = (
      this.#db
        .prepare(`SELECT count(*) AS n FROM tickets t ${and} t.assignee_kind = 'user' AND t.status IN (${OPEN_SQL})`)
        .get(...args) as { n: number }
    ).n;
    const unassigned = (
      this.#db.prepare(`SELECT count(*) AS n FROM tickets t ${and} t.assignee_kind IS NULL AND t.status = 'open'`).get(...args) as {
        n: number;
      }
    ).n;
    const o = this.#orphanSql();
    const orphans = (this.#db.prepare(`SELECT count(*) AS n FROM tickets t ${and} ${o.sql}`).get(...args, ...o.args) as { n: number }).n;
    return { byStatus, needsYou, unassigned, orphans, total: Object.values(byStatus).reduce((a, b) => a + b, 0) };
  }

  list(caller: Caller, filter: TicketFilter = {}): TicketList {
    const { sql, args } = this.#where(caller, filter);
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), LIST_MAX);
    const offset = Math.max(Math.trunc(filter.offset ?? 0), 0);
    const closedOnly = !!filter.status?.length && filter.status.every((s) => isTicketClosed(s));
    const order = closedOnly
      ? 't.closed_at DESC, t.number DESC'
      : filter.sort === 'newest'
        ? 't.created_at DESC, t.number DESC'
        : 't.priority_rank ASC, t.updated_at DESC, t.number DESC';
    const rows = (
      this.#db
        .prepare(`SELECT t.* FROM tickets t ${sql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`)
        .all(...args) as unknown as Row[]
    ).map((r) => this.#keyed(r));
    const total = (this.#db.prepare(`SELECT count(*) AS n FROM tickets t ${sql}`).get(...args) as { n: number }).n;
    return { items: this.#items(rows), total, counts: this.counts(caller) };
  }

  /**
   * D-58: one page of {@link list}, same order, by keyset on the sort key plus the ticket number (a ticket made or touched while a client pages
   * never repeats or skips a row), as SUMMARY rows: description and closing summary cut at {@link TICKET_LIST_TEXT} characters.
   * The cursor is bound to the caller and every filter value (a cursor from another filter is a 400). `keep` is the caller's `view` check: a
   * row it refuses is not shown. The cursor points at the last row SHOWN, or, when the scan bound (SCAN_FACTOR x limit rows read) ends the page, at
   * the last row scanned; it is sealed, so it shows nothing of a hidden ticket. `total` and `counts` only on page 1.
   */
  listPage(
    caller: Caller,
    filter: TicketFilter = {},
    args: { cursor?: string | undefined; limit?: unknown; keep?: (t: TicketItem) => boolean } = {},
  ): TicketPage {
    const { sql, args: sqlArgs } = this.#where(caller, filter);
    const limit = clampLimit(args.limit);
    const closedOnly = !!filter.status?.length && filter.status.every((s) => isTicketClosed(s));
    const kind = closedOnly ? 'closed' : filter.sort === 'newest' ? 'newest' : 'priority';
    const scope = `tickets|${JSON.stringify([caller.kind === 'agent' ? `agent:${caller.workspaceId}` : caller.kind, kind, filter.status ?? null, filter.priority ?? null, filter.type ?? null, filter.tag ?? null, filter.assignee ?? null, filter.workspaceId ?? null, filter.query?.trim() ?? null, !!filter.includeClosed, !!filter.orphan])}`;
    // The sort key of a row, as the cursor carries it, and the SQL that says "after the cursor" in the list's order.
    const keyOf = (r: Row): string =>
      kind === 'closed' ? (r.closed_at ?? '') : kind === 'newest' ? r.created_at : `${r.priority_rank}|${r.updated_at}`;
    const order =
      kind === 'closed'
        ? "COALESCE(t.closed_at, '') DESC, t.number DESC"
        : kind === 'newest'
          ? 't.created_at DESC, t.number DESC'
          : 't.priority_rank ASC, t.updated_at DESC, t.number DESC';
    const after = (key: string, num: number): { sql: string; args: (string | number)[] } => {
      if (kind !== 'priority') {
        const col = kind === 'closed' ? "COALESCE(t.closed_at, '')" : 't.created_at';
        return { sql: `(${col} < ? OR (${col} = ? AND t.number < ?))`, args: [key, key, num] };
      }
      const cut = key.indexOf('|');
      const rank = Number(key.slice(0, cut));
      const upd = key.slice(cut + 1);
      if (cut < 0 || !Number.isFinite(rank))
        throw new AppError('BAD_REQUEST', 'That cursor is not valid for this list. Load the list again.');
      return {
        sql: '(t.priority_rank > ? OR (t.priority_rank = ? AND t.updated_at < ?) OR (t.priority_rank = ? AND t.updated_at = ? AND t.number < ?))',
        args: [rank, rank, upd, rank, upd, num],
      };
    };
    let resume: { key: string; num: number } | null = null;
    if (args.cursor) {
      const at = decodeCursor(args.cursor, scope);
      if (typeof at.sort !== 'string' || typeof at.id !== 'number')
        throw new AppError('BAD_REQUEST', 'That cursor is not valid for this list. Load the list again.');
      resume = { key: at.sort, num: at.id };
    }
    const shown: { item: TicketItem; key: string; num: number }[] = [];
    // Bounded scan: at most SCAN_FACTOR x limit rows per request, however many `keep` hides. At the bound the page ends and `next` rests on the
    // last row SCANNED (shown or not); the cursor is sealed (keyset.ts), so a hidden ticket is not readable in it.
    const maxScan = limit * SCAN_FACTOR;
    let scanned = 0;
    let more: { key: string; num: number } | null = null;
    while (scanned < maxScan) {
      const room = Math.min(CURSOR_MAX_LIMIT, maxScan - scanned);
      const a = resume ? after(resume.key, resume.num) : null;
      const where = a ? (sql ? `${sql} AND ${a.sql}` : `WHERE ${a.sql}`) : sql;
      const got = (
        this.#db
          .prepare(`SELECT t.* FROM tickets t ${where} ORDER BY ${order} LIMIT ?`)
          .all(...sqlArgs, ...(a?.args ?? []), room + 1) as unknown as Row[]
      ).map((r) => this.#keyed(r));
      const batch = got.slice(0, room);
      const items = this.#items(batch);
      batch.forEach((r, i) => {
        const item = this.#summary(items[i]!);
        if (!args.keep || args.keep(item)) shown.push({ item, key: keyOf(r), num: r.number });
      });
      scanned += batch.length;
      const last = batch[batch.length - 1];
      more = got.length > room && last ? { key: keyOf(last), num: last.number } : null;
      if (shown.length > limit || !more) break;
      resume = more;
    }
    const page = shown.slice(0, limit);
    const last = page[page.length - 1];
    const nextAt = shown.length > limit && last ? { key: last.key, num: last.num } : shown.length > limit ? null : more;
    const out: TicketPage = { items: page.map((x) => x.item), next: nextAt ? cursorAfter(scope, nextAt.key, nextAt.num) : null };
    if (!args.cursor) {
      out.total = (this.#db.prepare(`SELECT count(*) AS n FROM tickets t ${sql}`).get(...sqlArgs) as { n: number }).n;
      out.counts = this.counts(caller);
    }
    return out;
  }

  /** A list row: the long texts cut (D-58). The detail read has the whole. */
  #summary(t: TicketItem): TicketItem {
    const cut = (s: string | null): string | null => {
      if (s === null || s.length <= TICKET_LIST_TEXT) return s;
      const end = /[\uD800-\uDBFF]/.test(s[TICKET_LIST_TEXT - 1]!) ? TICKET_LIST_TEXT - 1 : TICKET_LIST_TEXT;
      return s.slice(0, end);
    };
    return {
      ...t,
      description: cut(t.description) ?? '',
      closingSummary: cut(t.closingSummary),
      descriptionCut: t.description.length > TICKET_LIST_TEXT,
      closingSummaryCut: (t.closingSummary?.length ?? 0) > TICKET_LIST_TEXT,
    };
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
      return {
        id: e.id,
        ticketId: ticketIdOf(e.ticket_number),
        at: e.at,
        kind: e.kind,
        actor: e.actor,
        actorLabel: e.actor_label,
        body: e.body,
        data,
        fromAgent: /^(portal-mcp|session|ci|trigger):/.test(e.actor),
      };
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
    return {
      ticket: ticket!,
      events: this.#events(row.number, { limit: opts.eventsLimit }),
      sessions,
      checks: this.#checks(row.number),
      attachments: this.#attachments(row.number),
    };
  }

  /* ---------- Attachments (owner, 2026-10-17: "ticket support with attachment, all files") ---------- */

  #attachments(number: number): TicketAttachment[] {
    const rows = this.#db
      .prepare(
        'SELECT id, name, size, media_type, sha256, actor, actor_label, at FROM ticket_attachments WHERE ticket_number = ? ORDER BY id',
      )
      .all(number) as {
      id: number;
      name: string;
      size: number;
      media_type: string;
      sha256: string;
      actor: string;
      actor_label: string;
      at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      ticketId: ticketIdOf(number),
      name: r.name,
      size: r.size,
      mediaType: r.media_type,
      sha256: r.sha256,
      at: r.at,
      actor: r.actor,
      actorLabel: r.actor_label,
      fromAgent: /^(?:session|portal-mcp):/.test(r.actor),
    }));
  }

  /** The files on a ticket, oldest first (whoever may see the ticket). */
  attachments(caller: Caller, id: string): TicketAttachment[] {
    return this.#attachments(this.#need(caller, id).number);
  }

  /**
   * Attaches a file: whoever may comment on the ticket may attach (FR29, FR9b), any type. The name loses its folders and control characters;
   * the type is kept only when it looks like one (else application/octet-stream). Limits: TICKET_ATTACHMENT_LIMITS. One timeline entry.
   */
  attach(
    caller: Caller,
    id: string,
    file: { name: unknown; mediaType?: unknown; bytes: Buffer },
    opts: { sessionId?: string | null } = {},
  ): TicketAttachment {
    const row = this.#need(caller, id);
    const w = this.#writer(caller, opts.sessionId);
    const grant = this.#assertCanComment(caller, row, w);
    if (isTicketClosed(row.status) && caller.kind === 'agent')
      throw new AppError('FORBIDDEN', `${ticketIdOf(row.number)} is closed. A person can reopen it.`);
    const raw = typeof file.name === 'string' ? file.name : '';
    const name = raw
      .split(/[\\/]/)
      .pop()!
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, TICKET_ATTACHMENT_LIMITS.name);
    if (!name || name === '.' || name === '..')
      throw new AppError('VALIDATION_FAILED', 'Give the file a name.', { details: { name: 'A file name, without folders.' } });
    if (!file.bytes.length)
      throw new AppError('VALIDATION_FAILED', 'The file is empty.', { details: { file: 'Attach a file with content.' } });
    if (file.bytes.length > TICKET_ATTACHMENT_LIMITS.maxBytes)
      throw new AppError('PAYLOAD_TOO_LARGE', `The file is larger than ${TICKET_ATTACHMENT_LIMITS.maxBytes / 1024 / 1024} MB.`, {
        details: { file: 'Too large.' },
      });
    const count = (
      this.#db.prepare('SELECT count(*) AS n FROM ticket_attachments WHERE ticket_number = ?').get(row.number) as { n: number }
    ).n;
    if (count >= TICKET_ATTACHMENT_LIMITS.perTicket)
      throw new AppError(
        'CONFLICT',
        `${ticketIdOf(row.number)} already has ${TICKET_ATTACHMENT_LIMITS.perTicket} files. Remove one first.`,
      );
    const type = typeof file.mediaType === 'string' ? file.mediaType.split(';')[0]!.trim().toLowerCase() : '';
    const mediaType = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(type) ? type : 'application/octet-stream';
    const sha256 = putTicketFile(this.store.dataDir, file.bytes);
    const at = this.#now().toISOString();
    const attachmentId = this.#tx(() => {
      this.#db
        .prepare(
          'INSERT INTO ticket_attachments (ticket_number, name, size, media_type, sha256, actor, actor_label, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(row.number, name, file.bytes.length, mediaType, sha256, w.actor, w.label, at);
      const newId = Number((this.#db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
      this.#db.prepare('UPDATE tickets SET updated_at = ? WHERE number = ?').run(at, row.number);
      this.#addEvent(row.number, 'attachment', w, null, {
        attachmentId: newId,
        name,
        size: file.bytes.length,
        mediaType,
        ...(w.session ? { session: w.session.id } : {}),
      });
      return newId;
    });
    this.#auditForEnded(grant.ended, w, row, 'comment');
    this.#auditWorkerComment(grant.worker, w, row);
    this.onChange?.();
    return this.#attachments(row.number).find((a) => a.id === attachmentId)!;
  }

  /** One file's record and bytes, for whoever may see the ticket; the same not found for a file of another ticket. */
  attachmentFile(caller: Caller, id: string, attachmentId: number): { attachment: TicketAttachment; bytes: Buffer } {
    const row = this.#need(caller, id);
    const attachment = this.#attachments(row.number).find((a) => a.id === attachmentId);
    const bytes = attachment ? readTicketFile(this.store.dataDir, attachment.sha256) : null;
    if (!attachment || !bytes) throw new AppError('NOT_FOUND', `${ticketIdOf(row.number)} has no file ${attachmentId}.`);
    return { attachment, bytes };
  }

  /** Removes a file: a person, or the session that attached it. The bytes go when no other row names them. One timeline entry. */
  removeAttachment(caller: Caller, id: string, attachmentId: number, opts: { sessionId?: string | null } = {}): void {
    const row = this.#need(caller, id);
    const w = this.#writer(caller, opts.sessionId);
    const attachment = this.#attachments(row.number).find((a) => a.id === attachmentId);
    if (!attachment) throw new AppError('NOT_FOUND', `${ticketIdOf(row.number)} has no file ${attachmentId}.`);
    if (caller.kind === 'agent' && attachment.actor !== w.actor)
      throw new AppError('FORBIDDEN', 'Only a person or the session that attached a file can remove it.');
    if (caller.kind === 'token') this.#assertWrites(caller);
    this.#tx(() => {
      this.#db.prepare('DELETE FROM ticket_attachments WHERE id = ?').run(attachmentId);
      this.#db.prepare('UPDATE tickets SET updated_at = ? WHERE number = ?').run(this.#now().toISOString(), row.number);
      this.#addEvent(row.number, 'attachment', w, null, {
        attachmentId,
        name: attachment.name,
        size: attachment.size,
        mediaType: attachment.mediaType,
        removed: true,
      });
    });
    const still = this.#db.prepare('SELECT 1 FROM ticket_attachments WHERE sha256 = ? LIMIT 1').get(attachment.sha256);
    if (!still) removeTicketFile(this.store.dataDir, attachment.sha256);
    this.onChange?.();
  }

  #checks(number: number): TicketCheck[] {
    const rows = this.#db
      .prepare('SELECT name, state, run_id, commit_sha, link, updated_at FROM ticket_checks WHERE ticket_number = ? ORDER BY name')
      .all(number) as {
      name: string;
      state: TicketCheckState;
      run_id: string | null;
      commit_sha: string | null;
      link: string | null;
      updated_at: string;
    }[];
    return rows.map((r) => ({
      name: r.name,
      state: r.state,
      runId: r.run_id,
      commit: r.commit_sha,
      link: r.link,
      updatedAt: r.updated_at,
    }));
  }

  /** A ticket's id and summary, for a link to it. */
  brief(id: string): { id: string; summary: string; status: TicketStatus; type: TicketType } | null {
    const n = parseTicketId(id);
    const row = n === null ? undefined : this.#row(n);
    return row ? { id: ticketIdOf(row.number), summary: row.summary, status: row.status, type: row.type } : null;
  }

  /** The message a session started for this ticket would open with, for the dialog's preview (its session id is not known yet). */
  opening(caller: Caller, id: string): string {
    const [item] = this.#items([this.#need(caller, id)]);
    return openingMessage(item!, '(its id, once it starts)');
  }

  tags(caller: Caller): TicketTag[] {
    const { sql, args } = this.#where(caller, {}, true);
    const rows = this.#db
      .prepare(
        `SELECT g.tag AS tag, count(*) AS count FROM ticket_tags g JOIN tickets t ON t.number = g.ticket_number ${sql} GROUP BY g.tag ORDER BY count DESC, g.tag ASC`,
      )
      .all(...args) as { tag: string; count: number }[];
    return rows.map((r) => ({ tag: r.tag, count: r.count }));
  }

  /* ---------- Writing ---------- */

  /** Hands what was written to `onEvent` once it is committed. */
  #tell() {
    const told = this.#told;
    this.#told = [];
    if (!told.length || !this.onEvent) return;
    queueMicrotask(() => {
      for (const e of told) {
        try {
          this.onEvent?.(e);
        } catch (err) {
          console.error(`[tickets] an event listener failed: ${(err as Error).message}`);
        }
      }
    });
  }

  #addEvent(
    number: number,
    kind: TicketEventKind,
    w: Pick<Writer, 'actor' | 'label'>,
    body: string | null,
    data: Record<string, unknown> | null,
  ) {
    this.#told.push({ ticketId: ticketIdOf(number), kind, actor: w.actor, fromAgent: /^(?:session|portal-mcp):/.test(w.actor), data });
    if (!this.#inTx) queueMicrotask(() => this.#tell());
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
  #assignee(
    caller: Caller,
    input: TicketAssignee | null | undefined,
  ): { kind: 'session'; session: TicketSessionInfo } | { kind: 'user'; name: string } | null {
    if (input === null || input === undefined) return null;
    if (input.kind === 'user') return { kind: 'user', name: cleanLine(input.name || TICKET_DEFAULT_USER, 'assignee', USER_LABEL_MAX) };
    if (input.kind !== 'session' || typeof input.sessionId !== 'string') throw invalid('assignee', 'Assign to a session or a person.');
    const s = this.sessions.get(input.sessionId);
    if (!s) throw invalid('assignee', 'No such session.');
    if (s.state === 'ended') throw invalid('assignee', 'That session has ended.');
    if (caller.kind === 'agent' && s.workspaceId !== caller.workspaceId)
      throw new AppError('FORBIDDEN', `That session is not in workspace ${caller.workspaceId}.`);
    return { kind: 'session', session: s };
  }

  /**
   * FR9c (D-62, T-483): an agent may not put a ticket on a person without an allowed tag (authz.ts `canAgentAssignUser`). A refusal is
   * FORBIDDEN with the D-62 path (not a 404: the agent may see the ticket) and one `ticket.agent_assign_refused` audit row (ids and tags only).
   */
  #assertAgentAssign(
    caller: Caller,
    w: Writer,
    facts: {
      ticketId: string | null;
      action: 'create' | 'update';
      assigneeAfter: 'session' | 'user' | null;
      assignsUser: boolean;
      tagsBefore: readonly string[];
      tagsAfter: readonly string[];
    },
  ): AssignedPersonAudit | null {
    // An admin's token acting for a session is never refused, but the assignment it makes to a person is audited (T-483).
    const forSession = caller.kind === 'token' && w.session !== null;
    if (caller.kind !== 'agent' && !forSession) return null;
    const allowedTags = this.#allowedAssignTags();
    const d = canAgentAssignUser({
      callerKind: caller.kind,
      assigneeAfter: facts.assigneeAfter,
      assignsUser: facts.assignsUser,
      tagsBefore: facts.tagsBefore,
      tagsAfter: facts.tagsAfter,
      allowedTags,
    });
    if (d.allow) {
      if (!facts.assignsUser) return null;
      const allowedTag = facts.tagsAfter.find((t) => allowedTags.includes(t)) ?? null;
      return {
        action: facts.action,
        actor: w.actor,
        actorKind: caller.kind === 'agent' ? 'agent' : 'token',
        sessionId: w.session?.id ?? null,
        leadId: w.session?.parentId ?? null,
        allowedTag,
      };
    }
    this.onAudit?.({
      kind: 'ticket.agent_assign_refused',
      actor: w.actor,
      actorLabel: null,
      userId: FOUNDING_USER_ID,
      subject: facts.ticketId ? `ticket:${facts.ticketId}` : null,
      detail: {
        ticketId: facts.ticketId,
        action: facts.action,
        sessionId: w.session?.id ?? null,
        leadId: w.session?.parentId ?? null,
        tags: [...facts.tagsAfter],
        allowedTags,
        why: d.why,
      },
    });
    throw new AppError('FORBIDDEN', D62_ASSIGN_REFUSAL);
  }

  /** `tickets.agentAssignUserTags` as a list; the built-in default when the setting cannot be read. */
  #allowedAssignTags(): string[] {
    let raw: unknown = AGENT_ASSIGN_USER_TAGS_DEFAULT;
    try {
      raw = this.#agentAssignUserTags();
    } catch {
      // the setting could not be read: the built-in default holds
    }
    return allowedAssignTags(raw);
  }

  /**
   * FR9d (D-62, T-527): an agent may not add `owner-checklist` without an allowed tag (authz.ts `canAgentTagChecklist`): the tag puts a
   * ticket on the owner's Needs you as surely as assigning a person. A refusal is FORBIDDEN with the D-62 path and one
   * `ticket.agent_checklist_refused` audit row (ids and tags only), the same shape as `ticket.agent_assign_refused`.
   */
  #assertAgentChecklist(
    caller: Caller,
    w: Writer,
    facts: { ticketId: string | null; action: 'create' | 'update'; tagsBefore: readonly string[]; tagsAfter: readonly string[] },
  ): ChecklistTaggedAudit | null {
    // An admin's token acting for a session is never refused, but the tag it adds is audited (the T-483 shape).
    const forSession = caller.kind === 'token' && w.session !== null;
    if (caller.kind !== 'agent' && !forSession) return null;
    const allowedTags = this.#allowedAssignTags();
    const d = canAgentTagChecklist({ callerKind: caller.kind, tagsBefore: facts.tagsBefore, tagsAfter: facts.tagsAfter, allowedTags });
    if (d.allow) {
      if (!forSession || !facts.tagsAfter.includes(OWNER_CHECKLIST_TAG) || facts.tagsBefore.includes(OWNER_CHECKLIST_TAG)) return null;
      return {
        action: facts.action,
        actor: w.actor,
        sessionId: w.session?.id ?? null,
        leadId: w.session?.parentId ?? null,
        allowedTag: facts.tagsAfter.find((t) => allowedTags.includes(t)) ?? null,
      };
    }
    this.onAudit?.({
      kind: 'ticket.agent_checklist_refused',
      actor: w.actor,
      actorLabel: null,
      userId: FOUNDING_USER_ID,
      subject: facts.ticketId ? `ticket:${facts.ticketId}` : null,
      detail: {
        ticketId: facts.ticketId,
        action: facts.action,
        sessionId: w.session?.id ?? null,
        leadId: w.session?.parentId ?? null,
        tags: [...facts.tagsAfter],
        allowedTags,
        why: d.why,
      },
    });
    throw new AppError('FORBIDDEN', D62_CHECKLIST_REFUSAL);
  }

  /** The audit row for an owner-checklist tag an admin's token added for a session (ids and the allowing tag; no ticket text). Called after the write. */
  #auditChecklistTagged(a: ChecklistTaggedAudit | null, ticketId: string) {
    if (!a) return;
    this.onAudit?.({
      kind: 'ticket.agent_checklist_tagged',
      actor: a.actor,
      actorLabel: null,
      userId: FOUNDING_USER_ID,
      subject: `ticket:${ticketId}`,
      detail: { ticketId, action: a.action, actorKind: 'token', sessionId: a.sessionId, leadId: a.leadId, allowedTag: a.allowedTag },
    });
  }

  /** The audit row for an allowed assignment to a person (ids, actor kind and the allowing tag; no ticket text). Called after the write. */
  #auditAssignedPerson(a: AssignedPersonAudit | null, ticketId: string) {
    if (!a) return;
    this.onAudit?.({
      kind: 'ticket.agent_assigned_person',
      actor: a.actor,
      actorLabel: null,
      userId: FOUNDING_USER_ID,
      subject: `ticket:${ticketId}`,
      detail: { ticketId, action: a.action, actorKind: a.actorKind, sessionId: a.sessionId, leadId: a.leadId, allowedTag: a.allowedTag },
    });
  }

  /** FR20: the queue is protected from a looping agent. */
  #createLimit(caller: Caller) {
    if (caller.kind === 'ui' || caller.kind === 'system' || caller.kind === 'trigger') return; // a trigger has its own limits
    const ref = caller.kind === 'agent' ? reporterRef(caller) : caller.tokenId;
    const since = new Date(this.#now().getTime() - HOUR_MS).toISOString();
    const recent = (
      this.#db
        .prepare("SELECT count(*) AS n FROM tickets WHERE reporter_kind = 'token' AND reporter_ref = ? AND created_at > ?")
        .get(ref, since) as { n: number }
    ).n;
    if (recent >= CREATE_PER_HOUR)
      throw new AppError(
        'RATE_LIMITED',
        `${caller.kind === 'agent' ? 'This session' : 'This token'} has made ${CREATE_PER_HOUR} tickets in the last hour. Wait, or ask a person to look at the queue.`,
      );
    if (caller.kind === 'agent') {
      const mine = this.#inWorkspace('workspace_id', caller.workspaceId);
      const open = (
        this.#db
          .prepare(`SELECT count(*) AS n FROM tickets WHERE source = 'agent' AND ${mine.sql} AND status IN (${OPEN_SQL})`)
          .get(...mine.args) as { n: number }
      ).n;
      let cap = OPEN_PER_WORKSPACE;
      try {
        cap = this.#agentOpenPerWorkspace();
      } catch {
        // the setting could not be read: the built-in cap holds
      }
      if (open >= cap)
        throw new AppError('RATE_LIMITED', `${caller.workspaceId} already has ${cap} open tickets made by agents. Close some first.`);
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
    const assignedAudit = this.#assertAgentAssign(caller, w, {
      ticketId: null,
      action: 'create',
      assigneeAfter: assignee?.kind ?? null,
      assignsUser: assignee?.kind === 'user',
      tagsBefore: [],
      tagsAfter: tags,
    });
    const checklistAudit = this.#assertAgentChecklist(caller, w, { ticketId: null, action: 'create', tagsBefore: [], tagsAfter: tags });
    // An agent's ticket concerns its own workspace; a session assignee's workspace is where the work is.
    let workspaceId = caller.kind === 'agent' ? caller.workspaceId : workspaceIdOf(req.workspaceId);
    if (assignee?.kind === 'session') workspaceId = assignee.session.workspaceId;
    const source = caller.kind === 'ui' ? 'human' : caller.kind === 'system' || caller.kind === 'trigger' ? 'system' : 'agent';
    const reporter =
      caller.kind === 'ui'
        ? { kind: 'ui' as const, ref: null, label: 'Admin', workspace: null }
        : caller.kind === 'system'
          ? { kind: 'system' as const, ref: null, label: 'Portal', workspace: null }
          : caller.kind === 'trigger'
            ? { kind: 'system' as const, ref: null, label: cleanText(w.label, 60), workspace: null }
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
        .run(
          type,
          priority,
          RANK[priority],
          summary,
          description,
          source,
          reporter.kind,
          reporter.ref,
          reporter.label,
          reporter.workspace,
          assignee ? assignee.kind : null,
          assignee ? (assignee.kind === 'session' ? assignee.session.id : assignee.name) : null,
          this.#stored(workspaceId),
          at,
          at,
        );
      const n = Number(r.lastInsertRowid);
      this.#setTags(n, tags);
      this.#addEvent(n, 'created', w, null, { type, priority, tags, workspaceId, source });
      if (assignee)
        this.#addEvent(n, 'assigned', w, null, {
          from: null,
          to: assignee.kind === 'session' ? { kind: 'session', sessionId: assignee.session.id } : { kind: 'user', name: assignee.name },
        });
      return n;
    });
    this.#auditAssignedPerson(assignedAudit, ticketIdOf(number));
    this.#auditChecklistTagged(checklistAudit, ticketIdOf(number));
    this.onChange?.();
    return this.#items([this.#row(number)!])[0]!;
  }

  update(caller: Caller, id: string, req: Partial<UpdateTicketRequest>, opts: { sessionId?: string | null } = {}): TicketItem {
    const row = this.#need(caller, id); // visibility first: a ticket it can't see doesn't exist for it
    const w = this.#writer(caller, opts.sessionId);
    let grant: EndedGrant | null;
    try {
      grant = this.#assertCanModify(caller, row, w);
    } catch (e) {
      // 2026-10-18: a lead routes its crew's work (T-84 c11534: every hand-off of an unassigned ticket went through the coordinator).
      if (!this.#leadMayAssign(caller, row, w, req)) throw e;
      grant = null;
    }
    const agent = caller.kind === 'agent';
    const tags = this.#tagsOf([row.number]).get(row.number) ?? [];
    const sets: Record<string, string | number | null> = {};
    const entries: { kind: TicketEventKind; body?: string | null; data: Record<string, unknown> }[] = [];
    const next = { ...row };

    if (req.summary !== undefined) {
      const v = cleanLine(req.summary, 'summary', TICKET_LIMITS.summary);
      if (v !== row.summary)
        ((sets.summary = v), (next.summary = v), entries.push({ kind: 'summary', data: { from: row.summary, to: v } }));
    }
    if (req.description !== undefined) {
      const v = cleanMarkdown(req.description, 'description', TICKET_LIMITS.description);
      if (v !== row.description)
        ((sets.description = v),
          (next.description = v),
          entries.push({ kind: 'description', data: { from: row.description.length, to: v.length } }));
    }
    if (req.type !== undefined) {
      const v = oneOf(req.type, TICKET_TYPES, 'type');
      if (v !== row.type) ((sets.type = v), (next.type = v), entries.push({ kind: 'type', data: { from: row.type, to: v } }));
    }
    if (req.priority !== undefined) {
      const v = oneOf(req.priority, TICKET_PRIORITIES, 'priority');
      if (v !== row.priority)
        ((sets.priority = v),
          (sets.priority_rank = RANK[v]),
          (next.priority = v),
          entries.push({ kind: 'priority', data: { from: row.priority, to: v } }));
    }
    let newTags: string[] | null = null;
    if (req.tags !== undefined) {
      const v = cleanTags(req.tags);
      if ([...v].sort().join(',') !== [...tags].sort().join(','))
        ((newTags = v), entries.push({ kind: 'tags', data: { from: tags, to: v } }));
    }

    // Assignee first: it can move the status (unassigning an in-progress ticket puts it back in the queue) and the workspace.
    let status = row.status;
    let assigneeAfter = row.assignee_kind;
    let assignsUser = false;
    if (req.assignee !== undefined) {
      const a = this.#assignee(caller, req.assignee);
      const before = row.assignee_kind ? `${row.assignee_kind}:${row.assignee_ref}` : null;
      const after = a ? (a.kind === 'session' ? `session:${a.session.id}` : `user:${a.name}`) : null;
      if (before !== after) {
        assigneeAfter = a ? a.kind : null;
        assignsUser = a?.kind === 'user';
        sets.assignee_kind = a ? a.kind : null;
        sets.assignee_ref = a ? (a.kind === 'session' ? a.session.id : a.name) : null;
        entries.push({
          kind: 'assigned',
          data: {
            from: row.assignee_kind
              ? {
                  kind: row.assignee_kind,
                  ...(row.assignee_kind === 'session' ? { sessionId: row.assignee_ref } : { name: row.assignee_ref }),
                }
              : null,
            to: a ? (a.kind === 'session' ? { kind: 'session', sessionId: a.session.id } : { kind: 'user', name: a.name }) : null,
          },
        });
        if (a?.kind === 'session' && !this.#isIn(row, a.session.workspaceId))
          ((sets.workspace_id = a.session.workspaceId),
            entries.push({ kind: 'workspace', data: { from: row.workspace_id, to: a.session.workspaceId } }));
        if (!a && status === 'in_progress') status = 'open';
      }
    }
    const assignedAudit = this.#assertAgentAssign(caller, w, {
      ticketId: ticketIdOf(row.number),
      action: 'update',
      assigneeAfter,
      assignsUser,
      tagsBefore: tags,
      tagsAfter: newTags ?? tags,
    });
    const checklistAudit = this.#assertAgentChecklist(caller, w, {
      ticketId: ticketIdOf(row.number),
      action: 'update',
      tagsBefore: tags,
      tagsAfter: newTags ?? tags,
    });
    if (req.workspaceId !== undefined && !('workspace_id' in sets)) {
      if (agent) throw new AppError('FORBIDDEN', 'An agent’s tickets stay in its own workspace.');
      const v = workspaceIdOf(req.workspaceId);
      if (!this.#isIn(row, v)) ((sets.workspace_id = v), entries.push({ kind: 'workspace', data: { from: row.workspace_id, to: v } }));
    }
    if (req.status !== undefined) {
      const v = oneOf(req.status, TICKET_STATUSES, 'status');
      // The manager neither closes (done, wont_do) nor reopens through update: the same rule as close() (#11136 b, QA c691df71).
      if (caller.kind === 'token' && caller.manager && v !== row.status && (isTicketClosed(v) || isTicketClosed(row.status)))
        throw new AppError('FORBIDDEN', MANAGER_NO_CLOSE);
      if (isTicketClosed(v) && agent) throw invalid('status', 'Close a ticket with ticket_close, which records what was done.');
      if (isTicketClosed(row.status) && agent)
        throw new AppError('FORBIDDEN', `${ticketIdOf(row.number)} is closed. A person can reopen it.`);
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
      if ('workspace_id' in sets) sets.workspace_id = this.#stored(sets.workspace_id as string | null);
      const cols = Object.keys(sets);
      this.#db
        .prepare(`UPDATE tickets SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE number = ?`)
        .run(...cols.map((c) => sets[c]!), row.number);
      if (newTags) this.#setTags(row.number, newTags);
      for (const e of entries) this.#addEvent(row.number, e.kind, w, e.body ?? null, e.data);
    });
    this.#auditForEnded(grant, w, row, 'update');
    this.#auditAssignedPerson(assignedAudit, ticketIdOf(row.number));
    this.#auditChecklistTagged(checklistAudit, ticketIdOf(row.number));
    this.onChange?.();
    return this.#items([this.#row(row.number)!])[0]!;
  }

  comment(caller: Caller, id: string, text: unknown, opts: { sessionId?: string | null } = {}): TicketEvent {
    const row = this.#need(caller, id);
    const w = this.#writer(caller, opts.sessionId);
    const grant = this.#assertCanComment(caller, row, w);
    const body = cleanMarkdown(text, 'text', TICKET_LIMITS.comment, { required: true });
    const eventId = this.#tx(() => {
      this.#db.prepare('UPDATE tickets SET updated_at = ? WHERE number = ?').run(this.#now().toISOString(), row.number);
      this.#addEvent(row.number, 'comment', w, body, w.session ? { session: w.session.id } : null);
      return Number((this.#db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    });
    this.#auditForEnded(grant.ended, w, row, 'comment');
    this.#auditWorkerComment(grant.worker, w, row);
    this.onChange?.();
    return this.#events(row.number).find((e) => e.id === eventId)!;
  }

  close(caller: Caller, id: string, req: Partial<CloseTicketRequest> = {}, opts: { sessionId?: string | null } = {}): TicketItem {
    const row = this.#need(caller, id);
    // A manager is not a QA session: QA closes on its pass (general-manager PRD §9.4, #11136 b). After #need, so a missing ticket stays NOT_FOUND.
    if (caller.kind === 'token' && caller.manager) throw new AppError('FORBIDDEN', MANAGER_NO_CLOSE);
    const w = this.#writer(caller, opts.sessionId);
    const grant = this.#assertCanModify(caller, row, w);
    if (isTicketClosed(row.status)) throw new AppError('CONFLICT', `${ticketIdOf(row.number)} is already closed.`);
    const outcome = req.outcome === undefined ? 'done' : oneOf(req.outcome, TICKET_CLOSED_STATUSES, 'outcome');
    const summary = cleanMarkdown(req.summary, 'summary', TICKET_LIMITS.closing, {
      required: caller.kind === 'token' || caller.kind === 'agent',
    });
    const at = this.#now().toISOString();
    this.#tx(() => {
      this.#db
        .prepare('UPDATE tickets SET status = ?, closed_at = ?, closing_summary = ?, updated_at = ? WHERE number = ?')
        .run(outcome, at, summary || null, at, row.number);
      this.#addEvent(row.number, 'closed', w, summary || null, {
        from: row.status,
        to: outcome,
        ...(w.session ? { session: w.session.id } : {}),
      });
    });
    this.#auditForEnded(grant, w, row, 'close');
    this.onChange?.();
    return this.#items([this.#row(row.number)!])[0]!;
  }

  /**
   * FR13: hands the most urgent claimable ticket to a session. Claimable: open, unassigned, visible to the caller, in
   * the session's workspace or the shared queue, and not an approval (a person answers those). All the tags asked for,
   * one of the types asked for; most urgent first, then oldest. One transaction, so two callers never get the same one.
   * T-1069: a ticket NAMED by `id` may also be claimed while unassigned in progress, in review or blocked (a lane delivered it and nobody
   * holds it: its lead could neither post the lane's verdict nor pass it on, 2026-10-17); its status stays as it is.
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
        wantedNumber !== null ? "t.status IN ('open', 'in_progress', 'in_review', 'blocked')" : "t.status = 'open'",
        't.assignee_kind IS NULL',
        "t.type <> 'approval'",
      ];
      const args: (string | number)[] = [];
      const mine = this.#inWorkspace('t.workspace_id', session.workspaceId);
      where.push(`(t.workspace_id IS NULL OR ${mine.sql})`);
      args.push(...mine.args);
      if (wantedNumber !== null) (where.push('t.number = ?'), args.push(wantedNumber));
      for (const tag of tags)
        (where.push('EXISTS (SELECT 1 FROM ticket_tags g WHERE g.ticket_number = t.number AND g.tag = ?)'), args.push(tag));
      if (types.length) (where.push(`t.type IN (${types.map(() => '?').join(',')})`), args.push(...types));
      const row = this.#keyed(
        this.#db
          .prepare(
            `SELECT t.* FROM tickets t WHERE ${where.join(' AND ')} ORDER BY t.priority_rank ASC, t.created_at ASC, t.number ASC LIMIT 1`,
          )
          .get(...args) as unknown as Row | undefined,
      );
      if (!row) return null;
      const at = this.#now().toISOString();
      const status = row.status === 'open' ? 'in_progress' : row.status;
      this.#db
        .prepare('UPDATE tickets SET assignee_kind = ?, assignee_ref = ?, status = ?, workspace_id = ?, updated_at = ? WHERE number = ?')
        .run('session', session.id, status, this.#stored(session.workspaceId), at, row.number);
      this.#addEvent(row.number, 'assigned', w, null, { from: null, to: { kind: 'session', sessionId: session.id }, claimed: true });
      if (status !== row.status) this.#addEvent(row.number, 'status', w, null, { from: row.status, to: status });
      if (!this.#isIn(row, session.workspaceId))
        this.#addEvent(row.number, 'workspace', w, null, { from: row.workspace_id, to: session.workspaceId });
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
    const ids = [refs.branch ? parseTicketBranch(refs.branch) : null, ...(refs.message ? parseTicketTrailers(refs.message) : [])].filter(
      (x): x is string => !!x,
    );
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
  attachCheck(
    id: string,
    check: { name: string; state: TicketCheckState; runId?: string | null; commit?: string | null; link?: string | null },
    by: { actor: string; label?: string },
  ): TicketCheck | null {
    const n = parseTicketId(id);
    const row = n === null ? undefined : this.#row(n);
    if (!row) return null;
    if (!/^[a-z][a-z0-9-]{1,24}:[A-Za-z0-9._~:-]{1,80}$/.test(by.actor)) throw invalid('actor', 'An actor is like ci:<run id>.');
    const name = cleanLine(check.name, 'name', 60);
    if (!(TICKET_CHECK_STATES as readonly string[]).includes(check.state))
      throw invalid('state', `Use one of: ${TICKET_CHECK_STATES.join(', ')}.`);
    const runId = check.runId ? cleanLine(check.runId, 'runId', 80) : null;
    const commit = check.commit
      ? /^[0-9a-f]{7,64}$/i.test(check.commit)
        ? check.commit.toLowerCase()
        : (() => {
            throw invalid('commit', 'A commit is 7 to 64 hex digits.');
          })()
      : null;
    const link = check.link
      ? CHECK_LINK.test(check.link) && !/(^|\/)\.\.(\/|$)/.test(check.link)
        ? check.link
        : (() => {
            throw invalid('link', 'A link is an http(s) address or a portal page like /admin/ci/runs/41.');
          })()
      : null;
    const label = cleanLine(by.label ?? 'CI', 'label', 40);
    const before = this.#db.prepare('SELECT state FROM ticket_checks WHERE ticket_number = ? AND name = ?').get(row.number, name) as
      { state: TicketCheckState } | undefined;
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
        this.#addEvent(row.number, 'ci', { actor: by.actor, label }, null, {
          name,
          state: check.state,
          from: before?.state ?? null,
          runId,
          commit,
          link,
        });
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

  /* ---------- Verdicts (FR36, T-325 S1) ---------- */

  /**
   * The sessions whose work a ticket's verdict would judge (`authors`) and the sessions that lead them (`leads`): the holder and its
   * lineage, every session that was ever assigned the ticket, and every session started on it, and the parents of all of those.
   */
  #workers(row: Row): { authors: Set<string>; leads: Set<string>; leadHolders: Set<string> } {
    const authors = new Set<string>();
    const holderLine: string[] = [];
    const holder = row.assignee_kind === 'session' && row.assignee_ref ? this.sessions.get(row.assignee_ref) : null;
    if (row.assignee_kind === 'session' && row.assignee_ref) {
      holderLine.push(row.assignee_ref);
      if (holder) holderLine.push(...this.#ancestors(holder));
      for (const a of holderLine) authors.add(a);
    }
    const assigned = this.#db
      .prepare("SELECT DISTINCT json_extract(data, '$.to.sessionId') AS s FROM ticket_events WHERE ticket_number = ? AND kind = 'assigned'")
      .all(row.number) as { s: string | null }[];
    for (const r of assigned) if (r.s) authors.add(r.s);
    for (const s of this.sessions.list({ ticketId: ticketIdOf(row.number) })) authors.add(s.id);
    const leads = new Set<string>();
    for (const id of authors) {
      const p = this.sessions.get(id)?.parentId;
      if (p) leads.add(p);
    }
    // T-325 S1b: the holder (with its lineage) may be a verifier's ancestor only when it leads the work: it is the parent of another author
    // and was not itself started on this ticket. An implementer holding the ticket leads nobody, so a QA it spawns is refused.
    const leadsWork = !!row.assignee_ref && leads.has(row.assignee_ref) && holder?.ticketId !== ticketIdOf(row.number);
    return { authors, leads, leadHolders: new Set(leadsWork ? holderLine : []) };
  }

  /** A session's spawn chain, nearest first: its parent and the session it continues, then theirs (bounded, cycle safe). Not the session itself. */
  #spawnChain(s: TicketSessionInfo): string[] {
    const out: string[] = [];
    const seen = new Set<string>([s.id]);
    let frontier: TicketSessionInfo[] = [s];
    while (frontier.length && out.length < 200) {
      const next: TicketSessionInfo[] = [];
      for (const cur of frontier) {
        for (const up of [cur.parentId, cur.continuedFrom]) {
          if (!up || seen.has(up)) continue;
          seen.add(up);
          out.push(up);
          const info = this.sessions.get(up);
          if (info) next.push(info);
        }
      }
      frontier = next;
    }
    return out;
  }

  /**
   * Records a QA or review verdict on ONE full commit. Refused by `canRecordVerdict` (the author, the lead, anything but a QA/review session
   * or a person); a ticket the caller cannot see is the same not found. Rows are never edited: the latest verdict of a role on a commit wins.
   * Writes a timeline entry and an audit row `ticket.verdict`.
   */
  recordVerdict(
    caller: Caller,
    id: string,
    req: { role?: unknown; verdict?: unknown; commit?: unknown },
    opts: { sessionId?: string | null } = {},
  ): StoredVerdict {
    this.#assertWrites(caller);
    const row = this.#need(caller, id);
    const role = oneOf(req.role, VERDICT_ROLES, 'role');
    const verdict = oneOf(req.verdict, VERDICTS, 'verdict');
    const commit = normalizeSha(req.commit);
    const w = this.#writer(caller, opts.sessionId);
    // An admin's token acting "for" a session is not that session: only the agent's own token or a person may record.
    const { authors, leads, leadHolders } = this.#workers(row);
    const self = caller.kind === 'agent' && w.session ? w.session : null;
    const d = canRecordVerdict({
      callerKind: caller.kind,
      role,
      session: self ? { id: self.id, agent: self.agent } : null,
      authors,
      leads,
      commit,
      chain: self ? this.#spawnChain(self) : [],
      leadHolders,
    });
    const ticketId = ticketIdOf(row.number);
    if (!d.allow) {
      this.onAudit?.({
        kind: 'ticket.verdict_refused',
        actor: w.actor,
        actorLabel: null,
        userId: FOUNDING_USER_ID,
        subject: `ticket:${ticketId}`,
        detail: { ticketId, role, why: d.why, sessionId: w.session?.id ?? null },
      });
      throw new AppError(
        d.why === 'bad_commit' ? 'VALIDATION_FAILED' : 'FORBIDDEN',
        VERDICT_REFUSAL_TEXT[d.why],
        d.why === 'bad_commit' ? { details: { commit: VERDICT_REFUSAL_TEXT.bad_commit } } : undefined,
      );
    }
    const at = this.#now().toISOString();
    const stored = this.#tx(() => {
      this.#db
        .prepare(
          'INSERT INTO ticket_verdicts (ticket_number, role, verdict, commit_sha, actor, actor_label, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(row.number, role, verdict, commit!, w.actor, w.label, at);
      const vid = Number((this.#db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
      this.#db.prepare('UPDATE tickets SET updated_at = ? WHERE number = ?').run(at, row.number);
      this.#addEvent(
        row.number,
        'comment',
        w,
        `${role === 'qa' ? 'QA' : 'Review'} ${verdict.toUpperCase()} recorded on commit ${commit}.`,
        { verdict, role, commit, verdictId: vid },
      );
      return { id: vid, role, verdict, commit: commit!, actor: w.actor, at } satisfies StoredVerdict;
    });
    this.onAudit?.({
      kind: 'ticket.verdict',
      actor: w.actor,
      actorLabel: null,
      userId: FOUNDING_USER_ID,
      subject: `ticket:${ticketId}`,
      detail: { ticketId, role, verdict, commit, sessionId: w.session?.id ?? null },
    });
    this.onChange?.();
    return stored;
  }

  /** Every verdict on a ticket, oldest first. A ticket the caller cannot see: not found. */
  verdicts(caller: Caller, id: string): StoredVerdict[] {
    const row = this.#need(caller, id);
    return (
      this.#db
        .prepare('SELECT id, role, verdict, commit_sha, actor, at FROM ticket_verdicts WHERE ticket_number = ? ORDER BY id')
        .all(row.number) as { id: number; role: VerdictRole; verdict: Verdict; commit_sha: string; actor: string; at: string }[]
    ).map((v) => ({ id: v.id, role: v.role, verdict: v.verdict, commit: v.commit_sha, actor: v.actor, at: v.at }));
  }

  /** Whether `head` (a full sha) is passing now: each needed role's latest verdict ON THAT COMMIT is a pass. An older commit's verdict never counts. */
  verdictStatus(caller: Caller, id: string, head: string, need: readonly VerdictRole[] = ['qa']): VerdictEvaluation {
    const sha = normalizeSha(head);
    if (!sha) throw invalid('commit', VERDICT_REFUSAL_TEXT.bad_commit);
    return evaluateVerdicts(this.verdicts(caller, id), sha, need);
  }

  /* ---------- Sessions ---------- */

  /**
   * FR15 (people only): creates a session for the ticket, assigns it and moves it to in progress, then sends the ticket
   * as the opening message from `ticket:<id>`. The assignment lands before the message, so the agent's first tool call
   * already finds the ticket assigned to it.
   */
  async startSession(caller: Caller, id: string, req: Partial<StartTicketSessionRequest>): Promise<StartTicketSessionResult> {
    // A person, or an admin's token (not an agent's: an agent can't start sessions) when session control is on.
    if (!(caller.kind === 'ui' || caller.kind === 'trigger' || (caller.kind === 'token' && caller.scope === 'admin')))
      throw new AppError('FORBIDDEN', 'Only a person starts a session for a ticket.');
    const row = this.#need(caller, id);
    if (isTicketClosed(row.status)) throw new AppError('CONFLICT', `${ticketIdOf(row.number)} is closed. Reopen it first.`);
    const workspaceId = typeof req.workspaceId === 'string' ? req.workspaceId.trim() : '';
    if (!workspaceId) throw invalid('workspaceId', 'Pick a workspace.');
    const ticketId = ticketIdOf(row.number);
    const worktree = req.worktree === true ? {} : req.worktree && typeof req.worktree === 'object' ? req.worktree : undefined;
    const title = `${ticketId}: ${row.summary}`.slice(0, 80);
    const session = await this.sessions.create({
      ticketId,
      workspaceId,
      claudeId: req.claudeId,
      cwd: req.cwd,
      title,
      worktree,
      ...(caller.kind === 'trigger' ? { actor: `portal:trigger-${caller.triggerId}` } : {}),
    });

    const w: Writer = { ...this.#writer(caller), session: null };
    this.#tx(() => {
      const cur = this.#row(row.number)!;
      const at = this.#now().toISOString();
      const sets: Record<string, string | number | null> = {
        assignee_kind: 'session',
        assignee_ref: session.id,
        status: 'in_progress',
        workspace_id: this.#stored(session.workspaceId),
        updated_at: at,
      };
      if (session.worktree) ((sets.worktree_branch = session.worktree.branch), (sets.worktree_path = session.worktree.path));
      const cols = Object.keys(sets);
      this.#db
        .prepare(`UPDATE tickets SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE number = ?`)
        .run(...cols.map((c) => sets[c]!), row.number);
      this.#addEvent(row.number, 'session_started', w, null, {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        worktree: session.worktree,
      });
      if (cur.assignee_kind !== 'session' || cur.assignee_ref !== session.id)
        this.#addEvent(row.number, 'assigned', w, null, {
          from: cur.assignee_kind
            ? {
                kind: cur.assignee_kind,
                ...(cur.assignee_kind === 'session' ? { sessionId: cur.assignee_ref } : { name: cur.assignee_ref }),
              }
            : null,
          to: { kind: 'session', sessionId: session.id },
        });
      if (cur.status !== 'in_progress') this.#addEvent(row.number, 'status', w, null, { from: cur.status, to: 'in_progress' });
      if (!this.#isIn(cur, session.workspaceId))
        this.#addEvent(row.number, 'workspace', w, null, { from: cur.workspace_id, to: session.workspaceId });
    });
    this.onChange?.();

    const item = this.#items([this.#row(row.number)!])[0]!;
    try {
      // The transcript names the sender by the ticket's number ("From ticket T-1"); the ticket's words are in the message itself.
      await this.sessions.send(session.id, ticketId, openingMessage(item, session.id), ticketId);
    } catch (e) {
      const message = cleanText((e as Error).message, 300);
      this.#tx(() =>
        this.#addEvent(
          row.number,
          'comment',
          { actor: 'system', label: 'Portal' },
          `The session started, but its opening message could not be sent: ${message}. Send it a message by hand.`,
          null,
        ),
      );
      this.onChange?.();
      throw e instanceof AppError
        ? e
        : new AppError('SERVICE_UNAVAILABLE', `The session started, but the ticket could not be sent to it: ${message}`);
    }
    return { ticket: this.#items([this.#row(row.number)!])[0]!, session: this.#sessionView(this.sessions.get(session.id) ?? session) };
  }

  /* ---------- Bump (FR28 to FR32) ---------- */

  /** Who may bump: a person, or an admin's token of operate or admin scope (a script). Never an agent, a trigger or a read token. */
  #assertCanBump(caller: Caller) {
    if (caller.kind === 'ui') return;
    if (caller.kind === 'token') return this.#assertWrites(caller);
    throw new AppError('FORBIDDEN', 'Only a person, or a script with an operate token, bumps a ticket into a session.');
  }

  /**
   * The sessions a ticket can be bumped into (FR28): its assigned session first (with the reason when it can't take it), then the live
   * sessions of its workspace (any workspace's for the shared queue), each with its state, title and, when it can't, why.
   */
  bumpTargets(caller: Caller, id: string): BumpTarget[] {
    this.#assertCanBump(caller);
    const row = this.#need(caller, id);
    const preferred = row.assignee_kind === 'session' ? this.sessions.get(row.assignee_ref!) : null;
    const all = this.sessions.list(row.workspace_id ? { workspaceId: row.workspace_id } : {});
    return targetsFor(all, { workspaceId: this.#bumpWorkspace(row), preferred });
  }

  /** FR30: a ticket isn't bumped more than 10 times an hour, a session doesn't get more than 20 bumps an hour. */
  #bumpLimit(number: number, sessionId: string) {
    const since = new Date(this.#now().getTime() - HOUR_MS).toISOString();
    const ticket = (
      this.#db
        .prepare("SELECT count(*) AS n FROM ticket_events WHERE ticket_number = ? AND kind = 'bumped' AND at > ?")
        .get(number, since) as { n: number }
    ).n;
    if (ticket >= BUMP_PER_HOUR_TICKET)
      throw new AppError('RATE_LIMITED', `${ticketIdOf(number)} was bumped ${BUMP_PER_HOUR_TICKET} times in the last hour. Wait a little.`);
    const session = (
      this.#db
        .prepare("SELECT count(*) AS n FROM ticket_events WHERE kind = 'bumped' AND json_extract(data, '$.sessionId') = ? AND at > ?")
        .get(sessionId, since) as { n: number }
    ).n;
    if (session >= BUMP_PER_HOUR_SESSION)
      throw new AppError('RATE_LIMITED', `That session got ${BUMP_PER_HOUR_SESSION} bumps in the last hour. Let it work.`);
  }

  /**
   * FR28: pushes the ticket into a running session. `prioritise`: the ticket is assigned to the session and set in progress, and the
   * message goes in with the queue priority `next` (it steers the running turn). `ask`: nothing about the ticket changes, the message
   * waits for the running turn (`later`) and asks for an answer by ticket_comment, which the session may then write (FR29). Either way
   * the timeline gets a `bumped` entry first, then the message is sent from `ticket:<id>`; a send that fails leaves a note and says so.
   * The routes and the tool check the seam (operate on the ticket and on the session) before this.
   */
  async bump(caller: Caller, id: string, req: Partial<BumpRequest>): Promise<TicketBumpResult> {
    this.#assertCanBump(caller);
    const row = this.#need(caller, id);
    const ticketId = ticketIdOf(row.number);
    if (isTicketClosed(row.status)) throw new AppError('CONFLICT', `${ticketId} is closed. Reopen it first.`);
    const mode = bumpMode(req.mode);
    const note = bumpNote(req.note);
    const sessionId = typeof req.sessionId === 'string' ? req.sessionId.trim() : '';
    if (!sessionId) throw invalid('sessionId', 'Pick a session.');
    const session = this.sessions.get(sessionId);
    if (!session) throw invalid('sessionId', 'No such session.');
    assertBumpable(session, this.#bumpWorkspace(row));
    const w = this.#writer(caller);

    this.#tx(() => {
      this.#bumpLimit(row.number, session.id);
      const cur = this.#row(row.number)!;
      const at = this.#now().toISOString();
      if (mode === 'prioritise') {
        this.#db
          .prepare(
            "UPDATE tickets SET assignee_kind = 'session', assignee_ref = ?, status = 'in_progress', workspace_id = ?, updated_at = ? WHERE number = ?",
          )
          .run(session.id, session.workspaceId, at, row.number);
        if (cur.assignee_kind !== 'session' || cur.assignee_ref !== session.id)
          this.#addEvent(row.number, 'assigned', w, null, {
            from: cur.assignee_kind
              ? {
                  kind: cur.assignee_kind,
                  ...(cur.assignee_kind === 'session' ? { sessionId: cur.assignee_ref } : { name: cur.assignee_ref }),
                }
              : null,
            to: { kind: 'session', sessionId: session.id },
          });
        if (cur.status !== 'in_progress') this.#addEvent(row.number, 'status', w, null, { from: cur.status, to: 'in_progress' });
        if (cur.workspace_id !== session.workspaceId)
          this.#addEvent(row.number, 'workspace', w, null, { from: cur.workspace_id, to: session.workspaceId });
      } else this.#db.prepare('UPDATE tickets SET updated_at = ? WHERE number = ?').run(at, row.number);
      this.#addEvent(row.number, 'bumped', w, note || null, { sessionId: session.id, sessionTitle: cleanText(session.title, 80), mode });
    });
    this.onChange?.();

    const item = this.#items([this.#row(row.number)!])[0]!;
    const by = caller.kind === 'token' ? `The MCP client “${cleanText(caller.label, 60)}”` : 'A person in the portal';
    try {
      await this.sessions.send(
        session.id,
        ticketId,
        bumpTicketMessage(item, { mode, by, note, sessionId: session.id, link: this.#link(ticketId) }),
        ticketId,
        { priority: BUMP_PRIORITY[mode] },
      );
    } catch (e) {
      const message = cleanText((e as Error).message, 300);
      this.#tx(() =>
        this.#addEvent(
          row.number,
          'comment',
          { actor: 'system', label: 'Portal' },
          `The bump could not be sent to the session: ${message}. Send it a message by hand.`,
          null,
        ),
      );
      this.onChange?.();
      throw e instanceof AppError ? e : new AppError('SERVICE_UNAVAILABLE', `The bump could not be sent to the session: ${message}`);
    }
    this.onAudit?.({
      kind: 'ticket.bumped',
      actor: w.actor,
      actorLabel: caller.kind === 'token' ? caller.label : null,
      userId: FOUNDING_USER_ID,
      subject: `ticket:${ticketId}`,
      detail: { ticketId, sessionId: session.id, mode, note: note.length > 0 },
    });
    return {
      ticket: this.#items([this.#row(row.number)!])[0]!,
      session: this.#sessionView(this.sessions.get(session.id) ?? session),
      mode,
    };
  }

  /**
   * T-546: the latest comment a session wrote on any ticket: the ticket and the comment's id (what a lead's crew digest points to for the
   * worker's full report), or null. A fact for the portal's own digest, not a read for a caller: it carries no text.
   */
  latestCommentOf(sessionId: string): { ticket: string; comment: number } | null {
    const r = this.#db
      .prepare(
        "SELECT id, ticket_number AS number FROM ticket_events WHERE kind = 'comment' AND json_extract(data, '$.session') = ? ORDER BY id DESC LIMIT 1",
      )
      .get(sessionId) as { id: number; number: number } | undefined;
    return r ? { ticket: ticketIdOf(r.number), comment: r.id } : null;
  }

  /** FR31: the tickets bumped into a session, the latest bump of each, newest first (the session page's chips). */
  bumpedInto(caller: Caller, sessionId: string): TicketBumped[] {
    const rows = this.#db
      .prepare(
        "SELECT e.ticket_number AS number, e.at AS at, e.data AS data FROM ticket_events e WHERE e.kind = 'bumped' AND json_extract(e.data, '$.sessionId') = ? ORDER BY e.id DESC LIMIT 100",
      )
      .all(sessionId) as { number: number; at: string; data: string }[];
    const out: TicketBumped[] = [];
    for (const r of rows) {
      if (out.some((b) => b.ticketId === ticketIdOf(r.number))) continue;
      const t = this.#row(r.number);
      if (!t || !this.#visible(caller, t)) continue;
      let mode: TicketBumped['mode'] = 'ask';
      try {
        mode = (JSON.parse(r.data) as { mode?: string }).mode === 'prioritise' ? 'prioritise' : 'ask';
      } catch {
        // an unreadable entry still shows, as a question
      }
      out.push({ ticketId: ticketIdOf(r.number), summary: t.summary, status: t.status, mode, at: r.at });
      if (out.length >= 10) break;
    }
    return out;
  }

  /* ---------- Tickets follow the track (T-270) ---------- */

  /** The unfinished tickets `from` holds, oldest first. */
  #heldBy(from: string): Row[] {
    return (
      this.#db
        .prepare(`SELECT * FROM tickets WHERE assignee_kind = 'session' AND assignee_ref = ? AND status IN (${OPEN_SQL}) ORDER BY number`)
        .all(from) as unknown as Row[]
    ).map((r) => this.#keyed(r));
  }

  /**
   * A continuation was created (chat controller `continueTickets`, inside its transaction): every unfinished ticket held by the ENDED
   * sessions of `from` (the predecessor and its ended predecessors) is assigned to `to`, an `assigned` entry each (actor system,
   * `continued: true`, as migration 772 wrote them), status kept. A `from` that is not ended, or in another workspace, is skipped.
   * Closed tickets keep their assignee: that is who did the work. Returns the ticket ids moved.
   */
  continueFrom(to: string, from: readonly string[]): string[] {
    const head = this.sessions.get(to);
    if (!head || !from.length) return [];
    const w = { actor: 'system', label: 'Portal' };
    const moved = this.#tx(() => {
      const out: string[] = [];
      const at = this.#now().toISOString();
      for (const f of from) {
        const s = this.sessions.get(f);
        if (!s || s.state !== 'ended' || s.workspaceId !== head.workspaceId || f === to) continue;
        for (const r of this.#heldBy(f)) {
          this.#db.prepare('UPDATE tickets SET assignee_ref = ?, updated_at = ? WHERE number = ?').run(to, at, r.number);
          this.#addEvent(r.number, 'assigned', w, null, {
            from: { kind: 'session', sessionId: f },
            to: { kind: 'session', sessionId: to },
            continued: true,
          });
          out.push(ticketIdOf(r.number));
        }
      }
      return out;
    });
    if (moved.length) {
      this.onAudit?.({
        kind: 'ticket.continued',
        actor: 'system',
        userId: FOUNDING_USER_ID,
        subject: `session:${to}`,
        detail: { sessionId: to, fromSessions: [...from], tickets: moved },
      });
      this.onChange?.();
    }
    return moved;
  }

  /** What `ticket_adopt` would do: the rule's reason and the tickets it would move. Refused like the rule: 404, 409 live, 403 live successor. */
  adoptPlan(
    caller: Caller,
    fromSessionId: string,
    opts: { sessionId?: string | null } = {},
  ): { me: TicketSessionInfo; from: string; why: EndedGrantReason; tickets: string[] } {
    this.#assertWrites(caller);
    const w = this.#writer(caller, opts.sessionId);
    const me = this.#needSession(w, 'To adopt tickets');
    const from = typeof fromSessionId === 'string' ? this.sessions.get(fromSessionId.trim()) : null;
    // Another workspace's session doesn't exist for it, as its tickets don't.
    if (!from || from.workspaceId !== me.workspaceId) throw new AppError('NOT_FOUND', 'No such session in your workspace.');
    if (from.id === me.id) throw invalid('from_session', 'That is your own session.');
    if (from.state !== 'ended')
      throw new AppError('CONFLICT', 'That session is still live: it keeps its tickets. Ask it, or wait until it has ended.');
    const grant = this.#forEnded(me, from.id);
    if (!grant) throw new AppError('FORBIDDEN', 'A live session continues that one: its tickets are that session’s to take.');
    const tickets = this.#heldBy(from.id)
      .filter((r) => r.workspace_id === null || this.#isIn(r, me.workspaceId))
      .map((r) => ticketIdOf(r.number));
    return { me, from: from.id, why: grant.why, tickets };
  }

  /**
   * `ticket_adopt` (T-270): the calling session takes over every unfinished ticket of an ENDED session of its workspace that is in its lineage
   * or has no live successor (the FR9a rule). One `assigned` entry each (the caller, `adopted: true` and why), one audit row. Returns the ids.
   */
  adopt(
    caller: Caller,
    fromSessionId: string,
    opts: { sessionId?: string | null } = {},
  ): { tickets: string[]; why: EndedGrantReason; from: string } {
    const plan = this.adoptPlan(caller, fromSessionId, opts);
    const w = this.#writer(caller, opts.sessionId);
    const moved = this.#tx(() => {
      const out: string[] = [];
      const at = this.#now().toISOString();
      for (const r of this.#heldBy(plan.from)) {
        if (!(r.workspace_id === null || this.#isIn(r, plan.me.workspaceId))) continue;
        this.#db.prepare('UPDATE tickets SET assignee_ref = ?, updated_at = ? WHERE number = ?').run(plan.me.id, at, r.number);
        this.#addEvent(r.number, 'assigned', w, null, {
          from: { kind: 'session', sessionId: plan.from },
          to: { kind: 'session', sessionId: plan.me.id },
          adopted: true,
          why: plan.why,
        });
        out.push(ticketIdOf(r.number));
      }
      return out;
    });
    this.onAudit?.({
      kind: 'ticket.adopted',
      actor: w.actor,
      actorLabel: caller.kind === 'token' ? caller.label : null,
      userId: FOUNDING_USER_ID,
      subject: `session:${plan.from}`,
      detail: { sessionId: plan.me.id, forSession: plan.from, why: plan.why, tickets: moved },
    });
    if (moved.length) this.onChange?.();
    return { tickets: moved, why: plan.why, from: plan.from };
  }

  /* ---------- Orphans: detect and fall back (T-270 layers 2 and 3) ---------- */

  #orphanState(): { lastRunAt: string | null; dead: Record<string, string> } {
    if (this.#orphans) return this.#orphans;
    const st: { lastRunAt: string | null; dead: Record<string, string> } = { lastRunAt: null, dead: {} };
    try {
      const row = this.store.db?.prepare('SELECT value FROM portal_meta WHERE key = ?').get(ORPHAN_META) as { value: string } | undefined;
      const p = row ? (JSON.parse(row.value) as { lastRunAt?: unknown; dead?: unknown }) : null;
      if (p && typeof p.lastRunAt === 'string') st.lastRunAt = p.lastRunAt;
      if (p?.dead && typeof p.dead === 'object') for (const [k, v] of Object.entries(p.dead)) if (typeof v === 'string') st.dead[k] = v;
    } catch {
      // unreadable: start afresh (the delay starts again, nothing moves early)
    }
    return (this.#orphans = st);
  }

  #saveOrphanState() {
    if (!this.store.writable || !this.#orphans) return;
    try {
      this.#db
        .prepare('INSERT INTO portal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(ORPHAN_META, JSON.stringify(this.#orphans));
    } catch (e) {
      console.error(`[tickets] saving the orphan sweep's state failed: ${(e as Error).message}`);
    }
  }

  /** When the sweep last ran (restart safe: the loop waits for the rest of its minute). */
  orphanLastRun(): string | null {
    return this.#orphanState().lastRunAt;
  }

  #markDead(id: string, at: string) {
    const st = this.#orphanState();
    if (st.dead[id]) return;
    st.dead[id] = at;
    this.#saveOrphanState();
  }

  #markAlive(id: string) {
    const st = this.#orphans ?? (this.store.db ? this.#orphanState() : null);
    if (!st?.dead[id]) return;
    delete st.dead[id];
    this.#saveOrphanState();
  }

  /** The sessions that hold an unfinished ticket and are dead now. */
  #deadHolders(): Map<string, { s: TicketSessionInfo | null; why: TicketOrphanWhy }> {
    const out = new Map<string, { s: TicketSessionInfo | null; why: TicketOrphanWhy }>();
    const ids = this.#db
      .prepare(`SELECT DISTINCT assignee_ref AS id FROM tickets WHERE assignee_kind = 'session' AND status IN (${OPEN_SQL})`)
      .all() as { id: string }[];
    for (const { id } of ids) {
      const s = this.sessions.get(id);
      const why = deadWhy(s);
      if (why) out.set(id, { s, why });
    }
    return out;
  }

  /** The SQL for "an orphan": unfinished, held by one of the dead sessions. */
  #orphanSql(): { sql: string; args: string[] } {
    const ids = [...this.#deadHolders().keys()];
    if (!ids.length) return { sql: '0', args: [] };
    return {
      sql: `(t.assignee_kind = 'session' AND t.status IN (${OPEN_SQL}) AND t.assignee_ref IN (${ids.map(() => '?').join(', ')}))`,
      args: ids,
    };
  }

  /**
   * Who takes a dead session's ticket (T-270 layer 3a): the live session whose `continued_from` chain reaches the dead one (the nearest,
   * then the latest active), else a live session in the same workspace whose title has the same track prefix (up to its first ":"; a title
   * without one matches nothing). Only within the holder's workspace, and only when the ticket is in that workspace or the shared queue.
   */
  #successorOf(deadId: string, dead: TicketSessionInfo | null, r: Row): { s: TicketSessionInfo; reason: 'lineage' | 'title' } | null {
    const ws = dead?.workspaceId ?? r.workspace_id;
    if (!ws) return null;
    if (r.workspace_id !== null && !this.#isIn(r, ws)) return null;
    const all = this.sessions.list({ workspaceId: ws });
    const live = (x: TicketSessionInfo) => x.id !== deadId && !deadWhy(x);
    const latest = (a: TicketSessionInfo, b: TicketSessionInfo) => b.lastActivityAt.localeCompare(a.lastActivityAt);
    const seen = new Set([deadId]);
    let frontier = [deadId];
    while (frontier.length && seen.size < 500) {
      const next = all.filter((x) => x.continuedFrom && frontier.includes(x.continuedFrom) && !seen.has(x.id));
      const heir = next.filter(live).sort(latest)[0];
      if (heir) return { s: heir, reason: 'lineage' };
      for (const x of next) seen.add(x.id);
      frontier = next.map((x) => x.id);
    }
    const prefix = titlePrefix(dead?.title);
    const same = prefix ? all.filter((x) => live(x) && titlePrefix(x.title) === prefix).sort(latest)[0] : undefined;
    return same ? { s: same, reason: 'title' } : null;
  }

  /** Moves one orphan (its own transaction, checked again inside): to the successor, or back to the queue. Null when it no longer is one. */
  #fallback(number: number, deadId: string, dead: TicketSessionInfo | null, why: TicketOrphanWhy): OrphanMove | null {
    const w = { actor: 'system', label: 'Portal' };
    const move = this.#tx((): OrphanMove | null => {
      const r = this.#row(number);
      if (!r || r.assignee_kind !== 'session' || r.assignee_ref !== deadId || isTicketClosed(r.status)) return null;
      if (!deadWhy(this.sessions.get(deadId))) return null;
      const at = this.#now().toISOString();
      const from = { kind: 'session', sessionId: deadId };
      const heir = this.#successorOf(deadId, dead, r);
      if (heir) {
        this.#db.prepare('UPDATE tickets SET assignee_ref = ?, updated_at = ? WHERE number = ?').run(heir.s.id, at, number);
        this.#addEvent(number, 'assigned', w, null, {
          from,
          to: { kind: 'session', sessionId: heir.s.id },
          fallback: true,
          reason: heir.reason,
          holder: why,
        });
        return { ticketId: ticketIdOf(number), from: deadId, to: heir.s.id, reason: heir.reason, holder: why };
      }
      // Back to the agents' queue: the status stays (in_review waits for a verifier, blocked stays blocked) except in_progress, which
      // nobody is doing any more; the description and every comment stay.
      const status: TicketStatus = r.status === 'in_progress' ? 'open' : r.status;
      this.#db
        .prepare('UPDATE tickets SET assignee_kind = NULL, assignee_ref = NULL, status = ?, updated_at = ? WHERE number = ?')
        .run(status, at, number);
      this.#addEvent(number, 'assigned', w, null, { from, to: null, fallback: true, reason: 'queue', holder: why });
      if (status !== r.status) this.#addEvent(number, 'status', w, null, { from: r.status, to: status, fallback: true });
      this.#addEvent(number, 'comment', w, ORPHAN_QUEUE_COMMENT, { fallback: true });
      return { ticketId: ticketIdOf(number), from: deadId, to: null, reason: 'queue', holder: why };
    });
    if (move)
      this.onAudit?.({
        kind: 'ticket.fallback',
        actor: 'system',
        userId: FOUNDING_USER_ID,
        subject: `ticket:${move.ticketId}`,
        detail: { ticketId: move.ticketId, from: move.from, to: move.to, reason: move.reason, holder: move.holder },
      });
    return move;
  }

  /**
   * One pass of the orphan sweep (T-270): finds every unfinished ticket held by a dead session (ended, archived, missing), notes when it
   * first saw each such session dead (in `portal_meta`, so a restart neither resets nor skips the delay), and once `orphanAfterMin` has
   * passed moves its tickets (`#fallback`), at most ORPHAN_MOVES_PER_PASS. A session back to live is forgotten: nothing of it moves. It
   * creates no ticket, assigns nothing to a person, sends no notification.
   */
  sweepOrphans(opts: { max?: number } = {}): { moved: OrphanMove[]; waiting: number } {
    if (!this.store.writable || !this.store.deliveryAllowed) return { moved: [], waiting: 0 };
    const now = this.#now();
    const nowIso = now.toISOString();
    const afterMs = Math.max(0, Number(this.#orphanAfterMin()) || 0) * 60_000;
    const st = this.#orphanState();
    const dead = this.#deadHolders();
    for (const id of Object.keys(st.dead)) if (!dead.has(id)) delete st.dead[id];
    for (const id of dead.keys()) st.dead[id] ??= nowIso;
    st.lastRunAt = nowIso;
    this.#saveOrphanState();
    const max = opts.max ?? ORPHAN_MOVES_PER_PASS;
    const moved: OrphanMove[] = [];
    let waiting = 0;
    for (const [id, { s, why }] of dead) {
      const held = this.#heldBy(id);
      if (now.getTime() - Date.parse(st.dead[id]!) < afterMs) {
        waiting += held.length;
        continue;
      }
      for (const r of held) {
        if (moved.length >= max) return (moved.length && this.onChange?.(), { moved, waiting });
        try {
          const m = this.#fallback(r.number, id, s, why);
          if (m) moved.push(m);
        } catch (e) {
          console.error(`[tickets] moving ${ticketIdOf(r.number)} off an ended session failed: ${(e as Error).message}`);
        }
      }
    }
    if (moved.length) this.onChange?.();
    return { moved, waiting };
  }

  /** A session ended: any unfinished ticket assigned to it says so, once (FR18). */
  #sessionEnded(s: TicketSessionInfo) {
    if (!this.store.writable) return;
    try {
      const rows = this.#db
        .prepare(`SELECT number FROM tickets WHERE assignee_kind = 'session' AND assignee_ref = ? AND status IN (${OPEN_SQL})`)
        .all(s.id) as { number: number }[];
      let changed = false;
      // The orphan delay counts from here (T-270), not from the sweep's next look.
      if (rows.length) this.#markDead(s.id, this.#now().toISOString());
      for (const { number } of rows) {
        const last = this.#db
          .prepare(
            "SELECT kind, data FROM ticket_events WHERE ticket_number = ? AND kind IN ('session_ended', 'session_started', 'assigned') ORDER BY id DESC LIMIT 1",
          )
          .get(number) as { kind: string; data: string | null } | undefined;
        if (last?.kind === 'session_ended' && last.data?.includes(s.id)) continue;
        this.#addEvent(number, 'session_ended', { actor: 'system', label: 'Portal' }, null, {
          sessionId: s.id,
          reason: s.endedReason ? cleanText(s.endedReason, 200) : null,
        });
        changed = true;
      }
      if (changed) this.onChange?.();
    } catch (e) {
      console.error(`[tickets] noting an ended session failed: ${(e as Error).message}`);
    }
  }
}
