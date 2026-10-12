// Knowledge: dates for daily notes (Knowledge PRD FR15). A day belongs to a time zone: the vault's on the
// server (agents, jobs), the browser's in the UI, which sends the date it means.

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function serverTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && validTimezone(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** `YYYY-MM-DD` for `now` in `tz`. */
export function todayIn(tz: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** `HH:MM` for `now` in `tz`. */
export function timeIn(tz: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('hour')}:${get('minute')}`;
}

/** A real calendar date written `YYYY-MM-DD`. */
export function isDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
