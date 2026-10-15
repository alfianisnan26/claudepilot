// Tickets (tickets PRD): one queue of work that people and agents share. A ticket has a type, a priority,
// a one-line summary, a Markdown description, tags and a status; it is assigned to an agent session or a
// person; every change is an entry on its timeline. The text of a ticket is untrusted input.

import type { BumpMode } from './bump.js';

export const TICKET_TYPES = ['task', 'bug', 'feature', 'question', 'request', 'incident', 'approval', 'chore'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

/** Most urgent first: this order is the queue's order. */
export const TICKET_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ['open', 'in_progress', 'blocked', 'in_review', 'done', 'wont_do'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
/** Statuses of work that isn't finished. */
export const TICKET_OPEN_STATUSES: readonly TicketStatus[] = ['open', 'in_progress', 'blocked', 'in_review'];
export const TICKET_CLOSED_STATUSES: readonly TicketStatus[] = ['done', 'wont_do'];
export const isTicketClosed = (s: TicketStatus) => s === 'done' || s === 'wont_do';

/** Who the ticket came from, which never changes: a person in the portal, an agent, or the portal itself. */
export type TicketSource = 'human' | 'agent' | 'system';

export interface TicketReporter {
  /** `ui`: a person in the portal. `token`: an agent or script through a Portal MCP token. `system`: the portal. */
  kind: 'ui' | 'token' | 'system';
  /** The token's id, for `token`. */
  ref: string | null;
  /** What to call them: "Admin", the token's label, "Portal". */
  label: string;
  /** The workspace the token is bound to, when it is. */
  workspaceId: string | null;
}

/** An agent session, or a person (a label until the portal has per-user identity). */
export type TicketAssignee = { kind: 'session'; sessionId: string } | { kind: 'user'; name: string };

export interface TicketLimits {
  summary: number;
  description: number;
  comment: number;
  closing: number;
  tags: number;
  tag: number;
}
export const TICKET_LIMITS: TicketLimits = { summary: 140, description: 20_000, comment: 8_000, closing: 2_000, tags: 10, tag: 30 };

/** A tag: lowercase letters and digits, with `.`, `_` and `-` inside. */
export const TICKET_TAG = /^[a-z0-9][a-z0-9._-]*$/;

/** The person assignee when none is named. */
export const TICKET_DEFAULT_USER = 'admin';

export interface Ticket {
  /** `T-12`. */
  id: string;
  number: number;
  type: TicketType;
  priority: TicketPriority;
  status: TicketStatus;
  summary: string;
  /** Markdown. Untrusted when it came from an agent. */
  description: string;
  tags: string[];
  source: TicketSource;
  reporter: TicketReporter;
  /** Null: nobody, so it is in the agents' queue. */
  assignee: TicketAssignee | null;
  /** Where the work happens; null for the shared queue. */
  workspaceId: string | null;
  /** The worktree a session works it in, when it has one. */
  worktree: { branch: string; path: string } | null;
  closingSummary: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export type TicketSessionState = 'starting' | 'idle' | 'working' | 'waiting' | 'interrupted' | 'ended';

/** A chat session that worked (or works) a ticket. */
export interface TicketSession {
  id: string;
  title: string;
  state: TicketSessionState;
  workspaceId: string;
  lastActivityAt: string;
  endedReason: string | null;
  worktree: { branch: string; path: string } | null;
}

/** A ticket as the list shows it: with its assignee session's state. */
export interface TicketItem extends Ticket {
  /** The assigned session, when it still exists. */
  assigneeSession: TicketSession | null;
  /** The assigned session has ended while the ticket is still open (tickets PRD FR18). */
  sessionEnded: boolean;
  /**
   * T-270 (FR18b): the ticket is unfinished and the session holding it is dead (ended, archived or gone), so nobody works it. Derived when
   * read, never stored on the ticket: the orphan sweep moves it to the track's live successor or back to the queue once
   * `tickets.orphanAfterMin` has passed since `since`. Null for every other ticket.
   */
  orphan: TicketOrphan | null;
}

/** Why the holder counts as dead: its state is `ended`, it was archived (ended and hidden), or the portal no longer has the session. */
export type TicketOrphanWhy = 'ended' | 'archived' | 'missing';

export interface TicketOrphan {
  /** When the portal saw the session dead (the end it heard of, or the sweep's first look); null until the sweep has looked. */
  since: string | null;
  sessionId: string;
  why: TicketOrphanWhy;
}

/** The tickets module's settings (the shared settings registry). */
export const TICKET_SETTING_KEYS = { orphanAfterMin: 'tickets.orphanAfterMin', agentOpenPerWorkspace: 'tickets.agentOpenPerWorkspace' } as const;

export type TicketEventKind =
  | 'created'
  | 'comment'
  | 'status'
  | 'assigned'
  | 'priority'
  | 'type'
  | 'summary'
  | 'description'
  | 'tags'
  | 'workspace'
  | 'session_started'
  | 'session_ended'
  | 'ci'
  | 'closed'
  | 'reopened'
  /** A person (or a script) pushed it into a running session (FR28): `data` `{ sessionId, sessionTitle, mode }`, `body` the note. */
  | 'bumped';

/** One entry on a ticket's timeline: who did what, when. Never edited. */
export interface TicketEvent {
  id: number;
  ticketId: string;
  at: string;
  kind: TicketEventKind;
  /** `ui`, `session:<id>`, `portal-mcp:<token id>`, `ticket:<id>` or `system`. */
  actor: string;
  /** A name for it: "Admin", a token's label, a session's title, "Portal". */
  actorLabel: string;
  /** A comment's or a closing summary's text (Markdown). */
  body: string | null;
  /** What changed: `{ from, to }`, or the facts of the event. */
  data: Record<string, unknown> | null;
  /** The actor wrote this as an agent: its text is untrusted. */
  fromAgent: boolean;
}

export interface TicketDetail {
  ticket: TicketItem;
  /** Oldest first. */
  events: TicketEvent[];
  /** Sessions whose ticket is this one, newest first. */
  sessions: TicketSession[];
  /** The checks CI attached (interface I10), one per name, by name. */
  checks: TicketCheck[];
}

/** The state of one pipeline check on a ticket. */
export const TICKET_CHECK_STATES = ['queued', 'running', 'passed', 'failed', 'cancelled'] as const;
export type TicketCheckState = (typeof TICKET_CHECK_STATES)[number];

/** A check a CI run attached to a ticket (interface I10): its latest state. */
export interface TicketCheck {
  name: string;
  state: TicketCheckState;
  /** The run it comes from. */
  runId: string | null;
  commit: string | null;
  /** Where the run is shown. */
  link: string | null;
  updatedAt: string;
}

export interface TicketCounts {
  byStatus: Record<TicketStatus, number>;
  /** Not closed and assigned to a person. */
  needsYou: number;
  /** Open and assigned to nobody: the agents' queue. */
  unassigned: number;
  /** Unfinished and held by a dead session (T-270); the sweep resolves them. Absent from an older server. */
  orphans?: number;
  total: number;
}

export interface TicketList {
  items: TicketItem[];
  /** Matching the filters. */
  total: number;
  /** Over the whole queue, ignoring filters. */
  counts: TicketCounts;
}

/** `me` is the caller's session; `user` a person; `session:<id>`; `unassigned`; `any`. */
export type TicketAssigneeFilter = 'any' | 'unassigned' | 'user' | `session:${string}`;

export interface TicketFilter {
  status?: TicketStatus[];
  priority?: TicketPriority[];
  type?: TicketType[];
  tag?: string;
  assignee?: TicketAssigneeFilter;
  workspaceId?: string;
  /** Matches summary, description and tags. */
  query?: string;
  /** Only orphans (T-270): unfinished tickets whose session is dead. */
  orphan?: boolean;
  /** Closed tickets are left out unless asked for (or `status` names one). */
  includeClosed?: boolean;
  /** `priority` (the default): the most urgent first, then the latest update. `newest`: the latest made first (the Home page). */
  sort?: 'priority' | 'newest';
  limit?: number;
  offset?: number;
}

export interface CreateTicketRequest {
  summary: string;
  description?: string;
  type?: TicketType;
  priority?: TicketPriority;
  tags?: string[];
  /** `user` for a person (label optional), a session id for an agent; omitted: the agents' queue. */
  assignee?: TicketAssignee | null;
  workspaceId?: string | null;
}

export interface UpdateTicketRequest {
  summary?: string;
  description?: string;
  type?: TicketType;
  priority?: TicketPriority;
  status?: TicketStatus;
  tags?: string[];
  assignee?: TicketAssignee | null;
  workspaceId?: string | null;
}

export interface CommentTicketRequest {
  text: string;
}

export interface CloseTicketRequest {
  /** What was done, or why not. Required for agents, optional for a person. */
  summary?: string;
  outcome?: 'done' | 'wont_do';
}

/** `POST /api/tickets/:id/session`: start a session for the ticket (tickets PRD FR15). */
export interface StartTicketSessionRequest {
  workspaceId: string;
  /** Which Claude on that workspace; the default when omitted. */
  claudeId?: string;
  /** Run it in a git worktree of its own. `true` for the defaults. */
  worktree?: boolean | { repo?: string; branch?: string; base?: string };
  /** A folder to run in (default: the workspace's work folder). */
  cwd?: string;
}

/** What starting a session returns: the ticket as it is now, and the session. */
export interface StartTicketSessionResult {
  ticket: TicketItem;
  session: TicketSession;
}

/** What a bump returns (FR28): the ticket as it is now (assigned and in progress after Prioritise; unchanged after Ask) and the session. */
export interface TicketBumpResult {
  ticket: TicketItem;
  session: TicketSession;
  mode: BumpMode;
}

/** A ticket bumped into a session, for the session page's chip (FR31): the latest bump per ticket, newest first. */
export interface TicketBumped {
  ticketId: string;
  summary: string;
  status: TicketStatus;
  mode: BumpMode;
  at: string;
}

export interface TicketTag {
  tag: string;
  count: number;
}

export const TICKET_API = {
  /** GET `TicketFilter` as a query string: `TicketList`. POST `CreateTicketRequest`: `TicketItem`. */
  list: '/api/tickets',
  /** GET: `TicketDetail`. PATCH `UpdateTicketRequest`: `TicketItem`. DELETE: remove it. */
  one: (id: string) => `/api/tickets/${encodeURIComponent(id)}`,
  /** POST `CommentTicketRequest`: the new `TicketEvent`. */
  comments: (id: string) => `/api/tickets/${encodeURIComponent(id)}/comments`,
  /** POST `CloseTicketRequest`: close it. DELETE: reopen it. */
  close: (id: string) => `/api/tickets/${encodeURIComponent(id)}/close`,
  /** POST `StartTicketSessionRequest`: `StartTicketSessionResult`. */
  session: (id: string) => `/api/tickets/${encodeURIComponent(id)}/session`,
  /** GET: `TicketTag[]`. */
  tags: '/api/tickets/tags',
  /** GET: a ticket's id, summary and status, for a session page to link to it. */
  brief: (id: string) => `/api/tickets/${encodeURIComponent(id)}/brief`,
  /** GET: the opening message a session started for it would get, as `{ text }` (tickets PRD FR15). */
  opening: (id: string) => `/api/tickets/${encodeURIComponent(id)}/opening`,
  /** GET: the sessions it can be bumped into, as `BumpTarget[]`. POST `BumpRequest`: `TicketBumpResult` (FR28). */
  bump: (id: string) => `/api/tickets/${encodeURIComponent(id)}/bump`,
  /** GET: the tickets bumped into a session, as `TicketBumped[]` (FR31). */
  bumped: (sessionId: string) => `/api/tickets/bumped?session=${encodeURIComponent(sessionId)}`,
} as const;

/** `T-12` for 12. */
export const ticketIdOf = (n: number): string => `T-${n}`;

/**
 * The ticket a git branch is for: `ticket/T-12-fix-login`, `ticket/12-fix-login` or `feature/ticket/12`
 * (interface I10: CI finds a ticket from the branch it ran on). Null when the branch names none.
 */
export function parseTicketBranch(branch: string): string | null {
  const m = /(?:^|\/)ticket\/(?:T-)?(\d{1,9})(?:[-_/]|$)/i.exec(branch.trim());
  return m ? ticketIdOf(Number(m[1])) : null;
}

/** The tickets a commit message names in `Ticket: T-12` trailers (interface I10), in order, without repeats. */
export function parseTicketTrailers(message: string): string[] {
  const ids: string[] = [];
  for (const m of message.matchAll(/^Ticket:[ \t]*(?:T-|#)?(\d{1,9})\b/gim)) {
    const id = ticketIdOf(Number(m[1]));
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The number in `T-12`, `t-12`, `#12` or `12`; null when it isn't one. */
export function parseTicketId(raw: string): number | null {
  const m = /^(?:T-|#)?(\d{1,9})$/i.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

export const TICKET_TYPE_LABEL: Record<TicketType, string> = {
  task: 'Task',
  bug: 'Bug',
  feature: 'Feature',
  question: 'Question',
  request: 'Request',
  incident: 'Incident',
  approval: 'Approval',
  chore: 'Chore',
};

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  in_review: 'In review',
  done: 'Done',
  wont_do: 'Won’t do',
};

export const TICKET_PRIORITY_LABEL: Record<TicketPriority, string> = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
