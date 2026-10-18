#!/usr/bin/env node
// The browser container's root init (browser & desktop PRD §10.1, §13 Users). It runs as root with every
// capability dropped but SETUID and SETGID, and does two things: starts the supervisor as uid 1001, and
// starts Chromium as uid 1000 when the supervisor asks, with a command line built here from the root-owned
// config. The supervisor can say "start" and "stop", nothing else, so a compromised supervisor can't run an
// arbitrary program as uid 1000, and a compromised renderer (uid 1000) can't touch the supervisor's files.
import { fork, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { EXT_DIR } from './headers-ext.mjs';
import { guardSignals, safeKill } from './heal.mjs';
import { chromeArgs, limitedRelay, loadConfig, log, UID_CHROME, UID_CPB } from './lib.mjs';

const cfg = loadConfig();
const headless = cfg.tier === 'headless';
const RUN = process.env.CPB_RUN || '/run/cpb';
const DISPLAY = process.env.CPB_DISPLAY || ':99';
const CHROME_BIN = process.env.CPB_CHROME_BIN || '/usr/bin/chromium';
const HEADERS_FILE = process.env.CPB_HEADERS_FILE || '/etc/cpb-secrets/headers.json';
const HEADERS_EXT = process.env.CPB_HEADERS_EXT || '/opt/cpb/headers-ext.mjs';
const profileDir = cfg.profile === 'fresh' ? '/tmp/cpb-profile' : cfg.profileDir;

let supervisor = null;
let chrome = null; // { child, pid, stopping, timer }
let shuttingDown = false;
let supervisorFailures = 0;

const as = (uid) => ({ uid, gid: uid });

/**
 * Kubernetes (PRD §10.2): no tmpfs with an owner, only `emptyDir`s, which the kubelet makes root-owned and writable by everyone. This
 * root init owns them, so it can set their modes without CAP_FOWNER: `/tmp` gets the sticky bit and the X socket folder, and the
 * supervisor's folder `/run/cpb` is made by uid 1001 itself (no CAP_CHOWN here) inside a `/run` nobody else can write to, so Chrome
 * (uid 1000) can't put a socket of its own where the supervisor's control and VNC sockets live.
 */
function prepareKubernetesFolders() {
  chmodSync('/tmp', 0o1777);
  mkdirSync('/tmp/.X11-unix', { recursive: true, mode: 0o1777 });
  chmodSync('/tmp/.X11-unix', 0o1777);
  chmodSync('/run', 0o1777);
  const r = spawnSync('/bin/mkdir', ['-p', '-m', '0711', RUN], { ...as(UID_CPB), encoding: 'utf8' });
  chmodSync('/run', 0o755);
  if (r.status !== 0) throw new Error(`${RUN}: ${(r.stderr || r.error?.message || 'mkdir failed').trim()}`);
}
if (process.env.CPB_K8S === '1') {
  try {
    prepareKubernetesFolders();
  } catch (e) {
    log('kubernetes folders:', e.message);
  }
}

/**
 * `sandbox: auto`: one headless page with Chromium's sandbox, as Chrome's user, before the first start. A node whose seccomp profile or
 * kernel refuses user namespaces answers "No usable sandbox"; then Chrome runs without it, unless the pool requires it (PRD §13).
 */
let sandboxProbed = false;
function settleSandbox() {
  if (!cfg.sandboxAuto) return;
  if (sandboxProbed) {
    if (!cfg.sandbox && cfg.requireSandbox) throw new Error('Chromium’s sandbox can’t start on this node, and the pool requires it.');
    return;
  }
  const r = spawnSync(CHROME_BIN, ['--headless=new', '--disable-gpu', '--user-data-dir=/tmp/cpb-probe', '--dump-dom', 'about:blank'], {
    ...as(UID_CHROME),
    env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
    encoding: 'utf8',
    timeout: 45_000,
  });
  spawnSync('/bin/rm', ['-rf', '/tmp/cpb-probe'], as(UID_CHROME));
  const works = r.status === 0 && /<html/i.test(r.stdout ?? '') && !/No usable sandbox/i.test(`${r.stdout}${r.stderr}`);
  sandboxProbed = true;
  cfg.sandbox = works;
  log(`sandbox probe: ${works ? 'on' : 'unavailable, running without it'}`);
  if (!works && cfg.requireSandbox) throw new Error('Chromium’s sandbox can’t start on this node, and the pool requires it.');
}

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

/**
 * Request headers from named secrets (PRD §24). `/etc/cpb-secrets/headers.json` is root-only, written by the portal; here, as root, it is
 * read and its entries go by stdin to a uid 1000 child that writes the extension (files 0400, in memory, rebuilt at every start, so a
 * removed header is gone at the next start). Returns the extension's folder, or null when there are no headers. Only names and counts are
 * logged, never a value, and a bad file only costs the headers: Chromium starts without them.
 */
function prepareHeaders({ skip = false } = {}) {
  let entries;
  if (skip) {
    // The supervisor asked for a start without headers (T-921 self-heal): clear the extension and say so.
    log('headers: skipped for this start (the supervisor asked for a start without them)');
    spawnSync(process.execPath, [HEADERS_EXT, 'write', EXT_DIR], { ...as(UID_CHROME), input: '[]', encoding: 'utf8' });
    return null;
  }
  try {
    entries = JSON.parse(readFileSync(HEADERS_FILE, 'utf8'));
  } catch (e) {
    if (e?.code !== 'ENOENT') log('headers file unreadable, starting without headers:', e instanceof SyntaxError ? 'not JSON' : e.message);
    spawnSync(process.execPath, [HEADERS_EXT, 'write', EXT_DIR], { ...as(UID_CHROME), input: '[]', encoding: 'utf8' });
    return null;
  }
  const r = spawnSync(process.execPath, [HEADERS_EXT, 'write', EXT_DIR], { ...as(UID_CHROME), input: JSON.stringify(entries), encoding: 'utf8' });
  if (r.status !== 0) {
    log('headers extension not built:', (r.stderr || r.error?.message || 'failed').trim().slice(0, 200));
    return null;
  }
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1) || '{}');
  log(`headers: ${out.count} rule(s)${out.dropped?.length ? `, dropped: ${out.dropped.join(', ')}` : ''}`);
  return out.count ? EXT_DIR : null;
}

function startChrome(id, { headers = true } = {}) {
  if (chrome) return tellSupervisor({ event: 'chrome-started', id, pid: chrome.pid, already: true });
  try {
    settleSandbox();
    prepareProfile();
    const extensionDir = prepareHeaders({ skip: !headers });
    const env = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/node',
      LANG: process.env.LANG || 'C.UTF-8',
      ...(headless ? {} : { DISPLAY, XAUTHORITY: `${RUN}/xauth` }),
    };
    const child = spawn(CHROME_BIN, chromeArgs(cfg, { headless, profileDir, extensionDir }), { ...as(UID_CHROME), env, stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = limitedRelay('[chrome]');
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    const me = { child, pid: child.pid, stopping: false, timer: null };
    chrome = me;
    // Node reports a refused signal (EPERM) as an 'error' event on the child, not a throw: with no listener left it took the init down
    // (T-921). A persistent listener: a signal error is logged and sent again as Chrome's uid, only a spawn error fails the start.
    guardSignals(child, {
      name: 'chrome',
      log,
      asChrome: killAsChrome,
      onError: (e) => {
        if (chrome === me) chrome = null;
        tellSupervisor({ event: 'chrome-failed', id, error: e.message });
      },
    });
    child.once('exit', (code, signal) => {
      clearTimeout(me.timer);
      if (chrome === me) chrome = null;
      log(`chrome exited (${signal ?? code})`);
      tellSupervisor({ event: 'chrome-exit', code, signal, expected: me.stopping });
    });
    child.once('spawn', () => tellSupervisor({ event: 'chrome-started', id, pid: child.pid, sandbox: cfg.sandbox, headers: extensionDir !== null }));
  } catch (e) {
    chrome = null;
    log('chrome start failed:', e.message);
    tellSupervisor({ event: 'chrome-failed', id, error: e.message });
  }
}

/** The init has no CAP_KILL: a signal to uid 1000 can be refused (EPERM). A helper running as Chrome's own uid can always send it. */
function killAsChrome(pid, signal) {
  const r = spawnSync(process.execPath, ['-e', 'process.kill(Number(process.argv[1]), process.argv[2])', String(pid), signal], { ...as(UID_CHROME), timeout: 5000 });
  return r.status === 0;
}
const killer = { log, asChrome: killAsChrome };

function stopChrome({ force } = {}) {
  const me = chrome;
  if (!me) return;
  me.stopping = true;
  safeKill(me.child, force ? 'SIGKILL' : 'SIGTERM', killer);
  clearTimeout(me.timer);
  me.timer = setTimeout(() => safeKill(me.child, 'SIGKILL', killer), 5000);
  me.timer.unref();
}

function startSupervisor() {
  const child = fork('/opt/cpb/supervisor.mjs', [], {
    ...as(UID_CPB),
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: process.env.LANG || 'C.UTF-8', NODE_OPTIONS: process.env.NODE_OPTIONS || '' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  supervisor = child;
  guardSignals(child, { name: 'supervisor', log, onError: (e) => log(`supervisor process error (${e?.code ?? 'unknown'})`) });
  const startedAt = Date.now();
  child.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.op === 'chrome-start') startChrome(m.id, { headers: m.headers !== false });
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
  if (supervisor) safeKill(supervisor, 'SIGTERM', { log });
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
