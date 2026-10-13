// A phone screen must not be draggable: the page never rubber-bands (overscroll-behavior), and the header and grab bar of a sheet (the More
// menu) are not drag handles (apps/web/src/lib/sheetDrag.ts). Runs the REAL app in headless Chromium over CDP with touch emulation at 390 x 844.
// usage: SL_PORT=3403 SL_CODE=<server code> SL_CDP=9604 node tools/qa/mobile-drag.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.env.SL_PORT ?? 3403);
const CODE = process.env.SL_CODE ?? '24681372';
const CDP = Number(process.env.SL_CDP ?? 9604);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = async () => {
  const r = await fetch(`http://localhost:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${PORT}` }, body: JSON.stringify({ code: CODE }) });
  const m = /portal_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  if (!m) throw new Error(`login failed ${r.status}`);
  return m[1];
};

const profile = mkdtempSync(join(tmpdir(), 'md-profile-'));
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
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); if (!ok) console.log(`  FAIL ${name} ${detail}`); };

/** A one-finger drag from (x, y0) to (x, y1) in steps. */
const drag = async (x, y0, y1) => {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / steps }] });
    await sleep(16);
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(500);
};
const panelTop = `(() => { const p = document.querySelector('[role=dialog][aria-modal=true]'); return p ? Math.round(p.getBoundingClientRect().top) : null; })()`;

try {
  const cookie = await login();
  await send('Network.enable');
  await send('Network.setCookie', { name: 'portal_session', value: cookie, url: `http://localhost:${PORT}` });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: `http://localhost:${PORT}/` });
  check('the app shell is there', await waitFor(`document.querySelector('nav[aria-label=Main] [aria-label=More]') !== null`, 15000));

  check('the page never rubber-bands: html', (await ev(`getComputedStyle(document.documentElement).overscrollBehaviorY`)) === 'none');
  check('the page never rubber-bands: body', (await ev(`getComputedStyle(document.body).overscrollBehaviorY`)) === 'none');
  check('the page never scrolls sideways: the root clips', (await ev(`getComputedStyle(document.getElementById('root')).overflowX`)) === 'clip');
  check('the page never scrolls sideways: nothing is wider than the screen', (await ev(`document.scrollingElement.scrollWidth <= innerWidth`)) === true);

  await ev(`document.querySelector('nav[aria-label=Main] [aria-label=More]').click()`);
  check('the More sheet opens', await waitFor(`document.querySelector('[role=dialog][aria-modal=true]') !== null`, 4000));
  await sleep(600); // its entrance spring
  const top0 = await ev(panelTop);
  const head = await ev(`(() => { const h = document.querySelector('[role=dialog] > header'); const r = h.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const bar = await ev(`(() => { const h = document.querySelector('[role=dialog] > div.touch-none'); const r = h.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);

  await drag(head.x - 60, head.y, head.y + 260);
  check('a drag on the header does not move the sheet', (await ev(panelTop)) === top0, `top ${await ev(panelTop)} vs ${top0}`);
  check('and does not close it', (await ev(`document.querySelector('[role=dialog][aria-modal=true]') !== null`)) === true);

  await drag(bar.x, bar.y, bar.y + 260);
  check('a drag on the grab bar does not move the sheet', (await ev(panelTop)) === top0, `top ${await ev(panelTop)} vs ${top0}`);
  check('and does not close it', (await ev(`document.querySelector('[role=dialog][aria-modal=true]') !== null`)) === true);

  // The sheet still closes the ways that are meant: the × button.
  await ev(`document.querySelector('[role=dialog] > header button').click()`);
  check('the × still closes it', await waitFor(`document.querySelector('[role=dialog][aria-modal=true]') === null`, 3000));
} finally {
  cleanup();
}
const bad = results.filter((r) => !r.ok);
console.log(`${results.length - bad.length}/${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
