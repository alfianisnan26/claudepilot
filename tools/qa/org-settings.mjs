// Org settings (owner request 2026-11-01, docs/prd/organizations.md §13.9): every section an owner sees, at 390 px (touch, safe areas) then
// 1280 px, light and dark, against a scratch portal. The server-code sign-in (the founding user, an instance admin) creates an org over the
// API, a member is seeded into it, and a team and an invitation are made over the API. It screenshots and asserts (QA-STANDARDS A1-A9):
//   - the owner gets all ten sections as tabs (docs/prd/ui-layout.md §2), one at a time, each its own path; no side list or picker;
//   - A5: every control in the page is at least 44 px at 390 px (a FAIL; a checkbox counts by its label row); at 1280 px only a note;
//   - A2: no horizontal scroll on the page, with the Move here dialog open, and with the Delete dialog open;
//   - Back returns to the previous tab, a legacy ?tab=access moves to /access; the Policies switches are there; the audit filter answers;
//   - Delete stays disabled until the slug is typed exactly.
// usage: tools/qa/with-portal.sh 3473 env QA_SHOTS=job-out/org-settings node tools/qa/org-settings.mjs
//   scripts/job-run.sh --ref <commit> --artifacts job-out/org-settings --out job-out/org-settings-art/ -- 'tools/qa/with-portal.sh 3473 env QA_SHOTS=job-out/org-settings node tools/qa/org-settings.mjs; exit $?'
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
const created = await call('POST', '/api/orgs', { name: 'Konfersi Indonesia Holdings Internasional', slug: `qa-set-${tag}` });
if (created.status !== 201) throw new Error(`creating the org: ${created.status} ${created.text}`);
const org = created.data;
const db = new DatabaseSync(process.env.ORGS_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`, { timeout: 10_000 });
const memberId = `u_QaSetMbr${tag.slice(-3).padStart(3, '0')}`;
const at = new Date().toISOString();
db.prepare(
  "INSERT OR IGNORE INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, 'member', 'active', 'not-a-hash', ?, ?, 'ui')",
).run(memberId, `${memberId}@example.test`, `${memberId.toLowerCase()}@example.test`, 'Quinn Member with a long display name', at, at);
db.prepare("INSERT OR IGNORE INTO org_members (org_id, user_id, role, state, via, added_by, added_at) VALUES (?, ?, 'member', 'active', 'invite', 'system:qa', ?)").run(org.id, memberId, at);
const team = await call('POST', `/api/orgs/${org.id}/teams`, { name: 'Platform engineering' });
check('a team is made over the API', team.status === 201, team.text);
const inv = await call('POST', `/api/orgs/${org.id}/invitations`, { email: 'someone@example.test', role: 'member' });
check('an invitation is made over the API', inv.status === 201, String(inv.status));
const pol = await call('PATCH', `/api/orgs/${org.id}`, { policies: { membersMayInvite: true } });
check('an owner sets a policy over the API', pol.status === 200 && pol.data?.policies?.membersMayInvite === true, pol.text);

// --- measures -----------------------------------------------------------------------------------------------------------------------------
const MEASURE = (scope) => `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const desc = (e) => e.tagName.toLowerCase() + ' "' + (e.getAttribute('aria-label') || e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30) + '"';
  const box = (e) => { const l = e.closest('label'); return (e.type === 'checkbox' || e.type === 'radio') && l ? l.getBoundingClientRect() : e.getBoundingClientRect(); };
  const roots = [...document.querySelectorAll(${JSON.stringify(scope)})];
  const ctl = roots.flatMap((r) => [...r.querySelectorAll('a[href], button, input, select')]).filter(vis);
  const small = ctl.filter((e) => { const r = box(e); return r.width < 43.5 || r.height < 43.5; }).map((e) => { const r = box(e); return desc(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); });
  const doc = document.scrollingElement;
  return { small, controls: ctl.length, docScroll: doc.scrollWidth, docClient: doc.clientWidth, text: roots.map((r) => r.innerText).join('\\n') };
})()`;
const ALL = ['general', 'members', 'teams', 'invitations', 'objects', 'access', 'sign-in', 'policies', 'audit', 'danger'];

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
      const base = `/admin/orgs/${org.id}`;
      await b.goto(base, 2500);
      await b.waitFor(`document.querySelectorAll('[role=tablist] [role=tab]').length >= 10`, 20_000, 'the tabs').catch(() => {});
      await sleep(400);

      // The tab bar (docs/prd/ui-layout.md §2): every section an owner may use, one shown at a time; no side list, no picker.
      const tabs = await b.eval(`[...document.querySelectorAll('[role=tablist] [role=tab]')].map((e) => e.getAttribute('data-tab'))`);
      check(`${t}: the owner gets every section as a tab`, JSON.stringify(tabs) === JSON.stringify(ALL), JSON.stringify(tabs));
      check(`${t}: one section at a time, no side list or picker`, await b.eval(`document.querySelectorAll('[data-org-section]').length === 1 && !document.querySelector('[data-org-picker], [data-org-nav]')`));
      let s = await b.eval(MEASURE('main'));
      sizes(`${t}: General: controls >= 44 px`, size.mobile, s.small.filter((x) => !/About/.test(x)));
      check(`${t}: General: no sideways scroll`, s.docScroll <= s.docClient + 1, `${s.docScroll}/${s.docClient}`);
      await b.shot(`org-settings-${t}`);

      // Every tab: its own path, its content, 44 px controls, no sideways scroll.
      const want = { members: /Quinn Member/, teams: /Platform engineering/, invitations: /someone@example\.test/, policies: /Members invite/ };
      for (const id of ALL.slice(1)) {
        await b.clickSel(`[role=tab][data-tab="${id}"]`);
        await b.waitFor(`location.pathname === ${JSON.stringify(`${base}/${id}`)} && !!document.querySelector('[data-org-section="${id}"]')`, 10_000, id).catch(() => {});
        await sleep(id === 'members' || id === 'teams' || id === 'invitations' ? 1200 : 500);
        s = await b.eval(MEASURE('main'));
        check(`${t}: ${id}: its own path and section`, await b.eval(`location.pathname === ${JSON.stringify(`${base}/${id}`)} && document.querySelector('[data-org-section]')?.getAttribute('data-org-section') === ${JSON.stringify(id)}`));
        if (want[id]) check(`${t}: ${id}: lists what was seeded`, want[id].test(s.text), JSON.stringify(s.text.slice(0, 160)));
        sizes(`${t}: ${id}: controls >= 44 px`, size.mobile, s.small.filter((x) => !/About/.test(x)));
        check(`${t}: ${id}: no sideways scroll`, s.docScroll <= s.docClient + 1, `${s.docScroll}/${s.docClient}`);
        if (id === 'members' || id === 'audit' || id === 'danger') await b.shot(`org-settings-${id}-${t}`);
      }

      // Back goes to the previous tab; a legacy ?tab=access link moves to the Access tab's path.
      await b.eval('history.back()');
      await sleep(800);
      check(`${t}: Back returns to the previous tab`, await b.eval(`location.pathname === ${JSON.stringify(`${base}/audit`)}`), await b.eval('location.pathname'));
      await b.goto(`${base}?tab=access`, 2000);
      check(`${t}: ?tab=access moves to /access`, await b.eval(`location.pathname === ${JSON.stringify(`${base}/access`)} && !location.search`), await b.eval('location.href'));

      // Audit: rows, and the kind filter answers.
      await b.goto(`${base}/audit`, 2000);
      await b.waitFor(`document.querySelectorAll('[data-org-audit-row]').length >= 3`, 10_000, 'audit rows').catch(() => {});
      const rows = await b.eval(`document.querySelectorAll('[data-org-audit-row]').length`);
      check(`${t}: the audit lists rows`, rows >= 3, `rows=${rows}`);
      await b.eval(`(() => { const sel = document.querySelector('[data-org-audit-filter]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'org.team'); sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(1200);
      const teamRows = await b.eval(`[...document.querySelectorAll('[data-org-audit-row]')].map((e) => e.innerText.split('\\n')[0])`);
      check(`${t}: the Teams filter shows team rows only`, teamRows.length >= 1 && teamRows.every((x) => /^Team/.test(x)), JSON.stringify(teamRows));
      await b.shot(`org-settings-audit-filter-${t}`);

      // Move here (Objects): the dialog lists the person's own things (or says there are none); no sideways scroll.
      await b.goto(`${base}/objects`, 2000);
      await b.waitFor(`!!document.querySelector('[data-org-move-open]')`, 10_000, 'Move here').catch(() => {});
      await b.clickSel('[data-org-move-open]');
      await b.waitFor(`!!document.querySelector('[role=dialog]')`, 5000, 'the move dialog').catch(() => {});
      await sleep(900);
      s = await b.eval(MEASURE('[role=dialog]'));
      check(`${t}: Move here opens`, /Move here/.test(s.text) && (/Nothing of yours/.test(s.text) || s.controls > 1), JSON.stringify(s.text.slice(0, 120)));
      sizes(`${t}: Move here: controls >= 44 px`, size.mobile, s.small);
      check(`${t}: Move here: no sideways scroll`, s.docScroll <= s.docClient + 1, `${s.docScroll}/${s.docClient}`);
      await b.shot(`org-settings-move-${t}`);
      await b.key('Escape');
      await sleep(600);

      // Delete (Danger zone): disabled until the slug is typed exactly; never confirmed here.
      await b.goto(`${base}/danger`, 2000);
      await b.waitFor(`!!document.querySelector('[data-org-delete]')`, 10_000, 'Delete').catch(() => {});
      await b.clickSel('[data-org-delete]');
      await b.waitFor(`!!document.querySelector('[data-org-delete-input]')`, 5000, 'the delete dialog').catch(() => {});
      await sleep(500);
      const disabled = () => b.eval(`document.querySelector('[data-org-delete-confirm]')?.disabled ?? null`);
      check(`${t}: Delete is disabled before typing`, (await disabled()) === true);
      await b.focusSel('[data-org-delete-input]');
      await b.type(org.slug.toUpperCase());
      check(`${t}: Delete stays disabled for a wrong case`, (await disabled()) === true);
      await b.eval(`(() => { const i = document.querySelector('[data-org-delete-input]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(org.slug)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(200);
      check(`${t}: Delete is enabled with the slug`, (await disabled()) === false);
      s = await b.eval(MEASURE('[role=dialog]'));
      sizes(`${t}: Delete: controls >= 44 px`, size.mobile, s.small);
      check(`${t}: Delete: no sideways scroll`, s.docScroll <= s.docClient + 1, `${s.docScroll}/${s.docClient}`);
      await b.shot(`org-settings-delete-${t}`);
      await b.key('Escape');
      await sleep(600);
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
