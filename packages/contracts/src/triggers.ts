// Triggers and schedules (docs/prd/triggers.md): start a chat session or a ticket from a cron schedule, from a webhook of a Git host
// (Gitea, GitHub, GitLab: push, pull request, issue, comment) or from a failed CI run. Each trigger has limits that are checked BEFORE a
// run starts (parallel runs, runs per hour and per day, an estimated cost per run and per day, minutes), approval rules, and a run
// history. A trigger is a person's standing instruction; what arrives from a webhook is UNTRUSTED input to an agent.
//
// MULTI-USER (PLAN-10): a trigger has an OWNER and runs with that owner's rights, limits and approval rules: before every run the owner's
// `can(owner, 'operate', workspace)` is checked again (a revoked share or a disabled user skips the run). The receiver `/hooks/<token>` is
// platform-wide and public; the trigger it finds names the owner. The master switch and the global caps are admin settings. Per-person
// rows carry `owner_id TEXT NOT NULL DEFAULT 'u_owner'`; a user lists and edits only their own triggers (an admin lists all).
//
// The rules this file encodes (the PRD says why):
// - The public receiver is `POST /hooks/<token>`, outside `/api` and outside the session guard; it is authenticated by the provider's
//   signature, and answers the same thing for an accepted and an ignored delivery.
// - Free text from an event (a title, a body, a comment, commit messages, a log tail) is NEVER put in an instruction: a template may
//   name only the facts in `TRIGGER_VARIABLES.safe`; the free text goes in a labelled block after the instruction.
// - A trigger-started session runs in the permission mode `default`, `plan` or `acceptEdits`: never Bypass, never `dontAsk`.
// - Every figure about cost is an estimate (Claude Code prices tokens at API list prices; for a plan that is not a bill).

import type { TicketPriority, TicketType } from './tickets.js';
import type { Figure } from './usage.js';

export const TRIGGER_SOURCES = ['cron', 'webhook', 'ci_failed'] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export const WEBHOOK_PROVIDERS = ['gitea', 'github', 'gitlab'] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

/** What a webhook trigger can listen to, normalised across providers (a provider's own words map onto these, triggers PRD section 7). */
export const WEBHOOK_EVENTS = ['push', 'pull_request', 'issue', 'comment'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** The normalised actions of each event. `push` has one. A pull request's `merged` is a `closed` whose merge flag is set. */
export const WEBHOOK_ACTIONS: Record<WebhookEvent, readonly string[]> = {
  push: ['pushed'],
  pull_request: ['opened', 'updated', 'reopened', 'closed', 'merged', 'labeled'],
  issue: ['opened', 'reopened', 'closed', 'labeled'],
  comment: ['created'],
};

export const TRIGGER_ACTION_TYPES = ['session', 'ticket', 'ticket_session'] as const;
export type TriggerActionType = (typeof TRIGGER_ACTION_TYPES)[number];

/** The modes a trigger's session may start in. Bypass is never one of them, and neither is `dontAsk`. */
export const TRIGGER_PERMISSION_MODES = ['default', 'plan', 'acceptEdits'] as const;
export type TriggerPermissionMode = (typeof TRIGGER_PERMISSION_MODES)[number];

/* ---------- Specs ---------- */

/**
 * Five fields (minute hour day-of-month month day-of-week), POSIX syntax plus steps (`*` + `/5`, `1-5`, lists), month and weekday names;
 * 7 is Sunday. When both day fields are restricted a day matches if EITHER does (POSIX). No seconds, no `L`, `W`, `#`, no `@` aliases.
 * `tz` is an IANA zone. A time that does not exist (a clock change forward) fires once, right after the gap; a time that happens twice
 * fires once, the first time. `catchUp`: a time missed while the portal was off is recorded as skipped (`skip`) or run once (`once`),
 * never as a burst.
 */
export interface CronSpec {
  expr: string;
  tz: string;
  catchUp: 'skip' | 'once';
}

export interface WebhookSpec {
  provider: WebhookProvider;
  /**
   * The Git host's name (`github.com`, `git.example.com`): only used to check that a link in an event points at that host and to write the
   * setup instructions; the portal never calls it. Null for GitHub means `github.com`.
   */
  host: string | null;
  /** At least one. */
  events: WebhookEvent[];
  /** Normalised actions; empty means every action of the chosen events. */
  actions: string[];
  /** `owner/name` patterns (`*` inside a segment); empty means whatever repository the webhook is installed on. */
  repos: string[];
  /** Patterns against the pushed branch, or a pull request's target branch; empty means any. */
  branches: string[];
  /** The issue or pull request must carry one of these labels; empty means any. */
  labels: string[];
  /** GitLab only: `signing` (a signing token, GitLab 19.0 and later) or `token` (the older plain secret token). */
  gitlabAuth: 'signing' | 'token';
}

export interface CiFailedSpec {
  /** Empty (null) means any workspace, repository, pipeline. */
  workspaceId: string | null;
  repo: string | null;
  pipeline: string | null;
  branches: string[];
  /** The same repository, pipeline and branch does not fire again for this many minutes (the loop guard). */
  cooldownMin: number;
  /** And not more than this many times per day for one branch. */
  maxPerBranchPerDay: number;
}

/* ---------- Action, limits, approval ---------- */

export interface TriggerAction {
  type: TriggerActionType;
  workspaceId: string;
  /** Which Claude on that workspace; null: its Default. */
  claudeId: string | null;
  /** A folder in the workspace; null: its work folder. */
  cwd: string | null;
  /** Run in a git worktree of its own. */
  worktree: boolean;
  permissionMode: TriggerPermissionMode;
  /** The instruction, with `{{variables}}` from the safe list. Event text reaches the session only in the labelled block. */
  template: string;
  /** For `ticket` and `ticket_session`. `assignTo` `queue`: the agents' queue; `owner`: assigned to the trigger's owner ("Needs you", and a `human_request` notification). */
  ticket: { type: TicketType; priority: TicketPriority; tags: string[]; assignTo: 'queue' | 'owner' } | null;
}

export interface TriggerLimits {
  /** Runs starting or running at once. */
  maxParallel: number;
  maxPerHour: number;
  maxPerDay: number;
  /** Estimated dollars one run may spend before it is stopped (Claude Code's own estimate). */
  costUsdPerRun: number;
  /** Estimated dollars all runs of this trigger may spend in a day (its time zone) before new runs are skipped. */
  costUsdPerDay: number;
  /** A run still going after this many minutes is stopped. */
  maxMinutes: number;
}

/** Every limit has a bound and a default; none can be switched off (every automatic action has a limit). The defaults are design choices, not measurements. */
export const TRIGGER_LIMIT_BOUNDS: Record<keyof TriggerLimits, { min: number; max: number; default: number }> = {
  maxParallel: { min: 1, max: 5, default: 1 },
  maxPerHour: { min: 1, max: 60, default: 4 },
  maxPerDay: { min: 1, max: 500, default: 12 },
  costUsdPerRun: { min: 0.1, max: 100, default: 2 },
  costUsdPerDay: { min: 0.1, max: 1000, default: 10 },
  maxMinutes: { min: 1, max: 480, default: 45 },
};

export const TRIGGER_DEFAULT_LIMITS: TriggerLimits = {
  maxParallel: TRIGGER_LIMIT_BOUNDS.maxParallel.default,
  maxPerHour: TRIGGER_LIMIT_BOUNDS.maxPerHour.default,
  maxPerDay: TRIGGER_LIMIT_BOUNDS.maxPerDay.default,
  costUsdPerRun: TRIGGER_LIMIT_BOUNDS.costUsdPerRun.default,
  costUsdPerDay: TRIGGER_LIMIT_BOUNDS.costUsdPerDay.default,
  maxMinutes: TRIGGER_LIMIT_BOUNDS.maxMinutes.default,
};

/**
 * When a run waits for a person. `always`: every run. `untrusted`: a run whose sender is not in `trustedSenders` (cron and CI runs have
 * no sender and are trusted). `never`: runs start by themselves. A webhook trigger defaults to `always`; setting it to `never` asks for a
 * confirmation. A pending run expires after `ttlHours`.
 */
export interface TriggerApproval {
  mode: 'always' | 'untrusted' | 'never';
  trustedSenders: string[];
  ttlHours: number;
}

export const TRIGGER_APPROVAL_DEFAULT: Record<TriggerSource, TriggerApproval['mode']> = { cron: 'never', webhook: 'always', ci_failed: 'never' };

/* ---------- The trigger ---------- */

export interface Trigger {
  /** `trg_` + 12 hex. */
  id: string;
  /** The user who owns it and whose rights it runs with. Set from the signed-in user at creation; it does not change. */
  ownerId: string;
  name: string;
  enabled: boolean;
  source: TriggerSource;
  cron: CronSpec | null;
  /**
   * `path` is the public receiver path (`/hooks/<token>`, a capability: shown in the trigger's own page only); `secretSet` says a signing
   * secret exists (never its value). `secretMode`: `generated` (the portal made it and showed it once: GitHub, Gitea, GitLab's secret token)
   * or `provided` (GitLab's signing token is made by GitLab and shown once there: the owner pastes it into the portal with `TRIGGER_API.setSecret`).
   * Until a secret is set the receiver answers every delivery 401.
   */
  webhook: (WebhookSpec & { path: string; secretSet: boolean; secretMode: 'generated' | 'provided' }) | null;
  ciFailed: CiFailedSpec | null;
  action: TriggerAction;
  limits: TriggerLimits;
  approval: TriggerApproval;
  /** The next cron time, when the trigger is enabled and the master switch is on. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  runsToday: number;
  /** Today's estimated cost of its runs (its day starts at midnight in `cron.tz`, or in the portal's zone). Always an estimate. */
  costToday: Figure;
  createdAt: string;
  updatedAt: string;
}

/** `POST TRIGGER_API.list`; `PATCH TRIGGER_API.one(id)` takes the same fields, all optional. */
export interface TriggerInput {
  name: string;
  enabled?: boolean;
  source: TriggerSource;
  cron?: CronSpec;
  webhook?: WebhookSpec;
  ciFailed?: CiFailedSpec;
  action: TriggerAction;
  limits?: Partial<TriggerLimits>;
  approval?: Partial<TriggerApproval>;
  /** Required when the change removes a protection (a webhook trigger set to approval `never`). */
  confirm?: boolean;
}

export interface CreatedTrigger {
  trigger: Trigger;
  /** The webhook's signing secret, once; null for other sources and for a GitLab trigger that uses the signing token (GitLab makes that one: paste it into the portal afterwards). Paste it into the Git host's webhook form. */
  secret: string | null;
}

/** The master switch and the global cap (settings `triggers.*`). Off until a person turns it on. */
export const TRIGGER_SETTING_KEYS = {
  enabled: 'triggers.enabled',
  /** Runs starting or running across all triggers. */
  maxParallelTotal: 'triggers.maxParallelTotal',
  /** Runs starting or running for one owner, so one user cannot use up the others' share. */
  maxParallelPerOwner: 'triggers.maxParallelPerOwner',
  /** The time zone of a cron that has none, and of "today" for limits. */
  timezone: 'triggers.timezone',
} as const;

/* ---------- Events and runs ---------- */

/**
 * An event as the pipeline uses it, after the receiver verified it and extracted these fields. Everything in it was validated (a login, a
 * repository name, a branch, a sha, an https URL on the provider's host) or is in `untrusted`, clipped, redacted, and shown to people and
 * to the agent as untrusted text only.
 */
export interface TriggerEventFacts {
  source: TriggerSource;
  provider: WebhookProvider | null;
  event: WebhookEvent | 'schedule' | 'ci_failed';
  action: string | null;
  repo: string | null;
  branch: string | null;
  sha: string | null;
  number: number | null;
  /** A login that matched `[A-Za-z0-9._-]{1,64}`; otherwise null. */
  sender: string | null;
  /** The event's page on the Git host; an https URL on the host named in the trigger, else null. */
  url: string | null;
  /** A pull request whose source is another repository (a fork): its sender is never trusted by default. Null when the provider does not say. */
  fork: boolean | null;
  at: string;
  /** CI: the run that failed. */
  ci?: { runId: string; runNumber: number; pipeline: string; reason: string | null; ticketId: string | null; workspaceId: string };
  /** Free text, each at most 4,000 characters. */
  untrusted: { title?: string; body?: string; comment?: string; commits?: string; labels?: string; logTail?: string };
}

export const TRIGGER_RUN_STATES = ['pending_approval', 'starting', 'running', 'succeeded', 'failed', 'skipped', 'denied', 'expired', 'stopped'] as const;
export type TriggerRunState = (typeof TRIGGER_RUN_STATES)[number];

/** Why a run did not start, or ended as it did. Fixed codes; the page has one short line for each. */
export const TRIGGER_REASONS = [
  'master_off', // triggers are switched off
  'disabled',
  'filtered', // the event did not match the trigger's filters
  'duplicate', // the same delivery id again
  'parallel_limit',
  'hour_limit',
  'day_limit',
  'cost_day_limit',
  'cost_run_limit', // stopped: the run's estimated cost passed its limit
  'time_limit', // stopped: it ran past its minutes
  'cooldown', // the loop guard
  'self_triggered', // caused by a session this trigger started
  'missed', // a cron time passed while the portal was off
  'workspace_gone',
  'workspace_stopped',
  'locked', // the portal is Locked or Frozen
  'emergency', // the emergency stop was used
  'denied', // a person skipped it
  'expired', // nobody approved it in time
  'owner_denied', // the owner may no longer operate that workspace (a share was revoked): nothing started
  'owner_disabled', // the owner's account is disabled
  'start_failed', // the session could not start
  'session_failed', // the session ended with an error
  'invalid_event',
] as const;
export type TriggerReason = (typeof TRIGGER_REASONS)[number];

export interface TriggerRun {
  /** `run_` + 12 hex. */
  id: string;
  triggerId: string;
  triggerName: string;
  /** The trigger's owner when the run was made. */
  ownerId: string;
  at: string;
  state: TriggerRunState;
  reason: TriggerReason | null;
  event: TriggerEventFacts;
  /** The provider's delivery id (`X-GitHub-Delivery`, `X-Gitea-Delivery`, GitLab's `webhook-id`), the key that stops a redelivery from running twice. */
  deliveryId: string | null;
  sessionId: string | null;
  ticketId: string | null;
  /** The estimated cost of the session and the agents under it. */
  costUsd: Figure;
  startedAt: string | null;
  endedAt: string | null;
  /** Who approved it: `ui` or `device:<destination id>`. */
  approval: { by: string; at: string } | null;
}

export interface TriggerRunPage {
  items: TriggerRun[];
  /** The `at` to pass as `before` for the next page; null at the end. */
  next: string | null;
}

/** `POST TRIGGER_API.test`: what a trigger would do with a sample event, without starting anything. */
export interface TriggerTestResult {
  /** The event the sample made. */
  event: TriggerEventFacts;
  matches: boolean;
  /** Why it would not match or would not start (a `TriggerReason`), else null. */
  reason: TriggerReason | null;
  /** The instruction and the untrusted block exactly as the session would get them. */
  opening: string;
  /** Cron: the next five times, ISO, in UTC. */
  nextRuns: string[];
}

/* ---------- Templates ---------- */

/**
 * What a template may name. `safe` facts are validated or generated by the portal and may stand in the instruction. `untrusted` ones are
 * free text: a template may only list them in `{{untrusted.<name>}}`, and they are rendered inside the labelled block, never inline.
 */
export const TRIGGER_VARIABLES: Record<TriggerSource, { safe: readonly string[]; untrusted: readonly string[] }> = {
  cron: { safe: ['trigger.name', 'time', 'date', 'cron'], untrusted: [] },
  webhook: {
    safe: ['trigger.name', 'time', 'date', 'provider', 'event', 'action', 'repo', 'branch', 'sha', 'short_sha', 'number', 'sender', 'url'],
    untrusted: ['title', 'body', 'comment', 'commits', 'labels'],
  },
  ci_failed: {
    safe: ['trigger.name', 'time', 'date', 'repo', 'branch', 'sha', 'short_sha', 'pipeline', 'run_number', 'run_id', 'reason', 'ticket'],
    untrusted: ['logTail'],
  },
};

export const TRIGGER_TEMPLATE_MAX = 4000;

/* ---------- The public receiver ---------- */

/** `POST /hooks/<token>`: not under `/api`, no session; authenticated by the provider's signature. Anything else answers 404. */
export const HOOK_PREFIX = '/hooks/';
export const HOOK_TOKEN_PREFIX = 'cpwh_';
/** The generated signing secret (shown once; the Git host's webhook form takes it). */
export const HOOK_SECRET_PREFIX = 'cpws_';
/** Largest body read. GitHub caps its own payloads at 25 MB; a larger one is refused with 413 (the trigger never sees it). */
export const HOOK_MAX_BYTES = 1_048_576;
/** A body must arrive within this many seconds. */
export const HOOK_READ_TIMEOUT_S = 10;
/** Signature replay window for the schemes that carry a timestamp (GitLab's signing token), in seconds. */
export const HOOK_TIMESTAMP_SKEW_S = 300;
/** How long a delivery id is remembered, in days. */
export const HOOK_DELIVERY_TTL_DAYS = 7;

/** The headers each provider sends (lowercase). */
export const HOOK_HEADERS: Record<WebhookProvider, { event: string; delivery: string; signature: readonly string[] }> = {
  github: { event: 'x-github-event', delivery: 'x-github-delivery', signature: ['x-hub-signature-256'] },
  gitea: { event: 'x-gitea-event', delivery: 'x-gitea-delivery', signature: ['x-gitea-signature', 'x-hub-signature-256'] },
  gitlab: { event: 'x-gitlab-event', delivery: 'webhook-id', signature: ['webhook-signature', 'x-gitlab-token'] },
};

export const TRIGGER_API = {
  /** GET: `Trigger[]`. POST `TriggerInput`: `CreatedTrigger`. */
  list: '/api/triggers',
  /** GET: `Trigger`. PATCH `Partial<TriggerInput>`: `Trigger`. DELETE: remove it (its runs stay in the history for 90 days). */
  one: (id: string) => `/api/triggers/${encodeURIComponent(id)}`,
  /** POST: fire it now with a manual event (cron and CI triggers; the limits and approval apply); `TriggerRun`. */
  run: (id: string) => `/api/triggers/${encodeURIComponent(id)}/run`,
  /** POST `{ sample?: Partial<TriggerEventFacts> }`: `TriggerTestResult`. Starts nothing. */
  test: (id: string) => `/api/triggers/${encodeURIComponent(id)}/test`,
  /** POST `TriggerInput`: `TriggerTestResult` for a trigger not saved yet (validation, the rendered opening, the next cron times). */
  preview: '/api/triggers/preview',
  /** GET `?before=&limit=&state=`: `TriggerRunPage`. */
  runs: (id: string) => `/api/triggers/${encodeURIComponent(id)}/runs`,
  /** GET `?before=&limit=&state=&trigger=`: `TriggerRunPage` across every trigger. */
  allRuns: '/api/triggers/runs',
  /** GET: `TriggerRun`. */
  runOne: (id: string, runId: string) => `/api/triggers/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`,
  /** POST: approve a pending run (it starts, limits checked again). */
  approve: (id: string, runId: string) => `/api/triggers/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/approve`,
  /** POST: skip a pending run. */
  skip: (id: string, runId: string) => `/api/triggers/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/skip`,
  /** POST: stop a starting or running run (its session is ended). */
  stop: (id: string, runId: string) => `/api/triggers/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/stop`,
  /**
   * After a re-check of the server code. POST: a new generated signing secret, `{ secret }`, shown once (GitHub, Gitea, GitLab's secret
   * token). PUT `{ secret }`: set the signing token GitLab generated (`whsec_` + base64, 16 to 128 bytes decoded); `Trigger`.
   */
  secret: (id: string) => `/api/triggers/${encodeURIComponent(id)}/secret`,
  /** POST (after a re-check of the server code): a new receiver path; `Trigger`. The old one answers 404 at once. */
  rotateUrl: (id: string) => `/api/triggers/${encodeURIComponent(id)}/url`,
} as const;
