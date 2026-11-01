// The Admin console on the UI standard (docs/coord/UI-STANDARD.md; owner, 2026-11-01), in a real browser at 390, 1280 and 1584 px, light and
// dark. The console's own build is served by `vite preview` and its API is answered in the page (a stand-in admin session and 60 users), so
// no admin host is needed. It screenshots and asserts:
//   - desktop: only the content pane scrolls (the document never does) and the content takes the full width; phone: the document scrolls;
//   - Users: the shared pill tabs All / Admins / Members / Disabled, 44 px, each showing only its rows; no sideways scroll.
// usage (in a Job, after `npm run build -w @portal/web`):
//   (cd apps/web && npx vite preview -c vite.admin.config.ts --port 4990 --strictPort >/tmp/admin-preview.log 2>&1 &) ; sleep 4;
//   ADMIN_URL=http://localhost:4990/admin-ui/ QA_SHOTS=job-out/admin node tools/qa/admin-console.mjs
import { Browser } from './browser.mjs';
import { sleep } from './lib.mjs';

const URL_ = process.env.ADMIN_URL ?? 'http://localhost:4990/admin-ui/';
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};

const at = new Date().toISOString();
const users = Array.from({ length: 60 }, (_, i) => ({
  id: `u_${i}`,
  email: `person-${String(i).padStart(2, '0')}-with-a-rather-long-address@konfersi.example`,
  displayName: `Person ${i}`,
  role: i % 7 === 0 ? 'admin' : 'member',
  state: i % 9 === 4 ? 'disabled' : 'active',
  createdAt: at,
  lastLoginAt: i % 3 ? at : null,
  abilities: i % 5 === 0 ? ['orgs.create'] : [],
}));
const STUB = `(() => {
  const me = { userId: 'u_0', email: 'owner@konfersi.example', displayName: 'Owner', expiresAt: ${JSON.stringify(at)}, idleExpiresAt: ${JSON.stringify(at)}, stepUpUntil: null };
  const users = ${JSON.stringify(users)};
  const json = (data) => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input) => {
    const p = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    if (p === '/admin-api/session') return json(me);
    if (p === '/admin-api/session/methods') return json({ password: true, oidc: null });
    if (p === '/admin-api/users') return json(users);
    return json([]);
  };
})();`;

const b = await Browser.launch({ width: 390, height: 844, mobile: true });
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  for (const size of [
    { name: '390', w: 390, h: 844, mobile: true },
    { name: '1280', w: 1280, h: 900, mobile: false },
    { name: '1584', w: 1584, h: 900, mobile: false },
  ]) {
    for (const dark of [false, true]) {
      const t = `${size.name}-${dark ? 'dark' : 'light'}`;
      console.log(t);
      await b.setViewport(size.w, size.h, size.mobile);
      await b.media({ dark });
      await b.goto(`${URL_}#users`, 2500);
      await b.waitFor(`document.querySelectorAll('[role=tablist] [role=tab]').length === 4`, 15_000, 'the Users tabs').catch(() => {});
      const f = await b.eval(`(() => { const doc = document.scrollingElement; const pane = document.getElementById('console-pane'); const ps = pane ? getComputedStyle(pane).overflowY : '';
        const tabs = [...document.querySelectorAll('[role=tablist] [role=tab]')];
        return { tabs: tabs.map((e) => e.getAttribute('data-tab')), small: tabs.filter((e) => e.getBoundingClientRect().height < 43.5).length,
          paneScrolls: ps === 'auto' || ps === 'scroll', docScrolls: doc.scrollHeight > doc.clientHeight + 1, sideways: doc.scrollWidth > doc.clientWidth + 1,
          mainWidth: Math.round(document.querySelector('main')?.getBoundingClientRect().width ?? 0), rows: document.querySelectorAll('main ul > li').length }; })()`);
      check(`${t}: Users has All, Admins, Members, Disabled`, JSON.stringify(f.tabs) === JSON.stringify(['all', 'admins', 'members', 'disabled']), JSON.stringify(f.tabs));
      check(`${t}: tabs are 44 px`, f.small === 0, String(f.small));
      check(`${t}: no sideways scroll`, !f.sideways);
      check(`${t}: All lists every user`, f.rows === users.length, `rows=${f.rows}`);
      if (size.mobile) check(`${t}: a phone scrolls the document`, !f.paneScrolls);
      else {
        check(`${t}: a desktop scrolls only the content pane`, f.paneScrolls && !f.docScrolls, JSON.stringify(f));
        check(`${t}: the content takes the width`, f.mainWidth >= size.w - 240 - 20, `main=${f.mainWidth}`);
      }
      await b.shot(`admin-users-all-${t}`);
      for (const [id, want] of [
        ['admins', users.filter((u) => u.state === 'active' && u.role === 'admin').length],
        ['disabled', users.filter((u) => u.state === 'disabled').length],
      ]) {
        await b.clickSel(`[role=tab][data-tab="${id}"]`);
        await sleep(400);
        const rows = await b.eval(`document.querySelectorAll('main ul > li').length`);
        check(`${t}: ${id} shows its ${want} rows`, rows === want, `rows=${rows}`);
      }
      await b.shot(`admin-users-disabled-${t}`);
    }
  }
  const errors = b.errors.filter((e) => !/ResizeObserver/.test(e));
  check('no page errors', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
} finally {
  await b.close();
}
console.log(failed ? `FAILED ${failed}` : 'PASS');
process.exit(failed ? 1 : 0);
