// UI reporter (docs/prd/ui-reporter.md). Two halves:
// - The SDK (repo alfianisnan26/pilot-reporter), loaded by a web app with one script tag: the floating widget button, the
//   recorders (console, network, performance, component tree), the screenshot and crop capture, the callouts drawn on the page,
//   and the hotkeys. It holds no token and calls no portal API.
// - The panel, a page of this portal (/reporter/v1/embed) that the SDK opens in an iframe: sign-in, the bucket's sessions,
//   tickets and knowledge, the report form, settings. It holds the scoped token (in its own, partitioned storage) and calls
//   /reporter/v1/* same-origin, so the host page never sees the token and the API needs no CORS.
// The two talk only through the ReporterBridge messages below, each side checking the other's origin and window.
// Everything the page sends is untrusted input: the server re-validates, caps and redacts it.

import type { TicketPriority, TicketStatus, TicketType } from './tickets.js';

/** Bumped when the evidence bundle changes shape; the server accepts this version only. */
export const REPORTER_EVIDENCE_SCHEMA = 1 as const;

/** Prefix of the scoped token the widget holds (one bucket, one origin). Hashed at rest like the other portal tokens. */
export const REPORTER_TOKEN_PREFIX = 'cprt_';

export const REPORTER_LIMITS = {
  /** Allowed page origins per bucket. */
  origins: 20,
  /** Repos named as the bucket's context. */
  repos: 20,
  /** Screenshot (png, jpeg or webp). */
  screenshotBytes: 8 * 1024 * 1024,
  /** Evidence bundle (JSON). */
  evidenceBytes: 2 * 1024 * 1024,
  consoleEntries: 200,
  networkEntries: 200,
  componentNodes: 400,
  /** Characters of one console line or one stringified value. */
  textChars: 2000,
  /** Token lifetime. */
  tokenHours: 12,
  /** Tickets a token may file per hour. */
  ticketsPerHour: 30,
  /** Captures (screenshot + evidence + anchor) on one ticket. */
  capturesPerTicket: 20,
  /** Comments (captures) on one draft review. */
  reviewComments: 50,
  /** Characters of one review comment. */
  commentChars: 4000,
  /** Draft reviews one person keeps open per bucket. */
  draftReviews: 10,
  /** A draft review untouched this long is discarded (its files too). */
  draftDays: 30,
} as const;

/** Per-bucket switch and allowlist, set by the owner in the bucket's settings. Off until turned on. */
export interface ReporterConfig {
  bucketKey: string;
  enabled: boolean;
  /** Exact origins (scheme, host, port) whose pages may connect, e.g. "https://stg.konfersi.com". No wildcards. */
  origins: string[];
  /** Repo context of this bucket ("platform/konfersi-landing-page"); a page may name one of these as its repo. */
  repos: string[];
  /** Show open-ticket callouts by default (each viewer can still hide them in the widget). */
  calloutsDefault: boolean;
  updatedAt: string | null;
}

export interface UpdateReporterConfigRequest {
  enabled?: boolean;
  origins?: string[];
  repos?: string[];
  calloutsDefault?: boolean;
}

/** What the panel tells the SDK in its `ready` message: whether this bucket and origin may use the widget at all. */
export interface ReporterStatus {
  enabled: boolean;
  bucketKey: string;
  bucketName: string;
  calloutsDefault: boolean;
  /** The SDK version the portal serves at /reporter/v1/reporter.js. */
  sdkVersion: string;
}

/**
 * What the connect popup posts to its opener after the signed-in person approves. The opener is the panel iframe, so
 * targetOrigin is the portal's own origin; the token never reaches the host page.
 */
export interface ReporterConnectMessage {
  type: 'pilot-reporter:connected';
  /** Echo of the nonce the widget passed to the popup. */
  nonce: string;
  token: string;
  expiresAt: string;
  bucketKey: string;
  actorLabel: string;
}

/** Where on the page a ticket points. Coordinates are CSS pixels in document space (scroll included). */
export interface ReporterAnchor {
  /** URL path plus search, no hash; callouts show on pages whose path matches. */
  path: string;
  /** A stable CSS selector of the element under the selection's centre, if one was found. */
  selector: string | null;
  /** The selection relative to that element's box, as fractions (0..1), so it survives layout changes. */
  relative: { x: number; y: number; w: number; h: number } | null;
  /** The selection in document coordinates at capture time; the fallback when the selector no longer matches. */
  rect: { x: number; y: number; w: number; h: number };
  viewport: { w: number; h: number; dpr: number };
  mode: 'full' | 'crop';
}

export interface ReporterConsoleEntry {
  ts: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  /** A stack for errors, truncated. */
  stack?: string;
}

export interface ReporterNetworkEntry {
  ts: number;
  method: string;
  /** Query values redacted (keys kept). */
  url: string;
  status: number | null;
  durationMs: number | null;
  initiator: 'fetch' | 'xhr' | 'resource' | 'beacon' | 'websocket';
  sizeBytes: number | null;
  /** A failure without a status (network error, abort, CORS). */
  error?: string;
}

export interface ReporterComponentNode {
  name: string;
  depth: number;
  /** Prop names only, never values. */
  props?: string[];
  /** File:line when the build has source info (dev builds). */
  source?: string;
}

export interface ReporterPerformance {
  navigation: { ttfbMs: number | null; domContentLoadedMs: number | null; loadMs: number | null; type: string | null };
  vitals: { lcpMs: number | null; cls: number | null; inpMs: number | null; fcpMs: number | null };
  longTasks: { count: number; totalMs: number };
  memory: { usedJsHeapBytes: number | null; totalJsHeapBytes: number | null };
}

/** The JSON attachment of a reported ticket. Every list is capped by REPORTER_LIMITS and redacted before it leaves the page. */
export interface ReporterEvidence {
  schema: typeof REPORTER_EVIDENCE_SCHEMA;
  sdkVersion: string;
  capturedAt: string;
  page: { url: string; title: string; referrer: string; lang: string };
  userAgent: string;
  /** The deployed version the page declared (commit, tag or build id), or null when it declared none. */
  appVersion: string | null;
  repo: string | null;
  anchor: ReporterAnchor;
  dom: { selector: string | null; path: string; snippet: string } | null;
  components: ReporterComponentNode[];
  /** "react" when a React tree was read, null when none was found. */
  framework: string | null;
  console: ReporterConsoleEntry[];
  network: ReporterNetworkEntry[];
  performance: ReporterPerformance;
}

/**
 * One shot of a report: a screenshot, its evidence bundle and where on the page it points. A ticket holds one or more
 * (owner, 2026-10-31: one ticket per screenshot, or many screenshots in one ticket, e.g. per page). Two ways in: the quick path
 * files a ticket from one capture at once; a REVIEW (below) collects anchored comments as a server-side draft and submits them
 * as one ticket, one per page, or one per comment.
 */
export interface ReporterCaptureInput {
  /** Made by the panel (a UUID); names the capture's attachments and its callout. */
  captureId: string;
  pageUrl: string;
  anchor: ReporterAnchor;
  /** What this shot shows, when the person wrote a line for it. */
  note: string | null;
}

/** How a submitted review becomes tickets. The server splits, in one transaction. */
export type ReporterFileMode = 'single' | 'per-page' | 'per-capture';

/**
 * POST /reporter/v1/tickets: the ticket with its captures (1..capturesPerTicket); each capture's screenshot and evidence follow as
 * attachments of the returned key, named by captureId.
 */
export interface ReporterCreateTicketRequest {
  summary: string;
  description: string;
  type?: TicketType;
  priority?: TicketPriority;
  tags?: string[];
  captures: ReporterCaptureInput[];
  appVersion: string | null;
  repo: string | null;
  sdkVersion: string;
}

/** POST /reporter/v1/tickets/:key/captures: add captures to an open ticket this bucket's widget filed ("add to existing"). */
export interface ReporterAddCapturesRequest {
  captures: ReporterCaptureInput[];
}

/** A capture as stored and shown. */
export interface ReporterCapture {
  captureId: string;
  /** 1-based order on the ticket ("2 of 5" on a callout). */
  index: number;
  pageUrl: string;
  anchor: ReporterAnchor;
  note: string | null;
  createdAt: string;
}

/**
 * A review, after GitHub's pull request review (owner, 2026-10-31): start one, add comments that each anchor an area of the page
 * with a screenshot and a Markdown body, across pages and over time, then submit it. Until submitted it is a DRAFT, kept on the
 * server (table reporter_reviews, reporter_review_comments), visible only to its author (the token's actor) in this bucket, from any
 * device; it is not a ticket, so no queue, agent or notification sees it. Submit turns it into tickets per `mode`, moving the
 * files, or adds its comments to an open ticket (targetTicketKey). Discard deletes it and its files.
 */
export type ReporterReviewStatus = 'draft' | 'submitted' | 'discarded';

export interface ReporterReviewComment extends ReporterCapture {
  /** The comment, Markdown, untrusted. */
  body: string;
  updatedAt: string;
  screenshotUrl: string | null;
}

export interface ReporterReview {
  id: string;
  bucketKey: string;
  status: ReporterReviewStatus;
  /** A working title; the submit form proposes it as the summary. */
  title: string;
  createdAt: string;
  updatedAt: string;
  comments: ReporterReviewComment[];
  /** The tickets it became, once submitted. */
  ticketKeys: string[];
}

/** POST /reporter/v1/reviews */
export interface ReporterStartReviewRequest {
  title?: string;
  appVersion: string | null;
  repo: string | null;
  sdkVersion: string;
}

/** POST /reporter/v1/reviews/:id/comments (the capture's screenshot and evidence follow as review attachments by captureId). */
export interface ReporterAddCommentRequest {
  capture: ReporterCaptureInput;
  body: string;
}

/** PATCH /reporter/v1/reviews/:id/comments/:captureId */
export interface ReporterUpdateCommentRequest {
  body?: string;
  /** Move it to this 1-based position. */
  index?: number;
}

/** POST /reporter/v1/reviews/:id/submit */
export interface ReporterSubmitReviewRequest {
  summary: string;
  /** The review's overall comment, Markdown; goes above the per-comment sections. */
  description: string;
  type?: TicketType;
  priority?: TicketPriority;
  tags?: string[];
  mode: ReporterFileMode;
  /** Add the comments to this open ticket of the bucket instead of creating tickets (mode is then ignored). */
  targetTicketKey?: string;
}

export interface ReporterSubmitReviewResponse {
  ticketKeys: string[];
}

/** A ticket as the widget sees it (the list, the callouts and the detail card). */
export interface ReporterTicket {
  key: string;
  summary: string;
  status: TicketStatus;
  type: TicketType;
  priority: TicketPriority;
  createdAt: string;
  updatedAt: string;
  /** The portal page of this ticket. */
  url: string;
  /** The ticket's captures, in order; empty when it did not come from the widget. */
  captures: (ReporterCapture & { screenshotUrl: string | null })[];
  appVersion: string | null;
}

export interface ReporterSession {
  id: string;
  title: string;
  status: string;
  ticketKey: string | null;
  updatedAt: string;
  url: string;
}

export interface ReporterNoteHit {
  path: string;
  title: string;
  snippet: string;
  url: string;
}

/**
 * What the server keeps per reported ticket (tables reporter_ticket_evidence and reporter_ticket_captures), shown in the ticket
 * page's evidence viewer: a strip of the captures, each with its screenshot, crop and evidence tabs.
 */
export interface TicketReporterEvidence {
  appVersion: string | null;
  repo: string | null;
  sdkVersion: string;
  origin: string;
  createdAt: string;
  captures: (ReporterCapture & { screenshotAttachmentId: string | null; evidenceAttachmentId: string | null })[];
}

/** Bumped when a bridge message changes shape; both sides send it in hello/ready and refuse another major. */
export const REPORTER_BRIDGE_VERSION = 1 as const;

/** A ticket as the SDK needs it to draw a callout (no token, no screenshot URL). */
export interface ReporterCallout {
  key: string;
  summary: string;
  status: TicketStatus;
  priority: TicketPriority;
  /** The portal page of the ticket, opened in a new tab from the hover card. */
  url: string;
  /** One callout per capture on this path; a ticket with several shows "index of total". */
  captureId: string;
  /**
   * A comment of the viewer's own draft review (key is then the review id, url the panel's review view): drawn as pending (dashed,
   * muted) so the reviewer sees what they already marked while still reviewing.
   */
  pending?: boolean;
  index: number;
  total: number;
  anchor: ReporterAnchor;
}

/** Host page (SDK) -> panel iframe. The panel accepts these only from window.parent and only from the `origin` it was opened for. */
export type ReporterHostMessage =
  | { type: 'pilot-reporter:hello'; bridge: typeof REPORTER_BRIDGE_VERSION; sdkVersion: string; page: { url: string; title: string }; appVersion: string | null; repo: string | null }
  | { type: 'pilot-reporter:navigated'; page: { url: string; title: string } }
  /** The capture the panel asked for. The screenshot travels as a transferred ArrayBuffer. */
  | { type: 'pilot-reporter:capture-result'; requestId: string; screenshot: ArrayBuffer; mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; evidence: ReporterEvidence }
  | { type: 'pilot-reporter:capture-cancelled'; requestId: string; reason: 'user' | 'error'; message?: string }
  /** A capture the person started with a hotkey: the panel opens on the report form with it. */
  | { type: 'pilot-reporter:capture-started'; requestId: string; mode: 'full' | 'crop' }
  | { type: 'pilot-reporter:panel-opened' }
  | { type: 'pilot-reporter:callout-clicked'; key: string };

/** Panel iframe -> host page (SDK). The SDK accepts these only from its iframe's contentWindow and only from the portal origin. */
export type ReporterPanelMessage =
  | { type: 'pilot-reporter:ready'; bridge: typeof REPORTER_BRIDGE_VERSION; status: ReporterStatus; connected: boolean; actorLabel: string | null }
  | { type: 'pilot-reporter:capture-request'; requestId: string; mode: 'full' | 'crop'; precise: boolean }
  /** The open tickets of this bucket anchored on the current path; replaces what is drawn. Empty when signed out. */
  | { type: 'pilot-reporter:callouts'; path: string; callouts: ReporterCallout[] }
  | { type: 'pilot-reporter:settings'; calloutsVisible: boolean; hotkeys: Record<'report' | 'crop' | 'callouts' | 'panel', string> }
  | { type: 'pilot-reporter:highlight'; key: string }
  /** Comments in the open draft review: the widget button shows the count as a badge (0 hides it). */
  | { type: 'pilot-reporter:tray'; count: number }
  | { type: 'pilot-reporter:close' };

export type ReporterBridgeMessage = ReporterHostMessage | ReporterPanelMessage;

/**
 * Routes. Owner side under /api (cookie, the usual CSRF): the bucket's config and a ticket's evidence. Widget side under
 * /reporter/v1, outside /api: the public SDK script; the embed page, framed only by the bucket's allowed origins (CSP
 * frame-ancestors) while the bucket is enabled; the connect popup (portal cookie, same-origin approve); and the panel's API,
 * same-origin with the bearer `cprt_` token (no CORS: only the panel calls it). A denial is the same 404 as a missing object.
 */
export const REPORTER_ROUTES = {
  config: '/api/reporter/buckets/:key/config', // GET, PUT (owner)
  evidence: '/api/tickets/:id/reporter-evidence', // GET (owner, ticket page)
  script: '/reporter/v1/reporter.js', // GET, public, the pinned SDK build
  embed: '/reporter/v1/embed', // GET page (iframe) ?bucket=&origin= ; frame-ancestors = that origin when allowed
  status: '/reporter/v1/status', // GET ?bucket=&origin= (panel, same-origin, no token): ReporterStatus for the panel's ready message
  connect: '/reporter/v1/connect', // GET page (popup) ?bucket=&origin=&nonce=; POST approve (cookie, same-origin)
  me: '/reporter/v1/me', // GET
  tickets: '/reporter/v1/tickets', // GET ?status=open|all&path=, POST
  ticket: '/reporter/v1/tickets/:key', // GET
  captures: '/reporter/v1/tickets/:key/captures', // POST ReporterAddCapturesRequest
  attach: '/reporter/v1/tickets/:key/attachments', // POST raw body; x-reporter-capture: <captureId>; x-reporter-kind: screenshot | evidence
  file: '/reporter/v1/tickets/:key/captures/:captureId/screenshot', // GET
  reviews: '/reporter/v1/reviews', // GET ?status=draft (the author's own), POST start
  review: '/reporter/v1/reviews/:id', // GET, PATCH {title}, DELETE (discard)
  reviewComments: '/reporter/v1/reviews/:id/comments', // POST
  reviewComment: '/reporter/v1/reviews/:id/comments/:captureId', // PATCH, DELETE
  reviewAttach: '/reporter/v1/reviews/:id/attachments', // POST raw body; x-reporter-capture; x-reporter-kind
  reviewFile: '/reporter/v1/reviews/:id/comments/:captureId/screenshot', // GET
  reviewSubmit: '/reporter/v1/reviews/:id/submit', // POST
  sessions: '/reporter/v1/sessions', // GET
  knowledge: '/reporter/v1/knowledge', // GET ?q=
  note: '/reporter/v1/knowledge/note', // GET ?path=
} as const;
