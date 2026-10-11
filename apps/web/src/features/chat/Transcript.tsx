import { cn, Spinner } from '@isnanme/ui';
import type { ChatEvent, ChatImage, ChatInputState } from '@portal/contracts';
import { Clock3, ImageIcon, Wrench, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { chatApi } from './api';
import { imageAlt, imageFileName, ImageThumbs, type ViewerImage } from './ImageViewer';
import { CopyButton, Markdown } from './Markdown';
import { formatUsd } from './shared';
import type { ChatDelta, ChatOutgoing } from './useChatSocket';

/** Friendly words for a resolved request's outcome. */
const OUTCOME: Record<string, string> = {
  allowed_once: 'Allowed',
  allowed_session: 'Allowed for the session',
  denied: 'Denied',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
};

const NO_INPUTS: ReadonlyMap<string, ChatInputState> = new Map();

/** "mcp__playwright__browser_take_screenshot" reads "playwright · browser_take_screenshot". */
const toolLabel = (name: string) => (name.startsWith('mcp__') ? name.slice(5).split('__').filter(Boolean).join(' · ') : name);

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
 */
export function Transcript({
  sessionId,
  events,
  delta,
  outbox = [],
  inputs = NO_INPUTS,
  agentNames,
  onCancelQueued,
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
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  useEffect(() => {
    const el = ref.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [events, delta, outbox, inputs]);

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

  const ctx: RowContext = {
    sessionId,
    inputs,
    agentName: (label) => (label ? (agentNames?.get(label) ?? label) : null),
    resultTools,
    finals,
    onCancelQueued,
  };

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      aria-label="Transcript"
      className={cn('overflow-y-auto overscroll-contain px-4 py-5', className)}
    >
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3">
        {events.map((e) => (
          <EventRow key={e.seq} event={e} ctx={ctx} />
        ))}
        {outbox.map((o) => (
          <UserMessage
            key={o.uuid}
            text={o.text}
            images={o.images.map((img, i, all) => ({ ...img, alt: imageAlt('Image you sent', i, all.length) }))}
            state={inputs.get(o.uuid)}
            sending
            onCancel={onCancelQueued ? () => onCancelQueued(o.uuid, o.text) : undefined}
          />
        ))}
        {delta && <AssistantReply text={delta.text} agentLabel={ctx.agentName(delta.agentLabel)} live />}
      </div>
    </div>
  );
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
    case 'tool_use': {
      const agent = ctx.agentName(e.agentLabel);
      return (
        <ToolRow>
          <Wrench className="size-3.5 shrink-0" />
          <span className="shrink-0 font-mono">{e.toolName ? toolLabel(e.toolName) : 'tool'}</span>
          {e.text && (
            <span title={e.text} className="min-w-0 truncate font-mono text-muted">
              {e.text}
            </span>
          )}
          {agent && <span className="shrink-0 truncate text-muted/80">· {agent}</span>}
        </ToolRow>
      );
    }
    // Tool output stays folded to keep the log readable; images a tool returned are worth showing.
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
    case 'result':
      return (
        <div className="my-1 flex items-center gap-3 text-[11px] text-muted">
          <span className="h-px flex-1 bg-line" />
          {e.costUsd ? <span className="tabular-nums">{formatUsd(e.costUsd)}</span> : <span>Done</span>}
          <span className="h-px flex-1 bg-line" />
        </div>
      );
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
            'max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2.5 text-[14px] whitespace-pre-wrap break-words',
            withdrawn ? 'bg-surface-2 text-muted line-through' : 'bg-primary text-primary-ink',
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
      <Markdown text={text} className="w-full text-[14.5px] leading-[1.65] text-ink" />
      {live ? (
        <span className="mt-1 inline-block h-[1.05em] w-[2px] animate-pulse bg-ink/60" aria-hidden="true" />
      ) : (
        copy && text && <CopyButton text={text} label="Copy reply" className="-ml-1.5" />
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
