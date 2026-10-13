import { cn } from '@isnanme/ui';
import type { ChatEvent } from '@portal/contracts';
import { Bot, ChevronRight, Lightbulb, type LucideIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useAgentLine } from './AgentRow';
import { MOTION } from './motion';
import { formatSeconds, shortTarget, toolIcon, toolLabel, type TranscriptRow } from './ToolRows';
import { usageLine, type TurnUsage } from './Usage';

const NO_AGENTS: readonly string[] = [];

/** One step of a turn's work, as the collapsed row shows it: a tool call or a thinking block. */
type Step = { kind: 'tool'; call: ChatEvent; result: ChatEvent | null } | { kind: 'thinking'; event: ChatEvent };

/** The steps in order: runs of read-only calls open up into their calls; notes between steps are left out. */
function stepsOf(rows: TranscriptRow[]): Step[] {
  return rows.flatMap((r): Step[] =>
    r.type === 'tool'
      ? [{ kind: 'tool', call: r.call, result: r.result }]
      : r.type === 'group'
        ? r.tools.map((t) => ({ kind: 'tool' as const, call: t.call, result: t.result }))
        : r.type === 'thinking'
          ? [{ kind: 'thinking', event: r.event }]
          : [],
  );
}

/** Each step's icon: a thinking block's, or its tool's. */
const iconFor = (step: Step): LucideIcon => (step.kind === 'thinking' ? Lightbulb : toolIcon(step.call.toolName));

/** The step's words, next to its icon when it's the latest: "Read MEMORY.md", "Thought for 4 s". */
function stepText(step: Step, live: boolean): string {
  if (step.kind === 'thinking') {
    if (live) return 'Thinking';
    const ms = step.event.durationMs ?? 0;
    return ms >= 1000 ? `Thought for ${formatSeconds(ms)}` : 'Thought';
  }
  const name = step.call.toolName ? toolLabel(step.call.toolName) : 'Tool';
  const target = shortTarget(step.call.text);
  return target ? `${name} ${target}` : name;
}

const failed = (s: Step) => s.kind === 'tool' && !!s.result?.isError;
/** Icons shown before the latest one; older steps fold into "+N". */
const SHOWN = 5;

/**
 * A turn's work in one line (chat PRD FR5): every step as a small icon in an overlapping group, and
 * only the latest one (the one running, while the turn runs) named beside it, shimmering while it
 * runs. Done, the group is its tool calls and the last one is named. A failed step's icon is red. Tapping opens the steps (each opens to its details) and the
 * turn's usage; Show all details opens every one.
 */
export function ActivityBlock({
  rows,
  usage,
  live,
  details,
  render,
  agents = NO_AGENTS,
}: {
  rows: TranscriptRow[];
  usage: TurnUsage | null;
  /** The turn is still running and this is its latest work. */
  live: boolean;
  /** The sub-agents this turn's calls started (their Task call ids): while one runs, the line says what it does, even after the turn ended. */
  agents?: readonly string[];
  details: boolean;
  render: (r: TranscriptRow) => ReactNode;
}) {
  const [tapped, setTapped] = useState<boolean | null>(null);
  useEffect(() => setTapped(null), [details]);
  const open = tapped ?? details;
  const id = useId();
  // While it runs every step shows, thinking included; once done, the tools tell the story (thinking only
  // when there was nothing else).
  const all = stepsOf(rows);
  const tools = all.filter((x) => x.kind === 'tool');
  const steps = !live && tools.length ? tools : all;
  const latest = steps[steps.length - 1] ?? null;
  const earlier = steps.slice(0, -1);
  const hidden = Math.max(0, earlier.length - SHOWN);
  const shown = earlier.slice(hidden);
  // A sub-agent of this turn that still runs speaks for the line (the main agent may be done): its name, what it does, shimmering.
  const agent = useAgentLine(agents);
  const text = agent ? `${agent.label} · ${agent.line}` : latest ? stepText(latest, live) : live ? 'Writing' : 'Notes';
  const failures = steps.filter(failed).length;
  const LatestIcon = agent ? Bot : latest ? iconFor(latest) : Lightbulb;

  return (
    <div className="flex max-w-full flex-col items-start">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${steps.length} ${steps.length === 1 ? 'step' : 'steps'}${failures ? `, ${failures} failed` : ''}. Latest: ${text}`}
        onClick={() => setTapped(!open)}
        className="press -mx-1 inline-flex max-w-full items-center gap-2 rounded-xl px-1 py-1 text-[15.5px] text-muted transition-colors hover:text-ink-soft sm:text-[14.5px]"
      >
        <span className="flex shrink-0 items-center" aria-hidden="true">
          {hidden > 0 && <Chip className="text-[10.5px] font-semibold tabular-nums">+{hidden}</Chip>}
          <AnimatePresence initial={false}>
            {shown.map((s, i) => {
              const Icon = iconFor(s);
              return (
                <motion.span
                  key={s.kind === 'tool' ? s.call.seq : s.event.seq}
                  layout
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={MOTION.pop}
                  className={cn(hidden > 0 || i > 0 ? '-ml-1.5' : '')}
                >
                  <Chip danger={failed(s)}>
                    <Icon className="size-3.5" />
                  </Chip>
                </motion.span>
              );
            })}
            <motion.span
              key={latest ? (latest.kind === 'tool' ? latest.call.seq : latest.event.seq) : 'none'}
              layout
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={MOTION.pop}
              className={cn(shown.length > 0 || hidden > 0 ? '-ml-1.5' : '')}
            >
              <Chip latest danger={latest ? failed(latest) : false}>
                <LatestIcon className="size-3.5" />
              </Chip>
            </motion.span>
          </AnimatePresence>
        </span>
        {/* The latest step's words crossfade as the next one starts. */}
        <span className="relative min-w-0 overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              // An agent's words change as it writes: they update in place, and crossfade only when another agent (or step) speaks.
              key={agent ? `agent:${agent.label}` : text}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={MOTION.swap}
              className={cn('block truncate', live || agent ? 'shimmer' : latest && failed(latest) ? 'text-danger' : 'text-ink-soft')}
            >
              {text}
            </motion.span>
          </AnimatePresence>
        </span>
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
            transition={MOTION.expand}
            className="w-full overflow-hidden"
          >
            <div className="mt-1.5 ml-3 flex flex-col gap-2 border-l border-line/80 pl-3.5">
              {rows.map(render)}
              {usage && <p className="pt-0.5 pl-1 text-[12.5px] text-muted tabular-nums">{usageLine(usage)}</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** One step's round icon in the group; a ring in the page colour keeps overlapping ones apart. */
function Chip({ children, latest, danger, className }: { children: ReactNode; latest?: boolean; danger?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'flex size-7 items-center justify-center rounded-full ring-2 ring-bg',
        danger ? 'bg-danger-soft text-danger' : latest ? 'bg-surface-2 text-ink' : 'bg-surface-2 text-muted',
        className,
      )}
    >
      {children}
    </span>
  );
}
