#!/usr/bin/env node
// Process signals and stale locks for the browser container (browser & desktop PRD §10.1, T-1660). Dependency-free Node, used by the
// root init and the supervisor, and as a CLI run by the init as Chrome's user (`node procs.mjs profile <dir> <fresh|persistent>`).
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';

const log = (...args) => console.log(new Date().toISOString().slice(11, 23), ...args);

/** A process's name from `/proc` (the container's own pid namespace), or null when there is no such process. */
export function processName(pid) {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Sends `signal` to a child that runs as another user, and never throws. The root init holds no CAP_KILL, so its own `child.kill()` gets
 * EPERM for Chrome (uid 1000), which Node emits as an 'error' event: unhandled, that crashed the init and restarted the container (T-1660).
 * So the signal goes through `/bin/kill` run as the child's own user. True when it was delivered.
 */
export function signalAs(child, signal, { uid, run = spawnSync } = {}) {
  const pid = child?.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return false;
  try {
    const r = run('/bin/kill', ['-s', String(signal).replace(/^SIG/, ''), String(pid)], { uid, gid: uid, encoding: 'utf8', timeout: 5000 });
    if (r?.status === 0) return true;
    log(`kill ${signal} ${pid} failed:`, String(r?.stderr || r?.error?.message || `exit ${r?.status}`).trim().slice(0, 200));
  } catch (e) {
    log(`kill ${signal} ${pid} failed:`, e?.message ?? String(e));
  }
  return false;
}

/**
 * The X display's lock (`/tmp/.X99-lock`) and socket, removed when no X server owns them. `/tmp` outlives a container restart on
 * Kubernetes (an emptyDir), so a display killed with its container leaves the lock and the next Xvnc refuses to start. A lock whose pid
 * is a live X server stays. Returns `none`, `live`, `removed` or `stuck` (not ours to remove).
 */
export function clearStaleXLock(display, { tmp = '/tmp', name = processName } = {}) {
  const n = String(display).replace(/^:/, '');
  const lock = `${tmp}/.X${n}-lock`;
  let text;
  try {
    text = readFileSync(lock, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return 'none';
    text = '';
  }
  const pid = Number.parseInt(text.trim(), 10);
  if (pid > 0 && /^X/.test(name(pid) ?? '')) return 'live';
  try {
    rmSync(lock, { force: true });
    rmSync(`${tmp}/.X11-unix/X${n}`, { force: true });
  } catch {
    return 'stuck';
  }
  return 'removed';
}

const SINGLETONS = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

/**
 * Chrome's `Singleton*` links in a profile, removed unless a live Chrome owns them. `SingletonLock` points at `<host>-<pid>`: the owner is
 * live when it is this host and that pid is a Chromium process. A lock from another host (the pod before this one) is stale: left there,
 * a headed Chrome would hold a "profile in use" dialog before CDP listens. Returns `{ live: pid }` or `{ live: null, removed: [...] }`.
 */
export function clearStaleSingleton(dir, { host = hostname(), name = processName } = {}) {
  let target = null;
  try {
    target = readlinkSync(`${dir}/SingletonLock`);
  } catch {
    // no lock, or not a link
  }
  const m = target ? /^(.+)-(\d+)$/.exec(target) : null;
  if (m && m[1] === host && /chrom/i.test(name(Number(m[2])) ?? '')) return { live: Number(m[2]) };
  const removed = [];
  for (const f of SINGLETONS) {
    try {
      readlinkSync(`${dir}/${f}`);
      removed.push(f);
    } catch {
      // absent
    }
    rmSync(`${dir}/${f}`, { force: true });
  }
  return { live: null, removed };
}

/** The profile folder, ready for a start (run as Chrome's user): made 0700, stale Singleton links gone, a fresh profile emptied. */
export function prepareProfileDir(dir, profile, opts = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const r = clearStaleSingleton(dir, opts);
  if (r.live) return r;
  if (profile === 'fresh') {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
  } else chmodSync(dir, 0o700);
  return r;
}

// `node procs.mjs profile <dir> <fresh|persistent>`: prints `{ live, removed }`; exits 3 when a live Chrome holds the profile.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'profile') {
  try {
    const r = prepareProfileDir(process.argv[3], process.argv[4]);
    process.stdout.write(`${JSON.stringify(r)}\n`);
    process.exit(r.live ? 3 : 0);
  } catch (e) {
    process.stderr.write(`profile ${process.argv[3]}: ${e.message}\n`);
    process.exit(1);
  }
}
