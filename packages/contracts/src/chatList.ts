// The Sessions list as a model (chat-sessions PRD FR2, FR28; Workspace Claudes FR17): sessions filtered,
// searched, grouped by workspace, Claude, worktree or ticket, ordered by what needs you, and nested under
// the session that started them. Pure functions, so the page stays thin and the rules are tested.

import { sessionCost, type ChatSession } from './chat.js';

export type ListGroupBy = 'none' | 'workspace' | 'claude' | 'worktree' | 'ticket';
export const LIST_GROUP_BYS: readonly ListGroupBy[] = ['none', 'workspace', 'claude', 'worktree', 'ticket'];

/**
 * `attention`: waiting on you, interrupted, or ended for safety. `working`: in progress. `pinned`: what the person pinned. In the chips'
 * order (T-100): what needs attention first, All last. The web's `features/chat/listOrder.ts` decides which chips show and which one opens.
 */
export type ListFilter = 'attention' | 'working' | 'idle' | 'pinned' | 'ended' | 'all';
export const LIST_FILTERS: readonly ListFilter[] = ['attention', 'working', 'idle', 'pinned', 'ended', 'all'];

/** What a session's workspace is, as far as the list needs: gone, or its status. */
export interface WorkspaceFact {
  /** The workspace no longer exists (not in a reachable target's list). */
  gone: boolean;
  /** `running`, `stopped`, … when it exists. */
  status?: string;
}

export interface Rollup {
  total: number;
  working: number;
  waiting: number;
  idle: number;
  interrupted: number;
  ended: number;
  costUsd: number;
}

export interface ListRow {
  session: ChatSession;
  /** The sessions it started that are shown under it. */
  children: ListRow[];
  /** Over everything it started, however deep (filters don't change it); null when it started nothing. */
  rollup: Rollup | null;
  /** In a Claude's group, a chat that ran on that Claude earlier and runs on another now: the same chat, opened from here too (FR17). */
  earlier: boolean;
  /** Its workspace was removed: nothing can resume it, and what it needs from the workspace is off. */
  workspaceGone: boolean;
  /** Its parent is shown elsewhere and archived, so it has no lead header here: the title to show as "from …". */
  parentTitle: string | null;
  /**
   * A lead header (T-369): the lead of sessions in this group, brought in because it is not among the group's rows (it does not match the
   * chip or the search, or sits under another heading) and is not archived. Context, not a match: it is not in the group's count, Select all
   * does not take it, it has no swipe, checkbox or ⋯. Its `children` are its workers in the group.
   */
  context: boolean;
}

export interface ListGroup {
  key: string;
  title: string;
  subtitle: string | null;
  rows: ListRow[];
  /** Sessions in the group (children included). */
  count: number;
  waiting: number;
}

export interface ListView {
  /** Everything waiting on you, most urgent first, wherever it is grouped. */
  attention: ListRow[];
  groups: ListGroup[];
  /** Sessions shown, and how many the filters left out. */
  shown: number;
  total: number;
  archived: number;
}

export interface ListOptions {
  groupBy?: ListGroupBy;
  filter?: ListFilter;
  query?: string;
  /** Show archived sessions (and only those); otherwise they're left out. */
  archived?: boolean;
  /** What is known of a workspace, by its id. */
  workspaces?: (workspaceId: string) => WorkspaceFact | undefined;
  /**
   * Groups of the caller's own (the web's status headings in All, T-100), in place of `groupBy`: each session's group and the group's
   * place in the list (lower first). Nesting, rollups and "started by" work as for any grouping.
   */
  groupOf?: (s: ChatSession) => { key: string; title: string; order: number };
}

/** Ended for a safety or integrity stop (chat PRD §6 rule 1, §10.4): something to look at. */
const endedForSafety = (s: ChatSession) => s.state === 'ended' && /^(credential|integrity): /.test(s.endedReason ?? '');

/** Whether the session needs you: a request waiting, interrupted, or ended for safety. */
export const needsYou = (s: ChatSession): boolean => s.waiting > 0 || s.state === 'waiting' || s.state === 'interrupted' || endedForSafety(s);

/** PRD FR2's order: Needs input, then Interrupted and Failed, Working, Idle, Ended. */
export function attentionTier(s: ChatSession): number {
  if (s.waiting > 0 || s.state === 'waiting') return 0;
  if (s.state === 'interrupted' || endedForSafety(s)) return 1;
  if (s.state === 'working' || s.state === 'starting') return 2;
  if (s.state === 'idle') return 3;
  return 4;
}

/** By need, then the latest activity. */
const byNeed = (a: ChatSession, b: ChatSession) => attentionTier(a) - attentionTier(b) || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);

/** Pinned first, then by need, then the latest activity. */
const byUrgency = (a: ChatSession, b: ChatSession) => Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || byNeed(a, b);

/** Done: ended, and not for a safety stop (that one needs you). */
const done = (s: ChatSession) => s.state === 'ended' && !needsYou(s);

/** The sessions nested under a row that are rows of the group (a lead header is not), however deep. */
const membersUnder = (r: ListRow): ChatSession[] => r.children.flatMap((c) => [...(c.context ? [] : [c.session]), ...membersUnder(c)]);

/**
 * The session a row is ordered by (T-369). A lead with live workers under it goes by the most urgent of them, and by itself only when it
 * needs you, so a lead that flips between Idle and Working does not move its tree, and a lead header (`context`) sits where its first
 * worker would sit. Any other row goes by itself; a header whose workers are all done, by the most urgent of them.
 */
function orderedBy(r: ListRow): ChatSession {
  const below = membersUnder(r);
  const live = below.filter((s) => !done(s));
  const pool = r.context ? (live.length ? live : below) : live.length ? (needsYou(r.session) ? [r.session, ...live] : live) : [r.session];
  return [...pool].sort(byNeed)[0] ?? r.session;
}

/** Rows (a lead header too) in a group's order: a pinned lead first, then by need and the latest activity of what each is ordered by. */
const byRow = (a: ListRow, b: ListRow) => Number(!!b.session.pinnedAt) - Number(!!a.session.pinnedAt) || byNeed(orderedBy(a), orderedBy(b));

const knownLabels = new Map<string, string>();

/**
 * Remembers the labels of the workspaces a page has listed (T-42 slice 2: a rename changes the label shown, never the id), so every place that
 * only holds a workspace id names it by its label. The web calls it with each workspace list it receives; nothing else needs to.
 */
export function rememberWorkspaceLabels(list: readonly { id: string; name: string; label?: string }[]): void {
  for (const w of list) {
    if (w.label && w.label !== w.name) knownLabels.set(w.id, w.label);
    else knownLabels.delete(w.id);
  }
}

/** The same from `WORKSPACE_API.labels` (`{ [id]: label }`): what the app learns once at its start. */
export function rememberWorkspaceLabelMap(map: Readonly<Record<string, string>>): void {
  for (const [id, label] of Object.entries(map)) if (label) knownLabels.set(id, label);
}

/** What a workspace is called, from its id: its label when a list has said it has one, else its name without its target (`docker/api-dev` → `api-dev`). */
export const workspaceLabel = (id: string): string => knownLabels.get(id) ?? id.slice(id.indexOf('/') + 1);
const targetOf = (id: string): string => (id.includes('/') ? id.slice(0, id.indexOf('/')) : '');
const baseName = (path: string): string => path.replace(/\/+$/, '').slice(path.replace(/\/+$/, '').lastIndexOf('/') + 1);

function matchesFilter(s: ChatSession, filter: ListFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'pinned':
      return !!s.pinnedAt;
    case 'attention':
      return needsYou(s);
    case 'working':
      return s.state === 'working' || s.state === 'starting';
    case 'idle':
      return s.state === 'idle';
    case 'ended':
      return s.state === 'ended';
  }
}

/** Search: every word must appear in the title, workspace, Claude, folder, branch, ticket, state or id. */
export function matchesQuery(s: ChatSession, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [s.title, s.workspaceId, s.claudeName ?? '', s.cwd, s.worktree?.branch ?? '', s.worktree?.path ?? '', s.ticketId ?? '', s.state, s.id]
    .join('\n')
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Counts of a session's whole subtree: everything it started, however deep. */
function rollupOf(root: ChatSession, kids: ReadonlyMap<string, ChatSession[]>): Rollup | null {
  const out: Rollup = { total: 0, working: 0, waiting: 0, idle: 0, interrupted: 0, ended: 0, costUsd: 0 };
  const seen = new Set<string>([root.id]);
  const walk = (id: string) => {
    for (const c of kids.get(id) ?? []) {
      if (seen.has(c.id)) continue; // a cycle can't happen, but a list must never loop
      seen.add(c.id);
      out.total++;
      out.costUsd += sessionCost(c).usd; // T-343: a working worker's running turn counts (an estimate until its result)
      if (c.waiting > 0 || c.state === 'waiting') out.waiting++;
      else if (c.state === 'working' || c.state === 'starting') out.working++;
      else if (c.state === 'idle') out.idle++;
      else if (c.state === 'interrupted') out.interrupted++;
      else out.ended++;
      walk(c.id);
    }
  };
  walk(root.id);
  return out.total ? out : null;
}

/**
 * The list the page shows. Order inside a group is by need (FR2), nested under parents that are in the
 * same group; a session whose parent is not in the group sits under a lead header for that parent (T-369,
 * `context`), or, when the parent is archived, at the top of its group saying where it came from. Groups
 * are ordered by their most urgent session; "no ticket" and "no worktree" come last.
 */
export function buildListView(all: readonly ChatSession[], opts: ListOptions = {}): ListView {
  const { groupBy = 'none', filter = 'all', query = '', archived = false, workspaces, groupOf } = opts;
  const byId = new Map(all.map((s) => [s.id, s]));
  const kids = new Map<string, ChatSession[]>();
  for (const s of all) if (s.parentId && byId.has(s.parentId)) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s]);

  const pool = all.filter((s) => !!s.archivedAt === archived);
  const visible = pool.filter((s) => matchesFilter(s, filter) && matchesQuery(s, query));
  const shownIds = new Set(visible.map((s) => s.id));

  const groupKey = (s: ChatSession): { key: string; title: string; subtitle: string | null; last: boolean; order?: number } => {
    if (groupOf) {
      const g = groupOf(s);
      return { key: g.key, title: g.title, subtitle: null, last: false, order: g.order };
    }
    switch (groupBy) {
      case 'workspace':
        return { key: s.workspaceId, title: workspaceLabel(s.workspaceId), subtitle: targetOf(s.workspaceId), last: false };
      case 'claude':
        return { key: `${s.workspaceId}\u0000${s.claudeId}`, title: s.claudeName ?? 'Default', subtitle: workspaceLabel(s.workspaceId), last: false };
      case 'worktree':
        return s.worktree
          ? { key: s.worktree.path, title: s.worktree.branch || baseName(s.worktree.path), subtitle: baseName(s.worktree.repo), last: false }
          : { key: '', title: 'No worktree', subtitle: null, last: true };
      case 'ticket':
        return s.ticketId ? { key: s.ticketId, title: s.ticketId, subtitle: null, last: false } : { key: '', title: 'No ticket', subtitle: null, last: true };
      default:
        return { key: '', title: '', subtitle: null, last: false };
    }
  };

  const makeRow = (s: ChatSession): ListRow => ({
    session: s,
    children: [],
    rollup: rollupOf(s, kids),
    earlier: false,
    workspaceGone: !!workspaces?.(s.workspaceId)?.gone,
    parentTitle: null,
    context: false,
  });

  // Rows per group, then nest.
  const members = new Map<string, { meta: ReturnType<typeof groupKey>; sessions: ChatSession[] }>();
  for (const s of visible) {
    const meta = groupKey(s);
    const g = members.get(meta.key) ?? { meta, sessions: [] };
    g.sessions.push(s);
    members.set(meta.key, g);
  }

  const groups: ListGroup[] = [];
  for (const [key, g] of members) {
    const ordered = [...g.sessions].sort(byUrgency);
    const inGroup = new Set(ordered.map((s) => s.id));
    const rows = new Map<string, ListRow>();
    for (const s of ordered) rows.set(s.id, makeRow(s));
    // T-369: a session whose lead the list has but this group does not shows under a lead header (the tree always shows); one whose lead
    // is archived names it as "from …" instead. One header per lead, never a header for a header: a header nests under its own lead only when
    // that lead is here already (a row, or the header of another of its workers).
    const headers: ChatSession[] = [];
    for (const s of ordered) {
      const lead = s.parentId && s.parentId !== s.id ? byId.get(s.parentId) : undefined;
      if (!lead || inGroup.has(lead.id)) continue;
      if (lead.archivedAt) rows.get(s.id)!.parentTitle = lead.title || 'another session';
      else if (!rows.has(lead.id)) {
        rows.set(lead.id, { ...makeRow(lead), context: true });
        headers.push(lead);
      }
    }
    const top: ListRow[] = [];
    // Nesting under a parent that is itself nested under this session would hide both: that one stays on top.
    const underItself = (s: ChatSession): boolean => {
      let p: string | null = s.parentId;
      for (let hops = 0; p && hops < 100; hops++) {
        if (p === s.id) return true;
        p = byId.get(p)?.parentId ?? null;
      }
      return false;
    };
    for (const s of [...ordered, ...headers]) {
      const row = rows.get(s.id)!;
      const parentRow = s.parentId ? rows.get(s.parentId) : undefined;
      if (parentRow && parentRow !== row && !underItself(s)) parentRow.children.push(row);
      else top.push(row);
    }
    const sortTree = (list: ListRow[]): ListRow[] => {
      for (const r of list) sortTree(r.children);
      return list.sort(byRow);
    };
    groups.push({
      key,
      title: g.meta.title,
      subtitle: g.meta.subtitle,
      rows: sortTree(top),
      count: ordered.length,
      waiting: ordered.filter((s) => s.waiting > 0 || s.state === 'waiting').length,
    });
  }
  // Grouped by Claude, a chat that moved shows under each Claude it ran on: running under its current one, and as
  // "ran here earlier" under the others (the same chat, one tap to open it; never a second session).
  if (groupBy === 'claude' && !groupOf) {
    for (const s of visible) {
      for (const p of s.previousClaudes) {
        const key = `${s.workspaceId}\u0000${p.claudeId}`;
        let g = groups.find((x) => x.key === key);
        if (!g) {
          g = { key, title: p.name, subtitle: workspaceLabel(s.workspaceId), rows: [], count: 0, waiting: 0 };
          groups.push(g);
          members.set(key, { meta: { key, title: p.name, subtitle: g.subtitle, last: false }, sessions: [] });
        }
        g.rows.push({ ...makeRow(s), earlier: true });
      }
    }
  }
  // Groups ordered by their most urgent session; the "none of" groups last. A lead header is not a session of its group.
  const rank = (g: ListGroup) => Math.min(5, ...members.get(g.key)!.sessions.map(attentionTier));
  const newest = (g: ListGroup) => Math.max(...g.rows.flatMap((r) => (r.context ? r.children : [r])).map((r) => Date.parse(r.session.lastActivityAt)));
  const order = (g: ListGroup) => members.get(g.key)!.meta.order ?? 0;
  groups.sort((a, b) => order(a) - order(b) || Number(members.get(a.key)!.meta.last) - Number(members.get(b.key)!.meta.last) || rank(a) - rank(b) || newest(b) - newest(a) || a.title.localeCompare(b.title));

  // The queue of what waits on you: sessions with a request open, not ended, not archived.
  const attention = visible
    .filter((s) => s.state !== 'ended' && (s.waiting > 0 || s.state === 'waiting'))
    .sort(byUrgency)
    .map(makeRow);

  return { attention, groups, shown: visible.length, total: pool.length, archived: all.filter((s) => !!s.archivedAt).length };
}

/** One line for a parent's rollup: "3 started · 1 working · 1 needs you". Null when it started nothing. */
export function rollupLine(r: Rollup | null): string | null {
  if (!r) return null;
  const parts = [`${r.total} started`];
  if (r.waiting) parts.push(`${r.waiting} ${r.waiting === 1 ? 'needs' : 'need'} you`);
  if (r.working) parts.push(`${r.working} working`);
  if (r.interrupted) parts.push(`${r.interrupted} interrupted`);
  if (r.idle) parts.push(`${r.idle} idle`);
  if (r.ended) parts.push(`${r.ended} ended`);
  return parts.join(' · ');
}
