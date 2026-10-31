// UI reporter (docs/prd/ui-reporter.md): a floating widget (the SDK, repo alfianisnan26/pilot-reporter) that a web app loads
// with one script tag. It signs in to this portal for one ticket bucket, shows that bucket's sessions, tickets and knowledge,
// files a ticket with evidence of the page (screenshot, component tree, network, console, performance, version), and redraws
// open tickets as callouts where they were reported. Everything a page sends is untrusted input: the server re-validates,
// caps and redacts it.

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

/** GET /reporter/v1/status?bucket=KEY (no token): may this origin use the widget at all. Answers only to an allowed Origin. */
export interface ReporterStatus {
  enabled: boolean;
  bucketKey: string;
  bucketName: string;
  calloutsDefault: boolean;
  /** The SDK version the portal serves at /reporter/v1/reporter.js. */
  sdkVersion: string;
}

/** What the connect popup posts to its opener (targetOrigin = the page's origin), after the signed-in person approves. */
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

/** POST /reporter/v1/tickets: the ticket; the screenshot and the evidence follow as attachments of the returned key. */
export interface ReporterCreateTicketRequest {
  summary: string;
  description: string;
  type?: TicketType;
  priority?: TicketPriority;
  tags?: string[];
  anchor: ReporterAnchor;
  pageUrl: string;
  appVersion: string | null;
  repo: string | null;
  sdkVersion: string;
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
  /** Set when the ticket came from the widget. */
  anchor: ReporterAnchor | null;
  pageUrl: string | null;
  appVersion: string | null;
  /** The screenshot, readable with the same token. */
  screenshotUrl: string | null;
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

/** What the server keeps per reported ticket (table reporter_ticket_evidence), shown in the ticket page's evidence viewer. */
export interface TicketReporterEvidence {
  pageUrl: string;
  anchor: ReporterAnchor;
  appVersion: string | null;
  repo: string | null;
  sdkVersion: string;
  origin: string;
  screenshotAttachmentId: string | null;
  evidenceAttachmentId: string | null;
  createdAt: string;
}

/**
 * Routes. Owner side under /api (cookie, the usual CSRF): the bucket's config. Widget side under /reporter/v1 (outside /api and its
 * cookie CSRF): bearer `cprt_` token, CORS answered only for the token's origin when that origin is still allowed, preflight with
 * Access-Control-Allow-Private-Network. A denial is the same 404 as a missing object.
 */
export const REPORTER_ROUTES = {
  config: '/api/reporter/buckets/:key/config', // GET, PUT (owner)
  evidence: '/api/tickets/:id/reporter-evidence', // GET (owner, ticket page)
  script: '/reporter/v1/reporter.js', // GET, public, the pinned SDK build
  status: '/reporter/v1/status', // GET ?bucket=
  connect: '/reporter/v1/connect', // GET page (popup) ?bucket=&origin=&nonce=; POST approve (cookie, same-origin)
  me: '/reporter/v1/me', // GET
  tickets: '/reporter/v1/tickets', // GET ?status=open|all&path=, POST
  ticket: '/reporter/v1/tickets/:key', // GET
  attach: '/reporter/v1/tickets/:key/attachments', // POST raw body; x-reporter-kind: screenshot | evidence
  file: '/reporter/v1/tickets/:key/screenshot', // GET
  sessions: '/reporter/v1/sessions', // GET
  knowledge: '/reporter/v1/knowledge', // GET ?q=
  note: '/reporter/v1/knowledge/note', // GET ?path=
} as const;
