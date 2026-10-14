import { Badge, cn, Dialog } from '@isnanme/ui';
import { needsYou, type ChatSession } from '@portal/contracts';
import { ChevronDown, CornerLeftUp, Network } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Popover } from '@/components/Popover';
import { chatApi } from './api';
import { crewOfSessions, otherClaude } from './crew';
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
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const { lead, workers, refresh } = crew;
  const count = workers?.length ?? 0;
  const asks = (workers ?? []).filter(needsYou).length;
  const close = useCallback(() => setOpen(false), []);
  // Another session opened from the list: the list closes.
  useEffect(() => setOpen(false), [session.id]);
  if (!crewShown(crew)) return null;

  const pill = 'flex h-8 min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[13px] text-ink-soft';
  const list = workers && <WorkerList session={session} workers={workers} onPick={close} />;
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
            setOpen((o) => !o);
          }}
          className="press pointer-events-auto flex h-11 shrink-0 items-center"
        >
          <span className={cn(pill, 'hover:text-ink', asks > 0 && 'border-amber-500/40 text-amber-700 dark:text-amber-400')}>
            <Network className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="font-semibold tabular-nums">{count}</span>
          </span>
        </button>
      )}
      {roomy ? (
        <Popover anchor={anchor} open={open && !!list} onClose={close} label="Workers" prefer="below">
          {list}
        </Popover>
      ) : (
        <Dialog open={open && !!list} onClose={close} title="Workers" size="sm">
          {list ?? null}
        </Dialog>
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
