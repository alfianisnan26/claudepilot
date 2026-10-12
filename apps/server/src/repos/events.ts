// Workspace git: what changed between two looks at a workspace's repositories, as events (docs/prd/workspace-git.md §8), and the
// one line each event reads as. Pure: the scan decides when to look, the store keeps the result, the service attributes it.

import type { RepoEventData, RepoEventKind } from '@portal/contracts';
import type { RawLog } from './parse.js';
import type { NodeCore } from './tree.js';
import { short } from './text.js';

export interface EventDraft {
  repoId: string | null;
  /** The repository's name at the time. */
  repo: string | null;
  kind: RepoEventKind;
  summary: string;
  data: RepoEventData;
  /** A chat that was in the repository could have made this change, so the service tries to name it. */
  attributable: boolean;
}

/** At most this many drift events a scan writes for one superproject, and events of a kind for the first scan of a workspace. */
const MAX_DRIFT_EVENTS = 20;

const dirtyCount = (n: NodeCore): number => (n.state ? n.state.changes.staged + n.state.changes.unstaged + n.state.changes.untracked + n.state.changes.conflicted : 0);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const KIND_WORD: Record<string, string> = { repo: 'repo', submodule: 'submodule', nested: 'nested repo', worktree: 'worktree', missing: 'submodule' };

/** The line an event reads as; `name` is the repository's name. Short, plain, ready to show. */
export function describe(kind: RepoEventKind, name: string | null, d: RepoEventData): string {
  const who = name ?? 'Workspace';
  switch (kind) {
    case 'discovered':
      return `Found ${KIND_WORD[d.kind ?? 'repo'] ?? 'repo'} ${who}`;
    case 'removed':
      return `${who} is gone`;
    case 'branch_changed':
      return `${who}: ${d.from ?? 'detached'} → ${d.to ?? 'detached'}`;
    case 'head_moved': {
      const n = d.commits ?? 0;
      if (d.fastForward === true && n > 0) return `${who}: ${plural(n, 'new commit')}${d.authors?.length ? ` by ${d.authors.join(', ')}` : ''}`;
      return `${who}: moved to ${short(d.toSha)}${d.fastForward === false ? ' (history changed)' : ''}`;
    }
    case 'dirty':
      return `${who}: ${plural((d.staged ?? 0) + (d.unstaged ?? 0) + (d.untracked ?? 0) + (d.conflicted ?? 0), 'file')} changed`;
    case 'clean':
      return `${who}: clean`;
    case 'conflicted':
      return `${who}: ${plural(d.conflicted ?? 0, 'conflict')}`;
    case 'diverged':
      return `${who}: diverged (${d.ahead ?? 0} ahead, ${d.behind ?? 0} behind)`;
    case 'worktree_added':
      return `${who}: worktree ${d.branch ?? d.path ?? ''} added`.trim();
    case 'worktree_removed':
      return `${who}: worktree ${d.branch ?? d.path ?? ''} gone`.trim();
    case 'drift':
      return `${who}: ${d.path ?? 'submodule'} at ${short(d.checkedOut)}, recorded ${short(d.recorded)}`;
    case 'aligned':
      return `${who}: ${d.path ?? 'submodule'} matches the record`;
    case 'scan_failed':
      return name ? `${who}: couldn’t be read (${d.error ?? 'unknown'})` : `Scan failed: ${d.error ?? 'unknown'}`;
    case 'scan_requested':
      return name ? `${who}: scan requested` : 'Scan requested';
    case 'worktree_created':
      return `${who}: worktree ${d.branch ?? ''} made`.trim();
    case 'worktree_deleted':
      return `${who}: worktree ${d.branch ?? d.path ?? ''} removed${d.forced ? ' (changes discarded)' : ''}`.trim();
    case 'sync':
      return `${who}: sync ${d.outcome ?? ''}${d.error ? `: ${d.error}` : ''}`.trim();
    case 'sync_setting':
      return `${who}: keep synced ${d.enabled ? 'on' : 'off'}`;
    case 'settings':
      return d.roots !== undefined ? `Scan folders: ${d.roots ? d.roots.join(', ') || 'none' : 'default'}` : `Automatic scans ${d.auto ? 'on' : 'off'}`;
  }
}

function draft(n: Pick<NodeCore, 'id' | 'name'> | null, kind: RepoEventKind, data: RepoEventData, attributable = true): EventDraft {
  return { repoId: n?.id ?? null, repo: n?.name ?? null, kind, data, summary: describe(kind, n?.name ?? null, data), attributable };
}

export interface DiffInput {
  /** The repositories the last look found and kept, removed ones left out. */
  previous: NodeCore[];
  /** What this look found. */
  next: NodeCore[];
  /** The commits since the last look, by folder, for the repositories whose HEAD moved. */
  logs: ReadonlyMap<string, RawLog | null>;
  /**
   * Repositories (ids) that are certainly gone: the folder was read again and holds no repository, or a not-cloned submodule that its
   * superproject no longer records. A repository the look didn't reach (a limit, a failed read) is not gone, only unseen.
   */
  confirmedGone: ReadonlySet<string>;
  /** The workspace had never been looked at: what it finds is reported as found by the first scan. */
  initial: boolean;
}

export interface DiffResult {
  events: EventDraft[];
  /** Ids to mark removed. */
  gone: string[];
}

export function diffScan(input: DiffInput): DiffResult {
  const events: EventDraft[] = [];
  const gone: string[] = [];
  const prev = new Map(input.previous.map((n) => [n.id, n]));
  const nextById = new Map(input.next.map((n) => [n.id, n]));
  const nameOf = (id: string | null) => (id ? (nextById.get(id) ?? prev.get(id)) : null) ?? null;
  const ordered = [...input.next].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const driftCount = new Map<string, number>();

  for (const n of ordered) {
    const was = prev.get(n.id);
    if (!was || (was.kind === 'missing' && n.kind !== 'missing')) {
      if (n.kind === 'missing') continue;
      if (n.kind === 'worktree') {
        const main = nameOf(n.parentId ?? n.mainId);
        events.push(draft(main ?? n, 'worktree_added', { path: n.path, branch: n.state?.branch ?? undefined, ...(input.initial ? { initial: true } : {}) }));
      } else events.push(draft(n, 'discovered', { kind: n.kind, path: n.path, branch: n.state?.branch ?? undefined, ...(input.initial ? { initial: true } : {}) }));
      continue;
    }
    if (n.kind === 'missing' && was.kind !== 'missing') {
      // still declared, but the folder holds no repository any more (a deinit, or deleted by hand)
      if (was.kind === 'worktree') events.push(draft(nameOf(was.parentId ?? was.mainId) ?? was, 'worktree_removed', { path: was.path, branch: was.state?.branch ?? undefined }));
      else events.push(draft(was, 'removed', { kind: was.kind, path: was.path }));
      continue;
    }
    if (n.error && !was.error) {
      events.push(draft(n, 'scan_failed', { error: n.error }, false));
      continue;
    }
    const a = was.state;
    const b = n.state;
    if (a && b) {
      const branchChanged = a.branch !== b.branch || a.detached !== b.detached;
      if (branchChanged) {
        events.push(draft(n, 'branch_changed', { from: a.branch, to: b.branch, fromSha: a.head?.sha ?? null, toSha: b.head?.sha ?? null }));
      } else if (b.head && a.head?.sha !== b.head.sha) {
        const log = input.logs.get(n.path) ?? null;
        const ff = log ? (log.kind === 'ff' ? true : log.kind === 'rewritten' ? false : null) : null;
        const commits = log?.kind === 'ff' ? (log.count ?? log.commits.length) : undefined;
        const authors = log?.kind === 'ff' ? [...new Set(log.commits.map((c) => c.author).filter(Boolean))].slice(0, 5) : undefined;
        const subjects = log?.kind === 'ff' ? log.commits.slice(0, 5).map((c) => c.subject) : undefined;
        events.push(
          draft(n, 'head_moved', {
            from: short(a.head?.sha),
            to: short(b.head.sha),
            fromSha: a.head?.sha ?? null,
            toSha: b.head.sha,
            fastForward: ff,
            ...(branchChanged ? {} : { branch: b.branch ?? undefined }),
            ...(commits !== undefined ? { commits } : {}),
            ...(authors?.length ? { authors } : {}),
            ...(subjects?.length ? { subjects } : {}),
          }),
        );
      }
      const wasDirty = dirtyCount(was) > 0;
      const isDirty = dirtyCount(n) > 0;
      if (isDirty && !wasDirty) events.push(draft(n, 'dirty', { ...b.changes }));
      else if (!isDirty && wasDirty) events.push(draft(n, 'clean', {}));
      if (b.changes.conflicted > 0 && a.changes.conflicted === 0) events.push(draft(n, 'conflicted', { conflicted: b.changes.conflicted }));
      const wasDiv = (a.upstream?.ahead ?? 0) > 0 && (a.upstream?.behind ?? 0) > 0;
      const isDiv = (b.upstream?.ahead ?? 0) > 0 && (b.upstream?.behind ?? 0) > 0;
      if (isDiv && !wasDiv) events.push(draft(n, 'diverged', { ahead: b.upstream!.ahead!, behind: b.upstream!.behind! }));
    }
    // A submodule's drift is the superproject's news.
    if (n.kind === 'submodule' && n.submodule && n.parentId) {
      const parent = nameOf(n.parentId);
      const rel = n.name;
      const drifted = n.submodule.drifted;
      const wasDrifted = was.submodule?.drifted ?? false;
      const key = `${n.submodule.recorded}:${n.state?.head?.sha ?? ''}`;
      const wasKey = `${was.submodule?.recorded}:${was.state?.head?.sha ?? ''}`;
      if (parent && ((drifted && (!wasDrifted || key !== wasKey)) || (!drifted && wasDrifted))) {
        const count = (driftCount.get(parent.id) ?? 0) + 1;
        driftCount.set(parent.id, count);
        if (count <= MAX_DRIFT_EVENTS) {
          events.push(
            draft(parent, drifted ? 'drift' : 'aligned', {
              path: rel,
              recorded: n.submodule.recorded ?? undefined,
              checkedOut: n.state?.head?.sha ?? null,
            }),
          );
        }
      }
    }
  }

  // What was there and certainly isn't now.
  for (const w of input.previous) {
    if (nextById.has(w.id) || !input.confirmedGone.has(w.id)) continue;
    gone.push(w.id);
    if (w.kind === 'missing') continue;
    if (w.kind === 'worktree') {
      const main = nameOf(w.parentId ?? w.mainId);
      events.push(draft(main ?? w, 'worktree_removed', { path: w.path, branch: w.state?.branch ?? undefined }));
    } else events.push(draft(w, 'removed', { kind: w.kind, path: w.path }));
  }
  return { events, gone };
}
