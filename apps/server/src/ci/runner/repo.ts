// Local remotes (PRD FR1 to FR8): bare repositories under ~/.claudepilot/git, the hook that records pushes, wiring a working
// repository to one, listing branches, and the portal's merge. Every git call takes an argument array; every path and name
// is checked first.

import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { bareDir, ensureDir, Fail, git, gitRoot, gitText, inside, rootDir, validRef, validRefName, validRepoName, validSha } from './common.js';
import { emitEvents } from './events.js';

/** The hook stub (PRD FR4): calls the runner by the absolute path it was installed at, and never blocks a push. */
export function hookText(self: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(self)) throw new Fail('bad_runner_path', 'The runner is at a path that can not go in a hook.');
  return `#!/bin/sh\n# claudepilot: written by the portal and rewritten when a workspace starts. Records the push; never blocks it.\n'${self}' hook post-receive >/dev/null 2>&1 || true\n`;
}

export type HookState = 'ok' | 'outdated' | 'missing';

export function hookState(repo: string, self: string): HookState {
  const path = join(bareDir(repo), 'hooks', 'post-receive');
  if (!existsSync(path)) return 'missing';
  try {
    if (readFileSync(path, 'utf8') !== hookText(self)) return 'outdated';
    return (statSync(path).mode & 0o111) !== 0 ? 'ok' : 'outdated';
  } catch {
    return 'missing';
  }
}

/** Writes the hook. A bare repository whose configuration points hooks somewhere else is reported as outdated, since the hook there would not run. */
export async function ensureHooks(repo: string, self: string): Promise<HookState> {
  const dir = join(bareDir(repo), 'hooks');
  ensureDir(dir, 0o755);
  const path = join(dir, 'post-receive');
  writeFileSync(path, hookText(self), { mode: 0o755 });
  chmodSync(path, 0o755);
  // What git would really use: the repository's, the user's and the system's configuration, not our own overrides.
  const hooksPath = await git(['config', '--get', 'core.hooksPath'], { gitDir: bareDir(repo), raw: true });
  return hooksPath.code === 0 && hooksPath.stdout.toString('utf8').trim() ? 'outdated' : 'ok';
}

/** The repository's folder when it exists and is one of ours. */
export function needRepo(repo: unknown): string {
  if (!validRepoName(repo)) throw new Fail('bad_name', 'A remote\'s name is lowercase letters, digits, . _ and -, up to 64.');
  const dir = bareDir(repo);
  if (!existsSync(join(dir, 'HEAD'))) throw new Fail('no_repo', `There is no remote named ${repo}.`);
  return dir;
}

/** A working repository's top folder, for a path the portal was given: absolute, real, under the home folder, never the portal's own. */
async function workingRepo(path: unknown): Promise<string> {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) throw new Fail('bad_path', 'Give an absolute path.');
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new Fail('no_path', 'That folder does not exist.');
  }
  const home = realpathSync(homedir());
  if (!inside(home, real) || real === home || inside(join(home, '.claudepilot'), real) || inside('/etc/claudepilot', real)) throw new Fail('bad_path', 'That folder is not one a remote can be made from.');
  if (!statSync(real).isDirectory()) throw new Fail('bad_path', 'That is not a folder.');
  const top = await gitText(['rev-parse', '--show-toplevel'], { cwd: real }, 'not_a_repo');
  const topReal = realpathSync(top);
  if (!inside(home, topReal) || inside(join(home, '.claudepilot'), topReal)) throw new Fail('bad_path', 'That repository is not one a remote can be made from.');
  return topReal;
}

export interface RepoInfo {
  name: string;
  path: string;
  defaultBranch: string;
  branches: number;
  hook: HookState;
}

async function info(repo: string, self: string): Promise<RepoInfo> {
  const dir = needRepo(repo);
  const head = await git(['symbolic-ref', '--short', 'HEAD'], { gitDir: dir });
  const refs = await git(['for-each-ref', '--format=%(refname)', 'refs/heads'], { gitDir: dir });
  return { name: repo, path: dir, defaultBranch: head.code === 0 ? head.stdout.toString('utf8').trim() : 'main', branches: refs.stdout.toString('utf8').split('\n').filter(Boolean).length, hook: hookState(repo, self) };
}

export const repoInfo = info;

export async function repoList(self: string): Promise<RepoInfo[]> {
  if (!existsSync(gitRoot())) return [];
  const out: RepoInfo[] = [];
  for (const entry of readdirSync(gitRoot())) {
    if (!entry.endsWith('.git')) continue;
    const name = entry.slice(0, -4);
    if (!validRepoName(name) || !existsSync(join(gitRoot(), entry, 'HEAD'))) continue;
    out.push(await info(name, self));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** `repo create <name> [--from <path>] [--branch <name>] [--connect]` (PRD FR1, FR2). */
export async function repoCreate(name: unknown, opts: { from?: string; branch?: string; connect?: boolean }, self: string): Promise<Record<string, unknown>> {
  if (!validRepoName(name)) throw new Fail('bad_name', 'A remote\'s name is lowercase letters, digits, . _ and -, up to 64.');
  const branch = opts.branch ?? 'main';
  if (!validRefName(branch)) throw new Fail('bad_branch', 'That is not a branch name.');
  const dir = bareDir(name);
  if (existsSync(dir)) throw new Fail('exists', `There is already a remote named ${name}.`);
  if (existsSync(gitRoot()) && readdirSync(gitRoot()).filter((e) => e.endsWith('.git')).length >= 20) throw new Fail('too_many', 'A workspace has at most 20 remotes.');
  ensureDir(rootDir(), 0o755);
  ensureDir(gitRoot(), 0o755);
  const source = opts.from === undefined ? null : await workingRepo(opts.from);
  try {
    if (source) {
      const r = await git(['clone', '--bare', '--no-hardlinks', '--quiet', source, dir], { timeoutMs: 600_000 });
      if (r.code !== 0) throw new Fail('clone_failed', r.stderr.trim().split('\n')[0] ?? 'The clone failed.');
      // A clone of a repository on a detached head, or on a branch it doesn't have yet, has no usable default: pick one.
      const heads = (await gitText(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { gitDir: dir })).split('\n').filter(Boolean);
      const head = await git(['symbolic-ref', '--short', 'HEAD'], { gitDir: dir });
      const current = head.code === 0 ? head.stdout.toString('utf8').trim() : '';
      if (!heads.includes(current)) {
        const pick = heads.includes(branch) ? branch : heads.includes('main') ? 'main' : heads.includes('master') ? 'master' : heads[0];
        if (pick) await gitText(['symbolic-ref', 'HEAD', `refs/heads/${pick}`], { gitDir: dir });
      }
    } else {
      await gitText(['init', '--bare', '--quiet', `--initial-branch=${branch}`, dir], {}, 'init_failed');
    }
    // A bare clone remembers where it came from; nothing should ever fetch from there into it.
    await git(['remote', 'remove', 'origin'], { gitDir: dir });
    // Pushes into it are the only way things change; refuse a push that would delete the branch it points at.
    await gitText(['config', 'receive.denyDeleteCurrent', 'true'], { gitDir: dir });
    const hook = await ensureHooks(name, self);
    let connected: string | null = null;
    if (source && opts.connect) connected = (await connect(name, source, self)).path as string;
    return { ok: true, ...(await info(name, self)), hook, connected };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Gives a working repository a remote named `pilot` that points at the bare one (PRD FR2, FR3). Nothing else of its configuration is touched. */
async function connect(repo: string, path: unknown, self: string): Promise<Record<string, unknown>> {
  const dir = needRepo(repo);
  const top = await workingRepo(path);
  const current = await git(['remote', 'get-url', 'pilot'], { cwd: top });
  let action: 'added' | 'updated' | 'unchanged';
  if (current.code !== 0) {
    await gitText(['remote', 'add', 'pilot', dir], { cwd: top });
    action = 'added';
  } else if (resolve(current.stdout.toString('utf8').trim()) === dir) action = 'unchanged';
  else {
    await gitText(['remote', 'set-url', 'pilot', dir], { cwd: top });
    action = 'updated';
  }
  await ensureHooks(repo, self);
  return { ok: true, path: top, action };
}

export const repoConnect = connect;

export function repoDelete(repo: unknown): Record<string, unknown> {
  const dir = needRepo(repo);
  // The folder must be exactly ours: a real path directly under the git root.
  if (realpathSync(dir) !== join(realpathSync(gitRoot()), `${repo as string}.git`)) throw new Fail('bad_path', 'That folder is not where remotes live.');
  rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

/** `branches <repo> [--limit n]`: heads, newest first, with their tip's subject and time. */
export async function repoBranches(repo: unknown, limit: number): Promise<Record<string, unknown>> {
  const dir = needRepo(repo);
  const r = await git(['for-each-ref', '--sort=-committerdate', `--count=${Math.max(1, Math.min(limit, 500))}`, '--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)%00%(subject)', 'refs/heads'], { gitDir: dir });
  const branches = r.stdout
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, sha, at, subject] = line.split('\0');
      return { name: name ?? '', sha: sha ?? '', at: at ?? '', subject: (subject ?? '').slice(0, 200) };
    })
    .filter((b) => validRefName(b.name) && validSha(b.sha));
  return { ok: true, branches };
}

/** `rev <repo> <ref>`: the commit a branch or tag points at. */
export async function repoRev(repo: unknown, ref: unknown): Promise<Record<string, unknown>> {
  const dir = needRepo(repo);
  if (!validRef(ref)) throw new Fail('bad_ref', 'That is not a branch or tag.');
  const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { gitDir: dir });
  if (r.code !== 0) throw new Fail('no_ref', `There is no ${ref.replace(/^refs\/(heads|tags)\//, '')} in ${repo as string}.`);
  return { ok: true, sha: r.stdout.toString('utf8').trim() };
}

/**
 * The portal's merge (PRD FR8): a fast-forward when the target is an ancestor of the source, otherwise a merge commit made
 * with plumbing, so no working tree and no hook runs. The target moves with a compare-and-swap; the same event a push would
 * write follows, so one path turns merges into runs.
 */
export async function repoMerge(
  repo: unknown,
  opts: { source: unknown; target: unknown; strategy?: string; expect?: string; message?: string; author?: string },
): Promise<Record<string, unknown>> {
  const dir = needRepo(repo);
  if (!validRefName(opts.source) || !validRefName(opts.target)) throw new Fail('bad_branch', 'That is not a branch name.');
  const strategy = opts.strategy ?? 'merge';
  if (strategy !== 'ff' && strategy !== 'merge') throw new Fail('bad_strategy', 'The strategy is ff or merge.');
  if (opts.source === opts.target) throw new Fail('same_branch', 'A branch can not be merged into itself.');
  const srcRef = `refs/heads/${opts.source}`;
  const dstRef = `refs/heads/${opts.target}`;
  const rev = async (ref: string, what: string) => {
    const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { gitDir: dir });
    if (r.code !== 0) throw new Fail('no_branch', `There is no branch ${what}.`);
    return r.stdout.toString('utf8').trim();
  };
  const src = await rev(srcRef, opts.source);
  const dst = await rev(dstRef, opts.target);
  if (opts.expect !== undefined && opts.expect !== dst) throw new Fail('moved', `${opts.target} has moved since it was read.`, { current: dst });
  const ancestor = async (a: string, b: string) => (await git(['merge-base', '--is-ancestor', a, b], { gitDir: dir })).code === 0;
  if (await ancestor(src, dst)) return { ok: true, sha: dst, strategy: 'ff', alreadyMerged: true, old: dst };

  let sha: string;
  let used: 'ff' | 'merge';
  if (await ancestor(dst, src)) {
    sha = src;
    used = 'ff';
  } else {
    if (strategy === 'ff') throw new Fail('not_ff', `${opts.target} has commits that ${opts.source} lacks, so it can not be fast-forwarded.`);
    const tree = await git(['merge-tree', '--write-tree', '--name-only', dst, src], { gitDir: dir });
    const lines = tree.stdout.toString('utf8').split('\n');
    if (tree.code === 1) {
      // First line the tree, then the conflicted paths up to a blank line, then messages.
      const files: string[] = [];
      for (const l of lines.slice(1)) {
        if (!l) break;
        files.push(l);
      }
      throw new Fail('conflict', `${opts.source} conflicts with ${opts.target} in ${files.length} file${files.length === 1 ? '' : 's'}.`, { files: files.slice(0, 50) });
    }
    if (tree.code !== 0 || !validSha(lines[0]?.trim())) throw new Fail('merge_failed', tree.stderr.trim().split('\n')[0] || 'git could not merge these.');
    const message = (opts.message ?? `Merge branch '${opts.source}' into ${opts.target}`).slice(0, 4000);
    const who = (opts.author ?? 'Claudepilot').replace(/[<>\n\0]/g, '').slice(0, 60) || 'Claudepilot';
    const commit = await gitText(['commit-tree', lines[0]!.trim(), '-p', dst, '-p', src, '-m', message], { gitDir: dir, env: { GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: 'claudepilot@localhost', GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: 'claudepilot@localhost' } }, 'merge_failed');
    if (!validSha(commit)) throw new Fail('merge_failed', 'git did not make a commit.');
    sha = commit;
    used = 'merge';
  }
  // The compare-and-swap: only moves the branch if it is still where we read it.
  const move = await git(['update-ref', '-m', `merge ${opts.source}`, dstRef, sha, dst], { gitDir: dir });
  if (move.code !== 0) throw new Fail('moved', `${opts.target} moved while it was being merged. Try again.`);
  emitEvents(repo as string, [{ ref: dstRef, old: dst, new: sha }], 'portal');
  return { ok: true, sha, strategy: used, alreadyMerged: false, old: dst };
}
