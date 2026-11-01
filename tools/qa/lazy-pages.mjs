// Every page of the app frame still opens now that it loads on first use (owner request 2026-11-01, performance: apps/web/src/app/lazyPage.tsx):
// each route draws its page inside the frame (the tab bar or side panel stays), with no error boundary and no console error; a pool type's
// own page (/admin/pools/skills/library) opens through PoolRoutes; an unknown pool page goes Home; the other pages' chunks are fetched
// while the browser is idle after Home.
// usage: QA_PORT=3487 QA_CODE=24681372 node tools/qa/lazy-pages.mjs   exits 1 on a failure.
import { Browser } from './browser.mjs';
import { login, sleep } from './lib.mjs';

const cookie = await login();
const fails = [];
const check = (ok, what) => {
  if (!ok) fails.push(what);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};
const PAGES = [
  '/admin/attention',
  '/admin/workspaces',
  '/admin/sessions',
  '/admin/tickets',
  '/admin/ci',
  '/admin/knowledge',
  '/admin/pools',
  '/admin/pools/skills',
  '/admin/pools/skills/library',
  '/admin/targets',
  '/admin/access',
  '/admin/notifications',
  '/admin/settings',
  '/admin/profile',
  '/admin/usage',
  '/admin/shared',
];
for (const width of [390, 1280]) {
  const b = await Browser.launch({ width, height: width < 600 ? 844 : 800 });
  try {
    await b.cookie(cookie);
    await b.goto('/admin/home', 2500);
    await b.waitFor(`document.querySelectorAll('[data-home-card]').length > 0`, 15_000, 'Home');
    await sleep(6000); // idle: the other pages' chunks
    const fetched = b.requests.filter((r) => /\/assets\/(SettingsPage|TicketsPage|WorkspacesPage)-/.test(r.url)).length;
    check(fetched >= 3, `${width}: the other pages' chunks are fetched while idle after Home (${fetched} of 3 looked for)`);
    for (const path of PAGES) {
      const errors = b.errors.length;
      await b.goto(path, 0);
      const ok = await b
        .waitFor(`!document.querySelector('[aria-busy="true"]') && document.body.innerText.trim().length > 40`, 15_000, `${path} drawn`)
        .then(
          () => true,
          () => false,
        );
      const text = await b.eval(`document.body.innerText`);
      const where = await b.eval('location.pathname');
      check(
        ok && !/Something went wrong|Could not show this|Reload/.test(text.slice(0, 2000)) && b.errors.length === errors,
        `${width}: ${path} opens (${where})`,
      );
    }
    await b.goto('/admin/pools/skills/no-such-page', 0);
    await b.waitFor(`location.pathname === '/admin/home'`, 10_000, 'Home').then(
      () => check(true, `${width}: an unknown pool page goes Home`),
      () => check(false, `${width}: an unknown pool page goes Home`),
    );
  } finally {
    await b.close();
  }
}
if (fails.length) {
  console.log(`\n${fails.length} failed`);
  process.exit(1);
}
console.log('\nall passed');
