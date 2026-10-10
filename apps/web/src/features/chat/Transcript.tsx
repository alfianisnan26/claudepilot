import { cn } from '@isnanme/ui';
import type { ChatEvent } from '@portal/contracts';
import { Wrench } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { formatUsd } from './shared';
import type { ChatDelta } from './useChatSocket';

/** Friendly words for a resolved request's outcome. */
const OUTCOME: Record<string, string> = {
  allowed_once: 'Allowed',
  allowed_session: 'Allowed for the session',
  denied: 'Denied',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
};

/**
 * The transcript as a scrolling log. It owns its own scroll area so it can keep itself pinned to
 * the bottom while new lines and live tokens arrive — but only when the reader is already there, so
 * scrolling up to re-read is never yanked back down.
 */
export function Transcript({ events, delta, className }: { events: ChatEvent[]; delta: ChatDelta | null; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  useEffect(() => {
    const el = ref.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [events, delta]);

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
          <EventRow key={e.seq} event={e} />
        ))}
        {delta && <AssistantBubble text={delta.text} agentLabel={delta.agentLabel} live />}
      </div>
    </div>
  );
}

function EventRow({ event: e }: { event: ChatEvent }) {
  switch (e.kind) {
    case 'user':
      return <UserBubble text={e.text ?? ''} />;
    case 'assistant':
      return <AssistantBubble text={e.text ?? ''} agentLabel={e.agentLabel ?? null} />;
    case 'tool_use':
      return (
        <ToolRow>
          <Wrench className="size-3.5 shrink-0" />
          <span className="truncate font-mono">{e.toolName ?? 'tool'}</span>
          {e.agentLabel && <span className="truncate text-muted/80">· {e.agentLabel}</span>}
        </ToolRow>
      );
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
    // `request` drives the approvals dock; `tool_result` is folded away to keep the log readable.
    case 'request':
    case 'tool_result':
      return null;
    default:
      return null;
  }
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-[14px] whitespace-pre-wrap break-words text-primary-ink">
        {text}
      </div>
    </div>
  );
}

function AssistantBubble({ text, agentLabel, live }: { text: string; agentLabel: string | null; live?: boolean }) {
  return (
    <div className="flex flex-col items-start gap-1">
      {agentLabel && (
        <span className="px-1 text-[10.5px] font-semibold tracking-wide text-muted uppercase">{agentLabel}</span>
      )}
      <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-surface-2 px-3.5 py-2.5 text-[14px] whitespace-pre-wrap break-words text-ink">
        {text}
        {live && <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse bg-ink/60 align-middle" aria-hidden="true" />}
      </div>
    </div>
  );
}

function ToolRow({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-1.5 px-1 text-[12px] text-ink-soft">{children}</div>;
}

function CenterLine({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="px-6 text-center text-[12px] text-muted">{children}</p>;
}
