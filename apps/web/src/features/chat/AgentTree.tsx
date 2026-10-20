import { Button, cn, EmptyState, useToast } from '@isnanme/ui';
import { CHAT_SOCKET_PATH, type ChatServerMessage, type ChatSession } from '@portal/contracts';
import { AlertTriangle, Check, ChevronDown, ChevronUp, LoaderCircle, Moon, Network, Pause, UserRound } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { Popover } from '@/components/Popover';
import { useNow } from '@/features/usage/claude/useClaudeUsage';
import { errorText } from '@/lib/api';
import {
  buildAgentTrees,
  costLabel,
  dismissFailed,
  elapsedLabel,
  isDismissed,
  readDismissed,
  RESUME_MESSAGE,
  retryKind,
  STATUS_LABEL,
  type AgentNode,
  type AgentStatus,
  type AgentTreeData,
} from './agentTreeData';
import { chatApi } from './api';
import './agentTree.css';

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * T-1710: the Agents tree, the Tree view of the Agents page. Each lead that started workers, as connected cards (agentTreeData.ts has the
 * rules): on a phone an indented column, from 1024 px the lead's workers in a row under it (the owner's reference). It reads the list the
 * page already polls, so it updates with it; the clock ticks each second for the running ones' time.
 */
export function AgentTreeView({ sessions, query, onChanged }: { sessions: readonly ChatSession[]; query: string; onChanged: () => void }) {
  const now = useNow(1000);
  const [dismissed, setDismissed] = useState<Record<string, string>>(() => readDismissed());
  const trees = useMemo(
    () => buildAgentTrees(sessions, { now, query, dismissed: (s) => isDismissed(dismissed, s) }),
    [sessions, now, query, dismissed],
  );
  const dismiss = useCallback((s: ChatSession) => setDismissed((d) => dismissFailed(s, d)), []);

  if (trees.length === 0)
    return (
      <EmptyState icon={<Network className="size-6" />} title={query ? 'No crews match' : 'No crews yet'}>
        An agent that starts workers shows here with them, as a tree.
      </EmptyState>
    );
  return (
    <MotionConfig reducedMotion="user">
      <div className="at-tree flex flex-col gap-6" data-agent-tree="">
        {trees.map((t) => (
          <TreeSection key={t.root.session.id} tree={t} onDismiss={dismiss} onChanged={onChanged} />
        ))}
      </div>
    </MotionConfig>
  );
}

function TreeSection({ tree, onDismiss, onChanged }: { tree: AgentTreeData; onDismiss: (s: ChatSession) => void; onChanged: () => void }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (id: string) => setCollapsed((c) => (c.has(id) ? new Set([...c].filter((x) => x !== id)) : new Set(c).add(id))),
    [],
  );
  // A row wider than the page starts with the lead in view (the lead sits in the middle of its row), not at the row's left edge.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, []);
  return (
    <section aria-label={`${tree.root.name}: ${tree.total} agents`} data-agent-tree-root={tree.root.session.id}>
      <TreeHeader tree={tree} onDismiss={onDismiss} onChanged={onChanged} />
      {/* From 1024 px the row can be wider than the page: it scrolls inside this box, never the page. */}
      <div ref={scroller} className="expanded:overflow-x-auto expanded:pb-2">
        <div className="at-root flex flex-col expanded:mx-auto expanded:w-max">
          <Branch node={tree.root} depth={0} collapsed={collapsed} onToggle={toggle} />
        </div>
      </div>
    </section>
  );
}

/** "8 agents · 4 running · 1 failed ⌃ · $1.52": the failed count opens the list of failed agents. */
function TreeHeader({ tree, onDismiss, onChanged }: { tree: AgentTreeData; onDismiss: (s: ChatSession) => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);
  const failed = tree.failed.length;
  useEffect(() => {
    if (open && failed === 0) setOpen(false);
  }, [open, failed]);
  return (
    <div className="mb-2 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[13.5px]">
      <span className="text-muted tabular-nums">{plural(tree.total, 'agent')}</span>
      {tree.running > 0 && <span className="font-semibold text-sky-700 tabular-nums dark:text-sky-300">{tree.running} running</span>}
      {failed > 0 && (
        <button
          ref={button}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          data-agent-failed=""
          className="press inline-flex min-h-11 items-center gap-1 rounded-full bg-danger-soft px-3 font-semibold text-danger tabular-nums focus-visible:ring-2 focus-visible:ring-danger/40 focus-visible:outline-hidden"
        >
          {failed} failed
          {open ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
        </button>
      )}
      <span className="ml-auto font-semibold text-ink tabular-nums">{costLabel(tree.costUsd)}</span>
      <InfoTip label="About the cost">
        What the agents in this tree cost so far, at list price (for a plan, not a bill). A running turn counts as an estimate until it ends.
      </InfoTip>
      <Popover anchor={button} open={open && failed > 0} onClose={close} label="Failed agents" prefer="below" width={360}>
        <FailedList nodes={tree.failed} onDismiss={onDismiss} onChanged={onChanged} />
      </Popover>
    </div>
  );
}

function FailedList({ nodes, onDismiss, onChanged }: { nodes: AgentNode[]; onDismiss: (s: ChatSession) => void; onChanged: () => void }) {
  const list = useRef<HTMLUListElement>(null);
  // Keyboard: the first action takes focus when the list opens (Escape closes it and gives focus back to "N failed").
  useEffect(() => {
    const id = requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('a, button')?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <ul ref={list} className="flex flex-col divide-y divide-line">
      {nodes.map((n) => (
        <FailedItem key={n.session.id} node={n} onDismiss={onDismiss} onChanged={onChanged} />
      ))}
    </ul>
  );
}

function FailedItem({ node, onDismiss, onChanged }: { node: AgentNode; onDismiss: (s: ChatSession) => void; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const s = node.session;
  const kind = retryKind(s);
  const retry = async () => {
    setBusy(true);
    try {
      if (kind === 'recover') await chatApi.recover(s.id);
      else await sendOnce(s.id, RESUME_MESSAGE);
      toast('Retrying');
      onChanged();
    } catch (e) {
      toast(errorText(e, 'Could not retry it. Open it to see why.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <Link to={`/admin/sessions/${s.id}`} className="font-semibold text-ink underline-offset-2 hover:underline">
            {node.name}
          </Link>
          {node.task && <span className="text-muted"> {node.task}</span>}
          {s.endedReason && <p className="mt-0.5 text-[13px] text-ink-soft">{s.endedReason}</p>}
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" className="min-h-11" onClick={() => onDismiss(s)}>
          Dismiss
        </Button>
        {kind && (
          <Button size="sm" className="min-h-11" loading={busy} onClick={() => void retry()}>
            Retry
          </Button>
        )}
      </div>
    </li>
  );
}

/** A card and, below it, its workers: in a row under the lead from 1024 px, else an indented column. */
function Branch({
  node,
  depth,
  collapsed,
  onToggle,
}: {
  node: AgentNode;
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const id = node.session.id;
  const open = !collapsed.has(id);
  const kids = node.children.length > 0;
  // Motion's reducedMotion="user" drops transforms but still tweens height and opacity: with the setting on, the subtree just appears.
  const still = useReducedMotion();
  return (
    <>
      <AgentCard node={node} wide={depth <= 1} open={open} onToggle={kids ? () => onToggle(id) : undefined} />
      <AnimatePresence initial={false}>
        {kids && open && (
          <motion.div
            key="kids"
            id={`at-kids-${id}`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: still ? 0 : 0.22, ease: EASE }}
            className="overflow-hidden"
          >
            <ul className={cn('at-col', depth === 0 && 'at-row')}>
              <AnimatePresence initial={false}>
                {node.children.map((c) => (
                  <motion.li
                    key={c.session.id}
                    className="at-item"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.24, ease: EASE }}
                  >
                    <Branch node={c} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} />
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function AgentCard({ node, wide, open, onToggle }: { node: AgentNode; wide: boolean; open: boolean; onToggle?: () => void }) {
  const s = node.session;
  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: EASE }}
      data-agent-card={s.id}
      data-agent-status={node.status}
      className={cn(
        'relative w-full min-w-0 rounded-2xl border border-line bg-surface px-3.5 py-3 shadow-sm',
        // From 1024 px a lead's and a worker's card are one width (agentTree.css --at-card); the cards below a worker fit in its column.
        wide && 'expanded:w-[18.5rem]',
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <Link
            to={`/admin/sessions/${s.id}`}
            // The link stretches over the whole card (a 44 px target on a phone); the collapse button sits above it.
            className="block rounded-md text-[15px] leading-snug font-semibold text-ink [overflow-wrap:anywhere] after:absolute after:inset-0 after:rounded-2xl hover:underline focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-hidden"
          >
            {node.name}
          </Link>
          {node.model && <span className="block text-[12.5px] text-muted">{node.model}</span>}
        </div>
        <StatusPill status={node.status} />
      </div>
      {(node.task || s.ticketId) && (
        <p className="mt-1.5 text-[13.5px] leading-snug text-ink-soft [overflow-wrap:anywhere]">
          {s.ticketId && <span className="mr-1.5 font-mono text-[12px] text-muted" title={s.ticketId}>{s.ticketKey ?? s.ticketId}</span>}
          {node.task}
        </p>
      )}
      <div className="mt-1.5 flex min-h-6 items-center gap-1 text-[13px] tabular-nums">
        <span className="font-semibold text-ink">{costLabel(node.costUsd)}</span>
        <span className="text-muted">· {elapsedLabel(node.elapsedMs)}</span>
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={`at-kids-${s.id}`}
            aria-label={`${open ? 'Hide' : 'Show'} ${plural(node.descendants, 'worker')}`}
            className="press relative z-10 -my-2.5 -mr-2 ml-auto inline-flex min-h-11 min-w-11 items-center justify-center gap-0.5 rounded-full px-2 text-muted hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-hidden"
          >
            {node.descendants}
            <ChevronDown className={cn('size-4 transition-transform motion-reduce:transition-none', !open && '-rotate-90')} aria-hidden="true" />
          </button>
        )}
      </div>
    </motion.article>
  );
}

const PILL: Record<AgentStatus, { className: string; icon: React.ReactNode }> = {
  running: { className: 'bg-sky-500/12 text-sky-700 dark:text-sky-300', icon: <LoaderCircle className="at-spin size-3" aria-hidden="true" /> },
  waiting: { className: 'bg-amber-500/12 text-amber-700 dark:text-amber-400', icon: <UserRound className="size-3" aria-hidden="true" /> },
  failed: { className: 'bg-danger-soft text-danger', icon: <AlertTriangle className="size-3" aria-hidden="true" /> },
  done: { className: 'bg-accent-soft text-accent', icon: <Check className="size-3" aria-hidden="true" /> },
  asleep: { className: 'bg-surface-2 text-ink-soft', icon: <Moon className="size-3" aria-hidden="true" /> },
  idle: { className: 'bg-surface-2 text-ink-soft', icon: <Pause className="size-3" aria-hidden="true" /> },
};

/** The status, cross-fading when it changes. */
function StatusPill({ status }: { status: AgentStatus }) {
  const p = PILL[status];
  return (
    <span className="relative inline-grid shrink-0">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={status}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap', p.className)}
        >
          {p.icon}
          {STATUS_LABEL[status]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * Sends one message to an agent over the chat socket (the same `send` the composer uses; sending resumes an interrupted agent) and waits
 * for the portal's answer. Its own short-lived socket: the list page holds none.
 */
function sendOnce(session: string, text: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${CHAT_SOCKET_PATH}`);
    const uuid = crypto.randomUUID();
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve();
    };
    const timer = window.setTimeout(() => finish(new Error('No answer from the portal. Open the agent to check.')), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'send', session, uuid, text }));
    ws.onmessage = (e) => {
      let msg: ChatServerMessage;
      try {
        msg = JSON.parse(String(e.data)) as ChatServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'ack' && msg.uuid === uuid) finish(msg.ok ? undefined : new Error(msg.error || 'That didn’t go through.'));
      else if (msg.type === 'error' && msg.session === session) finish(new Error(msg.message));
    };
    ws.onerror = () => finish(new Error('Could not reach the portal.'));
    ws.onclose = () => finish(new Error('The connection closed before the portal answered.'));
  });
}
