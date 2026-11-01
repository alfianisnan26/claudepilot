// The layout standard (docs/prd/ui-layout.md; owner requests 2026-11-01) in a real browser against a scratch portal, at 390 px (touch, safe
// areas) and 1280 px, light and dark, plus Home at 1280, 1584 and 1920. The server-code sign-in creates an org with 200 teams over the API.
// It screenshots and asserts (QA-STANDARDS A1-A10, measured):
//   - Settings: six tabs, each its own path, one section at a time; Back and Forward move between tabs; `?tab=sessions` moves to
//     /admin/settings/sessions; tabs are 44 px; the bar sticks while the page scrolls; no sideways scroll;
//   - the frame: on a desktop the document never scrolls (only #main-scroll), no centred column; on a phone the document scrolls as before;
//   - a long list (200 teams) does not grow the page unbounded: on a desktop the pane stays under 2.5 screens, on a phone the list is cut
//     with Show all;
//   - Profile and Org settings tabs; the workspace sheet's Claudes / Details switch;
//   - the glance dock: a handle at the edge, the panel over the page on a tap, Esc hides it, Pin makes it a column;
//   - Home: tiles in 3 or more columns from 1584 px, the document does not scroll.
// usage: tools/qa/with-portal.sh 3474 env QA_SHOTS=job-out/nav-tabs node tools/qa/nav-tabs.mjs
//   scripts/job-run.sh --ref <commit> --artifacts job-out/nav-tabs --out job-out/nav-tabs-art/ -- 'tools/qa/with-portal.sh 3474 env QA_SHOTS=job-out/nav-tabs node tools/qa/nav-tabs.mjs; exit $?'
import { Browser } from './browser.mjs';
import { api as apiOf, login, sleep } from './lib.mjs';

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};

// --- seed ---------------------------------------------------------------------------------------------------------------------------------
const cookie = await login();
const call = apiOf(cookie);
const tag = Date.now().toString(36);
const created = await call('POST', '/api/orgs', { name: 'Konfersi Indonesia', slug: `qa-nav-${tag}` });
if (created.status !== 201) throw new Error(`creating the org: ${created.status} ${created.text}`);
const org = created.data;
let made = 0;
for (let i = 0; i < 200; i += 20) {
  const batch = await Promise.all(Array.from({ length: 20 }, (_, j) => call('POST', `/api/orgs/${org.id}/teams`, { name: `Team ${String(i + j + 1).padStart(3, '0')}` })));
  made += batch.filter((r) => r.status === 201).length;
}
check('200 teams are made over the API', made === 200, `made=${made}`);

// --- measures -----------------------------------------------------------------------------------------------------------------------------
const FRAME = `(() => {
  const doc = document.scrollingElement;
  const pane = document.getElementById('main-scroll');
  const ps = pane ? getComputedStyle(pane) : null;
  const tabs = [...document.querySelectorAll('[role=tablist] [role=tab]')];
  const small = tabs.filter((e) => { const r = e.getBoundingClientRect(); return r.height < 43.5 || r.width < 43.5; }).map((e) => e.innerText);
  return {
    docScrolls: doc.scrollHeight > doc.clientHeight + 1,
    docScroll: doc.scrollWidth, docClient: doc.clientWidth,
    paneScrolls: !!ps && (ps.overflowY === 'auto' || ps.overflowY === 'scroll'),
    paneHeight: pane ? pane.scrollHeight : 0,
    mainWidth: Math.round(document.getElementById('main')?.getBoundingClientRect().width ?? 0),
    tabs: tabs.map((e) => e.getAttribute('data-tab')), small,
    path: location.pathname + location.search,
  };
})()`;
const tabsOf = () => b.eval(`[...document.querySelectorAll('[role=tablist] [role=tab]')].map((e) => e.getAttribute('data-tab'))`);
const path = () => b.eval('location.pathname + location.search');
const SIZES = [
  { name: '390', w: 390, h: 844, mobile: true, insets: { top: 47, left: 0, right: 0, bottom: 34 } },
  { name: '1280', w: 1280, h: 900, mobile: false, insets: { top: 0, left: 0, right: 0, bottom: 0 } },
];
const SETTINGS = ['general', 'agents', 'sessions', 'claude', 'people', 'glance'];

const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
try {
  for (const size of SIZES) {
    for (const dark of [false, true]) {
      const t = `${size.name}-${dark ? 'dark' : 'light'}`;
      console.log(t);
      await b.setViewport(size.w, size.h, size.mobile);
      await b.send('Emulation.setSafeAreaInsetsOverride', { insets: size.insets }).catch(() => {});
      await b.media({ dark });

      // Settings: the tabs, each a path; one section at a time.
      await b.goto('/admin/settings', 2500);
      await b.waitFor(`document.querySelectorAll('[role=tablist] [role=tab]').length === 6 && !!document.querySelector('[data-settings-group]')`, 15_000, 'settings').catch(() => {});
      let f = await b.eval(FRAME);
      check(`${t}: Settings has its six tabs`, JSON.stringify(f.tabs) === JSON.stringify(SETTINGS), JSON.stringify(f.tabs));
      if (!f.tabs.length) {
        console.log('  page errors:', JSON.stringify(b.errors.slice(-3)));
        console.log('  console:', JSON.stringify(b.console.filter((c) => /error/.test(c.type)).slice(-5)));
        throw new Error('the page did not render');
      }
      check(`${t}: tabs are 44 px`, f.small.length === 0, JSON.stringify(f.small));
      check(`${t}: no sideways scroll`, f.docScroll <= f.docClient + 1, `${f.docScroll}/${f.docClient}`);
      if (size.mobile) check(`${t}: a phone scrolls the document, not a pane`, !f.paneScrolls);
      else {
        check(`${t}: a desktop scrolls only the content pane`, f.paneScrolls && !f.docScrolls);
        check(`${t}: the content takes the width (no centred column)`, f.mainWidth >= size.w - 256 - 40, `main=${f.mainWidth}`);
      }
      await b.shot(`nav-settings-general-${t}`);
      for (const id of SETTINGS.slice(1)) {
        await b.clickSel(`[role=tab][data-tab="${id}"]`);
        await b.waitFor(`location.pathname === '/admin/settings/${id}'`, 5000, id).catch(() => {});
        await sleep(700);
        check(`${t}: ${id} is /admin/settings/${id}`, (await path()) === `/admin/settings/${id}`, await path());
        check(`${t}: ${id}: one panel`, await b.eval(`document.querySelectorAll('[role=tabpanel]').length === 1 && document.querySelector('[role=tabpanel]').getAttribute('data-tab-panel') === '${id}'`));
        if (id === 'sessions' || id === 'people') await b.shot(`nav-settings-${id}-${t}`);
      }
      // The bar sticks: scroll the page (pane on a desktop) down; the bar stays at the top of what is visible.
      await b.clickSel('[role=tab][data-tab="sessions"]');
      await sleep(600);
      const stuck = await b.eval(`(async () => {
        const pane = document.getElementById('main-scroll'); const s = getComputedStyle(pane).overflowY === 'auto' ? pane : null;
        if (s) s.scrollTo({ top: 600 }); else window.scrollTo({ top: 600 });
        await new Promise((r) => setTimeout(r, 300));
        const bar = document.querySelector('[role=tablist]').getBoundingClientRect();
        const top = s ? s.getBoundingClientRect().top : 0;
        return { at: Math.round(bar.top - top), scrolled: Math.round(s ? s.scrollTop : scrollY) };
      })()`);
      check(`${t}: the tab bar sticks while scrolling`, stuck.scrolled < 50 || stuck.at < 140, JSON.stringify(stuck));
      await b.eval('history.back()');
      await sleep(600);
      check(`${t}: Back goes to the previous tab`, (await path()) === '/admin/settings/glance', await path());
      await b.eval('history.forward()');
      await sleep(600);
      check(`${t}: Forward comes back`, (await path()) === '/admin/settings/sessions', await path());
      await b.goto('/admin/settings?tab=people', 1500);
      check(`${t}: ?tab=people moves to /admin/settings/people`, (await path()) === '/admin/settings/people', await path());

      // A long list (200 teams) stays bounded.
      await b.goto(`/admin/orgs/${org.id}/teams`, 2500);
      await b.waitFor(`document.querySelectorAll('[data-org-team]').length >= 200`, 20_000, 'the teams').catch(() => {});
      await sleep(600);
      f = await b.eval(FRAME);
      const bounded = await b.eval(`document.querySelector('[data-org-section=teams] [data-bounded]')?.getAttribute('data-bounded') ?? null`);
      if (size.mobile) {
        const docH = await b.eval('document.scrollingElement.scrollHeight');
        check(`${t}: 200 teams: cut with Show all`, bounded === 'cut' && (await b.eval(`[...document.querySelectorAll('[data-org-section=teams] button')].some((e) => /Show all/.test(e.innerText))`)), `bounded=${bounded}`);
        check(`${t}: 200 teams: the page stays under 3 screens`, docH < 3 * size.h, `doc=${docH}`);
      } else {
        check(`${t}: 200 teams: the list scrolls inside`, bounded === 'scroll', `bounded=${bounded}`);
        check(`${t}: 200 teams: the pane stays under 2.5 screens, the document does not scroll`, f.paneHeight < 2.5 * size.h && !f.docScrolls, `pane=${f.paneHeight}`);
      }
      await b.shot(`nav-org-teams-${t}`);
      check(`${t}: Org settings: ten tabs in one bar`, (await tabsOf()).length === 10, JSON.stringify(await tabsOf()));

      // Profile.
      await b.goto('/admin/profile', 2000);
      await b.waitFor(`!!document.querySelector('[data-profile-page]')`, 10_000, 'profile').catch(() => {});
      check(`${t}: Profile: the server code gets Account and Preferences`, JSON.stringify(await tabsOf()) === JSON.stringify(['account', 'preferences']), JSON.stringify(await tabsOf()));
      await b.shot(`nav-profile-${t}`);

      // The workspace sheet: one tab at a time (a stand-in running workspace, answered in the page).
      await b.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => { const w = { id: 'docker/qa-nav', name: 'qa-nav', target: 'docker', image: 'workspace', status: 'running', createdAt: '2026-09-01T00:00:00.000Z' };
          const real = window.fetch.bind(window); const json = (b) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
          window.fetch = async (input, init) => { const p = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
            if (p === '/api/workspaces') { const body = await (await real(input, init)).json(); return json({ ...body, data: [...(body.data ?? []).filter((x) => x.id !== w.id), w] }); }
            if (p === '/api/workspaces/' + w.id + '/claudes') return json({ data: [] });
            return real(input, init); }; })();`,
      });
      await b.goto('/admin/workspaces', 2500);
      await b.clickSel('button[aria-label^="Details for qa-nav"]').catch(() => {});
      await sleep(1200);
      const sheet = await b.eval(`[...document.querySelectorAll('[role=dialog] [role=radio]')].map((e) => e.innerText)`);
      check(`${t}: the workspace sheet offers Claudes and Details`, sheet.includes('Claudes') && sheet.includes('Details'), JSON.stringify(sheet));
      await b.shot(`nav-workspace-sheet-${t}`);
      await b.key('Escape');
      await sleep(400);
    }
  }

  // The dock and Home on a desktop.
  await b.setViewport(1280, 900, false);
  await b.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: 0 } }).catch(() => {});
  await b.media({ dark: false });
  await b.goto('/admin/home', 800);
  // The glance layout is saved per person on the server (D-111 D6): turn the dock on there, unpinned.
  const saved = await call('PUT', '/api/layouts/glance', { layout: { places: { header: true, dock: true, list: true, composer: true }, dockOpen: false } });
  check('the dock is turned on in the saved layout', saved.status === 200 || saved.status === 204, `${saved.status} ${saved.text}`);
  await b.goto('/admin/home', 2500);
  const handle = await b.eval(`!!document.querySelector('[data-dock=handle]')`);
  check('dock: a handle on the edge, no panel', handle && !(await b.eval(`!!document.querySelector('[data-dock=overlay], [data-dock=column]')`)));
  if (handle) {
    await b.clickSel('[data-dock=handle]');
    await sleep(500);
    check('dock: a tap shows the panel over the page', await b.eval(`!!document.querySelector('[data-dock=overlay]')`));
    await b.shot('nav-dock-overlay-1280');
    await b.key('Escape');
    await sleep(500);
    check('dock: Esc hides it', !(await b.eval(`!!document.querySelector('[data-dock=overlay]')`)));
    await b.clickSel('[data-dock=handle]');
    await sleep(500);
    await b.clickSel('[data-dock=overlay] button[aria-label="Pin dock"]');
    await sleep(500);
    check('dock: Pin makes it a column that makes room', await b.eval(`!!document.querySelector('[data-dock=column]') && getComputedStyle(document.documentElement).getPropertyValue('--glance-dock-w').trim() === '20rem'`));
    await b.shot('nav-dock-pinned-1280');
    await b.clickSel('[data-dock=column] button[aria-label="Unpin dock"]');
    await sleep(400);
  }
  for (const w of [1280, 1584, 1920]) {
    for (const dark of [false, true]) {
      await b.setViewport(w, w === 1920 ? 1080 : 900, false);
      await b.media({ dark });
      await b.goto('/admin/home', 2500);
      await b.waitFor(`document.querySelectorAll('[data-home-card]').length > 0`, 15_000, 'cards').catch(() => {});
      await sleep(800);
      const home = await b.eval(`(() => { const g = document.querySelector('[data-home-grid]'); const doc = document.scrollingElement;
        return { cols: g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 0, docScrolls: doc.scrollHeight > doc.clientHeight + 1, sideways: doc.scrollWidth > doc.clientWidth + 1 }; })()`);
      check(`home ${w} ${dark ? 'dark' : 'light'}: ${w >= 1584 ? '3+' : '2+'} columns, no document scroll`, home.cols >= (w >= 1584 ? 3 : 2) && !home.docScrolls && !home.sideways, JSON.stringify(home));
      await b.shot(`nav-home-${w}-${dark ? 'dark' : 'light'}`);
    }
  }
  const errors = b.errors.filter((e) => !/ResizeObserver/.test(e));
  check('no page errors', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
} finally {
  await b.close();
}
console.log(failed ? `FAILED ${failed}` : 'PASS');
process.exit(failed ? 1 : 0);
