// Claude usage: which Claude a chat should move to (docs/prd/claude-usage.md §20.5). Pure over the snapshot's Claudes: it ranks, says why, and says
// how it knows. It never recommends a Claude that is signed out, out of usage, not read yet, or nearly out, and it never moves anything.

import {
  headroomFrom,
  measuredFigure,
  unavailableFigure,
  USAGE_THRESHOLDS,
  type ClaudeUsage,
  type Figure,
  type MoveCandidate,
  type MoveNone,
  type MoveReason,
  type MoveRecommendation,
  type PaceStatus,
  type UnavailableReason,
} from '@portal/contracts';

/** At least this much of the fullest window left is "room"; under it is "tight" (the warn threshold's complement). */
export const ROOM_PCT = 100 - USAGE_THRESHOLDS.warn;
/** A Claude whose pace says it runs out before its reset ranks as if it had this many points less. */
export const OVER_PACE_PENALTY = 20;

const none = <T = number>(reason: UnavailableReason): Figure<T> => unavailableFigure<T>(reason);

function candidateOf(c: ClaudeUsage): MoveCandidate & { score: number } {
  const h = headroomFrom({ claudeId: c.claudeId, runsOn: c.runsOn, windows: c.windows, checkedAt: c.checkedAt, stale: c.stale });
  const base = {
    claudeId: c.claudeId,
    name: c.claudeName,
    workspaceId: c.workspaceId,
    slot: c.slot,
    rank: null as number | null,
    recommended: false,
    stale: c.stale,
    checkedAt: c.checkedAt,
    score: -1,
  };
  const blank = (reason: MoveReason, why: UnavailableReason) => ({
    ...base,
    reason,
    basis: 'unavailable' as const,
    leftPct: none(why),
    window: null,
    resetsAt: none<string>(why),
    availableAt: none<string>(why),
    pace: none<PaceStatus>(why),
  });
  if (h.kind === 'signed_out') return blank('signed_out', 'signed_out');
  if (h.kind === 'no_limits') return { ...blank('no_limits', 'no_limits'), basis: 'measured' };
  if (h.kind === 'unknown' || !h.limiting) return blank('unknown', 'no_reading');
  const window = { key: h.limiting.key, label: h.limiting.label };
  const resetsAt: Figure<string> = h.limiting.resetsAt ? measuredFigure(h.limiting.resetsAt) : none('no_reset_time');
  if (h.exhausted) {
    return { ...base, reason: 'exhausted', basis: 'measured', leftPct: measuredFigure(0), window, resetsAt, availableAt: h.availableAt ? measuredFigure(h.availableAt) : none('no_reset_time'), pace: none('no_limits') };
  }
  const left = h.limiting.leftPct;
  const over = c.outlook.status.value === 'over';
  const reason: MoveReason = left < ROOM_PCT ? 'tight' : over ? 'over_pace' : 'room';
  return {
    ...base,
    reason,
    // The order follows readings only, unless the pace moved it.
    basis: reason === 'over_pace' ? 'estimate' : 'measured',
    leftPct: measuredFigure(left),
    window,
    resetsAt,
    availableAt: none('no_limits'),
    pace: c.outlook.status,
    score: left - (over ? OVER_PACE_PENALTY : 0),
  };
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
const time = (f: Figure<string>) => (f.value === null ? Infinity : Date.parse(f.value));

/**
 * The Claudes of `workspaceId` that a chat can move to (every one but `from` that the asking user may use), ranked. Order: `room` and `over_pace` by percent left of the fullest window
 * (minus 20 points for `over_pace`), the sooner reset first on a tie; then `no_limits` (a pool or key: nothing to run out of, billed per use); then
 * `tight` by percent left. Those that cannot take the chat follow without a rank: exhausted by when they return, unknown, signed out.
 */
export function recommendMove(claudes: ClaudeUsage[], opts: { workspaceId: string; from?: string | null; nowMs: number; allow?: (claudeId: string) => boolean }): MoveRecommendation {
  // Only Claudes the asking user may use are listed (multi-user seam: absent means all).
  const all = claudes.filter((c) => c.workspaceId === opts.workspaceId && c.claudeId !== opts.from && (!opts.allow || opts.allow(c.claudeId))).map(candidateOf);
  const room = all.filter((c) => c.reason === 'room' || c.reason === 'over_pace').sort((a, b) => b.score - a.score || time(a.resetsAt) - time(b.resetsAt) || byName(a, b));
  const free = all.filter((c) => c.reason === 'no_limits').sort(byName);
  const tight = all.filter((c) => c.reason === 'tight').sort((a, b) => (b.leftPct.value ?? 0) - (a.leftPct.value ?? 0) || byName(a, b));
  const out = all.filter((c) => c.reason === 'exhausted').sort((a, b) => time(a.availableAt) - time(b.availableAt) || byName(a, b));
  const unknown = all.filter((c) => c.reason === 'unknown').sort(byName);
  const signedOut = all.filter((c) => c.reason === 'signed_out').sort(byName);
  const ranked = [...room, ...free, ...tight];
  ranked.forEach((c, i) => (c.rank = i + 1));
  const best = room[0] ?? free[0] ?? null;
  if (best) best.recommended = true;
  const noneReason: MoveNone | null = best ? null : !all.length ? 'no_other_claude' : tight.length ? 'all_tight' : 'none_ready';
  return {
    now: new Date(opts.nowMs).toISOString(),
    workspaceId: opts.workspaceId,
    from: opts.from ?? null,
    recommended: best?.claudeId ?? null,
    none: noneReason,
    candidates: [...ranked, ...out, ...unknown, ...signedOut].map(({ score: _score, ...c }) => c),
  };
}
