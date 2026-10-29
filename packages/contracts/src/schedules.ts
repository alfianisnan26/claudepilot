// The schedules registry (T-965, general-manager PRD §9.2; built in T-968 S2b and T-965): every scheduler and background loop of the portal
// in one list, read by `GET /api/schedules`, the Portal MCP tool `schedules_list` and the Schedules page. Helpers outside the portal (the
// supervisor, a coordinator's monitor) report with `POST /api/schedules/heartbeat`.

import type { TriggerSource } from './triggers.js';

/**
 * `loop`: a portal loop (its heartbeat, or the measured runner of platform/loops.ts); `trigger`: a trigger of any source (docs/prd/triggers.md);
 * `helper`: something outside the portal that sends a heartbeat. Pipelines with a schedule are not yet a CI feature.
 */
export type ScheduleKind = 'loop' | 'trigger' | 'helper';

/**
 * `ok`: the last run went well (or the loop has not run yet and is not late); `failing`: the last run failed; `stale`: running, but the
 * last heartbeat (or the start, before the first one) is older than two intervals; `stopped`: the loop is not running; `disabled`: a trigger
 * that is off or paused.
 */
export type ScheduleState = 'ok' | 'failing' | 'stale' | 'stopped' | 'disabled';

export interface ScheduleRow {
  /** `loop:<name>`, `trigger:<id>` or `helper:<name>`. */
  id: string;
  kind: ScheduleKind;
  name: string;
  /** The module that owns it (`tickets`, `triggers`, ...); for a trigger, the module `triggers`; for a helper, the kind it gave (`supervisor`, `monitor`). */
  module: string;
  /** What it does, one line; null for a trigger (its name says it). */
  description: string | null;
  /** Milliseconds between runs for a loop or a helper; null for a trigger. */
  interval_ms: number | null;
  /** A cron trigger's expression and time zone. */
  cron: { expr: string; tz: string } | null;
  last_run: string | null;
  /** `ok` or `failed`; null before the first run. */
  last_result: 'ok' | 'failed' | null;
  /** A loop's last error, cleaned of anything credential-shaped and cut to 200 characters. */
  last_error: string | null;
  next_run: string | null;
  state: ScheduleState;
  /** A trigger's source; null for loops and helpers. */
  source: TriggerSource | null;
  /** A trigger's owner (a user id); a helper's owner as it said (else its token's label); null for a loop. */
  owner: string | null;
  /** Where a trigger acts (its workspace); null otherwise. */
  target: string | null;
  /** What a trigger does when it fires (`session`, `ticket`, `ticket_session`); null otherwise. */
  action: string | null;
  /** A trigger's switch (paused counts as off); null for what cannot be switched (loops, helpers). */
  enabled: boolean | null;
}

/** `POST SCHEDULES_API.heartbeat` with `Authorization: Bearer <portal MCP token>` (operate or admin scope), never a cookie. */
export interface ScheduleHeartbeat {
  /** Lower case letters, digits, `.`, `_`, `-`; 1 to 64. The same name again is the same helper. */
  name: string;
  /** What it is, the same alphabet, 1 to 32: `supervisor`, `monitor`, `job`. */
  kind: string;
  /** Seconds between its beats, 10 to 604800 (7 days). Two missed intervals make it stale. */
  interval: number;
  /** Who runs it, at most 80 characters; the token's label when absent. */
  owner?: string;
  /** What it does, at most 200 characters. */
  description?: string;
}

export interface ScheduleHeartbeatAck {
  id: string;
  /** When the next beat is due; stale after twice that. */
  next_due: string;
  stale_after: string;
}

/** The heartbeat's bounds (`ScheduleHeartbeat`). */
export const SCHEDULE_HEARTBEAT_LIMITS = { intervalMinS: 10, intervalMaxS: 604_800, helpersMax: 100, nameMax: 64, kindMax: 32, ownerMax: 80, descriptionMax: 200 } as const;

/** One background loop of the portal, with what its runs did (platform/loops.ts; the Schedules page, owner 2026-10-18). */
export interface PortalLoop {
  id: string;
  what: string;
  everyMs: number;
  since: string;
  lastRunAt: string | null;
  lastMs: number | null;
  lastOk: boolean | null;
  lastError: string | null;
  runs: number;
  failures: number;
}

export const SCHEDULES_API = {
  /** GET: `{ items: ScheduleRow[] }` (T-968 S2b, T-965; the Schedules page and the manager's `schedules_list`). */
  list: '/api/schedules',
  /** POST `ScheduleHeartbeat` -> `ScheduleHeartbeatAck`: a helper outside the portal says it is alive (a portal MCP token, never a cookie). */
  heartbeat: '/api/schedules/heartbeat',
  /** Full session only. GET: `PortalLoop[]` (the measured loops with their run counts and durations; the Schedules page reads `list`). */
  loops: '/api/admin/loops',
} as const;

/* ---------- The General Manager (T-968, D-80) ---------- */

/** The person's manager as Home shows it. */
export interface ManagerStatus {
  enabled: boolean;
  sessionId: string | null;
  state: string | null;
  workspaceId: string | null;
  /** Its dedicated runtime (`kubernetes/general-manager`, no other session may run there), or null before Prepare. */
  runtime: { workspaceId: string; status: string } | null;
}

export const MANAGER_API = {
  /** Full session. GET: `ManagerStatus`. */
  status: '/api/admin/manager',
  /** Full session. POST: makes the dedicated runtime workspace when it is missing; `ManagerStatus`. */
  prepare: '/api/admin/manager/prepare',
  /** Full session. POST: makes and starts the person's one manager in its runtime; `ManagerStatus`. */
  enable: '/api/admin/manager/enable',
  /** Full session. POST: ends it (the transcript stays); `ManagerStatus`. */
  disable: '/api/admin/manager/disable',
} as const;
