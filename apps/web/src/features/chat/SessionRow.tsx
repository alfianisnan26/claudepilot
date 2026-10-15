import { Badge, cn, Menu, type MenuItem } from '@isnanme/ui';
import type { ChatSession, ClaudeUsage, ListGroupBy, ListRow, PersonaIdentity } from '@portal/contracts';
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
  IdCard,
  MessageSquare,
  Moon,
  Network,
  Pencil,
  Pin,
  PinOff,
  ShieldAlert,
  Ticket,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { InfoTip } from '@/components/InfoTip';
import { PersonaAvatar } from '@/features/personas/PersonaAvatar';
import { formatDateTime } from '@/lib/format';
import { crewCount, crewOfRows, fromLead } from './crew';
import { RecoverButton } from './Recover';
import { RoleBadge } from './RoleBadge';
import { barWidth, roleShown, rowMeta, rowState, thirdLine, type QuotaMeter, type RowMeta, type RowState } from './rowMeta';
import { endedForSafety, formatUsd, StateBadge, timeShort } from './shared';
import { SWIPE_SETTLE_MS, useRowSwipe } from './swipe';

/**
 * What every row needs to know about the rows on screen and the Claudes (T-375, rowMeta.ts): whether the workspace label and the persona
 * avatars tell rows apart, and the claude-usage snapshot (by Claude id; null while it loads) for the quota bars, read at `nowMs`.
 */
export interface RowFacts {
  showWorkspace: boolean;
  showAvatars: boolean;
  usage: ReadonlyMap<string, ClaudeUsage> | null;
  nowMs: number;
}

const NO_FACTS: RowFacts = { showWorkspace: true, showAvatars: false, usage: null, nowMs: 0 };

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

const DOT: Record<RowState['tone'], string> = {
  busy: 'bg-accent animate-pulse motion-reduce:animate-none',
  ask: 'bg-amber-500',
  danger: 'bg-danger',
  quiet: 'bg-muted/60',
};
const WORD: Record<RowState['tone'], string> = {
  busy: 'text-ink-soft',
  ask: 'font-medium text-amber-700 dark:text-amber-400',
  danger: 'font-medium text-danger',
  quiet: '',
};

/** Line two's state: a dot and a word; from 640 px a working session also says how many agents run (T-41). */
function StateWord({ state }: { state: RowState }) {
  return (
    <span data-row-state="" className={cn('inline-flex items-center gap-1', WORD[state.tone])}>
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', DOT[state.tone])} />
      {state.word}
      {state.agents > 0 && (
        <span className="hidden sm:inline">
          {' '}
          · {state.agents} {state.agents === 1 ? 'agent' : 'agents'}
        </span>
      )}
    </span>
  );
}

const BAR: Record<'neutral' | 'warn' | 'critical', string> = { neutral: 'bg-ink-soft', warn: 'bg-amber-500', critical: 'bg-danger' };
const PCT: Record<'neutral' | 'warn' | 'critical', string> = { neutral: '', warn: 'text-amber-700 dark:text-amber-400', critical: 'text-danger' };

/**
 * The mini quota bar (28 x 4 px) of the Claude a session runs on, then its name (capped; a short line cuts the name, never the bar): the
 * 5-hour window's percent used, neutral, amber from 70, red from 90; grey with no number when the reading is unavailable; no bar for a pool
 * or a key. The words (5-hour and week, resets, the reading's age)
 * are the tip and the screen reader's text: the row is one link, and a button inside a link is not allowed (nor would a tap stay on it).
 */
function ClaudeQuota({ claude }: { claude: NonNullable<RowMeta['claude']> }) {
  const m: QuotaMeter = claude.meter;
  return (
    <span data-row-claude="" title={m.title} className="inline-flex items-center gap-1">
      {m.kind !== 'no_limits' && (
        <span
          aria-hidden="true"
          data-quota-bar={m.kind === 'plan' ? m.tone : 'unavailable'}
          className="relative h-1 w-7 shrink-0 overflow-hidden rounded-full bg-line"
        >
          {m.kind === 'plan' && <span className={cn('absolute inset-y-0 left-0 rounded-full', BAR[m.tone])} style={{ width: `${barWidth(m.usedPct)}%` }} />}
        </span>
      )}
      {m.kind === 'plan' && (
        <span aria-hidden="true" className={cn('shrink-0 tabular-nums', PCT[m.tone])}>
          {Math.round(m.usedPct)}%
        </span>
      )}
      {claude.name && (
        <span aria-hidden="true" className="max-w-16 min-w-0 truncate">
          {claude.name}
        </span>
      )}
      <span className="sr-only">{m.title}</span>
    </span>
  );
}

/** Bypass as a red shield dot on the icon's corner. */
const BYPASS_DOT = (
  <span className="flex size-4 items-center justify-center rounded-full bg-danger text-white ring-2 ring-surface">
    <ShieldAlert className="size-2.5" aria-hidden="true" />
  </span>
);

/**
 * One session in the list (T-375): two lines at 390 px, a third only when it carries something.
 *   (o) Konfersi: migration              [crew 3]   2m  ⋯
 *       ● Working · Opus 5.5 · ▬▬── 62% satria · ≈ $10.39
 * The icon is the state's ring (amber needs you, accent working, a line otherwise) around the session's kind (a role, asleep, removed, a
 * chat), or the persona's avatar when the rows on screen have more than one persona; Bypass is a red shield dot on its corner (a tip says
 * it; the word too from 640 px). Line one: the title, the pin, the role (an icon on a phone, hidden when the title already starts with it),
 * the crew count, the time. Line two (muted, one line, cut on the right): the state, the model (its id and effort in the tip), the Claude and
 * its quota bar, the cost, the workspace only when the card's rows span several, the branch and ticket. Line three: only what it waits on
 * (amber). The folder lives on the session page. Selecting turns the row into a checkbox. Grouped by
 * Claude, a chat that moved is also listed, lighter, under the Claudes it ran on earlier: the same chat. A removed workspace is stated
 * plainly.
 *
 * Crew (T-294, crew.ts): a lead's row counts what it started (an icon and a number; the words in the tip); its workers sit under it on a
 * rail, the live ones in spawn order, the done ones behind one "N done" row; a worker shows its Claude and bar only when it differs from its
 * lead's (`lead`). A worker whose lead is not among the rows sits under a lead
 * header (T-369, `row.context`: the lead as muted context, a tap opens it); in a chip, a lead that matches with workers under it shows as
 * the same header (`row.header`), so its flip in and out of the chip moves nothing; one whose lead is archived links to it ("from …").
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
  facts = NO_FACTS,
  lead = null,
}: {
  row: ListRow;
  depth?: number;
  /** The lead this row sits under (its row or header is right above): a worker on the same Claude does not repeat it. */
  lead?: ChatSession | null;
  groupBy: ListGroupBy;
  selecting: boolean;
  selected: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onCollapse: (id: string) => void;
  actions: RowActions;
  /** Each workspace's persona (I11), by workspace id: its avatar stands in for the chat icon when `facts.showAvatars`. */
  personas?: Readonly<Record<string, PersonaIdentity>> | null;
  facts?: RowFacts;
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
  const asks = s.waiting > 0 || s.state === 'waiting';
  const persona = facts.showAvatars && !row.workspaceGone ? (personas?.[s.workspaceId] ?? null) : null;
  const bypass = s.mode === 'bypassPermissions' && s.state !== 'ended';
  const role = roleShown(s);
  const state = rowState(s, row.workspaceGone, safety?.label ?? null);
  const meta = rowMeta({ session: s, groupBy, showWorkspace: facts.showWorkspace, usage: facts.usage?.get(s.claudeId) ?? null, nowMs: facts.nowMs, lead });
  const third = thirdLine(meta);

  const branch = meta.branch && (
    <span title={meta.branch.title} className="inline-flex min-w-0 items-center gap-1 font-mono">
      <GitBranch className="size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{meta.branch.label}</span>
    </span>
  );
  const ticket = meta.ticket && (
    <span className="inline-flex shrink-0 items-center gap-1">
      <Ticket className="size-3" aria-hidden="true" />
      {meta.ticket}
    </span>
  );
  // Line two: one line, the facts in this order; what does not fit is cut on the right. Only the workspace and the branch give up room
  // (they truncate); the Claude's name is capped and its bar never shrinks (a shrinking item let the bar paint over the cost).
  const facts2: { key: string; node: React.ReactNode; shrinks?: boolean }[] = [{ key: 'state', node: <StateWord state={state} /> }];
  if (meta.model)
    facts2.push({
      key: 'model',
      node: (
        <span data-row-model="" title={meta.model.title}>
          {meta.model.label}
        </span>
      ),
    });
  if (meta.claude) facts2.push({ key: 'claude', node: <ClaudeQuota claude={meta.claude} /> });
  // T-343: a running turn's cost is an estimate (≈) until its result; a model without a price adds nothing (unavailable, never a guess).
  if (meta.cost)
    facts2.push({ key: 'cost', node: <span className="tabular-nums">{meta.cost.estimate ? `≈ ${formatUsd(meta.cost.usd)}` : formatUsd(meta.cost.usd)}</span> });
  if (meta.workspace)
    facts2.push({
      key: 'ws',
      shrinks: true,
      node: (
        <span title={meta.workspace.title} className={cn('min-w-0 truncate font-mono', row.workspaceGone && 'line-through')}>
          {meta.workspace.label}
        </span>
      ),
    });
  if (branch) facts2.push({ key: 'wt', shrinks: true, node: branch });
  if (ticket) facts2.push({ key: 'ticket', node: ticket });

  const icon = depth > 0 ? 'size-8' : 'size-10';
  const glyph = depth > 0 ? 'size-4' : 'size-[18px]';

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
    enabled: !selecting && !row.header,
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
      groupBy={groupBy}
      selecting={selecting}
      selected={selected}
      collapsed={collapsed}
      onToggle={onToggle}
      onCollapse={onCollapse}
      actions={actions}
      personas={personas}
      facts={facts}
      lead={s}
    />
  );

  // A lead header shows its workers always (it has no fold of its own); a lead's row, until it is folded.
  const crewShown = row.children.length > 0 && (row.header || open);
  const crewList = crewShown && (
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
  );

  // T-369: a lead header. The lead of workers shown here while it is not (it does not match the chip or the search, or sits under another
  // heading): one muted line, its title, state, crew count and Claude, a tap opens it. Context, not a match: no checkbox, swipe or ⋯. In a
  // chip, a lead that matches with workers under it keeps this same line (its state badge says Working), so the flip moves nothing (QA A9);
  // being a match, it takes a checkbox while selecting (no taller: the line is 44 px on a phone, 36 px from 640 px).
  if (row.header)
    return (
      <li data-lead-header="">
        <div className="flex items-center rounded-[inherit] bg-surface-2/60">
          {selecting && !row.context && (
            <button
              type="button"
              role="checkbox"
              aria-checked={picked}
              aria-label={`Select ${title}`}
              onClick={() => onToggle(s.id)}
              className={cn(
                'press ml-4 flex size-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors sm:ml-5',
                picked ? 'border-primary bg-primary text-primary-ink' : 'border-line-strong bg-surface',
              )}
            >
              {picked && <Check className="size-4" strokeWidth={3} />}
            </button>
          )}
          <Link
            to={`/admin/sessions/${s.id}`}
            data-crew-header={s.id}
            title={title}
            onClick={(e) => (row.context ? selecting && e.preventDefault() : click(e))}
            className="press flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-[inherit] py-1.5 pr-4 pl-4 text-[13px] text-muted hover:text-ink sm:min-h-9 sm:pl-5"
          >
            <span className="sr-only">Lead: </span>
            <span data-header-title="" className="min-w-0 flex-1 truncate font-semibold text-ink-soft">
              {title}
            </span>
            {safety ? <Badge tone="danger">{safety.label}</Badge> : asks ? <Badge tone="warning">Needs you</Badge> : <StateBadge state={s.state} agents={s.agentsRunning ?? 0} />}
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
            {s.claudeName && groupBy !== 'claude' && <span className="max-w-[30%] min-w-0 shrink truncate">{s.claudeName}</span>}
          </Link>
        </div>
        {crewList}
      </li>
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
        {bypass && (
          // The Bypass dot sits on the icon's corner, outside the row's link (a button inside a link is not allowed): a zero-width anchor at
          // the link's start (its negative margin takes back the gap), the tip placed from it. Selecting, the dot is only a mark.
          <span data-row-bypass="" className="relative -mr-2.5 w-0 shrink-0 self-start">
            <span className={cn('absolute -top-[7px] z-10', depth > 0 ? 'left-[15px]' : 'left-[23px]')}>
              {selecting ? (
                <span className="flex size-6 items-center justify-center" role="img" aria-label="Bypass">
                  {BYPASS_DOT}
                </span>
              ) : (
                <InfoTip label="Bypass" icon={BYPASS_DOT}>
                  Bypass: this session runs every tool without asking you first.
                </InfoTip>
              )}
            </span>
          </span>
        )}
        <Link to={`/admin/sessions/${s.id}`} onClick={click} className="flex min-w-0 flex-1 items-start gap-3">
          <span
            data-row-icon=""
            className={cn(
              'flex shrink-0 items-center justify-center rounded-full',
              icon,
              asks ? 'ring-2 ring-amber-500/60' : active ? 'ring-2 ring-accent/60' : 'ring-1 ring-line',
              row.workspaceGone && 'opacity-60',
            )}
          >
            {persona ? (
              // The persona's avatar, only when the rows on screen have several personas (rowMeta.avatarsShown).
              <PersonaAvatar name={persona.name} avatar={persona.avatar} size={depth > 0 ? 'sm' : 'md'} />
            ) : (
              <span
                className={cn(
                  'flex size-full items-center justify-center rounded-full',
                  asks ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' : active ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-soft',
                )}
              >
                {row.workspaceGone ? (
                  <CloudOff className={glyph} aria-hidden="true" />
                ) : s.process === 'asleep' && s.state === 'idle' ? (
                  <Moon className={glyph} aria-hidden="true" />
                ) : s.agent ? (
                  <IdCard className={glyph} aria-hidden="true" />
                ) : (
                  <MessageSquare className={glyph} aria-hidden="true" />
                )}
              </span>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <p className="min-w-0 truncate font-semibold">{title}</p>
              {s.pinnedAt && <Pin className="size-3.5 shrink-0 text-muted" aria-label="Pinned" />}
              {role && <RoleBadge session={s} iconOnPhone />}
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
              {bypass && (
                <span aria-hidden="true" className="hidden shrink-0 sm:inline-flex">
                  <Badge tone="danger">Bypass</Badge>
                </span>
              )}
              <span data-row-time="" className="ml-auto shrink-0 pl-1 text-[12.5px] text-muted tabular-nums" title={formatDateTime(s.lastActivityAt)}>
                {timeShort(s.lastActivityAt)}
              </span>
            </div>
            <p data-row-meta="" className="mt-0.5 flex min-w-0 items-center gap-1 overflow-hidden text-[12.5px] whitespace-nowrap text-muted">
              {facts2.map((f, i) => (
                <span key={f.key} className={cn('flex items-center gap-1', f.shrinks ? 'min-w-0' : 'shrink-0')}>
                  {i > 0 && <span aria-hidden="true">·</span>}
                  {f.node}
                </span>
              ))}
            </p>
            {third === 'waiting' && (
              <p data-row-third="waiting" className="mt-0.5 truncate text-[12.5px] font-medium text-amber-700 dark:text-amber-400">
                {meta.waitingFor}
              </p>
            )}
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
            className={cn(
              'press -mt-2 -mb-2 flex min-h-11 min-w-0 basis-full items-center gap-1 text-[12.5px] text-muted hover:text-ink sm:-mt-1 sm:-mb-1 sm:min-h-8',
              depth > 0 ? 'pl-11' : 'pl-[52px]',
            )}
          >
            <CornerLeftUp className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">from {from.title}</span>
          </Link>
        )}
      </div>
      </div>
      {crewList}
    </li>
  );
}
