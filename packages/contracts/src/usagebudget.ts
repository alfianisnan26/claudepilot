// Usage spend (docs/prd/claude-usage.md §21 to §26): who spent what (per session, workspace, ticket, persona and Claude, a
// session's children rolled up into it), budgets with alerts, and spike detection. Nothing here names an account.
//
// NUMBERS ARE NEVER INVENTED (round 4 plan, P1). A derived figure is the shared `Figure` of usage.ts: its value, how it is known
// (`measured`, `estimate`, `unavailable`) and, when unavailable, a fixed reason code (`UNAVAILABLE_TEXT` has the line for each). The page
// labels an estimate "est." and shows "-" with the reason in an InfoTip. Plain counters (tokens, requests) are stored values: measured.
// DOLLARS ARE ALWAYS AN ESTIMATE (`REQUEST_BASIS`): Claude Code prices tokens at API list prices; for a plan that is what the same use
// would cost on the API, not a bill. So every dollar figure here is `estimate`, and a budget in dollars is a budget in estimated dollars.

import type { ChatSessionState, ChatUsageRange, ChatUsageTotals } from './chat.js';
import type { UsageAlertLevel } from './claudeusage.js';
import type { Figure, UnavailableReason } from './usage.js';

/**
 * The shared reasons (usage.ts) and one of this feature's: `no_cost`, requests exist but Claude Code reported no dollars for them, so a
 * share of the dollars means nothing. (A page that does not know a code shows "Not available."; `reasonText` already falls back so.)
 */
export type SpendReason = UnavailableReason | 'no_cost';

/** A shared `Figure`, or one unavailable for this feature's own reason. Narrow on `basis` as for `Figure`. */
export type SpendFigure<T = number> = Figure<T> | { value: null; basis: 'unavailable'; reason: 'no_cost' };

/**
 * What a slice of requests used: dollars (an estimate), tokens, requests (finished turns) and sub-agents started. A request's
 * sub-agents run inside it and are counted once, in it.
 */
export type SpendTotals = ChatUsageTotals;

/** Tokens a budget counts: input + output + cache writes. Cache reads are shown beside them, not added. */
export const spendTokens = (t: Pick<ChatUsageTotals, 'input' | 'output' | 'cacheWrite'>): number => t.input + t.output + t.cacheWrite;

/* ---------- Attribution ---------- */

export const ATTRIBUTION_BY = ['session', 'workspace', 'ticket', 'persona', 'claude'] as const;
export type AttributionBy = (typeof ATTRIBUTION_BY)[number];

/** A session as an attribution row names it. After a delete, the title and links are the last ones recorded. */
export interface SessionFacts {
  sessionId: string;
  title: string;
  workspaceId: string;
  /** The part of the workspace id after the target: `docker/api` is `api`. */
  workspaceName: string;
  claudeId: string;
  claudeName: string;
  ticketId: string | null;
  /** The session that started this one, or null. A parent that is gone still shows here. */
  parentId: string | null;
  /**
   * The session this one continues (T-136 lineage, T-312), or null. A continuation's row sits right under the first row of its chain, whose
   * `total` is then the whole chain's.
   */
  continuedFrom: string | null;
  /** 0 for a root; rows of a session report come in tree order (a session, then the sessions it started), so this is the indent. */
  depth: number;
  /** Sessions this one started that have rows in the tree. */
  children: number;
  /** False once deleted: its requests stay, its title and links are from the last request recorded. */
  exists: boolean;
  state: ChatSessionState | null;
}

/**
 * One row of an attribution report.
 * `state`: `known` a real value; `none` recorded as having none ("No ticket", "No persona"); `unknown` not recorded (`reason` says
 * why): its totals are the real sums of requests whose attribution is not known, so the page shows the reason and the numbers, never a 0 for
 * the person, ticket or persona; `others` the roots left out of the list, summed (their children are in it).
 */
export interface AttributionRow {
  by: AttributionBy;
  /** Session id, workspace id, ticket id (`T-12`), persona pool id or Claude id; '' for `none` and `unknown`; `others` for the rest. */
  key: string;
  label: string;
  state: 'known' | 'none' | 'unknown' | 'others';
  reason?: SpendReason;
  /** The requests of this row's own sessions (for a session: its own, its sub-agents inside them). */
  own: SpendTotals;
  /** `own` plus the sessions it started, all the way down (by `session`). Equal to `own` for every other dimension. */
  total: SpendTotals;
  /** `total` dollars as a percent (0 to 100) of the window's dollars, so an `estimate`; unavailable (`no_samples`, `no_cost`) when there is nothing to divide by. */
  share: SpendFigure;
  /** Sessions with requests behind this row. */
  sessions: number;
  firstAt: string | null;
  lastAt: string | null;
  /** By `session` only. */
  session?: SessionFacts;
  /** By `ticket` only, a `known` row (T-449): the ticket's type and status, and the part of leads' cost apportioned to it. */
  ticket?: AttributionTicket;
}

/**
 * What a ticket row of the attribution says beyond its own requests (T-449). `own` of the row is what sessions working on the ticket spent;
 * `viaLead` is the part of a lead's cost (a session with no ticket that started workers on tickets) apportioned to it, by the number of its
 * workers with requests in the window, per ticket (`ATTRIBUTION_LEAD_BASIS`). The row's `total` is `own` plus `viaLead`.
 */
export interface AttributionTicket {
  /** Ticket type (feature, bug, task, ...), or null when the ticket is not known (deleted). */
  type: string | null;
  status: string | null;
  /** When it was closed as done (ISO), else null. */
  doneAt: string | null;
  /** Dollars (estimates) of leads' own requests apportioned to this ticket; 0 when none. */
  viaLeadUsd: number;
  /** Workers of leads on this ticket in the window: the weights behind `viaLeadUsd`. */
  viaLeadWorkers: number;
}

/** How a lead's cost is split over tickets: said in the response, never guessed. */
export const ATTRIBUTION_LEAD_BASIS =
  'A session with no ticket of its own that started workers on tickets (session_spawn with a ticket): its dollars in the window are split over those tickets in proportion to the number of its workers with requests in the window, per ticket. The parts add up to its dollars exactly (the remainder goes one millionth of a dollar at a time to the largest fractions, then the lower ticket number). A session with no worker on a ticket stays No ticket.';

/** Cost per done ticket by type (`by=ticket`): the tickets shown that were closed as done, grouped by type. */
export interface TicketTypeCost {
  type: string;
  tickets: number;
  costUsd: number;
  /** `costUsd` over `tickets`. */
  perTicketUsd: number;
}

/**
 * `GET USAGE_SPEND_API.attribution?by=&range=&claudeId=&workspaceId=&limit=&format=`: the window's requests grouped by one dimension.
 * - `session`: a tree. A session's `total` includes the sessions it started (`parent_id`), so the roots add up to `totals`.
 * - `ticket`: the session's ticket link; a child session with no ticket of its own counts under its parent's ticket.
 * - `persona`: the persona assigned to the session's workspace when its process last started, recorded from now on. Requests
 *   before that are `unknown` with `not_recorded`: never guessed. A persona never passes down to children.
 * - `workspace`, `claude`: where the request ran. A chat that moved to another Claude counts each turn where it ran.
 * `limit` caps the root rows of `session` (default 25, at most 200) and the rows of the other dimensions; the rest sum into `others`.
 * `format=csv` answers the rows as a CSV file.
 */
export interface AttributionReport {
  by: AttributionBy;
  range: ChatUsageRange;
  from: string;
  to: string;
  /** Every request in the window, attributed or not. The rows' totals add up to it (by `session`, the roots'). */
  totals: SpendTotals;
  /** The side questions' part of `totals` (`chat_usage.kind = 'side'`, chat PRD §20): counted in every row and total above, shown apart here. */
  side: SpendTotals;
  rows: AttributionRow[];
  /** The percent (0 to 100) of the window's dollars whose row is `known` or `none` (not `unknown`). 100 for every dimension but `persona` and `ticket` (a deleted session's ticket is unknown). */
  coverage: SpendFigure;
  /** Rows summed into `others`. */
  more: number;
  now: string;
  /** By `ticket` (T-449): the basis of every row's `viaLeadUsd` (`ATTRIBUTION_LEAD_BASIS`). */
  leadBasis?: string;
  /** By `ticket` with `done=1`: only tickets closed as done inside the window are rows (`totals` stays the window's). */
  doneOnly?: boolean;
  /** By `ticket`: the done-in-window tickets' cost (own plus via lead) grouped by type, most dollars first. */
  doneByType?: TicketTypeCost[];
}

/* ---------- Budgets ---------- */

export const BUDGET_PERIODS = ['day', 'month'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/** `all`: everything the portal runs. `claude`: one Claude. `workspace`: one workspace. */
export type BudgetScopeKind = 'all' | 'claude' | 'workspace';

/** `alert`: raise alerts and nothing else (the default). `pause`: also refuse new messages once used up; opt-in, never implied. */
export type BudgetMode = 'alert' | 'pause';

/** `id` is null exactly for `all`; a Claude's id or a workspace's id (`docker/api`) otherwise. */
export interface BudgetScope {
  kind: BudgetScopeKind;
  id: string | null;
}

/** `POST USAGE_SPEND_API.budgets` (all of it) and `PUT USAGE_SPEND_API.budget(id)` (only what changes). */
export interface BudgetInput {
  /** At most 60 characters; empty is fine (the page names it from its scope and period). */
  name?: string;
  scope: BudgetScope;
  period: BudgetPeriod;
  /** Estimated dollars (API-equivalent for a plan), above 0. At least one of `limitUsd` and `limitTokens` is needed. */
  limitUsd?: number | null;
  /** Input + output + cache-write tokens, above 0. */
  limitTokens?: number | null;
  mode?: BudgetMode;
  enabled?: boolean;
}

export interface Budget {
  id: string;
  name: string;
  scope: BudgetScope;
  period: BudgetPeriod;
  limitUsd: number | null;
  limitTokens: number | null;
  mode: BudgetMode;
  enabled: boolean;
  /** Who made it (a user id; `u_owner` for the one owner of today's portal). A budget per Claude is managed by admins, one per workspace by that workspace's managers. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** `near` from 80 %, `high` from 95 %, `exhausted` at 100 % (the thresholds of the plan windows). */
export type BudgetLevel = 'ok' | UsageAlertLevel;

export interface BudgetState {
  budget: Budget;
  /** What the scope is called now ("Satria · api", "api", "Everything"); null when a Claude no longer exists. */
  scopeLabel: string | null;
  /** The period being counted, in `timezone`: a day from its midnight, a month from the 1st. */
  periodStart: string;
  periodEnd: string;
  timezone: string;
  /** Estimated dollars used in the period (`estimate`). Always has a value (0 when nothing ran). */
  usedUsd: Figure;
  /** Input + output + cache-write tokens used in the period (`measured`). */
  usedTokens: Figure;
  /** Percent of the limit used; of the dollar limit (`estimate`), the token limit (`measured`), or the fuller of the two. Can exceed 100. */
  usedPct: Figure;
  /** Which limit `usedPct` is of. */
  limiting: 'usd' | 'tokens';
  level: BudgetLevel;
  /** New messages are refused now: mode `pause` and the budget is used up. A running turn is never stopped. */
  paused: boolean;
  snoozedUntil: string | null;
}

/** `GET USAGE_SPEND_API.budgets`. */
export interface BudgetsReport {
  budgets: BudgetState[];
  thresholds: { warn: number; critical: number };
  /** The portal's time zone setting (`usage.timezone`) that days and months are counted in. */
  timezone: string;
  now: string;
}

/** `PUT USAGE_SPEND_API.budgetSnooze(id)` `{ until }`. Not offered for a budget that pauses (its alerts are the warning). */
export type BudgetSnoozeUntil = '1h' | '4h' | 'reset';

/* ---------- Spikes ---------- */

/**
 * `rate`: the last 15 minutes of a Claude cost much more than that Claude's usual. `burst`: one session finished many requests in a
 * few minutes (a loop between turns: a ticket, CI or another session answering each other). `outlier`: one request cost far more than the
 * median request. Rules of thumb, always labelled heuristic; they alert and never act.
 */
export const SPIKE_KINDS = ['rate', 'burst', 'outlier'] as const;
export type SpikeKind = (typeof SPIKE_KINDS)[number];

/** The sensitivity in force, from Settings (`usage.spikes.*`). */
export interface SpikeSettings {
  enabled: boolean;
  /** `rate`: spend of the last 15 minutes against this multiple of the 90th percentile of the Claude's active 15-minute periods over 7 days. */
  rateFactor: number;
  /** `burst`: this many finished requests by one session within `burstWindowMin` minutes. */
  burstRequests: number;
  burstWindowMin: number;
  /** `outlier`: a request this many times the median request over 7 days. */
  outlierFactor: number;
  /** Nothing smaller than this many estimated dollars is a spike. */
  minUsd: number;
}

/** What a spike rests on; every number says how it is known. */
export type SpikeEvidence =
  | {
      kind: 'rate';
      windowMin: number;
      spentUsd: SpendFigure;
      /** The 90th percentile (nearest rank) of the Claude's active 15-minute periods over the 7 days before. */
      baselineUsd: SpendFigure;
      factor: SpendFigure;
      /** Active 15-minute periods behind the baseline. */
      periods: number;
      /** The session that spent most of the window, when it spent at least half; `share` is its percent (0 to 100) of the window's dollars; else null. */
      topSession: { sessionId: string; share: number } | null;
    }
  | { kind: 'burst'; requests: number; windowMin: number; threshold: number; spentUsd: SpendFigure }
  | {
      kind: 'outlier';
      costUsd: SpendFigure;
      /** The median request over the 7 days before. */
      medianUsd: SpendFigure;
      factor: SpendFigure;
      /** Requests behind the median. */
      requests: number;
    };

export interface SpikeEvent {
  id: string;
  kind: SpikeKind;
  at: string;
  /** Always true: a rule of thumb, not proof that anything is wrong. */
  heuristic: true;
  /** The session it names (burst, outlier; rate when one chat dominates, by the first row of its continued chain); null otherwise. */
  sessionId: string | null;
  sessionTitle: string | null;
  claudeId: string;
  claudeName: string;
  workspaceId: string;
  workspaceName: string;
  evidence: SpikeEvidence;
  /** One terse line: "24 requests in 10 min (limit 20)". */
  summary: string;
  /** An alert was raised (not when its subject was snoozed). */
  alerted: boolean;
  /** Who it is for (a user id; `u_owner` today): the manager of what it is about once the portal has several users. */
  owner: string;
  /**
   * What a snooze of this event covers: the session (burst, outlier) or the Claude (rate). For a session it is the first row of its
   * `continued_from` chain (T-312): the rows of a continued chat share one cooldown and one snooze.
   */
  subject: string;
  /** Until when its subject is snoozed, if it is. */
  snoozedUntil: string | null;
}

/** `GET USAGE_SPEND_API.spikes?range=1d|7d|30d`: events newest first. */
export interface SpikesReport {
  range: '1d' | '7d' | '30d';
  events: SpikeEvent[];
  settings: SpikeSettings;
  now: string;
}

/** `PUT USAGE_SPEND_API.spikeSnooze` `{ subject, until }`: mutes alerts for that session or Claude. Events are still recorded. */
export type SpikeSnoozeUntil = '1h' | '4h' | 'day';

/* ---------- Alerts and the summary ---------- */

/**
 * What an alert is about: everything, a workspace, a Claude or a session. `label` names it for a person (a workspace's name, a Claude's name);
 * it is null for `all` and for a session, whose title is the page's to look up (it is text from elsewhere, so it is never carried here).
 */
export interface SpendAlertScope {
  kind: 'all' | 'workspace' | 'claude' | 'session';
  /** A workspace id, a Claude id or a session id; null for `all`. */
  id: string | null;
  label: string | null;
}

/**
 * One alert. `id` is stable (a budget's: `budget|<budget id>|<level>|<period start ms>`, a spike's: `spike|<event id>`), so a page shows each only
 * once and a notification is sent once per id. Every alert carries its `level`, its `scope` and no secret: only ids, names, numbers and one terse line.
 * They also go to in-process listeners as they are raised (`UsageSpend.onAlert`, where push notifications plug in).
 */
export type SpendAlert =
  | {
      kind: 'budget';
      id: string;
      at: string;
      level: UsageAlertLevel;
      scope: SpendAlertScope;
      /** Who the alert is for: the budget's owner (a user id; `u_owner` today). Notifications route on it. */
      owner: string;
      /** The workspace it concerns, for routing: the budget's own workspace, a Claude budget's workspace; null for a budget on everything. */
      workspaceId: string | null;
      /** One terse line: "api daily: 95 %", "Everything monthly: used up". */
      summary: string;
      budgetId: string;
      budgetName: string;
      scopeLabel: string | null;
      usedPct: number;
      periodEnd: string;
      /** New messages are refused until the period ends or the budget changes. */
      paused: boolean;
    }
  | {
      kind: 'spike';
      id: string;
      at: string;
      /** Always `near`: a heads-up. A spike is a rule of thumb with its evidence, not a quota level and not proof that anything is wrong. */
      level: UsageAlertLevel;
      /** `claude` for a rate spike (a Claude's last 15 minutes), `session` for a loop or a single large request. */
      scope: SpendAlertScope;
      /** Who the alert is for (a user id; `u_owner` today): the manager of what it is about once the portal has several users. Notifications route on it. */
      owner: string;
      /** One terse line: "24 requests in 10 min (limit 20)". */
      summary: string;
      spikeId: string;
      spikeKind: SpikeKind;
      /** The session the spike happened in (a rate spike: the chat that spent most of it, by the first row of its chain). */
      sessionId: string | null;
      /**
       * The first row of that session's `continued_from` chain (T-312): a chat continued as new rows is one subject, so the alerts of its rows
       * group under this id. The session itself when it continues nothing; null when the spike names no session.
       */
      rootSessionId: string | null;
      claudeId: string;
      workspaceId: string;
      heuristic: true;
    };

/** `GET USAGE_SPEND_API.summary`: what a header strip, the Needs-attention widget and the MCP summary read. */
export interface SpendSummary {
  /** Since midnight, since Monday's midnight and since the 1st, in `timezone`. */
  today: SpendTotals;
  week: SpendTotals;
  month: SpendTotals;
  timezone: string;
  budgets: { total: number; near: number; high: number; exhausted: number; paused: number };
  /** Spike events in the last day. */
  spikes24h: number;
  /** The last day's alerts that are not snoozed, newest first. */
  alerts: SpendAlert[];
  now: string;
}

/** What a person changed here, and who did: a budget made, changed, snoozed or removed, a spike snoozed. Ids and what was done (a budget's scope, period and limits are settings); never usage amounts or workspace text. */
export interface SpendAuditEntry {
  id: number;
  at: string;
  /** The user (`u_owner` today). */
  actor: string;
  /** How: `ui`, or `portal-mcp:<token id>`. */
  via: string;
  action: 'budget.create' | 'budget.update' | 'budget.delete' | 'budget.snooze' | 'budget.unsnooze' | 'spike.snooze' | 'spike.unsnooze';
  objectKind: 'budget' | 'spike_subject';
  objectId: string;
  /** One terse line: "daily budget for api, $10, pauses". */
  summary: string;
}

/**
 * Routes. The live topic is the existing `claudeusage`: its push also means "a budget or spike alert fired or a budget changed, load
 * these again" (no new socket type). Every route sits behind the session guard like the rest of `/api`.
 */
export const USAGE_SPEND_API = {
  /** GET: `SpendSummary`. */
  summary: '/api/usage-spend',
  /** GET `?by=session|workspace|ticket|persona|claude&range=30m|1h|12h|1d|7d|30d&claudeId=&workspaceId=&limit=&done=1&format=json|csv`: `AttributionReport` (`done=1`, by ticket only: tickets closed as done in the window). */
  attribution: '/api/usage-spend/attribution',
  /** GET: `BudgetsReport`. POST `BudgetInput`: the new `BudgetState` (201). */
  budgets: '/api/usage-spend/budgets',
  /** PUT `BudgetInput` (only what changes): `BudgetState`. DELETE: `{ id }`. */
  budget: (id: string) => `/api/usage-spend/budgets/${encodeURIComponent(id)}`,
  /** PUT `{ until: BudgetSnoozeUntil }`: `BudgetState`. DELETE ends the snooze. 409 for a budget that pauses. */
  budgetSnooze: (id: string) => `/api/usage-spend/budgets/${encodeURIComponent(id)}/snooze`,
  /** GET `?range=1d|7d|30d`: `SpikesReport`. */
  spikes: '/api/usage-spend/spikes',
  /** PUT `{ subject, until: SpikeSnoozeUntil }`: `SpikesReport`. DELETE `?subject=` ends it. */
  spikeSnooze: '/api/usage-spend/spikes/snooze',
  /** GET: `SpendAlert[]`, the last day's that are not snoozed, newest first (also in `SpendSummary.alerts`). */
  alerts: '/api/usage-spend/alerts',
  /** GET `?limit=` (default 50, at most 200): `SpendAuditEntry[]`, newest first. */
  audit: '/api/usage-spend/audit',
} as const;

/** The Portal MCP tools of this feature (docs/prd/claude-usage.md §26). Only `usage_budget_set` and `usage_budget_delete` change anything, and only for an admin's token. */
export const USAGE_SPEND_TOOLS = ['usage_summary', 'usage_attribution', 'usage_budgets', 'usage_spikes', 'usage_budget_set', 'usage_budget_delete'] as const;
