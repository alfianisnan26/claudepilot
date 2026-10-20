// The Home page (docs/prd/glance-widgets.md §18) in a real browser: the app opens on it, every card shows, no sideways scroll, every
// control in a card is a 44 px target, Arrange hides and orders a card (kept on reload), and switching Dashboard | Manager moves no header
// control (T-1851: the right-most button used to jump); at 390 px (touch) and 1280 px, light and dark.
// usage: QA_PORT=3423 QA_CODE=24681372 node tools/qa/home.mjs   ->  screenshots in /tmp/qa-shots/home-<width>-<theme>.png; exits 1 on a failure.
import { AUDIT, Browser, SHOTS } from './browser.mjs';
import { api, login, sleep } from './lib.mjs';

const cookie = await login();
const call = api(cookie);
// Something for the Tickets card to list (a scratch portal starts empty).
await call('POST', '/api/tickets', { summary: 'Home check: a ticket with a rather long summary that must truncate on a phone', type: 'task', priority: 'normal' }).catch(() => undefined);

// The cards and their default order, read from the page (the Arrange list holds every card, in order), not written here: Home grows
// cards (autonomy, review, pace came after this check was written and it went stale).
const CARDS = await (async () => {
  const b = await Browser.launch({ width: 390, height: 844 });
  try {
    await b.cookie(cookie);
    await b.eval(`localStorage.clear()`).catch(() => undefined);
    await b.goto('/admin/home', 2500);
    await b.waitFor(`!!document.querySelector('button[aria-label="Arrange cards"]')`, 10_000, 'the Arrange button');
    await b.clickSel('button[aria-label="Arrange cards"]');
    await b.waitFor(`document.querySelectorAll('[data-arrange-card]').length > 0`, 4000, 'the Arrange list');
    return await b.eval(`[...document.querySelectorAll('[data-arrange-card]')].map((e) => e.dataset.arrangeCard)`);
  } finally {
    await b.close();
  }
})();
console.log(`cards: ${CARDS.join(', ')}`);
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
      // One column at 390 px reads in order; from 1024 px the cards sit in column stacks, so there only the set is compared.
      if (width === 390) check(JSON.stringify(ids) === JSON.stringify(CARDS), `${tag}: the cards in the default order (${ids.join(', ')})`);
      else check(JSON.stringify([...ids].sort()) === JSON.stringify([...CARDS].sort()), `${tag}: every card shows (${ids.join(', ')})`);
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
      // T-1851: every header control keeps its place across the switch: the switch's two buttons and the right-most control.
      const RECTS = `[...document.querySelectorAll('[data-home-header-actions] button')].map((e) => { const r = e.getBoundingClientRect(); return (e.getAttribute('aria-label') || '?') + '@' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + 'x' + Math.round(r.height); })`;
      const RIGHT = `(() => { const v = [...document.querySelectorAll('[data-home-header-actions] button')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0); const r = v.sort((x, y) => y.right - x.right)[0]; return r ? Math.round(r.right) + ',' + Math.round(r.top) + ',' + Math.round(r.width) : 'none'; })()`;
      const SWITCH = `[...document.querySelectorAll('[role=group][aria-label="Home mode"] button')].map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width); }).join(' ')`;
      const dash = { all: await b.eval(RECTS), right: await b.eval(RIGHT), sw: await b.eval(SWITCH) };
      await b.clickSel('[role=group][aria-label="Home mode"] button[aria-label="Manager"]');
      await b.waitFor(`document.querySelector('h1')?.textContent === 'Manager'`, 4000, 'Manager mode');
      await sleep(600);
      const mgr = { all: await b.eval(RECTS), right: await b.eval(RIGHT), sw: await b.eval(SWITCH) };
      await b.shot(`home-manager-${tag}`);
      check(dash.right === mgr.right, `${tag}: the right-most header control holds still on the switch (dashboard ${dash.right}, manager ${mgr.right})`);
      check(dash.sw === mgr.sw, `${tag}: the mode switch holds still (dashboard ${dash.sw}, manager ${mgr.sw})`);
      check(JSON.stringify(dash.all) === JSON.stringify(mgr.all), `${tag}: every header control in the same slot (${dash.all.join(' ')} | ${mgr.all.join(' ')})`);
      const arrangeHidden = await b.eval(`(() => { const e = document.querySelector('button[aria-label="Arrange cards"]'); return !!e && getComputedStyle(e).visibility === 'hidden' && !!e.closest('[aria-hidden=true]'); })()`);
      check(arrangeHidden, `${tag}: in Manager, Arrange keeps its slot but is hidden from sight, tab order and screen readers`);
      if (width === 390) {
        const small = await b.eval(`[...document.querySelectorAll('[role=group][aria-label="Home mode"] button')].filter((e) => { const r = e.getBoundingClientRect(); return r.height < 44 || r.width < 44; }).map((e) => e.getAttribute('aria-label') + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height))`);
        check(small.length === 0, `${tag}: the mode switch is 44 px ${small.join('; ')}`);
      }
      await b.clickSel('[role=group][aria-label="Home mode"] button[aria-label="Dashboard"]');
      await b.waitFor(`document.querySelector('h1')?.textContent === 'Home'`, 4000, 'Dashboard mode');
      await sleep(400);
      check((await b.eval(RIGHT)) === dash.right, `${tag}: and back on Dashboard, the same place`);
      await b.eval(`localStorage.removeItem('home.mode')`);
      if (width === 390 && !dark) {
        // Arrange: hide Usage and move Quota up, then a reload keeps both.
        await b.clickSel('button[aria-label="Arrange cards"]');
        await b.waitFor(`!!document.querySelector('[role=dialog]')`, 4000, 'the Arrange dialog');
        await sleep(400);
        await b.shot('home-arrange-390');
        await b.clickSel('[role=dialog] [aria-label="Show Usage"]');
        await b.clickSel('[role=dialog] button[aria-label="Move Quota up"]');
        await b.goto('/admin/home', 2500);
        await b.waitFor(`document.querySelectorAll('[data-home-card]').length >= ${CARDS.length - 1}`, 8000, 'the cards after reload');
        const after = await b.eval(`[...document.querySelectorAll('[data-home-card]')].map((e) => e.dataset.homeCard)`);
        const q = CARDS.indexOf('quota');
        const moved = q > 0 ? [...CARDS.slice(0, q - 1), 'quota', CARDS[q - 1], ...CARDS.slice(q + 1)] : [...CARDS];
        const want = moved.filter((id) => id !== 'usage');
        check(JSON.stringify(after) === JSON.stringify(want), `${tag}: Arrange hid Usage and moved Quota up, kept on reload (${after.join(', ')}; want ${want.join(', ')})`);
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
