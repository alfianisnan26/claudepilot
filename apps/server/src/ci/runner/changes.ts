// `changes <repo> <base> <head> [--show <path>]` (T-110, PRD FR41a): the paths that differ between two commits, which the auto-approve rule
// reads in its dry run, and optionally one file's text at both commits (the migrations file, to tell a new migration from an edit of a
// released one). Read with git plumbing on the bare repository, so no repository code runs. Bounded: past the caps the answer says so
// (`truncated`, `too_large`) and the portal treats the diff as unreadable, never as empty.

import { Fail, git, validSha } from './common.js';
import { needRepo } from './repo.js';

/** At most this many paths are listed; more is reported as `truncated`. */
export const CHANGES_MAX_PATHS = 5000;
/** The most a `--show` file may be, per side. */
export const CHANGES_SHOW_BYTES = 1024 * 1024;

const SHOW_PATH = /^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,199}$/;

async function fileAt(dir: string, sha: string, path: string): Promise<{ text: string | null; tooLarge: boolean }> {
  const r = await git(['cat-file', 'blob', `${sha}:${path}`], { gitDir: dir, maxBytes: CHANGES_SHOW_BYTES + 1 });
  // Not in that commit (a file added or removed): null, which is a fact, not a failure.
  if (r.code !== 0) return { text: null, tooLarge: false };
  if (r.stdout.length > CHANGES_SHOW_BYTES) return { text: null, tooLarge: true };
  return { text: r.stdout.toString('utf8'), tooLarge: false };
}

export async function changes(repo: unknown, base: unknown, head: unknown, show?: string): Promise<Record<string, unknown>> {
  const dir = needRepo(repo);
  if (!validSha(base) || !validSha(head)) throw new Fail('bad_sha', 'That is not a commit id.');
  if (show !== undefined && (!SHOW_PATH.test(show) || show.includes('..') || show.includes('//') || show.endsWith('/'))) throw new Fail('bad_path', 'That is not a file path in the repository.');
  for (const sha of [base, head]) {
    const r = await git(['cat-file', '-e', `${sha}^{commit}`], { gitDir: dir });
    if (r.code !== 0) throw new Fail('no_commit', `There is no commit ${sha.slice(0, 7)} in ${repo as string}.`);
  }
  const d = await git(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', base, head], { gitDir: dir, maxBytes: 4 * 1024 * 1024 });
  if (d.code !== 0) throw new Fail('git_failed', d.stderr.trim().split('\n')[0]?.slice(0, 300) || 'git diff failed');
  const all = d.stdout.toString('utf8').split('\0').filter(Boolean);
  const ancestor = (await git(['merge-base', '--is-ancestor', base, head], { gitDir: dir })).code === 0;
  const out: Record<string, unknown> = { ok: true, paths: all.slice(0, CHANGES_MAX_PATHS), truncated: all.length > CHANGES_MAX_PATHS, ancestor };
  if (show !== undefined) {
    const [b, h] = await Promise.all([fileAt(dir, base, show), fileAt(dir, head, show)]);
    out.show = { path: show, base: b.text, head: h.text, tooLarge: b.tooLarge || h.tooLarge };
  }
  return out;
}
