// The Sessions list on a phone (chat PRD FR2, 2026-10-13): the chips run Pinned · Idle · … · All, Pinned appears once something is pinned and
// is the chip the list opens on, a pinned row leads, and a swipe to the right on a row pins (left archives). Real app in headless Chromium
// over CDP with touch emulation at 390 x 844 against a scratch portal that has at least two sessions.
// usage: QA_PORT=3417 QA_CODE=<server code> node tools/qa/session-swipe.mjs [--shots dir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Browser } from './browser.mjs';
import { api, login, sleep } from './lib.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};
const cookie = await login();
const call = api(cookie);
const sessions = (await call('GET', '/api/chat/sessions')).data ?? [];
if (sessions.length < 2) {
  console.error('needs at least two sessions on the portal');
  process.exit(2);
}
for (const s of sessions) if (s.pinnedAt) await call('DELETE', `/api/chat/sessions/${s.id}/pin`);

const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);
const shot = async (name) => {
  if (!shots) return;
  const r = await b.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, `${name}.png`), Buffer.from(r.data, 'base64'));
};
const chips = () => b.eval(`[...document.querySelectorAll('button[aria-pressed]')].map((e) => e.textContent.replace(/\\d+$/, '').trim())`);
const pressed = () => b.eval(`document.querySelector('button[aria-pressed=true]')?.textContent.replace(/\\d+$/, '').trim() ?? null`);
const rowBox = (title) =>
  b.eval(`(() => { const a = [...document.querySelectorAll('a[href^="/admin/sessions/"]')].find((e) => e.textContent.includes(${JSON.stringify(title)})); if (!a) return null; const r = a.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
const touch = async (type, x, y) => b.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
const swipe = async (from, dx) => {
  await touch('touchStart', from.x, from.y);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', from.x + (dx * i) / 8, from.y);
    await sleep(30);
  }
  await touch('touchEnd', 0, 0);
};

await b.goto('/admin/sessions', 2500);
check('nothing pinned: the list opens on Idle', (await pressed()) === 'Idle', String(await pressed()));
const order = await chips();
check('the chips: Idle first (Pinned hidden while nothing is pinned), All last', order[0] === 'Idle' && order[order.length - 1] === 'All', JSON.stringify(order));
check('no sideways scroll', (await b.eval('document.scrollingElement.scrollWidth <= innerWidth')) === true);
await shot('list-idle');

// Swipe the second session to the right: it is pinned, the Pinned chip appears and leads.
await b.eval(`[...document.querySelectorAll('button[aria-pressed]')].find((e) => e.textContent.startsWith('All')).click()`); // All: every row is on screen
await sleep(500);
const target = sessions[1];
const box = await rowBox(target.title.slice(0, 20));
check('the row is on screen', !!box);
await swipe(box, 120);
await sleep(1200);
const after = (await call('GET', `/api/chat/sessions/${target.id}`)).data;
check('a swipe to the right pins it', !!after?.pinnedAt);
await sleep(800);
const order2 = await chips();
check('the Pinned chip is first once something is pinned', order2[0] === 'Pinned', JSON.stringify(order2));
check('no sideways scroll after the swipe', (await b.eval('document.scrollingElement.scrollWidth <= innerWidth')) === true);
check('the row is back in place', (await b.eval(`!document.querySelector('[data-swipe]')`)) === true);
await shot('list-pinned');

// A fresh load opens on Pinned, with the pinned session in it.
await b.goto('/admin/sessions', 2500);
check('something pinned: the list opens on Pinned', (await pressed()) === 'Pinned', String(await pressed()));
check('the pinned session is listed', (await b.eval(`document.body.innerText.includes(${JSON.stringify(target.title.slice(0, 20))})`)) === true);
await shot('list-opens-pinned');

// A swipe to the left on the pinned row archives it: it leaves the list and the pin goes with it.
const box2 = await rowBox(target.title.slice(0, 20));
await swipe(box2, -120);
await sleep(1500);
const archived = (await call('GET', `/api/chat/sessions/${target.id}`)).data;
check('a swipe to the left archives it and unpins', !!archived?.archivedAt && !archived?.pinnedAt, JSON.stringify({ a: archived?.archivedAt, p: archived?.pinnedAt }));
await call('DELETE', `/api/chat/sessions/${target.id}/archive`);

await b.close();
console.log(`${failed ? 'FAILED' : 'passed'}: ${failed} failing`);
process.exit(failed ? 1 : 0);
