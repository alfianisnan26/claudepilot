import { cn } from '@isnanme/ui';
import { Grid2x2 } from 'lucide-react';
import { InfoTip } from '@/components/InfoTip';
import { setPatterns, Swatch, usePatterns, type StackItem } from '@/lib/usage';
import { displayName, nameCounts, type StackBy } from './requests';

/** Members of "Others" named in its popover before "+N more". */
const OTHERS_LISTED = 8;

/** What the "previous period" entry can do right now: on, off, or unable (with the reason a tip gives). */
export interface PreviousState {
  on: boolean;
  /** Why the line cannot be drawn (no earlier data, an item switched off), or null when it can. */
  unavailable: string | null;
}

const chip = (on: boolean) =>
  cn('press inline-flex h-8 tap:h-11 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] font-medium', on ? 'border-line bg-surface text-ink-soft' : 'border-line bg-transparent text-muted');

/** A dashed stroke: the previous period's line. */
function DashSwatch({ hollow }: { hollow?: boolean }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3 shrink-0">
      <line x1="0" x2="12" y1="6" y2="6" stroke="var(--color-ink-soft)" strokeWidth="1.5" strokeDasharray="3 2" opacity={hollow ? 0.45 : 1} />
    </svg>
  );
}

/**
 * The legend of a stacked chart: one entry per band in the order the stack runs (slot order, "Others" last), each a switch that takes its
 * band out of the chart and brings it back. A switched-off entry is an outline with muted words, so the state is never colour alone. The
 * previous period is an entry too (a dashed line); the ⓘ beside it says why it cannot be drawn. The last button turns the hatch patterns on
 * and off (the non-colour cue, docs/prd/claude-usage.md §20.6).
 */
export function StackLegend({
  items,
  kind,
  hidden,
  onToggle,
  previous,
  onPrevious,
}: {
  items: readonly StackItem[];
  kind: StackBy;
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
  previous: PreviousState;
  onPrevious: () => void;
}) {
  const counts = nameCounts(items);
  const [patterns] = usePatterns();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {items.map((it) => {
        const on = !hidden.has(it.key);
        const name = it.members ? it.label : displayName(it.label, it.sub, kind, counts);
        const inside = it.members?.map((m) => displayName(m.label, m.sub, kind, counts)).join(', ');
        const chipButton = (
          <button key={it.key} type="button" aria-pressed={on} onClick={() => onToggle(it.key)} title={inside ? `${name}: ${inside}` : name} className={chip(on)}>
            <Swatch slot={it.slot} hollow={!on} />
            <span dir="auto" className="min-w-0 truncate">
              {name}
            </span>
          </button>
        );
        // "Others" says who is in it in a popover a keyboard reaches (the first few, then how many more).
        if (!it.members) return chipButton;
        const shown = it.members.slice(0, OTHERS_LISTED);
        return (
          <span key={it.key} className="inline-flex max-w-full items-center">
            {chipButton}
            <InfoTip label="What is in Others">
              {shown.map((m) => displayName(m.label, m.sub, kind, counts)).join(', ')}
              {it.members.length > shown.length ? `, +${it.members.length - shown.length} more` : ''}
            </InfoTip>
          </span>
        );
      })}
      <span className="inline-flex items-center">
        <button type="button" aria-pressed={previous.on && !previous.unavailable} onClick={onPrevious} className={chip(previous.on && !previous.unavailable)}>
          <DashSwatch hollow={!previous.on || !!previous.unavailable} />
          <span>Previous</span>
        </button>
        {previous.on && previous.unavailable && <InfoTip label="Why no previous period">{previous.unavailable}</InfoTip>}
      </span>
      <button
        type="button"
        aria-pressed={patterns}
        aria-label="Patterns"
        title="Patterns"
        onClick={() => setPatterns(!patterns)}
        className={cn('press tap:size-11 ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-full border', patterns ? 'border-ink-soft text-ink' : 'border-line text-muted hover:text-ink')}
      >
        <Grid2x2 className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
