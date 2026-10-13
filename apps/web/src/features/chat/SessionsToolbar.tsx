import { cn } from '@isnanme/ui';
import { LIST_GROUP_BYS, type ListFilter, type ListGroupBy } from '@portal/contracts';
import { Archive, CircleAlert, CircleStop, Layers, ListChecks, LoaderCircle, Moon, Pin, Rows3, Search, X } from 'lucide-react';
import { STATUS_TITLE, visibleChips, type ChipCounts } from './listOrder';

export interface ViewState {
  groupBy: ListGroupBy;
  filter: ListFilter;
  query: string;
  /** Show the archived sessions instead of the open ones. */
  archived: boolean;
}

const GROUP_LABEL: Record<ListGroupBy, string> = {
  none: 'No grouping',
  workspace: 'Workspace',
  claude: 'Claude',
  worktree: 'Worktree',
  ticket: 'Ticket',
};

/** The chips' names and icons; their order and which show is `listOrder.ts`'s (T-100: what needs attention first, All last). */
const CHIP: Record<ListFilter | 'archived', { label: string; icon: React.ReactNode }> = {
  attention: { label: STATUS_TITLE.attention, icon: <CircleAlert className="size-4" aria-hidden="true" /> },
  working: { label: STATUS_TITLE.working, icon: <LoaderCircle className="size-4" aria-hidden="true" /> },
  idle: { label: STATUS_TITLE.idle, icon: <Moon className="size-4" aria-hidden="true" /> },
  pinned: { label: STATUS_TITLE.pinned, icon: <Pin className="size-4" aria-hidden="true" /> },
  ended: { label: STATUS_TITLE.ended, icon: <CircleStop className="size-4" aria-hidden="true" /> },
  archived: { label: 'Archived', icon: <Archive className="size-4" aria-hidden="true" /> },
  all: { label: 'All', icon: <Layers className="size-4" aria-hidden="true" /> },
};

/**
 * Search, filters and grouping for the Sessions list. The search matches title, workspace, Claude,
 * folder, branch, ticket and state; the chips filter by what needs you, is in progress, idle, pinned or ended (with counts, each
 * only when it has sessions; All last); Archived is a list of its own. Select turns the rows into checkboxes for bulk End, Archive
 * and Delete. Phones get the chips as a row that scrolls sideways, so nothing wraps into a tall block, and icon only (with the count)
 * except the chip you are on, which says its name (the text diet); every chip is a 44 px target there.
 */
export function SessionsToolbar({
  view,
  counts,
  onChange,
  selecting,
  onSelect,
}: {
  view: ViewState;
  counts: ChipCounts;
  onChange: (next: Partial<ViewState>) => void;
  selecting: boolean;
  onSelect: () => void;
}) {
  const active = (id: ListFilter | 'archived') => (id === 'archived' ? view.archived : !view.archived && view.filter === id);
  return (
    <div className="mb-4 flex flex-col gap-2.5">
      <div className="flex gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search sessions</span>
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            type="search"
            value={view.query}
            onChange={(e) => onChange({ query: e.target.value })}
            placeholder="Search title, workspace, branch…"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="h-11 w-full rounded-full border border-line bg-surface pr-10 pl-10 text-[16px] text-ink placeholder:text-muted focus:border-primary focus:outline-none sm:text-[15px] [&::-webkit-search-cancel-button]:hidden"
          />
          {view.query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onChange({ query: '' })}
              className="press absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
            >
              <X className="size-4" />
            </button>
          )}
        </label>
        {/* Icon only (the text diet): the native picker opens from it, it is named "Group by", and it lights up while a grouping is on. */}
        <label
          title={`Group by: ${GROUP_LABEL[view.groupBy]}`}
          className={cn(
            'press relative flex size-11 shrink-0 items-center justify-center rounded-full border focus-within:ring-2 focus-within:ring-primary/40',
            view.groupBy === 'none' ? 'border-line bg-surface text-muted hover:text-ink' : 'border-primary bg-primary text-primary-ink',
          )}
        >
          <Rows3 className="size-[18px]" aria-hidden="true" />
          <select
            aria-label="Group by"
            value={view.groupBy}
            onChange={(e) => onChange({ groupBy: e.target.value as ListGroupBy })}
            className="absolute inset-0 size-full cursor-pointer appearance-none rounded-full opacity-0"
          >
            {LIST_GROUP_BYS.map((g) => (
              <option key={g} value={g}>
                {GROUP_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
        {visibleChips(counts, view.archived ? 'archived' : view.filter).map((id) => {
          const c = CHIP[id];
          const on = active(id);
          return (
            <button
              key={id}
              type="button"
              data-chip={id}
              aria-pressed={on}
              aria-label={`${c.label} ${counts[id]}`}
              title={c.label}
              onClick={() => onChange(id === 'archived' ? { archived: !view.archived, filter: 'all' } : { archived: false, filter: id })}
              className={cn(
                'press inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full border px-3 text-[13.5px] font-semibold transition-colors sm:h-9 sm:min-w-0 sm:px-3.5',
                on ? 'border-primary bg-primary text-primary-ink' : 'border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink',
              )}
            >
              {c.icon}
              <span className={cn(!on && 'max-sm:sr-only')}>{c.label}</span>
              <span className={cn('tabular-nums', on ? 'text-primary-ink/70' : 'text-muted')}>{counts[id]}</span>
            </button>
          );
        })}
        {!selecting && (
          <button
            type="button"
            onClick={onSelect}
            aria-label="Select"
            title="Select"
            className="press ml-auto inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-[13.5px] font-semibold text-muted hover:bg-surface-2 hover:text-ink sm:h-9"
          >
            <ListChecks className="size-4" aria-hidden="true" /> <span className="max-sm:sr-only">Select</span>
          </button>
        )}
      </div>
    </div>
  );
}
