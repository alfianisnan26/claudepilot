// Events: what the hook and a portal merge write when a ref moves, and what the portal's poll reads (PRD FR5, FR9). One
// file per ref update, written whole under a temporary name and renamed, built with a JSON encoder, never by pasting a
// ref, a name or a message into text.

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CI_LIMITS } from '../limits.js';
import type { CiEventFile } from '../plan.js';
import { NULL_SHA } from '../plan.js';
import { ensureDir, eventsDir, gitRoot, nowIso, validEventId, validRef, validRepoName, validSha, writeAtomic } from './common.js';

const username = () => {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
};

export interface RefUpdate {
  old: string;
  new: string;
  ref: string;
}

/** Writes an event file for each update that is a branch or tag with a sane name; returns how many were written and how many were dropped. */
export function emitEvents(repo: string, updates: RefUpdate[], via: 'push' | 'portal', by?: string): { written: string[]; dropped: number } {
  ensureDir(eventsDir());
  const written: string[] = [];
  let dropped = 0;
  for (const u of updates) {
    if (written.length >= CI_LIMITS.eventsPerPush) {
      dropped++;
      continue;
    }
    if (!validRef(u.ref) || !validSha(u.old) || !validSha(u.new)) {
      dropped++;
      continue;
    }
    const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const ev: CiEventFile = { v: 1, id, at: nowIso(), repo, kind: u.new === NULL_SHA ? 'delete' : 'push', ref: u.ref, old: u.old, new: u.new, by: by ?? username(), via };
    writeAtomic(join(eventsDir(), `${id}.json`), JSON.stringify(ev));
    written.push(id);
  }
  return { written, dropped };
}

/** `cp-ci hook post-receive`: git's receive-pack runs it in the bare repository with `<old> <new> <ref>` lines on stdin. Never fails the push. */
export async function hookPostReceive(readStdin: () => Promise<string>): Promise<Record<string, unknown>> {
  const text = await readStdin();
  // The hook runs in the bare repository: its folder name is the remote's, and it must be one of ours.
  const cwd = realpathSync(process.cwd());
  const repo = basename(cwd).replace(/\.git$/, '');
  if (!validRepoName(repo) || !existsSync(gitRoot()) || dirname(cwd) !== realpathSync(gitRoot())) return { ok: false, error: 'not_a_remote', message: 'This is not one of the portal\'s remotes.' };
  const updates: RefUpdate[] = [];
  for (const line of text.split('\n').slice(0, 5000)) {
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S.*)$/.exec(line);
    if (m) updates.push({ old: m[1]!, new: m[2]!, ref: m[3]! });
  }
  const r = emitEvents(repo, updates, 'push');
  return { ok: true, events: r.written.length, dropped: r.dropped };
}

/** Pending events, oldest first. A file that isn't a valid event is moved aside (`bad/`), never left to be read again. */
export function pendingEvents(max: number): CiEventFile[] {
  const dir = eventsDir();
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir)
    .filter((n) => n.endsWith('.json') && validEventId(n.slice(0, -5)))
    .sort()
    .slice(0, max);
  const out: CiEventFile[] = [];
  for (const n of names) {
    const path = join(dir, n);
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size > 16_384) throw new Error('size');
      const ev = JSON.parse(readFileSync(path, 'utf8')) as Partial<CiEventFile>;
      if (ev.v !== 1 || ev.id !== n.slice(0, -5) || !validRepoName(ev.repo) || !validRef(ev.ref) || !validSha(ev.old) || !validSha(ev.new) || (ev.kind !== 'push' && ev.kind !== 'delete') || typeof ev.at !== 'string' || typeof ev.by !== 'string' || (ev.via !== 'push' && ev.via !== 'portal')) throw new Error('shape');
      out.push({ v: 1, id: ev.id, at: ev.at.slice(0, 40), repo: ev.repo, kind: ev.kind, ref: ev.ref, old: ev.old, new: ev.new, by: ev.by.slice(0, 64), via: ev.via });
    } catch {
      ensureDir(join(dir, 'bad'));
      try {
        renameSync(path, join(dir, 'bad', n));
      } catch {
        // gone already
      }
    }
  }
  return out;
}

/** Moves acknowledged events to `done/`; an id that isn't one, or has no file, is skipped. */
export function ackEvents(ids: string[]): number {
  const dir = eventsDir();
  let n = 0;
  for (const id of ids) {
    if (!validEventId(id)) continue;
    const from = join(dir, `${id}.json`);
    if (!existsSync(from)) continue;
    ensureDir(join(dir, 'done'));
    try {
      renameSync(from, join(dir, 'done', `${id}.json`));
      n++;
    } catch {
      // another poll took it
    }
  }
  return n;
}

/** Deletes acknowledged and rejected events older than `days`. */
export function pruneEvents(days: number): number {
  let n = 0;
  const cutoff = Date.now() - days * 86_400_000;
  for (const sub of ['done', 'bad']) {
    const dir = join(eventsDir(), sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      try {
        const p = join(dir, name);
        if (statSync(p).mtimeMs < cutoff) {
          rmSync(p, { force: true });
          n++;
        }
      } catch {
        // gone already
      }
    }
  }
  return n;
}
