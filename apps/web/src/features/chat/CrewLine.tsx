import { Badge, cn, Dialog } from '@isnanme/ui';
import { needsYou, type ChatSession } from '@portal/contracts';
import { ChevronDown, CircleAlert, CornerLeftUp, MessagesSquare, Network } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Popover } from '@/components/Popover';
import { chatApi } from './api';
import { crewOfSessions, otherClaude } from './crew';
import { CrewThread, useCrewChannel } from './CrewThread';
import { pillToFocus, threadCount, type CrewSheet } from './crewThread';
import { roleOf } from './crewLimits';
import { RoleBadge } from './RoleBadge';
import { StateBadge } from './shared';

export interface CrewState {
  /** The session that started this one (its lead), when it has one the portal still has. */
  lead: ChatSession | null;
  /** The sessions this one started, oldest first; null until known. */
  workers: ChatSession[] | null;
  /** Reads the workers again (the list opens fresh). */
  refresh: () => void;
}

/**
 * A session's crew (T-294): its lead (read once per lead) and its workers, read again when the session's state changes (a turn that started
 * one ends) and when the list opens. Nothing is polled; a failed read leaves what is known (no lead shows nothing, not a guess).
 */
export function useCrew(session: ChatSession | null | undefined): CrewState {
  const id = session?.id ?? '';
  const leadId = session?.parentId ?? '';
  const state = session?.state;
  const [lead, setLead] = useState<ChatSession | null>(null);
  const [workers, setWorkers] = useState<ChatSession[] | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    setLead(null);
    if (!leadId) return;
    let current = true;
    chatApi.get(leadId).then(
      (s) => current && setLead(s),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [leadId]);

  useEffect(() => {
    if (!id) return;
    let current = true;
    chatApi.children(id).then(
      (list) => current && setWorkers(list),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [id, state, round]);
  useEffect(() => setWorkers(null), [id]);

  const refresh = useCallback(() => setRound((n) => n + 1), []);
  return { lead, workers, refresh };
}

/** Whether the crew line shows: a lead, or workers. */
export const crewShown = (c: CrewState) => !!c.lead || (c.workers?.length ?? 0) > 0;

/**
 * The line under the session header (T-294): up to its lead ("from", its title and Claude) and down to its workers (an icon and their
 * number, a list on tap: title, state, Claude). Each pill sits in a 44 px target; the line itself lets taps through to the transcript.
 */
export function CrewLine({ session, crew, roomy }: { session: ChatSession; crew: CrewState; roomy: boolean }) {
  // One sheet at a time: the workers, or the crew's thread.
  const [sheet, setSheet] = useState<CrewSheet>(null);
  const open = sheet === 'workers';
  const threadOpen = sheet === 'thread';
  const anchor = useRef<HTMLButtonElement>(null);
  const threadAnchor = useRef<HTMLButtonElement>(null);
  const { lead, workers, refresh } = crew;
  const count = workers?.length ?? 0;
  // The channel is the lead's own: a session with workers shows it; a worker's page links up to its lead instead.
  const channel = useCrewChannel(session.id, count > 0, session.state);
  const posts = channel.messages.length;
  const channelFailed = channel.status === 'failed';
  const asks = (workers ?? []).filter(needsYou).length;
  const close = useCallback(() => setSheet(null), []);
  // Another session opened from the list: the sheet closes.
  useEffect(() => setSheet(null), [session.id]);
  // A desktop popover that closes, whichever way (Escape from inside it, a tap away, a resize), gives focus back to the pill that opened it. The
  // removed panel leaves focus on the body; a control the person moved to is left alone (crewThread.pillToFocus). Not a keydown listener of
  // ours: the popover's own Escape closes the sheet first and React removes such a listener before it runs.
  const was = useRef<CrewSheet>(null);
  useEffect(() => {
    const prev = was.current;
    was.current = sheet;
    const at = !document.activeElement || document.activeElement === document.body ? 'body' : 'other';
    const to = pillToFocus(prev, sheet, roomy, at);
    if (to) (to === 'thread' ? threadAnchor : anchor).current?.focus();
  }, [sheet, roomy]);
  if (!crewShown(crew)) return null;

  const pill = 'flex h-8 min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[13px] text-ink-soft';
  const channelLabel = channelFailed
    ? 'Crew messages, could not load'
    : posts > 0
      ? threadCount(posts)
      : channel.status === 'ready'
        ? 'Crew messages, none yet'
        : 'Crew messages';
  const list = workers && <WorkerList session={session} workers={workers} onPick={close} />;
  const thread = <CrewThread lead={session} workers={workers ?? []} channel={channel} trap={roomy} />;
  return (
    <div data-crew-line="" className="mx-auto flex max-w-[760px] items-center gap-2 px-1">
      {lead && (
        <Link
          to={`/admin/sessions/${lead.id}`}
          data-crew-lead=""
          title={lead.title || 'Untitled'}
          className="press pointer-events-auto flex h-11 min-w-0 items-center"
        >
          <span className={cn(pill, 'hover:text-ink')}>
            <CornerLeftUp className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="sr-only">From </span>
            <span className="min-w-0 truncate font-medium text-ink">{lead.title || 'Untitled'}</span>
            {lead.claudeName && <span className="shrink-0 text-muted">· {lead.claudeName}</span>}
          </span>
        </Link>
      )}
      {count > 0 && (
        <button
          ref={anchor}
          type="button"
          data-crew-workers=""
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${count} ${count === 1 ? 'worker' : 'workers'}${asks ? `, ${asks} ${asks === 1 ? 'needs' : 'need'} you` : ''}`}
          onClick={() => {
            if (!open) refresh();
            setSheet(open ? null : 'workers');
          }}
          className="press pointer-events-auto flex h-11 shrink-0 items-center"
        >
          <span className={cn(pill, 'hover:text-ink', asks > 0 && 'border-amber-500/40 text-amber-700 dark:text-amber-400')}>
            <Network className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="font-semibold tabular-nums">{count}</span>
          </span>
        </button>
      )}
      {count > 0 && (
        <button
          ref={threadAnchor}
          type="button"
          data-crew-channel=""
          aria-haspopup="dialog"
          aria-expanded={threadOpen}
          aria-label={channelLabel}
          title={channelLabel}
          onClick={() => {
            if (!threadOpen) refresh();
            setSheet(threadOpen ? null : 'thread');
          }}
          className="press pointer-events-auto flex h-11 shrink-0 items-center"
        >
          <span className={cn(pill, 'hover:text-ink', channelFailed && 'border-amber-500/40 text-amber-700 dark:text-amber-400')}>
            {channelFailed ? (
              <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <MessagesSquare className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            {posts > 0 && <span className="font-semibold tabular-nums">{posts}</span>}
          </span>
        </button>
      )}
      {roomy ? (
        <>
          <Popover anchor={anchor} open={open && !!list} onClose={close} label="Workers" prefer="below">
            {list}
          </Popover>
          <Popover anchor={threadAnchor} open={threadOpen && count > 0} onClose={close} label="Crew" prefer="below">
            {thread}
          </Popover>
        </>
      ) : (
        <>
          <Dialog open={open && !!list} onClose={close} title="Workers" size="sm">
            {list ?? null}
          </Dialog>
          <Dialog open={threadOpen && count > 0} onClose={close} title="Crew" size="sm">
            {thread}
          </Dialog>
        </>
      )}
    </div>
  );
}

/**
 * The workers, each a link: title (its role under it, when it has one), state, and its Claude when it differs from this session's; the
 * done ones behind one row.
 */
function WorkerList({ session, workers, onPick }: { session: ChatSession; workers: ChatSession[]; onPick: () => void }) {
  const [doneOpen, setDoneOpen] = useState(false);
  const { live, done } = crewOfSessions(workers);
  const row = (w: ChatSession) => {
    const claude = otherClaude(w, session);
    const asks = w.waiting > 0 || w.state === 'waiting';
    return (
      <li key={w.id}>
        <Link to={`/admin/sessions/${w.id}`} onClick={onPick} className="press flex min-h-11 items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-surface-2">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium">{w.title || 'Untitled'}</span>
            {roleOf(w) && (
              <span className="mt-0.5 flex min-w-0">
                <RoleBadge session={w} />
              </span>
            )}
          </span>
          {claude && (
            <Badge className="max-w-[40%] min-w-0">
              <span className="min-w-0 truncate">{claude}</span>
            </Badge>
          )}
          {asks ? <Badge tone="warning">Needs you</Badge> : <StateBadge state={w.state} agents={w.agentsRunning ?? 0} />}
        </Link>
      </li>
    );
  };
  return (
    <ul data-crew-list="" className="flex flex-col gap-0.5">
      {live.map(row)}
      {done.length > 0 && (
        <li>
          <button
            type="button"
            aria-expanded={doneOpen}
            onClick={() => setDoneOpen((o) => !o)}
            className="press flex min-h-11 w-full items-center gap-2 rounded-xl px-2 text-left text-[13px] font-semibold text-muted hover:text-ink"
          >
            <ChevronDown className={cn('size-4 shrink-0 transition-transform', !doneOpen && '-rotate-90')} aria-hidden="true" />
            <span className="tabular-nums">{done.length} done</span>
          </button>
        </li>
      )}
      {doneOpen && done.map(row)}
    </ul>
  );
}
