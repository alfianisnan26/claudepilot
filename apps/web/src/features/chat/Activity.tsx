import { cn, ease, Spinner } from '@isnanme/ui';
import { ChevronRight, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { formatSeconds, groupLabel, shortTarget, toolLabel, type TranscriptRow } from './ToolRows';
import { usageLine, type TurnUsage } from './Usage';

/** What one step did, in a few words: the live line while Claude works ("Read MEMORY.md"). */
function stepLabel(r: TranscriptRow): string {
  switch (r.type) {
    case 'thinking':
      return 'Thinking';
    case 'group':
      return groupLabel(r.tools);
    case 'tool': {
      const name = r.call.toolName ? toolLabel(r.call.toolName) : 'Tool';
      const target = shortTarget(r.call.text);
      return target ? `${name} ${target}` : name;
    }
    case 'event':
      return r.event.kind === 'assistant' ? 'Writing' : (r.event.text ?? 'Working');
  }
}

const toolCount = (rows: TranscriptRow[]) => rows.reduce((n, r) => n + (r.type === 'tool' ? 1 : r.type === 'group' ? r.tools.length : 0), 0);
const failedCount = (rows: TranscriptRow[]) => rows.reduce((n, r) => n + (r.type === 'tool' && r.result?.isError ? 1 : 0), 0);
const thoughtMs = (rows: TranscriptRow[]) => rows.reduce((n, r) => n + (r.type === 'thinking' ? (r.event.durationMs ?? 0) : 0), 0);

/** "Worked for 5 s · 3 steps", "Thought for 4 s", or while it runs, the step under way. */
function summary(rows: TranscriptRow[], usage: TurnUsage | null): string {
  const tools = toolCount(rows);
  if (!tools) {
    const ms = thoughtMs(rows);
    if (rows.every((r) => r.type === 'thinking')) return ms >= 1000 ? `Thought for ${formatSeconds(ms)}` : 'Thought';
  }
  const took = usage?.durationMs ?? null;
  const worked = took !== null && took >= 1000 ? `Worked for ${formatSeconds(took)}` : 'Worked';
  return tools ? `${worked} · ${tools} ${tools === 1 ? 'step' : 'steps'}` : worked;
}

/**
 * A turn's work in one row (chat PRD FR5): thinking, tool calls and the notes between them fold into a
 * pill above the reply. While the turn runs it names the step under way; done, it says how long it
 * worked and how many steps, with failed ones counted. Tapping opens the steps (each opens to its
 * details) and the turn's usage; Show all details opens every one.
 */
export function ActivityBlock({
  rows,
  usage,
  live,
  details,
  render,
}: {
  rows: TranscriptRow[];
  usage: TurnUsage | null;
  /** The turn is still running and this is its latest work. */
  live: boolean;
  details: boolean;
  render: (r: TranscriptRow) => ReactNode;
}) {
  const [tapped, setTapped] = useState<boolean | null>(null);
  useEffect(() => setTapped(null), [details]);
  const open = tapped ?? details;
  const id = useId();
  const failed = failedCount(rows);
  const label = live ? stepLabel(rows[rows.length - 1]!) : summary(rows, usage);
  return (
    <div className="flex max-w-full flex-col items-start">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setTapped(!open)}
        className="press inline-flex max-w-full items-center gap-2 rounded-full border border-line/60 bg-surface-2/50 py-1 pr-2.5 pl-2 text-[12.5px] text-ink-soft transition-colors hover:bg-surface-2"
      >
        {live ? <Spinner className="size-3.5 shrink-0" /> : <Sparkles className="size-3.5 shrink-0 text-muted" aria-hidden="true" />}
        {/* The live line crossfades from step to step. */}
        <span className="relative min-w-0 overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={label}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease }}
              className="block truncate"
            >
              {live && <span className="text-muted">Working · </span>}
              {label}
            </motion.span>
          </AnimatePresence>
        </span>
        {failed > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 text-muted">
            <span className="size-1.5 rounded-full bg-danger" aria-hidden="true" />
            {failed} failed
          </span>
        )}
        <ChevronRight className={cn('size-3.5 shrink-0 opacity-60 transition-transform duration-200', open && 'rotate-90')} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={id}
            key="steps"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease }}
            className="w-full overflow-hidden"
          >
            <div className="mt-2 ml-3 flex flex-col gap-1.5 border-l border-line pl-3">
              {rows.map(render)}
              {usage && <p className="pt-0.5 pl-1 text-[11.5px] text-muted tabular-nums">{usageLine(usage)}</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
