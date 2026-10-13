import type { AutoMode, AutoTransferEvent, AutoTransferSettings, ClaudeUsage } from '@portal/contracts';
import { readClaude, windowViews, type QuotaReading, type Thresholds, type WindowView } from './quota';

// The Home page's Quota card (docs/prd/glance-widgets.md §18): every Claude the viewer has, the one closest to running out first, each
// with its windows (session, week, per model), their pace and reset, and the auto-move state under them. Pure, so the order is tested.

export interface BoardRow {
  reading: QuotaReading;
  windows: WindowView[];
}

const etaMs = (c: ClaudeUsage): number => {
  const f = c.outlook?.etaAt;
  const t = f && f.basis !== 'unavailable' ? Date.parse(f.value) : NaN;
  return Number.isFinite(t) ? t : Infinity;
};

/** 0: a plan reading (it can run out); 1: no reading yet, signed out, or unreadable; 2: a pool or an API key (nothing to run out of). */
const group = (r: QuotaReading): number => (r.leftPct !== null ? 0 : r.headroom.kind === 'no_limits' ? 2 : 1);

/**
 * "Closest to running out" first: the least left of its fullest window (measured, so a projection never reorders two Claudes whose
 * readings differ), a tie broken by the sooner projected run-out (an estimate), then by name. Claudes without a number follow, then
 * those with no plan limits.
 */
export function quotaBoard(claudes: readonly ClaudeUsage[], nowMs: number, th: Thresholds): BoardRow[] {
  return claudes
    .map((c) => ({ reading: readClaude(c, nowMs, th), windows: windowViews(c, nowMs, th) }))
    .sort(
      (a, b) =>
        group(a.reading) - group(b.reading) ||
        (a.reading.leftPct ?? 0) - (b.reading.leftPct ?? 0) ||
        etaMs(a.reading.claude) - etaMs(b.reading.claude) ||
        a.reading.claude.claudeName.localeCompare(b.reading.claude.claudeName),
    );
}

export const AUTO_MODE_WORD: Record<AutoMode, string> = { off: 'Off', ask: 'Ask', auto: 'Automatic' };

/** The engine's own actor: a move it made by itself (a person's answer to a suggestion is `user:…`). */
export const AUTO_ACTOR = 'portal:autotransfer';

export interface AutoLine {
  mode: AutoMode;
  /** Percent left at or under which a chat moves; null while off. */
  thresholdPct: number | null;
  /** The last move the portal made by itself, from the caller's trail; null when none is in it. */
  last: { at: string; from: string | null; to: string | null } | null;
}

/** What the card says about auto move: the mode in force for the viewer, its threshold, and the last automatic move. */
export function autoLine(effective: AutoTransferSettings, moves: readonly AutoTransferEvent[]): AutoLine {
  const auto = moves.find((e) => e.kind === 'moved' && e.actor === AUTO_ACTOR);
  return {
    mode: effective.mode,
    thresholdPct: effective.mode === 'off' ? null : effective.thresholdPct,
    last: auto ? { at: auto.at, from: auto.from?.name ?? null, to: auto.to?.name ?? null } : null,
  };
}
