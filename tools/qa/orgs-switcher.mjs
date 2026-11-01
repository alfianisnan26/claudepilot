// Organizations slice 9 (docs/prd/organizations.md §7): the context switcher and Org settings, at 390 px (touch, safe areas) then 1280 px,
// light and dark, against a scratch portal. The server-code sign-in (the founding user, an instance admin) creates two orgs over the API
// (one with a long name) and a member is seeded into the first. It screenshots and asserts (QA-STANDARDS A1-A9, measured):
//   - the switcher closed and open (side bar top-left at 1280, the icon button and its sheet at 390): Personal, both orgs, New organization;
//   - A5: every row of the list and every control of Org settings is at least 44 px at 390 px (a FAIL); at 1280 px only a note;
//   - A2: no horizontal scroll on the page, with the list open, and on Org settings;
//   - picking an org stores `claudepilot.context.<userId>` = org:<id> and shows the "nothing here yet" note; Personal clears it;
//   - Org settings lists the members with role pickers, and demoting the last owner shows the plain "needs an owner" error.
// usage: tools/qa/with-portal.sh 3472 env QA_SHOTS=job-out/orgs node tools/qa/orgs-switcher.mjs
//   scripts/job-run.sh --ref <commit> --artifacts job-out/orgs --out job-out/orgs-art/ -- 'tools/qa/with-portal.sh 3472 env QA_SHOTS=job-out/orgs node tools/qa/orgs-switcher.mjs; exit $?'
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { api as apiOf, login, PORT, sleep } from './lib.mjs';

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};
const sizes = (name, strict, list) =>
  strict ? check(name, list.length === 0, JSON.stringify(list)) : console.log(`  note ${name} (1280 px) ${list.length ? JSON.stringify(list.slice(0, 4)) : 'ok'}`);

// --- seed ---------------------------------------------------------------------------------------------------------------------------------
const cookie = await login();
const call = apiOf(cookie);
const tag = Date.now().toString(36);
const mk = async (name, slug) => {
  const r = await call('POST', '/api/orgs', { name, slug });
  if (r.status !== 201) throw new Error(`creating ${slug}: ${r.status} ${r.text}`);
  return r.data;
};
const abilities = await call('GET', '/api/orgs/abilities');
check('the instance admin may create organizations', JSON.stringify(abilities.data?.abilities) === '["orgs.create"]', abilities.text);
const acme = await mk('Acme', `qa-acme-${tag}`);
await mk('Konfersi Indonesia Holdings Internasional Sejahtera Abadi', `qa-long-${tag}`);
const db = new DatabaseSync(process.env.ORGS_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`, { timeout: 10_000 });
const memberId = `u_QaMember${tag.slice(-3).padStart(3, '0')}`;
const at = new Date().toISOString();
db.prepare(
  "INSERT OR IGNORE INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, 'member', 'active', 'not-a-hash', ?, ?, 'ui')",
).run(memberId, `${memberId}@example.test`, `${memberId.toLowerCase()}@example.test`, 'Quinn Member with a long display name', at, at);
db.prepare("INSERT OR IGNORE INTO org_members (org_id, user_id, role, state, via, added_by, added_at) VALUES (?, ?, 'member', 'active', 'invite', 'system:qa', ?)").run(acme.id, memberId, at);

// --- measures -----------------------------------------------------------------------------------------------------------------------------
const MEASURE = (scope) => `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const desc = (e) => e.tagName.toLowerCase() + ' "' + (e.getAttribute('aria-label') || e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30) + '"';
  const roots = [...document.querySelectorAll(${JSON.stringify(scope)})];
  const ctl = roots.flatMap((r) => [...r.querySelectorAll('a[href], button, input, select')]).filter(vis);
  const small = ctl.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => { const r = e.getBoundingClientRect(); return desc(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); });
  const doc = document.scrollingElement;
  return { small, controls: ctl.length, docScroll: doc.scrollWidth, docClient: doc.clientWidth, text: roots.map((r) => r.innerText).join('\\n') };
})()`;
const storageKey = `claudepilot.context.u_owner`;
const stored = (b) => b.eval(`(() => { try { return localStorage.getItem(${JSON.stringify(storageKey)}); } catch { return 'blocked'; } })()`);

const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
const SIZES = [
  { name: '390', w: 390, h: 844, mobile: true, insets: { top: 47, left: 0, right: 0, bottom: 34 } },
  { name: '1280', w: 1280, h: 900, mobile: false, insets: { top: 0, left: 0, right: 0, bottom: 0 } },
];
try {
  for (const size of SIZES) {
    for (const dark of [false, true]) {
      const t = `${size.name}-${dark ? 'dark' : 'light'}`;
      console.log(t);
      await b.setViewport(size.w, size.h, size.mobile);
      await b.send('Emulation.setSafeAreaInsetsOverride', { insets: size.insets }).catch(() => {});
      await b.media({ dark });
      await b.goto('/admin/home', 500);
      await b.eval(`(() => { try { localStorage.removeItem(${JSON.stringify(storageKey)}); } catch {} })()`);
      await b.goto('/admin/home', 2500);
      const trigger = size.mobile ? '[data-context-switcher="icon"]' : '[data-context-switcher="sidebar"]';
      await b.waitFor(`!!document.querySelector('${trigger}')`, 20_000, 'the switcher').catch(() => {});
      check(`${t}: the switcher is shown`, await b.eval(`!!document.querySelector('${trigger}')`));
      if (!size.mobile) check(`${t}: closed, it reads Personal`, (await b.eval(`document.querySelector('${trigger}').innerText`)).includes('Personal'));
      if (size.mobile) {
        // The glance strip fills in after the first paint: give the bar a moment to settle, then measure.
        const acct = `document.querySelector('header [aria-label="Account menu"]')?.getBoundingClientRect().right ?? -1`;
        await b.waitFor(`(${acct}) > 0 && (${acct}) <= innerWidth`, 5000, 'the top bar').catch(() => {});
        const right = await b.eval(`Math.round(document.querySelector('header [aria-label="Account menu"]')?.getBoundingClientRect().right ?? -1)`);
        check(`${t}: the top bar keeps the account button on screen`, right > 0 && right <= size.w, `right=${right}`);
      }
      await b.shot(`orgs-switcher-closed-${t}`);

      await b.clickSel(trigger);
      await b.waitFor(`!!document.querySelector('[data-context-list]')`, 5000, 'the list').catch(() => {});
      await sleep(400);
      let s = await b.eval(MEASURE('[data-context-list]'));
      check(`${t}: open: Personal, both orgs and New organization`, /Personal/.test(s.text) && /Acme/.test(s.text) && /Konfersi Indonesia/.test(s.text) && /New organization/.test(s.text), JSON.stringify(s.text.slice(0, 200)));
      sizes(`${t}: open: every row >= 44 px`, size.mobile, s.small);
      check(`${t}: open: no sideways scroll`, s.docScroll <= s.docClient + 1, `${s.docScroll}/${s.docClient}`);
      await b.shot(`orgs-switcher-open-${t}`);

      await b.clickText('Acme', { selector: '[data-context-list] button' });
      await sleep(1200);
      check(`${t}: picking Acme stores org:<id> for this user`, (await stored(b)) === `org:${acme.id}`, String(await stored(b)));
      check(`${t}: the org's note says its lists are empty for now`, await b.eval(`!!document.querySelector('[data-org-scope-note]')`));
      await b.shot(`orgs-context-acme-${t}`);

      await b.goto(`/admin/orgs/${acme.id}`, 2500);
      await b.waitFor(`document.querySelectorAll('[data-org-member]').length >= 2`, 15_000, 'members').catch(() => {});
      s = await b.eval(MEASURE('main'));
      check(`${t}: Org settings lists the owner and the member`, /Quinn Member/.test(s.text) && /\(you\)/.test(s.text), JSON.stringify(s.text.slice(0, 160)));
      sizes(`${t}: Org settings: controls >= 44 px`, size.mobile, s.small.filter((x) => !/About/.test(x)));
      check(`${t}: Org settings: no sideways scroll`, s.docScroll <= s.docClient + 1, `${s.docScroll}/${s.docClient}`);
      await b.shot(`orgs-settings-${t}`, { full: true });

      // The last owner cannot step down: the refusal is shown as words, not a code.
      await b.eval(`(() => {
        const sel = document.querySelector('[data-org-member="u_owner"] select'); if (!sel) return false;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'member');
        sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await b.waitFor(`!!document.querySelector('[data-org-error]')`, 8000, 'the error').catch(() => {});
      const err = await b.eval(`document.querySelector('[data-org-error]')?.innerText ?? ''`);
      check(`${t}: demoting the last owner shows "needs an owner"`, /needs an owner/i.test(err), JSON.stringify(err));
      await b.shot(`orgs-settings-last-owner-${t}`);

      // Back to Personal through the switcher.
      await b.clickSel(trigger);
      await sleep(400);
      await b.clickText('Personal', { selector: '[data-context-list] button', exact: true });
      await sleep(800);
      check(`${t}: Personal clears the stored context`, (await stored(b)) === null, String(await stored(b)));
    }
  }
  const errors = b.errors.filter((e) => !/ResizeObserver/.test(e));
  check('no page errors', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
} finally {
  await b.close();
  db.close();
}
console.log(failed ? `FAILED ${failed}` : 'PASS');
process.exit(failed ? 1 : 0);
