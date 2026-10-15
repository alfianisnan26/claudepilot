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
