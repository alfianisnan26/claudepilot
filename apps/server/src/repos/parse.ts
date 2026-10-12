// Workspace git: what the session host's `repo-find`, `repo-state` and `repo-sync` printed, parsed and checked
// (docs/prd/workspace-git.md §6, §7). The host is the portal's own script, but what it prints is a workspace's data: every field
// is validated against what it should look like and clipped, and a line that doesn't fit is dropped, never guessed at.

import type { RepoChanges, RepoHead, RepoOperation, RepoRemote, RepoSyncOutcome, RepoUpstream } from '@portal/contracts';
import { absPath, basename, cleanUrl, dirname, localRemoteName, plain, relPath, SHA, toInt, validRefName } from './text.js';

/** The most of anything one record keeps: a runaway output can't grow what is stored. */
export const MAX_REMOTES = 20;
export const MAX_WORKTREES = 200;
export const MAX_MODULES = 500;
export const MAX_LOG = 30;

export interface FoundRepo {
  /** The folder that holds the `.git` entry (the working folder), absolute. */
  path: string;
  /** `d`: a `.git` folder; `f`: a `.git` file (a submodule or a linked worktree). */
  type: 'd' | 'f';
}

export interface FoundRepos {
  /** The folder walked, as the host resolved it; null when the host refused it. */
  root: string | null;
  repos: FoundRepo[];
  /** More repositories than the count limit were there. */
  truncated: boolean;
  /** The walk ran out of time. */
  timedOut: boolean;
}

/** `repo-find`'s output: `#root`, then `<type><TAB><relative path of the .git entry>` per repository, then the `#truncated` and `#timeout` marks. */
export function parseFind(out: string): FoundRepos {
  const found: FoundRepos = { root: null, repos: [], truncated: false, timedOut: false };
  const seen = new Set<string>();
  for (const line of out.split('\n')) {
    if (line.startsWith('#root\t')) {
      found.root = absPath(line.slice(6));
    } else if (line === '#truncated') found.truncated = true;
    else if (line === '#timeout') found.timedOut = true;
    else if (found.root) {
      const tab = line.indexOf('\t');
      if (tab !== 1) continue;
      const type = line[0];
      if (type !== 'd' && type !== 'f') continue; // a link (`l`) is no repository
      const rel = line.slice(2);
      if (rel !== '.git' && !rel.endsWith('/.git')) continue;
      const dir = rel === '.git' ? '' : rel.slice(0, -5);
      if (dir && relPath(dir) === null) continue;
      const path = absPath(dir ? `${found.root === '/' ? '' : found.root}/${dir}` : found.root);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      found.repos.push({ path, type });
    }
  }
  return found;
}

export interface RawWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface RawModule {
  /** The name in `.gitmodules` (kept for display only). */
  name: string;
  path: string | null;
  url: string | null;
}

export interface RawLog {
  /** `ff`: the old commit is an ancestor of HEAD (the commits are what's new). `rewritten`: it isn't. `unknown`: it is not in the repository. */
  kind: 'ff' | 'rewritten' | 'unknown';
  /** How many commits since, when `ff`. */
  count: number | null;
  commits: { sha: string; author: string; subject: string }[];
}

/** What the host said about one folder. `error` set means the rest is empty. */
export interface RawRepo {
  /** The folder asked about. */
  path: string;
  error: 'refused' | 'notrepo' | 'ownership' | 'timeout' | 'unreadable' | null;
  gitDir: string;
  commonDir: string;
  superproject: string | null;
  /** `(detached)` is already `detached`; a repository with no commit has `unborn`. */
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  oid: string | null;
  upstream: RepoUpstream | null;
  changes: RepoChanges;
  /** Untracked folders (relative, no trailing slash), at most 100: a folder of other repositories is one entry. */
  untrackedDirs: string[];
  head: RepoHead | null;
  stash: number;
  unpushed: number | null;
  remotes: RepoRemote[];
  operation: RepoOperation | null;
  filters: number;
  fetchedAtMs: number | null;
  worktrees: RawWorktree[];
  modules: RawModule[];
  gitlinks: { path: string; sha: string }[];
  log: RawLog | null;
}

const ERRORS = ['refused', 'notrepo', 'ownership', 'timeout', 'unreadable'] as const;
const OPERATIONS: readonly string[] = ['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'];

function blank(path: string): RawRepo {
  return {
    path,
    error: null,
    gitDir: '',
    commonDir: '',
    superproject: null,
    branch: null,
    detached: false,
    unborn: false,
    oid: null,
    upstream: null,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    untrackedDirs: [],
    head: null,
    stash: 0,
    unpushed: null,
    remotes: [],
    operation: null,
    filters: 0,
    fetchedAtMs: null,
    worktrees: [],
    modules: [],
    gitlinks: [],
    log: null,
  };
}

/** The ISO instant a commit time is, in UTC; null when it isn't one. */
function isoUtc(text: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace('.000Z', 'Z') : null;
}

/**
 * `repo-state`'s output: a record per folder (`R`, tagged lines, `Z`). A record that never reached its `Z` (the call was cut short)
 * is `unreadable`, so a half-read repository is never taken for a whole one. Fields are clipped here; secrets are taken out by the
 * caller (it knows the workspace's values).
 */
export function parseState(out: string): RawRepo[] {
  const records: RawRepo[] = [];
  let cur: RawRepo | null = null;
  const remotes = new Map<string, { url?: string; pushUrl?: string }>();
  const modules = new Map<string, RawModule>();
  const close = () => {
    if (!cur) return;
    for (const [name, r] of remotes) {
      if (cur.remotes.length >= MAX_REMOTES) break;
      const url = r.url ?? r.pushUrl;
      if (!url) continue;
      const push = r.pushUrl && r.pushUrl !== url ? r.pushUrl : null;
      cur.remotes.push({ name, url, pushUrl: push, local: localRemoteName(url) ?? (push ? localRemoteName(push) : null) });
    }
    cur.modules = [...modules.values()].slice(0, MAX_MODULES);
    records.push(cur);
    cur = null;
    remotes.clear();
    modules.clear();
  };
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t');
    const tag = tab < 0 ? line : line.slice(0, tab);
    const rest = tab < 0 ? '' : line.slice(tab + 1);
    const f = rest.split('\t');
    if (tag === 'R') {
      // an unfinished record before this one: its repository was not read to the end
      if (cur) {
        (cur as RawRepo).error = 'unreadable';
        close();
      }
      const path = absPath(rest);
      cur = path ? blank(path) : null;
      remotes.clear();
      modules.clear();
      continue;
    }
    if (!cur) continue;
    const c: RawRepo = cur;
    switch (tag) {
      case 'E':
        c.error = (ERRORS as readonly string[]).includes(f[0] ?? '') ? (f[0] as RawRepo['error']) : 'unreadable';
        break;
      case 'Z':
        close();
        break;
      case 'T':
        c.gitDir = absPath(f[0]) ?? '';
        c.commonDir = absPath(f[1]) ?? '';
        c.superproject = f[2] ? absPath(f[2]) : null;
        break;
      case 'B': {
        const name = f[0] ?? '';
        const oid = f[1] ?? '';
        c.detached = name === '(detached)';
        c.unborn = oid === '(initial)';
        c.branch = c.detached ? null : validRefName(name);
        c.oid = SHA.test(oid) ? oid : null;
        break;
      }
      case 'D':
        c.changes = { staged: toInt(f[0]) ?? 0, unstaged: toInt(f[1]) ?? 0, untracked: toInt(f[2]) ?? 0, conflicted: toInt(f[3]) ?? 0 };
        break;
      case 'Q': {
        const dir = relPath((f[0] ?? '').replace(/\/$/, ''));
        if (dir && c.untrackedDirs.length < 100) c.untrackedDirs.push(dir);
        break;
      }
      case 'U': {
        const name = validRefName(f[0]);
        if (!name) break;
        if (f[1] === 'gone') c.upstream = { name, ahead: null, behind: null, gone: true };
        else {
          const a = toInt(f[1]);
          const b = toInt(f[2]);
          c.upstream = { name, ahead: a, behind: b, gone: a === null || b === null };
        }
        break;
      }
      case 'H': {
        const sha = f[0] ?? '';
        if (!SHA.test(sha)) break;
        c.head = { sha, at: isoUtc(f[1] ?? ''), author: plain(f[2], 80) || null, subject: plain(f.slice(3).join(' '), 200) };
        break;
      }
      case 'S':
        c.stash = toInt(f[0], 100_000) ?? 0;
        break;
      case 'P':
        c.unpushed = Math.min(toInt(f[0]) ?? 0, 1000);
        break;
      case 'X': {
        // `remote.<name>.<url|pushurl> <value>` (credentials were taken out by the host and are again here)
        const sp = rest.indexOf(' ');
        const m = sp < 0 ? null : /^remote\.(.+)\.(url|pushurl)$/.exec(rest.slice(0, sp));
        if (!m) break;
        const name = validRefName(m[1], 100);
        const url = cleanUrl(rest.slice(sp + 1));
        if (!name || !url) break;
        const entry = remotes.get(name) ?? {};
        if (m[2] === 'url') entry.url = url;
        else entry.pushUrl = url;
        remotes.set(name, entry);
        break;
      }
      case 'M':
        c.operation = OPERATIONS.includes(f[0] ?? '') ? (f[0] as RepoOperation) : null;
        break;
      case 'L':
        c.filters = toInt(f[0], 1000) ?? 0;
        break;
      case 'F': {
        const n = toInt(f[0]);
        c.fetchedAtMs = n === null ? null : n * 1000;
        break;
      }
      case 'W': {
        if (c.worktrees.length >= MAX_WORKTREES) break;
        const path = absPath(f[0]);
        if (!path) break;
        const flags = f[3] ?? '';
        c.worktrees.push({
          path,
          head: f[1] && SHA.test(f[1]) ? f[1] : null,
          branch: f[2] ? validRefName(f[2]) : null,
          detached: flags.includes('d'),
          locked: flags.includes('l'),
          prunable: flags.includes('p'),
        });
        break;
      }
      case 'Y': {
        // `submodule.<name>.<path|url> <value>`
        const sp = rest.indexOf(' ');
        const m = sp < 0 ? null : /^submodule\.(.+)\.(path|url)$/.exec(rest.slice(0, sp));
        if (!m) break;
        const name = plain(m[1], 100);
        if (!name) break;
        const value = rest.slice(sp + 1);
        const mod = modules.get(name) ?? { name, path: null, url: null };
        if (m[2] === 'path') mod.path = relPath(value);
        else mod.url = cleanUrl(value) || null;
        modules.set(name, mod);
        break;
      }
      case 'N': {
        // `160000 <sha> <stage>` and the path, tab separated
        const m = /^160000 ([0-9a-f]{40}|[0-9a-f]{64}) \d$/.exec(f[0] ?? '');
        const path = relPath(f.slice(1).join('\t'));
        if (m && path && c.gitlinks.length < MAX_MODULES) c.gitlinks.push({ path, sha: m[1]! });
        break;
      }
      case 'K':
        if (f[0] === 'ff' || f[0] === 'rewritten' || f[0] === 'unknown') c.log = { kind: f[0], count: f[0] === 'ff' ? (toInt(f[1]) ?? 0) : null, commits: [] };
        break;
      case 'C': {
        if (!c.log || c.log.commits.length >= MAX_LOG || !SHA.test(f[0] ?? '')) break;
        c.log.commits.push({ sha: f[0]!, author: plain(f[1], 80), subject: plain(f.slice(2).join(' '), 200) });
        break;
      }
      default:
        break;
    }
  }
  if (cur) {
    (cur as RawRepo).error = 'unreadable';
    close();
  }
  return records;
}

export interface RawSync {
  outcome: RepoSyncOutcome;
  from: string | null;
  to: string | null;
  ahead: number | null;
  behind: number | null;
  note: string | null;
}

/** `repo-sync`'s one line: `sync<TAB>outcome<TAB>from<TAB>to<TAB>ahead<TAB>behind<TAB>note`; null when it isn't there (the host failed before it). */
export function parseSync(out: string): RawSync | null {
  for (const line of out.split('\n')) {
    const f = line.split('\t');
    if (f[0] !== 'sync' || f.length < 7) continue;
    const outcome = f[1];
    if (outcome !== 'updated' && outcome !== 'current' && outcome !== 'refused' && outcome !== 'failed') continue;
    return {
      outcome,
      from: SHA.test(f[2] ?? '') ? f[2]! : null,
      to: SHA.test(f[3] ?? '') ? f[3]! : null,
      ahead: toInt(f[4]),
      behind: toInt(f[5]),
      note: plain(f.slice(6).join(' '), 200) || null,
    };
  }
  return null;
}

/** The working folder of the repository a linked worktree belongs to, from its common git dir (`<main>/.git`); a bare one is its own folder. */
export const mainFolder = (commonDir: string): string => (commonDir.endsWith('/.git') ? dirname(commonDir) : commonDir);

/** A folder's name for the tree. */
export const folderName = (path: string): string => basename(path);
