import { Button, cn, EmptyState, useToast } from '@isnanme/ui';
import { CHAT_SOCKET_PATH, type ChatServerMessage, type ChatSession } from '@portal/contracts';
import { AlertTriangle, Bot, Check, ChevronDown, ChevronUp, Cpu, GitBranch, LoaderCircle, Moon, Network, Pause, ShieldAlert, UserRound } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import claudeIcon from '@/assets/icons/claude-ai.svg';
import geminiIcon from '@/assets/icons/google-gemini.svg';
import ollamaIcon from '@/assets/icons/ollama.svg';
import openaiIcon from '@/assets/icons/openai.svg';
import { InfoTip } from '@/components/InfoTip';
import { useNow } from '@/features/usage/claude/useClaudeUsage';
import { errorText } from '@/lib/api';
import {
  agentFacets,
  buildAgentTrees,
  costParts,
  dismissFailed,
  edgeFade,
  elapsedLabel,
  filterTree,
  foldedLabel,
  isDismissed,
  modelMaker,
  readDismissed,
  readFilter,
  RESUME_MESSAGE,
  retryKind,
  STATUS_LABEL,
  writeFilter,
  type AgentFacet,
  type AgentNode,
  type AgentStatus,
  type AgentTreeData,
  type ModelMaker,
  type TreeFilter,
} from './agentTreeData';
import { chatApi } from './api';
import './agentTree.css';

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * T-1710: the Agents tree, the Tree view of the Agents page. Each lead that started workers, as connected cards (agentTreeData.ts has the
 * rules): on a phone an indented column, from 1024 px the lead's workers in a row under it (the owner's reference). It reads the list the
 * page already polls, so it updates with it; the clock ticks each second for the running ones' time. T-1853: by default only the agents at
 * work (and the leads above them) show; the rest folds behind a count, and a filter (kept per viewer) shows Waiting only or All.
 */
export function AgentTreeView({ sessions, query, onChanged }: { sessions: readonly ChatSession[]; query: string; onChanged: () => void }) {
  const now = useNow(1000);
  const [dismissed, setDismissed] = useState<Record<string, string>>(() => readDismissed());
  const trees = useMemo(
    () => buildAgentTrees(sessions, { now, query, dismissed: (s) => isDismissed(dismissed, s) }),
    [sessions, now, query, dismissed],
  );
  const dismiss = useCallback((s: ChatSession) => setDismissed((d) => dismissFailed(s, d)), []);
  const [filter, setFilterState] = useState<TreeFilter>(() => readFilter());
  const setFilter = useCallback((f: TreeFilter) => {
    setFilterState(f);
    writeFilter(f);
  }, []);

  if (trees.length === 0)
    return (
      <EmptyState icon={<Network className="size-6" />} title={query ? 'No crews match' : 'No crews yet'}>
        An agent that starts workers shows here with them, as a tree.
      </EmptyState>
    );
  return (
    <MotionConfig reducedMotion="user">
      <div className="at-tree flex flex-col gap-6" data-agent-tree="">
        <FilterBar value={filter} onChange={setFilter} />
        {trees.map((t) => (
          <TreeSection key={t.root.session.id} tree={t} filter={filter} onShowAll={() => setFilter('all')} onDismiss={dismiss} onChanged={onChanged} />
        ))}
      </div>
    </MotionConfig>
  );
}

const FILTER_LABEL: Record<TreeFilter, string> = { active: 'Active', waiting: 'Waiting', all: 'All' };

/** All / Active / Waiting, for every tree on the page. */
function FilterBar({ value, onChange }: { value: TreeFilter; onChange: (f: TreeFilter) => void }) {
  return (
    <div className="-mb-3 flex items-center gap-1" role="group" aria-label="Show agents">
      {(['all', 'active', 'waiting'] as const satisfies readonly TreeFilter[]).map((f) => (
        <button
          key={f}
          type="button"
          aria-pressed={value === f}
          onClick={() => onChange(f)}
          data-agent-filter={f}
          className={cn(
            'press inline-flex min-h-11 items-center rounded-full px-3.5 text-[13.5px] font-semibold focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-hidden',
            value === f ? 'bg-ink text-surface' : 'text-muted hover:bg-surface-2 hover:text-ink',
          )}
        >
          {FILTER_LABEL[f]}
        </button>
      ))}
      <InfoTip label="About the filter">
        Active shows the agents at work and waiting on you, with the leads above them; Waiting only those waiting. The rest folds behind a count
        under each tree. Kept in this browser.
      </InfoTip>
    </div>
  );
}

function TreeSection({
  tree,
  filter,
  onShowAll,
  onDismiss,
  onChanged,
}: {
  tree: AgentTreeData;
  filter: TreeFilter;
  onShowAll: () => void;
  onDismiss: (s: ChatSession) => void;
  onChanged: () => void;
}) {
  const shown = useMemo(() => filterTree(tree.root, filter), [tree.root, filter]);
  // "N failed" opens the failed list in the page's flow, right under the lead's card (T-1825: a floating list kept covering cards).
  const [failedOpen, setFailedOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const failed = tree.failed.length;
  useEffect(() => {
    if (failedOpen && failed === 0) setFailedOpen(false);
  }, [failedOpen, failed]);
  const closeFailed = useCallback(() => {
    setFailedOpen(false);
    chip.current?.focus();
  }, []);
  const stripId = `at-failed-${tree.root.session.id}`;
  const more = foldedLabel(shown.folded);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (id: string) => setCollapsed((c) => (c.has(id) ? new Set([...c].filter((x) => x !== id)) : new Set(c).add(id))),
    [],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const lead = tree.root.session.id;
  const leadCard = useCallback(() => scroller.current?.querySelector(`[data-agent-card="${CSS.escape(lead)}"]`) ?? null, [lead]);
  // A row wider than the page shows the lead in its middle, not the row's left edge: when it opens, when the filter changes, and whenever
  // the row's width changes (a fold, new workers) until the person scrolls it by hand (T-1825 QA: All widened the row past the lead).
  const byHand = useRef(false);
  const centre = useCallback(() => {
    const el = scroller.current;
    const card = leadCard();
    if (!el || !card || el.scrollWidth <= el.clientWidth) return;
    const box = el.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    el.scrollLeft += (c.left + c.right) / 2 - (box.left + box.right) / 2;
  }, [leadCard]);
  useLayoutEffect(() => {
    byHand.current = false;
    centre();
  }, [filter, centre]);
  useEffect(() => {
    const el = scroller.current;
    const row = el?.firstElementChild;
    if (!el || !row || typeof ResizeObserver === 'undefined') return;
    const mark = () => {
      byHand.current = true;
    };
    const keys = (e: KeyboardEvent) => /^(Arrow(Left|Right)|Home|End)$/.test(e.key) && mark();
    // The scroll bar itself is the box (a press on a card or a button inside it is not a scroll).
    const bar = (e: PointerEvent) => e.target === el && mark();
    el.addEventListener('wheel', mark, { passive: true });
    el.addEventListener('touchmove', mark, { passive: true });
    el.addEventListener('keydown', keys);
    el.addEventListener('pointerdown', bar);
    let width = row.getBoundingClientRect().width;
    const ro = new ResizeObserver(() => {
      const w = row.getBoundingClientRect().width;
      if (Math.abs(w - width) < 1) return;
      width = w;
      if (!byHand.current) centre();
    });
    ro.observe(row);
    return () => {
      el.removeEventListener('wheel', mark);
      el.removeEventListener('touchmove', mark);
      el.removeEventListener('keydown', keys);
      el.removeEventListener('pointerdown', bar);
      ro.disconnect();
    };
  }, [centre]);
  // T-1825: an edge with more of the row beyond it fades out, the cue that the row scrolls (agentTree.css .at-scroll).
  const [fade, setFade] = useState({ left: false, right: false });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const f = edgeFade(el.scrollLeft, el.scrollWidth, el.clientWidth);
      setFade((o) => (o.left === f.left && o.right === f.right ? o : f));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, []);
  return (
    <section aria-label={`${tree.root.name}: ${tree.total} agents`} data-agent-tree-root={tree.root.session.id}>
      <TreeHeader tree={tree} chip={chip} open={failedOpen} controls={stripId} onToggle={() => setFailedOpen((o) => !o)} />
      {/* From 1024 px the row can be wider than the page: it scrolls inside this box, never the page. */}
      <div
        ref={scroller}
        className="at-scroll expanded:overflow-x-auto expanded:pb-2"
        data-fade-left={fade.left || undefined}
        data-fade-right={fade.right || undefined}
      >
        <div className="at-root flex flex-col expanded:mx-auto expanded:w-max">
          <Branch
            node={shown.root}
            depth={0}
            collapsed={collapsed}
            onToggle={toggle}
            under={
              <FailedStrip id={stripId} open={failedOpen && failed > 0} nodes={tree.failed} onClose={closeFailed} onDismiss={onDismiss} onChanged={onChanged} />
            }
          />
        </div>
      </div>
      {more && (
        <button
          type="button"
          onClick={onShowAll}
          data-agent-folded=""
          aria-label={`Show all: ${more.slice(1)} hidden`}
          className="press mt-1 inline-flex min-h-11 items-center rounded-full px-3 text-[13px] font-semibold text-muted tabular-nums hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-hidden expanded:mx-auto expanded:flex"
        >
          {more}
        </button>
      )}
    </section>
  );
}

/** "8 agents · 4 running · 1 failed ⌃ · $1.52": the failed count opens the failed list under the lead's card. */
function TreeHeader({
  tree,
  chip,
  open,
  controls,
  onToggle,
}: {
  tree: AgentTreeData;
  chip: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  controls: string;
  onToggle: () => void;
}) {
  const failed = tree.failed.length;
  return (
    <div className="mb-2 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[13.5px]">
      <span className="text-muted tabular-nums">{plural(tree.total, 'agent')}</span>
      {tree.running > 0 && <span className="font-semibold text-sky-700 tabular-nums dark:text-sky-300">{tree.running} running</span>}
      {failed > 0 && (
        <button
          ref={chip}
          type="button"
          aria-expanded={open}
          aria-controls={controls}
          onClick={onToggle}
          data-agent-failed=""
          className="press inline-flex min-h-11 items-center gap-1 rounded-full bg-danger-soft px-3 font-semibold text-danger tabular-nums focus-visible:ring-2 focus-visible:ring-danger/40 focus-visible:outline-hidden"
        >
          {failed} failed
          {open ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
        </button>
      )}
      <Cost usd={tree.costUsd} className="ml-auto font-semibold text-ink tabular-nums" />
      <InfoTip label="About the cost">
        What the agents in this tree cost so far, at list price (for a plan, not a bill). A running turn counts as an estimate until it ends.
      </InfoTip>
    </div>
  );
}

/** The failed agents, in the flow under the lead's card (as wide as it), one line each; it pushes the workers down, so it covers nothing. */
function FailedStrip({
  id,
  open,
  nodes,
  onClose,
  onDismiss,
  onChanged,
}: {
  id: string;
  open: boolean;
  nodes: AgentNode[];
  onClose: () => void;
  onDismiss: (s: ChatSession) => void;
  onChanged: () => void;
}) {
  const still = useReducedMotion();
  const list = useRef<HTMLUListElement>(null);
  // Keyboard: the first link takes focus when it opens; Escape closes it and gives focus back to "N failed".
  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('a, button')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(t);
  }, [open]);
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="failed"
          id={id}
          role="region"
          aria-label="Failed agents"
          data-agent-failed-strip=""
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: still ? 0 : 0.22, ease: EASE }}
          // As wide as the lead's card (AgentCard: 22rem from 1024 px).
          className="w-full overflow-hidden expanded:w-[22rem]"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onClose();
            }
          }}
        >
          <ul ref={list} className="mt-1.5 flex flex-col divide-y divide-line rounded-2xl border border-danger/25 bg-surface px-2 shadow-sm">
            {nodes.map((n) => (
              <FailedItem key={n.session.id} node={n} onDismiss={onDismiss} onChanged={onChanged} />
            ))}
          </ul>
        </motion.div>
      )}
    </AnimatePresence>
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
  const about = [node.task, s.endedReason].filter(Boolean).join(' · ');
  return (
    <li className="flex min-w-0 items-center gap-1.5 py-1 text-[13.5px]" title={about || undefined}>
      <AlertTriangle className="size-4 shrink-0 text-danger" aria-hidden="true" />
      <Link
        to={`/admin/sessions/${s.id}`}
        className="flex min-h-11 min-w-11 max-w-[45%] shrink-0 items-center truncate rounded-md font-semibold text-ink underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-hidden"
      >
        <span className="truncate">{node.name}</span>
      </Link>
      <span className="min-w-0 flex-1 truncate text-muted">{node.task}</span>
      {about && <span className="sr-only">{about}</span>}
      <Button variant="secondary" size="sm" className="min-h-11 shrink-0 px-2.5" onClick={() => onDismiss(s)}>
        Dismiss
      </Button>
      {kind && (
        <Button size="sm" className="min-h-11 shrink-0 px-2.5" loading={busy} onClick={() => void retry()}>
          Retry
        </Button>
      )}
    </li>
  );
}

/** A card and, below it, its workers: in a row under the lead from 1024 px, else an indented column. */
function Branch({
  node,
  depth,
  collapsed,
  onToggle,
  under,
}: {
  node: AgentNode;
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** What sits between the card and its workers (the lead's failed list). */
  under?: React.ReactNode;
}) {
  const id = node.session.id;
  const open = !collapsed.has(id);
  const kids = node.children.length > 0;
  // Motion's reducedMotion="user" drops transforms but still tweens height and opacity: with the setting on, the subtree just appears.
  const still = useReducedMotion();
  return (
    <>
      <AgentCard node={node} depth={depth} open={open} onToggle={kids ? () => onToggle(id) : undefined} />
      {under}
      <AnimatePresence initial={false}>
        {kids && open && (
          <motion.div
            key="kids"
            id={`at-kids-${id}`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: still ? 0 : 0.22, ease: EASE }}
            className="relative overflow-hidden"
          >
            {/* T-1825: the node the lines leave from, just under the card. */}
            <span className={cn('at-dot', depth === 0 && 'at-dot-row')} aria-hidden="true" />
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

function AgentCard({ node, depth, open, onToggle }: { node: AgentNode; depth: number; open: boolean; onToggle?: () => void }) {
  const s = node.session;
  const facets = agentFacets(s);
  return (
    <motion.article
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: EASE }}
      data-agent-card={s.id}
      data-agent-status={node.status}
      className={cn(
        'relative w-full min-w-0 rounded-2xl border border-line bg-surface px-3.5 py-3 shadow-sm',
        // From 1024 px the lead's card is wider than its workers' (agentTree.css --at-card); the cards below a worker fit in its column.
        depth === 0 && 'expanded:w-[22rem]',
        depth === 1 && 'expanded:w-[18.5rem]',
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <ModelGlyph model={s.model} />
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
      <div className="mt-1.5 flex min-h-6 items-center gap-1.5 text-[13px] tabular-nums">
        {s.ticketId && <span className="font-mono text-[12px] text-muted">{s.ticketId}</span>}
        <Cost usd={node.costUsd} className="font-semibold text-ink" />
        <InfoTip label={`About ${node.name}`} className="relative z-10">
          {node.task && <span className="block text-ink">{node.task}</span>}
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{elapsedLabel(node.elapsedMs)}</span>
            {facets.map((f) => (
              <FacetIcon key={f} facet={f} branch={s.worktree?.branch} />
            ))}
          </span>
        </InfoTip>
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

/** "$1.52" with the cents muted (the owner's reference). */
function Cost({ usd, className }: { usd: number; className?: string }) {
  const { whole, fraction } = costParts(usd);
  return (
    <span className={className} data-cost="">
      {whole}
      <span className="font-normal text-muted">{fraction}</span>
    </span>
  );
}

/** The model's maker as its mark (src/assets/icons, NOTICE.md); a chip for a model the portal cannot place, a robot before the first report. */
const MAKER: Record<Exclude<ModelMaker, 'other'>, { src: string; name: string; invert?: boolean }> = {
  claude: { src: claudeIcon, name: 'Claude' },
  openai: { src: openaiIcon, name: 'OpenAI', invert: true },
  gemini: { src: geminiIcon, name: 'Gemini' },
  ollama: { src: ollamaIcon, name: 'Ollama', invert: true },
};

function ModelGlyph({ model }: { model: string | null }) {
  const maker = modelMaker(model);
  const mark = maker && maker !== 'other' ? MAKER[maker] : null;
  return (
    <span
      className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-muted"
      data-model-maker={maker ?? 'none'}
      aria-hidden="true"
    >
      {mark ? (
        <img src={mark.src} alt="" width={16} height={16} draggable={false} className={cn('size-4 object-contain', mark.invert && 'dark:invert')} />
      ) : maker === 'other' ? (
        <Cpu className="size-4" />
      ) : (
        <Bot className="size-4" />
      )}
    </span>
  );
}

const FACET: Record<AgentFacet, { label: string; icon: React.ReactNode }> = {
  branch: { label: 'Own worktree', icon: <GitBranch className="size-3.5" aria-hidden="true" /> },
  bypass: { label: 'Bypass on', icon: <ShieldAlert className="size-3.5 text-danger" aria-hidden="true" /> },
};

function FacetIcon({ facet, branch }: { facet: AgentFacet; branch?: string }) {
  const f = FACET[facet];
  const label = facet === 'branch' && branch ? `${f.label}: ${branch}` : f.label;
  return (
    <span className="inline-flex items-center gap-1" data-agent-facet={facet}>
      {f.icon}
      {label}
    </span>
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
