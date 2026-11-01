// The account area and the Profile (owner request 2026-11-01: "refine user information as well, and profile"), at 390 px (touch, safe
// areas) then 1280 px, light and dark, against a scratch portal. Seeds over the API and the scratch database: a founder admin account, a
// member with a username, a picture, an org (owner) and a linked SSO sign-in. It screenshots and asserts (QA-STANDARDS A1-A9, measured):
//   - a member's account menu shows their name, email, the Member chip and the org with its role, and a Profile link;
//   - a server-code session's menu says "Owner (server code)" with the founder's name and the server-code InfoTip (no role guess);
//   - the Profile lists You, Password, Linked sign-ins, Devices (this device marked), Organizations, Preferences; the server code gets its card;
//   - A5: every control of the menu and the Profile is at least 44 px at 390 px (a FAIL); at 1280 px only a note; A2: no sideways scroll.
// usage: QA_PORT=3417 QA_CODE=24681372 QA_SHOTS=<dir> node tools/qa/profile.mjs   (after scripts/scratch-portal.sh start 3417)
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { Browser } from './browser.mjs';
import { api as apiOf, BASE, login, PORT, sleep } from './lib.mjs';

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};
const sizes = (name, strict, list) =>
  strict ? check(name, list.length === 0, JSON.stringify(list)) : console.log(`  note ${name} (1280 px) ${list.length ? JSON.stringify(list.slice(0, 4)) : 'ok'}`);

// --- seed ---------------------------------------------------------------------------------------------------------------------------------
const code = await login();
const asCode = apiOf(code);
const tag = Date.now().toString(36);
const password = ['profile', 'qa', 'long', 'pass', 'phrase', tag].join('-');
const mkUser = async (email, displayName, role) => {
  const r = await asCode('POST', '/api/admin/users', { email, displayName, password, role });
  if (r.status !== 201) throw new Error(`creating ${email}: ${r.status} ${r.text}`);
  return r.data;
};
const founder = await mkUser(`alfian-${tag}@isnan.example`, 'Alfian Isnan', 'admin');
const member = await mkUser(`mia-${tag}@konfersi.example`, 'Mia Kurniawati Saraswati Wibowo', 'member');
const db = new DatabaseSync(process.env.PROFILE_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`, { timeout: 10_000 });
db.prepare('UPDATE users SET founder = 0').run();
db.prepare('UPDATE users SET founder = 1 WHERE id = ?').run(founder.id);
const at = new Date().toISOString();
db.prepare(
  "INSERT OR REPLACE INTO sso_providers (id, name, issuer, client_id, domains, created_by, created_at, updated_at) VALUES ('sso_qaKonfersi', 'Konfersi Team', 'https://auth.konfersi.example', 'qa', '[\"sso-only.example\"]', 'ui', ?, ?)",
).run(at, at);
db.prepare("INSERT OR IGNORE INTO sso_identities (provider_id, subject, user_id, email, linked_at, last_login_at) VALUES ('sso_qaKonfersi', ?, ?, ?, ?, ?)").run(`sub-${tag}`, member.id, member.email, at, at);
const org = await asCode('POST', '/api/orgs', { name: 'Konfersi', slug: `qa-konfersi-${tag}` });
if (org.status !== 201) throw new Error(`org: ${org.status} ${org.text}`);
db.prepare("INSERT OR IGNORE INTO org_members (org_id, user_id, role, state, via, added_by, added_at) VALUES (?, ?, 'owner', 'active', 'invite', 'system:qa', ?)").run(org.data.id, member.id, at);

const signIn = async (email, ua) => {
  const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, 'User-Agent': ua }, body: JSON.stringify({ email, password }) });
  const m = /portal_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  if (!m) throw new Error(`sign-in ${email}: ${r.status}`);
  return m[1];
};
// A second browser of the member's, so the device list has another row to sign out.
await signIn(member.email, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
const mia = await signIn(member.email, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1');
const asMia = apiOf(mia);
check('the member sets a username', (await asMia('PATCH', '/api/me', { username: `mia.${tag}` })).status === 200);
const pic = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 236, g: 120, b: 80 } } }).png().toBuffer();
const up = await fetch(`${BASE}/api/me/avatar`, { method: 'POST', headers: { Cookie: `portal_session=${mia}`, Origin: BASE, 'Content-Type': 'image/png' }, body: pic });
check('the member uploads a picture', up.status === 200, String(up.status));

// --- measures -----------------------------------------------------------------------------------------------------------------------------
const MEASURE = (scope) => `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const desc = (e) => e.tagName.toLowerCase() + ' "' + (e.getAttribute('aria-label') || e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30) + '"';
  const roots = [...document.querySelectorAll(${JSON.stringify(scope)})];
  const ctl = roots.flatMap((r) => [...r.querySelectorAll('a[href], button, input:not(.sr-only), select')]).filter(vis);
  const small = ctl.filter((e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map((e) => { const r = e.getBoundingClientRect(); return desc(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); });
  const doc = document.scrollingElement;
  return { small, docScroll: doc.scrollWidth, docClient: doc.clientWidth, text: roots.map((r) => r.innerText).join('\\n') };
})()`;
const openMenu = (b) => b.eval(`[...document.querySelectorAll('button[aria-label="Account menu"]')].find((e) => e.offsetParent)?.click()`);
const SIZES = [
  { name: '390', w: 390, h: 844, mobile: true, insets: { top: 47, left: 0, right: 0, bottom: 34 } },
  { name: '1280', w: 1280, h: 900, mobile: false, insets: { top: 0, left: 0, right: 0, bottom: 0 } },
];

const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie: mia });
try {
  for (const who of ['member', 'code']) {
    await b.cookie(who === 'member' ? mia : code);
    for (const size of SIZES) {
      for (const dark of [false, true]) {
        const t = `${who}-${size.name}-${dark ? 'dark' : 'light'}`;
        console.log(t);
        await b.setViewport(size.w, size.h, size.mobile);
        await b.send('Emulation.setSafeAreaInsetsOverride', { insets: size.insets }).catch(() => {});
        await b.media({ dark });
        // The member works in the org context, so the menu names the org.
        await b.goto('/admin/home', 500);
        await b.eval(`(() => { try { ${who === 'member' ? `localStorage.setItem('claudepilot.context.${member.id}', 'org:${org.data.id}')` : `localStorage.removeItem('claudepilot.context.u_owner')`}; } catch {} })()`);
        await b.goto('/admin/home', 2500);
        await b.waitFor(`!!document.querySelector('[data-account-menu="${who === 'member' ? 'account' : 'code'}"]')`, 20_000, 'the account menu').catch(() => {});
        await openMenu(b);
        await b.waitFor(`!!document.querySelector('[data-account-who]')`, 5000, 'the menu').catch(() => {});
        await sleep(400);
        let s = await b.eval(MEASURE('[role=dialog][aria-label=Account]'));
        if (who === 'member') {
          check(`${t}: menu: name, email, Member chip, org with role`, /Mia Kurniawati/.test(s.text) && s.text.includes(member.email) && /Member/.test(s.text) && /Konfersi · Owner/.test(s.text), JSON.stringify(s.text.slice(0, 200)));
          check(`${t}: menu: the picture shows`, await b.eval(`!!document.querySelector('[data-account-who] img[src^="/api/users/avatars/"]')`));
        } else {
          check(`${t}: menu: Owner (server code) and the founder`, /Owner \(server code\)/.test(s.text) && /Alfian Isnan/.test(s.text) && !/Signed in with server code/.test(s.text), JSON.stringify(s.text.slice(0, 200)));
          check(`${t}: menu: the server-code InfoTip`, await b.eval(`!!document.querySelector('[data-account-who] button[aria-label="About the server code"]')`));
        }
        check(`${t}: menu: Profile link`, /Profile/.test(s.text));
        sizes(`${t}: menu: controls >= 44 px`, size.mobile, s.small.filter((x) => !/About/.test(x)));
        check(`${t}: menu: no sideways scroll`, s.docScroll <= s.docClient + 1, `${s.docScroll}/${s.docClient}`);
        await b.shot(`profile-menu-${t}`);

        await b.goto('/profile', 2500);
        await b.waitFor(`!!document.querySelector('[data-profile-page="${who === 'member' ? 'account' : 'code'}"]')`, 15_000, 'the profile').catch(() => {});
        if (who === 'member') await b.waitFor(`!!document.querySelector('[data-profile-devices] li')`, 10_000, 'devices').catch(() => {});
        await sleep(600);
        s = await b.eval(MEASURE('main'));
        if (who === 'member') {
          const want = ['You', 'Password', 'Linked sign-ins', 'Konfersi Team', 'Devices', 'This device', 'Safari on iPhone', 'Chrome on Mac', 'Organizations', 'Konfersi', 'Preferences'];
          const missing = want.filter((w) => !s.text.includes(w));
          check(`${t}: profile: every section`, missing.length === 0, JSON.stringify(missing));
          check(`${t}: profile: the username is filled`, await b.eval(`[...document.querySelectorAll('main input')].some((i) => i.value === 'mia.${tag}')`));
        } else {
          check(`${t}: profile: the server-code card`, /Server code/.test(s.text) && /Use an account/.test(s.text) && !/Devices/.test(s.text), JSON.stringify(s.text.slice(0, 200)));
        }
        sizes(`${t}: profile: controls >= 44 px`, size.mobile, s.small.filter((x) => !/About/.test(x)));
        check(`${t}: profile: no sideways scroll`, s.docScroll <= s.docClient + 1, `${s.docScroll}/${s.docClient}`);
        await b.shot(`profile-page-${t}`, { full: true });
      }
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
