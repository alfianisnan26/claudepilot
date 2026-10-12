// Usage spend: the day and the month a budget counts in (docs/prd/claude-usage.md §23.2). A budget's "daily" and "monthly" need ONE
// clock for the whole portal, whoever has a page open, so the Settings key `usage.timezone` (an IANA name, "UTC" by default) names it.
// A zone with daylight saving has days of 23 and 25 hours: the boundaries are found on the wall clock, then converted back to an instant.
// Pure.

const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

const formats = new Map<string, Intl.DateTimeFormat>();

function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formats.set(tz, f);
  }
  return f;
}

/** Whether `tz` is a time zone name this runtime knows ("UTC", "Asia/Jakarta"). */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    format(tz);
    return true;
  } catch {
    return false;
  }
}

/** How far the zone's wall clock is ahead of UTC at the instant `atMs`, in ms (Jakarta: +7 hours). */
export function offsetMs(tz: string, atMs: number): number {
  const t = Math.floor(atMs / 1000) * 1000;
  const parts = format(tz).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return wall - t;
}

/** The instant at which the zone's wall clock reads `wall` (read as if it were UTC). Iterates, so a change of offset between the guess and the answer is followed. */
function instantOfWall(tz: string, wall: number): number {
  let t = wall - offsetMs(tz, wall);
  t = wall - offsetMs(tz, t);
  return wall - offsetMs(tz, t);
}

export type BudgetPeriodName = 'day' | 'month';

/** The period holding `atMs`: from its first instant (inclusive) to the next period's (exclusive), in the zone. */
export function periodBounds(period: BudgetPeriodName, tz: string, atMs: number): { start: number; end: number } {
  const local = atMs + offsetMs(tz, atMs);
  if (period === 'day') {
    const startWall = Math.floor(local / DAY) * DAY;
    return { start: instantOfWall(tz, startWall), end: instantOfWall(tz, startWall + DAY) };
  }
  const d = new Date(local);
  return {
    start: instantOfWall(tz, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)),
    end: instantOfWall(tz, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)),
  };
}
