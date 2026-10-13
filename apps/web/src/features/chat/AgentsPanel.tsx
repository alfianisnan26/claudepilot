import { Badge, Button, ease, Spinner, useToast } from '@isnanme/ui';
import type { ChatTask } from '@portal/contracts';
import { Bot, ChevronRight, Square, X } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { errorText } from '@/lib/api';
import { AgentDetail, TASK_STATUS as STATUS, taskMs } from './AgentDetail';
import { isAgentTask, modelShort } from './agentFold';
import type { AgentLive } from './motion/deltas';
import { AgentTag, formatDuration, formatTokens, useModal, useNow } from './shared';

/** After its ack, how long a stopped task's row waits for the task to report it ended before Stop is offered again. */
const STOP_GRACE_MS = 15_000;

/** Running first, then the most recently started. */
const byActivity = (a: ChatTask, b: ChatTask) =>
  Number(b.status === 'running') - Number(a.status === 'running') || Date.parse(b.startedAt) - Date.parse(a.startedAt);

/** "2 running · 3 done · 1 failed". */
function tasksSummary(tasks: ChatTask[]): string {
  const count = (status: ChatTask['status']) => tasks.filter((t) => t.status === status).length;
  const parts = [
    [count('running'), 'running'],
    [count('completed'), 'done'],
    [count('failed'), 'failed'],
    [count('killed'), 'stopped'],
  ].flatMap(([n, word]) => (n ? [`${n} ${word}`] : []));
  return parts.length ? parts.join(' · ') : 'Nothing running';
}

interface AgentsProps {
  /** The session: a sub-agent's detail view reads its transcript from it. */
  sessionId: string;
  tasks: ChatTask[];
  /** What each sub-agent is writing now, by its Task call: the detail view's live line. */
  agentLive?: ReadonlyMap<string, AgentLive>;
  /** The sub-agent whose detail view is open (its task id), or null for the list; the transcript's agent rows open one too. */
  selected: string | null;
  onSelect: (taskId: string | null) => void;
  /** Stops one running task (`stop_task`), settling on its ack. Without it there's no Stop. */
  onStopTask?: (taskId: string) => Promise<void>;
  /** Interrupts the turn (`stop`): the first half of Stop all. */
  onInterrupt?: () => Promise<void>;
  /** While the socket is down, Stop waits. */
  connected?: boolean;
}

/**
 * The session's sub-agents and background tasks: what each is doing, its type, status, tokens,
 * tool uses, time and summary, with Stop on each running one and Stop all above them. The same
 * content fills the side panel on wide screens and the sheet below them.
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
  const sorted = useMemo(() => [...tasks].sort(byActivity), [tasks]);
  const now = useNow(tasks.some((t) => t.status === 'running'));
  const running = sorted.filter((t) => t.status === 'running');
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

  const chosen = selected ? tasks.find((t) => t.taskId === selected) : undefined;
  if (chosen)
    return (
      <AgentDetail
        sessionId={sessionId}
        task={chosen}
        live={chosen.toolUseId ? agentLive?.get(chosen.toolUseId) : undefined}
        onBack={() => onSelect(null)}
        onClose={onClose}
        closeLabel={closeLabel}
        titleId={titleId}
        onStop={onStopTask ? () => void stopOne(chosen.taskId) : undefined}
        stopping={stopping.has(chosen.taskId)}
        stopDisabled={!connected}
        failure={chosen.status === 'running' ? failures.get(chosen.taskId) : undefined}
      />
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-semibold">
            Agents
          </h2>
          <p className="truncate text-[11px] text-muted">{tasksSummary(tasks)}</p>
        </div>
        {onStopTask && running.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            icon={<Square className="size-3.5" />}
            loading={stoppingAll}
            disabled={!connected}
            onClick={() => void stopAll()}
            aria-label={`Stop all: the turn and ${running.length === 1 ? 'the running agent' : `${running.length} running agents`}`}
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
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-ink-soft">
              <Bot className="size-6" />
            </span>
            <p className="mt-4 text-sm font-semibold">No agents yet</p>
            <p className="mt-1 max-w-xs text-[13px] text-muted">Sub-agents and background tasks show up here while Claude works.</p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {sorted.map((t) => (
              <TaskRow
                key={t.taskId}
                task={t}
                now={now}
                onOpen={() => onSelect(t.taskId)}
                onStop={onStopTask ? () => void stopOne(t.taskId) : undefined}
                stopping={stopping.has(t.taskId)}
                stopDisabled={!connected}
                failure={t.status === 'running' ? failures.get(t.taskId) : undefined}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TaskRow({
  task: t,
  now,
  onOpen,
  onStop,
  stopping,
  stopDisabled,
  failure,
}: {
  task: ChatTask;
  now: number;
  onOpen: () => void;
  onStop?: () => void;
  stopping: boolean;
  stopDisabled: boolean;
  failure?: string;
}) {
  const status = STATUS[t.status] ?? STATUS.running;
  const ms = taskMs(t, now);
  const facts = [
    t.tokens != null && `${formatTokens(t.tokens)} tokens`,
    t.toolUses != null && `${t.toolUses} ${t.toolUses === 1 ? 'tool use' : 'tool uses'}`,
    Number.isFinite(ms) && formatDuration(ms),
  ].filter((f): f is string => !!f);
  const name = t.description || 'Task';
  // A sub-agent's model as Claude Code reported it; "unavailable" until it did. A background command has none.
  const model = isAgentTask(t) ? (modelShort(t.model) ?? 'unavailable') : null;
  return (
    <li>
      <button type="button" onClick={onOpen} aria-label={`${name}, ${status.label}${model ? `, model ${model}` : ''}. Open`} className="press flex w-full items-start gap-2 px-4 pt-3 pb-3 text-left hover:bg-surface-2/60">
        <span className="min-w-0 flex-1">
          <span className="flex items-start gap-2">
            <span className="min-w-0 flex-1 text-[13.5px] leading-snug font-semibold break-words">{name}</span>
            {model && (
              <span
                title={t.model ?? 'Not reported yet'}
                className={`mt-0.5 shrink-0 rounded px-1.5 py-px text-[10.5px] font-semibold tracking-wide uppercase ${t.model ? 'bg-surface-2 text-ink-soft' : 'text-muted'}`}
              >
                {model}
              </span>
            )}
            <Badge tone={status.tone} className="shrink-0">
              {t.status === 'running' && <Spinner className="size-3" />}
              {status.label}
            </Badge>
          </span>
          {(t.subagentType || facts.length > 0) && (
            <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-muted">
              {t.subagentType && <AgentTag label={t.subagentType} />}
              {facts.length > 0 && <span className="tabular-nums">{facts.join(' · ')}</span>}
            </span>
          )}
          {t.summary && <span className="mt-1.5 line-clamp-2 block text-[12.5px] break-words text-ink-soft">{t.summary}</span>}
        </span>
        <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
      </button>
      {onStop && t.status === 'running' && (
        <div className="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pb-3">
          <Button
            size="sm"
            variant="secondary"
            icon={<Square className="size-3.5" />}
            loading={stopping}
            disabled={stopDisabled}
            onClick={onStop}
            aria-label={stopping ? `Stopping ${name}` : `Stop ${name}`}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </Button>
          {failure && !stopping && (
            <p role="alert" className="min-w-0 flex-1 text-[12.5px] font-medium break-words text-danger">
              {failure}
            </p>
          )}
        </div>
      )}
    </li>
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
