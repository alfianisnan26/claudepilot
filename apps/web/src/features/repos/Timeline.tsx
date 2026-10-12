import { Button, cn, Segmented } from '@isnanme/ui';
import type { RepoEvent } from '@portal/contracts';
import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { formatDateTime, timeAgo } from '@/lib/format';
import { reposApi } from './api';
import { actorLabel, detailsOf, EVENT_FILTERS, eventTone, filterQuery, plainSummary, ticketOf, type EventFilter } from './labels';
import { BREAK } from './clamp';
import { LinesSkeleton } from './Skeleton';
import { TONE_DOT } from './tone';

const PAGE = 20;

/**
 * A repo's log, newest first: what scans noticed (commits, branch moves, changes, drift) and what the portal did when asked,
 * with who. All, only the commits and branch moves, or only the audit. A line with more to say opens (the commits' subjects, the
 * move, the reason). `version` changes whenever the repo was read again, which loads the first page afresh.
 */
export function Timeline({ repoId, version }: { repoId: string; version: string }) {
  const [filter, setFilter] = useState<EventFilter>('all');
  const [events, setEvents] = useState<RepoEvent[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const run = useRef(0);

  const load = useCallback(async () => {
    const mine = ++run.current;
    try {
      const page = await reposApi.events({ repoId, ...filterQuery(filter), limit: PAGE });
      if (run.current !== mine) return;
      setEvents(page.events);
      setNext(page.next);
      setFailed(null);
    } catch (e) {
      if (run.current === mine) setFailed(e instanceof Error ? e.message : 'Couldn’t load it.');
    }
  }, [repoId, filter]);

  useEffect(() => {
    setEvents(null);
  }, [repoId, filter]);
  useEffect(() => void load(), [load, version]);

  const loadMore = async () => {
    if (!next) return;
    setMore(true);
    try {
      const page = await reposApi.events({ repoId, ...filterQuery(filter), before: next, limit: PAGE });
      setEvents((list) => [...(list ?? []), ...page.events]);
      setNext(page.next);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'Couldn’t load it.');
    } finally {
      setMore(false);
    }
  };

  return (
    <section aria-label="Timeline" className="flex flex-col gap-3">
      <div className="flex items-center gap-1">
        <h3 className="text-[13px] font-semibold text-muted">Timeline</h3>
        <InfoTip label="About the timeline">
          Commits: new commits and branch moves a scan noticed. Audit: what a person, a session, a ticket or a token asked the portal to do here. Kept 90 days.
        </InfoTip>
        <div className="ml-auto w-52">
          <Segmented<EventFilter> label="Show" value={filter} options={EVENT_FILTERS} onChange={setFilter} />
        </div>
      </div>
      {!events && !failed && <LinesSkeleton />}
      {failed && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
          <span className={cn('text-danger', BREAK)}>{failed}</span>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}
      {events && events.length === 0 && <p className="text-[13px] text-muted">{filter === 'all' ? 'Nothing yet.' : 'Nothing here.'}</p>}
      {events && events.length > 0 && (
        <ol className="flex flex-col">
          {events.map((e) => (
            <EventRow key={e.id} e={e} />
          ))}
        </ol>
      )}
      {next && (
        <Button variant="ghost" size="sm" className="self-center" loading={more} onClick={() => void loadMore()}>
          More
        </Button>
      )}
    </section>
  );
}

const LINK = 'font-medium text-ink-soft underline underline-offset-2 hover:text-ink';

function EventRow({ e }: { e: RepoEvent }) {
  const [open, setOpen] = useState(false);
  const lines = detailsOf(e);
  const ticket = ticketOf(e.actor);
  const session = e.sessionId;
  const sessionLink = session && (
    <Link to={`/admin/sessions/${encodeURIComponent(session)}`} className={LINK}>
      Session
    </Link>
  );
  // Who did it: a session or a ticket is a link to it; a change a session was in the repo for is "Workspace" with that session beside it.
  const who = e.actor.startsWith('session:') ? (
    sessionLink || 'Session'
  ) : ticket ? (
    <Link to={`/admin/tickets/${encodeURIComponent(ticket)}`} className={LINK}>
      {actorLabel(e.actor)}
    </Link>
  ) : (
    <span title={e.actor}>{actorLabel(e.actor)}</span>
  );
  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex items-start gap-2.5 py-2">
        <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', TONE_DOT[eventTone(e)])} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p dir="auto" className={cn('text-sm leading-snug text-ink', BREAK)}>{plainSummary(e)}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-muted">
            {who}
            {session && !e.actor.startsWith('session:') && (
              <>
                <span aria-hidden="true">·</span>
                {sessionLink}
              </>
            )}
            <span aria-hidden="true">·</span>
            <time dateTime={e.at} title={formatDateTime(e.at)}>
              {timeAgo(e.at)}
            </time>
          </p>
          {open && (
            <div className="mt-2 flex flex-col gap-1 rounded-xl bg-surface-2 px-2.5 py-2 text-[12.5px] text-ink-soft">
              {lines.map((l, i) => (
                <p key={i} dir="auto" className={cn('font-mono', BREAK)}>
                  {l}
                </p>
              ))}
            </div>
          )}
        </div>
        {lines.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Hide details' : 'Show details'}
            onClick={() => setOpen((o) => !o)}
            className="press -my-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
          >
            <ChevronDown className={cn('size-4 transition-transform duration-150', open && 'rotate-180')} />
          </button>
        )}
      </div>
    </li>
  );
}
