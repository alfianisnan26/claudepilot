import { groupLabel, toolKind, type ToolKind, type ToolPair, type TranscriptRow } from '@/features/chat/toolModel';
import { memo, useId, useState, type ReactNode } from 'react';
import { ACTIVITY_FIRST, isAgentStep, runTook, stepFailed, stepParts, stepText, type ChatItem } from './chatModel';
import { Icon, type IconName } from './icons';

/** The portal transcript's icon per tool kind (ToolRows.tsx), drawn with the panel's inlined copies. */
const KIND_ICON: Record<ToolKind, IconName> = {
  run: 'squareTerminal',
  read: 'fileText',
  write: 'filePen',
  search: 'search',
  list: 'folderOpen',
  web: 'globe',
  agent: 'bot',
  todo: 'listChecks',
  mcp: 'plug',
  other: 'wrench',
};
const stepIcon = (s: ToolPair): IconName => KIND_ICON[toolKind(s.call.toolName)];

/** Icons shown before the latest one; older steps fold into "+N" (the portal's activity row). */
const SHOWN = 5;

type Activity = Extract<ChatItem, { type: 'activity' }>;

/**
 * A run of tool calls as one row, as the portal chat shows a turn's work (Activity.tsx): every step a small round icon in an overlapping
 * group, the latest one named beside it (shimmering while it runs, red when it failed), a chevron. Tapping opens the calls, one line each,
 * runs of read-only calls folded as in the portal ("3 files read · 2 searches"). The panel never has a call's output: a failed call shows
 * its one-line error instead. Closed by default; its open state is its own, so it holds while new calls stream in.
 */
export const ToolActivity = memo(
  function ToolActivity({ item, initiallyOpen = false }: { item: Activity; /** Tests render it open. */ initiallyOpen?: boolean }) {
    const [open, setOpen] = useState(initiallyOpen);
    const [all, setAll] = useState(false);
    const id = useId();
    const { steps, rows, live } = item;
    const latest = steps[steps.length - 1]!;
    const earlier = steps.slice(0, -1);
    const hidden = Math.max(0, earlier.length - SHOWN);
    const shown = earlier.slice(hidden);
    const failures = steps.filter(stepFailed).length;
    const running = live && !latest.result;
    const text = stepText(latest);
    const took = live ? null : runTook(steps);
    const visible = all ? rows : rows.slice(0, ACTIVITY_FIRST);
    const more = rows.length - visible.length;
    return (
      <li className="flex max-w-full flex-col items-start">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-label={`${steps.length} ${steps.length === 1 ? 'step' : 'steps'}${failures ? `, ${failures} failed` : ''}${live ? ', running' : ''}. Latest: ${text}`}
          onClick={() => setOpen(!open)}
          className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-xl px-1 text-[13.5px] text-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
        >
          <span className="flex shrink-0 items-center" aria-hidden="true">
            {hidden > 0 && <Chip className="text-[10.5px] font-semibold tabular-nums">+{hidden}</Chip>}
            {shown.map((s, i) => (
              <Chip key={s.call.seq} danger={stepFailed(s)} className={hidden > 0 || i > 0 ? '-ml-1.5' : ''}>
                <Icon name={stepIcon(s)} className="size-3.5" />
              </Chip>
            ))}
            <Chip latest danger={stepFailed(latest)} className={shown.length > 0 || hidden > 0 ? '-ml-1.5' : ''}>
              <Icon name={stepIcon(latest)} className="size-3.5" />
            </Chip>
          </span>
          <span className={`min-w-0 truncate ${running ? 'shimmer' : stepFailed(latest) ? 'text-danger' : 'text-ink-soft'}`}>{text}</span>
          <Icon name="chevronRight" className={`size-4 opacity-70 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
        </button>
        {open && (
          <div id={id} className="mt-0.5 ml-3 flex w-[calc(100%-0.75rem)] min-w-0 flex-col gap-0.5 border-l border-line pl-3">
            {visible.map((r) => (
              <Row key={r.type === 'group' ? `g${r.tools[0]!.call.seq}` : r.type === 'tool' ? `t${r.call.seq}` : 'x'} row={r} live={live} />
            ))}
            {more > 0 && (
              <button type="button" onClick={() => setAll(true)} className="inline-flex min-h-11 items-center self-start px-1 text-[12.5px] font-semibold text-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden">
                Show {more} more
              </button>
            )}
            {took && <p className="px-1 pb-1 text-[12px] text-muted tabular-nums">{took}</p>}
          </div>
        )}
      </li>
    );
  },
  (a, b) => a.item.sig === b.item.sig,
);

/** One row inside an opened activity: a call, or a run of read-only calls that opens to its calls (the portal's ToolGroup). */
function Row({ row, live }: { row: TranscriptRow; live: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (row.type === 'tool') return <Step step={row} live={live} />;
  if (row.type !== 'group') return null;
  const pending = live && row.tools.some((t) => !t.result);
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        className="inline-flex min-h-11 max-w-full items-center gap-2 self-start rounded-lg px-1 text-left text-[13px] text-ink-soft focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden"
      >
        <Icon name="layers" className="size-3.5" />
        <span className={`min-w-0 truncate ${pending ? 'shimmer' : ''}`}>{groupLabel(row.tools)}</span>
        {pending && <span className="sr-only">(running)</span>}
        <Icon name="chevronRight" className={`size-3.5 opacity-60 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div id={id} className="ml-2 flex min-w-0 flex-col border-l border-line pl-2">
          {row.tools.map((t) => (
            <Step key={t.call.seq} step={t} live={live} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One call: its icon, its name and what it was given (a path's file name, a command's start), in the danger tone with its error when it failed. */
function Step({ step, live }: { step: ToolPair; live: boolean }) {
  const failed = stepFailed(step);
  const running = live && !step.result;
  const agent = isAgentStep(step);
  const text = stepText(step);
  const { name, target } = stepParts(step);
  return (
    <div className={`flex min-h-9 min-w-0 flex-col justify-center px-1 py-1 text-[13px] ${failed ? 'text-danger' : 'text-ink-soft'}`}>
      <span className="flex min-w-0 items-center gap-2">
        <Icon name={stepIcon(step)} className="size-4" />
        {agent ? (
          <span className={`min-w-0 truncate ${running ? 'shimmer' : ''}`}>{text}</span>
        ) : (
          <>
            <span className={`shrink-0 font-mono ${running ? 'shimmer' : ''}`}>{name}</span>
            <span className="min-w-0 truncate font-mono text-muted">{target}</span>
          </>
        )}
        {running && <span className="sr-only">(running)</span>}
        {failed && <span className="sr-only">(failed)</span>}
      </span>
      {failed && step.result?.text && <span className="mt-0.5 ml-6 line-clamp-2 text-[12px] break-words">{step.result.text}</span>}
    </div>
  );
}

/** One step's round icon in the group; a ring in the page colour keeps overlapping ones apart. */
function Chip({ children, latest, danger, className = '' }: { children: ReactNode; latest?: boolean; danger?: boolean; className?: string }) {
  return <span className={`flex size-7 items-center justify-center rounded-full ring-2 ring-bg ${danger ? 'bg-danger-soft text-danger' : latest ? 'bg-surface-2 text-ink' : 'bg-surface-2 text-muted'} ${className}`}>{children}</span>;
}
