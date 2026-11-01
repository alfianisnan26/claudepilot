// Fine-grained org access (owner request 2026-11-01, docs/prd/access.md §7): the Access section and the grant flow, at 390 px (touch, safe
// areas) then 1280 px, light and dark, against a scratch portal. The server-code sign-in (the founding user) creates an org over the API;
// a member, two org-owned vaults and one open access request (from the member) are seeded into the database. It screenshots and asserts
// (QA-STANDARDS A1-A9):
//   - `?tab=access` opens at Access; the owner sees Objects, People and Requests (with the waiting count);
//   - the Access sheet of a vault: You, who has access; Give access -> Who (the member) -> Level (cards, manage enabled for a person) ->
//     Until (7 days) -> Review -> Grant; the member is then listed at Operate with an end, and can be ended (the X);
//   - the Requests tab: Decide opens with the level cards and the end picker;
//   - A5: every control in the sheet is at least 44 px at 390 px (a FAIL); A2: no sideways scroll on the page or with a sheet open;
//   - no outline-none: a focused control shows a ring (a computed box-shadow or outline).
// usage: tools/qa/with-portal.sh 3474 env QA_SHOTS=job-out/org-access node tools/qa/org-access.mjs
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
const created = await call('POST', '/api/orgs', { name: 'Konfersi Indonesia', slug: `qa-acc-${tag}` });
if (created.status !== 201) throw new Error(`creating the org: ${created.status} ${created.text}`);
const org = created.data;
const db = new DatabaseSync(process.env.ORGS_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`, { timeout: 10_000 });
const memberId = `u_QaAccMbr${tag.slice(-3).padStart(3, '0')}`;
const at = new Date().toISOString();
db.prepare(
  "INSERT OR IGNORE INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, 'member', 'active', 'not-a-hash', ?, ?, 'ui')",
).run(memberId, `${memberId}@example.test`, `${memberId.toLowerCase()}@example.test`, 'Quinn Member with a long display name', at, at);
db.prepare("INSERT OR IGNORE INTO org_members (org_id, user_id, role, state, via, added_by, added_at) VALUES (?, ?, 'member', 'active', 'invite', 'system:qa', ?)").run(org.id, memberId, at);
const vault = db.prepare("INSERT INTO kg_vaults (id, name, kind, root, read_only, created_at, updated_at, owner_kind, owner_id) VALUES (?, ?, 'vault', ?, 0, ?, ?, 'org', ?)");
const v1 = `vq_${tag}_1`;
const v2 = `vq_${tag}_2`;
vault.run(v1, 'Engineering handbook and runbooks', `/qa/${v1}`, at, at, org.id);
vault.run(v2, 'Sales', `/qa/${v2}`, at, at, org.id);
db.prepare("INSERT INTO access_requests (id, org_id, object_type, object_id, requester, level, note, state, created_at) VALUES (?, ?, 'vault', ?, ?, 'operate', 'For the Q4 pipeline review', 'open', ?)").run(
  `arq_qa${tag}`,
  org.id,
  v2,
  memberId,
  at,
);
const team = await call('POST', `/api/orgs/${org.id}/teams`, { name: 'Platform engineering' });
check('a team is made over the API', team.status === 201, team.text);

const MEASURE = (scope) => `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const desc = (e) => e.tagName.toLowerCase() + ' "' + (e.getAttribute('aria-label') || e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30) + '"';
  const box = (e) => { const l = e.closest('label'); return (e.type === 'checkbox' || e.type === 'radio') && l ? l.getBoundingClientRect() : e.getBoundingClientRect(); };
  const roots = [...document.querySelectorAll(${JSON.stringify(scope)})];
  const ctl = roots.flatMap((r) => [...r.querySelectorAll('a[href], button, input, select, textarea')]).filter(vis);
  const small = ctl.filter((e) => { const r = box(e); return r.width < 43.5 || r.height < 43.5; }).map((e) => { const r = box(e); return desc(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); });
  const doc = document.scrollingElement;
  return { small, controls: ctl.length, docScroll: doc.scrollWidth, docClient: doc.clientWidth, text: roots.map((r) => r.innerText).join('\\n') };
})()`;
const clickIn = (selector, text) =>
  `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.innerText.includes(${JSON.stringify(text)})); if (e) e.click(); return !!e; })()`;
const sheet = (mode) => `!!document.querySelector('[data-access-sheet="${mode}"]')`;

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
      await b.goto(`/admin/orgs/${org.id}?tab=access`, 2500);
      await b.waitFor(`document.querySelectorAll('[data-access-object]').length >= 2`, 20_000, 'the access objects').catch(() => {});
      await sleep(1200);
      const top = await b.eval(`Math.round(document.getElementById('org-s-access')?.getBoundingClientRect().top ?? -1)`);
      check(`${t}: ?tab=access opens at Access`, top >= 0 && top < 260, `top=${top}`);
      let s = await b.eval(MEASURE('[data-org-access]'));
      check(`${t}: Objects, People, Requests with the waiting count`, /Objects/.test(s.text) && /People/.test(s.text) && /Requests 1/.test(s.text), JSON.stringify(s.text.slice(0, 160)));
      sizes(`${t}: Access: controls >= 44 px`, size.mobile, s.small.filter((x) => !/About/.test(x)));
      check(`${t}: no sideways scroll`, s.docScroll <= s.docClient + 1, `${s.docScroll}/${s.docClient}`);
      await b.shot(`org-access-${t}`);

      // The sheet of the first vault: You, who has access, Give access.
      await b.clickSel(`[data-access-object="vault:${v1}"] button`);
      await b.waitFor(`!!document.querySelector('[data-access-entries]')`, 8000, 'the entries').catch(() => {});
      await sleep(700);
      s = await b.eval(MEASURE('[role=dialog]'));
      check(`${t}: the sheet lists who has access`, /You/.test(s.text) && /Owners and admins/.test(s.text), JSON.stringify(s.text.slice(0, 160)));
      sizes(`${t}: sheet: controls >= 44 px`, size.mobile, s.small);
      check(`${t}: sheet: no sideways scroll`, s.docScroll <= s.docClient + 1, `${s.docScroll}/${s.docClient}`);
      await b.shot(`org-access-sheet-${t}`);

      const first = size.name === '390' && !dark;
      // The grant flow (made once; later passes end the share and make it again).
      await b.clickSel('[data-access-add]');
      await b.waitFor(sheet('who'), 5000, 'Who').catch(() => {});
      await b.waitFor(`document.querySelectorAll('[data-access-who] [role=radio]').length >= 1`, 8000, 'the people').catch(() => {});
      await sleep(500);
      s = await b.eval(MEASURE('[role=dialog]'));
      sizes(`${t}: Who: controls >= 44 px`, size.mobile, s.small);
      await b.shot(`org-access-who-${t}`);
      check(`${t}: Who: the member is offered`, await b.eval(clickIn('[data-access-who] [role=radio]', 'Quinn')));
      await b.clickSel('[data-access-next]');
      await b.waitFor(sheet('level'), 5000, 'Level').catch(() => {});
      await sleep(500);
      const cards = await b.eval(`[...document.querySelectorAll('[data-access-level-card]')].map((e) => e.getAttribute('data-access-level-card') + ':' + (e.disabled ? 'off' : 'on'))`);
      check(`${t}: Level: three cards, all open to an owner for a person`, JSON.stringify(cards) === JSON.stringify(['view:on', 'operate:on', 'manage:on']), JSON.stringify(cards));
      s = await b.eval(MEASURE('[role=dialog]'));
      sizes(`${t}: Level: controls >= 44 px`, size.mobile, s.small);
      await b.clickSel('[data-access-level-card="operate"]');
      await sleep(200);
      // No outline-none: the focused card shows a ring.
      // Keyboard focus (focus-visible): from the card to its InfoTip and back.
      await b.focusSel('[data-access-level-card="operate"]');
      await b.key('Tab');
      await b.key('Tab', { modifiers: 8 });
      await sleep(200);
      const ring = await b.eval(`(() => { const e = document.activeElement; if (!e?.matches('[data-access-level-card]')) return 'focus on ' + (e?.tagName ?? 'nothing'); const st = getComputedStyle(e); return st.boxShadow !== 'none' || (st.outlineStyle !== 'none' && st.outlineWidth !== '0px'); })()`);
      check(`${t}: Level: a focused card shows a ring`, ring === true, String(ring));
      await b.shot(`org-access-level-${t}`);
      await b.clickSel('[data-access-next]');
      await b.waitFor(sheet('until'), 5000, 'Until').catch(() => {});
      await sleep(500);
      await b.eval(clickIn('[data-access-sheet="until"] button, [data-access-sheet="until"] [role=radio]', '7 days'));
      await sleep(300);
      s = await b.eval(MEASURE('[role=dialog]'));
      sizes(`${t}: Until: controls >= 44 px`, size.mobile, s.small);
      await b.shot(`org-access-until-${t}`);
      await b.clickSel('[data-access-next]');
      await b.waitFor(sheet('review'), 5000, 'Review').catch(() => {});
      await sleep(400);
      s = await b.eval(MEASURE('[role=dialog]'));
      check(`${t}: Review names who, level and end`, /Quinn/.test(s.text) && /Operate/.test(s.text) && !/No end/.test(s.text), JSON.stringify(s.text.slice(0, 200)));
      await b.shot(`org-access-review-${t}`);
      await b.clickSel('[data-access-grant]');
      await b.waitFor(`${sheet('list')} && document.querySelectorAll('[data-access-entry="user"]').length >= 1`, 8000, 'the new entry').catch(() => {});
      await sleep(600);
      s = await b.eval(MEASURE('[role=dialog]'));
      check(`${t}: granted: the member is listed at Operate with an end`, /Quinn/.test(s.text) && /Operate/.test(s.text) && /ends in 7 d/.test(s.text), JSON.stringify(s.text.slice(0, 240)));
      if (first) await b.shot(`org-access-granted-${t}`);
      // End it again (one tap and the confirm), so the next pass starts the same.
      // A toast may sit over the row on a phone for a moment: the element is clicked, not a point.
      await b.eval(`document.querySelector('[data-access-revoke]')?.click()`);
      await sleep(500);
      await b.eval(clickIn('[role=dialog] button, [role=alertdialog] button', 'End'));
      await b.waitFor(`document.querySelectorAll('[data-access-entry="user"]').length === 0`, 8000, 'ended').catch(() => {});
      check(`${t}: one tap ends it`, (await b.eval(`document.querySelectorAll('[data-access-entry="user"]').length`)) === 0);
      await b.key('Escape');
      await sleep(600);

      // Requests: Decide opens with the cards and the end picker (not decided here).
      await b.eval(clickIn('[data-org-access] [role=radio], [data-org-access] button', 'Requests'));
      await b.waitFor(`!!document.querySelector('[data-access-decide]')`, 8000, 'the request').catch(() => {});
      await sleep(400);
      await b.shot(`org-access-requests-${t}`);
      await b.clickSel('[data-access-decide]');
      await b.waitFor(`document.querySelectorAll('[data-access-decide-sheet] [data-access-level-card]').length === 3`, 8000, 'Decide').catch(() => {});
      await sleep(500);
      s = await b.eval(MEASURE('[role=dialog]'));
      check(`${t}: Decide shows the note, the levels and the end`, /Q4 pipeline/.test(s.text) && /Until/.test(s.text) && /Approve/.test(s.text), JSON.stringify(s.text.slice(0, 200)));
      sizes(`${t}: Decide: controls >= 44 px`, size.mobile, s.small);
      check(`${t}: Decide: no sideways scroll`, s.docScroll <= s.docClient + 1, `${s.docScroll}/${s.docClient}`);
      await b.shot(`org-access-decide-${t}`);
      await b.key('Escape');
      await sleep(600);
      await b.eval(clickIn('[data-org-access] [role=radio], [data-org-access] button', 'Objects'));
      await sleep(300);
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
