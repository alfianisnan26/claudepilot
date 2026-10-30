import { Badge, Button, useToast } from '@isnanme/ui';
import type { ChatEvent, DelegatedSession } from '@portal/contracts';
import { ChevronLeft, Send, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Markdown } from '@/features/chat/Markdown';
import { api, errorText } from '@/lib/api';

/**
 * A session shared with this account (owner, 2026-10-17), directly or through a team: read live, and what the share allows on top (send,
 * answer its approvals, stop the turn). Polls every 2.5 s (a revoke shows on the next poll). Nothing else of the workspace is reachable from here.
 */
export function DelegatedSessionView({ id, onBack }: { id: string; onBack: () => void }) {
  const toast = useToast();
  const [session, setSession] = useState<DelegatedSession | null>(null);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [gone, setGone] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const last = useRef(0);
  const end = useRef<HTMLDivElement>(null);

  const poll = useCallback(async () => {
    try {
      setSession(await api.delegatedOne(id));
      const fresh = last.current ? await api.delegatedEvents(id, last.current) : (await api.delegatedPage(id)).events;
      if (fresh.length) {
        last.current = fresh[fresh.length - 1]!.seq;
        setEvents((prev) => [...prev, ...fresh].slice(-400));
      }
    } catch {
      setGone(true);
    }
  }, [id]);
  useEffect(() => {
    void poll();
    const t = setInterval(() => void poll(), 2500);
    return () => clearInterval(t);
  }, [poll]);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [events.length]);

  const resolved = useMemo(() => new Set(events.filter((e) => e.kind === 'resolved' && e.requestId).map((e) => e.requestId!)), [events]);
  const open = events.filter((e) => e.kind === 'request' && e.request && !resolved.has(e.request.requestId));
  const can = (c: 'send' | 'respond' | 'stop') => !!session?.caps?.includes(c);
  const operate = session?.level === 'operate';

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await poll();
    } catch (e) {
      toast(errorText(e, 'Couldn’t do that.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const t = text;
    setText('');
    void act(() => api.delegatedSend(id, t));
  };

  if (gone)
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">This agent is no longer shared with you.</p>
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
    );
  return (
    <div className="flex min-h-[70dvh] flex-col gap-3" data-delegated-session="">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} aria-label="Back" className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-surface-2">
          <ChevronLeft className="size-5" />
        </button>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{session?.title ?? '…'}</span>
          <span className="block truncate text-[12.5px] text-muted">{session ? `${session.workspaceId} · ${session.state}` : ''}</span>
        </span>
        <Badge tone={operate ? 'warning' : 'neutral'}>{operate ? 'Operate' : 'View'}</Badge>
        {can('stop') && session?.state === 'working' && (
          <button type="button" onClick={() => void act(() => api.delegatedStop(id))} disabled={busy} aria-label="Stop the turn" className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full text-danger hover:bg-danger-soft">
            <Square className="size-4" />
          </button>
        )}
      </div>
      <ol className="flex flex-1 flex-col gap-2 overflow-y-auto">
        {events
          .filter((e) => (e.kind === 'user' || e.kind === 'assistant' || e.kind === 'tool_use' || e.kind === 'error') && !e.parentToolUseId)
          .map((e) => (
            <li key={e.seq} className={e.kind === 'user' ? 'self-end max-w-[85%] rounded-2xl bg-accent-soft px-3.5 py-2' : e.kind === 'tool_use' ? 'text-[12.5px] text-muted' : 'max-w-full'}>
              {e.kind === 'tool_use' ? (
                <span className="[overflow-wrap:anywhere]">• {e.toolName}{e.text ? `: ${e.text.slice(0, 160)}` : ''}</span>
              ) : (
                <Markdown text={e.text ?? ''} className="text-[14.5px] leading-relaxed [overflow-wrap:anywhere]" />
              )}
            </li>
          ))}
        <div ref={end} />
      </ol>
      {open.length > 0 && (
        <ul className="flex flex-col gap-2">
          {open.map((e) => (
            <li key={e.request!.requestId} className="rounded-2xl border border-line p-3">
              <p className="font-semibold [overflow-wrap:anywhere]">{e.request!.title}</p>
              {e.request!.detail && <p className="mt-0.5 text-[13px] text-muted [overflow-wrap:anywhere]">{e.request!.detail}</p>}
              {can('respond') ? (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Button variant="ghost" disabled={busy} onClick={() => void act(() => api.delegatedRespond(id, e.request!.requestId, 'deny'))}>
                    Deny
                  </Button>
                  <Button disabled={busy} onClick={() => void act(() => api.delegatedRespond(id, e.request!.requestId, 'allow'))}>
                    Allow
                  </Button>
                </div>
              ) : (
                <p className="mt-1 text-[12.5px] text-muted">Waiting for the owner.</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {can('send') && (
        <form onSubmit={send} className="flex items-end gap-2">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Message" className="min-h-11 flex-1 resize-none rounded-2xl border border-line bg-surface px-3.5 py-2.5 text-[15px] outline-hidden focus-visible:ring-2 focus-visible:ring-accent" />
          <button type="submit" disabled={busy || !text.trim()} aria-label="Send" className="press inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-accent text-white disabled:opacity-50">
            <Send className="size-[18px]" />
          </button>
        </form>
      )}
    </div>
  );
}
