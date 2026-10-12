// Cron for triggers (docs/prd/triggers.md §10), pure and shared: CI M3's `on.schedule` uses the same module (local-git-ci FR16).
//
// Grammar: five fields (minute hour day-of-month month day-of-week), POSIX plus steps (`*/15`, `a-b/n`, `a/n` = `a-max/n`), lists,
// ranges, month names `JAN`-`DEC` and weekday names `SUN`-`SAT` (any case), 7 is Sunday. When BOTH day fields are restricted a day
// matches if EITHER does (POSIX); a day field that starts with `*` is unrestricted. Refused with a message: seconds (a sixth field),
// `L`, `W`, `#`, `?`, the `@` aliases.
//
// Clock changes (the zone is an IANA name, evaluated on the server's ICU data): a wall-clock time that does not exist fires ONCE at the
// first instant after the gap; a wall-clock time that happens twice fires ONCE, at its first occurrence. So the mapping from wall-clock
// candidates (in order) to instants is non-decreasing, and `next` walks the candidates in order and stops at the first one after `after`.

export interface CronField {
  values: number[];
  /** The field starts with `*` (for the day fields' OR rule). */
  star: boolean;
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  /** 0-6, Sunday 0 (a 7 is folded into 0). */
  dow: CronField;
}

export class CronError extends Error {}

const MONTHS: Record<string, number> = Object.fromEntries('JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ').map((n, i) => [n, i + 1]));
const DAYS: Record<string, number> = Object.fromEntries('SUN MON TUE WED THU FRI SAT'.split(' ').map((n, i) => [n, i]));
const FIELD_NAMES = ['minute', 'hour', 'day of month', 'month', 'day of week'] as const;
/** How far `next` looks: a schedule that does not fire within this many days (`0 0 31 2 *`) never fires. Five years covers 29 February. */
const HORIZON_DAYS = 5 * 366 + 2;

function atom(raw: string, name: string, min: number, max: number, names?: Record<string, number>): number {
  const up = raw.toUpperCase();
  if (names && Object.hasOwn(names, up)) return names[up]!;
  if (!/^\d{1,2}$/.test(raw)) throw new CronError(`The ${name} field has “${raw.slice(0, 12)}”, which is not a number${names ? ' or a name' : ''}.`);
  const n = Number(raw);
  if (n < min || n > max) throw new CronError(`The ${name} field takes ${min} to ${max}; ${n} is out of range.`);
  return n;
}

function parseField(spec: string, index: number, min: number, max: number, names?: Record<string, number>): CronField {
  const name = FIELD_NAMES[index]!;
  if (/[LW#?]/i.test(spec.replace(/[A-Z]{3}/gi, (m) => (names && Object.hasOwn(names, m.toUpperCase()) ? '0' : m))))
    throw new CronError(`The ${name} field uses L, W, # or ?, which are not supported.`);
  const set = new Set<number>();
  for (const item of spec.split(',')) {
    if (!item) throw new CronError(`The ${name} field has an empty list item.`);
    const [range, stepRaw, extra] = item.split('/');
    if (extra !== undefined) throw new CronError(`The ${name} field has two steps in “${item.slice(0, 20)}”.`);
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d{1,2}$/.test(stepRaw) || Number(stepRaw) < 1) throw new CronError(`The ${name} field has a step that is not a whole number of at least 1.`);
      step = Number(stepRaw);
    }
    let lo: number;
    let hi: number;
    if (range === '*') [lo, hi] = [min, max];
    else if (range!.includes('-')) {
      const [a, b, more] = range!.split('-');
      if (more !== undefined || !a || !b) throw new CronError(`The ${name} field has a range that is not a-b.`);
      lo = atom(a, name, min, max, names);
      hi = atom(b, name, min, max, names);
      if (lo > hi) throw new CronError(`The ${name} field has a range that runs backwards (${a}-${b}).`);
    } else {
      lo = atom(range!, name, min, max, names);
      hi = stepRaw !== undefined ? max : lo;
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { values: [...set].sort((a, b) => a - b), star: spec.startsWith('*') };
}

/** Parses an expression or throws a `CronError` whose message can be shown as is. */
export function parseCron(expr: string): ParsedCron {
  if (typeof expr !== 'string') throw new CronError('A cron expression is five fields.');
  const text = expr.trim();
  if (text.startsWith('@')) throw new CronError('The @ forms (@hourly, @daily, …) are not supported: write the five fields.');
  if (text.length > 120) throw new CronError('That expression is too long.');
  const f = text.split(/\s+/);
  if (f.length === 6) throw new CronError('Six fields: seconds are not supported. Write minute hour day month weekday.');
  if (f.length !== 5) throw new CronError('A cron expression is five fields: minute hour day month weekday.');
  const dowRaw = parseField(f[4]!, 4, 0, 7, DAYS);
  const dow: CronField = { star: dowRaw.star, values: [...new Set(dowRaw.values.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b) };
  return { minute: parseField(f[0]!, 0, 0, 59), hour: parseField(f[1]!, 1, 0, 23), dom: parseField(f[2]!, 2, 1, 31), month: parseField(f[3]!, 3, 1, 12, MONTHS), dow };
}

/** An IANA zone this server's ICU knows. */
export function validZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at an instant, as the UTC number with the same fields (minute resolution). */
export function wallOf(tz: string, ms: number): number {
  const p: Record<string, number> = {};
  for (const x of formatter(tz).formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, 0);
}

const MINUTE = 60_000;
const offsetAt = (tz: string, ms: number) => wallOf(tz, ms) - Math.floor(ms / MINUTE) * MINUTE;

/** The local calendar date of an instant: `{ y, m, d }`. */
export function localDate(tz: string, ms: number): { y: number; m: number; d: number } {
  const w = new Date(wallOf(tz, ms));
  return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate() };
}

/** The first instant of a local day (midnight, or the first instant after a gap at midnight). */
export function startOfLocalDay(tz: string, ms: number): number {
  const { y, m, d } = localDate(tz, ms);
  return instantOfWall(tz, Date.UTC(y, m - 1, d, 0, 0, 0), zoneOffsets(tz, Date.UTC(y, m - 1, d)));
}

/** The offsets a zone uses around a day (at most two in practice: one clock change a day). */
function zoneOffsets(tz: string, dayUtc: number): number[] {
  const out = new Set<number>([offsetAt(tz, dayUtc - 86_400_000), offsetAt(tz, dayUtc + 12 * 3_600_000), offsetAt(tz, dayUtc + 2 * 86_400_000)]);
  return [...out];
}

/**
 * The instant a wall-clock time `w` stands for: its first occurrence; when it does not exist (a gap), the first instant after the gap.
 * `offsets` are the zone's offsets around that day.
 */
function instantOfWall(tz: string, w: number, offsets: number[]): number {
  const hits = offsets.map((o) => w - o).filter((ms) => wallOf(tz, ms) === w);
  if (hits.length) return Math.min(...hits);
  // A gap: the transition lies between w - max offset and w - min offset; the first minute whose wall clock is at or past w.
  let lo = Math.floor((w - Math.max(...offsets)) / MINUTE) - 1;
  let hi = Math.ceil((w - Math.min(...offsets)) / MINUTE) + 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (wallOf(tz, mid * MINUTE) >= w) hi = mid;
    else lo = mid;
  }
  return hi * MINUTE;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function dayMatches(c: ParsedCron, y: number, m: number, d: number): boolean {
  if (!c.month.values.includes(m) || d > daysInMonth(y, m)) return false;
  const domOk = c.dom.values.includes(d);
  const dowOk = c.dow.values.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
  if (!c.dom.star && !c.dow.star) return domOk || dowOk; // POSIX: either day field
  return domOk && dowOk;
}

/**
 * The next `count` fire instants strictly after `after` (UTC milliseconds), in order, under the rules above. Fewer (or none) when the
 * schedule does not fire within about five years.
 */
export function nextRuns(cron: ParsedCron | string, tz: string, after: number, count = 1): number[] {
  const c = typeof cron === 'string' ? parseCron(cron) : cron;
  if (!validZone(tz)) throw new CronError(`Unknown time zone “${String(tz).slice(0, 64)}”.`);
  const out: number[] = [];
  // Start a day early: the local date of `after` may be behind a candidate whose gap instant falls on it.
  const start = localDate(tz, after);
  for (let i = -1; i < HORIZON_DAYS && out.length < count; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!dayMatches(c, y, m, d)) continue;
    const offsets = zoneOffsets(tz, day.getTime());
    for (const h of c.hour.values) {
      for (const min of c.minute.values) {
        const at = instantOfWall(tz, Date.UTC(y, m - 1, d, h, min, 0), offsets);
        if (at <= after || out.includes(at)) continue;
        out.push(at);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

/** One next fire as an ISO string, or null when it never fires. */
export function nextRunIso(expr: string, tz: string, after: Date): string | null {
  const [ms] = nextRuns(expr, tz, after.getTime(), 1);
  return ms === undefined ? null : new Date(ms).toISOString();
}

/** Checks an expression and a zone for saving: a message, or null when it is fine (it must also fire at least once). */
export function cronProblem(expr: unknown, tz: unknown, now = Date.now()): string | null {
  if (!validZone(tz)) return 'Pick a known time zone.';
  try {
    const c = parseCron(String(expr ?? ''));
    if (!nextRuns(c, tz, now, 1).length) return 'That schedule never fires.';
    return null;
  } catch (e) {
    if (e instanceof CronError) return e.message;
    throw e;
  }
}
