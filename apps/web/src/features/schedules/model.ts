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
export const attentionCount = (rows: readonly ScheduleRow[]): number =>
  rows.filter((r) => r.state === 'failing' || r.state === 'stale').length;

export const STATE_LABEL: Record<ScheduleState, string> = {
  ok: 'OK',
  failing: 'Failing',
  stale: 'Late',
  stopped: 'Stopped',
  disabled: 'Off',
};
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

/**
 * One list's load (T-965 UX finding): a failed load is an error with its reason, never an empty list ("Nothing runs by itself." after a
 * failed fetch was a false statement). `loading` before the first answer.
 */
export type ListLoad<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: T[] };

/** A settled fetch as a list's load; `reason` turns the rejection into the short message shown with the Retry button. */
export function settleList<T>(r: PromiseSettledResult<T[]>, reason: (e: unknown) => string): ListLoad<T> {
  return r.status === 'fulfilled' ? { status: 'ready', items: r.value } : { status: 'error', message: reason(r.reason) };
}

/** A trigger's settings can be changed on the page (the editor): every trigger; loops and helpers are code or outside the portal. */
export const canEdit = (r: ScheduleRow): boolean => r.kind === 'trigger';

const KIND_LABEL: Record<ScheduleKind, string> = { loop: 'Loop', trigger: 'Trigger', helper: 'Helper' };
const ACTION_LABEL: Record<string, string> = { session: 'Session', ticket: 'Ticket', ticket_session: 'Ticket + session' };

/**
 * The detail sheet's lines for one row (T-2950): only what the server sent, a missing value left out (never a guess). `when` turns a time
 * into words (an absolute time and how long ago on the page; a fixed one in tests).
 */
export function detailRows(r: ScheduleRow, when: (iso: string) => string): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [
    { label: 'Kind', value: KIND_LABEL[r.kind] },
    { label: 'State', value: STATE_LABEL[r.state] },
  ];
  const add = (label: string, value: string | null | undefined) => {
    if (value) out.push({ label, value });
  };
  if (r.kind === 'trigger') {
    add('Source', SOURCE_LABEL[r.source ?? ''] ?? r.source);
    add('Schedule', r.cron ? `${r.cron.expr} (${r.cron.tz})` : null);
    add('Workspace', r.target);
    add('Action', r.action ? (ACTION_LABEL[r.action] ?? r.action) : null);
    add('Owner', r.owner);
  } else {
    add('Module', r.module);
    add('Runs', r.interval_ms !== null ? everyText(r.interval_ms) : null);
    if (r.kind === 'helper') add('Owner', r.owner);
  }
  add('Last run', r.last_run ? when(r.last_run) : 'Not yet');
  add('Result', r.last_result === 'ok' ? 'OK' : r.last_result === 'failed' ? 'Failed' : null);
  add('Error', r.last_error);
  add('Next run', r.next_run && r.state !== 'disabled' && r.state !== 'stopped' ? when(r.next_run) : null);
  return out;
}
