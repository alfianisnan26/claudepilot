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
  /** Sites (origin + environment + repo) per bucket. */
  sites: 20,
  /** Sessions a bucket offers as direct-report targets. */
  sessionTargets: 10,
  /** Repos named as the bucket's context. */
  repos: 20,
  /** Screenshot (png, jpeg or webp). */
  screenshotBytes: 8 * 1024 * 1024,
  /** Evidence bundle (JSON). */
  evidenceBytes: 2 * 1024 * 1024,
  consoleEntries: 200,
  networkEntries: 200,
  /** Interactions kept for the repro trail. */
  interactionEntries: 50,
  /** UI check findings per capture. */
  checkFindings: 100,
  /** Duplicate candidates offered. */
  duplicateCandidates: 5,
  componentNodes: 400,
  /** What the DOM screenshot could not draw, per capture (the SDK sends at most 10). */
  captureGaps: 10,
  /** Characters of one console line or one stringified value. */
  textChars: 2000,
  /** Token lifetime. */
  tokenHours: 12,
  /**
   * Live tokens one person keeps per bucket and origin (several devices, browsers, test runs): a new approval revokes only the oldest beyond
   * this. Was one (2026-10-31): a test agent approving as the owner signed the owner's own panel out.
   */
  liveTokensPerSite: 5,
  /** Tickets a token may file per hour. */
  ticketsPerHour: 30,
  /** Chat messages a token may send to sessions in ten minutes (chat in the widget). */
  chatMessagesPer10Min: 20,
  /** Characters of one chat message from the widget. */
  chatChars: 8000,
  /** Lines of a chat page (the newest first loaded, older on scroll up). */
  chatPage: 40,
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

/**
 * A site: one origin, which environment of which repo it serves (owner, 2026-10-31: the same repo on different domains or
 * environments must always know where a ticket belongs). An origin belongs to exactly one site of one bucket in the whole portal
 * (unique), so a page always resolves to one bucket, one repo and one environment. The SERVER's site record decides; what the page
 * declares (ReporterBuildInfo.repo / environment) is untrusted and only compared: a mismatch is stored and shown, never obeyed.
 */
export interface ReporterSite {
  /** Exact origin (scheme, host, port), e.g. "https://stg.konfersi.com". No wildcards. */
  origin: string;
  /** "stg", "uat", "prod", "local"... Lowercase, 1-20 chars. */
  environment: string;
  /** "platform/konfersi-landing-page": the repo whose build this origin serves. */
  repo: string;
  /** Optional display name ("Landing stg"). */
  label: string | null;
  /** The repo's branch this environment deploys from ("stg"), when known: lets the server check a fix against that branch. */
  branch: string | null;
}

/** A session a reporter may send a direct report to (owner, 2026-10-31: report straight to the lead, urgent). */
export interface ReporterSessionTarget {
  sessionId: string;
  /** What the panel calls it ("Konfersi lead"). */
  label: string;
}

/** Per-bucket switch, sites and session targets, set by the owner in the bucket's settings. Off until turned on. */
export interface ReporterConfig {
  bucketKey: string;
  enabled: boolean;
  sites: ReporterSite[];
  /** Direct-report targets, the first is the default. Empty = the Session option is shown disabled with the reason. */
  sessionTargets: ReporterSessionTarget[];
  /** Show open-ticket callouts by default (each viewer can still hide them in the widget). */
  calloutsDefault: boolean;
  updatedAt: string | null;
}

export interface UpdateReporterConfigRequest {
  enabled?: boolean;
  sites?: ReporterSite[];
  sessionTargets?: ReporterSessionTarget[];
  calloutsDefault?: boolean;
}

/**
 * Where a report goes (owner, 2026-10-31): `ticket` joins the bucket's queue; `session` is urgent, straight to a session (the
 * lead): it still makes a ticket (priority urgent, tag "ui-urgent", assigned to that session) so it is traced and its deployment is
 * tracked, AND posts it into that session's chat at once (summary, per-capture sections, the screenshots as images, the ticket
 * key, asking for the reply on the ticket). The panel can switch target at any time before sending, while capturing too.
 */
export type ReporterReportTarget = { kind: 'ticket' } | { kind: 'session'; sessionId: string };

/** The site a ticket came from, frozen at report time. */
export interface ReporterTicketSite {
  bucketKey: string;
  origin: string;
  environment: string;
  repo: string;
  /** What the page declared when it differed from the site record (shown as a warning). */
  declaredMismatch: { repo: string | null; environment: string | null } | null;
}

/**
 * A build seen live in an environment (owner, 2026-10-31: fundamental to know whether a fix is deployed). Sources: `pipeline` = a
 * deploy pipeline or agent posted it with a portal token after deploying (AUTHORITATIVE); `widget` = OBSERVED: a signed-in panel on
 * that site reported the page's build (ReporterBuildInfo.commit) as it loaded, which the page itself declares (a stale tab or a wrong
 * meta tag can lie), so it counts only when `verified` (the commit exists in a checkout of the repo the server can read) and only
 * while the bucket has no pipeline deployment for that environment. Kept per (bucket, repo, environment): a token of one bucket never
 * writes what another bucket reads.
 */
export interface ReporterDeployment {
  repo: string;
  environment: string;
  commit: string;
  branch: string | null;
  source: 'widget' | 'pipeline';
  /** The origin it was seen on (widget) or the pipeline's label. */
  via: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Pipeline: always true. Observed: the commit was found in a checkout of the repo; false = unverified, history only, never live. */
  verified?: boolean;
}

/** POST /api/reporter/deployments (a portal token with operate on the bucket, for pipelines and agents after a deploy). */
export interface ReporterRecordDeploymentRequest {
  /** Only this bucket (it must serve the repo and environment); else every bucket the token may operate on that does. */
  bucket?: string;
  repo: string;
  environment: string;
  commit: string;
  branch?: string;
  label?: string;
}

/**
 * Is this ticket's fix live in an environment. `deployed`: the environment's current commit (see `confidence`) is a fix commit or
 * contains one (ancestry proven by the server in a checkout of the repo).
 * `not-deployed`: proven absent. `unknown`: no fix commit known, no build seen for that environment, or ancestry could not be
 * checked; `reason` says which. Never guessed.
 */
export interface ReporterDeploymentState {
  environment: string;
  status: 'deployed' | 'not-deployed' | 'unknown';
  /** The environment's current commit, and when it was last seen. */
  currentCommit: string | null;
  seenAt: string | null;
  /** The fix commit found in it, when deployed. */
  fixCommit: string | null;
  reason: 'no-fix-commit' | 'no-build-seen' | 'ancestry-unchecked' | null;
  /**
   * Where `currentCommit` comes from, when there is one: `pipeline` = a deployment a pipeline posted (authoritative); `observed` = a
   * build a signed-in widget saw whose commit exists in the repo, used only while the bucket has no pipeline for this environment. A
   * `deployed` from `observed` is shown with a lower-confidence marker.
   */
  confidence?: 'pipeline' | 'observed';
}

/** What the panel tells the SDK in its `ready` message: whether this bucket and origin may use the widget at all. */
export interface ReporterStatus {
  /** The site this origin resolved to (environment and repo come from here, not from the page). */
  site: ReporterSite | null;
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

/**
 * The connect popup's answer when it cannot hand the token to `window.opener` (the opener was lost: signing in inside the popup goes
 * through the portal's pages, whose Cross-Origin-Opener-Policy cuts the popup off from the panel). The approval is held on the server for
 * two minutes, keyed by the nonce; the panel claims it ONCE with the secret the nonce was derived from (nonce = base64url(SHA-256(verifier))),
 * which never left the panel. No token travels in a URL.
 */
export interface ReporterConnectClaimRequest {
  bucket: string;
  origin: string;
  verifier: string;
}

/** Not approved yet (or unknown, expired, already claimed: the same answer), or the connect message. */
export type ReporterConnectClaim = { pending: true } | ReporterConnectMessage;

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
  mode: ReporterCaptureMode;
}

/**
 * What a capture covers: `viewport` only what was on screen ("Screen", the default), `full` the whole page ("Whole page", desktop), `crop`
 * an area the person drew. `viewport` is additive (2026-10-31): a reader that knows only `full` and `crop` shows it like `full`.
 */
export type ReporterCaptureMode = 'viewport' | 'full' | 'crop';
export const REPORTER_CAPTURE_MODES: readonly ReporterCaptureMode[] = ['viewport', 'full', 'crop'];

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

/**
 * What was deployed (owner, 2026-10-31: commit, branch, version). From the SDK config (data-version, data-commit, data-branch,
 * data-env, data-built-at, data-repo, or init()), else meta tags (version, app-version, commit, build-id), else null: never guessed.
 */
export interface ReporterBuildInfo {
  version: string | null;
  commit: string | null;
  branch: string | null;
  /** "stg", "uat", "local"... as the page declares it. */
  environment: string | null;
  builtAt: string | null;
  /** The repo context, one of the bucket's repos when the bucket lists any. */
  repo: string | null;
}

/** Where the person was. Query VALUES are redacted in url and search (keys kept); the hash is kept (SPA routes) but capped. */
export interface ReporterPageInfo {
  url: string;
  origin: string;
  /** The domain (host without port). */
  host: string;
  path: string;
  search: string;
  hash: string;
  title: string;
  referrer: string;
  lang: string;
  /** The SPA's route pattern when the app exposes one (e.g. a meta tag or init({ route })), else null. */
  route: string | null;
  /** Steps in this tab's history, a hint of how the person got here. */
  historyLength: number;
}

/** The device and browser (owner, 2026-10-31: device info). Each field null when the browser does not tell. */
export interface ReporterDeviceInfo {
  userAgent: string;
  /** From User-Agent Client Hints when available, else parsed from the user agent. */
  browser: { name: string | null; version: string | null };
  os: { name: string | null; version: string | null };
  mobile: boolean | null;
  touch: boolean;
  screen: { w: number; h: number; dpr: number; orientation: string | null };
  viewport: { w: number; h: number };
  hardwareConcurrency: number | null;
  deviceMemoryGb: number | null;
  connection: { effectiveType: string | null; downlinkMbps: number | null; rttMs: number | null; saveData: boolean | null };
  timezone: string | null;
  locale: string | null;
}

/** The page's state at capture (owner, 2026-10-31: state). */
export interface ReporterPageState {
  scroll: { x: number; y: number; maxY: number };
  visibility: string;
  online: boolean;
  colorScheme: 'light' | 'dark';
  reducedMotion: boolean;
  /** document.activeElement as a selector (focus bugs), or null. */
  focused: string | null;
  /** Names only, never values, of this origin's localStorage, sessionStorage and cookies readable by script. */
  storageKeys: { local: string[]; session: string[]; cookies: string[] };
  /**
   * What the app chose to expose through init({ getState }), as JSON: capped (evidenceBytes share), redacted, and null when the app
   * gives none. The SDK never reads app state on its own.
   */
  app: unknown;
}

/**
 * One step of the interaction trail (owner, 2026-10-31: repro steps). Input VALUES are never recorded: `value` is "[masked]" for
 * text and password fields, the option label for a select, "checked"/"unchecked" for a checkbox or radio.
 */
export interface ReporterInteraction {
  ts: number;
  kind: 'click' | 'input' | 'change' | 'submit' | 'navigate' | 'key' | 'scroll';
  selector: string | null;
  /** The element's accessible name or visible label, capped; what a person would call it ("Sign in" button). */
  label: string | null;
  value?: string;
  /** For navigate: the path (query values redacted). For key: only Enter, Escape, Tab and arrows, never characters. */
  detail?: string;
}

/** Steps to reproduce, built by the SERVER from the trail, the page and the device (so it improves without an SDK release). */
export interface ReporterRepro {
  steps: string[];
  /** A Playwright test (TypeScript) at the capture's viewport and user agent, ending at the captured state, for agents to run. */
  playwright: string;
}

/**
 * Automatic UI checks on the cropped area (owner, 2026-10-31), against the ClaudePilot QA standard: axe-core (loaded on demand from
 * {portal}/reporter/v1/axe.js at capture time, never at page load), touch targets under 44px, contrast, horizontal overflow, text
 * cut off (ellipsis or clipped).
 */
export interface ReporterCheckFinding {
  source: 'axe' | 'target-size' | 'contrast' | 'overflow' | 'truncation';
  rule: string;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  message: string;
  selector: string | null;
  help: string | null;
}

export interface ReporterChecks {
  /** False when the checks could not run (axe failed to load, CSP); `error` says why. Never a silent empty list. */
  ran: boolean;
  error?: string;
  findings: ReporterCheckFinding[];
}

/** The JSON attachment of a reported ticket. Every list is capped by REPORTER_LIMITS and redacted before it leaves the page. */
export interface ReporterEvidence {
  schema: typeof REPORTER_EVIDENCE_SCHEMA;
  sdkVersion: string;
  capturedAt: string;
  page: ReporterPageInfo;
  device: ReporterDeviceInfo;
  state: ReporterPageState;
  build: ReporterBuildInfo;
  anchor: ReporterAnchor;
  dom: { selector: string | null; path: string; snippet: string } | null;
  components: ReporterComponentNode[];
  /** "react" when a React tree was read, null when none was found. */
  framework: string | null;
  console: ReporterConsoleEntry[];
  network: ReporterNetworkEntry[];
  performance: ReporterPerformance;
  interactions: ReporterInteraction[];
  checks: ReporterChecks;
  /**
   * Normalized signatures of the console errors and unhandled rejections in the buffer (message with numbers, ids and URLs
   * replaced, plus the top stack frame's file and function), for duplicate detection.
   */
  errorSignatures: string[];
  /**
   * What the DOM screenshot could not draw (a cross-origin image without CORS, a WebGL canvas, another site's frame), in plain words,
   * at most REPORTER_LIMITS.captureGaps; absent when the shot is complete or was taken with precise capture (the tab's own pixels).
   * Optional and additive: older SDKs do not send it.
   */
  captureGaps?: string[];
}

/**
 * POST /reporter/v1/duplicates (owner, 2026-10-31): before filing, the panel asks for similar open tickets of the bucket: a capture
 * on the same path whose area overlaps (IoU of the document rects, or the same selector), or the same error signature.
 */
export interface ReporterDuplicateQuery {
  path: string;
  anchor: ReporterAnchor;
  errorSignatures: string[];
}

export interface ReporterDuplicateCandidate {
  key: string;
  summary: string;
  status: TicketStatus;
  reasons: ('same-area' | 'same-element' | 'same-error')[];
  /** 0..1, higher is more alike. */
  score: number;
  url: string;
  thumbnailUrl: string | null;
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
  build: ReporterBuildInfo;
  sdkVersion: string;
  /** Default { kind: 'ticket' }. */
  target?: ReporterReportTarget;
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
  build: ReporterBuildInfo;
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
  /** Default { kind: 'ticket' }; with a session, every resulting ticket is urgent and posted to it. */
  target?: ReporterReportTarget;
}

export interface ReporterSubmitReviewResponse {
  ticketKeys: string[];
  /** With a session target: whether the chat message reached the session (the tickets exist either way). */
  sessionDelivery?: ReporterSessionDelivery;
}

/** Whether a direct report's chat message reached the session. A failure keeps the ticket; the panel says so plainly. */
export interface ReporterSessionDelivery {
  sessionId: string;
  delivered: boolean;
  error: string | null;
}

/** POST /reporter/v1/tickets answer: the new ticket's key and page, plus the session delivery for a direct report. */
export interface ReporterCreateTicketResponse {
  key: string;
  url: string;
  sessionDelivery?: ReporterSessionDelivery;
}

/** GET /reporter/v1/me: who the token is (the panel shows actorLabel, signs out on 401). */
export interface ReporterMe {
  bucketKey: string;
  origin: string;
  actorLabel: string;
  expiresAt: string;
  /**
   * The request's client address as the portal sees it (the socket, or the trusted proxy's X-Forwarded-For entry; a header a client sets is
   * never believed), and its family. Shown in the panel's Context view; the same address is stored with each report. Additive.
   */
  clientIp?: string | null;
  clientIpFamily?: 4 | 6 | null;
}

/** POST /reporter/v1/observed-build body: the build the page declared; the server records it for the SITE's repo and environment. */
export interface ReporterObservedBuildRequest {
  build: ReporterBuildInfo;
  pageUrl: string;
}

/** GET /reporter/v1/session-targets item: a direct-report target and that session's live state. */
export interface ReporterSessionTargetStatus extends ReporterSessionTarget {
  /** The session's title, when the server tells it. */
  title?: string | null;
  /** 'working', 'idle', 'waiting', 'asleep', 'ended'... as the chat reports it. */
  status: string;
  /** False when the session cannot take a message (ended, gone): the panel disables it with the reason. */
  available: boolean;
  reason: string | null;
}

/** GET /reporter/v1/knowledge/note?path= */
export interface ReporterNote {
  path: string;
  title: string;
  /** Markdown, untrusted; rendered sanitized. */
  body: string;
  url: string;
}

/**
 * GET /reporter/v1/tickets query (owner, 2026-10-31: better filtering and sorting). All optional; the panel keeps the last choice
 * per viewer. `page` scopes to tickets with a capture on that path ('this' = the page the person is on, sent as the path).
 */
export interface ReporterTicketQuery {
  /** Default 'open'. */
  status?: 'open' | 'closed' | 'all' | TicketStatus;
  type?: TicketType[];
  priority?: TicketPriority[];
  tags?: string[];
  /** Text in key, summary or a capture's comment. */
  q?: string;
  /** A path: tickets with a capture there. Absent = every page. */
  path?: string;
  /** Only tickets this token's person filed. */
  mine?: boolean;
  /** 'position' = top-to-bottom on the page (needs path); default 'updated'. */
  sort?: 'updated' | 'created' | 'priority' | 'position' | 'captures';
  order?: 'asc' | 'desc';
  cursor?: string;
  limit?: number;
}

/** The list answer: the page, plus counts for the filter chips (by status, priority and type, and how many are on this path). */
export interface ReporterTicketList {
  items: ReporterTicket[];
  nextCursor: string | null;
  counts: { status: Record<string, number>; priority: Record<string, number>; type: Record<string, number>; onPath: number };
}

/**
 * Where the work on a ticket stands, as the callout colours it (owner, 2026-10-31: live status). Relative to the environment being
 * VIEWED: `fixed` = done with a fix commit known but not proven live here; `deployed` = ReporterDeploymentState 'deployed' for this
 * site's environment. A ticket reported on stg and viewed on uat (same repo) shows uat's state.
 */
export type ReporterWorkPhase = 'open' | 'working' | 'review' | 'fixed' | 'deployed' | 'wont-do';

export interface ReporterFixInfo {
  commit: string | null;
  branch: string | null;
  environment: string | null;
  at: string | null;
}

/** A comment on a reported ticket, as the panel shows it (owner, 2026-10-31: reply to the agent from the page). */
export interface ReporterTicketComment {
  id: string;
  /** "You", an agent session's name, or a person. */
  author: string;
  authorKind: 'reporter' | 'agent' | 'person' | 'system';
  /** Markdown, untrusted; the panel renders it sanitized. */
  body: string;
  createdAt: string;
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
  build: ReporterBuildInfo | null;
  phase: ReporterWorkPhase;
  fix: ReporterFixInfo | null;
  site: ReporterTicketSite | null;
  /** Where it went: the queue, or straight to a session (urgent). */
  target: { kind: 'ticket' } | { kind: 'session'; sessionId: string; label: string; status: string };
  /** Every commit known to fix it (the "Ticket: KEY" trailers the server found, or set by the agent on close). */
  fixCommits: string[];
  /** One row per environment of this ticket's repo (all sites of the bucket with that repo), stg, uat, prod... */
  deployments: ReporterDeploymentState[];
  /** Comments since the reporter last replied or read; an agent's open question shows as a badge on the callout. */
  unread: number;
  awaitingReporter: boolean;
  /** Steps to reproduce from the first capture's trail, when it had one. */
  repro: ReporterRepro | null;
  /** UI check findings per capture, counted by severity, for the list and the card. */
  checkCounts: Record<ReporterCheckFinding['severity'], number>;
}

export interface ReporterSession {
  id: string;
  title: string;
  status: string;
  ticketKey: string | null;
  updatedAt: string;
  url: string;
}

/**
 * One line of a session's conversation as the panel shows it (PILOT-1111, chat in the widget). Less than the portal shows the owner, never
 * more: the person's and the assistant's text (already redacted when stored, redacted again on the way out), a tool call as its name and
 * one short line, an approval as a line that says one waits (answered in pilot only), and images by reference. Sub-agent lines, thinking,
 * tool output, costs and system notes are left out.
 */
export interface ReporterChatMessage {
  seq: number;
  at: string;
  kind: 'user' | 'assistant' | 'tool' | 'tool_result' | 'approval' | 'error';
  /** For `tool_result`: empty when the tool succeeded, else its error as one short redacted line (never its output). */
  text: string;
  /** For `user`: who sent it when it was not the owner at the keyboard (a reporter, a ticket, another session). */
  from: string | null;
  /** For `tool`: the tool's name; `text` is one line of what it was given (a command, a path), cut short. */
  tool: string | null;
  /** For `tool` and `tool_result`: the call's id, which joins a result to its call (the panel folds a run of calls into one row). */
  toolId?: string | null;
  /** For `tool_result`: false when the tool failed. */
  ok?: boolean;
  /** Images on the line, served by `REPORTER_ROUTES.sessionBlob` with the bearer token. */
  images: { url: string; mediaType: string; width: number | null; height: number | null }[];
}

/** The session's state as the panel needs it: busy, waiting on an approval (answered in pilot, never here), or ended. */
export interface ReporterChatState {
  id: string;
  title: string;
  state: 'starting' | 'idle' | 'working' | 'waiting' | 'interrupted' | 'ended';
  /** Open approvals and what the oldest asks ("Run a command: npm test"); the panel links out to answer them. */
  waiting: number;
  waitingFor: string | null;
  /** The last stored event; the live stream and `?after=` resume after it. */
  lastSeq: number;
  /** The ticket of the bucket it works on, when it works on one. */
  ticketKey: string | null;
  url: string;
}

/**
 * `GET REPORTER_ROUTES.sessionMessages?before=<seq>&limit=<n>` (a page counted back from the newest: `before` absent) or `?after=<seq>` (what
 * came after). `items` oldest first; `before` is the cursor of the next older page (null when there is none).
 */
export interface ReporterChatPage {
  items: ReporterChatMessage[];
  before: number | null;
  session: ReporterChatState;
}

/** `POST REPORTER_ROUTES.sessionMessages`: a message to the session as the token's person, optionally with the current capture. */
export interface ReporterChatSendRequest {
  /** The client's id for it (a UUID), so a retry is not sent twice. */
  uuid: string;
  text: string;
  image?: { mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; dataBase64: string } | null;
}

/** A line of the live stream (`REPORTER_ROUTES.sessionStream`, NDJSON): new lines and the state, or a keep-alive. */
export type ReporterChatStreamLine = { type: 'hello'; session: ReporterChatState } | { type: 'update'; items: ReporterChatMessage[]; session: ReporterChatState } | { type: 'ping' } | { type: 'gone' };

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
  build: ReporterBuildInfo;
  sdkVersion: string;
  origin: string;
  site: ReporterTicketSite;
  target: ReporterReportTarget;
  fixCommits: string[];
  deployments: ReporterDeploymentState[];
  createdAt: string;
  captures: (ReporterCapture & { screenshotAttachmentId: string | null; evidenceAttachmentId: string | null })[];
  /** The reporter's address as the portal saw it when the ticket was filed (added by the server); null for older tickets. Additive. */
  reporterIp?: string | null;
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
  /** Colour and label of the marker; updates live. */
  phase: ReporterWorkPhase;
  /** "Fixed in abc1234 (stg)" on the card. */
  fix: ReporterFixInfo | null;
  /** This environment's deployment state of the fix, and where it was reported ("reported on stg"). */
  deployment: ReporterDeploymentState | null;
  reportedOn: { origin: string; environment: string } | null;
  /** A badge on the marker: someone asked the reporter something. */
  awaitingReporter: boolean;
  unread: number;
  index: number;
  total: number;
  anchor: ReporterAnchor;
}

/** Host page (SDK) -> panel iframe. The panel accepts these only from window.parent and only from the `origin` it was opened for. */
export type ReporterHostMessage =
  | { type: 'pilot-reporter:hello'; bridge: typeof REPORTER_BRIDGE_VERSION; sdkVersion: string; page: { url: string; title: string }; build: ReporterBuildInfo }
  | { type: 'pilot-reporter:navigated'; page: { url: string; title: string } }
  /**
   * The capture the panel asked for. The screenshot travels as a transferred ArrayBuffer. `target`: what the capture toolbar's
   * Ticket | Session switch says, preselected on the report form (or the review's submit form); a session target the bucket does not
   * offer now (or sessionId '' = "the default session") becomes the bucket's first available target, else Ticket.
   */
  | { type: 'pilot-reporter:capture-result'; requestId: string; screenshot: ArrayBuffer; mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; evidence: ReporterEvidence; target?: ReporterReportTarget }
  | { type: 'pilot-reporter:capture-cancelled'; requestId: string; reason: 'user' | 'error'; message?: string }
  /** A capture the person started with a hotkey: the panel opens on the report form with it. */
  | { type: 'pilot-reporter:capture-started'; requestId: string; mode: ReporterCaptureMode; target?: ReporterReportTarget }
  | { type: 'pilot-reporter:panel-opened' }
  | { type: 'pilot-reporter:callout-clicked'; key: string; captureId: string }
  /** The showcase moved (Prev / Next on the caption card) or ended. */
  | { type: 'pilot-reporter:focus-changed'; key: string; captureId: string }
  | { type: 'pilot-reporter:focus-ended' }
  /** The capture is not on this page, or its element is gone and the stored rect is off-screen. */
  | { type: 'pilot-reporter:focus-missing'; key: string; captureId: string | null; reason: 'other-page' | 'not-found' }
  /**
   * What the next report from this page would carry, for the panel's Context view (owner, 2026-10-31): sent after hello, on navigation, and
   * at most once a second while the counts change. Additive: a panel that does not know it ignores it; the panel shows "unknown" without it.
   */
  | { type: 'pilot-reporter:context'; page: ReporterPageInfo; device: ReporterDeviceInfo; build: ReporterBuildInfo; counts: ReporterContextCounts };

/** Live counts of what the SDK has buffered for the next report (the Context view's "What a ticket carries"). */
export interface ReporterContextCounts {
  console: number;
  consoleErrors: number;
  network: number;
  networkFailed: number;
  interactions: number;
}

/** Panel iframe -> host page (SDK). The SDK accepts these only from its iframe's contentWindow and only from the portal origin. */
export type ReporterPanelMessage =
  | { type: 'pilot-reporter:ready'; bridge: typeof REPORTER_BRIDGE_VERSION; status: ReporterStatus; connected: boolean; actorLabel: string | null }
  /** `target` (optional): the panel's current Ticket | Session choice, the default of the capture toolbar's switch. */
  | { type: 'pilot-reporter:capture-request'; requestId: string; mode: ReporterCaptureMode; precise: boolean; target?: ReporterReportTarget }
  /** The panel's Ticket | Session choice changed (and once after ready): the next capture toolbar starts on it. */
  | { type: 'pilot-reporter:target'; target: ReporterReportTarget }
  /** The open tickets of this bucket anchored on the current path; replaces what is drawn. Empty when signed out. */
  | { type: 'pilot-reporter:callouts'; path: string; callouts: ReporterCallout[] }
  | { type: 'pilot-reporter:settings'; calloutsVisible: boolean; hotkeys: Record<'report' | 'crop' | 'callouts' | 'panel', string> }
  | { type: 'pilot-reporter:highlight'; key: string }
  /**
   * Showcase (owner, 2026-10-31: show and focus the tickets of this page so the issue is plain to see): scroll to the capture's area,
   * dim the rest of the page (spotlight), pulse the outlined box, show a caption card (key, summary, status, "2 of 5", comment
   * excerpt) with Prev / Next across this ticket's captures on this page and Close. Captures on another page: the SDK reports
   * focus-missing so the panel can offer to open that page.
   */
  | { type: 'pilot-reporter:focus'; key: string; captureId: string | null; spotlight: boolean }
  | { type: 'pilot-reporter:focus-clear' }
  /**
   * Comments in the open draft review: the widget button shows the count as a badge (0 hides it). `replies` (optional, additive): the
   * person's open tickets that wait for their reply, which the SDK shows on the button too.
   */
  | { type: 'pilot-reporter:tray'; count: number; replies?: number }
  /**
   * The panel shows something full screen (the screenshot viewer): on a phone the SDK raises its sheet to full height while `expanded`,
   * and puts it back after. Additive (2026-10-31): an SDK that does not know it ignores it and the viewer fills the sheet as it is.
   */
  | { type: 'pilot-reporter:expand'; expanded: boolean }
  | { type: 'pilot-reporter:close' };

export type ReporterBridgeMessage = ReporterHostMessage | ReporterPanelMessage;

/**
 * Routes. Owner side under /api (cookie, the usual CSRF): the bucket's config and a ticket's evidence. Widget side under
 * /reporter/v1, outside /api: the public SDK script; the embed page, framed only by the bucket's allowed origins (CSP
 * frame-ancestors) while the bucket is enabled; the connect popup (portal cookie, same-origin approve); and the panel's API,
 * same-origin with the bearer `cprt_` token (no CORS: only the panel calls it). A denial is the same 404 as a missing object.
 */
export const REPORTER_ROUTES = {
  config: '/api/reporter/buckets/:key/config', // GET, PUT (owner); a site origin used by another bucket is refused (409)
  deploymentsOwner: '/api/reporter/deployments', // GET ?bucket=&repo= (owner), POST ReporterRecordDeploymentRequest (token, operate)
  evidence: '/api/tickets/:id/reporter-evidence', // GET (owner, ticket page)
  script: '/reporter/v1/reporter.js', // GET, public, the pinned SDK build
  embed: '/reporter/v1/embed', // GET page (iframe) ?bucket=&origin= ; frame-ancestors = that origin when allowed
  status: '/reporter/v1/status', // GET ?bucket=&origin= (panel, same-origin, no token): ReporterStatus for the panel's ready message
  connect: '/reporter/v1/connect', // GET page (popup) ?bucket=&origin=&nonce=; POST approve (cookie, same-origin)
  connectClaim: '/reporter/v1/connect/claim', // POST ReporterConnectClaimRequest (panel, same-origin, no token) -> ReporterConnectClaim
  me: '/reporter/v1/me', // GET
  tickets: '/reporter/v1/tickets', // GET ReporterTicketQuery -> ReporterTicketList, POST
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
  ticketComments: '/reporter/v1/tickets/:key/comments', // GET (marks read), POST {body} (the reporter's reply, on the ticket timeline)
  duplicates: '/reporter/v1/duplicates', // POST ReporterDuplicateQuery -> { candidates: ReporterDuplicateCandidate[] }
  axe: '/reporter/v1/axe.js', // GET, public, pinned axe-core, loaded by the SDK only at capture time
  /**
   * GET, a streamed response (fetch with the bearer token; not EventSource, which cannot send it) of changes to this bucket's
   * reported tickets: phase, fix, comments. The panel re-sends callouts within seconds; it falls back to polling every 30 s.
   */
  events: '/reporter/v1/events',
  sessionTargets: '/reporter/v1/session-targets', // GET: the bucket's targets with each session's live status
  /**
   * POST the build the page declared, once per page load of a signed-in panel: recorded as an OBSERVED (`widget`) deployment of the
   * token's bucket for the SITE's repo and environment, verified only when the commit exists in a checkout of the repo.
   */
  observedBuild: '/reporter/v1/observed-build',
  sessions: '/reporter/v1/sessions', // GET
  /**
   * Chat in the widget (PILOT-1111), only for a session of the token's bucket (linked to one of its tickets, in its default workspace, or one
   * of its direct-report targets); any other id is the same 404. GET a page (ReporterChatPage), POST ReporterChatSendRequest (rate limited).
   */
  sessionMessages: '/reporter/v1/sessions/:id/messages',
  /** GET ?after=<seq>: NDJSON ReporterChatStreamLine while the panel shows the chat (fetch with the bearer token; closed after 5 minutes). */
  sessionStream: '/reporter/v1/sessions/:id/stream',
  /** GET an image a line of that session shows (images only). */
  sessionBlob: '/reporter/v1/sessions/:id/blobs/:blobId',
  knowledge: '/reporter/v1/knowledge', // GET ?q=
  note: '/reporter/v1/knowledge/note', // GET ?path=
} as const;
