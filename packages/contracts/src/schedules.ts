// The schedules registry (T-965, general-manager PRD §9.2; built in T-968 S2b): every scheduler and background loop of the portal in one
// list, read by `GET /api/schedules` and the Portal MCP tool `schedules_list`. Read only today; the actions, the helpers' heartbeat route
// and the page are later slices (PRD §9.2).



/** `loop`: a portal loop that calls its heartbeat; `trigger`: a cron trigger (docs/prd/triggers.md). Pipelines with a schedule are not yet a CI feature. */
export type ScheduleKind = 'loop' | 'trigger';

/**
 * `ok`: the last run went well (or the loop has not run yet and is not late); `failing`: the last run failed; `stale`: running, but the
 * last heartbeat (or the start, before the first one) is older than two intervals; `stopped`: the loop is not running; `disabled`: a trigger
 * that is off or paused.
 */
export type ScheduleState = 'ok' | 'failing' | 'stale' | 'stopped' | 'disabled';

export interface ScheduleRow {
  /** `loop:<name>` or `trigger:<id>`. */
  id: string;
  kind: ScheduleKind;
  name: string;
  /** The module that owns it (`tickets`, `triggers`, ...); for a trigger, the module `triggers`. */
  module: string;
  /** What it does, one line; null for a trigger (its name says it). */
  description: string | null;
  /** Milliseconds between runs for a loop; null for a cron trigger (its expression is in `cron`). */
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
}

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
  /** GET: `ScheduleRow[]` (T-968 S2b; the manager's `schedules_list`). */
  list: '/api/schedules',
  /** Full session only. GET: `PortalLoop[]` (the Schedules page). The cron triggers come from `TRIGGER_API.list`. */
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
