// The Home page (docs/prd/glance-widgets.md §18) in a real browser: the app opens on it, every card shows, no sideways scroll, every
// control in a card is a 44 px target, Arrange hides and orders a card (kept on reload); at 390 px (touch) and 1280 px, light and dark.
// usage: QA_PORT=3423 QA_CODE=24681372 node tools/qa/home.mjs   ->  screenshots in /tmp/qa-shots/home-<width>-<theme>.png; exits 1 on a failure.
import { AUDIT, Browser, SHOTS } from './browser.mjs';
import { api, login, sleep } from './lib.mjs';

const cookie = await login();
const call = api(cookie);
// Something for the Tickets card to list (a scratch portal starts empty).
await call('POST', '/api/tickets', { summary: 'Home check: a ticket with a rather long summary that must truncate on a phone', type: 'task', priority: 'normal' }).catch(() => undefined);

const CARDS = ['attention', 'sessions', 'quota', 'workspaces', 'tickets', 'ci', 'usage'];
const fails = [];
const check = (ok, what) => {
  if (!ok) fails.push(what);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

for (const [width, height] of [[390, 844], [1280, 800]]) {
  for (const dark of [false, true]) {
    const tag = `${width}-${dark ? 'dark' : 'light'}`;
    const b = await Browser.launch({ width, height, dark });
    try {
      await b.cookie(cookie);
      await b.goto('/admin', 2500);
      await b.waitFor(`document.querySelectorAll('[data-home-card]').length >= ${CARDS.length}`, 10_000, 'the cards');
      await sleep(1500); // the lazy card bodies and their first readings
      const path = await b.eval('location.pathname');
      check(path === '/admin/home', `${tag}: the app opens on Home (${path})`);
      const ids = await b.eval(`[...document.querySelectorAll('[data-home-card]')].map((e) => e.dataset.homeCard)`);
      check(JSON.stringify(ids) === JSON.stringify(CARDS), `${tag}: the cards in the default order (${ids.join(', ')})`);
      const a = await b.eval(AUDIT);
      check(!a.hscroll && a.overflowing.length === 0, `${tag}: no sideways scroll ${a.hscroll ? JSON.stringify(a.hscroll) : ''} ${a.overflowing.join('; ')}`);
      const small = await b.eval(`[...document.querySelectorAll('[data-home-card] a[href], [data-home-card] button')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 44 || r.width < 44); }).map((e) => (e.getAttribute('aria-label') || e.innerText).slice(0, 40) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height))`);
      // 44 px is the touch rule (QA A1); with a mouse the app's ⓘ and small buttons are smaller, as on every page.
      if (width === 390) check(small.length === 0, `${tag}: 44 px targets in the cards ${small.join('; ')}`);
      check(a.unnamed.length === 0, `${tag}: every control named ${a.unnamed.join('; ')}`);
      const crashed = await b.eval(`[...document.querySelectorAll('[data-home-card]')].filter((e) => e.innerText.includes('Could not show this')).map((e) => e.dataset.homeCard)`);
      check(crashed.length === 0, `${tag}: no card failed to draw ${crashed.join(', ')}`);
      if (width === 390) {
        const bar = await b.eval(`document.querySelectorAll('[data-tabbar] li').length`);
        check(bar <= 5, `${tag}: the phone bar has at most five entries (${bar})`);
        const first = await b.eval(`document.querySelector('[data-tabbar] a')?.getAttribute('aria-label')`);
        check(first === 'Home', `${tag}: Home is first in the phone bar (${first})`);
      }
      await b.shot(`home-${tag}`, { full: true });
      if (width === 390 && !dark) {
        // Arrange: hide Usage and move Quota up, then a reload keeps both.
        await b.clickSel('button[aria-label="Arrange cards"]');
        await b.waitFor(`!!document.querySelector('[role=dialog]')`, 4000, 'the Arrange dialog');
        await sleep(400);
        await b.shot('home-arrange-390');
        await b.clickSel('[role=dialog] [aria-label="Show Usage"]');
        await b.clickSel('[role=dialog] button[aria-label="Move Quota up"]');
        await b.goto('/admin/home', 2500);
        await b.waitFor(`document.querySelectorAll('[data-home-card]').length >= 6`, 8000, 'the cards after reload');
        const after = await b.eval(`[...document.querySelectorAll('[data-home-card]')].map((e) => e.dataset.homeCard)`);
        check(JSON.stringify(after) === JSON.stringify(['attention', 'quota', 'sessions', 'workspaces', 'tickets', 'ci']), `${tag}: Arrange hid Usage and moved Quota up, kept on reload (${after.join(', ')})`);
        await b.eval(`localStorage.clear()`);
      }
      if (b.errors.length) check(false, `${tag}: page errors ${b.errors.slice(0, 3).join(' | ')}`);
    } finally {
      await b.close();
    }
  }
}
console.log(fails.length ? `\n${fails.length} failed; screenshots in ${SHOTS}` : `\nall passed; screenshots in ${SHOTS}`);
process.exit(fails.length ? 1 : 0);
