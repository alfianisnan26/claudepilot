#!/usr/bin/env node
// The browser container's root init (browser & desktop PRD §10.1, §13 Users). It runs as root with every
// capability dropped but SETUID and SETGID, and does two things: starts the supervisor as uid 1001, and
// starts Chromium as uid 1000 when the supervisor asks, with a command line built here from the root-owned
// config. The supervisor can say "start" and "stop", nothing else, so a compromised supervisor can't run an
// arbitrary program as uid 1000, and a compromised renderer (uid 1000) can't touch the supervisor's files.
import { fork, spawn, spawnSync } from 'node:child_process';
import { chromeArgs, limitedRelay, loadConfig, log, UID_CHROME, UID_CPB } from './lib.mjs';

const cfg = loadConfig();
const headless = cfg.tier === 'headless';
const RUN = process.env.CPB_RUN || '/run/cpb';
const DISPLAY = process.env.CPB_DISPLAY || ':99';
const CHROME_BIN = process.env.CPB_CHROME_BIN || '/usr/bin/chromium';
const profileDir = cfg.profile === 'fresh' ? '/tmp/cpb-profile' : cfg.profileDir;

let supervisor = null;
let chrome = null; // { child, pid, stopping, timer }
let shuttingDown = false;
let supervisorFailures = 0;

const as = (uid) => ({ uid, gid: uid });

function tellSupervisor(msg) {
  try {
    if (supervisor?.connected) supervisor.send(msg);
  } catch {
    // the supervisor is going away; it asks again when it is back
  }
}

/** The profile folder, ready for a start: stale Singleton locks gone (no Chrome runs), a fresh profile emptied. */
function prepareProfile() {
  const script =
    cfg.profile === 'fresh'
      ? 'rm -rf "$P"; mkdir -m 0700 "$P"'
      : 'mkdir -p "$P" && chmod 0700 "$P" && rm -f "$P/SingletonLock" "$P/SingletonCookie" "$P/SingletonSocket"';
  const r = spawnSync('/bin/sh', ['-c', script], { ...as(UID_CHROME), env: { P: profileDir, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`profile folder ${profileDir}: ${(r.stderr || r.error?.message || 'failed').trim()}`);
}

function startChrome(id) {
  if (chrome) return tellSupervisor({ event: 'chrome-started', id, pid: chrome.pid, already: true });
  try {
    prepareProfile();
    const env = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/node',
      LANG: process.env.LANG || 'C.UTF-8',
      ...(headless ? {} : { DISPLAY, XAUTHORITY: `${RUN}/xauth` }),
    };
    const child = spawn(CHROME_BIN, chromeArgs(cfg, { headless, profileDir }), { ...as(UID_CHROME), env, stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = limitedRelay('[chrome]');
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    const me = { child, pid: child.pid, stopping: false, timer: null };
    chrome = me;
    child.once('error', (e) => {
      chrome = null;
      tellSupervisor({ event: 'chrome-failed', id, error: e.message });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(me.timer);
      if (chrome === me) chrome = null;
      log(`chrome exited (${signal ?? code})`);
      tellSupervisor({ event: 'chrome-exit', code, signal, expected: me.stopping });
    });
    child.once('spawn', () => tellSupervisor({ event: 'chrome-started', id, pid: child.pid }));
  } catch (e) {
    chrome = null;
    log('chrome start failed:', e.message);
    tellSupervisor({ event: 'chrome-failed', id, error: e.message });
  }
}

function stopChrome({ force } = {}) {
  const me = chrome;
  if (!me) return;
  me.stopping = true;
  me.child.kill(force ? 'SIGKILL' : 'SIGTERM');
  clearTimeout(me.timer);
  me.timer = setTimeout(() => me.child.kill('SIGKILL'), 5000);
  me.timer.unref();
}

function startSupervisor() {
  const child = fork('/opt/cpb/supervisor.mjs', [], {
    ...as(UID_CPB),
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: process.env.LANG || 'C.UTF-8', NODE_OPTIONS: process.env.NODE_OPTIONS || '' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  supervisor = child;
  const startedAt = Date.now();
  child.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.op === 'chrome-start') startChrome(m.id);
    else if (m.op === 'chrome-stop') stopChrome({ force: m.force === true });
  });
  child.once('exit', (code, signal) => {
    if (supervisor === child) supervisor = null;
    if (shuttingDown) return;
    // A supervisor that lived a while is a one-off; one that dies at once is backed off.
    supervisorFailures = Date.now() - startedAt > 30_000 ? 0 : supervisorFailures + 1;
    const wait = Math.min(10_000, 500 * 2 ** supervisorFailures);
    log(`supervisor exited (${signal ?? code}); restarting in ${wait} ms`);
    setTimeout(startSupervisor, wait);
  });
  // Chrome may still be running from before the supervisor's restart: it adopts it.
  child.once('spawn', () => tellSupervisor({ event: 'hello', chrome: chrome ? { running: true, pid: chrome.pid } : { running: false } }));
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}: closing`);
  // The supervisor closes Chrome through CDP so cookies flush; ours is the backstop.
  if (supervisor) supervisor.kill('SIGTERM');
  setTimeout(() => stopChrome(), 3000).unref();
  const done = setInterval(() => {
    if (!chrome && !supervisor) process.exit(0);
  }, 100);
  done.unref();
  setTimeout(() => process.exit(0), 9000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log(`cpb init: tier ${cfg.tier}, display ${cfg.display.width}x${cfg.display.height}, profile ${cfg.profile}, sandbox ${cfg.sandbox ? 'on' : 'OFF'}`);
startSupervisor();
