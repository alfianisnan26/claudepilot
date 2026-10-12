#!/usr/bin/env node
// The browser container's supervisor (browser & desktop PRD §11.3, §12.3, §14.2), uid 1001. It owns the
// virtual display and VNC servers, wakes Chromium on the first call and closes it when idle, holds the
// control lease, and answers the gate (in the workspace) over loopback HTTP. The portal reaches it only
// through `cpb-ctl` over `exec`, on a unix socket the workspace and Chrome can't open.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { vncObfuscate } from './des.mjs';
import { CDP_PORT, chromeArgs, limitedRelay, loadConfig, log, PROTOCOL, SUPERVISOR_PORT } from './lib.mjs';

const cfg = loadConfig();
const RUN = process.env.CPB_RUN || '/run/cpb';
const PORT = Number(process.env.CPB_PORT || SUPERVISOR_PORT);
const CDP = Number(process.env.CPB_CDP_PORT || CDP_PORT);
const DISPLAY = process.env.CPB_DISPLAY || ':99';
const XAUTH = `${RUN}/xauth`;
const CTL_SOCK = `${RUN}/ctl.sock`;
/** Without an init to ask (tests, a dev machine), Chrome is started directly, as whoever runs this. */
const DIRECT = process.env.CPB_DIRECT === '1' || typeof process.send !== 'function';
const headless = cfg.tier === 'headless';
const hasDisplay = !headless && process.env.CPB_NO_DISPLAY !== '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bootId = randomUUID();
const S = {
  chrome: { state: 'asleep', pid: null, since: Date.now(), bootId: null, starts: 0, crashes: [], error: null, expectStop: false },
  display: { up: false },
  /** The control lease (§12.3): { holder, label, since, leaseUntil, private }. */
  control: null,
  viewers: 0,
  /** Agent sessions that called the gate lately: id → last seen (ms). */
  sessions: new Map(),
  activity: { at: 0, toolAt: 0, tool: null, session: null },
  /** Handoffs (§12.4): id → { id, reason, origin, session, state, requestedAt, resolvedAt, note }. */
  handoffs: new Map(),
};

/* ---------- Child processes ---------- */

/** Runs `cmd` for as long as `wanted()`, restarting with backoff. Returns { stop, child }. */
function supervise(name, cmd, args, { env = {}, wanted = () => true, onUp } = {}) {
  let child = null;
  let failures = 0;
  let stopped = false;
  const start = () => {
    if (stopped || !wanted()) return;
    const startedAt = Date.now();
    const c = spawn(cmd, args, { env: { PATH: '/usr/local/bin:/usr/bin:/bin', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child = c;
    const relay = limitedRelay(`[${name}]`, 60);
    c.stdout.on('data', relay);
    c.stderr.on('data', relay);
    c.once('error', (e) => log(`${name} failed to start: ${e.message}`));
    c.once('spawn', () => onUp?.(c));
    c.once('exit', (code, signal) => {
      if (child === c) child = null;
      if (stopped) return;
      failures = Date.now() - startedAt > 30_000 ? 0 : failures + 1;
      const wait = Math.min(15_000, 300 * 2 ** failures);
      log(`${name} exited (${signal ?? code}); ${wanted() ? `restarting in ${wait} ms` : 'not restarting'}`);
      setTimeout(start, wait).unref();
    });
  };
  start();
  return {
    get child() {
      return child;
    },
    stop() {
      stopped = true;
      child?.kill('SIGTERM');
    },
  };
}

/* ---------- Display, window manager, VNC (Browser and Desktop tiers) ---------- */

const OPENBOX_RC = `<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus>
  <desktops><number>1</number></desktops>
  <applications>
    <application class="*"><decor>no</decor><maximized>yes</maximized></application>
  </applications>
</openbox_config>
`;

const procs = {};
const x11 = { DISPLAY, XAUTHORITY: XAUTH, HOME: process.env.HOME || '/tmp' };
const password = () => randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(8, 'x').slice(0, 8);

/**
 * One process is the X display and the VNC server: TigerVNC's Xvnc (x11vnc's `-unixsock` still listened on TCP
 * 5900 here, so it was dropped). It listens on a `0600` unix socket only (`-rfbport -1`, no abstract X socket),
 * and checks two random passwords made at each start: the second is view-only, enforced by the server itself,
 * so a filter bug in the portal's bridge can't grant input (§12.1, §13 Display and VNC).
 */
async function startDisplay() {
  if (!hasDisplay) return;
  fs.mkdirSync(RUN, { recursive: true, mode: 0o711 });
  try {
    fs.chmodSync(RUN, 0o711);
  } catch {
    // not ours to chmod (a test directory)
  }
  // Chrome (uid 1000) must read the cookie to draw; other containers sharing the network namespace have none.
  fs.rmSync(XAUTH, { force: true });
  const add = spawnSync('xauth', ['-f', XAUTH, '-q', 'add', DISPLAY, '.', randomBytes(16).toString('hex')], { encoding: 'utf8' });
  if (add.status !== 0) throw new Error(`xauth: ${(add.stderr || add.error?.message || '').trim()}`);
  fs.chmodSync(XAUTH, 0o644);

  const full = password();
  const view = password();
  fs.writeFileSync(`${RUN}/vnc-full.pw`, full, { mode: 0o600 });
  fs.writeFileSync(`${RUN}/vnc-view.pw`, view, { mode: 0o600 });
  fs.writeFileSync(`${RUN}/vnc.passwd`, Buffer.concat([vncObfuscate(full), vncObfuscate(view)]), { mode: 0o600 });

  const { width, height } = cfg.display;
  fs.rmSync(`${RUN}/vnc.sock`, { force: true });
  procs.xvnc = supervise(
    'xvnc',
    'Xtigervnc',
    [
      DISPLAY, '-geometry', `${width}x${height}`, '-depth', '24', '-nolisten', 'tcp', '-nolisten', 'local', '-auth', XAUTH,
      '-rfbunixpath', `${RUN}/vnc.sock`, '-rfbunixmode', '384', '-rfbport', '-1',
      '-SecurityTypes', 'VncAuth', '-PasswordFile', `${RUN}/vnc.passwd`, '-AlwaysShared',
      // The clipboard goes through `xclip`, never through VNC (§12.2).
      '-AcceptCutText=0', '-SendCutText=0', '-SetPrimary=0', '-SendPrimary=0',
    ],
    { env: { HOME: x11.HOME } },
  );
  const socket = `/tmp/.X11-unix/X${DISPLAY.slice(1)}`;
  for (let i = 0; i < 100 && !(fs.existsSync(socket) && fs.existsSync(`${RUN}/vnc.sock`)); i++) await sleep(100);
  if (!fs.existsSync(socket)) throw new Error('The display did not start');
  S.display.up = true;

  fs.mkdirSync(`${RUN}/openbox`, { recursive: true });
  fs.writeFileSync(`${RUN}/openbox/rc.xml`, OPENBOX_RC);
  procs.openbox = supervise('openbox', 'openbox', ['--config-file', `${RUN}/openbox/rc.xml`], { env: x11 });
}

/* ---------- Chromium ---------- */

const cdpUrl = (path) => `http://127.0.0.1:${CDP}${path}`;
async function cdpJson(path, ms = 2000) {
  const res = await fetch(cdpUrl(path), { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`CDP ${path}: ${res.status}`);
  return res.json();
}

/** One CDP command on the browser target, then close: used for Browser.close and memory pressure. */
async function cdpBrowserCall(method, params = {}, ms = 3000) {
  const { webSocketDebuggerUrl } = await cdpJson('/json/version');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => (ws.close(), reject(new Error(`${method} timed out`))), ms);
    const done = (fn, v) => (clearTimeout(timer), fn(v));
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id === 1) {
        ws.close();
        done(m.error ? reject : resolve, m.error ? new Error(m.error.message) : m.result);
      }
    });
    ws.addEventListener('error', () => done(reject, new Error('CDP socket error')));
    // Browser.close ends the connection without a reply when Chrome exits first.
    ws.addEventListener('close', () => done(resolve, {}));
  });
}

const waiting = new Map(); // IPC request id → { resolve, reject }
let directChild = null;

function chromeStartViaInit() {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    waiting.set(id, { resolve, reject });
    process.send({ op: 'chrome-start', id });
    setTimeout(() => waiting.delete(id) && reject(new Error('The init did not answer')), 15_000).unref();
  });
}

function chromeStartDirect() {
  const profileDir = cfg.profile === 'fresh' ? fs.mkdtempSync('/tmp/cpb-profile-') : cfg.profileDir;
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) fs.rmSync(`${profileDir}/${f}`, { force: true });
  const child = spawn(process.env.CPB_CHROME_BIN || '/usr/bin/chromium', chromeArgs(cfg, { headless: !hasDisplay, profileDir, cdpPort: CDP }), {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || '/tmp', ...(hasDisplay ? { DISPLAY, XAUTHORITY: XAUTH } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const relay = limitedRelay('[chrome]');
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);
  directChild = child;
  child.once('exit', (code, signal) => {
    directChild = null;
    onChromeExit({ code, signal, expected: S.chrome.expectStop });
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => resolve({ pid: child.pid }));
  });
}

function onChromeExit({ code, signal, expected }) {
  const c = S.chrome;
  const wasUp = c.state === 'up' || c.state === 'starting';
  c.pid = null;
  c.since = Date.now();
  c.bootId = null;
  if (expected || c.expectStop) {
    c.state = 'asleep';
    c.expectStop = false;
    return;
  }
  if (wasUp && code === 0 && !signal) {
    // Someone closed the last window: Chrome ended by itself (§15.5 "Chrome closed").
    c.state = 'closed';
    return;
  }
  const now = Date.now();
  c.crashes = [...c.crashes.filter((t) => now - t < 10 * 60_000), now];
  if (c.crashes.length >= 3) {
    c.state = 'error';
    c.error = 'The browser crashed 3 times in 10 minutes.';
  } else {
    c.state = 'crashed';
  }
}

async function waitForCdp(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (S.chrome.state !== 'starting') throw new Error('The browser stopped while starting.');
    try {
      await cdpJson('/json/version', 1000);
      return;
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`The browser did not answer on CDP within ${Math.round(ms / 1000)} s.`);
}

let wakePromise = null;
/** Starts Chromium if it is not running and waits until CDP answers (§14.2 "first tool call or viewer"). */
function wake() {
  const c = S.chrome;
  if (c.state === 'up') return Promise.resolve();
  if (c.state === 'error') return Promise.reject(new Error(c.error || 'The browser is in an error state. Restart it from the portal.'));
  wakePromise ??= (async () => {
    c.state = 'starting';
    c.since = Date.now();
    c.error = null;
    try {
      if (hasDisplay && !S.display.up) throw new Error('The display is not up yet.');
      const started = DIRECT ? await chromeStartDirect() : await chromeStartViaInit();
      c.pid = started.pid ?? null;
      await waitForCdp(30_000);
      c.state = 'up';
      c.since = Date.now();
      c.bootId = randomUUID();
      c.starts++;
      touch(null, null);
      log(`chrome up (pid ${c.pid}, boot ${c.bootId.slice(0, 8)})`);
    } catch (e) {
      if (c.state === 'starting') c.state = 'crashed';
      c.error = e.message;
      log('wake failed:', e.message);
      await stopChrome('failed start').catch(() => undefined);
      throw e;
    }
  })().finally(() => (wakePromise = null));
  return wakePromise;
}

/** Closes Chromium through CDP so cookies are flushed, then makes sure it is gone. */
async function stopChrome(why) {
  const c = S.chrome;
  if (c.state === 'asleep' || c.state === 'closed') return;
  log(`stopping chrome: ${why}`);
  c.expectStop = true;
  try {
    await cdpBrowserCall('Browser.close', {}, 3000);
  } catch {
    // not answering: the signal below
  }
  const until = Date.now() + 4000;
  while (c.pid && Date.now() < until && c.state !== 'asleep') await sleep(100);
  if (c.state !== 'asleep' && c.state !== 'closed') {
    if (DIRECT) directChild?.kill('SIGKILL');
    else process.send({ op: 'chrome-stop', force: true });
    for (let i = 0; i < 50 && c.state !== 'asleep'; i++) await sleep(100);
  }
  if (c.state !== 'asleep') {
    c.state = 'asleep';
    c.pid = null;
  }
  c.expectStop = false;
}

async function restartChrome() {
  S.chrome.state === 'error' && (S.chrome.state = 'asleep', S.chrome.crashes = [], S.chrome.error = null);
  await stopChrome('restart');
  await wake();
}

if (!DIRECT) {
  process.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.event === 'chrome-started' || m.event === 'chrome-failed') {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.event === 'chrome-started') w.resolve({ pid: m.pid });
      else w.reject(new Error(m.error || 'Chrome did not start'));
    } else if (m.event === 'chrome-exit') onChromeExit(m);
    else if (m.event === 'hello' && m.chrome?.running) {
      S.chrome.state = 'up';
      S.chrome.pid = m.chrome.pid;
      S.chrome.bootId ??= randomUUID();
    }
  });
}

/* ---------- Activity, idle stop, control lease ---------- */

function touch(tool, session) {
  S.activity.at = Date.now();
  if (tool) {
    S.activity.tool = String(tool).slice(0, 80);
    S.activity.toolAt = S.activity.at;
  }
  if (session) {
    S.activity.session = String(session).slice(0, 80);
    S.sessions.set(S.activity.session, Date.now());
  }
}

/** Sessions that called within the last 10 minutes (older ones are gone: Claude Code starts a gate per session). */
function liveSessions() {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [id, at] of S.sessions) if (at < cutoff) S.sessions.delete(id);
  return [...S.sessions.keys()];
}

/** Idle time, in ms: the config's minutes (tests set CPB_IDLE_MS to wait less). */
const IDLE_MS = Number(process.env.CPB_IDLE_MS) || cfg.idleMinutes * 60_000;

function idleStopAt() {
  if (!IDLE_MS || S.chrome.state !== 'up') return null;
  const last = Math.max(S.activity.at, S.control?.since ?? 0);
  return last + IDLE_MS;
}

const waitingHandoff = () => [...S.handoffs.values()].some((h) => h.state === 'waiting');

async function idleTick() {
  const at = idleStopAt();
  if (at && Date.now() >= at && !S.control && S.viewers === 0 && !waitingHandoff()) await stopChrome('idle');
}

/** Memory guard (FR16): tells Chromium to shed memory at 80% and 88% of the container's limit. */
let lastPressure = 0;
async function memoryTick() {
  if (!cfg.memoryGuard || S.chrome.state !== 'up') return;
  const m = memory();
  if (!m.limit || m.used / m.limit < 0.8 || Date.now() - lastPressure < 30_000) return;
  lastPressure = Date.now();
  await cdpBrowserCall('Memory.simulatePressureNotification', { level: m.used / m.limit >= 0.88 ? 'critical' : 'moderate' }).catch(() => undefined);
}

/** The container's cgroup: current use (without reclaimable file cache) and limit, in bytes. */
function memory() {
  const num = (p) => {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      return v === 'max' ? 0 : Number(v);
    } catch {
      return 0;
    }
  };
  let used = num('/sys/fs/cgroup/memory.current');
  try {
    const inactive = /^inactive_file (\d+)/m.exec(fs.readFileSync('/sys/fs/cgroup/memory.stat', 'utf8'));
    if (inactive) used -= Number(inactive[1]);
  } catch {
    // no memory.stat: use the raw figure
  }
  return { used: Math.max(0, used), limit: num('/sys/fs/cgroup/memory.max') };
}

/** Keys a take-over may leave held, released when it ends (§12.3); Caps Lock cleared. */
function releaseKeys() {
  if (!hasDisplay) return;
  const run = (cmd, args) => spawnSync(cmd, args, { env: { PATH: '/usr/bin:/bin', ...x11 }, encoding: 'utf8', timeout: 3000 });
  run('xdotool', ['keyup', 'Shift_L', 'Shift_R', 'Control_L', 'Control_R', 'Alt_L', 'Alt_R', 'Meta_L', 'Meta_R', 'Super_L', 'Super_R']);
  if (/Caps Lock:\s+on/.test(run('xset', ['q']).stdout || '')) run('xdotool', ['key', 'Caps_Lock']);
}

function setControl({ on, holder, label, ttl, private: priv }) {
  if (!on) return releaseControl('released');
  const secs = Math.min(600, Math.max(Number(process.env.CPB_MIN_TTL) || 5, Number(ttl) || 90));
  const now = Date.now();
  const same = S.control && S.control.holder === holder;
  S.control = {
    holder: String(holder).slice(0, 80),
    label: String(label || holder).slice(0, 80),
    since: same ? S.control.since : now,
    leaseUntil: now + secs * 1000,
    // Private (§12.3): the pool says every take-over is, or this one is (a handoff).
    private: priv === true || cfg.private,
  };
  if (!same) touch(null, null);
  return controlView();
}

function releaseControl(why) {
  if (!S.control) return controlView();
  log(`control released: ${why}`);
  S.control = null;
  releaseKeys();
  S.activity.at = Date.now();
  return controlView();
}

const controlView = () => (S.control ? { held: true, ...S.control } : { held: false });

/* ---------- Status ---------- */

async function tabs() {
  if (S.chrome.state !== 'up') return [];
  try {
    const list = await cdpJson('/json/list');
    return list
      .filter((t) => t.type === 'page' && /^(https?|about|file|chrome):/.test(t.url || ''))
      .map((t) => ({ id: t.id, title: String(t.title || '').slice(0, 200), url: String(t.url || '').slice(0, 2000) }));
  } catch {
    return [];
  }
}

/** How many page tabs are open, read from Chrome at most once a second (the gate uses it to decide when to bring its tab forward). */
let tabCache = { at: 0, n: 0 };
async function tabCount() {
  if (S.chrome.state !== 'up') return 0;
  if (Date.now() - tabCache.at < 1000) return tabCache.n;
  try {
    const list = await cdpJson('/json/list', 1500);
    tabCache = { at: Date.now(), n: list.filter((t) => t.type === 'page' && /^(https?|about|file|chrome):/.test(t.url || '')).length };
  } catch {
    tabCache = { at: Date.now(), n: tabCache.n };
  }
  return tabCache.n;
}

function status() {
  const c = S.chrome;
  const m = memory();
  return {
    protocol: PROTOCOL,
    bootId,
    tier: cfg.tier,
    display: cfg.display,
    sandbox: cfg.sandbox ? 'on' : 'off',
    chrome: { state: c.state, pid: c.pid, since: c.since, bootId: c.bootId, starts: c.starts, crashes: c.crashes.length, error: c.error },
    vnc: { up: S.display.up, enabled: hasDisplay && cfg.liveView },
    control: controlView(),
    viewers: S.viewers,
    activity: { ...S.activity },
    sessions: liveSessions().length,
    tabCount: tabCache.n,
    idle: { minutes: cfg.idleMinutes, stopAt: idleStopAt() },
    memory: m,
    handoffs: [...S.handoffs.values()].slice(-10).map(handoffView),
    takeOver: cfg.takeOver,
    private: cfg.private,
  };
}

/* ---------- Handoffs (§12.4) ---------- */

/** How long a handoff waits for a person (tests set CPB_HANDOFF_MS). */
const HANDOFF_MS = Number(process.env.CPB_HANDOFF_MS) || 10 * 60_000;

const handoffView = (h) => ({ id: h.id, reason: h.reason, origin: h.origin, session: h.session, state: h.state, requestedAt: h.requestedAt, resolvedAt: h.resolvedAt, note: h.note });

/**
 * The agent's tab: the one at `tabUrl` (which the gate read from the pinned server), else the first. Brought to the
 * front, so the person sees what the agent was doing; its origin is read here, never taken from the agent's words.
 */
async function agentTab(tabUrl) {
  const list = await tabs();
  const tab = (typeof tabUrl === 'string' && list.find((t) => t.url === tabUrl)) || list[0] || null;
  if (tab) await fetch(cdpUrl(`/json/activate/${tab.id}`), { signal: AbortSignal.timeout(3000) }).catch(() => undefined);
  return tab;
}

function originOf(url) {
  try {
    const o = new URL(url).origin;
    return o === 'null' ? null : o;
  } catch {
    return null;
  }
}

async function createHandoff({ reason, session, tabUrl }) {
  if (!cfg.takeOver || !cfg.liveView || headless) return { id: null, state: 'unavailable', note: 'No live view for sign-in here' };
  for (const h of S.handoffs.values()) if (h.state === 'waiting' && h.session === session) return handoffView(h);
  const id = randomUUID();
  const tab = await agentTab(tabUrl);
  const h = { id, reason: String(reason || '').slice(0, 200), origin: tab ? originOf(tab.url) : null, session: String(session || '').slice(0, 80), state: 'waiting', requestedAt: Date.now(), resolvedAt: null, note: '', waitedMs: 0 };
  S.handoffs.set(id, h);
  for (const [k, v] of S.handoffs) if (S.handoffs.size > 50 && v.state !== 'waiting') S.handoffs.delete(k);
  touch('browser_handoff', session);
  return handoffView(h);
}

function answerHandoff(id, state, note) {
  const h = S.handoffs.get(id);
  if (!h) throw new Error('No such handoff');
  if (h.state !== 'waiting' && h.state !== 'in_control') return handoffView(h);
  h.state = state;
  h.note = String(note || '').slice(0, 200);
  if (state !== 'in_control') h.resolvedAt = Date.now();
  return handoffView(h);
}

/** The handoff the person in control left unanswered: "The person left before finishing" (§12.4). */
function handoffsLeft() {
  for (const h of S.handoffs.values()) if (h.state === 'in_control') answerHandoff(h.id, 'left', '');
}

/* ---------- Loopback HTTP: the gate's API (§13 Loopback services) ---------- */

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
};

async function readJson(req, max = 16 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    // A page in the agent's browser can't add `X-CPB` without a preflight, can't send an IP-literal Host
    // for another name (DNS rebinding), and any request with an Origin is refused outright.
    if (req.headers.origin !== undefined) return json(res, 403, { error: 'origin not allowed' });
    if (req.headers.host !== `127.0.0.1:${PORT}`) return json(res, 403, { error: 'host not allowed' });
    if (req.headers['x-cpb'] !== '1') return json(res, 403, { error: 'missing X-CPB' });
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' && !/^application\/json(;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'send application/json' });

    if (req.method === 'GET' && url.pathname === '/status') {
      await tabCount();
      return json(res, 200, status());
    }
    if (req.method === 'GET' && url.pathname === '/tabs') return json(res, 200, { tabs: await tabs() });
    if (req.method === 'POST' && url.pathname === '/wake') {
      try {
        await wake();
        await tabCount();
        return json(res, 200, status());
      } catch (e) {
        return json(res, 503, { error: e.message, ...status() });
      }
    }
    if (req.method === 'POST' && url.pathname === '/activate') {
      const b = await readJson(req);
      if (!/^[A-F0-9]{16,64}$/i.test(String(b.id || ''))) return json(res, 400, { error: 'bad tab id' });
      await fetch(cdpUrl(`/json/activate/${b.id}`), { signal: AbortSignal.timeout(3000) });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/activity') {
      const b = await readJson(req);
      touch(b.tool, b.session);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/handoff') {
      const b = await readJson(req);
      return json(res, 200, await createHandoff(b));
    }
    const m = /^\/handoff\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      // Long poll: answers when the handoff changes, or after 20 s with the current state.
      const until = Date.now() + 20_000;
      const state0 = url.searchParams.get('state') || 'waiting';
      for (;;) {
        const h = S.handoffs.get(m[1]);
        if (!h) return json(res, 404, { error: 'no such handoff' });
        if (h.state !== state0 || Date.now() >= until) return json(res, 200, handoffView(h));
        await sleep(500);
      }
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
});

/* ---------- The control socket: the portal, through `cpb-ctl` (uid 1001 only) ---------- */

async function runCommand(cmd, a) {
  switch (cmd) {
    case 'status':
      return { ...status(), ...(a.tabs ? { tabs: await tabs() } : {}) };
    case 'wake':
      await wake();
      return status();
    case 'control':
      if (a.on && !cfg.takeOver) throw new Error('Take-over is off for this browser.');
      return setControl({ on: a.on === true || a.on === 'on', holder: a.holder || 'portal', label: a.label, ttl: a.ttl, private: a.private === true });
    case 'viewers':
      S.viewers = Math.max(0, Math.min(1000, Number(a.n) || 0));
      if (S.viewers > 0) touch(null, null);
      return { viewers: S.viewers };
    case 'chrome':
      if (a.action === 'stop') await stopChrome('asked');
      else if (a.action === 'restart') await restartChrome();
      else throw new Error('action must be stop or restart');
      return status();
    case 'tabs':
      return { tabs: await tabs() };
    case 'activate-tab':
      if (!/^[A-F0-9]{16,64}$/i.test(a.id || '')) throw new Error('bad tab id');
      await fetch(cdpUrl(`/json/activate/${a.id}`), { signal: AbortSignal.timeout(3000) });
      return { ok: true };
    case 'handoff-answer':
      return answerHandoff(String(a.id || ''), ['in_control', 'handed_back', 'declined', 'expired', 'left', 'cancelled'].includes(a.state) ? a.state : 'declined', a.note);
    case 'handoffs-left':
      handoffsLeft();
      return { ok: true };
    default:
      throw new Error(`unknown command ${String(cmd).slice(0, 40)}`);
  }
}

function startCtl() {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o711 });
  fs.rmSync(CTL_SOCK, { force: true });
  const ctl = net.createServer((sock) => {
    let buf = '';
    sock.setTimeout(60_000, () => sock.destroy());
    sock.on('data', async (d) => {
      buf += d;
      if (buf.length > 64 * 1024) return sock.destroy();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      let out;
      try {
        const req = JSON.parse(line);
        out = { ok: true, result: await runCommand(req.cmd, req.args && typeof req.args === 'object' ? req.args : {}) };
      } catch (e) {
        out = { ok: false, error: e.message };
      }
      sock.end(`${JSON.stringify(out)}\n`);
    });
    sock.on('error', () => undefined);
  });
  ctl.listen(CTL_SOCK, () => fs.chmodSync(CTL_SOCK, 0o600));
  return ctl;
}

/* ---------- Boot and shutdown ---------- */

process.umask(0o077);
let ctlServer;
async function main() {
  log(`supervisor: tier ${cfg.tier}, ${DIRECT ? 'direct' : 'under init'}, sandbox ${cfg.sandbox ? 'on' : 'OFF'}`);
  ctlServer = startCtl();
  await startDisplay().catch((e) => log('display failed:', e.message));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  log(`listening on 127.0.0.1:${PORT}`);
  setInterval(() => void idleTick().catch((e) => log('idle:', e.message)), Number(process.env.CPB_TICK_MS) || 15_000).unref();
  setInterval(() => void memoryTick().catch(() => undefined), 10_000).unref();
  setInterval(() => {
    if (S.control && Date.now() > S.control.leaseUntil) {
      handoffsLeft();
      releaseControl('lease expired');
    }
    // A handoff waits 10 minutes, and the clock stops while someone has control (§12.4).
    for (const h of S.handoffs.values()) {
      if (h.state !== 'waiting') continue;
      if (!S.control) h.waitedMs += 1000;
      if (h.waitedMs >= HANDOFF_MS) answerHandoff(h.id, 'expired', '');
    }
  }, 1000).unref();
  if (cfg.startWithWorkspace) void wake().catch(() => undefined);
}

async function shutdown(signal) {
  log(`${signal}: closing`);
  server.close();
  ctlServer?.close();
  releaseControl('shutdown');
  await stopChrome('shutdown').catch(() => undefined);
  for (const p of Object.values(procs)) p.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((e) => {
  log('fatal:', e.message);
  process.exit(1);
});
