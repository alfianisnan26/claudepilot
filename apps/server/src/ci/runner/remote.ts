// Runners (T-557, local-git-ci PRD §23): what a workspace needs to run another workspace's run. The commit travels as a git bundle
// (written here on the SOURCE side, read back by the portal in chunks, written into a MIRROR on the runner, never into the runner's own
// remotes), and the run's secrets as a lease the supervisor reads and removes with the run. Everything goes through cp-ci's own stdin and
// replies, so it works on every runtime the portal reaches (Kubernetes, Docker, a Connect host) without knowing the runner's home path.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { CI_LIMITS } from '../limits.js';
import { ciRoot, ensureDir, Fail, git, validRunId, validSha } from './common.js';
import { needRepo } from './repo.js';

/** A mirror's name: `m-<8 hex of the source workspace>-<remote name>`, so two workspaces' remotes of one name never mix. */
export const MIRROR_NAME = /^m-[0-9a-f]{8}-[a-z0-9][a-z0-9._-]{0,63}$/;
export const validMirror = (m: unknown): m is string => typeof m === 'string' && MIRROR_NAME.test(m) && !m.endsWith('.git') && !m.includes('..');
export const mirrorsDir = () => join(ciRoot(), 'mirrors');
export const mirrorDir = (m: string) => join(mirrorsDir(), `${m}.git`);
const outboxDir = () => join(ciRoot(), 'outbox');
const inboxDir = () => join(ciRoot(), 'inbox');
export const leasesDir = () => join(ciRoot(), 'leases');
export const leaseDir = (runId: string) => join(leasesDir(), runId);

/** A transfer's id is the run's id: one bundle per run, never a path from the caller. */
function needId(id: unknown): string {
  if (!validRunId(id)) throw new Fail('bad_run', 'That is not a run id.');
  return id;
}

/** The mirror's folder when it exists. */
export function needMirror(m: unknown): string {
  if (!validMirror(m)) throw new Fail('bad_name', 'That is not a mirror name.');
  const dir = mirrorDir(m);
  if (!existsSync(join(dir, 'HEAD'))) throw new Fail('no_repo', `There is no mirror named ${m}.`);
  return dir;
}

const MAX_HAVES = 50;
/** Refs a mirror keeps: one per run it received; older ones go (their objects stay reachable from the newer ones, or are gc'd by git). */
const KEEP_REFS = 50;

/* ---------- On the source workspace ---------- */

/**
 * `repo bundle <remote> <sha> --id <run> [--haves a,b]`: the commit and what it needs, minus what the runner said it has, as a bundle in
 * this workspace's outbox, base64 (the portal reads text). `empty` when the runner already has everything: nothing to send.
 */
export async function repoBundle(remote: unknown, sha: unknown, id: unknown, haves: string[]): Promise<Record<string, unknown>> {
  const dir = needRepo(remote);
  const run = needId(id);
  if (!validSha(sha)) throw new Fail('bad_sha', 'That is not a full commit hash.');
  const commit = await git(['cat-file', '-e', `${sha}^{commit}`], { gitDir: dir });
  if (commit.code !== 0) throw new Fail('no_commit', 'The remote does not have that commit.');
  // Only what this repository knows can be left out: an unknown hash would make `git bundle` fail.
  const known: string[] = [];
  for (const h of haves.filter(validSha).slice(0, MAX_HAVES)) if ((await git(['cat-file', '-e', `${h}^{commit}`], { gitDir: dir })).code === 0) known.push(h);
  if (known.includes(sha as string)) return { ok: true, empty: true };
  const ref = `refs/pilot-runner/${run}`;
  ensureDir(outboxDir());
  const path = join(outboxDir(), `${run}.bundle`);
  try {
    const set = await git(['update-ref', ref, sha as string], { gitDir: dir });
    if (set.code !== 0) throw new Fail('git_failed', 'Could not mark the commit for the bundle.');
    const made = await git(['bundle', 'create', '--quiet', path, ref, ...known.map((h) => `^${h}`)], { gitDir: dir, timeoutMs: 600_000 });
    if (made.code !== 0) {
      if (/empty bundle/i.test(made.stderr)) return { ok: true, empty: true };
      throw new Fail('git_failed', `Could not bundle the commit: ${made.stderr.trim().split('\n')[0] ?? 'git bundle failed'}`);
    }
    const size = statSync(path).size;
    if (size > CI_LIMITS.runnerBundleBytes) throw new Fail('too_large', `The commit needs a ${Math.round(size / 1048576)} MiB bundle; a runner takes at most ${CI_LIMITS.runnerBundleBytes / 1048576} MiB at once.`);
    writeFileSync(join(outboxDir(), `${run}.b64`), readFileSync(path).toString('base64'), { mode: 0o600 });
    return { ok: true, empty: false, bytes: statSync(join(outboxDir(), `${run}.b64`)).size };
  } finally {
    rmSync(path, { force: true });
    await git(['update-ref', '-d', ref], { gitDir: dir }).catch(() => undefined);
  }
}

/** `repo outbox <run> --offset N --max M [--drop]`: one chunk of a bundle's base64, or (with `--drop`) the bundle removed. */
export function outbox(id: unknown, offset: number, max: number, drop: boolean): Record<string, unknown> {
  const run = needId(id);
  const path = join(outboxDir(), `${run}.b64`);
  if (drop) {
    rmSync(path, { force: true });
    return { ok: true };
  }
  if (!existsSync(path)) throw new Fail('no_bundle', 'There is no bundle for that run.');
  const all = readFileSync(path);
  const data = all.subarray(offset, offset + max).toString('ascii');
  const next = Math.min(all.length, offset + max);
  return { ok: true, data, next, size: all.length, done: next >= all.length };
}

/* ---------- On the runner ---------- */

/** `mirror heads <mirror> [--sha S]`: what the runner's mirror has (the newest refs), and whether it has the commit already. */
export async function mirrorHeads(m: unknown, sha: string | undefined): Promise<Record<string, unknown>> {
  if (!validMirror(m)) throw new Fail('bad_name', 'That is not a mirror name.');
  const dir = mirrorDir(m);
  if (!existsSync(join(dir, 'HEAD'))) return { ok: true, exists: false, heads: [], has: false };
  const refs = await git(['for-each-ref', '--sort=-committerdate', `--count=${MAX_HAVES}`, '--format=%(objectname)', 'refs/pilot-runner/'], { gitDir: dir });
  const heads = [...new Set(refs.stdout.toString('utf8').split('\n').filter(validSha))];
  const has = sha && validSha(sha) ? (await git(['cat-file', '-e', `${sha}^{commit}`], { gitDir: dir })).code === 0 : false;
  return { ok: true, exists: true, heads, has };
}

/**
 * `mirror put <mirror> <run> <sha> --part N [--last] --bytes B`: one base64 chunk of the bundle on stdin; part 0 starts a new file. With
 * `--last`, the bundle goes into the mirror (made bare when it is new, with no hooks: nothing here reacts to it) and the commit is checked.
 */
export async function mirrorPut(m: unknown, id: unknown, sha: unknown, part: number, last: boolean, chunk: Buffer): Promise<Record<string, unknown>> {
  if (!validMirror(m)) throw new Fail('bad_name', 'That is not a mirror name.');
  const run = needId(id);
  if (!validSha(sha)) throw new Fail('bad_sha', 'That is not a full commit hash.');
  ensureDir(inboxDir());
  const path = join(inboxDir(), `${run}.bundle`);
  const bytes = Buffer.from(chunk.toString('ascii'), 'base64');
  if (part === 0) writeFileSync(path, bytes, { mode: 0o600 });
  else {
    if (!existsSync(path)) throw new Fail('no_bundle', 'The bundle\'s first part never arrived.');
    appendFileSync(path, bytes);
  }
  if (statSync(path).size > CI_LIMITS.runnerBundleBytes) {
    rmSync(path, { force: true });
    throw new Fail('too_large', 'The bundle is too large.');
  }
  if (!last) return { ok: true, part };
  try {
    const dir = mirrorDir(m);
    if (!existsSync(join(dir, 'HEAD'))) {
      mkdirSync(mirrorsDir(), { recursive: true, mode: 0o700 });
      const init = await git(['init', '--bare', '--quiet', dir]);
      if (init.code !== 0) throw new Fail('git_failed', 'Could not make the mirror.');
    }
    const check = await git(['bundle', 'verify', '--quiet', path], { gitDir: dir, timeoutMs: 600_000 });
    if (check.code !== 0) throw new Fail('bad_bundle', `The bundle does not apply: ${check.stderr.trim().split('\n')[0] ?? 'git bundle verify failed'}`);
    const fetched = await git(['fetch', '--quiet', '--no-tags', path, 'refs/pilot-runner/*:refs/pilot-runner/*'], { gitDir: dir, timeoutMs: 600_000 });
    if (fetched.code !== 0) throw new Fail('git_failed', `Could not take the bundle: ${fetched.stderr.trim().split('\n')[0] ?? 'git fetch failed'}`);
    if ((await git(['cat-file', '-e', `${sha}^{commit}`], { gitDir: dir })).code !== 0) throw new Fail('no_commit', 'The bundle did not bring the commit.');
    await pruneRefs(dir);
    return { ok: true, part, imported: true };
  } finally {
    rmSync(path, { force: true });
  }
}

async function pruneRefs(dir: string): Promise<void> {
  const refs = await git(['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/pilot-runner/'], { gitDir: dir });
  const names = refs.stdout.toString('utf8').split('\n').filter((r) => r.startsWith('refs/pilot-runner/'));
  for (const r of names.slice(KEEP_REFS)) await git(['update-ref', '-d', r], { gitDir: dir });
}

/* ---------- The secrets lease ---------- */

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `lease <run> --bytes B`: the run's secrets as JSON `{NAME: value}` on stdin (never in a command line), written one file per name, 0600,
 * in a 0700 folder of this run. The supervisor reads them instead of the workspace's Secrets & env files and removes the folder at the end;
 * `lease <run> --drop` removes it earlier (a run cancelled before it started), and gc removes a forgotten one after a day.
 */
export function leaseWrite(id: unknown, raw: Buffer): Record<string, unknown> {
  const run = needId(id);
  let x: unknown;
  try {
    x = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Fail('bad_lease', 'The lease is not JSON.');
  }
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Fail('bad_lease', 'The lease is a map of names to values.');
  const entries = Object.entries(x as Record<string, unknown>);
  if (entries.length > 20) throw new Fail('bad_lease', 'A run takes at most 20 secrets.');
  for (const [k, v] of entries) if (!SECRET_NAME.test(k) || k.startsWith('PILOT_') || typeof v !== 'string' || Buffer.byteLength(v) > 65_536) throw new Fail('bad_lease', 'A lease entry is not a name with a value.');
  const dir = leaseDir(run);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(leasesDir(), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  for (const [k, v] of entries) writeFileSync(join(dir, k), v as string, { mode: 0o600 });
  return { ok: true, count: entries.length };
}

export function leaseDrop(id: unknown): Record<string, unknown> {
  rmSync(leaseDir(needId(id)), { recursive: true, force: true });
  return { ok: true };
}

/** The leased values a job names, for the supervisor. A name the portal did not lease is an error that names only the name. */
export function leaseRead(runId: string, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(leaseDir(runId), name), 'utf8');
    } catch {
      throw new Error(`The secret ${name} was not handed to this runner. Assign it in Secrets & env to the repository's workspace.`);
    }
    out[name] = text;
  }
  return out;
}

/** gc: leases, bundles in and out older than a day (a run that never ended, a transfer that broke off). */
export function gcRemote(): number {
  let n = 0;
  const cutoff = Date.now() - 86_400_000;
  for (const d of [leasesDir(), inboxDir(), outboxDir()]) {
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      try {
        if (statSync(p).mtimeMs < cutoff) (rmSync(p, { recursive: true, force: true }), n++);
      } catch {
        // gone meanwhile
      }
    }
  }
  return n;
}
