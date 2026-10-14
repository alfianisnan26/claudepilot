import { cn } from '@isnanme/ui';
import type { ClaudeUsage, ClaudeUsageWindow } from '@portal/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { fullest, leftText, localTime, pctText, STATE_WORDS, stateTone, TONE_TEXT, toneOf, type Tone } from './format';
import { projectionSpan } from './pace';
import { blindWindow } from './unknownWords';
import { useClaudeRow, useNow, windowAt } from './useClaudeUsage';

/** What the bar adds when a window has a pace (docs/prd/claude-usage.md §20.2): where it is estimated to reach by the reset, and where an even spend would be. */
export type BarMark = NonNullable<ReturnType<typeof projectionSpan>>;

/**
 * A bar whose track is a lighter step of the fill's colour, like the context meter in a chat: the colour carries how full it is. With a
 * `mark` the estimated rest up to the reset is a paler stretch after the fill (a wall at the end when it is estimated to run out first, dimmer
 * while the estimate is low confidence) and a thin tick shows where an even spend would stand.
 */
export function Bar({ pct, tone, className, mark }: { pct: number | null; tone: Tone; className?: string; mark?: BarMark | null }) {
  const width = pct === null ? 0 : Math.min(100, Math.max(pct > 0 ? 3 : 0, pct));
  return (
    <span className={cn('relative block h-1.5 overflow-hidden rounded-full bg-current/20', TONE_TEXT[tone], className)} aria-hidden="true">
      {mark && mark.to > mark.from && <span className="absolute inset-y-0 bg-current" style={{ left: `${mark.from}%`, width: `${mark.to - mark.from}%`, opacity: mark.low ? 0.28 : 0.5 }} />}
      <span className="absolute inset-y-0 left-0 rounded-full bg-current transition-[width] duration-300" style={{ width: `${width}%` }} />
      {mark?.over && <span className="absolute inset-y-0 right-0 w-[3px] bg-danger" style={{ opacity: mark.low ? 0.5 : 1 }} />}
      {mark && mark.even !== null && <span className="absolute inset-y-0 w-[2px] -translate-x-1/2 bg-ink/70" style={{ left: `${mark.even}%` }} />}
    </span>
  );
}

/**
 * When a window resets: the countdown, and the time on this device's clock on tap (a title never shows on a phone). A window whose
 * reset has passed says so, since its number is old.
 */
function Reset({ w, nowMs }: { w: ClaudeUsageWindow; nowMs: number }) {
  const [clock, setClock] = useState(false);
  if (!w.resetsAt) return <span className="text-right text-muted">—</span>;
  const gone = w.level === 'reset';
  const at = localTime(w.resetsAt, nowMs);
  return (
    <button
      type="button"
      onClick={() => setClock((c) => !c)}
      title={gone ? `Reset at ${at}` : `Resets at ${at}`}
      aria-label={gone ? `Reset at ${at}` : `Resets at ${at}, in ${leftText(w.resetsAt, nowMs)}`}
      className="press -my-1 rounded-md py-1 text-right whitespace-nowrap text-muted tabular-nums hover:text-ink tap:-my-3.5 tap:py-3.5"
    >
      {gone ? 'reset' : clock ? at : leftText(w.resetsAt, nowMs)}
    </button>
  );
}

/** One window of a plan: label, bar, percent, reset. */
export function WindowLine({ w, nowMs }: { w: ClaudeUsageWindow; nowMs: number }) {
  const v = windowAt(w, nowMs);
  // T-255: 0 % with no reset time is no reading: shown as a dash, never 0 %.
  const blind = blindWindow(v);
  const tone = blind ? 'quiet' : toneOf(v.level);
  return (
    <li className="grid grid-cols-[3.75rem_minmax(0,1fr)_2.75rem_4.25rem] items-center gap-2 text-[13px]">
      <span className="truncate text-ink-soft" title={v.label}>
        {v.label}
      </span>
      <Bar pct={v.level === 'reset' || blind ? 0 : v.usedPct} tone={tone} mark={blind ? null : projectionSpan(v)} />
      <span className={cn('text-right font-semibold tabular-nums', v.level === 'reset' || v.level === 'unknown' || blind ? 'text-muted' : TONE_TEXT[tone])}>{v.level === 'reset' || blind ? '—' : pctText(v.usedPct)}</span>
      <Reset w={v} nowMs={nowMs} />
    </li>
  );
}

/**
 * Two thin bars for a Claude's row elsewhere (the session over the week), nothing while it has no plan limits or no reading. Tap
 * opens the Usage tab on it. Reads the same shared snapshot as the tab, so it asks the portal for nothing.
 */
export function ClaudeMeter({ claudeId, className }: { claudeId: string; className?: string }) {
  const row = useClaudeRow(claudeId);
  const now = useNow(60_000);
  if (!row || row.state === 'no_limits' || row.state === 'signed_out') return null;
  const windows = row.windows.map((w) => windowAt(w, now));
  const top = windows.find((w) => w.key === 'session') ?? windows[0];
  const week = windows.find((w) => w.key === 'week') ?? (top === windows[0] ? windows[1] : windows[0]);
  const lead = fullest(windows);
  if (!top) return null;
  const words = `${STATE_WORDS[row.state]}${lead ? `: ${lead.label} ${pctText(lead.usedPct)}` : ''}`;
  return (
    <Link
      to={`/admin/usage?tab=claudes#${encodeURIComponent(claudeId)}`}
      aria-label={`${row.claudeName} usage. ${words}`}
      title={words}
      className={cn('press inline-flex w-9 shrink-0 flex-col gap-1 rounded-md py-1', row.stale && 'opacity-60', className)}
    >
      <Bar pct={top.level === 'reset' ? 0 : top.usedPct} tone={toneOf(top.level)} />
      {week && <Bar pct={week.level === 'reset' ? 0 : week.usedPct} tone={toneOf(week.level)} />}
    </Link>
  );
}

export { stateTone };
export type { ClaudeUsage };
