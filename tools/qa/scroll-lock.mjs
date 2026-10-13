// The page must always be scrollable when no dialog is open ("Settings sometimes cannot be scrolled", apps/web/src/lib/scrollGuard.ts).
// Runs the REAL app in headless Chromium over CDP at phone and desktop size: a wheel scroll must move the Settings page; a lock that
// nobody holds (what two overlapping kit dialogs leave behind) must be released by itself; a lock held by an open modal must stay;
// a real dialog and the command palette must give the page back when they close.
// usage: SL_PORT=3403 SL_CODE=<server code> SL_CDP=9603 node tools/qa/scroll-lock.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.env.SL_PORT ?? 3403);
const CODE = process.env.SL_CODE ?? '24681372';
const CDP = Number(process.env.SL_CDP ?? 9603);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = async () => {
  const r = await fetch(`http://localhost:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${PORT}` }, body: JSON.stringify({ code: CODE }) });
  const m = /portal_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  if (!m) throw new Error(`login failed ${r.status}`);
  return m[1];
};

const profile = mkdtempSync(join(tmpdir(), 'sl-profile-'));
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

let targets;
for (let i = 0; i < 60; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); if (targets.some((t) => t.type === 'page')) break; } catch {}
  await sleep(200);
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let n = 0;
const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) pending.get(m.id)(m); });
const send = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(`eval: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
  return r.result?.result?.value;
};
const waitFor = async (expr, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(50); } return false; };
const wheel = async (dy) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 400, deltaX: 0, deltaY: dy });
  await sleep(250);
};
const scrollY = () => ev('Math.round(scrollY)');
const bodyOverflow = () => ev('document.body.style.overflow');

const results = [];
let cfg = '';
const check = (name, ok, detail = '') => { results.push({ cfg, name, ok: !!ok }); if (!ok) console.log(`  FAIL ${cfg} / ${name} ${detail}`); };

/** What the kit's Dialog and the palette both do to the page: save body's overflow, hide it, put the saved value back later. */
const STUCK = `(() => { const lock = () => { const saved = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = saved; }; }; const a = lock(); const b = lock(); a(); b(); return document.body.style.overflow; })()`;

async function run(c) {
  cfg = c.name;
  await send('Emulation.setDeviceMetricsOverride', { width: c.w, height: c.h, deviceScaleFactor: 1, mobile: c.mobile ?? false });
  await send('Page.navigate', { url: `http://localhost:${PORT}/admin/settings` });
  check('the settings page is there', await waitFor(`document.querySelector('[aria-labelledby^="settings-"]') !== null`, 15000));
  await sleep(500);
  check('the page is taller than the screen', (await ev('document.scrollingElement.scrollHeight - innerHeight')) > 100);

  await ev('scrollTo(0, 0)');
  await wheel(400);
  const base = await scrollY();
  check('a wheel scroll moves the page', base > 0, `scrollY=${base}`);
  await ev('scrollTo(0, 0)');

  // A lock nobody holds (two overlapping locks): the page cannot be scrolled by hand, and it must free itself.
  check('the kit pattern, overlapped, leaves body hidden', (await ev(STUCK)) === 'hidden');
  await wheel(400);
  check('locked: a wheel scroll does nothing (this is what users hit)', (await scrollY()) === 0, `scrollY=${await scrollY()}`);
  check('the lock is released by itself', await waitFor(`document.body.style.overflow === ''`, 3000));
  await wheel(400);
  check('and the page scrolls again', (await scrollY()) > 0);
  await ev('scrollTo(0, 0)');

  // A lock held by an open modal stays, and goes when the modal goes.
  await ev(`(() => { const d = document.createElement('div'); d.id = 'sl-modal'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); document.body.appendChild(d); document.body.style.overflow = 'hidden'; })()`);
  await sleep(1200);
  check('an open modal keeps its lock', (await bodyOverflow()) === 'hidden');
  await ev(`document.getElementById('sl-modal').remove()`);
  check('the lock goes after the modal is gone', await waitFor(`document.body.style.overflow === ''`, 3000));

  // The real thing: the command palette (Ctrl+K) locks and gives the page back.
  await ev(`document.body.focus()`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  const opened = await waitFor(`document.querySelector('[role=dialog][aria-modal=true]') !== null`, 3000);
  check('the palette opens with Ctrl+K', opened);
  if (opened) {
    check('and locks the page', (await bodyOverflow()) === 'hidden');
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    check('Esc closes it and the page is free', await waitFor(`document.querySelector('[role=dialog][aria-modal=true]') === null && document.body.style.overflow === ''`, 3000));
  }
  await wheel(400);
  check('the page still scrolls at the end', (await scrollY()) > 0);
}

try {
  const cookie = await login();
  await send('Network.enable');
  await send('Network.setCookie', { name: 'portal_session', value: cookie, url: `http://localhost:${PORT}` });
  for (const c of [{ name: 'phone-390', w: 390, h: 844, mobile: true }, { name: 'desktop-1280', w: 1280, h: 800 }]) await run(c);
} finally {
  cleanup();
}
const bad = results.filter((r) => !r.ok);
console.log(`${results.length - bad.length}/${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
