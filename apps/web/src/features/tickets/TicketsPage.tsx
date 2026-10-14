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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
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

/**
 * The queue (tickets PRD §13): a list or a board of tickets, filtered by status, priority, type, tag and
 * who has it, with the ones waiting on you a tap away. Filters live in the address, so a view can be shared.
 * It follows the live socket: an agent's comment or a claim shows up without a reload.
 */
export function TicketsPage() {
  const toast = useToast();
  const navigate = useNavigate();
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

  return (
    <>
      <PageHeader title="Tickets" action={none ? undefined : add} />

      <div className={cn('mb-4 flex flex-col gap-2.5', none && 'hidden')}>
        <div className="flex gap-2">
          <label className="relative min-w-0 flex-1">
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
              className="h-11 w-full rounded-full border border-line bg-surface pr-10 pl-10 text-[16px] text-ink placeholder:text-muted focus:border-primary focus:outline-none sm:text-[15px] [&::-webkit-search-cancel-button]:hidden"
            />
            {text && (
              <button type="button" aria-label="Clear search" onClick={() => (setText(''), set({ q: null }))} className="press absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink">
                <X className="size-4" />
              </button>
            )}
          </label>
          <div role="group" aria-label="View" className="flex shrink-0 rounded-full border border-line bg-surface p-0.5">
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
                className={cn('press flex size-10 items-center justify-center rounded-full', view === id ? 'bg-primary text-primary-ink' : 'text-muted hover:text-ink')}
              >
                <Icon className="size-[18px]" />
              </button>
            ))}
          </div>
        </div>

        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
          {view === 'list' &&
            SCOPES.map((s) => {
              const on = scope === s.id && !needs && !queue;
              const n = chipCount(s.id);
              return (
                <Chip key={s.id} on={on} onClick={() => set({ s: s.id === 'active' ? null : s.id, assignee: null })} count={n}>
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
          {(orphans || !!counts?.orphans) && (
            <Chip on={orphans} tone="danger" title="Their session ended: the portal moves them in a few minutes" onClick={() => set({ orphan: orphans ? null : '1', assignee: null })} count={counts?.orphans ?? null}>
              Orphans
            </Chip>
          )}
        </div>

        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
          <FilterSelect label="Priority" value={priority ?? ''} onChange={(v) => set({ priority: v || null })} options={TICKET_PRIORITIES.map((p) => ({ value: p, label: TICKET_PRIORITY_LABEL[p] }))} />
          <FilterSelect label="Type" value={type ?? ''} onChange={(v) => set({ type: v || null })} options={TICKET_TYPES.map((t) => ({ value: t, label: TICKET_TYPE_LABEL[t] }))} />
          {(tags.length > 0 || tag) && <FilterSelect label="Tag" value={tag ?? ''} onChange={(v) => set({ tag: v || null })} options={tags.map((t) => ({ value: t.tag, label: `${t.tag} (${t.count})` }))} />}
        </div>
      </div>

      {failed && !data && <LoadError onRetry={load} />}
      {!data && !failed && <RowsSkeleton rows={4} lines={2} trailing icon="rounded-2xl" />}
      {data &&
        (data.items.length === 0 ? (
          <EmptyState icon={<TicketIcon className="size-6" />} title={q || needs || queue || orphans || priority || type || tag ? 'No match' : 'No tickets'} action={q || needs || queue || orphans || priority || type || tag ? undefined : add} />
        ) : view === 'list' ? (
          <ul className="flex flex-col gap-2">
            {data.items.map((t) => (
              <TicketRow key={t.id} ticket={t} onOpen={() => navigate(`/admin/tickets/${t.id}`)} onBump={() => setBumping(t)} />
            ))}
          </ul>
        ) : (
          <Board items={data.items} onMove={move} onBump={setBumping} />
        ))}

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
          navigate(`/admin/tickets/${t.id}`);
        }}
      />
    </>
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
        'press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13.5px] font-semibold transition-colors',
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
          'h-9 appearance-none rounded-full border bg-surface pr-8 pl-3.5 text-[16px] font-semibold focus:border-primary focus:outline-none sm:text-[13.5px]',
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

/** A row opens the ticket; its ⋯ (outside the row's button, top right) has Bump for a ticket that isn't closed. */
function TicketRow({ ticket: t, onOpen, onBump }: { ticket: TicketItem; onOpen: () => void; onBump: () => void }) {
  const open = !isTicketClosed(t.status);
  return (
    <li className="relative">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'flex w-full min-w-0 items-start gap-3 rounded-2xl border border-line bg-surface px-3.5 py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
          open && 'pr-12',
        )}
      >
        <PriorityMark priority={t.priority} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="shrink-0 text-[12.5px] font-semibold text-muted tabular-nums">{t.id}</span>
            <span className="line-clamp-2 text-[14.5px] font-semibold">{t.summary}</span>
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
        <div className="absolute top-1.5 right-1.5">
          <Menu label={`More for ${t.id}`} align="right" items={[{ label: 'Bump…', icon: <ChevronsUp className="size-4" />, onSelect: onBump }]} />
        </div>
      )}
    </li>
  );
}

/** A column per status; closed tickets share the last (newest first). Moving a card is a menu, which works on a phone and with a keyboard. */
function Board({ items, onMove, onBump }: { items: TicketItem[]; onMove: (t: TicketItem, s: TicketStatus) => void; onBump: (t: TicketItem) => void }) {
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
    <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-3 sm:mx-0 sm:px-0">
      {columns.map(({ status, cards, total }) => (
        <section key={status} aria-label={TICKET_STATUS_LABEL[status]} className="w-[17.5rem] shrink-0 snap-start sm:w-[16rem] lg:w-[17rem]">
          <h2 className="mb-2 flex items-center gap-2 px-1 text-[13px] font-semibold text-ink-soft">
            {status === 'done' ? 'Closed' : TICKET_STATUS_LABEL[status]}
            <span className="rounded-full bg-surface-2 px-1.5 text-[11.5px] tabular-nums text-muted">{total}</span>
          </h2>
          <ul className="flex flex-col gap-2 rounded-2xl bg-surface-2/50 p-2">
            {cards.length === 0 && <li className="px-2 py-4 text-center text-[13px] text-muted">None</li>}
            {cards.map((t) => (
              <li key={t.id} className="rounded-xl border border-line bg-surface p-3">
                <div className="flex items-start gap-2">
                  <PriorityMark priority={t.priority} className="mt-px" />
                  <Link to={`/admin/tickets/${t.id}`} className="min-w-0 flex-1 rounded-md focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none">
                    <span className="text-[12px] font-semibold text-muted tabular-nums">{t.id}</span>
                    <span className="line-clamp-3 block text-[13.5px] font-semibold">{t.summary}</span>
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
