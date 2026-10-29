import { cn } from '@isnanme/ui';
import type { ChatSession } from '@portal/contracts';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { chatApi } from './api';
import { authorsOf, lastId, mergeMessages, tail, THREAD_PAGE, threadOf, type CrewMessage } from './crewThread';
import { RoleBadge } from './RoleBadge';

/** At most this many pages of 100 are read at once; the portal keeps the newest 500 messages of a channel anyway. */
const MAX_PAGES = 5;

export interface CrewChannelState {
  /** Oldest first. */
  messages: CrewMessage[];
  /** `unavailable`: the portal did not answer the read (no route yet, or no access): the thread stays hidden, never a guess. */
  status: 'loading' | 'ready' | 'unavailable';
}

/**
 * A lead's crew channel (T-294): read when the lead's page opens and again when its state changes (a turn that posted ends), going on from the
 * newest message known, so a re-read costs one small page. A person only reads: nothing here moves any member's place. Nothing is polled.
 * `enabled` is false for a session that started nothing: it has no channel of its own to show.
 */
export function useCrewChannel(leadId: string | undefined, enabled: boolean, state: ChatSession['state'] | undefined): CrewChannelState {
  const [view, setView] = useState<CrewChannelState & { id: string }>({ id: '', messages: [], status: 'loading' });

  useEffect(() => {
    if (!leadId || !enabled) return;
    let current = true;
    void (async () => {
      let messages = view.id === leadId ? view.messages : [];
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const read = await chatApi.crewChannel(leadId, lastId(messages));
          messages = mergeMessages(messages, read.items);
          if (!read.more || read.items.length === 0) break;
        }
        if (current) setView({ id: leadId, messages, status: 'ready' });
      } catch {
        // No route, or not allowed: what is known stays, and a channel never read stays hidden.
        if (current) setView((v) => (v.id === leadId ? { ...v, status: v.messages.length ? 'ready' : 'unavailable' } : { id: leadId, messages: [], status: 'unavailable' }));
      }
    })();
    return () => {
      current = false;
    };
    // `view` is read for the place to go on from, not a trigger: only another lead or a new state reads again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, enabled, state]);

  if (!leadId || !enabled || view.id !== leadId) return { messages: [], status: 'loading' };
  return view;
}

/**
 * The crew's channel as one thread (T-294): what the whole crew should be able to look up, oldest first, the newest in sight, "Earlier"
 * for the rest. One name per run of one author, with its role; a session the portal lists links to its page. The time is the local one.
 * Every line breaks anywhere, so a long path or URL never pushes the sheet sideways.
 */
export function CrewThread({ lead, workers, messages }: { lead: ChatSession; workers: readonly ChatSession[]; messages: readonly CrewMessage[] }) {
  const [shown, setShown] = useState(THREAD_PAGE);
  useEffect(() => setShown(THREAD_PAGE), [lead.id]);
  const authors = useMemo(() => authorsOf(lead, workers), [lead, workers]);
  const { items, older } = tail(messages, shown);
  const entries = useMemo(() => threadOf(items, authors, new Date()), [items, authors]);

  return (
    <div data-crew-thread="" className="flex flex-col gap-2">
      <p className="flex items-center gap-1 text-[13px] text-muted">
        <span>Shared by the crew</span>
        <InfoTip label="About the crew thread">
          What the lead and its workers posted with crew_post, for everyone in the crew to look up: a decision, an interface, a finding. The portal keeps
          the newest 500. Reading it here does not mark it read for any agent.
        </InfoTip>
      </p>
      {older > 0 && (
        <button
          type="button"
          data-crew-earlier=""
          onClick={() => setShown((n) => n + THREAD_PAGE)}
          className="press flex min-h-11 w-full items-center justify-center rounded-xl text-[13px] font-semibold text-muted hover:text-ink"
        >
          <span className="tabular-nums">Earlier · {older}</span>
        </button>
      )}
      <ol className="flex flex-col gap-1">
        {entries.map((e) =>
          e.kind === 'day' ? (
            <li key={`d${e.key}`} role="separator" className="flex items-center gap-3 py-1 text-[12px] text-muted">
              <span className="h-px min-w-4 flex-1 bg-line" aria-hidden="true" />
              <span>{e.label}</span>
              <span className="h-px min-w-4 flex-1 bg-line" aria-hidden="true" />
            </li>
          ) : (
            <li key={e.id} data-crew-message={e.id} className={cn('flex flex-col', e.first && 'mt-2')}>
              {e.first && (
                <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
                  {e.author.known ? (
                    <Link
                      to={`/admin/sessions/${e.author.id}`}
                      className="press flex min-h-11 min-w-0 items-center truncate font-semibold text-ink-soft hover:text-ink sm:min-h-6"
                    >
                      <span className="truncate">{e.author.name}</span>
                    </Link>
                  ) : (
                    <span className="min-w-0 truncate font-semibold text-ink-soft">{e.author.name}</span>
                  )}
                  {e.author.role && <RoleBadge session={{ agent: e.author.role }} iconOnPhone />}
                  <time dateTime={e.at} className="ml-auto shrink-0 tabular-nums">
                    {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </time>
                </div>
              )}
              <p className="rounded-2xl border border-line bg-surface px-3.5 py-2 text-[14.5px] leading-[1.45] break-words whitespace-pre-wrap [overflow-wrap:anywhere] text-ink">
                {e.text}
              </p>
            </li>
          ),
        )}
      </ol>
    </div>
  );
}
