import { Badge, cn, Menu, Spinner, type MenuItem } from '@isnanme/ui';
import { rollupLine, workspaceLabel, type ChatSession, type ListGroupBy, type ListRow, type PersonaIdentity } from '@portal/contracts';
import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  Check,
  ChevronDown,
  CircleStop,
  CloudOff,
  GitBranch,
  MessageSquare,
  Moon,
  Pencil,
  Ticket,
  Trash2,
} from 'lucide-react';
import { Link } from 'react-router';
import { PersonaAvatar } from '@/features/personas/PersonaAvatar';
import { formatDateTime } from '@/lib/format';
import { endedForSafety, formatUsd, StateBadge, timeShort } from './shared';

/** What a row's ⋯ can do; the page owns the dialogs. */
export interface RowActions {
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

/** A row's ⋯ (FR4): Rename, Move to another Claude, Archive or Unarchive, End while it hasn't ended, Select, Delete (always confirmed). */
export function rowActions(row: ListRow, on: RowActions): MenuItem[] {
  const s = row.session;
  const gone = row.workspaceGone;
  return [
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
 */
export function SessionRow({
  row,
  depth = 0,
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
  const rollup = rollupLine(row.rollup);
  const asks = s.waiting > 0 || s.state === 'waiting';
  const persona = row.workspaceGone ? null : (personas?.[s.workspaceId] ?? null);

  // Line one: who runs it and when. Line two, when there is one: where its work is (branch, folder, ticket).
  const who: { key: string; node: React.ReactNode }[] = [];
  if (groupBy !== 'claude' && s.claudeName) who.push({ key: 'claude', node: <span className="shrink-0">{s.claudeName}</span> });
  if (groupBy !== 'workspace')
    who.push({
      key: 'ws',
      node: (
        <span title={s.workspaceId} className={cn('min-w-0 truncate font-mono', row.workspaceGone && 'line-through')}>
          {workspaceLabel(s.workspaceId)}
        </span>
      ),
    });
  if (s.costUsd > 0) who.push({ key: 'cost', node: <span className="shrink-0">{formatUsd(s.costUsd)}</span> });
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

  return (
    <li>
      <div className={cn('flex items-start gap-2.5 py-3 pr-2.5 pl-3 sm:pr-4 sm:pl-5', depth === 0 && 'pl-4', picked && 'bg-accent-soft/50')}>
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
              {safety ? <Badge tone="danger">{safety.label}</Badge> : s.state !== 'waiting' ? <StateBadge state={s.state} /> : null}
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
            {row.parentTitle && <p className="mt-0.5 truncate text-[12.5px] text-muted">Started by {row.parentTitle}</p>}
            {rollup && <p className="mt-0.5 text-[12.5px] text-muted">{rollup}</p>}
          </div>
        </Link>
        {row.children.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the ${row.children.length} ${row.children.length === 1 ? 'session' : 'sessions'} ${title} started`}
            onClick={() => onCollapse(s.id)}
            className="press flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
          >
            <ChevronDown className={cn('size-[18px] transition-transform', !open && '-rotate-90')} />
          </button>
        )}
        {!selecting && <Menu label={`Actions for ${title}`} items={rowActions(row, actions)} />}
      </div>
      {row.children.length > 0 && open && (
        <ul className="ml-4 border-l-2 border-line sm:ml-7">
          {row.children.map((c) => (
            <SessionRow
              key={c.session.id}
              row={c}
              depth={depth + 1}
              groupBy={groupBy}
              selecting={selecting}
              selected={selected}
              collapsed={collapsed}
              onToggle={onToggle}
              onCollapse={onCollapse}
              actions={actions}
              personas={personas}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
