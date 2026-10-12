// Where a plan window is heading (docs/prd/claude-usage.md §20.2), as the Claudes tab says it: the bar's projection marks, the warning line
// when a Claude is estimated to run out before it resets, and the pace details. Pure functions of the server's `windows[].pace`, tested
// without a browser. Every number here is an estimate (a rate from the readings of the current period, never from tokens).

import { ALL_MODEL_WINDOWS, type ClaudeUsage, type ClaudeUsageWindow, type Figure, type PaceStatus, type WindowPace } from '@portal/contracts';
import { leftText, localTime } from './format';

export type Clock = (iso: string) => string;
const defaultClock: Clock = (iso) => localTime(iso);

/** A Claude estimated to run out of a window that stops it before that window resets. */
export interface Risk {
  window: ClaudeUsageWindow;
  pace: WindowPace;
  /** When the window is estimated to reach 100 %. */
  etaAt: string;
  /** Few readings or a short span: shown, and said so, but no alert is sent for it. */
  low: boolean;
}

/**
 * The window that decides a Claude's outlook when it is `over` (the one that runs out first), or null: not a plan Claude, already out, or
 * nothing is projected to run out. Only `session` and `week` count (a model's own week stops only that model).
 */
export function projectionRisk(c: Pick<ClaudeUsage, 'runsOn' | 'state' | 'windows' | 'outlook'>): Risk | null {
  if (c.runsOn !== 'plan' || c.state === 'exhausted') return null;
  if (c.outlook.status.basis === 'unavailable' || c.outlook.status.value !== 'over') return null;
  const key = c.outlook.window?.key;
  const window = c.windows.find((w) => w.key === key && ALL_MODEL_WINDOWS.includes(w.key));
  const pace = window?.pace;
  if (!window || !pace || pace.etaAt.basis === 'unavailable') return null;
  return { window, pace, etaAt: pace.etaAt.value, low: pace.lowConfidence };
}

/** A Claude that needs a look because of its pace: counted by the tab's badge unless its alerts (or just its projections) are snoozed. */
export function needsPaceLook(c: ClaudeUsage): boolean {
  const risk = projectionRisk(c);
  return !!risk && !risk.low && !c.snoozedUntil && !c.projectionSnoozedUntil;
}

const num = (f: Figure): number | null => (f.basis === 'unavailable' ? null : f.value);
const rounded = (v: number, places = 1): string => String(Math.round(v * 10 ** places) / 10 ** places);

/** "Session runs out ~06:56 · resets 07:26" (or "may run out" when the estimate is low confidence), and the numbers behind it for the ⓘ. */
export function riskWords(risk: Risk, clock: Clock = defaultClock): { line: string; tip: string } {
  const { window: w, pace } = risk;
  const reset = w.resetsAt ? clock(w.resetsAt) : null;
  const eta = clock(risk.etaAt);
  const speed = num(pace.speed);
  const projected = num(pace.projectedPct);
  const line = `${w.label} ${risk.low ? 'may run out' : 'runs out'} ~${eta}${reset ? ` · resets ${reset}` : ''}`;
  const tip =
    `From how fast ${w.label.toLowerCase()} filled${speed === null ? '' : `: ${rounded(speed)} points an hour`} over ${pace.readings} readings in this period, not from tokens. ` +
    `At that speed it reaches 100 % about ${eta}${projected === null || !reset ? '' : ` and would stand at ${Math.round(projected)} % when it resets at ${reset}`}.` +
    (risk.low ? ' Few readings or a short span: low confidence, so no alert is sent.' : '');
  return { line, tip };
}

/** Where the bar's projection reaches, as a percent of the bar (0 to 100): the used part and the estimated rest up to the reset, capped at the end. */
export function projectionSpan(w: ClaudeUsageWindow): { from: number; to: number; over: boolean; even: number | null; low: boolean } | null {
  const pace = w.pace;
  if (!pace || w.usedPct === null || w.level === 'reset') return null;
  const projected = num(pace.projectedPct);
  if (projected === null) return null;
  const from = Math.min(100, Math.max(0, w.usedPct));
  return { from, to: Math.min(100, Math.max(from, projected)), over: projected > 100, even: num(pace.evenPct), low: pace.lowConfidence };
}

/** One line of the pace details (the open row): all figures keep their basis; a time after the reset reads "after reset". */
export interface PaceRow {
  key: string;
  label: string;
  speed: Figure;
  projectedPct: Figure;
  /** "06:56", "after reset" (it would not run out first), or the reason it is not known. */
  outAt: { text: string; figure: Figure<string> };
  evenPct: Figure;
  aheadPts: Figure;
  status: Figure<PaceStatus>;
  low: boolean;
  readings: number;
}

export function paceRows(c: Pick<ClaudeUsage, 'windows'>, clock: Clock = defaultClock): PaceRow[] {
  return c.windows
    .filter((w) => w.pace)
    .map((w) => {
      const p = w.pace!;
      const status = p.status.basis === 'unavailable' ? null : p.status.value;
      const text = p.etaAt.basis === 'unavailable' ? '-' : status === 'under' ? 'after reset' : status === 'exhausted' ? 'now' : clock(p.etaAt.value);
      return { key: w.key, label: w.label, speed: p.speed, projectedPct: p.projectedPct, outAt: { text, figure: p.etaAt }, evenPct: p.evenPct, aheadPts: p.aheadPts, status: p.status, low: p.lowConfidence, readings: p.readings };
    });
}

/** "+10 pts" / "-7 pts": how far a window is ahead of an even spend (negative: behind). */
export function aheadText(pts: number): string {
  const r = Math.round(pts);
  return r === 0 ? '0 pts' : `${r > 0 ? '+' : '-'}${Math.abs(r)} pts`;
}

export { leftText };
