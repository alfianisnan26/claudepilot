import { Button, cn, ease, useToast } from '@isnanme/ui';
import type { ChatTask } from '@portal/contracts';
import { Activity, Bot, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleStop, Search, Square, SquareTerminal, X } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { errorText } from '@/lib/api';
import { MONO } from '../code/font';
import { AgentDetail, TASK_STATUS, taskMs } from './AgentDetail';
import { agentLatest, isAgentTask, modelShort, tasksSummary } from './agentFold';
import {
  callCommand,
  countTasks,
  DONE_PAGE,
  groupTasks,
  NO_FILTER,
  taskLabel,
  taskLine,
  type Counts,
  type KindFilter,
  type ListFilter,
  type StatusFilter,
  type TaskLine,
} from './agentList';
import { CommandDetail } from './CommandDetail';
import type { AgentLive } from './motion/deltas';
import { formatDuration, useModal, useNow } from './shared';
import { useTaskFeed } from './taskFeed';

/** After its ack, how long a stopped task's row waits for the task to report it ended before Stop is offered again. */
const STOP_GRACE_MS = 15_000;

interface AgentsProps {
  /** The session: a sub-agent's detail view reads its transcript from it. */
  sessionId: string;
  tasks: ChatTask[];
  /** What each sub-agent is writing now, by its Task call: the row's and the detail view's live line. */
  agentLive?: ReadonlyMap<string, AgentLive>;
  /** The task whose detail view is open (its task id), or null for the list; the transcript's agent rows open one too. */
  selected: string | null;
  onSelect: (taskId: string | null) => void;
  /** Stops one running task (`stop_task`), settling on its ack. Without it there's no Stop. */
  onStopTask?: (taskId: string) => Promise<void>;
  /** Interrupts the turn (`stop`): the first half of Stop all. */
  onInterrupt?: () => Promise<void>;
  /** While the socket is down, Stop waits. */
  connected?: boolean;
}

/** What one row shows, worked out once per change of the task or its feed (not every second). */
interface RowView {
  agent: boolean;
  label: string;
  line: TaskLine;
  /** A sub-agent's model as Claude Code reported it ("unavailable" until it did); null for a command. */
  model: string | null;
  /** The whole command, for search. */
  command: string | null;
}

/** "2 agents and 3 commands", "the running agent". */
function stopAllWhat(agents: number, commands: number): string {
  const n = (k: number, one: string, many: string) => (k === 1 ? `1 ${one}` : `${k} ${many}`);
  return [agents && n(agents, 'agent', 'agents'), commands && n(commands, 'command', 'commands')].filter(Boolean).join(' and ');
}

/**
 * The session's sub-agents and background commands (T-149): a strip of chips that count and filter them (Running, Failed, Done, Agents,
 * Commands) with a search, then groups with sticky headers: running agents, running commands, failed or stopped (never folded away), and
 * done (folded, newest first, ten at a time). Every row is the same height, two lines: a short label, its state, model and time; then what
 * it does now or how it ended. A row opens its detail (an agent's transcript, a command's whole command); Stop sits on each running one and
 * Stop all above them. The same content fills the side panel on wide screens and the sheet below them.
 */
export function AgentsPanel({
  sessionId,
  tasks,
  agentLive,
  selected,
  onSelect,
  onStopTask,
  onInterrupt,
  connected = true,
  onClose,
  closeLabel,
  titleId,
}: AgentsProps & {
  onClose: () => void;
  closeLabel: string;
  titleId?: string;
}) {
  const toast = useToast();
  const feed = useTaskFeed(sessionId);
  const now = useNow(tasks.some((t) => t.status === 'running'));
  const running = useMemo(() => tasks.filter((t) => t.status === 'running'), [tasks]);
  // Stops in flight (or acked, until the task reports it ended), and why the last one failed, by task.
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [stoppingAll, setStoppingAll] = useState(false);
  const latest = useRef(tasks);
  useLayoutEffect(() => {
    latest.current = tasks;
  });
  const stillRunning = (taskId: string) => latest.current.some((t) => t.taskId === taskId && t.status === 'running');

  const mark = useCallback((ids: string[], on: boolean) => {
    setStopping((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  const fail = useCallback((taskId: string, message: string | null) => {
    setFailures((m) => {
      if (message === null && !m.has(taskId)) return m;
      const next = new Map(m);
      if (message === null) next.delete(taskId);
      else next.set(taskId, message);
      return next;
    });
  }, []);

  // Acked stops wait for the task to report it ended; if it never does, Stop comes back.
  const timers = useRef(new Set<number>());
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);
  const settleLater = (taskId: string) => {
    const t = window.setTimeout(() => {
      timers.current.delete(t);
      mark([taskId], false);
    }, STOP_GRACE_MS);
    timers.current.add(t);
  };

  /** Stops one task; resolves with why it failed, or null. A task that ended meanwhile isn't a failure. */
  const stopOne = async (taskId: string): Promise<string | null> => {
    if (!onStopTask) return null;
    mark([taskId], true);
    fail(taskId, null);
    try {
      await onStopTask(taskId);
      settleLater(taskId);
      return null;
    } catch (e) {
      mark([taskId], false);
      if (!stillRunning(taskId)) return null;
      const message = errorText(e, 'Couldn’t stop it.');
      fail(taskId, message);
      return message;
    }
  };
  // The rows keep one Stop and one Open for their whole life, so a row that did not change does not render again.
  const stopRef = useRef(stopOne);
  useLayoutEffect(() => {
    stopRef.current = stopOne;
  });
  const stopRow = useCallback((taskId: string) => void stopRef.current(taskId), []);
  const openRow = useCallback((taskId: string) => onSelect(taskId), [onSelect]);

  // Stop all: interrupt the turn first, then stop each task that's still running.
  const stopAll = async () => {
    const ids = running.map((t) => t.taskId);
    setStoppingAll(true);
    mark(ids, true);
    let problem: string | null = null;
    try {
      await onInterrupt?.();
    } catch (e) {
      problem = errorText(e, 'Couldn’t stop the turn.');
    }
    const results = await Promise.all(ids.filter(stillRunning).map(stopOne));
    const failed = results.filter((r): r is string => r !== null);
    mark(ids.filter((id) => !stillRunning(id)), false);
    setStoppingAll(false);
    if (failed.length) toast(failed.length === 1 ? `Couldn’t stop an agent: ${failed[0]}` : `Couldn’t stop ${failed.length} agents: ${failed[0]}`, 'error');
    else if (problem) toast(problem, 'error');
  };

  // Each row's label and line: from the task, the call behind it and what an agent does now (not the clock: that is the time column).
  const views = useMemo(() => {
    const out = new Map<string, RowView>();
    for (const t of tasks) {
      const agent = isAgentTask(t);
      const call = t.toolUseId ? feed.calls.get(t.toolUseId) : undefined;
      const command = agent ? null : (callCommand(call)?.text ?? null);
      const label = taskLabel(t, command);
      const doing = agent && t.status === 'running' && t.toolUseId ? agentLatest(feed.rows.get(t.toolUseId), agentLive?.get(t.toolUseId)) : null;
      out.set(t.taskId, { agent, label, line: taskLine(t, label, command, doing), model: agent ? (modelShort(t.model) ?? 'unavailable') : null, command });
    }
    return out;
  }, [tasks, feed, agentLive]);

  // Filters, search, and the done group's fold: kept while a detail view is open, so back returns to the same list.
  const [filter, setFilter] = useState<ListFilter>(NO_FILTER);
  const [searching, setSearching] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [doneShown, setDoneShown] = useState(DONE_PAGE);
  const counts = useMemo(() => countTasks(tasks), [tasks]);
  const groups = useMemo(
    () =>
      groupTasks(tasks, filter, (t) => {
        const v = views.get(t.taskId);
        return [v?.label, t.description, t.subagentType, v?.model, v?.command, t.summary].filter(Boolean).join('\n');
      }),
    [tasks, filter, views],
  );
  const doneUnfolded = doneOpen || filter.status === 'done' || !!filter.query.trim();
  const shownCount = groups.agents.length + groups.commands.length + groups.failed.length + groups.done.length;

  // Back from a detail view lands where the list was.
  const scroller = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(0);
  const chosen = selected ? tasks.find((t) => t.taskId === selected) : undefined;
  useLayoutEffect(() => {
    if (!chosen && scroller.current) scroller.current.scrollTop = scrollTop.current;
  }, [chosen]);

  if (chosen) {
    const view = views.get(chosen.taskId);
    const common = {
      onBack: () => onSelect(null),
      onClose,
      closeLabel,
      titleId,
      onStop: onStopTask ? () => void stopOne(chosen.taskId) : undefined,
      stopping: stopping.has(chosen.taskId),
      stopDisabled: !connected,
      failure: chosen.status === 'running' ? failures.get(chosen.taskId) : undefined,
    };
    if (view && !view.agent)
      return <CommandDetail task={chosen} label={view.label} call={chosen.toolUseId ? feed.calls.get(chosen.toolUseId) : undefined} {...common} />;
    return <AgentDetail sessionId={sessionId} task={chosen} live={chosen.toolUseId ? agentLive?.get(chosen.toolUseId) : undefined} {...common} />;
  }

  const runningAgents = running.filter(isAgentTask).length;
  const stopWhat = stopAllWhat(runningAgents, running.length - runningAgents);
  const row = (t: ChatTask) => {
    const v = views.get(t.taskId)!;
    const ms = taskMs(t, t.status === 'running' ? now : 0);
    return (
      <TaskRow
        key={t.taskId}
        id={t.taskId}
        status={t.status}
        label={v.label}
        model={v.model}
        modelId={t.model}
        lead={v.line.lead}
        tone={v.line.tone}
        code={v.line.code}
        elapsed={Number.isFinite(ms) ? formatDuration(ms) : ''}
        onOpen={openRow}
        onStop={onStopTask && t.status === 'running' ? stopRow : undefined}
        stopping={stopping.has(t.taskId)}
        stopDisabled={!connected}
        failure={t.status === 'running' ? failures.get(t.taskId) : undefined}
      />
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-semibold">
            Agents
          </h2>
          {/* The chips show the counts; a screen reader hears them change. */}
          <p className="sr-only" role="status">
            {tasksSummary(tasks)}
          </p>
        </div>
        {tasks.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (searching) setFilter((f) => ({ ...f, query: '' }));
              setSearching(!searching);
            }}
            aria-label="Search"
            aria-expanded={searching}
            aria-controls="agents-search"
            className={cn(
              'flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-surface-2 hover:text-ink sm:hidden',
              searching || filter.query ? 'text-ink' : 'text-muted',
            )}
          >
            <Search className="size-[18px]" aria-hidden="true" />
          </button>
        )}
        {onStopTask && running.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            icon={<Square className="size-3.5" />}
            loading={stoppingAll}
            disabled={!connected}
            onClick={() => void stopAll()}
            title={`Stops the turn and ${stopWhat}`}
            aria-label={`Stop all: the turn and ${running.length === 1 ? `the running ${runningAgents ? 'agent' : 'command'}` : stopWhat}`}
          >
            Stop all
          </Button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink tap:size-11"
        >
          <X className="size-[18px]" />
        </button>
      </div>
      {tasks.length > 0 && (
        <Toolbar
          counts={counts}
          filter={filter}
          onFilter={setFilter}
          searching={searching}
        />
      )}
      <div
        ref={scroller}
        onScroll={(e) => (scrollTop.current = e.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-ink-soft">
              <Bot className="size-6" />
            </span>
            <p className="mt-4 text-sm font-semibold">No agents yet</p>
            <p className="mt-1 max-w-xs text-[13px] text-muted">Sub-agents and background tasks show up here while Claude works.</p>
          </div>
        ) : shownCount === 0 ? (
          <div className="flex flex-col items-center px-6 py-10 text-center">
            <p className="text-sm font-semibold">Nothing matches</p>
            <Button size="sm" variant="secondary" className="mt-3" onClick={() => setFilter(NO_FILTER)}>
              Clear filters
            </Button>
          </div>
        ) : (
          <>
            <Group title="Agents" count={groups.agents.length}>
              {groups.agents.map(row)}
            </Group>
            <Group title="Commands" count={groups.commands.length}>
              {groups.commands.map(row)}
            </Group>
            <Group title="Failed" count={groups.failed.length} danger>
              {groups.failed.map(row)}
            </Group>
            <Group
              title="Done"
              count={groups.done.length}
              fold={filter.status === 'done' || filter.query.trim() ? undefined : { open: doneOpen, onToggle: () => setDoneOpen(!doneOpen) }}
            >
              {doneUnfolded && groups.done.slice(0, doneShown).map(row)}
            </Group>
            {doneUnfolded && groups.done.length > doneShown && (
              <div className="px-4 py-3">
                <Button size="sm" variant="secondary" className="w-full tap:min-h-11" onClick={() => setDoneShown(doneShown + DONE_PAGE)}>
                  Show more ({groups.done.length - doneShown})
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const CHIPS: { id: StatusFilter | KindFilter; kind: boolean; label: string; title: string; icon: ReactNode; count: (c: Counts) => number }[] = [
  { id: 'running', kind: false, label: 'Running', title: 'Running', icon: <Activity className="size-4" aria-hidden="true" />, count: (c) => c.running },
  { id: 'failed', kind: false, label: 'Failed', title: 'Failed or stopped', icon: <CircleAlert className="size-4" aria-hidden="true" />, count: (c) => c.failed },
  { id: 'done', kind: false, label: 'Done', title: 'Done', icon: <CircleCheck className="size-4" aria-hidden="true" />, count: (c) => c.done },
  { id: 'agents', kind: true, label: 'Agents', title: 'Sub-agents', icon: <Bot className="size-4" aria-hidden="true" />, count: (c) => c.agents },
  { id: 'commands', kind: true, label: 'Commands', title: 'Background commands', icon: <SquareTerminal className="size-4" aria-hidden="true" />, count: (c) => c.commands },
];

/**
 * The summary strip: each chip counts and filters (one status and one kind at a time; a second tap clears it). Icon and count (the chosen
 * chip says its name; each names itself on hover and to a screen reader), in one row that scrolls sideways rather than wrap into a taller
 * block: the panel is narrow at every width. The search field above it shows from 640 px, and behind the header's search button on a phone.
 */
function Toolbar({ counts, filter, onFilter, searching }: { counts: Counts; filter: ListFilter; onFilter: (f: ListFilter) => void; searching: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searching) input.current?.focus({ preventScroll: true });
  }, [searching]);
  return (
    <div className="shrink-0 border-b border-line">
      <div className={cn('px-4 pt-2.5', searching ? 'block' : 'hidden sm:block')}>
        <label className="relative block">
          <span className="sr-only">Search agents and commands</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            ref={input}
            id="agents-search"
            type="search"
            value={filter.query}
            onChange={(e) => onFilter({ ...filter, query: e.target.value })}
            onKeyDown={(e) => {
              // Escape clears the search first; the panel closes on the next one.
              if (e.key === 'Escape' && filter.query) {
                e.stopPropagation();
                onFilter({ ...filter, query: '' });
              }
            }}
            placeholder="Search"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="h-11 w-full rounded-full border border-line bg-surface pr-3 pl-9 text-[16px] text-ink placeholder:text-muted focus:border-primary focus:outline-none sm:h-9 sm:text-[13.5px] [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
      </div>
      <div className="relative flex gap-2 overflow-x-auto px-4 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="Filter">
        {CHIPS.map((c) => {
          const on = (c.kind ? filter.kind : filter.status) === c.id;
          const n = c.count(counts);
          if (!n && !on) return null;
          return (
            <button
              key={c.id}
              type="button"
              data-chip={c.id}
              aria-pressed={on}
              aria-label={`${c.label} ${n}`}
              title={c.title}
              onClick={() =>
                onFilter(c.kind ? { ...filter, kind: on ? null : (c.id as KindFilter) } : { ...filter, status: on ? null : (c.id as StatusFilter) })
              }
              className={cn(
                'press inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors sm:h-8 sm:min-w-0 sm:px-3',
                on ? 'border-primary bg-primary text-primary-ink' : 'border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink',
                !on && c.id === 'failed' && 'text-danger',
              )}
            >
              {c.icon}
              <span className={cn(!on && 'sr-only')}>{c.label}</span>
              <span className={cn('tabular-nums', on ? 'text-primary-ink/70' : 'text-muted')}>{n}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A group: a sticky header with its count (the done group's header folds it), then its rows. Hidden when it has none. */
function Group({ title, count, danger, fold, children }: { title: string; count: number; danger?: boolean; fold?: { open: boolean; onToggle: () => void }; children: ReactNode }) {
  const id = useId();
  if (!count) return null;
  const head = (
    <>
      <span className={cn('text-[11px] font-semibold tracking-wide uppercase', danger ? 'text-danger' : 'text-muted')}>{title}</span>
      <span className="text-[11px] font-semibold text-muted tabular-nums">{count}</span>
    </>
  );
  const cls = 'sticky top-0 z-10 flex min-h-9 w-full items-center gap-2 border-b border-line bg-bg px-4 text-left tap:min-h-11';
  return (
    <section aria-labelledby={id}>
      {fold ? (
        <button type="button" id={id} aria-expanded={fold.open} onClick={fold.onToggle} className={cn(cls, 'press hover:bg-surface-2')}>
          {head}
          <ChevronDown className={cn('ml-auto size-4 text-muted transition-transform motion-reduce:transition-none', !fold.open && '-rotate-90')} aria-hidden="true" />
        </button>
      ) : (
        <h3 id={id} className={cls}>
          {head}
        </h3>
      )}
      {(!fold || fold.open) && <ul className="divide-y divide-line border-b border-line">{children}</ul>}
    </section>
  );
}

const DOT: Record<ChatTask['status'], string> = {
  running: 'bg-accent motion-safe:animate-pulse',
  completed: 'bg-line-strong',
  failed: 'bg-danger',
  killed: 'bg-gold',
};
const TONE: Record<TaskLine['tone'], string> = {
  live: 'shimmer',
  muted: 'text-muted',
  danger: 'font-medium text-danger',
  warn: 'font-medium text-gold',
};

/**
 * One task, always two lines and the same height (the list holds still while lines change): its state as a dot, a short label, the model
 * of a sub-agent and the time; then what it does now or how it ended, one line, cut with an ellipsis. It opens the detail view; a running
 * one has Stop beside it. Plain values only, so a row renders again only when what it shows changed (a live line, its clock).
 */
const TaskRow = memo(function TaskRow({
  id,
  status,
  label,
  model,
  modelId,
  lead,
  tone,
  code,
  elapsed,
  onOpen,
  onStop,
  stopping,
  stopDisabled,
  failure,
}: {
  id: string;
  status: ChatTask['status'];
  label: string;
  /** A sub-agent's model label ("unavailable" until reported); null for a command. */
  model: string | null;
  /** The model id as Claude Code reported it, for the label's tooltip. */
  modelId: string | null;
  lead: string | null;
  tone: TaskLine['tone'];
  code: string | null;
  elapsed: string;
  onOpen: (taskId: string) => void;
  onStop?: (taskId: string) => void;
  stopping: boolean;
  stopDisabled: boolean;
  failure?: string;
}) {
  const state = (TASK_STATUS[status] ?? TASK_STATUS.running).label;
  return (
    <li className="flex h-15 items-stretch" data-task={id}>
      <button
        type="button"
        onClick={() => onOpen(id)}
        aria-label={`${label}, ${state}${model ? `, model ${model}` : ''}. Open`}
        className="press flex min-w-0 flex-1 items-center gap-3 pr-2 pl-4 text-left hover:bg-surface-2/60"
      >
        <span className={cn('size-2 shrink-0 rounded-full', DOT[status])} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13.5px] leading-5 font-semibold">{label}</span>
            {model && (
              <span
                title={modelId ?? 'Not reported yet'}
                className={cn('shrink-0 rounded px-1.5 py-px text-[10.5px] font-semibold tracking-wide uppercase', modelId ? 'bg-surface-2 text-ink-soft' : 'text-muted')}
              >
                {model}
              </span>
            )}
            {elapsed && <span className="shrink-0 text-[12px] text-muted tabular-nums">{elapsed}</span>}
          </span>
          <Line lead={lead} tone={tone} code={code} failure={failure && !stopping ? failure : undefined} />
        </span>
        {!onStop && <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden="true" />}
      </button>
      {onStop && (
        <span className="flex shrink-0 items-center pr-2">
          <Button
            size="icon"
            variant="ghost"
            icon={<CircleStop className="size-[18px]" aria-hidden="true" />}
            loading={stopping}
            disabled={stopDisabled}
            onClick={() => onStop(id)}
            aria-label={stopping ? `Stopping ${label}` : `Stop ${label}`}
            title={stopping ? 'Stopping…' : 'Stop'}
          />
        </span>
      )}
    </li>
  );
});

/** A row's second line: one line, cut with an ellipsis. A Stop that failed says why, in its place. */
function Line({ lead, tone, code, failure }: TaskLine & { failure?: string }) {
  if (failure)
    return (
      <span role="alert" className="block truncate text-[12.5px] leading-[18px] font-medium text-danger">
        {failure}
      </span>
    );
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 text-[12.5px] leading-[18px]">
      {lead && <span className={cn(code ? 'shrink-0' : 'min-w-0 truncate', TONE[tone])}>{lead}</span>}
      {code && (
        <span className="min-w-0 truncate text-[12px] text-muted" style={{ fontFamily: MONO }}>
          {code}
        </span>
      )}
    </span>
  );
}

/**
 * The agents panel below 1280 px: full screen on phones, a sheet from the right from 640 px.
 * A modal: focus moves in, Escape or × closes, and focus returns to the Agents button (⋯ on phones).
 */
export function AgentsSheet({ open, onClose, ...props }: AgentsProps & { open: boolean; onClose: () => void }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <MotionConfig reducedMotion="user">
      <AnimatePresence>{open && <Sheet key="agents" {...props} onClose={onClose} />}</AnimatePresence>
    </MotionConfig>,
    document.body,
  );
}

function Sheet({ onClose, ...props }: AgentsProps & { onClose: () => void }) {
  const ref = useModal<HTMLDivElement>(onClose);
  const titleId = useId();
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <motion.div
        className="absolute inset-0 bg-black/35"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={onClose}
        aria-hidden="true"
      />
      <motion.div
        ref={ref}
        id="agents-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%', transition: { duration: 0.18, ease } }}
        transition={{ duration: 0.24, ease }}
        className="relative flex h-full w-full flex-col bg-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-lift outline-none sm:w-[400px] sm:border-l sm:border-line"
      >
        <AgentsPanel {...props} onClose={onClose} closeLabel="Close agents" titleId={titleId} />
      </motion.div>
    </div>
  );
}
