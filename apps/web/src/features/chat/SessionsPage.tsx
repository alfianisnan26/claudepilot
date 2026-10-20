import { Badge, Button, cn, ConfirmDialog, EmptyState, LoadError, RowsSkeleton, useToast } from '@isnanme/ui';
import {
  buildListView,
  LIST_GROUP_BYS,
  workspaceLabel,
  type ChatSession,
  type ListGroup,
  type ListGroupBy,
  type ListRow,
} from '@portal/contracts';
import { ChevronDown, CircleAlert, Plus, MessagesSquare } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { GlanceStrip } from '@/features/glance/Strip';
import { usePersonaIdentities } from '@/features/personas/identities';
import { useClaudeUsage, useNow } from '@/features/usage/claude/useClaudeUsage';
import { errorText } from '@/lib/api';
import { chatApi } from './api';
import { BulkBar, runBulk, type BulkAction } from './BulkBar';
import { crewStatusGroup, selectable } from './crew';
import { AgentTreeView } from './AgentTree';
import { canFold, chipCounts, ofProgram, programCounts, withChange, withDefaultChip, type ChipChoice } from './listOrder';
import { NewSessionDialog } from './NewSessionDialog';
import { ArchiveSessionDialog, DeleteSessionDialog, EndSessionDialog, RenameSessionDialog } from './SessionDialogs';
import { avatarsShown, listFacts, workspaceShown } from './rowMeta';
import { SessionRow, type RowActions, type RowFacts } from './SessionRow';
import { SessionsToolbar, type ViewState } from './SessionsToolbar';
import { useMoveChat } from './SwitchDialog';
import { useChatList } from './useChatSocket';
import { useWorkspaceFacts } from './useWorkspaceFacts';

/** Archiving a session that's working or waiting on you stops it, so that asks first (like End, FR4). */
const isBusy = (s: ChatSession) => s.state === 'working' || s.state === 'waiting';

const VIEW_KEY = 'claudepilot.sessions-view';
function savedView(): Pick<ViewState, 'groupBy'> & { tree: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as { groupBy?: unknown; tree?: unknown };
    return { groupBy: LIST_GROUP_BYS.includes(raw.groupBy as ListGroupBy) ? (raw.groupBy as ListGroupBy) : 'none', tree: raw.tree === true };
  } catch {
    return { groupBy: 'none', tree: false };
  }
}
function saveView(v: { groupBy: ListGroupBy; tree: boolean }) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v));
  } catch {
    // private window: just not remembered
  }
}

/**
 * The sessions across workspaces (chat PRD FR2): what needs you on top, then everything else grouped as
 * you choose (workspace, Claude, worktree, ticket), searched and filtered, sessions under the one that
 * started them, and bulk End, Archive and Delete (always confirmed). A session left behind by a move
 * stays on its Claude with Open and Move again (Workspace Claudes FR17); one whose workspace was removed
 * says so and can only be read or deleted.
 */
export function SessionsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { sessions, failed, reload, hasMore, loadingMore, loadMore } = useChatList();
  const { factOf, loaded: workspacesLoaded } = useWorkspaceFacts();
  const personas = usePersonaIdentities();
  const [creating, setCreating] = useState(false);
  // `?new=1` opens the New session dialog (the app's "New session" shortcut and the glance Shortcuts widget link to it).
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get('new') !== '1') return;
    setCreating(true);
    const next = new URLSearchParams(params);
    next.delete('new');
    setParams(next, { replace: true });
  }, [params, setParams]);
  // The program filter (T-259 slice 3) narrows everything below it: the chips' counts and the list.
  const [program, setProgram] = useState<string | null>(null);
  const programs = useMemo(() => programCounts(sessions ?? []), [sessions]);
  const shown = useMemo(() => (sessions ? ofProgram(sessions, program) : null), [sessions, program]);
  // Counts for the filter chips, over what's open (never changed by the search).
  const counts = useMemo(() => chipCounts(shown ?? []), [shown]);
  // The chip opens on the first one with sessions in the order of attention (T-100: Needs you, In progress, Idle, Pinned, Ended, else All); once
  // the sessions are known, and only until the person picks one (the pick is in the same state, so a pending default never undoes it: T-321).
  // T-1710: the Tree view (leads and their workers as connected cards), remembered with the grouping.
  const [tree, setTree] = useState(() => savedView().tree);
  const [baseView, setView] = useState<Omit<ViewState, 'program'> & ChipChoice>(() => ({
    groupBy: savedView().groupBy,
    filter: 'attention',
    query: '',
    archived: false,
    picked: false,
  }));
  const view: ViewState = useMemo(() => ({ ...baseView, program }), [baseView, program]);
  useEffect(() => {
    if (sessions) setView((v) => withDefaultChip(v, counts));
  }, [sessions, counts]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [ending, setEnding] = useState<ChatSession | null>(null);
  const [archiving, setArchiving] = useState<ChatSession | null>(null);
  const [renaming, setRenaming] = useState<ChatSession | null>(null);
  const [deleting, setDeleting] = useState<ChatSession | null>(null);
  const move = useMoveChat();
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  const [busy, setBusy] = useState(false);

  const change = ({ program: nextProgram, ...next }: Partial<ViewState>) => {
    if (nextProgram !== undefined) setProgram(nextProgram);
    setView((v) => {
      const merged = withChange(v, next);
      saveView({ groupBy: merged.groupBy, tree });
      return merged;
    });
  };
  const changeTree = (on: boolean) => {
    setTree(on);
    if (on) stopSelecting();
    saveView({ groupBy: baseView.groupBy, tree: on });
  };

  // All without another grouping is grouped under the status headings, in the chips' order (T-100); a worker that does not need you sits
  // under its lead's heading, nested under it (T-294, crew.ts). A chip lists what matches it; a worker whose lead does not match sits
  // under a lead header, which is context, not a match (T-369, crew.ts).
  const byStatus = !view.archived && view.filter === 'all' && view.groupBy === 'none';
  const list = useMemo(
    () =>
      shown
        ? buildListView(shown, {
            groupBy: view.groupBy,
            filter: view.filter,
            query: view.query,
            archived: view.archived,
            workspaces: workspacesLoaded ? factOf : undefined,
            groupOf: byStatus ? crewStatusGroup(shown, view.query) : undefined,
          })
        : null,
    [shown, view, factOf, workspacesLoaded, byStatus],
  );

  const toggle = useCallback(
    (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set(s).add(id))),
    [],
  );
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const flip = (set: ReadonlySet<string>, id: string): ReadonlySet<string> =>
    set.has(id) ? new Set([...set].filter((x) => x !== id)) : new Set(set).add(id);

  const archive = async (s: ChatSession) => {
    setBusy(true);
    try {
      await chatApi.archive(s.id);
      toast('Archived');
      setArchiving(null);
      await reload();
    } catch (e) {
      toast(errorText(e, 'Could not archive it.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const unarchive = async (s: ChatSession) => {
    try {
      await chatApi.unarchive(s.id);
      toast('Back in Agents');
      await reload();
    } catch (e) {
      toast(errorText(e, 'Could not unarchive it.'), 'error');
    }
  };

  const togglePin = async (s: ChatSession) => {
    try {
      if (s.pinnedAt) await chatApi.unpin(s.id);
      else await chatApi.pin(s.id);
      toast(s.pinnedAt ? 'Unpinned' : 'Pinned');
      await reload();
    } catch (e) {
      toast(errorText(e, 'Could not change the pin.'), 'error');
    }
  };

  const actions: RowActions = {
    pin: (s) => void togglePin(s),
    rename: setRenaming,
    end: setEnding,
    archive: (s) => (isBusy(s) || s.worktree ? setArchiving(s) : void archive(s)),
    unarchive: (s) => void unarchive(s),
    remove: setDeleting,
    move: move.start,
    select: (s) => {
      setSelecting(true);
      setSelected(new Set([s.id]));
    },
  };

  // T-375: what the rows on screen have in common (one workspace, one persona: then no row says it) and the Claudes' quota (the shared
  // claude-usage snapshot the top bar reads; no request of its own), read at a minute's clock so a passed reset turns a bar grey.
  const { report: usage } = useClaudeUsage();
  const nowMs = useNow(60_000);
  const usageById = useMemo(() => (usage ? new Map(usage.claudes.map((c) => [c.claudeId, c])) : null), [usage]);
  // The workspace goes by each card's own rows (one workspace on every row of a card tells nothing apart, T-378's density check); the
  // avatars by the rows on screen.
  const factsByGroup: ReadonlyMap<string, RowFacts> = useMemo(() => {
    const groups = list ? list.groups : [];
    const showAvatars = avatarsShown(
      listFacts(
        groups.flatMap((g) => g.rows),
        personas,
      ),
    );
    return new Map(
      groups.map((g) => [
        g.key,
        { showWorkspace: workspaceShown(listFacts(g.rows, personas), view.groupBy), showAvatars, usage: usageById, nowMs },
      ]),
    );
  }, [list, personas, view.groupBy, usageById, nowMs]);

  const byId = useMemo(() => new Map((sessions ?? []).map((s) => [s.id, s])), [sessions]);
  const chosen = [...selected].map((id) => byId.get(id)).filter((s): s is ChatSession => !!s);
  // Select all takes the sessions shown, never a lead header (T-369).
  const allShown = list ? list.groups.flatMap((g) => selectable(g.rows)) : [];

  const runSelected = async () => {
    if (!bulk) return;
    setBusy(true);
    const targets = chosen.filter((s) => (bulk === 'end' ? s.state !== 'ended' : bulk === 'archive' ? !s.archivedAt : true));
    const call = bulk === 'end' ? chatApi.end : bulk === 'archive' ? chatApi.archive : chatApi.remove;
    const result = await runBulk(targets, (s) => call(s.id));
    setBusy(false);
    setBulk(null);
    const verb = bulk === 'end' ? 'Ended' : bulk === 'archive' ? 'Archived' : 'Deleted';
    if (result.failed.length === 0) toast(`${verb} ${result.ok} ${result.ok === 1 ? 'agent' : 'agents'}`);
    else
      toast(
        `${verb} ${result.ok}; ${result.failed.length} failed: ${errorText(result.failed[0]!.error, 'Something went wrong.')}`,
        'error',
      );
    stopSelecting();
    await reload();
  };

  return (
    <>
      <PageHeader
        title="Agents"
        description="Chat with the Claude Code agents in your workspaces."
        action={
          sessions &&
          sessions.length > 0 && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              <span className="hidden sm:inline">New agent</span>
              <span className="sm:hidden">New</span>
            </Button>
          )
        }
      />

      <GlanceStrip placement="list" labelled className="-mt-3 mb-4 flex-wrap" />

      {failed && !sessions && <LoadError onRetry={reload} />}
      {!sessions && !failed && <RowsSkeleton rows={3} lines={1} trailing icon="rounded-2xl" />}

      {sessions && sessions.length > 0 && (
        <SessionsToolbar
          view={view}
          counts={counts}
          programs={programs}
          onChange={change}
          selecting={selecting}
          onSelect={() => setSelecting(true)}
          tree={tree}
          onTree={changeTree}
        />
      )}

      {tree && sessions && sessions.length > 0 && <AgentTreeView sessions={sessions} query={view.query} onChanged={() => void reload()} />}

      {/* What waits on you, on top of the other chips' lists (All has it as its first heading, Needs you is it). */}
      {list &&
        sessions &&
        sessions.length > 0 &&
        !tree &&
        !view.archived &&
        view.filter !== 'attention' &&
        !byStatus &&
        list.attention.length > 0 && <Queue rows={list.attention} />}

      {list &&
        sessions &&
        !(tree && sessions.length > 0) &&
        (sessions.length === 0 ? (
          <EmptyState
            icon={<MessagesSquare className="size-6" />}
            title="No agents yet"
            action={
              <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                New session
              </Button>
            }
          >
            Start an agent to chat with Claude Code in one of your running workspaces.
          </EmptyState>
        ) : list.shown === 0 ? (
          <EmptyState icon={<MessagesSquare className="size-6" />} title={view.archived ? 'Nothing archived' : 'No agents match'}>
            {view.archived ? 'Archived agents end and wait here, with their transcripts.' : 'Nothing fits this search and filter.'}{' '}
            {(view.query || view.filter !== 'all' || view.archived || view.program) && (
              <button
                type="button"
                className="font-semibold text-ink underline underline-offset-2"
                onClick={() => change({ query: '', filter: 'all', archived: false, program: null })}
              >
                Show everything
              </button>
            )}
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-4">
            {list.groups.map((g) => (
              <Group
                key={g.key || 'all'}
                group={g}
                grouped={view.groupBy !== 'none' || byStatus}
                status={byStatus}
                folded={folded.has(g.key) && (!byStatus || canFold(g.key))}
                onFold={!byStatus || canFold(g.key) ? () => setFolded((f) => flip(f, g.key)) : undefined}
              >
                {g.rows.map((r) => (
                  <SessionRow
                    key={r.session.id}
                    row={r}
                    groupBy={view.groupBy}
                    selecting={selecting}
                    selected={selected}
                    collapsed={collapsed}
                    onToggle={toggle}
                    onCollapse={(id) => setCollapsed((c) => flip(c, id))}
                    actions={actions}
                    personas={personas}
                    facts={factsByGroup.get(g.key)}
                  />
                ))}
              </Group>
            ))}
          </div>
        ))}

      {/* D-58: the list loads the newest page; the 5 s refresh asks for that page only. */}
      {sessions && hasMore && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
            Older
          </Button>
        </div>
      )}

      {selecting && (
        <BulkBar
          count={selected.size}
          total={allShown.length}
          onAll={() => setSelected(new Set(allShown.map((s) => s.id)))}
          onNone={() => setSelected(new Set())}
          onDone={stopSelecting}
          onAction={setBulk}
        />
      )}

      <NewSessionDialog open={creating} onClose={() => setCreating(false)} />
      <EndSessionDialog session={ending} onClose={() => setEnding(null)} onEnded={() => (toast('Agent ended'), void reload())} />
      <ArchiveSessionDialog session={archiving} onClose={() => setArchiving(null)} onArchived={() => void reload()} />
      <ConfirmDialog
        open={!!bulk}
        title={bulkTitle(bulk, chosen)}
        description={bulkText(bulk, chosen)}
        confirmLabel={bulk === 'end' ? 'End agents' : bulk === 'archive' ? 'Archive' : 'Delete'}
        loading={busy}
        onConfirm={() => void runSelected()}
        onClose={() => !busy && setBulk(null)}
      />
      <RenameSessionDialog session={renaming} onClose={() => (setRenaming(null), void reload())} />
      <DeleteSessionDialog session={deleting} onClose={() => setDeleting(null)} onDeleted={() => void reload()} />
      {move.element}
    </>
  );
}

/** What waits on you: one tap to the session, wherever the list is grouped. */
function Queue({ rows }: { rows: ListRow[] }) {
  return (
    <section aria-label="Needs you" className="mb-4 rounded-[24px] border border-amber-500/30 bg-amber-500/[0.07]">
      <h2 className="flex items-center gap-2 px-4 pt-3 pb-1 text-[13px] font-bold text-amber-800 sm:px-5 dark:text-amber-300">
        <CircleAlert className="size-4" aria-hidden="true" /> Needs you
        <Badge tone="warning">{rows.length}</Badge>
      </h2>
      <ul className="divide-y divide-amber-500/20">
        {rows.slice(0, 5).map((r) => (
          <li key={r.session.id}>
            <Link to={`/admin/sessions/${r.session.id}`} className="press flex items-center gap-3 px-4 py-2.5 sm:px-5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14.5px] font-semibold">{r.session.title || 'Untitled'}</span>
                <span className="block truncate text-[13px] text-amber-800 dark:text-amber-300">
                  {r.session.waitingFor ?? 'Waiting for your answer'}
                  <span className="text-muted"> · {workspaceLabel(r.session.workspaceId)}</span>
                </span>
              </span>
              <span className="shrink-0 text-[13px] font-semibold text-ink">Open</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A group of rows in one card. Grouped (by workspace, Claude, … or, in All, by status), it has a heading with its count that folds the group;
 * a heading without `onFold` (Needs you) never folds. The card's rows keep to its corners by their own radius (RowList), not by an overflow
 * clip, so a row's ⋯ menu can still open past the card (T-100).
 */
function Group({
  group,
  grouped,
  status,
  folded,
  onFold,
  children,
}: {
  group: ListGroup;
  grouped: boolean;
  status: boolean;
  folded: boolean;
  onFold?: () => void;
  children: React.ReactNode;
}) {
  const rows = (
    <Card>
      <RowList>{children}</RowList>
    </Card>
  );
  if (!grouped) return rows;
  const head = (
    <>
      <span data-group-title className="min-w-0 truncate text-[15px] font-bold">
        {group.title}
      </span>
      {group.subtitle && <span className="min-w-0 truncate text-[13px] text-muted">{group.subtitle}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {group.rows.length > 0 && group.rows.every((r) => r.workspaceGone) && <Badge tone="danger">Removed</Badge>}
        {!status && group.waiting > 0 && <Badge tone="warning">{group.waiting} need you</Badge>}
        <span data-group-count className="text-[12.5px] font-semibold text-muted tabular-nums">
          {group.count}
        </span>
        {onFold && <ChevronDown className={cn('size-4 text-muted transition-transform', folded && '-rotate-90')} aria-hidden="true" />}
      </span>
    </>
  );
  const headClass = 'mb-1.5 flex min-h-11 w-full items-center gap-2 rounded-xl px-1 text-left sm:min-h-9';
  return (
    <section aria-label={group.title} data-status-group={status ? group.key : undefined}>
      {onFold ? (
        <button type="button" data-group-head aria-expanded={!folded} onClick={onFold} className={cn('press', headClass)}>
          {head}
        </button>
      ) : (
        <h2 data-group-head className={headClass}>
          {head}
        </h2>
      )}
      {!folded && rows}
    </section>
  );
}

/**
 * The rows of a card. The row at the top and the row at the bottom (a nested one too: its right corner is the card's) take the card's inner
 * corners (its 24 px radius less the 1 px border) on their swipe box, and the row's background and the swipe panes inherit them, so nothing
 * square paints past the curve (T-100: each row's square background did, at rest and mid-swipe). The card itself does not clip, so a
 * row's ⋯ menu opens past it.
 */
const ROW_CORNERS =
  '[&>li:first-child>div:first-child]:rounded-t-[23px] [&>li:last-child>div:last-child]:rounded-b-[23px] [&>li:last-child_li:last-child>div:last-child]:rounded-br-[23px]';
function RowList({ children }: { children: React.ReactNode }) {
  return (
    <ul data-session-rows className={cn('divide-y divide-line', ROW_CORNERS)}>
      {children}
    </ul>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function bulkTitle(action: BulkAction | null, chosen: ChatSession[]): string {
  const n = chosen.length;
  return action === 'end'
    ? `End ${plural(n, 'agent')}?`
    : action === 'archive'
      ? `Archive ${plural(n, 'agent')}?`
      : `Delete ${plural(n, 'agent')}?`;
}

function bulkText(action: BulkAction | null, chosen: ChatSession[]): string {
  const going = chosen.filter((s) => s.state === 'working' || s.state === 'waiting').length;
  const stops = going ? ` ${plural(going, 'is', 'are')} busy and stop${going === 1 ? 's' : ''} mid-task.` : '';
  // A worktree's folder is never removed in bulk: that is asked per session, because it can hold work nobody has saved.
  const trees = chosen.filter((s) => s.worktree).length;
  const kept = trees && action !== 'end' ? ` The ${trees === 1 ? 'worktree folder stays' : `${trees} worktree folders stay`}.` : '';
  if (action === 'end') return `They stop; transcripts stay.${stops}`;
  if (action === 'archive') return `They end and move to Archived.${stops}${kept}`;
  return `Transcripts and the agents’ files in the workspaces are deleted. Can’t be undone.${stops}${kept}`;
}
