import { QUIET_DEFAULT, type NotifyKind, type QuietHours } from '@portal/contracts';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isTime = (v: string) => HHMM.test(v);

/** A zone name the browser knows (`Intl` throws a RangeError for any other). */
export function isZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** This browser's zone, or UTC when it will not say. */
export function browserZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isZone(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * A known device whose notifications are written in UTC (or no zone) while this browser is elsewhere: register it again, which repairs
 * the zone on the server (T-126). A zone the person picked stays, so only a missing or UTC one asks.
 */
export const needsZoneRepair = (stored: string | undefined, here: string): boolean => (!stored || stored === 'UTC') && here !== 'UTC';

/** The zones for the picker: the browser's list when it has one (always with the current zone and UTC in it). */
export function zoneList(current: string): string[] {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    all = [];
  }
  const set = new Set(all);
  set.add('UTC');
  if (current && isZone(current)) set.add(current);
  return [...set].sort();
}

export const quietDefault = (tz: string, breakthrough: NotifyKind[] = []): QuietHours => ({ ...QUIET_DEFAULT, tz, breakthrough });

/** Minutes after midnight. */
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** Why a window cannot be saved, or null. Equal start and end is refused: it would mean "never" or "always", and neither is a window. */
export function quietProblem(q: QuietHours): string | null {
  if (!isTime(q.start) || !isTime(q.end)) return 'Use a time like 22:00.';
  if (q.start === q.end) return 'Start and end are the same.';
  if (!isZone(q.tz)) return 'Pick a time zone.';
  return null;
}

/** Whether a wall-clock time (`HH:MM`, already in the window's zone) is inside the window; the window may cross midnight. Start is in, end is out. */
export function insideWindow(q: Pick<QuietHours, 'start' | 'end'>, hhmm: string): boolean {
  const s = minutes(q.start);
  const e = minutes(q.end);
  const t = minutes(hhmm);
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** "22:00 to 07:00 · Asia/Jakarta", or "Off". */
export function quietLine(q: QuietHours): string {
  return q.enabled ? `${q.start} to ${q.end} · ${q.tz}` : 'Off';
}

/** Length of the window in minutes (crossing midnight counts through it): for the "8 h" hint. */
export function windowMinutes(q: Pick<QuietHours, 'start' | 'end'>): number {
  const d = minutes(q.end) - minutes(q.start);
  return d > 0 ? d : d + 24 * 60;
}
