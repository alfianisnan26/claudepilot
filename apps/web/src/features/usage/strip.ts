// What the summary strip's tiles say (docs/prd/claude-usage.md §20.7), as pure functions of the server's summary so the wording and the
// states are tested without a browser. Every figure keeps its basis (round 4 plan P1): estimates are labelled by the tile, unavailable
// ones are "-" with the server's reason.

import { reasonText, type LimitOutlook, type NextReset, type SpendRate, type SpendToday, type UnavailableReason } from '@portal/contracts';
import { formatCost, formatCostRate, formatTokenRate, formatTokens } from '@/lib/usage/format';
import { leftText, localTime, type Tone } from './claude/format';

export type Clock = (iso: string) => string;
const defaultClock: Clock = (iso) => localTime(iso);

export interface TileText {
  /** The big text: a time, "Out", "OK", "-". */
  value: string;
  /** A unit set small after the value ("/min"). */
  unit?: string;
  tone: Tone;
  /** The small line under the label. */
  hint: string;
  /** Set when the tile's value is not available: the tip says why. */
  reason: UnavailableReason | null;
  /** The longer note for the tile's tip (the numbers behind the value); null where there is none. */
  note: string | null;
  /** The value is an estimate (the tile carries "est."). */
  estimate: boolean;
}

const pct = (v: number) => `${Math.round(v)} %`;

/**
 * "Time until the limit". `over`: the time until the window is estimated to reach 100 %, counted from `nowMs`. `under`: "OK", with where
 * the window is estimated to stand when it resets. `exhausted`: "Out" until its reset. Unavailable: "-" with the reason. `named` puts the
 * Claude's name before the window (the strip over every Claude: which one runs out first).
 */
export function limitTile(limit: LimitOutlook & { claudeName?: string | null }, nowMs: number, named: boolean, clock: Clock = defaultClock): TileText {
  const status = limit.status;
  if (status.basis === 'unavailable') return { value: '-', tone: 'quiet', hint: named && limit.claudeName ? limit.claudeName : '', reason: status.reason, note: null, estimate: false };
  const w = limit.window;
  const where = [named ? limit.claudeName : null, w?.label].filter(Boolean).join(' · ');
  const resets = w?.resetsAt ? clock(w.resetsAt) : null;
  if (status.value === 'exhausted') {
    return { value: 'Out', tone: 'danger', hint: resets ? `${where} · until ${resets}` : where, reason: null, note: w ? `${w.label} is used up${resets ? ` until ${resets}` : ''}.` : null, estimate: false };
  }
  const used = w?.usedPct != null ? ` at ${pct(w.usedPct)}` : '';
  const proj = limit.projectedPct.basis === 'unavailable' ? null : limit.projectedPct.value;
  const eta = limit.etaAt.basis === 'unavailable' ? null : limit.etaAt.value;
  const how = 'From how fast it filled in this period (percentage points per hour), not from tokens.';
  if (status.value === 'over') {
    const note = `${w?.label ?? 'The window'} is${used}${eta ? ` and is estimated to reach 100 % about ${clock(eta)}` : ''}${resets ? `, before it resets at ${resets}` : ''}${proj !== null ? ` (it would stand at ${pct(proj)} then)` : ''}. ${how}`;
    return { value: eta ? leftText(eta, nowMs) || 'now' : '-', tone: 'gold', hint: `${where} · before reset`, reason: eta ? null : 'no_growth', note, estimate: true };
  }
  const note = `${w?.label ?? 'The window'} is${used} and is estimated to stand at ${proj !== null ? pct(proj) : 'less than 100 %'} when it resets${resets ? ` at ${resets}` : ''}. ${how}`;
  return { value: 'OK', tone: 'ok', hint: proj !== null ? `${where} · ~${pct(proj)} at reset` : where, reason: null, note, estimate: true };
}

/** "Next reset": the soonest reset of any window (a time Claude Code reported, so measured), as a countdown with the clock time beside it. */
export function resetTile(r: NextReset & { claudeName?: string | null }, nowMs: number, named: boolean, clock: Clock = defaultClock): TileText {
  if (r.at.basis === 'unavailable') return { value: '-', tone: 'quiet', hint: '', reason: r.at.reason, note: null, estimate: false };
  const where = [named ? r.claudeName : null, r.window?.label].filter(Boolean).join(' · ');
  return { value: leftText(r.at.value, nowMs) || 'now', tone: 'quiet', hint: `${where ? `${where} · ` : ''}${clock(r.at.value)}`, reason: null, note: null, estimate: false };
}

/** "Speed": dollars per minute over the last 15 minutes (an estimate), tokens per minute beneath, and today's average in the tip. */
export function speedTile(trailing: SpendRate, today: SpendRate): TileText {
  const cost = trailing.costPerMin;
  const tokens = trailing.tokensPerMin;
  const avg =
    today.costPerMin.basis === 'unavailable'
      ? `Today's average: ${reasonText(today.costPerMin.reason)}`
      : `Today's average: ${formatCostRate(today.costPerMin.value)}${today.tokensPerMin.basis === 'unavailable' ? '' : `, ${formatTokenRate(today.tokensPerMin.value)}`} over ${today.spanMin} min.`;
  return {
    value: cost.basis === 'unavailable' ? '-' : formatCost(cost.value),
    unit: cost.basis === 'unavailable' ? undefined : '/min',
    tone: 'quiet',
    hint: tokens.basis === 'unavailable' ? '' : formatTokenRate(tokens.value),
    reason: cost.basis === 'unavailable' ? cost.reason : null,
    note: `What finished in the last 15 minutes ÷ 15 min. A request counts when it finishes, so a long one reads as a burst. ${avg}`,
    estimate: true,
  };
}

/** "Today": the dollars spent since this device's midnight (an estimate); the request count beneath, the tokens in the tip. */
export function todayTile(today: SpendToday): TileText {
  const { costUsd, requests, tokens } = today;
  const count = requests.basis === 'unavailable' ? null : requests.value;
  return {
    value: costUsd.basis === 'unavailable' ? '-' : formatCost(costUsd.value),
    tone: 'quiet',
    hint: count === null ? '' : `${count} ${count === 1 ? 'request' : 'requests'}`,
    reason: costUsd.basis === 'unavailable' ? costUsd.reason : null,
    note: `Since midnight on this device${tokens.basis === 'unavailable' ? '' : `. Tokens spent: ${formatTokens(tokens.value)} (input + output + cache writes; cache reads are not counted)`}.`,
    estimate: true,
  };
}
