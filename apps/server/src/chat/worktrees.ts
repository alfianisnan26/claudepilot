// Git worktrees per session (chat-sessions PRD, "Git worktrees per session"). A chat can run in a worktree of its own: the
// portal adds one from a repository of the workspace, on a branch it names (or the person does), and the chat's folder is
// that worktree, so its changes stay apart from the repository's working folder and from other chats. The portal makes
// them itself, through the session host's hardened git (no hook, filter or fsmonitor of the repository runs), rather
// than leaving it to Claude Code's own `-w`: it has to validate the branch and base, check the new folder's project
// settings for trust, know the folder and branch (lists, tickets, CI, Files and Diff), and never remove one on its own.

import { AppError, defineErrorCodes } from '@isnanme/core';
import { WORKTREE_DIRTY, type ChatWorktreeStatus } from '@portal/contracts';

declare module '@isnanme/core' {
  interface ErrorCodeRegistry {
    WORKTREE_DIRTY: true;
  }
}
defineErrorCodes({ [WORKTREE_DIRTY]: { status: 409, message: 'The worktree has changes that would be lost.' } });

/** What the portal runs on the session host: its argv after `cp-session`, and what came back. */
export type HostRun = (workspaceId: string, args: string[]) => Promise<{ code: number | null; out: string }>;

/** Host exit codes of the worktree commands (host.ts). */
const REFUSED = 2;
const NOT_A_REPO = 3;
const BRANCH_IN_USE = 4;
const NO_BASE = 5;
const PATH_EXISTS = 6;
const HAS_CHANGES = 7;
/** `wt-add`'s parent folder is not one the caller may see (missing, outside the files root, the portal's own files). */
const PARENT_UNSEEN = 8;

/** A branch name the portal takes: a conservative subset of what git allows (the host asks git as well). */
export function branchProblem(branch: string): string | null {
  if (!branch) return 'Name the branch.';
  if (branch.length > 100) return 'Keep the branch name to 100 characters.';
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return 'Use letters, digits, dots, dashes, underscores and slashes.';
  if (branch.startsWith('-') || branch.endsWith('/') || branch.endsWith('.') || branch.includes('..') || branch.includes('//')) return 'That isn’t a valid branch name.';
  if (branch.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) return 'That isn’t a valid branch name.';
  return null;
}

/** A base the portal takes: a branch, tag or commit, with the revision operators a name can carry. */
export function baseProblem(base: string): string | null {
  if (!base) return 'Name the base.';
  if (base.length > 100) return 'Keep the base to 100 characters.';
  if (base.startsWith('-') || !/^[A-Za-z0-9._/@^~-]+$/.test(base)) return 'That isn’t a branch, tag or commit.';
  return null;
}

/** Words for a branch or folder name: lower case, ASCII, dashes. */
export function slug(text: string | null | undefined, max = 40): string {
  const s = (text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s;
}

/** The branch a worktree gets when nobody names one: `ticket/<n>-<words>` for a ticket's chat (CI reads it), else `session/<words>-<id>`. */
export function defaultBranch(o: { ticketId?: string | null; title?: string | null; token: string }): string {
  const words = slug(o.title);
  const ticket = o.ticketId ? /^T-(\d{1,9})$/.exec(o.ticketId)?.[1] : null;
  if (ticket) return `ticket/${ticket}-${slug((o.title ?? '').replace(new RegExp(`^T-?${ticket}\\b[\\s:.-]*`, 'i'), '')) || 'work'}`;
  return `session/${words || 'chat'}-${o.token}`;
}

/**
 * The folder name of a branch's worktree. The host puts it beside the repository, in `<repo>.worktrees/`, inside the files Files
 * and Diff can show; a name that is taken gets a number.
 */
export function worktreeLeaf(branch: string, attempt = 1): string {
  const leaf = slug(branch.replace(/\//g, '-'), 56) || 'worktree';
  return `${leaf}${attempt > 1 ? `-${attempt}` : ''}`;
}

/** What `wt-add` made. */
export interface MadeWorktree {
  /** The new worktree's real path. */
  path: string;
  branch: string;
  /** The commit the branch is at. */
  commit: string;
  /** The repository's top folder. */
  repo: string;
  /** The folder the request named, relative to the repository's top ('' when it was the top). */
  rel: string;
}

export class Worktrees {
  constructor(private readonly run: HostRun) {}

  /**
   * Makes a worktree of the repository containing `folder`, on `branch`, started from `base` (the repository's HEAD when none). The
   * host picks the place; a folder name that is taken gets a number. Nothing is left behind when it is refused.
   */
  async add(workspaceId: string, o: { folder: string; branch: string; base?: string | null; parent?: string }): Promise<MadeWorktree> {
    const bad = branchProblem(o.branch);
    if (bad) throw new AppError('VALIDATION_FAILED', bad, { details: { branch: bad } });
    const baseBad = o.base ? baseProblem(o.base) : null;
    if (baseBad) throw new AppError('VALIDATION_FAILED', baseBad, { details: { base: baseBad } });
    for (let attempt = 1; attempt <= 9; attempt++) {
      // T-1261: a parent folder, when one is named, is the fifth argument; without it the host uses <repo>.worktrees/.
      const r = await this.run(workspaceId, ['wt-add', o.folder, worktreeLeaf(o.branch, attempt), o.branch, o.base || '-', ...(o.parent ? [o.parent] : [])]);
      if (r.code === 0) {
        const made = parseMade(r.out);
        if (made) return made;
        throw new AppError('SERVICE_UNAVAILABLE', 'The workspace answered the worktree request in a way the portal didn’t understand.', { expose: true });
      }
      if (r.code === PATH_EXISTS) continue;
      throw refusal(r.code, r.out, o);
    }
    throw new AppError('CONFLICT', 'There are too many worktrees of that name. Name the branch.', { details: { branch: 'Name another branch.' } });
  }

  /** What removing a worktree would lose, or null when its folder is gone. */
  async status(workspaceId: string, path: string): Promise<ChatWorktreeStatus | null> {
    const r = await this.run(workspaceId, ['wt-status', path]);
    if (r.code === REFUSED || r.code === NOT_A_REPO) return null;
    if (r.code !== 0) throw new AppError('SERVICE_UNAVAILABLE', `Couldn’t read the worktree (exit ${r.code ?? 'unknown'}).`, { expose: true });
    const v = Object.fromEntries(r.out.split('\n').flatMap((l) => (l.includes('=') ? [[l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const] : [])));
    const n = (x: string | undefined) => (x && /^\d{1,9}$/.test(x) ? Number(x) : 0);
    const dirty = n(v.dirty);
    const untracked = n(v.untracked);
    return { exists: true, branch: v.branch || null, dirty, untracked, unique: n(v.unique), needsForce: dirty + untracked > 0 };
  }

  /**
   * Removes a worktree's folder. `safe` refuses (409 `WORKTREE_DIRTY`, with what is there) when it has changes or untracked files;
   * `force` is only for a person who was told what goes. The branch is deleted only when fully merged: commits are never lost with the folder.
   */
  async remove(workspaceId: string, path: string, mode: 'safe' | 'force'): Promise<{ branchDeleted: boolean }> {
    const r = await this.run(workspaceId, ['wt-remove', path, mode]);
    if (r.code === HAS_CHANGES) {
      const status = await this.status(workspaceId, path).catch(() => null);
      throw new AppError(WORKTREE_DIRTY, 'It has changes that would be lost.', { status: 409, details: status ?? undefined });
    }
    if (r.code === REFUSED || r.code === NOT_A_REPO) return { branchDeleted: false }; // already gone, or not one to remove
    if (r.code !== 0) throw new AppError('SERVICE_UNAVAILABLE', `Couldn’t remove the worktree${errorLine(r.out) ? `: ${errorLine(r.out)}` : ''}.`, { expose: true });
    return { branchDeleted: /^branch=deleted$/m.test(r.out) };
  }

  /** The worktrees of the repository containing `folder`, as git lists them. */
  async list(workspaceId: string, folder: string): Promise<{ path: string; branch: string | null; head: string; detached: boolean; locked: boolean; prunable: boolean }[]> {
    const r = await this.run(workspaceId, ['wt-list', folder]);
    if (r.code !== 0) return [];
    try {
      const parsed: unknown = JSON.parse(r.out.trim() || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((w: Record<string, unknown>) =>
        typeof w.path === 'string' && w.path.startsWith('/')
          ? [{ path: w.path, branch: typeof w.branch === 'string' ? w.branch : null, head: typeof w.head === 'string' ? w.head : '', detached: w.detached === true, locked: w.locked === true, prunable: w.prunable === true }]
          : [],
      );
    } catch {
      return [];
    }
  }
}

const errorLine = (out: string) => /^#error (.*)$/m.exec(out)?.[1]?.trim() ?? '';

function parseMade(out: string): MadeWorktree | null {
  for (const line of out.split('\n')) {
    const f = line.split('\t');
    if (f[0] === 'ok' && f.length >= 6 && f[1]!.startsWith('/') && f[4]!.startsWith('/')) return { path: f[1]!, branch: f[2]!, commit: f[3]!, repo: f[4]!, rel: f[5]! };
  }
  return null;
}

function refusal(code: number | null, out: string, o: { folder: string; branch: string; base?: string | null }): AppError {
  switch (code) {
    case NOT_A_REPO:
      return new AppError('VALIDATION_FAILED', 'That folder isn’t in a git repository.', { details: { worktree: 'Pick a folder inside a git repository.' } });
    case BRANCH_IN_USE:
      return new AppError('CONFLICT', `${o.branch} is already checked out in another worktree.`, { details: { branch: 'In use: name another branch.' } });
    case NO_BASE:
      return new AppError('VALIDATION_FAILED', `This repository has no “${o.base ?? 'HEAD'}”.`, { details: { base: 'Not found in this repository.' } });
    case REFUSED:
      return new AppError('VALIDATION_FAILED', 'A worktree can’t be made there: pick a repository inside your home folder, not the home folder itself (and a parent folder outside the repository).', { details: { worktree: 'Not allowed here.' } });
    case PARENT_UNSEEN:
      // One answer for a folder that isn't there and one the caller may not see, so neither tells the other apart.
      return new AppError('NOT_FOUND', 'No such folder.', { details: { parent: 'Not found.' } });
    default: {
      const why = errorLine(out);
      return new AppError('SERVICE_UNAVAILABLE', `Couldn’t make the worktree${why ? `: ${why}` : ` (exit ${code ?? 'unknown'})`}.`, { expose: true });
    }
  }
}
