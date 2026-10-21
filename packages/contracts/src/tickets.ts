// Tickets (tickets PRD): one queue of work that people and agents share. A ticket has a type, a priority,
// a one-line summary, a Markdown description, tags and a status; it is assigned to an agent session or a
// person; every change is an entry on its timeline. The text of a ticket is untrusted input.

import type { BumpMode } from './bump.js';
import type { CursorPage } from './page.js';

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
  /** `T-12`: the ticket's stable id, kept for ever (a PERMANENT alias of its bucket key, T-1098). URLs, sessions and trailers may use either. */
  id: string;
  number: number;
  /** T-1098: the bucket it belongs to (`KONF`). Absent from an older server. */
  bucket?: string;
  /** T-1098: its id in its bucket, `KONF-12`: what the portal shows. Absent from an older server (show `id`). */
  key?: string;
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
  /**
   * D-58: set on a LIST row only. A list row holds `description` and `closingSummary` cut at {@link TICKET_LIST_TEXT} characters; these say a
   * cut happened. The full text is `GET /api/tickets/:id`. Never write a cut text back: read the detail first.
   */
  descriptionCut?: boolean;
  closingSummaryCut?: boolean;
}

/** D-58: the most characters of a ticket's description (and closing summary) a list row carries. */
export const TICKET_LIST_TEXT = 200;

/** Why the holder counts as dead: its state is `ended`, it was archived (ended and hidden), or the portal no longer has the session. */
export type TicketOrphanWhy = 'ended' | 'archived' | 'missing';

export interface TicketOrphan {
  /** When the portal saw the session dead (the end it heard of, or the sweep's first look); null until the sweep has looked. */
  since: string | null;
  sessionId: string;
  why: TicketOrphanWhy;
}

/** The tickets module's settings (the shared settings registry). */
export const TICKET_SETTING_KEYS = {
  orphanAfterMin: 'tickets.orphanAfterMin',
  agentOpenPerWorkspace: 'tickets.agentOpenPerWorkspace',
  /** D-62 (T-483): the tags that let an agent put a ticket on a person; comma separated. */
  agentAssignUserTags: 'tickets.agentAssignUserTags',
  /** FR9g (D-85): groups of lead sessions that may comment on each other's tickets: groups split by `;`, session ids by `,`. Owner only. */
  leadPeerGroups: 'tickets.leadPeerGroups',
} as const;

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
  | 'bumped'
  /** A file was attached (`data` `{ attachmentId, name, size, mediaType }`) or removed (`data` adds `removed: true`). */
  | 'attachment'
  /** T-1967: it moved to another bucket: `data` `{ from, to }`, its key before and after (the old key stays an alias). */
  | 'bucket';

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

/** T-119: a state a ticket's flow shows: its status, or `waiting` (it carries the tag `needs-a-person`). */
export type TicketFlowState = TicketStatus | 'waiting';

export interface TicketFlowActor {
  /** `ui`, `session:<id>`, `portal-mcp:<token id>`, `system`. */
  actor: string;
  label: string;
  /** The session id, when the actor is a session. */
  session: string | null;
}

/** One stretch of a ticket in one state (derived from its events: `ticketFlow`, tickets/ticketFlow.ts). A closed state ends where it starts. */
export interface TicketFlowSpan {
  state: TicketFlowState;
  /** ISO. */
  start: string;
  /** ISO; null while the span runs. */
  end: string | null;
  durationMs: number;
  /** Who moved the ticket into this state. */
  by: TicketFlowActor | null;
  reason: string | null;
}

export type TicketFlowMarkerKind = 'assigned' | 'claimed' | 'bumped' | 'comment' | 'priority' | 'tags' | 'ci' | 'waiting';

/** A point on a ticket's flow: an assignment, a claim, a bump, a person's comment, a priority or tag change, a CI result. */
export interface TicketFlowMarker {
  kind: TicketFlowMarkerKind;
  at: string;
  by: TicketFlowActor;
  detail: string | null;
}

export interface TicketFlow {
  spans: TicketFlowSpan[];
  markers: TicketFlowMarker[];
  state: TicketFlowState | null;
  /** Milliseconds per state over all spans. */
  totals: Partial<Record<TicketFlowState, number>>;
}

export interface TicketDetail {
  ticket: TicketItem;
  /** Oldest first. */
  events: TicketEvent[];
  /** Sessions whose ticket is this one, newest first. */
  sessions: TicketSession[];
  /** The checks CI attached (interface I10), one per name, by name. */
  checks: TicketCheck[];
  /** Files attached to it, oldest first. Absent from an older server. */
  attachments?: TicketAttachment[];
}

/** A file on a ticket (owner, 2026-10-17: "ticket support with attachment, all files"): any type, kept by the portal, served only to who may see the ticket. */
export interface TicketAttachment {
  /** A number, unique across tickets. */
  id: number;
  ticketId: string;
  /** The file name as uploaded (no folders). */
  name: string;
  size: number;
  /** The type the uploader gave (or `application/octet-stream`). Only a few image types are shown inline; everything else downloads. */
  mediaType: string;
  sha256: string;
  at: string;
  /** Who attached it: `ui`, `session:<id>`, `portal-mcp:<token id>`. */
  actor: string;
  actorLabel: string;
  /** The actor attached it as an agent: the file is untrusted. */
  fromAgent: boolean;
}

/** One file at most 50 MB, at most 100 files on a ticket; a name of at most 200 characters. */
export const TICKET_ATTACHMENT_LIMITS = { maxBytes: 50 * 1024 * 1024, perTicket: 100, name: 200 } as const;

/** The types shown inline (an image preview); every other type, SVG and HTML included, is served as a download. */
export const TICKET_ATTACHMENT_INLINE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** The state of one pipeline check on a ticket. */
export const TICKET_CHECK_STATES = ['queued', 'running', 'passed', 'failed', 'cancelled'] as const;
export type TicketCheckState = (typeof TICKET_CHECK_STATES)[number];

/**
 * FR36d (T-1987, D-93): the shared evidence of a verdict recorded in a batch (`ticket_verdict_batch`): the job run, the batch branch, a
 * note. Stored with each verdict of the batch and in its timeline entry (`data.batch`). Absent on a verdict recorded alone.
 */
export interface TicketVerdictBatch {
  jobId: string | null;
  branch: string | null;
  note: string | null;
}

export const TICKET_VERDICT_BATCH_LIMITS = { items: 20, jobId: 120, branch: 120, note: 500 } as const;

/**
 * A batch branch name as D-93 spells it, as a whole token: Konfersi `qa/batch-<date>-<n>`, ClaudePilot `batch/<date>-<n>`, the date
 * `YYYY-MM-DD` or `YYYYMMDD`. A remote prefix (`origin/`) is allowed; a path such as `src/batch/foo.ts` is not a batch (QA on T-1987).
 */
export const TICKET_BATCH_BRANCH = /(?:^|[^A-Za-z0-9._-])((?:qa\/batch-|batch\/)(?:\d{4}-\d{2}-\d{2}|\d{8})-\d+)(?![A-Za-z0-9_/-]|\.[A-Za-z0-9])/;

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
  /** T-1098: unfinished tickets per bucket key (only buckets that have one). Absent from an older server. */
  byBucket?: Record<string, number>;
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

/**
 * `GET /api/tickets` (D-58): one page of summary rows (descriptions cut, see `TicketItem.descriptionCut`), `next` the cursor of the following page.
 * `total` and `counts` ride on the first page only (no `cursor`); a later page leaves them out.
 */
export interface TicketPage extends CursorPage<TicketItem> {
  total?: number;
  counts?: TicketCounts;
}

/** `me` is the caller's session; `user` a person; `session:<id>`; `unassigned`; `any`. */
export type TicketAssigneeFilter = 'any' | 'unassigned' | 'user' | `session:${string}`;

export interface TicketFilter {
  /** T-1098: one bucket's tickets (its key, `KONF`). */
  bucket?: string;
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
  /** Rows per page: 25 when absent, at most 100 on the route. */
  limit?: number;
  /** In-process only (the portal MCP's own paging); the HTTP route takes `cursor`. */
  offset?: number;
  /** The route: the `next` of the page before. */
  cursor?: string;
}

export interface CreateTicketRequest {
  /**
   * T-1098: the bucket (`KONF`). Left out: the bucket whose default workspace is the ticket's (or the agent's) workspace, else the bucket of the
   * ticket the calling session or its lead works on, else {@link TICKET_DEFAULT_BUCKET}.
   */
  bucket?: string;
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
  /** T-1967: move it to another bucket (its key): it takes that bucket's next number; its old key keeps resolving. */
  bucket?: string;
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

/** T-119 S1b: the scale a timeline is asked at. */
export const TICKET_TIMELINE_GRANULARITIES = ['minute', 'hour', 'day'] as const;
export type TicketTimelineGranularity = (typeof TICKET_TIMELINE_GRANULARITIES)[number];

/**
 * The longest window a granularity may ask for (a minute scale over a long window would be thousands of columns the chart cannot show) and the
 * window it gets when `from` is absent. A longer one is a 422 (VALIDATION_FAILED) that names the limit; a bad cursor is a 400. The maxima are the ticket's (T-119): 24 hours, 14 days, 180 days.
 */
export const TICKET_TIMELINE_LIMITS: Record<TicketTimelineGranularity, { maxWindowMs: number; defaultWindowMs: number }> = {
  minute: { maxWindowMs: 24 * 3_600_000, defaultWindowMs: 6 * 3_600_000 },
  hour: { maxWindowMs: 14 * 86_400_000, defaultWindowMs: 3 * 86_400_000 },
  day: { maxWindowMs: 180 * 86_400_000, defaultWindowMs: 30 * 86_400_000 },
};

/** Rows per timeline page: 50 when absent, at most 200 (the chart asks for 200). */
export const TICKET_TIMELINE_PAGE = { defaultLimit: 50, maxLimit: 200 } as const;

/**
 * GET `/api/tickets/timeline` query: `from` and `to` are ISO times, `granularity` a {@link TicketTimelineGranularity} (default `hour`), `limit`
 * 1..200 (50), `cursor`. The filters are the list's (`bucket`, `status`, `priority`, `type`, `tag`, `assignee`, `workspace`, `q`); closed
 * tickets are in unless `status` says otherwise. A next page sends the `from` and `to` the first page answered with.
 */
export interface TicketTimelineQuery extends Pick<TicketFilter, 'bucket' | 'status' | 'priority' | 'type' | 'tag' | 'assignee' | 'workspaceId' | 'query'> {
  from?: string;
  to?: string;
  granularity?: TicketTimelineGranularity;
  limit?: number;
  cursor?: string;
}

/** Who has a timeline row's ticket, as its label column shows it (initials): a person, or a session by its title. */
export interface TicketTimelineAssignee {
  kind: 'user' | 'session';
  /** The person's name, or the session's title (`Agent gone` when it no longer exists). */
  label: string;
  /** The session id, for a session. */
  sessionId: string | null;
}

/**
 * One ticket on the timeline: a summary row and its flow. `flow.spans` and `flow.markers` are the ones that touch the window (a span that
 * overlaps it, a marker inside it); `flow.totals` and `flow.state` are over the ticket's whole life.
 */
export interface TicketTimelineRow {
  id: string;
  /** T-1098: its bucket key (`KONF-12`), what the row shows. */
  key: string;
  bucket: string;
  summary: string;
  status: TicketStatus;
  priority: TicketPriority;
  type: TicketType;
  assignee: TicketTimelineAssignee | null;
  createdAt: string;
  closedAt: string | null;
  flow: TicketFlow;
}

/** The tickets whose life overlaps the window (created before `to`, not closed before `from`), oldest number first, a page at a time. */
export interface TicketTimeline {
  /** ISO, as resolved (absent params filled in). */
  from: string;
  to: string;
  granularity: TicketTimelineGranularity;
  /** ISO: the time the open spans run to. */
  now: string;
  items: TicketTimelineRow[];
  next: string | null;
}

export const TICKET_API = {
  /** GET `TicketTimelineQuery` as a query string: `TicketTimeline` (T-119). */
  timeline: '/api/tickets/timeline',
  /** GET `TicketFilter` as a query string: `TicketList`. POST `CreateTicketRequest`: `TicketItem`. */
  list: '/api/tickets',
  /** GET: `TicketBucket[]` (the ones the caller may view). POST `CreateTicketBucketRequest`: `TicketBucket` (T-1098). */
  buckets: '/api/tickets/buckets',
  /** GET: `TicketBucket`. PATCH `UpdateTicketBucketRequest`: `TicketBucket`. */
  bucket: (key: string) => `/api/tickets/buckets/${encodeURIComponent(key)}`,
  /** POST `MergeTicketBucketRequest`: `MergeTicketBucketResult` (T-1967, owner only): every ticket of the bucket moves into `into`, then it is gone. */
  bucketMerge: (key: string) => `/api/tickets/buckets/${encodeURIComponent(key)}/merge`,
  /** POST `TicketBucketMovesRequest`: `TicketBucketMoveResult[]` (T-1967, owner only), each move on its own. */
  bucketMoves: '/api/tickets/bucket-moves',
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
  /** GET: `TicketAttachment[]`. POST the file's bytes as the body (`content-type: application/octet-stream`), its name in the `x-file-name`
   *  header (URI-encoded) and its type in `x-file-type`: the new `TicketAttachment`. */
  attachments: (id: string) => `/api/tickets/${encodeURIComponent(id)}/attachments`,
  /** GET: the file (inline for a preview image, else a download). DELETE: remove it. */
  attachment: (id: string, attachmentId: number) => `/api/tickets/${encodeURIComponent(id)}/attachments/${attachmentId}`,
  /** GET: the tickets bumped into a session, as `TicketBumped[]` (FR31). */
  bumped: (sessionId: string) => `/api/tickets/bumped?session=${encodeURIComponent(sessionId)}`,
} as const;

/** `T-12` for 12. */
export const ticketIdOf = (n: number): string => `T-${n}`;

/* ---------- Buckets (T-1098): a project of tickets with its own id prefix and number counter ---------- */

/** A bucket's key: 2 to 6 capital letters (`KONF`, `CP`). Never `T` alone, so `T-12` always names the stable id. */
export const TICKET_BUCKET_KEY = /^[A-Z]{2,6}$/;
/** Where a ticket goes when nothing names a bucket, and where the migration put every ticket without a project tag. */
export const TICKET_DEFAULT_BUCKET = 'PILOT';
/** `KONF-12`. */
export const ticketKeyOf = (bucket: string, n: number): string => `${bucket}-${n}`;

export interface TicketBucket {
  /** The id prefix, `KONF`. Fixed once made. */
  key: string;
  name: string;
  description: string;
  /** Where its tickets go when a create names no workspace; and an agent files in it only from this workspace. Null: any. */
  defaultWorkspaceId: string | null;
  /** Tags every new ticket in it gets. */
  defaultTags: string[];
  /** A knowledge vault for its notes, or null. */
  vaultId: string | null;
  /** The number its next ticket takes. */
  nextNumber: number;
  /** Its unfinished tickets. */
  open: number;
  /** T-1967: all its tickets, closed ones too (what a merge moves). Absent from an older server. */
  total?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTicketBucketRequest {
  key: string;
  name: string;
  description?: string;
  defaultWorkspaceId?: string | null;
  defaultTags?: string[];
  vaultId?: string | null;
}

export type UpdateTicketBucketRequest = Partial<Omit<CreateTicketBucketRequest, 'key'>>;

/** T-1967: merge a bucket into another; `name` and `description` rename the target as it takes them in (optional). */
export interface MergeTicketBucketRequest {
  into: string;
  name?: string;
  description?: string;
}

/** One ticket a merge or a bulk move moved: its stable id and its key before and after. */
export interface TicketBucketMove {
  id: string;
  from: string;
  to: string;
}

export interface MergeTicketBucketResult {
  bucket: TicketBucket;
  /** In creation order. */
  moved: TicketBucketMove[];
}

export interface TicketBucketMovesRequest {
  moves: { id: string; bucket: string }[];
}

/** One move of a bulk request: done (`to` is its new key; `from === to` when it was already there) or refused with why. */
export type TicketBucketMoveResult = (TicketBucketMove & { ok: true }) | { id: string; ok: false; error: string };

/**
 * What a ticket reference names: the stable id (`T-12`, `#12`, `12`) or a bucket key (`KONF-12`, any case). Null when it is neither.
 * Every place that takes a ticket id takes both (T-1098: `T-<n>` is a permanent alias).
 */
export function parseTicketRef(raw: string): { number: number } | { bucket: string; n: number } | null {
  const v = raw.trim();
  const id = /^(?:T-|#)?(\d{1,9})$/i.exec(v);
  if (id) return { number: Number(id[1]) };
  const key = /^([A-Za-z]{2,6})-(\d{1,9})$/.exec(v);
  return key ? { bucket: key[1]!.toUpperCase(), n: Number(key[2]) } : null;
}

/** A reference as one canonical string: `T-12` or `KONF-12`. Null when it is not one. */
export function normalTicketRef(raw: string): string | null {
  const r = parseTicketRef(raw);
  if (!r) return null;
  return 'number' in r ? ticketIdOf(r.number) : ticketKeyOf(r.bucket, r.n);
}

/**
 * The ticket a git branch is for: `ticket/T-12-fix-login`, `ticket/12-fix-login`, `feature/ticket/12` or `ticket/KONF-12-fix-login`
 * (interface I10: CI finds a ticket from the branch it ran on). Null when the branch names none. A bucket key comes back as it is; the tickets
 * service resolves it.
 */
export function parseTicketBranch(branch: string): string | null {
  const m = /(?:^|\/)ticket\/(?:T-)?(\d{1,9})(?:[-_/]|$)/i.exec(branch.trim());
  if (m) return ticketIdOf(Number(m[1]));
  // Capitals only (`ticket/fix-12-login` is not a bucket key).
  const k = /(?:^|\/)ticket\/([A-Z]{2,6})-(\d{1,9})(?:[-_/]|$)/.exec(branch.trim());
  return k ? ticketKeyOf(k[1]!, Number(k[2])) : null;
}

/** The tickets a commit message names in `Ticket: T-12` (or `Ticket: KONF-12`) trailers (interface I10), in order, without repeats. */
export function parseTicketTrailers(message: string): string[] {
  const ids: string[] = [];
  for (const m of message.matchAll(/^Ticket:[ \t]*(?:(?:T-|#)?(\d{1,9})|([A-Za-z]{2,6})-(\d{1,9}))\b/gim)) {
    // A bucket key in capitals only, as the portal writes it (the `i` flag is for `Ticket:`).
    if (m[1] === undefined && !TICKET_BUCKET_KEY.test(m[2]!)) continue;
    const id = m[1] !== undefined ? ticketIdOf(Number(m[1])) : ticketKeyOf(m[2]!, Number(m[3]));
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
