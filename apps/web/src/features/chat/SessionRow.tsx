import { Badge, cn, Menu, Spinner, type MenuItem } from '@isnanme/ui';
import { sessionCost, workspaceLabel, type ChatSession, type ListGroupBy, type ListRow, type PersonaIdentity } from '@portal/contracts';
import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  Check,
  ChevronDown,
  CircleStop,
  CloudOff,
  CornerLeftUp,
  GitBranch,
  MessageSquare,
  Moon,
  Network,
  Pencil,
  Pin,
  PinOff,
  Ticket,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { PersonaAvatar } from '@/features/personas/PersonaAvatar';
import { formatDateTime } from '@/lib/format';
import { crewCount, crewOfRows, fromLead, otherClaude } from './crew';
import { RecoverButton } from './Recover';
import { RoleBadge } from './RoleBadge';
import { endedForSafety, formatUsd, StateBadge, timeShort } from './shared';
import { SWIPE_SETTLE_MS, useRowSwipe } from './swipe';

/** What a row's ⋯ can do; the page owns the dialogs. */
export interface RowActions {
  /** Pin or unpin (FR2): a pinned session leads its group and the Pinned chip lists it. */
  pin: (s: ChatSession) => void;
  rename: (s: ChatSession) => void;
  end: (s: ChatSession) => void;
  archive: (s: ChatSession) => void;
  unarchive: (s: ChatSession) => void;
  remove: (s: ChatSession) => void;
  /** Move the chat to another Claude. */
  move: (s: ChatSession) => void;
  /** Starts selecting with this row picked. */
  select: (s: ChatSession) => void;
}

/** A row's ⋯ (FR4): Pin or Unpin, Rename, Move to another Claude, Archive or Unarchive, End while it hasn't ended, Select, Delete (always confirmed). */
export function rowActions(row: ListRow, on: RowActions): MenuItem[] {
  const s = row.session;
  const gone = row.workspaceGone;
  return [
    ...(s.archivedAt
      ? []
      : [s.pinnedAt ? { label: 'Unpin', icon: <PinOff className="size-4" />, onSelect: () => on.pin(s) } : { label: 'Pin', icon: <Pin className="size-4" />, onSelect: () => on.pin(s) }]),
    { label: 'Rename…', icon: <Pencil className="size-4" />, onSelect: () => on.rename(s) },
    ...(!gone && s.state !== 'ended' && !s.switching
      ? [{ label: 'Move to another Claude…', icon: <ArrowRightLeft className="size-4" />, onSelect: () => on.move(s) }]
      : []),
    s.archivedAt
      ? { label: 'Unarchive', icon: <ArchiveRestore className="size-4" />, onSelect: () => on.unarchive(s) }
      : { label: 'Archive', icon: <Archive className="size-4" />, onSelect: () => on.archive(s) },
    ...(s.state === 'ended' ? [] : [{ label: 'End session', icon: <CircleStop className="size-4" />, onSelect: () => on.end(s), danger: true }]),
    { label: 'Select', icon: <Check className="size-4" />, onSelect: () => on.select(s) },
    { label: 'Delete…', icon: <Trash2 className="size-4" />, onSelect: () => on.remove(s), danger: true },
  ];
}

/** The folder a session works in as people read it: the branch for a worktree, else the last folder name. */
const folderName = (s: ChatSession) => s.cwd.replace(/\/+$/, '').slice(s.cwd.replace(/\/+$/, '').lastIndexOf('/') + 1) || '~';

/**
 * One session in the list: its state, where it runs (Claude, workspace, branch, ticket: whatever the
 * grouping doesn't already say), what it waits on, what it started, and ⋯. Selecting turns the row into
 * a checkbox. Grouped by Claude, a chat that moved is also listed, lighter, under the Claudes it ran on
 * earlier: the same chat. A removed workspace is stated plainly.
 *
 * Crew (T-294, crew.ts): a lead's row counts what it started (an icon and a number; the words in the tip); its workers sit under it on a
 * rail, the live ones in spawn order, the done ones behind one "N done" row; a worker names its Claude only when it differs from its
 * lead's. A worker shown away from its lead links to it ("from …"). A session that runs as an agent shows its role (a badge), only when set.
 */
export function SessionRow({
  row,
  depth = 0,
  lead = null,
  groupBy,
  selecting,
  selected,
  collapsed,
  onToggle,
  onCollapse,
  actions,
  personas,
}: {
  row: ListRow;
  depth?: number;
  /** The session it is nested under (a worker's lead), to name its Claude only when it differs. */
  lead?: ChatSession | null;
  groupBy: ListGroupBy;
  selecting: boolean;
  selected: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onCollapse: (id: string) => void;
  actions: RowActions;
  /** Each workspace's persona (I11), by workspace id: its avatar stands in for the chat icon. */
  personas?: Readonly<Record<string, PersonaIdentity>> | null;
}) {
  const s = row.session;
  const title = s.title || 'Untitled';
  const [doneOpen, setDoneOpen] = useState(false);
  if (row.earlier)
    return (
      <li>
        <Link to={`/admin/sessions/${s.id}`} className="press flex items-center gap-3 py-2.5 pr-4 pl-4 sm:pl-5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
            <MessageSquare className="size-4" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink-soft">{title}</span>
          <span className="shrink-0 text-[12.5px] text-muted">now on {s.claudeName ?? 'another Claude'}</span>
        </Link>
      </li>
    );
  const active = s.state === 'working' || s.state === 'waiting';
  const safety = s.state === 'ended' ? endedForSafety(s.endedReason) : null;
  const picked = selected.has(s.id);
  const open = !collapsed.has(s.id);
  const crew = crewCount(row.rollup);
  const workers = crewOfRows(row.children);
  const from = fromLead(row);
  // A worker under its lead: its Claude is the lead's unless it says otherwise (a badge), so the line does not repeat it.
  const ownClaude = depth > 0 ? otherClaude(s, lead) : null;
  const asks = s.waiting > 0 || s.state === 'waiting';
  const persona = row.workspaceGone ? null : (personas?.[s.workspaceId] ?? null);

  // Line one: who runs it and when. Line two, when there is one: where its work is (branch, folder, ticket).
  const who: { key: string; node: React.ReactNode }[] = [];
  if (groupBy !== 'claude' && s.claudeName && depth === 0) who.push({ key: 'claude', node: <span className="shrink-0">{s.claudeName}</span> });
  if (groupBy !== 'workspace')
    who.push({
      key: 'ws',
      node: (
        <span title={s.workspaceId} className={cn('min-w-0 truncate font-mono', row.workspaceGone && 'line-through')}>
          {workspaceLabel(s.workspaceId)}
        </span>
      ),
    });
  // T-343: a running turn's cost is an estimate (≈) until its result; a model without a price adds nothing (unavailable, never a guess).
  const cost = sessionCost(s);
  if (cost.usd > 0) who.push({ key: 'cost', node: <span className="shrink-0">{cost.basis === 'estimate' ? `≈ ${formatUsd(cost.usd)}` : formatUsd(cost.usd)}</span> });
  who.push({
    key: 'time',
    node: (
      <span className="shrink-0" title={formatDateTime(s.lastActivityAt)}>
        {timeShort(s.lastActivityAt)}
      </span>
    ),
  });
  const where: { key: string; node: React.ReactNode }[] = [];
  if (s.worktree && groupBy !== 'worktree')
    where.push({
      key: 'wt',
      node: (
        <span title={s.worktree.path} className="inline-flex min-w-0 items-center gap-1 font-mono">
          <GitBranch className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{s.worktree.branch}</span>
        </span>
      ),
    });
  else if (!s.worktree && groupBy === 'none' && s.cwd !== '/home/node')
    where.push({ key: 'dir', node: <span title={s.cwd} className="min-w-0 truncate font-mono">{folderName(s)}</span> });
  if (s.ticketId && groupBy !== 'ticket')
    where.push({
      key: 'ticket',
      node: (
        <span className="inline-flex shrink-0 items-center gap-1">
          <Ticket className="size-3" aria-hidden="true" />
          {s.ticketId}
        </span>
      ),
    });
  const line = (items: { key: string; node: React.ReactNode }[]) => (
    <p className="mt-0.5 flex min-w-0 items-baseline gap-1 text-[13px] text-muted">
      {items.map((m, i) => (
        <span key={m.key} className="flex min-w-0 items-baseline gap-1">
          {m.node}
          {i < items.length - 1 && <span aria-hidden="true">·</span>}
        </span>
      ))}
    </p>
  );

  const click = (e: React.MouseEvent) => {
    if (!selecting) return;
    e.preventDefault();
    onToggle(s.id);
  };

  // Swipe on a touch screen: right pins (or unpins), left archives (or unarchives). The panes behind the row say so; past the threshold they
  // fill in. The row moves by transform inside a box that clips while it moves, so the page never scrolls sideways; at rest nothing clips
  // (the ⋯ menu opens past the row). The box and the row take the corners the card gives the li (RowList, T-100), so neither paints a
  // square past the card's curve.
  const swipe = useRowSwipe({
    enabled: !selecting,
    onRight: () => actions.pin(s),
    onLeft: () => (s.archivedAt ? actions.unarchive(s) : actions.archive(s)),
  });
  const rightLabel = s.pinnedAt ? 'Unpin' : 'Pin';
  const leftLabel = s.archivedAt ? 'Unarchive' : 'Archive';

  const nested = (c: ListRow) => (
    <SessionRow
      key={c.session.id}
      row={c}
      depth={depth + 1}
      lead={s}
      groupBy={groupBy}
      selecting={selecting}
      selected={selected}
      collapsed={collapsed}
      onToggle={onToggle}
      onCollapse={onCollapse}
      actions={actions}
      personas={personas}
    />
  );

  return (
    <li>
      <div className={cn('relative rounded-[inherit]', swipe.clipped && 'overflow-hidden')} style={{ touchAction: 'pan-y' }} {...swipe.handlers}>
        {swipe.dx !== 0 && (
          <div aria-hidden="true" className="absolute inset-0 flex items-stretch justify-between rounded-[inherit] text-[12.5px] font-semibold">
            <span className={cn('flex w-[104px] items-center gap-1.5 pl-4 transition-colors', swipe.armed === 'right' ? 'bg-primary text-primary-ink' : 'bg-primary/15 text-primary')}>
              {s.pinnedAt ? <PinOff className="size-4" /> : <Pin className="size-4" />}
              {rightLabel}
            </span>
            <span className={cn('flex w-[104px] items-center justify-end gap-1.5 pr-4 transition-colors', swipe.armed === 'left' ? 'bg-danger text-white' : 'bg-danger/15 text-danger')}>
              {leftLabel}
              {s.archivedAt ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            </span>
          </div>
        )}
      <div
        data-swipe={swipe.dx !== 0 ? 'moving' : undefined}
        style={{ transform: swipe.dx ? `translateX(${swipe.dx}px)` : undefined, transition: swipe.dragging ? 'none' : `transform ${SWIPE_SETTLE_MS}ms ease-out` }}
        className={cn('relative flex flex-wrap items-start gap-x-2.5 rounded-[inherit] bg-surface py-3 pr-2.5 pl-3 sm:pr-4 sm:pl-5', depth === 0 && 'pl-4', picked && 'bg-accent-soft/50')}
      >
        {selecting && (
          <button
            type="button"
            role="checkbox"
            aria-checked={picked}
            aria-label={`Select ${title}`}
            onClick={() => onToggle(s.id)}
            className={cn(
              'press mt-2 flex size-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors',
              picked ? 'border-primary bg-primary text-primary-ink' : 'border-line-strong bg-surface',
            )}
          >
            {picked && <Check className="size-4" strokeWidth={3} />}
          </button>
        )}
        <Link
          to={`/admin/sessions/${s.id}`}
          onClick={click}
          aria-label={selecting ? undefined : undefined}
          className="flex min-w-0 flex-1 items-start gap-3"
        >
          {persona ? (
            // The persona's avatar, ringed when the chat needs you or is working: the state the icon's colour tells.
            <span
              className={cn(
                'flex shrink-0 items-center justify-center rounded-full p-1',
                depth > 0 ? 'size-8 sm:size-10' : 'size-10',
                asks ? 'ring-2 ring-amber-500/60' : active ? 'ring-2 ring-accent/60' : 'ring-1 ring-line',
              )}
            >
              <PersonaAvatar name={persona.name} avatar={persona.avatar} size={depth > 0 ? 'sm' : 'md'} />
            </span>
          ) : (
            <span
              className={cn(
                'flex shrink-0 items-center justify-center',
                depth > 0 ? 'size-8 rounded-lg sm:size-10 sm:rounded-xl' : 'size-10 rounded-xl',
                asks ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' : active ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-soft',
                row.workspaceGone && 'opacity-60',
              )}
            >
              {row.workspaceGone ? <CloudOff className="size-[18px] sm:size-5" /> : s.process === 'asleep' && s.state === 'idle' ? <Moon className="size-[18px] sm:size-5" /> : <MessageSquare className="size-[18px] sm:size-5" />}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="min-w-0 truncate font-semibold">{title}</p>
              {s.pinnedAt && <Pin className="size-3.5 shrink-0 text-muted" aria-label="Pinned" />}
              <RoleBadge session={s} />
              {ownClaude && (
                <Badge className="max-w-full min-w-0">
                  <span className="min-w-0 truncate">{ownClaude}</span>
                </Badge>
              )}
              {crew && (
                <span title={crew.label} data-crew-count="" className="inline-flex shrink-0">
                  <Badge tone={crew.tone}>
                    <Network className="size-3" aria-hidden="true" />
                    <span aria-hidden="true" className="tabular-nums">
                      {crew.total}
                    </span>
                    <span className="sr-only">{crew.label}</span>
                  </Badge>
                </span>
              )}
              {safety ? <Badge tone="danger">{safety.label}</Badge> : s.state !== 'waiting' ? <StateBadge state={s.state} agents={s.agentsRunning ?? 0} /> : null}
              {asks && !s.waitingFor && <Badge tone="warning">{s.waiting > 1 ? `${s.waiting} waiting` : 'Needs you'}</Badge>}
              {s.switching && (
                <Badge>
                  <Spinner className="size-3" /> Moving
                </Badge>
              )}
              {row.workspaceGone && <Badge tone="danger">Removed</Badge>}
              {s.mode === 'bypassPermissions' && s.state !== 'ended' && <Badge tone="danger">Bypass</Badge>}
            </div>
            {line(who)}
            {where.length > 0 && line(where)}
            {asks && s.waitingFor && <p className="mt-0.5 truncate text-[13px] font-medium text-amber-700 dark:text-amber-400">{s.waitingFor}</p>}
          </div>
        </Link>
        {row.children.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the ${row.children.length} ${row.children.length === 1 ? 'session' : 'sessions'} ${title} started`}
            onClick={() => onCollapse(s.id)}
            className="press -my-1 flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink sm:my-0 sm:size-9"
          >
            <ChevronDown className={cn('size-[18px] transition-transform', !open && '-rotate-90')} />
          </button>
        )}
        {!selecting && s.endedFor && !s.archivedAt && <RecoverButton session={s} tip={false} />}
        {!selecting && <Menu label={`Actions for ${title}`} items={rowActions(row, actions)} />}
        {from && !selecting && (
          <Link
            to={`/admin/sessions/${from.id}`}
            data-crew-from=""
            className="press -mt-2 -mb-2 flex min-h-11 min-w-0 basis-full items-center gap-1 pl-[52px] text-[12.5px] text-muted hover:text-ink sm:-mt-1 sm:-mb-1 sm:min-h-8"
          >
            <CornerLeftUp className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">from {from.title}</span>
          </Link>
        )}
      </div>
      </div>
      {row.children.length > 0 && open && (
        <ul data-crew="" className="ml-4 border-l-2 border-line sm:ml-7">
          {workers.live.map(nested)}
          {workers.done.length > 0 && (
            // One row for the done ones; it stays put after the live workers, and opening it lists them below it.
            <li>
              <button
                type="button"
                data-crew-done=""
                aria-expanded={doneOpen}
                onClick={() => setDoneOpen((o) => !o)}
                className="press flex min-h-11 w-full items-center gap-2 py-1.5 pr-4 pl-3 text-left text-[13px] font-semibold text-muted hover:text-ink sm:min-h-9 sm:pl-5"
              >
                <ChevronDown className={cn('size-4 shrink-0 transition-transform', !doneOpen && '-rotate-90')} aria-hidden="true" />
                <span className="tabular-nums">{workers.done.length} done</span>
              </button>
            </li>
          )}
          {doneOpen && workers.done.map(nested)}
        </ul>
      )}
    </li>
  );
}
