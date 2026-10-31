// Headless Chromium over CDP for QA: one browser, one page, helpers to click, type, wait, screenshot and audit.
//
// Memory discipline (a leak of these filled a shared 12 GB machine): every launch gets its OWN free debugging port and its own
// temporary profile; the whole process group is killed and the profile removed on close(), on process exit (also after an error
// or a timeout), on SIGINT/SIGTERM/SIGHUP, and after QA_BROWSER_MAX_MS (default 10 minutes) as a hard cap. A launch also reaps
// QA browsers left behind by an earlier crashed run (older than QA_BROWSER_STALE_S seconds, default 20 minutes).
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { BASE, login, sleep } from './lib.mjs';

export const SHOTS = process.env.QA_SHOTS ?? '/tmp/qa-shots';
mkdirSync(SHOTS, { recursive: true });

const PROFILE_PREFIX = 'qa-chrome-';
/** Browsers this process started and has not closed yet. */
const live = new Set();

function killTree(pid) {
  try {
    process.kill(-pid, 'SIGKILL'); // the whole process group (launched detached)
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

function dispose(b) {
  if (!live.delete(b)) return;
  clearTimeout(b.cap);
  try {
    b.ws?.terminate();
  } catch {
    // closed
  }
  if (b.proc?.pid) killTree(b.proc.pid);
  try {
    rmSync(b.profile, { recursive: true, force: true });
  } catch {
    // best effort: the next launch's reaper removes stale profiles
  }
}

const disposeAll = () => [...live].forEach(dispose);
process.on('exit', disposeAll);
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(signal, () => {
    disposeAll();
    process.exit(code);
  });
}

/** An unused TCP port, chosen by the OS, so overlapping runs never share a debugging port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Kills QA browsers (profile /tmp/qa-chrome-*) that outlived the run that started them, and deletes their profiles. */
function reapStale(staleSeconds) {
  let rows = '';
  try {
    rows = execSync('ps -eo pid,etimes,args', { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return;
  }
  const mine = new Set([...live].map((b) => b.profile));
  for (const line of rows.split('\n')) {
    const m = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+.*chromium.*--user-data-dir=(${tmpdir()}/${PROFILE_PREFIX}\\S+)`).exec(line);
    if (!m || line.includes('--type=')) continue;
    const [, pid, age, profile] = m;
    if (mine.has(profile) || Number(age) < staleSeconds) continue;
    killTree(Number(pid));
    rmSync(profile, { recursive: true, force: true });
  }
}

export class Browser {
  /** @param {{ width?: number, height?: number, dark?: boolean, mobile?: boolean, reducedMotion?: boolean, cookie?: string }} o */
  static async launch(o = {}) {
    reapStale(Number(process.env.QA_BROWSER_STALE_S ?? 1200));
    const b = new Browser();
    b.o = { width: 1280, height: 800, dark: false, mobile: false, reducedMotion: false, ...o };
    b.o.port = await freePort();
    b.profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
    live.add(b);
    // The hard cap: whatever the script does, the browser is gone after this long.
    b.cap = setTimeout(() => dispose(b), Number(process.env.QA_BROWSER_MAX_MS ?? 600_000));
    b.cap.unref();
    try {
      await b.#start(o);
    } catch (e) {
      dispose(b);
      throw e;
    }
    return b;
  }

  async #start(o) {
    const b = this;
    b.proc = spawn(
      'chromium',
      [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions', '--disable-background-networking',
        '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run', '--mute-audio', '--hide-scrollbars=false',
        '--disable-features=Translate,OptimizationHints,OnDeviceModelService,OptimizationGuideModelExecution',
        '--js-flags=--max-old-space-size=1536', '--renderer-process-limit=3',
        `--remote-debugging-port=${b.o.port}`, `--user-data-dir=${b.profile}`, 'about:blank',
      ],
      { stdio: 'ignore', detached: true }, // its own process group, so close() can take every helper process with it
    );
    b.proc.on('error', () => undefined);
    b.proc.unref();
    let targets;
    for (let i = 0; i < 100; i++) {
      try {
        targets = await (await fetch(`http://127.0.0.1:${b.o.port}/json`)).json();
        if (targets.some((t) => t.type === 'page')) break;
      } catch {
        // not up yet
      }
      await sleep(200);
    }
    const page = targets?.find((t) => t.type === 'page');
    if (!page) throw new Error('the browser did not start');
    b.ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      b.ws.once('open', resolve);
      b.ws.once('error', reject);
    });
    b.n = 0;
    b.pending = new Map();
    b.console = [];
    b.errors = [];
    b.failed = [];
    b.requests = [];
    b.dialogs = [];
    b.ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.id && b.pending.has(m.id)) return b.pending.get(m.id)(m);
      if (m.method === 'Runtime.consoleAPICalled') b.console.push({ type: m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? '').join(' ') });
      if (m.method === 'Runtime.exceptionThrown') b.errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      if (m.method === 'Network.loadingFailed') b.failed.push({ id: m.params.requestId, error: m.params.errorText, blocked: m.params.blockedReason });
      if (m.method === 'Network.requestWillBeSent') b.requests.push({ id: m.params.requestId, url: m.params.request.url, method: m.params.request.method });
      if (m.method === 'Page.javascriptDialogOpening') {
        b.dialogs.push(m.params.message);
        void b.send('Page.handleJavaScriptDialog', { accept: true });
      }
      if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) b.console.push({ type: `log-${m.params.entry.level}`, text: `${m.params.entry.text} ${m.params.entry.url ?? ''}` });
    });
    for (const d of ['Page', 'Runtime', 'Network', 'Log', 'DOM']) await b.send(`${d}.enable`);
    await b.setViewport(b.o.width, b.o.height);
    await b.media();
    if (o.cookie !== undefined) await b.cookie(o.cookie);
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.n;
      this.pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** `dpr`: the device pixel ratio (1 by default; an iPhone is 3). */
  async setViewport(width, height, mobile = width < 600, dpr = 1) {
    this.o.width = width;
    this.o.height = height;
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
    if (mobile) await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    else await this.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }

  async media({ dark = this.o.dark, reducedMotion = this.o.reducedMotion } = {}) {
    this.o.dark = dark;
    this.o.reducedMotion = reducedMotion;
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }] });
  }

  async cookie(value) {
    await this.send('Network.setCookie', { name: 'portal_session', value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Strict' });
  }

  async goto(path, wait = 1500) {
    await this.send('Page.navigate', { url: path.startsWith('http') ? path : `${BASE}${path}` });
    await sleep(wait);
  }

  /** Evaluates an expression (awaited) and returns its value. */
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n${expr.slice(0, 200)}`);
    return r.result.value;
  }

  async shot(name, { full = false } = {}) {
    const params = { format: 'png' };
    if (full) {
      const m = await this.send('Page.getLayoutMetrics');
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 6000), scale: 1 };
    }
    const r = await this.send('Page.captureScreenshot', params);
    const file = `${SHOTS}/${name}.png`;
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  /** Clicks the first visible element whose text (or aria-label) matches, via a real mouse event at its centre. */
  async clickText(text, { selector = 'button, a, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=option], summary, label', exact = false, nth = 0 } = {}) {
    const box = await this.eval(`(() => {
      const want = ${JSON.stringify(text)}; const exact = ${exact};
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => {
        const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
        if (r.width < 1 || r.height < 1 || s.visibility === 'hidden' || s.display === 'none') return false;
        const t = ((e.getAttribute('aria-label') || '') + ' ' + (e.innerText || e.textContent || '')).replace(/\\s+/g, ' ').trim();
        return exact ? t === want || (e.innerText || '').trim() === want : t.toLowerCase().includes(want.toLowerCase());
      });
      const e = els[${nth}]; if (!e) return null;
      e.scrollIntoView({ block: 'center', inline: 'center' });
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, n: els.length };
    })()`);
    if (!box) throw new Error(`no visible element matching "${text}"`);
    await this.clickAt(box.x, box.y);
    return box;
  }

  async clickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  async clickSel(selector, nth = 0) {
    const box = await this.eval(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!box) throw new Error(`no element for ${selector}`);
    await this.clickAt(box.x, box.y);
  }

  async type(text) {
    await this.send('Input.insertText', { text });
  }

  async key(key, { modifiers = 0, code } = {}) {
    const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, ' ': 32, Home: 36, End: 35, Delete: 46 };
    const vk = codes[key] ?? key.toUpperCase().charCodeAt(0);
    const base = { key, code: code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key), windowsVirtualKeyCode: vk, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(key.length === 1 && !modifiers ? { text: key } : key === 'Enter' ? { text: '\r' } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async focusSel(selector) {
    await this.eval(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
  }

  async waitFor(expr, ms = 8000, what = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await this.eval(`!!(${expr})`).catch(() => false)) return true;
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async signedIn() {
    this.cookieValue ??= await login();
    await this.cookie(this.cookieValue);
  }

  /** Closes the page's socket, kills the browser and everything it started, and deletes its profile. Safe to call twice. */
  async close() {
    dispose(this);
  }
}

/** Page checks that need no judgement: overflow, small tap targets, unnamed controls, duplicate ids, missing labels. */
export const AUDIT = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const name = (e) => (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') && document.getElementById(e.getAttribute('aria-labelledby'))?.innerText || e.innerText || e.getAttribute('title') || e.getAttribute('alt') || e.value || '').replace(/\\s+/g, ' ').trim();
  const desc = (e) => { const t = e.tagName.toLowerCase(); const c = (e.className && e.className.baseVal === undefined ? String(e.className) : '').split(/\\s+/).slice(0, 3).join('.'); return t + (e.id ? '#' + e.id : '') + (c ? '.' + c : '') + ' "' + name(e).slice(0, 40) + '"'; };
  const out = { url: location.pathname + location.search, vw: innerWidth, vh: innerHeight };
  const doc = document.scrollingElement;
  out.hscroll = doc.scrollWidth > innerWidth + 1 ? { scrollWidth: doc.scrollWidth, innerWidth } : null;
  out.overflowing = [...document.querySelectorAll('body *')].filter((e) => vis(e) && e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('[data-allow-overflow], pre, code, table, [style*="overflow"], .overflow-x-auto, .overflow-auto, .xterm')).slice(0, 8).map(desc);
  const interactive = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [role=option], summary, [tabindex]:not([tabindex="-1"])')].filter(vis);
  out.interactive = interactive.length;
  out.small = interactive.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).map((e) => { const r = e.getBoundingClientRect(); return desc(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }).slice(0, 40);
  out.smallCount = interactive.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).length;
  out.unnamed = interactive.filter((e) => !name(e) && !(e.tagName === 'INPUT' && e.labels && e.labels.length)).map(desc).slice(0, 20);
  out.inputsNoLabel = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter((e) => vis(e) && !(e.labels && e.labels.length) && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && !e.getAttribute('title')).map(desc).slice(0, 20);
  const ids = {}; for (const e of document.querySelectorAll('[id]')) ids[e.id] = (ids[e.id] || 0) + 1;
  out.dupIds = Object.entries(ids).filter(([, n]) => n > 1).map(([id, n]) => id + 'x' + n).slice(0, 10);
  out.imgNoAlt = [...document.querySelectorAll('img')].filter((e) => !e.hasAttribute('alt')).length;
  out.positiveTabindex = [...document.querySelectorAll('[tabindex]')].filter((e) => Number(e.getAttribute('tabindex')) > 0).length;
  out.h1 = [...document.querySelectorAll('h1')].map((e) => e.innerText.trim().slice(0, 40));
  out.landmarks = { main: document.querySelectorAll('main, [role=main]').length, nav: document.querySelectorAll('nav, [role=navigation]').length };
  out.title = document.title;
  out.xss = window.__xss ?? 0;
  return out;
})()`;
