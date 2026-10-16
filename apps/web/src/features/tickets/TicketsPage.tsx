import { Button, cn, EmptyState, LoadError, Menu, RowsSkeleton, useToast } from '@isnanme/ui';
import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABEL,
  TICKET_STATUS_LABEL,
  TICKET_TYPES,
  TICKET_TYPE_LABEL,
  isTicketClosed,
  type TicketFilter,
  type TicketItem,
  type TicketList,
  type TicketPriority,
  type TicketStatus,
  type TicketTag,
  type TicketType,
} from '@portal/contracts';
import { Bot, ChevronDown, ChevronsUp, Columns3, List, Plus, Search, Ticket as TicketIcon, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { usePanel, Workbench } from '@/components/Workbench';
import { errorText } from '@/lib/api';
import { useLive } from '@/lib/live';
import { ticketsApi } from './api';
import { BOARD_COLUMNS, ageShort, pageFilter } from './labels';
import { AssigneeChip, PriorityMark, StatusBadge, TagList, TicketFlags, TypeBadge } from './parts';
import { NewTicketDialog, TicketBumpDialog } from './TicketDialogs';

type Scope = 'active' | TicketStatus | 'closed';
type View = 'list' | 'board';

const VIEW_KEY = 'claudepilot.tickets-view';
const savedView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
};

const SCOPES: { id: Scope; label: string }[] = [
  { id: 'active', label: 'Active' },
  { id: 'open', label: 'Open' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'in_review', label: 'In review' },
  { id: 'closed', label: 'Closed' },
];

/** Closed tickets show in the board's last column, newest first, and no more than this many. */
const BOARD_CLOSED = 15;

// A ticket's page renders Markdown, so it loads on first use like the chat does.
const TicketPage = lazy(() => import('./TicketPage').then((m) => ({ default: m.TicketPage })));

/**
 * The Tickets page (tickets PRD §13), a Workbench of two panels (T-158): the queue, and the ticket that is open. On a phone one shows
 * at a time (a ticket in the queue's place, Back returns); where both fit (a desktop) the ticket opens beside the queue, which keeps
 * its place, its filters and its live updates. The address says which ticket is open (`/admin/tickets/T-n`, the filters kept).
 */
export function TicketsPage() {
  const { id } = useParams();
  return (
    <Workbench
      focus={id ? 'detail' : 'queue'}
      pinAlone
      panels={[
        { id: 'queue', label: 'Tickets', min: 300, grow: 1, priority: 0, scroll: 'self', content: <TicketQueue selected={id ?? null} /> },
        {
          id: 'detail',
          label: id ?? 'Ticket',
          min: 380,
          pref: 520,
          priority: 1,
          content: id ? (
            <Suspense fallback={<div className="skeleton h-40 rounded-[24px]" aria-busy="true" />}>
              <TicketPage />
            </Suspense>
          ) : null,
        },
      ]}
    />
  );
}

/**
 * The queue: a list or a board of tickets, filtered by status, priority, type, tag and who has it, with the ones waiting on you a tap
 * away. Filters live in the address, so a view can be shared. It follows the live socket: an agent's comment or a claim shows up
 * without a reload. Pinned (a desktop), the header and filters stay put and only the list or the board scrolls; the board scrolls
 * sideways inside itself, never the page.
 */
function TicketQueue({ selected }: { selected: string | null }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { pinned } = usePanel();
  const { search } = useLocation();
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'board' ? 'board' : params.get('view') === 'list' ? 'list' : savedView();
  const scope = (params.get('s') ?? 'active') as Scope;
  const needs = params.get('assignee') === 'user';
  const queue = params.get('assignee') === 'unassigned';
  const orphans = params.get('orphan') === '1';
  const priority = params.get('priority') as TicketPriority | null;
  const type = params.get('type') as TicketType | null;
  const tag = params.get('tag');
  const [text, setText] = useState(params.get('q') ?? '');
  const q = params.get('q') ?? '';

  const [data, setData] = useState<TicketList | null>(null);
  const [tags, setTags] = useState<TicketTag[]>([]);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [bumping, setBumping] = useState<TicketItem | null>(null);

  const set = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        for (const [k, v] of Object.entries(patch)) v === null || v === '' ? next.delete(k) : next.set(k, v);
        return next;
      },
      { replace: true },
    );

  const filter = useMemo<TicketFilter>(() => pageFilter({ view, scope, needs, queue, orphans, priority, type, tag, q }), [view, scope, needs, queue, orphans, priority, type, tag, q]);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [list, t] = await Promise.all([ticketsApi.list(filter), ticketsApi.tags()]);
      if (mine !== seq.current) return;
      setData(list);
      setTags(t);
      setFailed(false);
    } catch {
      if (mine === seq.current) setFailed(true);
    }
  }, [filter]);
  useEffect(() => void load(), [load]);
  useLive('tickets', () => void load());

  // The search box types freely and the list follows once typing pauses.
  useEffect(() => {
    if (text === q) return;
    const t = window.setTimeout(() => set({ q: text.trim() || null }), 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const setView = (v: View) => {
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // private window: just not remembered
    }
    set({ view: v });
  };

  const move = async (t: TicketItem, status: TicketStatus) => {
    try {
      await ticketsApi.update(t.id, { status });
      toast(`${t.id} moved to ${TICKET_STATUS_LABEL[status]}`);
      await load();
    } catch (e) {
      toast(errorText(e, 'Couldn’t move it.'), 'error');
    }
  };

  const counts = data?.counts;
  const chipCount = (s: Scope) => {
    if (!counts) return null;
    if (s === 'active') return counts.byStatus.open + counts.byStatus.in_progress + counts.byStatus.blocked + counts.byStatus.in_review;
    if (s === 'closed') return counts.byStatus.done + counts.byStatus.wont_do;
    return counts.byStatus[s];
  };

  const add = (
    <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
      <span className="hidden sm:inline">New ticket</span>
      <span className="sm:hidden">New</span>
    </Button>
  );
  // No tickets at all: nothing to search or filter, and the empty state holds the one New (QA-034).
  const none = !!counts && Object.values(counts.byStatus).every((n) => n === 0);
  // A ticket opens with the queue's address kept (its view and filters), so closing it, or Back, returns to the same queue.
  const open = (ticketId: string) => navigate({ pathname: `/admin/tickets/${ticketId}`, search });

  const body =
    data &&
    (data.items.length === 0 ? (
      <EmptyState icon={<TicketIcon className="size-6" />} title={q || needs || queue || orphans || priority || type || tag ? 'No match' : 'No tickets'} action={q || needs || queue || orphans || priority || type || tag ? undefined : add} />
    ) : view === 'list' ? (
      // As many columns of rows as the panel has room for (one on a phone): a wide screen shows more tickets, not longer rows.
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,28rem),1fr))] gap-2">
        {data.items.map((t) => (
          <TicketRow key={t.id} ticket={t} selected={t.id === selected} onOpen={() => open(t.id)} onBump={() => setBumping(t)} />
        ))}
      </ul>
    ) : (
      <Board items={data.items} selected={selected} search={search} pinned={pinned} onMove={move} onBump={setBumping} />
    ));

  return (
    <div className={cn(pinned && 'flex min-h-0 flex-1 flex-col')}>
      <PageHeader title="Tickets" action={none ? undefined : add} />

      <div className={cn('mb-4 flex flex-col gap-2.5', none && 'hidden')}>
        <div className="flex gap-2">
          {/* A form field keeps a usable width on a wide screen: the room goes to the board, not to the search box. */}
          <label className="relative max-w-2xl min-w-0 flex-1">
            <span className="sr-only">Search tickets</span>
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="h-11 w-full rounded-full border border-line bg-surface pr-10 pl-10 text-[16px] text-ink placeholder:text-muted focus:border-primary focus:outline-hidden sm:text-[15px] [&::-webkit-search-cancel-button]:hidden"
            />
            {text && (
              <button type="button" aria-label="Clear search" onClick={() => (setText(''), set({ q: null }))} className="press absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink tap:right-0 tap:size-11">
                <X className="size-4" />
              </button>
            )}
          </label>
          <div role="group" aria-label="View" className="flex shrink-0 rounded-full border border-line bg-surface p-0.5 tap:border-0 tap:p-0 tap:ring-1 tap:ring-line tap:ring-inset">
            {([
              ['list', List, 'List'],
              ['board', Columns3, 'Board'],
            ] as const).map(([id, Icon, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={view === id}
                aria-label={label}
                title={label}
                onClick={() => setView(id)}
                className={cn('press flex size-10 items-center justify-center rounded-full tap:size-11', view === id ? 'bg-primary text-primary-ink' : 'text-muted hover:text-ink')}
              >
                <Icon className="size-[18px]" />
              </button>
            ))}
          </div>
        </div>

        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
          {/* First while there are any: on a phone the row scrolls sideways, and an orphan must be seen without that. */}
          {(orphans || !!counts?.orphans) && (
            <Chip on={orphans} tone="danger" title="Their session ended: the portal moves them in a few minutes" onClick={() => set({ orphan: orphans ? null : '1', assignee: null, s: null })} count={counts?.orphans ?? null}>
              Orphans
            </Chip>
          )}
          {view === 'list' &&
            SCOPES.map((s) => {
              const on = scope === s.id && !needs && !queue && !orphans;
              const n = chipCount(s.id);
              return (
                <Chip key={s.id} on={on} onClick={() => set({ s: s.id === 'active' ? null : s.id, assignee: null, orphan: null })} count={n}>
                  {s.label}
                </Chip>
              );
            })}
          <Chip on={needs} tone="warning" onClick={() => set({ assignee: needs ? null : 'user', s: null, orphan: null })} count={counts?.needsYou ?? null}>
            Needs you
          </Chip>
          <Chip on={queue} title="Nobody has these: agents can take them" onClick={() => set({ assignee: queue ? null : 'unassigned', s: null, orphan: null })} count={counts?.unassigned ?? null}>
            Unassigned
          </Chip>
        </div>

        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
          <FilterSelect label="Priority" value={priority ?? ''} onChange={(v) => set({ priority: v || null })} options={TICKET_PRIORITIES.map((p) => ({ value: p, label: TICKET_PRIORITY_LABEL[p] }))} />
          <FilterSelect label="Type" value={type ?? ''} onChange={(v) => set({ type: v || null })} options={TICKET_TYPES.map((t) => ({ value: t, label: TICKET_TYPE_LABEL[t] }))} />
          {(tags.length > 0 || tag) && <FilterSelect label="Tag" value={tag ?? ''} onChange={(v) => set({ tag: v || null })} options={tags.map((t) => ({ value: t.tag, label: `${t.tag} (${t.count})` }))} />}
        </div>
      </div>

      {failed && !data && <LoadError onRetry={load} />}
      {!data && !failed && <RowsSkeleton rows={4} lines={2} trailing icon="rounded-2xl" />}
      {!pinned ? (
        body
      ) : view === 'board' && data?.items.length ? (
        // The board fills the rest of the panel: its columns scroll down, the board itself sideways.
        <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      ) : (
        // Room around the rows for their focus ring, which the scroller would clip.
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pt-1 pb-4">{body}</div>
      )}

      <TicketBumpDialog
        ticket={bumping}
        onClose={() => setBumping(null)}
        onBumped={(r) => {
          setBumping(null);
          toast(`${r.ticket.id} bumped into ${r.session.title || 'the session'}`);
          void load();
        }}
      />
      <NewTicketDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(t) => {
          setCreating(false);
          toast(`${t.id} created`);
          open(t.id);
        }}
      />
    </div>
  );
}

function Chip({ on, onClick, count, tone, title, children }: { on: boolean; onClick: () => void; count: number | null; tone?: 'warning' | 'danger'; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={cn(
        'press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13.5px] font-semibold transition-colors tap:h-11',
        on
          ? 'border-primary bg-primary text-primary-ink'
          : tone === 'warning' && count
            ? 'border-gold/50 bg-gold-soft text-ink hover:border-gold'
            : tone === 'danger' && count
              ? 'border-danger/50 bg-danger-soft text-ink hover:border-danger'
              : 'border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink',
      )}
    >
      {children}
      {count !== null && <span className={cn('tabular-nums', on ? 'text-primary-ink/70' : 'text-muted')}>{count}</span>}
    </button>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="relative shrink-0">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-9 appearance-none rounded-full border bg-surface pr-8 pl-3.5 text-[16px] font-semibold focus:border-primary focus:outline-hidden tap:h-11 sm:text-[13.5px]',
          value ? 'border-primary text-ink' : 'border-line text-ink-soft',
        )}
      >
        <option value="">{label}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
    </label>
  );
}

/**
 * A row opens the ticket; its ⋯ (outside the row's button, top right) has Bump for a ticket that isn't closed. The open ticket's row
 * is marked while it shows beside the queue.
 */
function TicketRow({ ticket: t, selected, onOpen, onBump }: { ticket: TicketItem; selected: boolean; onOpen: () => void; onBump: () => void }) {
  const open = !isTicketClosed(t.status);
  return (
    <li className="relative min-w-0">
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex h-full w-full min-w-0 items-start gap-3 rounded-2xl border bg-surface px-3.5 py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden',
          selected ? 'border-primary' : 'border-line',
          open && 'pr-12',
        )}
      >
        <PriorityMark priority={t.priority} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="shrink-0 text-[12.5px] font-semibold text-muted tabular-nums">{t.id}</span>
            <span className="line-clamp-2 text-[14.5px] font-semibold [overflow-wrap:anywhere]">{t.summary}</span>
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusBadge status={t.status} />
            <TypeBadge type={t.type} />
            <TicketFlags ticket={t} />
            <TagList tags={t.tags} />
          </span>
          <span className="mt-1.5 flex items-center gap-2 text-[12.5px] text-muted">
            <AssigneeChip ticket={t} />
            <span aria-hidden="true">·</span>
            <span title={t.updatedAt}>{ageShort(t.updatedAt)}</span>
            {t.source === 'agent' && <Bot className="size-3.5" aria-label="From an agent" />}
          </span>
        </span>
      </button>
      {open && (
        <div className={cn('absolute top-1.5 right-1.5', TAP_MENU)}>
          <Menu label={`More for ${t.id}`} align="right" items={[{ label: 'Bump…', icon: <ChevronsUp className="size-4" />, onSelect: onBump }]} />
        </div>
      )}
    </li>
  );
}

/** The kit's ⋯ menu button is 36 px: on a phone it gets the 44 px a finger needs (QA-STANDARDS A5). */
const TAP_MENU = 'tap:[&_[aria-haspopup=menu]]:size-11';

/**
 * A column per status; closed tickets share the last (newest first). Moving a card is a menu, which works on a phone and with a
 * keyboard. On a phone the columns keep their width and snap as you swipe; wider, they share the board's width between a minimum
 * and a maximum, so a wide screen shows every column. Pinned (a desktop) the board fills its panel's height, each column scrolls
 * down on its own and the board sideways, only when its columns do not fit.
 */
function Board({
  items,
  selected,
  search,
  pinned,
  onMove,
  onBump,
}: {
  items: TicketItem[];
  selected: string | null;
  search: string;
  pinned: boolean;
  onMove: (t: TicketItem, s: TicketStatus) => void;
  onBump: (t: TicketItem) => void;
}) {
  const columns = BOARD_COLUMNS.map((status) => {
    const cards =
      status === 'done'
        ? items
            .filter((t) => t.status === 'done' || t.status === 'wont_do')
            .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
            .slice(0, BOARD_CLOSED)
        : items.filter((t) => t.status === status);
    return { status, cards, total: status === 'done' ? items.filter((t) => t.status === 'done' || t.status === 'wont_do').length : cards.length };
  });
  return (
    // `relative`: the board is the containing block of what is absolutely placed in its cards (a priority's screen-reader text), so it
    // clips them too; without it they hang off the page at their place in a far column and widen the phone's layout (1216 px at 390).
    <div
      data-board=""
      className={cn(
        'relative -mx-4 flex gap-3 overflow-x-auto px-4 pb-3 sm:mx-0 sm:px-0',
        // On a phone a column snaps to the page's 16 px gutter (in line with the search), not to the screen's edge.
        pinned ? 'min-h-0 flex-1 overscroll-x-contain' : 'snap-x snap-mandatory scroll-px-4 sm:scroll-px-0',
      )}
    >
      {columns.map(({ status, cards, total }) => (
        <section
          key={status}
          aria-label={TICKET_STATUS_LABEL[status]}
          data-column={status}
          className={cn('w-[17.5rem] shrink-0 snap-start sm:w-auto sm:max-w-[40rem] sm:min-w-0 sm:flex-[1_0_16rem]', pinned && 'flex min-h-0 flex-col')}
        >
          <h2 className="mb-2 flex shrink-0 items-center gap-2 px-1 text-[13px] font-semibold text-ink-soft">
            {status === 'done' ? 'Closed' : TICKET_STATUS_LABEL[status]}
            <span className="rounded-full bg-surface-2 px-1.5 text-[11.5px] tabular-nums text-muted">{total}</span>
          </h2>
          <ul className={cn('flex flex-col gap-2 rounded-2xl bg-surface-2/50 p-2', pinned && 'min-h-0 overflow-y-auto overscroll-contain')}>
            {cards.length === 0 && <li className="px-2 py-4 text-center text-[13px] text-muted">None</li>}
            {cards.map((t) => (
              <li key={t.id} aria-current={t.id === selected ? 'true' : undefined} className={cn('rounded-xl border bg-surface p-3', t.id === selected ? 'border-primary' : 'border-line')}>
                <div className={cn('flex items-start gap-2', TAP_MENU)}>
                  <PriorityMark priority={t.priority} className="mt-px" />
                  <Link
                    to={{ pathname: `/admin/tickets/${t.id}`, search }}
                    className="min-w-0 flex-1 rounded-md focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-hidden tap:min-h-11"
                  >
                    <span className="text-[12px] font-semibold text-muted tabular-nums">{t.id}</span>
                    <span className="line-clamp-3 block text-[13.5px] font-semibold [overflow-wrap:anywhere]">{t.summary}</span>
                  </Link>
                  <Menu
                    label={`More for ${t.id}`}
                    items={[
                      ...(isTicketClosed(t.status) ? [] : [{ label: 'Bump…', icon: <ChevronsUp className="size-4" />, onSelect: () => onBump(t) }]),
                      ...(['open', 'in_progress', 'blocked', 'in_review', 'done', 'wont_do'] as TicketStatus[])
                        .filter((s) => s !== t.status)
                        .map((s) => ({ label: `Move to ${TICKET_STATUS_LABEL[s]}`, onSelect: () => onMove(t, s) })),
                    ]}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <TypeBadge type={t.type} />
                  <TicketFlags ticket={t} />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-muted">
                  <AssigneeChip ticket={t} />
                  <span>{ageShort(t.updatedAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
