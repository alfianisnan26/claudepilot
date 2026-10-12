// The Sessions list as a model (chat-sessions PRD FR2, FR28; Workspace Claudes FR17): sessions filtered,
// searched, grouped by workspace, Claude, worktree or ticket, ordered by what needs you, and nested under
// the session that started them. Pure functions, so the page stays thin and the rules are tested.

import type { ChatSession } from './chat.js';

export type ListGroupBy = 'none' | 'workspace' | 'claude' | 'worktree' | 'ticket';
export const LIST_GROUP_BYS: readonly ListGroupBy[] = ['none', 'workspace', 'claude', 'worktree', 'ticket'];

/** `attention`: waiting on you, interrupted, or ended for safety. `open`: not ended. */
export type ListFilter = 'all' | 'attention' | 'working' | 'idle' | 'ended';
export const LIST_FILTERS: readonly ListFilter[] = ['all', 'attention', 'working', 'idle', 'ended'];

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
  /** Its parent is shown elsewhere (another group, or filtered out): the title to show as "from …". */
  parentTitle: string | null;
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

const byUrgency = (a: ChatSession, b: ChatSession) => attentionTier(a) - attentionTier(b) || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);

/** A workspace's name without its target (`docker/api-dev` → `api-dev`). */
export const workspaceLabel = (id: string): string => id.slice(id.indexOf('/') + 1);
const targetOf = (id: string): string => (id.includes('/') ? id.slice(0, id.indexOf('/')) : '');
const baseName = (path: string): string => path.replace(/\/+$/, '').slice(path.replace(/\/+$/, '').lastIndexOf('/') + 1);

function matchesFilter(s: ChatSession, filter: ListFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
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
      out.costUsd += c.costUsd;
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
 * same group; a session whose parent is shown elsewhere stays at the top of its group and says where it
 * came from. Groups are ordered by their most urgent session; "no ticket" and "no worktree" come last.
 */
export function buildListView(all: readonly ChatSession[], opts: ListOptions = {}): ListView {
  const { groupBy = 'none', filter = 'all', query = '', archived = false, workspaces } = opts;
  const byId = new Map(all.map((s) => [s.id, s]));
  const kids = new Map<string, ChatSession[]>();
  for (const s of all) if (s.parentId && byId.has(s.parentId)) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s]);

  const pool = all.filter((s) => !!s.archivedAt === archived);
  const visible = pool.filter((s) => matchesFilter(s, filter) && matchesQuery(s, query));
  const shownIds = new Set(visible.map((s) => s.id));

  const groupKey = (s: ChatSession): { key: string; title: string; subtitle: string | null; last: boolean } => {
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
    for (const s of ordered) {
      const row = makeRow(s);
      row.parentTitle = s.parentId && byId.has(s.parentId) && !inGroup.has(s.parentId) ? byId.get(s.parentId)!.title || 'another session' : null;
      rows.set(s.id, row);
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
    for (const s of ordered) {
      const row = rows.get(s.id)!;
      const parentRow = s.parentId ? rows.get(s.parentId) : undefined;
      if (parentRow && parentRow !== row && !underItself(s)) parentRow.children.push(row);
      else top.push(row);
    }
    groups.push({
      key,
      title: g.meta.title,
      subtitle: g.meta.subtitle,
      rows: top,
      count: ordered.length,
      waiting: ordered.filter((s) => s.waiting > 0 || s.state === 'waiting').length,
    });
  }
  // Grouped by Claude, a chat that moved shows under each Claude it ran on: running under its current one, and as
  // "ran here earlier" under the others (the same chat, one tap to open it; never a second session).
  if (groupBy === 'claude') {
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
  // Groups ordered by their most urgent session; the "none of" groups last.
  const real = (g: ListGroup) => g.rows.filter((r) => !r.earlier);
  const rank = (g: ListGroup) => Math.min(5, ...real(g).map((r) => attentionTier(r.session)), ...real(g).flatMap((r) => r.children.map((c) => attentionTier(c.session))));
  const newest = (g: ListGroup) => Math.max(...g.rows.map((r) => Date.parse(r.session.lastActivityAt)));
  groups.sort((a, b) => Number(members.get(a.key)!.meta.last) - Number(members.get(b.key)!.meta.last) || rank(a) - rank(b) || newest(b) - newest(a) || a.title.localeCompare(b.title));

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
