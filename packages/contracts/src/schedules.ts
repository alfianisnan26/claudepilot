// The schedules registry (T-965, general-manager PRD §9.2; built in T-968 S2b): every scheduler and background loop of the portal in one
// list, read by `GET /api/schedules` and the Portal MCP tool `schedules_list`. Read only today; the actions, the helpers' heartbeat route
// and the page are later slices (PRD §9.2).

export const SCHEDULES_API = { list: '/api/schedules' } as const;

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
