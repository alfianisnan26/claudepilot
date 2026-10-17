// The Sessions list on a phone (chat PRD FR2, 2026-10-13; the order of T-100): the chips run in the order of attention with All last, the list
// opens on the first chip with sessions, Pinned is always there and counts a pin, and a swipe to the right on a row pins (left archives). Real app in headless Chromium
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
const sessions = (await call('GET', '/api/chat/sessions?limit=100')).data?.items ?? [];
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
// The chips as [id, count], from their aria-label ("<name> <count>").
const chips = () => b.eval(`[...document.querySelectorAll('[data-chip]')].map((e) => [e.dataset.chip, Number(e.getAttribute('aria-label').match(/(\\d+)$/)?.[1] ?? -1)])`);
const pressed = () => b.eval(`document.querySelector('[data-chip][aria-pressed=true]')?.dataset.chip ?? null`);
const firstFull = (c) => c.find(([id, n]) => id !== 'all' && id !== 'archived' && n > 0)?.[0] ?? 'all';
const chip = (id) => b.eval(`document.querySelector('[data-chip=${id}]')?.click()`);
const rowBox = (id) =>
  b.eval(`(() => { const a = document.querySelector('ul a[href="/admin/sessions/${id}"]'); if (!a) return null; const r = a.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
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
await b.waitFor("document.querySelectorAll('[data-chip]').length > 0", 30000, 'the chips');
const order = await chips();
check('the list opens on the first chip with sessions', (await pressed()) === firstFull(order), JSON.stringify({ on: await pressed(), order }));
check('the chips: Pinned there while nothing is pinned, All last', order.some(([id, n]) => id === 'pinned' && n === 0) && order.at(-1)?.[0] === 'all', JSON.stringify(order));
check('no sideways scroll', (await b.eval('document.scrollingElement.scrollWidth <= innerWidth')) === true);
await shot('list-first');

// Swipe a calm session to the right: it is pinned and the Pinned chip counts it. The Idle chip lists only a few rows, all on screen: the
// swipe needs no scrolling (a scrolled page shifted the touch point and swiped the wrong row).
// A calm one: archiving a busy session or one with a worktree asks first (a dialog), which is not what this checks.
const calm = (x) => x.state === 'idle' && !x.worktree && !x.waiting;
await chip('idle');
await b.waitFor(`document.querySelector('ul a[href^="/admin/sessions/"]')`, 30000, 'the rows');
await sleep(500);
const calmIds = sessions.filter(calm).map((x) => x.id);
const rows = await b.eval(`[...document.querySelectorAll('ul a[href^="/admin/sessions/"]')].map((a) => a.getAttribute('href').split('/').pop())`);
const target = sessions.find((x) => x.id === rows.find((id) => calmIds.includes(id))) ?? sessions[1];
const box = await rowBox(target.id);
check('the row is on screen', !!box && box.y < 800, JSON.stringify(box));
await swipe(box, 120);
await sleep(1200);
const after = (await call('GET', `/api/chat/sessions/${target.id}`)).data;
check('a swipe to the right pins it', !!after?.pinnedAt);
await sleep(800);
const order2 = await chips();
check('the Pinned chip counts it', order2.find(([id]) => id === 'pinned')?.[1] === 1, JSON.stringify(order2));
check('no sideways scroll after the swipe', (await b.eval('document.scrollingElement.scrollWidth <= innerWidth')) === true);
check('the row is back in place', (await b.eval(`!document.querySelector('[data-swipe]')`)) === true);
await shot('list-pinned');

// A fresh load still opens on the first chip with sessions; Pinned lists the pinned session.
await b.goto('/admin/sessions', 2500);
await b.waitFor("document.querySelectorAll('[data-chip]').length > 0", 30000, 'the chips');
check('a fresh load opens on the first chip with sessions', (await pressed()) === firstFull(await chips()), String(await pressed()));
await chip('pinned');
await sleep(500);
check('the pinned session is listed under Pinned', (await rowBox(target.id)) !== null);
await shot('list-pinned-chip');

// A swipe to the left on the pinned row archives it: it leaves the list and the pin goes with it.
const box2 = await rowBox(target.id);
await swipe(box2, -120);
await sleep(1500);
const archived = (await call('GET', `/api/chat/sessions/${target.id}`)).data;
check('a swipe to the left archives it and unpins', !!archived?.archivedAt && !archived?.pinnedAt, JSON.stringify({ a: archived?.archivedAt, p: archived?.pinnedAt }));
await call('DELETE', `/api/chat/sessions/${target.id}/archive`);

await b.close();
console.log(`${failed ? 'FAILED' : 'passed'}: ${failed} failing`);
process.exit(failed ? 1 : 0);
