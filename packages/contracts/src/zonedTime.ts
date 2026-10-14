// One way to write a clock time, for the server and the web (T-126 item 5): the Quota sheet, the Inbox, a push and a webhook text say
// the same fact the same way. "14:20" on the same day, "Wed 02:40" within six days, else "15 Oct 09:00", in a given zone (the device's
// own when none is given). Pure apart from Intl.

const formatters = new Map<string, { day: Intl.DateTimeFormat; clock: Intl.DateTimeFormat; weekday: Intl.DateTimeFormat; date: Intl.DateTimeFormat; zone: Intl.DateTimeFormat }>();

function fmt(tz: string | undefined) {
  const key = tz ?? '';
  let f = formatters.get(key);
  if (!f) {
    const timeZone = tz;
    f = {
      day: new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }),
      clock: new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
      weekday: new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }),
      date: new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }),
      zone: new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' }),
    };
    formatters.set(key, f);
  }
  return f;
}

/** A zone name this runtime knows. */
export function isKnownZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * `iso` as a clock time in `tz` (the device's zone when undefined), relative to `nowMs` for the day: "14:20", "Wed 02:40", "15 Oct 09:00".
 * Empty for a time that does not parse. An unknown zone reads as UTC.
 */
export function zonedTime(iso: string | null | undefined, nowMs: number, tz?: string): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const f = fmt(tz === undefined ? undefined : isKnownZone(tz) ? tz : 'UTC');
  const clock = f.clock.format(t);
  if (f.day.format(t) === f.day.format(new Date(nowMs))) return clock;
  if (Math.abs(t.getTime() - nowMs) < 6 * 86_400_000) return `${f.weekday.format(t)} ${clock}`;
  return `${f.date.format(t)} ${clock}`;
}

/** The short name of `tz` at `iso`: "UTC", "GMT+7", "CEST". */
export function zoneLabel(iso: string, tz: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const part = fmt(isKnownZone(tz) ? tz : 'UTC').zone.formatToParts(t).find((p) => p.type === 'timeZoneName');
  return part?.value ?? tz;
}

/**
 * A clock time kept as an instant inside stored text (the Inbox row), so whoever reads it sees it in their own zone: `⟦t:<ISO>⟧`.
 * Only the server writes these, from a parsed date (never from free text).
 */
export const timeMark = (at: Date): string => `⟦t:${at.toISOString()}⟧`;

const MARK = /⟦t:(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z)⟧/g;

/** Whether text carries time marks. */
export const hasTimeMarks = (text: string): boolean => text.includes('⟦t:');

/** Each mark replaced by `show(iso)`. */
export const fillTimeMarks = (text: string, show: (iso: string) => string): string => text.replace(MARK, (_m, iso: string) => show(iso));
