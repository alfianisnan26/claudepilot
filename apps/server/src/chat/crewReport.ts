// T-546 (D-65): the crew report digest. A lead reads what its workers did as ONE message at most every few minutes (a setting), because
// every report starts a lead turn that re-reads the whole context. This file holds what is pure about it: the setting, and which news
// does not wait.
import { defineSetting } from '../settings/registry.js';

export const CREW_REPORT_MIN = 'chat.crew.reportMin';
/** The window in minutes when nothing is set. */
export const CREW_REPORT_DEFAULT_MIN = 5;

defineSetting({
  key: CREW_REPORT_MIN,
  type: 'number',
  default: CREW_REPORT_DEFAULT_MIN,
  min: 0,
  max: 60,
  scope: 'global',
  group: 'sessions',
  order: 92,
  label: 'Crew digest',
  help: 'The most often, in minutes, that a lead hears of its workers: every report in the window arrives as one message. A fail, a block, a refusal, a worker waiting on a person or one ended for integrity goes at once. 0 sends each report without waiting.',
});

/** The window in milliseconds from the setting; a missing or odd value is `fallbackMs`. */
export function crewWindowMs(get: ((key: string) => unknown) | undefined, fallbackMs: number): number {
  if (!get) return fallbackMs;
  let v: unknown;
  try {
    v = get(CREW_REPORT_MIN);
  } catch {
    return fallbackMs;
  }
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(60, Math.max(0, v)) * 60_000) : CREW_REPORT_DEFAULT_MIN * 60_000;
}

/**
 * Whether the first line of a worker's reply says it failed, is blocked or refused (its verdict is the first word or two: `FAIL …`,
 * `BLOCKED: …`, `PASS …`, `DONE …`). Upper case only, so a sentence about "no tests failed" is not one.
 */
export function crewReplyUrgent(reply: string | null | undefined): boolean {
  const first = (reply ?? '').split('\n').find((l) => l.trim()) ?? '';
  return /^\W*(?:FAIL(?:ED)?|BLOCKED|REFUSED|REFUSAL)\b/.test(first);
}

// T-1613 (D-65): the crew wake. A lead that sits idle while its lanes are idle, or while its tickets got verdicts, is told ONCE by the
// portal. Each wake is one lead turn, and the window below is what bounds that cost: at most one wake per lead per window.
export const CREW_WAKE_MIN = 'chat.crew.wakeMin';
/** How long a lead is idle before a wake, and the least time between two wakes of one lead, in minutes, when nothing is set. */
export const CREW_WAKE_DEFAULT_MIN = 15;

defineSetting({
  key: CREW_WAKE_MIN,
  type: 'number',
  default: CREW_WAKE_DEFAULT_MIN,
  min: 0,
  max: 240,
  scope: 'global',
  group: 'sessions',
  order: 93,
  label: 'Crew wake',
  help: 'A lead idle this many minutes, with an idle worker or a new verdict on a ticket it holds, gets one message from the portal naming them. At most once in this many minutes per lead, and never twice for the same news. 0 turns it off.',
});

/** The wake's window in milliseconds from the setting (0: off); a missing or odd value is the default. */
export function crewWakeMs(get: ((key: string) => unknown) | undefined): number {
  let v: unknown;
  try {
    v = get?.(CREW_WAKE_MIN);
  } catch {
    v = undefined;
  }
  return Math.round((typeof v === 'number' && Number.isFinite(v) ? Math.min(240, Math.max(0, v)) : CREW_WAKE_DEFAULT_MIN) * 60_000);
}

/** Whole minutes, at least 1, for the wake's text. */
export function wakeMinutes(ms: number): number {
  return Math.max(1, Math.floor(ms / 60_000));
}
