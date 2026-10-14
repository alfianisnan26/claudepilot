// Claude usage: Claude Code's limit message in a chat's output as a hard signal (T-255). When a plan account is out of quota, Claude Code
// answers the turn itself (a `<synthetic>` assistant line with `error: "rate_limit"`) with text like
//   "You've hit your session limit · resets 11pm (UTC)"      (2.x, seen on this pod)
//   "You've hit your session limit, resets 10:20pm (UTC)"
//   "You've hit your weekly limit · resets Oct 20, 5am (Asia/Jakarta)"
//   "Claude usage limit reached. Your limit will reset at 5pm (America/New_York)."   (older CLIs)
// and often streams no `rate_limit_event` before it (at a session's first turn there is none). The usage probe may still read 0 % with no
// reset time for such an account (2026-10-13). This file reads the message: which window, and when it says the window resets. Pure: the time
// the line was written is given, the clock is never read.

/** What a limit message says. `guessed`: no reset time could be read, so the next 5-hour boundary after the message is assumed. */
export interface LimitMessage {
  window: 'session' | 'week' | 'week_opus' | 'week_sonnet';
  resetsAtMs: number;
  guessed: boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A stated reset further off than this is not believed (a week window resets within 7 days). */
const MAX_AHEAD_MS = 8 * DAY;

/** "hit your session limit", "hit your weekly limit", "hit your Opus limit", "usage limit reached", "5-hour limit reached". */
const LIMIT_RE = /\bhit your ([a-z0-9 .-]{0,30}?)\s*limit\b|\b(?:usage|5-hour|weekly|opus|sonnet)\s+limit\s+reached\b/i;
/** "resets 11pm", "resets 10:20pm (UTC)", "resets Oct 20, 5am (Asia/Jakarta)", "will reset at 5pm (America/New_York)", "resets Oct 20 at 5am". */
const RESET_RE =
  /\breset(?:s)?(?:\s+at)?\s+(?:on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([A-Za-z0-9_+\-/ ]{1,40})\))?/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Whether a text is Claude Code's limit message (not a chat talking about one: the caller checks the line is Claude Code's own). */
export function isLimitText(text: string): boolean {
  return LIMIT_RE.test(text);
}

function windowOf(text: string): LimitMessage['window'] {
  const m = LIMIT_RE.exec(text);
  const what = (m?.[0] ?? '').toLowerCase();
  if (/opus/.test(what)) return 'week_opus';
  if (/sonnet/.test(what)) return 'week_sonnet';
  if (/week/.test(what)) return 'week';
  return 'session';
}

/** A time zone Intl knows (`UTC`, `Asia/Jakarta`), else null. */
function zoneOf(raw: string | undefined): string | null {
  const z = (raw ?? 'UTC').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z;
  } catch {
    return null;
  }
}

/** The wall clock of `zone` at `ms`, as fields. */
function wall(ms: number, zone: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(ms);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: n('year'), mo: n('month') - 1, d: n('day'), h: n('hour') % 24, mi: n('minute') };
}

/** The instant a wall time of `zone` names (twice round for a daylight-saving change). */
function instant(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const target = Date.UTC(y, mo, d, h, mi);
  let t = target;
  for (let i = 0; i < 2; i++) {
    const w = wall(t, zone);
    t += target - Date.UTC(w.y, w.mo, w.d, w.h, w.mi);
  }
  return t;
}

/** The next 5-hour boundary after `atMs`: five hours on, up to the full hour (a session window is at most 5 hours long). */
export const fallbackReset = (atMs: number): number => Math.ceil((atMs + 5 * HOUR) / HOUR) * HOUR;

/** The reset a message states, as epoch ms after `atMs`, or null when it states none the portal can read. */
export function parseResetTime(text: string, atMs: number): number | null {
  const m = RESET_RE.exec(text);
  if (!m) return null;
  const zone = zoneOf(m[6]);
  if (!zone) return null;
  let h = Number(m[3]);
  const mi = m[4] ? Number(m[4]) : 0;
  if (h < 1 || h > 12 || mi > 59) return null;
  h = (h % 12) + (m[5]!.toLowerCase() === 'p' ? 12 : 0);
  const now = wall(atMs, zone);
  let t: number;
  if (m[1] && m[2]) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    const d = Number(m[2]);
    if (mo < 0 || d < 1 || d > 31) return null;
    t = instant(now.y, mo, d, h, mi, zone);
    if (t < atMs - DAY) t = instant(now.y + 1, mo, d, h, mi, zone);
  } else {
    t = instant(now.y, now.mo, now.d, h, mi, zone);
    if (t <= atMs) t = instant(now.y, now.mo, now.d + 1, h, mi, zone);
  }
  return Number.isFinite(t) && t > atMs && t - atMs <= MAX_AHEAD_MS ? t : null;
}

/** What a limit message says, or null when the text is not one. `atMs`: when the line was written. */
export function parseLimitMessage(text: string, atMs: number): LimitMessage | null {
  if (!text || text.length > 2000 || !isLimitText(text)) return null;
  const window = windowOf(text);
  const stated = parseResetTime(text, atMs);
  return stated !== null ? { window, resetsAtMs: stated, guessed: false } : { window, resetsAtMs: fallbackReset(atMs), guessed: true };
}

/** Marks the `rate_limit_info` the chat reader builds from a limit message, so the usage module records where it came from. */
export const LIMIT_MESSAGE_SOURCE = 'limit_message';

const RATE_LIMIT_TYPE: Record<LimitMessage['window'], string> = { session: 'five_hour', week: 'seven_day', week_opus: 'seven_day_opus', week_sonnet: 'seven_day_sonnet' };

/**
 * The limit message as a `rate_limit_info` the usage module already reads (`parseRateLimitInfo`: a refusal of that window, so 100 %
 * used, with the stated reset), plus where it came from. Times in Unix seconds, as Claude Code writes them.
 */
export function limitInfoOf(msg: LimitMessage, atMs: number): Record<string, unknown> {
  return {
    status: 'rejected',
    rateLimitType: RATE_LIMIT_TYPE[msg.window],
    resetsAt: Math.round(msg.resetsAtMs / 1000),
    reportedBy: LIMIT_MESSAGE_SOURCE,
    reportedAtMs: atMs,
    resetGuessed: msg.guessed,
  };
}
