// The Schedules page's pure parts (T-965): the order (what needs a look first), the kind filter, and the line under each row. The rows come
// from `GET /api/schedules` (general-manager PRD §9.2); nothing here guesses a number the server did not send.

import type { ScheduleKind, ScheduleRow, ScheduleState } from '@portal/contracts';

export type KindFilter = 'all' | ScheduleKind;

/** `every 30 s`, `every 6 h`, `daily`. */
export function everyText(ms: number): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return ms === 86_400_000 ? 'daily' : `every ${ms / 86_400_000} d`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `every ${ms / 3_600_000} h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `every ${ms / 60_000} min`;
  return `every ${Math.round(ms / 1000)} s`;
}

/** Failing first, then stale, then stopped; what is fine and what is off last. */
const RANK: Record<ScheduleState, number> = { failing: 0, stale: 1, stopped: 2, ok: 3, disabled: 4 };

/** The rows of one kind (or all), what needs a look first; the server's order within a state. */
export function visibleRows(rows: readonly ScheduleRow[], kind: KindFilter): ScheduleRow[] {
  return rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => kind === 'all' || r.kind === kind)
    .sort((a, b) => RANK[a.r.state] - RANK[b.r.state] || a.i - b.i)
    .map(({ r }) => r);
}

/** How many rows need a look (failing or stale). */
export const attentionCount = (rows: readonly ScheduleRow[]): number => rows.filter((r) => r.state === 'failing' || r.state === 'stale').length;

export const STATE_LABEL: Record<ScheduleState, string> = { ok: 'OK', failing: 'Failing', stale: 'Late', stopped: 'Stopped', disabled: 'Off' };
export const STATE_TONE: Record<ScheduleState, 'success' | 'danger' | 'warning' | 'neutral'> = {
  ok: 'success',
  failing: 'danger',
  stale: 'warning',
  stopped: 'neutral',
  disabled: 'neutral',
};

const SOURCE_LABEL: Record<string, string> = { cron: 'cron', ci_failed: 'on a failed CI run', webhook: 'webhook' };

/**
 * The line under a row's name: how often (or the cron), the last and next run, a trigger's source, target and action, a helper's owner, and
 * a failure. `ago` turns a time into words (`timeAgo` on the page; a fixed one in tests).
 */
export function detailText(r: ScheduleRow, ago: (iso: string) => string): string {
  const parts: string[] = [];
  if (r.kind === 'trigger') {
    parts.push(r.cron ? `${r.cron.expr} ${r.cron.tz}` : (SOURCE_LABEL[r.source ?? ''] ?? r.source ?? 'trigger'));
    if (r.target) parts.push(r.target);
    if (r.action) parts.push(r.action.replace('_', ' + '));
  } else {
    if (r.interval_ms !== null) parts.push(everyText(r.interval_ms));
    if (r.kind === 'helper' && r.owner) parts.push(r.owner);
    else if (r.kind === 'loop') parts.push(r.module);
  }
  parts.push(r.last_run ? `last ${ago(r.last_run)}` : 'not run yet');
  if (r.next_run && r.state !== 'disabled' && r.state !== 'stopped') parts.push(`next ${ago(r.next_run)}`);
  if (r.state === 'failing' && r.last_error) parts.push(r.last_error);
  return parts.join(' · ');
}

/** A trigger can be switched; it can be run now unless it waits for its webhook's events. */
export const canSwitch = (r: ScheduleRow): boolean => r.kind === 'trigger' && r.enabled !== null;
export const canRunNow = (r: ScheduleRow): boolean => r.kind === 'trigger' && r.source !== 'webhook';
/** `trigger:<id>` -> `<id>`, for the trigger routes. */
export const triggerIdOf = (r: ScheduleRow): string => r.id.slice('trigger:'.length);
