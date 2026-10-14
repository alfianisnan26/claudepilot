// Quiet hours (docs/prd/web-app-pwa.md §11.2): per destination, in the IANA zone stored with it, evaluated with `Intl` at the moment of
// the event, so a clock change can never misplace the window. The window may cross midnight (22:00 to 07:00). Pure functions.

import type { NotifyKind, QuietHours } from '@portal/contracts';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isHhmm = (v: unknown): v is string => typeof v === 'string' && HHMM.test(v);

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Minutes since local midnight in `tz` at `at`. */
export function localMinutes(at: Date, tz: string): number {
  let f = formatters.get(tz);
  if (!f) formatters.set(tz, (f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })));
  const parts = f.formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (h % 24) * 60 + m;
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Whether `at` falls in the window: start inclusive, end exclusive; across midnight when start is after end; empty when equal. */
export function inQuietHours(q: Pick<QuietHours, 'enabled' | 'start' | 'end' | 'tz'>, at: Date): boolean {
  if (!q.enabled || !isHhmm(q.start) || !isHhmm(q.end) || !isTimeZone(q.tz)) return false;
  const t = localMinutes(at, q.tz);
  const s = minutesOf(q.start);
  const e = minutesOf(q.end);
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** Whether an event of `kind` is held now: inside the window and not a break-through kind (`test` always goes through). */
export function holds(q: QuietHours, kind: NotifyKind, at: Date): boolean {
  if (kind === 'test') return false;
  if (q.breakthrough.includes(kind)) return false;
  return inQuietHours(q, at);
}
