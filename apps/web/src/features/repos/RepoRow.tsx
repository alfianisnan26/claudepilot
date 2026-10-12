import { Badge, cn } from '@isnanme/ui';
import type { RepoNode } from '@portal/contracts';
import { ChevronDown, MessageSquare, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { InfoTip } from '@/components/InfoTip';
import { Clamp, TIP_ID, tipProps } from './clamp';
import { branchLabel, chipsOf, homePath, KIND_WORD, type Chip, type TreeRow } from './labels';
import { RowMenu, type RowMenuItem } from './RowMenu';

/** One level of the tree, in the design system's spacing unit (4 px each): 16 px. */
const STEP = 4;
const unit = (n: number) => `calc(var(--spacing) * ${n})`;

export function RepoChip({ chip }: { chip: Chip }) {
  return (
    <span title={chip.title}>
      <Badge tone={chip.tone} className="tabular-nums">
        {chip.label}
      </Badge>
    </span>
  );
}

/**
 * A repo's status, in a row of its own that never grows: the first `max` chips (the worst first), then `+N`, which opens the rest
 * with what each one means (on a phone nothing else shows a chip's meaning). The row is as tall with one chip as with six.
 */
export function ChipList({ chips, max }: { chips: Chip[]; max: number }) {
  if (chips.length === 0) return null;
  const hidden = chips.slice(max);
  return (
    <span className="flex shrink-0 items-center gap-1">
      {chips.slice(0, max).map((c) => (
        <RepoChip key={c.key} chip={c} />
      ))}
      {hidden.length > 0 && (
        <InfoTip label={`${hidden.length} more ${hidden.length === 1 ? 'status' : 'statuses'}`} text={`+${hidden.length}`}>
          {hidden.map((c) => (
            <span key={c.key} className="block">
              <span className="font-semibold text-ink">{c.label}</span> {c.title}
            </span>
          ))}
        </InfoTip>
      )}
    </span>
  );
}

/** The quiet marks beside a name: a session runs here (green while it is alive), the worktree is kept synced (red when its last sync failed). */
export function RepoMarks({ node: n }: { node: RepoNode }) {
  const sessions = n.sessions.length;
  const live = n.sessions.some((s) => s.live);
  const failed = n.sync?.enabled && (n.sync.outcome === 'failed' || n.sync.outcome === 'refused');
  return (
    <>
      {sessions > 0 && (
        <span title={`${sessions} ${sessions === 1 ? 'session' : 'sessions'} here`} className={cn('inline-flex shrink-0 items-center gap-0.5 text-[12.5px] font-semibold tabular-nums', live ? 'text-accent' : 'text-muted')}>
          <MessageSquare className="size-3" aria-hidden="true" />
          {sessions}
        </span>
      )}
      {n.sync?.enabled && (
        <span title={failed ? `Keep synced: ${n.sync.note ?? n.sync.outcome}` : 'Kept synced'} className={cn('inline-flex shrink-0', failed ? 'text-danger' : 'text-accent')}>
          <RefreshCw className="size-3" aria-hidden="true" />
        </span>
      )}
    </>
  );
}

/** What a screen reader says for a repo's button: the name and branch, and the marks the text layer shows only as icons. */
function readAs(n: RepoNode, branch: string | null): string {
  const sessions = n.sessions.length;
  return [n.name, branch, sessions > 0 && `${sessions} ${sessions === 1 ? 'session' : 'sessions'} here`, n.sync?.enabled && 'kept synced', n.kind !== 'repo' && KIND_WORD[n.kind]].filter(Boolean).join(', ');
}

/**
 * One repo as a row of the same height whatever it holds (56 px): its name over its branch, each one line cut with an ellipsis
 * (the whole text shows in a tooltip when it is cut), and at the right its chips, a few and `+N`. The text layer is only to look at
 * (hidden from a screen reader, which gets the button's own label); the button under it is the whole left part of the row, so a
 * tap anywhere there opens the repo and the chips and ⋯ beside it keep their own jobs. `maxChips`: how many chips show before `+N`
 * (fewer on a phone). `children` are the controls after the chips.
 */
export function RepoItem({ node: n, depth = 0, quiet, maxChips, onOpen, children }: { node: RepoNode; depth?: number; quiet?: boolean; maxChips: number; onOpen: () => void; children?: ReactNode }) {
  const chips = chipsOf(n);
  const branch = branchLabel(n);
  const missing = n.kind === 'missing';
  return (
    <li className="relative" data-clamp-owner="" onPointerEnter={tipProps.onPointerEnter} onPointerLeave={tipProps.onPointerLeave}>
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} aria-hidden="true" className="absolute inset-y-0 w-px bg-line" style={{ left: unit(2 + i * STEP) }} />
      ))}
      <div className="flex h-14 items-center rounded-xl hover:bg-surface-2" style={{ paddingLeft: unit(depth * STEP) }}>
        <div className="relative h-full min-w-0 flex-1">
          <button
            type="button"
            onClick={onOpen}
            onFocus={tipProps.onFocus}
            onBlur={tipProps.onBlur}
            aria-label={readAs(n, branch)}
            aria-describedby={TIP_ID}
            title={`${n.kind === 'repo' ? '' : `${KIND_WORD[n.kind]} · `}${homePath(n.path)}`}
            className="absolute inset-0 rounded-xl"
          />
          <div aria-hidden="true" className="pointer-events-none relative flex h-full min-w-0 flex-col justify-center px-2">
            <span className="flex min-w-0 items-center gap-2">
              <Clamp className={cn('text-[15px]', quiet || missing ? 'font-medium text-muted' : 'font-semibold')}>{n.name}</Clamp>
              <RepoMarks node={n} />
            </span>
            {branch && <Clamp className="font-mono text-[12.5px] text-muted">{branch}</Clamp>}
          </div>
        </div>
        <ChipList chips={chips} max={maxChips} />
        {children}
      </div>
    </li>
  );
}

/**
 * A repo in the tree: the row, indented by its depth with a guide line for each level; a parent with children has a chevron, beside
 * the ⋯, that folds them. The ⋯ has Scan, New worktree, Sync and, for a worktree, Keep synced and Remove. A row that is only listed
 * for the sake of what is below it (a filter) is quieter: its name is muted, nothing is faded.
 */
export function RepoRow({ row, busy, items, maxChips, onOpen, onFold }: { row: TreeRow; busy: boolean; items: RowMenuItem[]; maxChips: number; onOpen: () => void; onFold: () => void }) {
  const n = row.node;
  return (
    <RepoItem node={n} depth={n.depth} quiet={row.context} maxChips={maxChips} onOpen={onOpen}>
      {row.folds && (
        <button
          type="button"
          aria-expanded={!row.folded}
          aria-label={`${row.folded ? 'Show' : 'Hide'} what is under ${n.name}`}
          onClick={onFold}
          className="press flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
        >
          <ChevronDown className={cn('size-[18px] transition-transform duration-150', row.folded && '-rotate-90')} />
        </button>
      )}
      {items.length > 0 ? <RowMenu label={`Actions for ${n.name}`} items={items} busy={busy} /> : <span className="size-11 shrink-0" />}
    </RepoItem>
  );
}
