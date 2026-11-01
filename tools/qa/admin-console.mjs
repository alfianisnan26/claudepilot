// The Admin console on the UI standard (docs/coord/UI-STANDARD.md; owner, 2026-11-01), in a real browser at 390, 1280 and 1584 px, light and
// dark. The console's own build is served by `vite preview` and its API is answered in the page (a stand-in admin session and 60 users), so
// no admin host is needed. It screenshots and asserts:
//   - desktop: only the content pane scrolls (the document never does) and the content takes the full width; phone: the document scrolls;
//   - Users: the shared pill tabs All / Admins / Members / Disabled, 44 px, each showing only its rows; no sideways scroll.
//   - Owner need 2026-11-01: Users -> a member -> Tokens -> New (no admin scope offered, the secret shown once with the MCP URL) and
//     Orgs -> an org -> Members -> Add (roles admin/member/guest, an existing account or a new one): each sheet fits, 44 px targets.
// usage (in a Job, after `npm run build -w @portal/web`):
//   (cd apps/web && npx vite preview -c vite.admin.config.ts --port 4990 --strictPort >/tmp/admin-preview.log 2>&1 &) ; sleep 4;
//   ADMIN_URL=http://localhost:4990/admin-ui/admin.html QA_SHOTS=job-out/admin node tools/qa/admin-console.mjs
import { Browser } from './browser.mjs';
import { sleep } from './lib.mjs';

const URL_ = process.env.ADMIN_URL ?? 'http://localhost:4990/admin-ui/admin.html';
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
const org = {
  id: 'org_konfersi',
  slug: 'konfersi',
  name: 'Konfersi',
  state: 'active',
  members: 2,
  needsOwner: false,
  createdBy: 'user:u_0',
  createdAt: at,
  owners: [{ userId: 'u_0', email: users[0].email, active: true }],
};
const orgDetail = {
  ...org,
  memberList: [
    { userId: 'u_0', email: users[0].email, displayName: 'Person 0', role: 'owner', via: 'created', joinedAt: at },
    { userId: 'u_2', email: users[2].email, displayName: 'Person 2', role: 'member', via: 'invite', joinedAt: at },
  ],
  objects: [{ kind: 'workspace', id: 'docker/konf-api', name: 'docker/konf-api' }],
  invitations: [],
  sso: null,
  domains: null,
  breakGlassOpen: [],
};
// The minted token's secret is built in the page at run time: no token-shaped literal in this file.
const STUB = `(() => {
  const me = { userId: 'u_0', email: 'owner@konfersi.example', displayName: 'Owner', expiresAt: ${JSON.stringify(at)}, idleExpiresAt: ${JSON.stringify(at)}, stepUpUntil: null };
  const users = ${JSON.stringify(users)};
  const org = ${JSON.stringify(org)};
  const orgDetail = ${JSON.stringify(orgDetail)};
  const json = (data) => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
  window.__calls = [];
  window.fetch = async (input, init) => {
    const p = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    const method = (init && init.method) || 'GET';
    window.__calls.push(method + ' ' + p + (init && init.body ? ' ' + init.body : ''));
    if (p === '/admin-api/session') return json(me);
    if (p === '/admin-api/session/methods') return json({ password: true, oidc: null });
    if (p === '/admin-api/users') return json(users);
    let m = /^\\/admin-api\\/users\\/(u_\\d+)\\/workspaces$/.exec(p);
    if (m) return json([{ id: 'docker/konf-api', label: 'konf-api' }]);
    m = /^\\/admin-api\\/users\\/(u_\\d+)\\/tokens$/.exec(p);
    if (m && method === 'POST') {
      const req = JSON.parse(init.body);
      return json({
        token: { kind: 'pmcp', id: 'ptk_new', label: req.label, createdAt: me.expiresAt, expiresAt: me.expiresAt, lastUsedAt: null, revokedAt: null, scope: req.scope, defaultWorkspaceId: req.defaultWorkspaceId || null },
        secret: ['cpat', 'Q'.repeat(43)].join('_'),
        mcpUrl: 'https://pilot.konfersi.example/mcp',
      });
    }
    m = /^\\/admin-api\\/users\\/(u_\\d+)$/.exec(p);
    if (m) { const u = users.find((x) => x.id === m[1]); return json({ ...u, sessions: { portal: 1, admin: 0 }, tokens: [] }); }
    if (p === '/admin-api/orgs') return json([org]);
    if (p === '/admin-api/orgs/org_konfersi') return json(orgDetail);
    if (p === '/admin-api/orgs/org_konfersi/members' && method === 'POST') return json(orgDetail);
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
      // The same address with a fragment does not reload the page: start each pass from All.
      if (await b.eval(`!!document.querySelector('[role=tab][data-tab=all]')`)) await b.clickSel('[role=tab][data-tab="all"]');
      await sleep(300);
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

  // ---------- Owner need 2026-11-01: New token (Users) and Add member (Orgs) ----------
  const inDialog = (label) => `[...document.querySelectorAll('[role=dialog]')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(label)})`;
  /** The sheet's box against the viewport, its controls under 44 px (a visually hidden radio is not a target), sideways scroll, its selects' options. */
  const dialogFacts = (label) =>
    b.eval(`(() => { const d = ${inDialog(label)}; if (!d) return null; const r = d.getBoundingClientRect(); const doc = document.scrollingElement;
      const small = [...d.querySelectorAll('button, input, select, textarea')].filter((e) => { const x = e.getBoundingClientRect(); return x.width > 2 && x.height > 0 && x.height < 43.5; })
        .map((e) => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 30));
      const options = (i) => [...(d.querySelectorAll('select')[i]?.options ?? [])].map((o) => o.value);
      return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, small, sideways: doc.scrollWidth > doc.clientWidth + 1 || d.scrollWidth > d.clientWidth + 1, options: [options(0), options(1), options(2)] }; })()`);
  const pick = (label, nth, value) =>
    b.eval(`(() => { const el = ${inDialog(label)}.querySelectorAll('select')[${nth}];
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`);
  const fill = async (selector, text) => {
    await b.focusSel(selector);
    await b.type(text);
  };
  const fits = (f) => !!f && f.left >= 0 && f.right <= f.vw && !f.sideways && f.small.length === 0;
  const base = URL_.replace(/#.*$/, '');
  for (const size of [
    { name: '390', w: 390, h: 844, mobile: true },
    { name: '1280', w: 1280, h: 900, mobile: false },
  ]) {
    for (const dark of [false, true]) {
      const t = `${size.name}-${dark ? 'dark' : 'light'}`;
      console.log(`${t} sheets`);
      await b.setViewport(size.w, size.h, size.mobile);
      await b.media({ dark });
      // A query per pass: the same address with only a new fragment would not load the page again.
      await b.goto(`${base}?pass=${t}#users`, 2500);
      await b.waitFor(`document.querySelectorAll('main ul > li button').length > 2`, 15_000, 'the users');
      // Person 1 is an active member.
      await b.clickText(users[1].email, { selector: 'main ul > li button' });
      await b.waitFor(`document.querySelector('button[aria-label="New token"]')`, 8000, 'the New token button');
      await b.clickSel('button[aria-label="New token"]');
      await b.waitFor(inDialog('New token'), 8000, 'the New token sheet');
      await sleep(400);
      let f = await dialogFacts('New token');
      check(`${t}: New token offers read and operate only to a member`, JSON.stringify(f.options[0]) === JSON.stringify(['read', 'operate']), JSON.stringify(f.options[0]));
      check(`${t}: New token offers 7, 30, 90, 365 days`, JSON.stringify(f.options[1]) === JSON.stringify(['7', '30', '90', '365']));
      check(`${t}: New token lists the workspaces it may operate`, JSON.stringify(f.options[2]) === JSON.stringify(['', 'docker/konf-api']), JSON.stringify(f.options[2]));
      check(`${t}: New token fits the width, 44 px targets`, fits(f), JSON.stringify(f));
      await fill('[role=dialog][aria-label="New token"] input', 'Afgan');
      await pick('New token', 2, 'docker/konf-api');
      await sleep(200);
      await b.shot(`admin-token-new-${t}`);
      await b.clickSel('[role=dialog][aria-label="New token"] button[type=submit]');
      await b.waitFor(inDialog('Afgan'), 8000, 'the secret sheet');
      await sleep(400);
      const sent = await b.eval(`window.__calls.filter((c) => c.startsWith('POST /admin-api/users/u_1/tokens')).at(-1) || ''`);
      check(
        `${t}: the request names the label, scope, lifetime and workspace`,
        sent.includes('"label":"Afgan"') && sent.includes('"scope":"operate"') && sent.includes('"expiresInDays":90') && sent.includes('"defaultWorkspaceId":"docker/konf-api"'),
        sent,
      );
      const shown = await b.eval(`(() => { const d = ${inDialog('Afgan')}; return { token: !!d.querySelector('input[aria-label=Token]')?.value.startsWith('cpat_'), url: d.querySelector('input[aria-label="MCP URL"]')?.value ?? null, once: /shown once/.test(d.textContent) }; })()`);
      check(`${t}: the secret is shown once with the MCP URL`, shown.token && shown.url === 'https://pilot.konfersi.example/mcp' && shown.once, JSON.stringify(shown));
      f = await dialogFacts('Afgan');
      check(`${t}: the secret sheet fits, 44 px targets`, fits(f), JSON.stringify(f));
      await b.shot(`admin-token-secret-${t}`);

      await b.goto(`${base}?pass=${t}-orgs#orgs`, 2500);
      await b.waitFor(`document.querySelector('main ul > li button')`, 15_000, 'the orgs');
      await b.clickSel('main ul > li button');
      await b.waitFor(`document.querySelector('button[aria-label="Add member"]')`, 8000, 'the Add member button');
      await sleep(300);
      const removable = await b.eval(`document.querySelectorAll('[role=dialog] button[aria-label^="Remove "]').length`);
      check(`${t}: Remove is offered for the member, not the owner`, removable === 1, String(removable));
      f = await dialogFacts('Konfersi');
      check(`${t}: the org sheet with its member buttons fits, 44 px targets`, fits(f), JSON.stringify(f));
      await b.shot(`admin-org-members-${t}`);
      await b.clickSel('button[aria-label="Add member"]');
      await b.waitFor(inDialog('Add member'), 8000, 'the Add member sheet');
      await sleep(400);
      f = await dialogFacts('Add member');
      check(`${t}: Add member roles are admin, member, guest`, JSON.stringify(f.options[1]) === JSON.stringify(['admin', 'member', 'guest']), JSON.stringify(f.options[1]));
      check(`${t}: Add member offers no current member`, !f.options[0].includes('u_0') && !f.options[0].includes('u_2') && f.options[0].includes('u_1'));
      check(`${t}: Add member fits the width, 44 px targets`, fits(f), JSON.stringify(f));
      await b.shot(`admin-member-add-${t}`);
      await b.clickText('New account', { selector: '[role=dialog] label' });
      await sleep(200);
      await fill('[role=dialog][aria-label="Add member"] input[type=email]', 'afgan.ai@konfersi.example');
      await b.shot(`admin-member-new-${t}`);
      await b.clickSel('[role=dialog][aria-label="Add member"] button[type=submit]');
      await sleep(600);
      const added = await b.eval(`window.__calls.filter((c) => c.startsWith('POST /admin-api/orgs/org_konfersi/members')).at(-1) || ''`);
      check(`${t}: Add member sends the new account's email and the member role`, added.includes('"email":"afgan.ai@konfersi.example"') && added.includes('"role":"member"'), added);
      check(`${t}: the sheet closes after adding`, !(await b.eval(`!!${inDialog('Add member')}`)));
    }
  }

  const errors = b.errors.filter((e) => !/ResizeObserver/.test(e));
  check('no page errors', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
} finally {
  await b.close();
}
console.log(failed ? `FAILED ${failed}` : 'PASS');
process.exit(failed ? 1 : 0);
