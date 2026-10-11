import { cn, ease } from '@isnanme/ui';
import { ChevronRight } from 'lucide-react';
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

/** The one tool a row used, by name ("File Write"), when it used just one. */
function onlyTool(rows: TranscriptRow[]): string | null {
  const calls = rows.flatMap((r) => (r.type === 'tool' ? [r.call] : r.type === 'group' ? r.tools.map((t) => t.call) : []));
  return calls.length === 1 && calls[0]!.toolName ? toolLabel(calls[0]!.toolName) : null;
}

/** "Used File Write", "Used 4 tools", "Thought for 4 s": what the turn did, once it's done. */
function summary(rows: TranscriptRow[]): string {
  const tools = toolCount(rows);
  if (tools) return onlyTool(rows) ? `Used ${onlyTool(rows)}` : `Used ${tools} tools`;
  const ms = thoughtMs(rows);
  if (rows.some((r) => r.type === 'thinking')) return ms >= 1000 ? `Thought for ${formatSeconds(ms)}` : 'Thought';
  return 'Notes';
}

/**
 * A turn's work in one quiet line (chat PRD FR5): thinking, tool calls and the notes between them fold
 * into "Used 4 tools ›" above the reply. While the turn runs it names the step under way, shimmering;
 * done, it says what was used, with failed steps counted. Tapping opens the steps (each opens to its
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
  const label = live ? stepLabel(rows[rows.length - 1]!) : summary(rows);
  return (
    <div className="flex max-w-full flex-col items-start">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setTapped(!open)}
        className="press -mx-1 inline-flex max-w-full items-center gap-1.5 rounded-lg px-1 py-1 text-[15.5px] text-muted transition-colors hover:text-ink-soft sm:text-[14.5px]"
      >
        {/* The live line crossfades from step to step. */}
        <span className="relative min-w-0 overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={label}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease }}
              className={cn('block truncate', live && 'shimmer')}
            >
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
        <ChevronRight className={cn('size-4 shrink-0 opacity-70 transition-transform duration-200', open && 'rotate-90')} aria-hidden="true" />
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
            <div className="mt-1.5 ml-1 flex flex-col gap-2 border-l border-line/80 pl-3.5">
              {rows.map(render)}
              {usage && <p className="pt-0.5 pl-1 text-[12.5px] text-muted tabular-nums">{usageLine(usage)}</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
