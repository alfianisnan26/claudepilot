import { Badge, ease, Spinner, type BadgeTone } from '@isnanme/ui';
import type { ChatTask } from '@portal/contracts';
import { Bot, X } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useId, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { AgentTag, formatDuration, formatTokens, useModal, useNow } from './shared';

const STATUS: Record<ChatTask['status'], { label: string; tone: BadgeTone }> = {
  running: { label: 'Running', tone: 'success' },
  completed: { label: 'Done', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  killed: { label: 'Stopped', tone: 'danger' },
};

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

/**
 * The session's sub-agents and background tasks: what each is doing, its type, status, tokens,
 * tool uses, time and summary. The same content fills the side panel on wide screens and the
 * sheet below them.
 */
export function AgentsPanel({
  tasks,
  onClose,
  closeLabel,
  titleId,
}: {
  tasks: ChatTask[];
  onClose: () => void;
  closeLabel: string;
  titleId?: string;
}) {
  const sorted = useMemo(() => [...tasks].sort(byActivity), [tasks]);
  const now = useNow(tasks.some((t) => t.status === 'running'));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-semibold">
            Agents
          </h2>
          <p className="truncate text-[11px] text-muted">{tasksSummary(tasks)}</p>
        </div>
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
              <TaskRow key={t.taskId} task={t} now={now} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TaskRow({ task: t, now }: { task: ChatTask; now: number }) {
  const status = STATUS[t.status] ?? STATUS.running;
  const started = Date.parse(t.startedAt);
  // Running: live from its start. Finished: what it reported, else start to end.
  const ms =
    t.status === 'running'
      ? now - started
      : (t.durationMs ?? (t.endedAt ? Date.parse(t.endedAt) - started : Number.NaN));
  const facts = [
    t.tokens != null && `${formatTokens(t.tokens)} tokens`,
    t.toolUses != null && `${t.toolUses} ${t.toolUses === 1 ? 'tool use' : 'tool uses'}`,
    Number.isFinite(ms) && formatDuration(ms),
  ].filter((f): f is string => !!f);
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[13.5px] leading-snug font-semibold break-words">{t.description || 'Task'}</p>
        <Badge tone={status.tone} className="shrink-0">
          {t.status === 'running' && <Spinner className="size-3" />}
          {status.label}
        </Badge>
      </div>
      {(t.subagentType || facts.length > 0) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-muted">
          {t.subagentType && <AgentTag label={t.subagentType} />}
          {facts.length > 0 && <span className="tabular-nums">{facts.join(' · ')}</span>}
        </div>
      )}
      {t.summary && (
        <p title={t.summary} className="mt-1.5 line-clamp-2 text-[12.5px] break-words text-ink-soft">
          {t.summary}
        </p>
      )}
    </li>
  );
}

/**
 * The agents panel below 1280 px: full screen on phones, a sheet from the right from 640 px.
 * A modal: focus moves in, Escape or × closes, and focus returns to the Agents button.
 */
export function AgentsSheet({ open, tasks, onClose }: { open: boolean; tasks: ChatTask[]; onClose: () => void }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <MotionConfig reducedMotion="user">
      <AnimatePresence>{open && <Sheet key="agents" tasks={tasks} onClose={onClose} />}</AnimatePresence>
    </MotionConfig>,
    document.body,
  );
}

function Sheet({ tasks, onClose }: { tasks: ChatTask[]; onClose: () => void }) {
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
        <AgentsPanel tasks={tasks} onClose={onClose} closeLabel="Close agents" titleId={titleId} />
      </motion.div>
    </div>
  );
}
