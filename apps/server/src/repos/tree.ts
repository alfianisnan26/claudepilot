// Workspace git: from what the host said about each folder to the tree the portal keeps (docs/prd/workspace-git.md §5, §7, §11):
// what each repository is (a repository, a submodule, a linked worktree, a nested one nobody declared, a declared one nobody cloned),
// how they relate, which of them need a look and how much, and the counts over a set of them.

import { REPO_ATTENTION_ORDER, type RepoAttention, type RepoKind, type RepoState, type RepoSummary } from '@portal/contracts';
import { mainFolder, type RawRepo } from './parse.js';
import { basename, repoId, within } from './text.js';

/** What a scan knows of one repository, before sessions, sync settings and times are added. */
export interface NodeCore {
  id: string;
  workspaceId: string;
  path: string;
  name: string;
  kind: RepoKind;
  parentId: string | null;
  mainId: string | null;
  state: RepoState | null;
  error: string | null;
  worktree: { locked: boolean; prunable: boolean } | null;
  submodule: { recorded: string | null; url: string | null; drifted: boolean } | null;
  drifted: number;
}

/** Cleans a piece of workspace text (secrets out, clipped): the caller knows the workspace's values. */
export type Clean = (text: string, max: number) => string;

export function stateOf(raw: RawRepo, clean: Clean): RepoState {
  const clip = (u: string) => clean(u, 300);
  return {
    branch: raw.branch,
    detached: raw.detached,
    unborn: raw.unborn,
    head: raw.head ? { sha: raw.head.sha, at: raw.head.at, author: raw.head.author ? clean(raw.head.author, 80) : null, subject: clean(raw.head.subject, 200) } : null,
    upstream: raw.upstream,
    changes: raw.changes,
    stash: raw.stash,
    unpushed: raw.unpushed,
    remotes: raw.remotes.map((r) => ({ name: r.name, url: clip(r.url), pushUrl: r.pushUrl ? clip(r.pushUrl) : null, local: r.local })),
    operation: raw.operation,
    filters: raw.filters,
    fetchedAt: raw.fetchedAtMs === null ? null : new Date(raw.fetchedAtMs).toISOString(),
  };
}

export interface Previous {
  kind: RepoKind;
  parentId: string | null;
  mainId: string | null;
  name: string;
}

const join = (base: string, rel: string) => (base === '/' ? `/${rel}` : `${base}/${rel}`);
const relIn = (path: string, base: string) => path.slice(base.length + 1);

/**
 * The repositories a set of host records describe, as tree nodes (unordered; see {@link orderNodes}).
 *
 * - A linked worktree is a record whose git dir isn't the common one; it belongs to the repository that holds the common dir.
 * - A submodule is a record git itself says has a superproject.
 * - Any other repository inside another one's folder is `nested`.
 * - A gitlink the superproject records whose folder holds no repository is `missing` (not cloned).
 * - A record the host could not read keeps what the portal knew of it (`previous`), or is a plain repository, with `error` set.
 */
export function buildNodes(workspaceId: string, records: RawRepo[], previous: ReadonlyMap<string, Previous>, clean: Clean): NodeCore[] {
  const read = records.filter((r) => !r.error);
  const byPath = new Map(read.map((r) => [r.path, r]));
  const failed = new Map(records.filter((r) => r.error).map((r) => [r.path, r]));
  const nodes = new Map<string, NodeCore>();

  // Every repository read, for "the one this is inside".
  const enclosers = read.map((r) => r.path);
  const nearest = (path: string): string | null => {
    let best: string | null = null;
    for (const p of enclosers) if (p !== path && within(path, p) && (!best || p.length > best.length)) best = p;
    return best;
  };

  for (const r of read) {
    const linked = r.gitDir !== r.commonDir;
    let kind: RepoKind = 'repo';
    let parentPath: string | null = null;
    let mainId: string | null = null;
    let name = basename(r.path);
    if (linked) {
      kind = 'worktree';
      const main = mainFolder(r.commonDir);
      mainId = repoId(workspaceId, main);
      parentPath = byPath.has(main) ? main : null;
    } else if (r.superproject) {
      kind = 'submodule';
      parentPath = byPath.has(r.superproject) ? r.superproject : null;
      if (parentPath && within(r.path, parentPath)) name = relIn(r.path, parentPath);
    } else {
      const enc = nearest(r.path);
      if (enc) {
        kind = 'nested';
        parentPath = enc;
        name = relIn(r.path, enc);
      }
    }
    nodes.set(r.path, {
      id: repoId(workspaceId, r.path),
      workspaceId,
      path: r.path,
      name,
      kind,
      parentId: parentPath ? repoId(workspaceId, parentPath) : null,
      mainId,
      state: stateOf(r, clean),
      error: null,
      worktree: linked ? { locked: !!r.worktrees.find((w) => w.path === r.path)?.locked, prunable: false } : null,
      submodule: null,
      drifted: 0,
    });
  }

  // An untracked folder that holds repositories the portal tracks on their own (a pool of clones inside a repository, a worktree kept
  // in a folder of it) is not a change of the repository around it: they are tracked, each with its own state.
  for (const r of read) {
    if (!r.untrackedDirs.length) continue;
    const base = r.path === '/' ? '' : r.path;
    const holding = r.untrackedDirs.filter((d) => read.some((o) => o.path !== r.path && within(o.path, `${base}/${d}`))).length;
    const n = nodes.get(r.path);
    if (holding && n?.state) n.state = { ...n.state, changes: { ...n.state.changes, untracked: Math.max(0, n.state.changes.untracked - holding) } };
  }

  // The worktree flags come from the main repository's list: a linked worktree's own record doesn't say whether it is locked.
  for (const r of read) {
    if (r.gitDir !== r.commonDir) continue;
    for (const w of r.worktrees) {
      const n = nodes.get(w.path);
      if (n?.worktree) n.worktree = { locked: w.locked, prunable: w.prunable };
    }
  }

  // Declared submodules: drift for the ones cloned, a `missing` node for the others.
  for (const r of read) {
    const urls = new Map(r.modules.flatMap((m) => (m.path ? [[m.path, m.url] as const] : [])));
    for (const g of r.gitlinks) {
      const full = join(r.path, g.path);
      const child = nodes.get(full);
      if (child && child.kind === 'submodule' && child.parentId === repoId(workspaceId, r.path)) {
        const drifted = child.state?.head?.sha !== g.sha;
        child.submodule = { recorded: g.sha, url: urls.get(g.path) ?? null, drifted };
        if (drifted) nodes.get(r.path)!.drifted++;
        continue;
      }
      if (child) continue; // a repository is there, but it isn't what the superproject records (nested, or the superproject changed): it stays what it is
      const f = failed.get(full);
      if (f && f.error !== 'notrepo' && f.error !== 'refused') {
        // there is something there that couldn't be read: a node with the reason, below the superproject
        nodes.set(full, {
          id: repoId(workspaceId, full),
          workspaceId,
          path: full,
          name: g.path,
          kind: 'submodule',
          parentId: repoId(workspaceId, r.path),
          mainId: null,
          state: null,
          error: errorCode(f.error),
          worktree: null,
          submodule: { recorded: g.sha, url: urls.get(g.path) ?? null, drifted: false },
          drifted: 0,
        });
        continue;
      }
      nodes.set(full, {
        id: repoId(workspaceId, full),
        workspaceId,
        path: full,
        name: g.path,
        kind: 'missing',
        parentId: repoId(workspaceId, r.path),
        mainId: null,
        state: null,
        error: null,
        worktree: null,
        submodule: { recorded: g.sha, url: urls.get(g.path) ?? null, drifted: false },
        drifted: 0,
      });
    }
  }

  // Folders that were asked about and couldn't be read, and aren't declared submodules: still tracked, with the reason.
  for (const [path, f] of failed) {
    if (nodes.has(path) || f.error === 'notrepo' || f.error === 'refused') continue;
    const was = previous.get(path);
    nodes.set(path, {
      id: repoId(workspaceId, path),
      workspaceId,
      path,
      name: was?.name ?? basename(path),
      kind: was && was.kind !== 'missing' ? was.kind : 'repo',
      parentId: was?.parentId ?? null,
      mainId: was?.mainId ?? null,
      state: null,
      error: errorCode(f.error),
      worktree: null,
      submodule: null,
      drifted: 0,
    });
  }
  return [...nodes.values()];
}

/** The short fixed code a node shows for a failed read. */
export function errorCode(error: RawRepo['error']): string | null {
  switch (error) {
    case 'timeout':
      return 'timeout';
    case 'ownership':
      return 'unsafe';
    case 'notrepo':
    case 'refused':
      return 'not_a_repository';
    case 'unreadable':
      return 'unreadable';
    default:
      return null;
  }
}

/**
 * Parents first, each followed by its children; siblings by folder (worktrees after the other kinds). A node whose parent isn't in the
 * set sits at the top. Returns the depth of each.
 */
export function orderNodes<T extends { id: string; path: string; kind: RepoKind; parentId: string | null }>(nodes: T[]): { node: T; depth: number }[] {
  const ids = new Set(nodes.map((n) => n.id));
  const kids = new Map<string | null, T[]>();
  for (const n of nodes) {
    const key = n.parentId && ids.has(n.parentId) && n.parentId !== n.id ? n.parentId : null;
    (kids.get(key) ?? kids.set(key, []).get(key)!).push(n);
  }
  const rank = (n: T) => (n.kind === 'worktree' ? 1 : 0);
  const sort = (xs: T[]) => xs.sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const out: { node: T; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const n of sort(kids.get(parent) ?? [])) {
      if (seen.has(n.id)) continue; // a cycle can't be drawn
      seen.add(n.id);
      out.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  // Anything left sat in a cycle: show it at the top rather than lose it.
  for (const n of nodes) if (!seen.has(n.id)) out.push({ node: n, depth: 0 });
  return out;
}

/** How much each reason weighs in the order of the attention list. */
export const ATTENTION_WEIGHT: Record<RepoAttention, number> = {
  error: 100,
  conflicted: 90,
  operation: 80,
  diverged: 70,
  behind: 45,
  unpushed: 40,
  dirty: 25,
  detached: 10,
  drift: 30,
  missing: 5,
};

/** Why a repository needs a look. A submodule is normally detached at the recorded commit, so that alone says nothing about it. */
export function attentionOf(n: Pick<NodeCore, 'kind' | 'state' | 'error' | 'submodule'>): { score: number; reasons: RepoAttention[] } {
  const found = new Set<RepoAttention>();
  const s = n.state;
  if (n.error) found.add('error');
  if (n.kind === 'missing') found.add('missing');
  if (s) {
    if (s.changes.conflicted > 0) found.add('conflicted');
    if (s.operation) found.add('operation');
    const ahead = s.upstream?.ahead ?? 0;
    const behind = s.upstream?.behind ?? 0;
    if (ahead > 0 && behind > 0) found.add('diverged');
    else if (behind > 0) found.add('behind');
    if ((s.unpushed ?? 0) > 0) found.add('unpushed');
    if (s.changes.staged + s.changes.unstaged + s.changes.untracked + s.changes.conflicted > 0) found.add('dirty');
    if (s.detached && n.kind !== 'submodule') found.add('detached');
  }
  if (n.submodule?.drifted) found.add('drift');
  const reasons = REPO_ATTENTION_ORDER.filter((r) => found.has(r));
  return { score: reasons.reduce((sum, r) => sum + ATTENTION_WEIGHT[r], 0), reasons };
}

export const EMPTY_SUMMARY: RepoSummary = { repos: 0, worktrees: 0, dirty: 0, ahead: 0, behind: 0, diverged: 0, detached: 0, unpushed: 0, conflicted: 0, missing: 0, drifted: 0, errors: 0, attention: 0 };

/** Counts over a set of nodes (the nodes of one workspace, or of all). */
export function summarize(nodes: Pick<NodeCore, 'kind' | 'state' | 'error' | 'submodule'>[]): RepoSummary {
  const out = { ...EMPTY_SUMMARY };
  for (const n of nodes) {
    if (n.kind === 'missing') {
      out.missing++;
      out.attention++;
      continue;
    }
    out.repos++;
    if (n.kind === 'worktree') out.worktrees++;
    const a = attentionOf(n);
    if (a.reasons.length) out.attention++;
    if (n.error) out.errors++;
    const s = n.state;
    if (s) {
      if (s.changes.staged + s.changes.unstaged + s.changes.untracked + s.changes.conflicted > 0) out.dirty++;
      if ((s.upstream?.ahead ?? 0) > 0) out.ahead++;
      if ((s.upstream?.behind ?? 0) > 0) out.behind++;
      if ((s.upstream?.ahead ?? 0) > 0 && (s.upstream?.behind ?? 0) > 0) out.diverged++;
      if (s.detached && n.kind !== 'submodule') out.detached++;
      if ((s.unpushed ?? 0) > 0) out.unpushed++;
      if (s.changes.conflicted > 0) out.conflicted++;
    }
    if (n.submodule?.drifted) out.drifted++;
  }
  return out;
}

/** The sum of summaries. */
export function addSummaries(list: RepoSummary[]): RepoSummary {
  const out = { ...EMPTY_SUMMARY };
  for (const s of list) for (const k of Object.keys(out) as (keyof RepoSummary)[]) out[k] += s[k];
  return out;
}
