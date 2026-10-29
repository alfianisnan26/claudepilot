import { Button, cn } from '@isnanme/ui';
import type { ChatSession } from '@portal/contracts';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { chatApi } from './api';
import {
  atBottom,
  authorsOf,
  CHANNEL_START,
  readChannel,
  scrollTarget,
  tabWrap,
  tail,
  THREAD_PAGE,
  threadOf,
  type ChannelLoad,
  type ScrollPlan,
} from './crewThread';
import { pickAnchor, type MeasuredRow } from './scrollAnchor';
import { RoleBadge } from './RoleBadge';

export interface CrewChannelState extends ChannelLoad {
  /** Reads the channel again (the Retry of a failed read). */
  retry: () => void;
}

/**
 * A lead's crew channel (T-294): read when the lead's page opens and again when its state changes (a turn that posted ends), going on from the
 * newest message known, so a re-read costs one small page. A person only reads: nothing here moves any member's place. Nothing is polled.
 * A failed read is a state of its own (`failed`, with its reason), never an empty channel. `enabled` is false for a session that started
 * nothing: it has no channel of its own to show.
 */
export function useCrewChannel(leadId: string | undefined, enabled: boolean, state: ChatSession['state'] | undefined): CrewChannelState {
  const [view, setView] = useState<ChannelLoad & { id: string }>({ id: '', ...CHANNEL_START });
  const [round, setRound] = useState(0);
  const retry = useCallback(() => setRound((n) => n + 1), []);

  useEffect(() => {
    if (!leadId || !enabled) return;
    let current = true;
    const known = view.id === leadId ? view.messages : [];
    // A retry shows it is reading again; what was read stays in sight.
    setView((v) => (v.id === leadId && v.status === 'failed' ? { ...v, status: 'loading' } : v));
    void readChannel((after) => chatApi.crewChannel(leadId, after), known).then((next) => {
      if (current) setView({ id: leadId, ...next });
    });
    return () => {
      current = false;
    };
    // `view` is read for the place to go on from, not a trigger: only another lead, a new state or a Retry reads again.
  }, [leadId, enabled, state, round]);

  if (!leadId || !enabled || view.id !== leadId) return { ...CHANNEL_START, retry };
  return { status: view.status, messages: view.messages, reason: view.reason, retry };
}

/** The tab stops inside the thread: its links, buttons and its scroll area. */
const STOPS = 'a[href], button:not([disabled]), [tabindex="0"]';

/**
 * The crew's channel as one thread (T-294): what the whole crew should be able to look up, oldest first. It opens at the newest message, "Earlier"
 * adds older ones above without moving the message being read, and a reader at the end follows new ones. One name per run of one author, with
 * its role; a session the portal lists links to its page. The time is the local one. Every line breaks anywhere, so a long path or URL never
 * pushes the sheet sideways. A failed read says so with its reason and a Retry; an empty channel says it is empty. Tab stays inside it
 * (`trap`, for the desktop popover; a phone's dialog traps on its own).
 */
export function CrewThread({
  lead,
  workers,
  channel,
  trap = false,
}: {
  lead: ChatSession;
  workers: readonly ChatSession[];
  channel: CrewChannelState;
  trap?: boolean;
}) {
  const { status, messages, reason, retry } = channel;
  const [shown, setShown] = useState(THREAD_PAGE);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // What to do with the scroll once the next render is in: the first open goes to the newest; "Earlier" holds an anchor.
  const plan = useRef<ScrollPlan>('bottom');
  const pinned = useRef(true);
  useEffect(() => {
    setShown(THREAD_PAGE);
    plan.current = 'bottom';
  }, [lead.id]);

  const authors = useMemo(() => authorsOf(lead, workers), [lead, workers]);
  const { items, older } = tail(messages, shown);
  const entries = useMemo(() => threadOf(items, authors, new Date()), [items, authors]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const mine = plan.current ?? (pinned.current ? 'bottom' : null);
    plan.current = null;
    const anchored = typeof mine === 'object' && mine !== null ? mine : null;
    const row = anchored?.key ? el.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(anchored.key)}"]`) : null;
    const rowTop = row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop : null;
    const to = scrollTarget(mine, { rowTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
    if (to !== null) el.scrollTop = to;
  }, [entries, status]);

  // The first stop on a desktop popover is the thread itself (it scrolls from the keyboard), so Escape and Tab have somewhere to start from.
  useEffect(() => {
    if (trap) (scroller.current ?? root.current)?.focus({ preventScroll: true });
  }, [trap]);

  const earlier = () => {
    const el = scroller.current;
    if (el) {
      const top = el.getBoundingClientRect().top;
      const rows: MeasuredRow[] = [...el.querySelectorAll<HTMLElement>('[data-anchor]')].map((r) => {
        const b = r.getBoundingClientRect();
        return { key: r.dataset.anchor ?? '', top: b.top - top + el.scrollTop, bottom: b.bottom - top + el.scrollTop };
      });
      plan.current = pickAnchor(rows, el.scrollTop, el.scrollHeight);
    }
    setShown((n) => n + THREAD_PAGE);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!trap || e.key !== 'Tab' || !root.current) return;
    const stops = [...root.current.querySelectorAll<HTMLElement>(STOPS)];
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const go = tabWrap(at, stops.length, e.shiftKey);
    if (go === null) return;
    e.preventDefault();
    stops[go]?.focus();
  };

  return (
    <div ref={root} data-crew-thread="" tabIndex={-1} onKeyDown={onKeyDown} className="flex flex-col gap-2 outline-none">
      <p className="flex items-center gap-1 text-[13px] text-muted">
        <span>Shared by the crew</span>
        <InfoTip label="About the crew thread">
          What the lead and its workers posted with crew_post, for everyone in the crew to look up: a decision, an interface, a finding. The
          portal keeps the newest 500. Reading it here does not mark it read for any agent.
        </InfoTip>
      </p>
      {status === 'failed' && (
        <div role="alert" data-crew-failed="" className="flex min-w-0 items-center gap-2 text-[13px] text-danger">
          <span className="min-w-0 flex-1">Couldn’t load crew.</span>
          <InfoTip label="Why the crew didn’t load">{reason ?? 'The portal did not answer.'}</InfoTip>
          <Button size="sm" variant="secondary" className="min-h-11 shrink-0 px-3" onClick={retry}>
            Retry
          </Button>
        </div>
      )}
      {status === 'loading' && messages.length === 0 && (
        <p role="status" className="py-2 text-[13px] text-muted">
          Loading…
        </p>
      )}
      {status === 'ready' && messages.length === 0 && (
        <p data-crew-empty="" className="py-2 text-[13px] text-muted">
          Nothing posted yet.
        </p>
      )}
      {messages.length > 0 && (
        <div
          ref={scroller}
          tabIndex={0}
          role="region"
          aria-label="Crew messages"
          data-crew-scroll=""
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = atBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
          }}
          className="max-h-[min(60dvh,30rem)] overflow-y-auto overscroll-contain [overflow-anchor:none] focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {older > 0 && (
            <button
              type="button"
              data-crew-earlier=""
              onClick={earlier}
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
                <li key={e.id} data-crew-message={e.id} data-anchor={`m${e.id}`} className={cn('flex flex-col', e.first && 'mt-2')}>
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
      )}
    </div>
  );
}
