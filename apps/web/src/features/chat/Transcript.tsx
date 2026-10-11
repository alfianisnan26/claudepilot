import { cn, Spinner } from '@isnanme/ui';
import type { ChatEvent, ChatImage, ChatInputState } from '@portal/contracts';
import { ArrowDown, Clock3, ImageIcon, X } from 'lucide-react';
import { motion, MotionConfig } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityBlock } from './Activity';
import { chatApi } from './api';
import { imageAlt, imageFileName, ImageThumbs, type ViewerImage } from './ImageViewer';
import { Markdown, QuietCopyButton } from './Markdown';
import { buildRows, LiveThinking, ThinkingRow, ToolCall, ToolGroup, toolLabel, type ToolPair, type TranscriptRow } from './ToolRows';
import { TurnDone, turnUsage, type TurnUsage } from './Usage';
import type { ChatDelta, ChatOutgoing } from './useChatSocket';

/** What the transcript shows, in order: a row as it is, a turn's work folded into one activity row, or a turn just done. */
type Item =
  | { kind: 'row'; key: string; row: TranscriptRow; fresh: boolean }
  | { kind: 'activity'; key: string; rows: TranscriptRow[]; result: ChatEvent | null; fresh: boolean }
  | { kind: 'done'; key: string; result: ChatEvent };

const rowSeq = (r: TranscriptRow): number =>
  r.type === 'tool' ? r.call.seq : r.type === 'group' ? r.tools[0]!.call.seq : r.event.seq;

/** New lines rise in; what was already there when the page opened doesn't move. */
const RISE = { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { type: 'spring', stiffness: 380, damping: 32 } } as const;
/** How long after the first events arrive they still count as history (it can come in more than one batch). */
const HISTORY_SETTLE_MS = 800;

/** Friendly words for a resolved request's outcome. */
const OUTCOME: Record<string, string> = {
  allowed_once: 'Allowed',
  allowed_session: 'Allowed for the session',
  denied: 'Denied',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
};

const NO_INPUTS: ReadonlyMap<string, ChatInputState> = new Map();

interface RowContext {
  sessionId: string;
  inputs: ReadonlyMap<string, ChatInputState>;
  /** A sub-agent's label as people read it: its task's description when known. */
  agentName: (label: string | null | undefined) => string | null;
  /** The tool behind a tool result with images, by the result's `seq`. */
  resultTools: ReadonlyMap<number, string>;
  /** Replies that end their turn (or the latest one): they get Copy; narration between tool calls doesn't. */
  finals: ReadonlySet<number>;
  onCancelQueued?: (uuid: string, text: string) => Promise<void>;
}

/**
 * The transcript as a scrolling log. It owns its own scroll area so it can keep itself pinned to
 * the bottom while new lines, live tokens and images arrive — but only when the reader is already
 * there, so scrolling up to re-read is never yanked back down. Messages sent from this tab that
 * aren't stored yet (`outbox`) show at the end, faded, until the stored copy replaces them.
 *
 * Tool calls show with their results, thinking as "Thought for 12 s", and runs of read-only calls as
 * one row, all folded; `details` (Show all details) opens every row and ungroups the runs.
 */
export function Transcript({
  sessionId,
  events,
  delta,
  outbox = [],
  inputs = NO_INPUTS,
  agentNames,
  onCancelQueued,
  details = false,
  working = false,
  padTop,
  padBottom,
  onOpenUsage,
  className,
}: {
  sessionId: string;
  events: ChatEvent[];
  delta: ChatDelta | null;
  outbox?: ChatOutgoing[];
  inputs?: ReadonlyMap<string, ChatInputState>;
  /** Sub-agent labels (`Task` tool_use ids) → their task's description. */
  agentNames?: ReadonlyMap<string, string>;
  onCancelQueued?: (uuid: string, text: string) => Promise<void>;
  /** Show all details: every row open, read-only runs ungrouped. */
  details?: boolean;
  /** A turn is running: calls still waiting for their result show a spinner. */
  working?: boolean;
  /** Room above and below the lines, for the glass header and dock the transcript scrolls under. */
  padTop?: string;
  padBottom?: number;
  /** A finished turn's Done pill opens Usage. */
  onOpenUsage?: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);

  // Everything up to the first batch (and what follows it right away) is history: only later lines animate.
  const history = useRef<{ seq: number; at: number } | null>(null);
  const last = events.length ? events[events.length - 1]!.seq : 0;
  if (events.length && (!history.current || Date.now() - history.current.at < HISTORY_SETTLE_MS)) {
    history.current = { seq: last, at: history.current?.at ?? Date.now() };
  }
  const base = history.current?.seq ?? 0;

  // Only the reader leaves the bottom: a scroll right after a touch, wheel or key. The view moving by
  // itself (content growing, a row folding) never stops it following the latest.
  const touched = useRef(0);
  const byReader = () => performance.now() - touched.current < 1200;
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gap < 120) nearBottom.current = true;
    else if (byReader()) nearBottom.current = false;
    setAwayFromBottom(gap > 320 && !nearBottom.current);
  };
  const reading = () => void (touched.current = performance.now());
  const toBottom = () => {
    const el = ref.current;
    if (!el) return;
    nearBottom.current = true;
    setAwayFromBottom(false);
    el.scrollTo({ top: el.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };

  useEffect(() => {
    const el = ref.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [events, delta, outbox, inputs, padBottom]);

  // The keyboard opening (or the dock growing) shrinks the view, and rows grow as they animate open
  // (a Done pill, an activity row): stay at the bottom through both if that's where it was.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, []);

  // Images take their height when they load, after the pin above ran: pin again then.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onLoad = (e: Event) => {
      if (e.target instanceof HTMLImageElement && nearBottom.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener('load', onLoad, true);
    return () => el.removeEventListener('load', onLoad, true);
  }, []);

  // Tool results don't name their tool; the closest earlier call from the same agent almost always is it.
  const resultTools = useMemo(() => {
    const out = new Map<number, string>();
    const lastCall = new Map<string, string>();
    for (const e of events) {
      const agent = e.agentLabel ?? '';
      if (e.kind === 'tool_use' && e.toolName) lastCall.set(agent, e.toolName);
      else if (e.kind === 'tool_result' && e.images?.length) {
        const tool = e.toolName ?? lastCall.get(agent);
        if (tool) out.set(e.seq, tool);
      }
    }
    return out;
  }, [events]);

  // The main agent's last reply before each result, and its latest reply in a turn still open.
  const finals = useMemo(() => {
    const out = new Set<number>();
    let pending: number | null = null;
    for (const e of events) {
      if (e.agentLabel) continue;
      if (e.kind === 'assistant') pending = e.seq;
      else if (e.kind === 'tool_use' || e.kind === 'user') pending = null;
      else if (e.kind === 'result' && pending !== null) {
        out.add(pending);
        pending = null;
      }
    }
    if (pending !== null) out.add(pending);
    return out;
  }, [events]);

  const rows = useMemo(() => buildRows(events, !details), [events, details]);
  const usage = useMemo(() => new Map<number, TurnUsage>(turnUsage(events).map((u) => [u.seq, u])), [events]);

  // A turn's work (thinking, tool calls, notes between them, sub-agents' lines) folds into activity rows;
  // the reply that ends the turn, what you sent, errors and tool images stay out. A turn's result goes to
  // its activity rows (their usage), and a result that just came in shows the Done pill.
  const items = useMemo(() => {
    const isActivity = (r: TranscriptRow): boolean => {
      if (r.type === 'thinking' || r.type === 'group') return true;
      if (r.type === 'tool') return !r.result?.images?.length;
      const e = r.event;
      if (e.kind === 'assistant') return !!e.agentLabel || !finals.has(e.seq);
      return e.kind === 'system' || e.kind === 'retry' || e.kind === 'resolved';
    };
    // "Ready" (the process started) says nothing a reader needs, except in Show all details.
    const quiet = (r: TranscriptRow) => !details && r.type === 'event' && r.event.kind === 'system' && r.event.text === 'Ready';
    const substantive = (r: TranscriptRow) => r.type !== 'event' || r.event.kind === 'assistant';
    const out: Item[] = [];
    let run: TranscriptRow[] = [];
    let turn: Extract<Item, { kind: 'activity' }>[] = [];
    const flush = () => {
      if (!run.length) return;
      if (run.some(substantive)) {
        const block: Extract<Item, { kind: 'activity' }> = { kind: 'activity', key: `a${rowSeq(run[0]!)}`, rows: run, result: null, fresh: rowSeq(run[0]!) > base };
        out.push(block);
        turn.push(block);
      } else for (const r of run) out.push({ kind: 'row', key: `r${rowSeq(r)}`, row: r, fresh: rowSeq(r) > base });
      run = [];
    };
    for (const r of rows) {
      if (quiet(r)) continue;
      if (isActivity(r)) {
        run.push(r);
        continue;
      }
      flush();
      if (r.type === 'event' && r.event.kind === 'result') {
        for (const b of turn) b.result = r.event;
        if (r.event.seq > base) out.push({ kind: 'done', key: `d${r.event.seq}`, result: r.event });
        turn = [];
        continue;
      }
      if (r.type === 'event' && r.event.kind === 'user') turn = [];
      out.push({ kind: 'row', key: `r${rowSeq(r)}`, row: r, fresh: rowSeq(r) > base });
    }
    flush();
    return out;
  }, [rows, finals, base, details]);
  const lastActivity = items.findLast((i) => i.kind === 'activity')?.key;

  const ctx: RowContext = {
    sessionId,
    inputs,
    agentName: (label) => (label ? (agentNames?.get(label) ?? label) : null),
    resultTools,
    finals,
    onCancelQueued,
  };

  const toolCall = (t: ToolPair) => {
    const tool = t.call.toolName ? toolLabel(t.call.toolName) : 'a tool';
    return (
      <ToolCall
        key={`t${t.call.seq}`}
        call={t.call}
        result={t.result}
        agent={ctx.agentName(t.call.agentLabel)}
        running={working}
        details={details}
        images={storedImages(sessionId, t.result?.images, `Image from ${tool}`)}
      />
    );
  };

  /** One row, as it shows on its own or inside an activity row. */
  const renderRow = (r: TranscriptRow, inActivity = false): ReactNode => {
    switch (r.type) {
      case 'event':
        if (inActivity) return <ActivityNote key={`e${r.event.seq}`} event={r.event} agent={ctx.agentName(r.event.agentLabel)} />;
        return <EventRow key={`e${r.event.seq}`} event={r.event} ctx={ctx} />;
      case 'tool':
        return toolCall(r);
      case 'group':
        return (
          <ToolGroup
            key={`g${r.tools[0]!.call.seq}`}
            tools={r.tools}
            agent={ctx.agentName(r.tools[0]!.call.agentLabel)}
            running={working}
            details={details}
            render={toolCall}
          />
        );
      case 'thinking':
        return <ThinkingRow key={`h${r.event.seq}`} event={r.event} agent={ctx.agentName(r.event.agentLabel)} details={details} />;
    }
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className={cn('relative', className)}>
        <div
          ref={ref}
          onScroll={onScroll}
          onWheel={reading}
          onTouchMove={reading}
          onKeyDown={reading}
          onPointerDown={reading}
          role="log"
          aria-live="polite"
          aria-label="Transcript"
          style={{ paddingTop: padTop, paddingBottom: padBottom }}
          className="h-full overflow-y-auto overscroll-contain px-5 py-5 [overflow-anchor:none] sm:px-6"
        >
          <div ref={content} className="mx-auto flex w-full max-w-[720px] flex-col gap-5">
            {items.map((it) => {
              if (it.kind === 'done') {
                const u = usage.get(it.result.seq);
                return u ? <TurnDone key={it.key} usage={u} onOpen={onOpenUsage} /> : null;
              }
              // Stored copies of what you sent don't rise: their outbox bubble already did.
              const rise = it.fresh && !(it.kind === 'row' && it.row.type === 'event' && it.row.event.kind === 'user');
              return (
                <motion.div key={it.key} {...RISE} initial={rise ? RISE.initial : false}>
                  {it.kind === 'activity' ? (
                    <ActivityBlock
                      rows={it.rows}
                      usage={it.result ? (usage.get(it.result.seq) ?? null) : null}
                      live={working && !it.result && it.key === lastActivity}
                      details={details}
                      render={(r) => renderRow(r, true)}
                    />
                  ) : (
                    renderRow(it.row)
                  )}
                </motion.div>
              );
            })}
            {outbox.map((o) => (
              <motion.div
                key={o.uuid}
                initial={{ opacity: 0, y: 16, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ type: 'spring', stiffness: 520, damping: 30 }}
                style={{ transformOrigin: 'bottom right' }}
              >
                <UserMessage
                  text={o.text}
                  images={o.images.map((img, i, all) => ({ ...img, alt: imageAlt('Image you sent', i, all.length) }))}
                  state={inputs.get(o.uuid)}
                  sending
                  onCancel={onCancelQueued ? () => onCancelQueued(o.uuid, o.text) : undefined}
                />
              </motion.div>
            ))}
            {delta && (
              <motion.div key={delta.thinking ? 'thinking' : 'reply'} {...RISE}>
                {delta.thinking ? (
                  <LiveThinking since={delta.thinking.since} agent={ctx.agentName(delta.agentLabel)} />
                ) : (
                  <AssistantReply text={delta.text} agentLabel={ctx.agentName(delta.agentLabel)} live />
                )}
              </motion.div>
            )}
          </div>
        </div>
        {/* Back to the latest, floating over the transcript above the composer. */}
        <motion.button
          type="button"
          aria-label="Jump to latest"
          onClick={toBottom}
          initial={false}
          animate={awayFromBottom ? { opacity: 1, scale: 1, y: 0 } : { opacity: 0, scale: 0.8, y: 8 }}
          transition={{ type: 'spring', stiffness: 500, damping: 34 }}
          style={{ bottom: (padBottom ?? 0) + 4, pointerEvents: awayFromBottom ? 'auto' : 'none' }}
          tabIndex={awayFromBottom ? 0 : -1}
          className="glass-card press absolute left-1/2 z-10 -ml-[22px] flex size-11 items-center justify-center rounded-full text-ink"
        >
          <ArrowDown className="size-5" />
        </motion.button>
      </div>
    </MotionConfig>
  );
}

/** A line inside a turn's activity: a note Claude wrote between steps, a sub-agent's reply, or a system line. */
function ActivityNote({ event: e, agent }: { event: ChatEvent; agent: string | null }) {
  if (e.kind === 'assistant')
    return (
      <div className="min-w-0 px-1">
        {agent && <span className="block truncate text-[10.5px] font-semibold tracking-wide text-muted uppercase">{agent}</span>}
        <Markdown text={e.text ?? ''} className="text-[14.5px] leading-relaxed text-ink-soft" />
      </div>
    );
  const text = e.kind === 'resolved' ? (e.outcome ? (OUTCOME[e.outcome] ?? e.outcome) : 'Resolved') : (e.text ?? (e.kind === 'retry' ? 'Retrying… (rate limit)' : ''));
  return text ? <p className="px-1 text-[13.5px] text-muted">{text}</p> : null;
}

/** A stored event's images, served from the session's blob store. */
const storedImages = (sessionId: string, images: ChatImage[] | undefined, alt: string): ViewerImage[] =>
  (images ?? []).map((img, i, all) => ({
    src: chatApi.blobUrl(sessionId, img.blobId),
    alt: imageAlt(alt, i, all.length),
    name: imageFileName(img),
  }));

function EventRow({ event: e, ctx }: { event: ChatEvent; ctx: RowContext }) {
  switch (e.kind) {
    case 'user': {
      const { uuid } = e;
      const text = e.text ?? '';
      const cancel = ctx.onCancelQueued;
      return (
        <UserMessage
          text={text}
          images={storedImages(ctx.sessionId, e.images, 'Image you sent')}
          state={uuid ? ctx.inputs.get(uuid) : undefined}
          onCancel={uuid && cancel ? () => cancel(uuid, text) : undefined}
        />
      );
    }
    case 'assistant':
      return <AssistantReply text={e.text ?? ''} agentLabel={ctx.agentName(e.agentLabel)} copy={ctx.finals.has(e.seq)} />;
    // A result with no call to join (calls show their own results): only shown for its images.
    case 'tool_result': {
      if (!e.images?.length) return null;
      const name = ctx.resultTools.get(e.seq);
      const tool = name ? toolLabel(name) : null;
      const agent = ctx.agentName(e.agentLabel);
      return (
        <div className="flex flex-col items-start gap-1.5">
          <ToolRow>
            <ImageIcon className="size-3.5 shrink-0" />
            <span className="truncate">
              {tool ? <span className="font-mono">{tool}</span> : 'A tool'} returned {e.images.length === 1 ? 'an image' : `${e.images.length} images`}
            </span>
            {agent && <span className="truncate text-muted/80">· {agent}</span>}
          </ToolRow>
          <ImageThumbs images={storedImages(ctx.sessionId, e.images, `Image from ${tool ?? 'a tool'}`)} />
        </div>
      );
    }
    case 'system':
      return <CenterLine>{e.text}</CenterLine>;
    case 'retry':
      return <CenterLine>{e.text ?? 'Retrying… (rate limit)'}</CenterLine>;
    case 'resolved':
      return <CenterLine>{e.outcome ? (OUTCOME[e.outcome] ?? e.outcome) : 'Resolved'}</CenterLine>;
    // A turn's end: its numbers are in its activity row, in Usage, and in the Done pill when it just finished.
    case 'result':
      return null;
    case 'error':
      return (
        <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">
          {e.text ?? 'Something went wrong.'}
        </p>
      );
    // `request` drives the approvals dock.
    case 'request':
      return null;
    default:
      return null;
  }
}

/**
 * Something you sent: its images, the bubble, and where it is in Claude Code's queue — Queued (with ✕
 * to withdraw it), Withdrawn, or Not sent. `sending` marks this tab's copy before the portal stored it.
 */
function UserMessage({
  text,
  images,
  state,
  sending,
  onCancel,
}: {
  text: string;
  images: ViewerImage[];
  state?: ChatInputState;
  sending?: boolean;
  onCancel?: () => Promise<void>;
}) {
  const withdrawn = state === 'cancelled';
  const notSent = state === 'failed' || state === 'discarded';
  return (
    <div className={cn('flex flex-col items-end gap-1.5', sending && state !== 'queued' && 'opacity-60')}>
      <ImageThumbs images={images} align="end" className={cn(withdrawn && 'opacity-50')} />
      {text && (
        <div
          className={cn(
            'max-w-[85%] rounded-[22px] px-4 py-2.5 text-[16.5px] leading-[1.45] whitespace-pre-wrap break-words sm:text-[15.5px]',
            withdrawn ? 'bg-surface-2 text-muted line-through' : 'bg-ink/[0.08] text-ink',
          )}
        >
          {text}
        </div>
      )}
      {state === 'queued' ? (
        <QueuedChip onCancel={onCancel} />
      ) : withdrawn ? (
        <Note>Withdrawn</Note>
      ) : notSent ? (
        <Note danger>Not sent</Note>
      ) : sending ? (
        <Note>Sending…</Note>
      ) : null}
    </div>
  );
}

function QueuedChip({ onCancel }: { onCancel?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <span
      title="Claude reads this after the current step"
      className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pr-0.5 pl-2 text-[11.5px] font-semibold text-ink-soft"
    >
      <Clock3 className="size-3" aria-hidden="true" />
      Queued
      {onCancel ? (
        <button
          type="button"
          disabled={busy}
          aria-label="Withdraw this message"
          title="Withdraw"
          onClick={() => {
            setBusy(true);
            void onCancel().finally(() => setBusy(false));
          }}
          className="press flex size-6 items-center justify-center rounded-full text-muted hover:bg-line hover:text-ink tap:size-8"
        >
          {busy ? <Spinner className="size-3" /> : <X className="size-3.5" />}
        </button>
      ) : (
        <span className="pr-1.5" />
      )}
    </span>
  );
}

function Note({ children, danger }: { children: ReactNode; danger?: boolean }) {
  return <span className={cn('px-1 text-[11.5px] font-semibold', danger ? 'text-danger' : 'text-muted')}>{children}</span>;
}

/**
 * A reply: full-width markdown (chat PRD FR5), with Copy under it when it ends its turn (`copy`). A
 * sub-agent's reply carries its name. `live` is the reply still being written.
 */
function AssistantReply({ text, agentLabel, live, copy }: { text: string; agentLabel: string | null; live?: boolean; copy?: boolean }) {
  return (
    <div className={cn('flex flex-col items-start gap-0.5', agentLabel && 'border-l-2 border-line pl-3')}>
      {agentLabel && (
        <span title={agentLabel} className="max-w-full truncate text-[10.5px] font-semibold tracking-wide text-muted uppercase">
          {agentLabel}
        </span>
      )}
      <Markdown text={text} className="w-full text-[16.5px] leading-[1.6] text-ink sm:text-[15.5px]" />
      {live ? (
        <span className="mt-1 inline-block h-[1.05em] w-[2px] animate-pulse bg-ink/60" aria-hidden="true" />
      ) : (
        copy && text && <QuietCopyButton text={text} label="Copy reply" className="-ml-1.5" />
      )}
    </div>
  );
}

function ToolRow({ children }: { children: ReactNode }) {
  return <div className="flex max-w-full items-center gap-1.5 px-1 text-[12px] text-ink-soft">{children}</div>;
}

function CenterLine({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="px-6 text-center text-[12px] text-muted">{children}</p>;
}
