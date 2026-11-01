// The Admin console on the UI standard (docs/coord/UI-STANDARD.md; owner, 2026-11-01), in a real browser at 390, 1280 and 1584 px, light and
// dark. The console's own build is served by `vite preview` and its API is answered in the page (a stand-in admin session, 200 users, 200
// audit rows paged like the server, an org with members), so no admin host is needed. It screenshots and asserts:
//   - desktop: only the content pane scrolls (the document never does) and the content takes the full width; phone: the document scrolls;
//   - Users: the shared pill tabs All / Admins / Members / Disabled, 44 px, each showing only its rows (counted by the list's set size); the
//     list is windowed (fewer than 100 rows drawn of 200) and, on a desktop, fills the pane and scrolls inside without growing it;
//   - Users and Orgs: master-detail: on a desktop the detail opens beside the list (the list stays), on a phone as a sheet;
//   - Orgs detail: tabs Overview / Members / Objects / Invitations / Break-glass, one section at a time;
//   - Audit: tabs All / Refused / Org / Security; windowed; the next page loads at the end of the list (1280);
//   - owner need 2026-11-01 (feat/admin-member-token): the user's Tokens -> New (no admin scope offered to a member, the secret shown once
//     with the MCP URL) and the org's Members tab -> Add (roles admin/member/guest, an existing account or a new one), Remove for a member
//     and not the owner: each sheet fits, 44 px targets, and sends what it says;
//   - step-up: a write answered REAUTH_REQUIRED opens "Confirm it's you"; the password confirms and the action RUNS BY ITSELF (no second tap);
//     with the provider configured, a popup's "stepped" message (the BroadcastChannel the popup page uses) resumes it too.
// usage (after `npm run build -w @portal/web`):
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
const N = 200;
const users = Array.from({ length: N }, (_, i) => ({
  id: `u_${i}`,
  email: `person-${String(i).padStart(3, '0')}-with-a-rather-long-address@konfersi.example`,
  displayName: `Person ${i}`,
  role: i % 7 === 0 ? 'admin' : 'member',
  state: i % 9 === 4 ? 'disabled' : 'active',
  createdAt: at,
  lastLoginAt: i % 3 ? at : null,
  abilities: i % 5 === 0 ? ['orgs.create'] : [],
}));
const audit = Array.from({ length: N }, (_, i) => ({ id: N - i, at, kind: i % 4 === 0 ? 'admin.signin_refused' : i % 4 === 1 ? 'org.created' : 'account.updated', severity: i % 4 === 0 ? 'medium' : 'info', actor: 'user:u_0', subject: `user:u_${i}`, detail: { method: 'oidc', reason: 'not_allowed', email: `x${i}@example.test` } }));
const STUB = (oidc) => `(() => {
  const me = { userId: 'u_0', email: 'owner@konfersi.example', displayName: 'Owner', expiresAt: ${JSON.stringify(at)}, idleExpiresAt: ${JSON.stringify(at)}, freshUntil: null };
  const users = ${JSON.stringify(users)}, audit = ${JSON.stringify(audit)};
  const org = { id: 'o_1', name: 'Konfersi Indonesia', slug: 'konfersi', state: 'active', members: 3, owners: [{ userId: 'u_0', email: 'owner@konfersi.example', active: true }], needsOwner: false, createdAt: ${JSON.stringify(at)},
    memberList: [{ userId: 'u_0', email: 'owner@konfersi.example', displayName: 'Owner', role: 'owner' }, { userId: 'u_1', email: 'a@konfersi.example', displayName: 'A', role: 'member' }],
    objects: [{ kind: 'workspace', id: 'w1', name: 'docker/one' }], invitations: [], sso: null, domains: null, breakGlassOpen: [] };
  let fresh = false;
  window.__ended = 0;
  window.__calls = [];
  const json = (data, status = 200) => new Response(JSON.stringify(status === 200 ? { data } : { error: data }), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url, location.href); const p = u.pathname; const m = (init?.method ?? 'GET').toUpperCase();
    window.__calls.push(m + ' ' + p + (init && init.body ? ' ' + init.body : ''));
    if (/^\\/admin-api\\/users\\/u_\\d+\\/workspaces$/.test(p)) return json([{ id: 'docker/konf-api', label: 'konf-api' }]);
    if (/^\\/admin-api\\/users\\/u_\\d+\\/tokens$/.test(p) && m === 'POST') {
      // The secret is built here at run time: no token-shaped literal in this file.
      const req = JSON.parse(init.body);
      return json({ token: { kind: 'pmcp', id: 'ptk_new', label: req.label, createdAt: me.expiresAt, expiresAt: me.expiresAt, lastUsedAt: null, revokedAt: null, scope: req.scope, defaultWorkspaceId: req.defaultWorkspaceId || null },
        secret: ['cpat', 'Q'.repeat(43)].join('_'), mcpUrl: 'https://pilot.konfersi.example/mcp' });
    }
    if (p === '/admin-api/orgs/o_1/members' && m === 'POST') return json(org);
    if (p === '/admin-api/session') return json({ ...me, freshUntil: fresh ? new Date(Date.now() + 300000).toISOString() : null });
    if (p === '/admin-api/session/methods') return json({ password: true, oidc: ${oidc ? "{ name: 'git.isnan.me' }" : 'null'} });
    if (p === '/admin-api/session/step-up' && m === 'POST') { fresh = true; return json(me); }
    if (p === '/admin-api/users') return json(users);
    if (/^\\/admin-api\\/users\\/[^/]+\\/sessions\\/end$/.test(p)) { if (!fresh) return json({ code: 'REAUTH_REQUIRED', message: 'Confirm it is you' }, 403); window.__ended++; return json({ ended: 1 }); }
    if (/^\\/admin-api\\/users\\/[^/]+$/.test(p)) { const x = users.find((y) => y.id === p.split('/').pop()); return json({ ...x, founder: false, sessions: { portal: 1, admin: 0 }, tokens: [] }); }
    if (p === '/admin-api/orgs') return json([org]);
    if (p === '/admin-api/orgs/o_1') return json(org);
    if (p === '/admin-api/audit') {
      const kind = u.searchParams.get('kind') ?? '', before = Number(u.searchParams.get('before') ?? 0), limit = Number(u.searchParams.get('limit') ?? 50);
      const rows = audit.filter((r) => !kind || r.kind === kind || r.kind.startsWith(kind + '.')).filter((r) => !before || r.id < before);
      return json(rows.slice(0, limit));
    }
    return json([]);
  };
})();`;
const MEASURE = `(() => { const doc = document.scrollingElement; const pane = document.getElementById('console-pane'); const ps = pane ? getComputedStyle(pane).overflowY : '';
  const tabs = [...document.querySelectorAll('main [role=tablist] [role=tab]')]; const rows = [...document.querySelectorAll('main [data-wl-index]')];
  const w = document.querySelector('main [data-windowed]'); const s = w?.querySelector('[data-windowed-scroll]');
  return { tabs: tabs.map((e) => e.getAttribute('data-tab')), small: tabs.filter((e) => e.getBoundingClientRect().height < 43.5).length,
    paneScrolls: ps === 'auto' || ps === 'scroll', docScrolls: doc.scrollHeight > doc.clientHeight + 1, sideways: doc.scrollWidth > doc.clientWidth + 1,
    paneGrows: pane ? pane.scrollHeight > pane.clientHeight + 4 : null, mode: w?.getAttribute('data-windowed') ?? null, listScrolls: s ? s.scrollHeight > s.clientHeight + 1 : false,
    mainWidth: Math.round(document.querySelector('main')?.getBoundingClientRect().width ?? 0), rendered: rows.length, setsize: Number(rows[0]?.getAttribute('aria-setsize') ?? 0),
    maxIndex: rows.reduce((m, r) => Math.max(m, Number(r.dataset.wlIndex)), -1) }; })()`;

const b = await Browser.launch({ width: 390, height: 844, mobile: true });
try {
  const stub = await b.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB(false) });
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
      await b.goto(`${URL_}?r=${t}#users`, 2500);
      await b.waitFor(`document.querySelectorAll('main [role=tablist] [role=tab]').length === 4 && document.querySelectorAll('main [data-wl-index]').length > 3`, 15_000, 'the Users tabs').catch(() => {});
      await sleep(400);
      let f = await b.eval(MEASURE);
      check(`${t}: Users has All, Admins, Members, Disabled`, JSON.stringify(f.tabs) === JSON.stringify(['all', 'admins', 'members', 'disabled']), JSON.stringify(f.tabs));
      check(`${t}: tabs are 44 px`, f.small === 0, String(f.small));
      check(`${t}: no sideways scroll`, !f.sideways);
      check(`${t}: All lists every user, windowed`, f.setsize === users.length && f.rendered > 3 && f.rendered < 100, `setsize=${f.setsize} rendered=${f.rendered}`);
      if (size.mobile) check(`${t}: a phone scrolls the document`, !f.paneScrolls && f.mode === 'window', JSON.stringify(f));
      else {
        check(`${t}: a desktop scrolls only the content pane; the list fills it and scrolls inside`, f.paneScrolls && !f.docScrolls && f.mode === 'fill' && f.listScrolls && f.paneGrows === false, JSON.stringify(f));
        check(`${t}: the content takes the width`, f.mainWidth >= size.w - 240 - 20, `main=${f.mainWidth}`);
      }
      await b.shot(`admin-users-all-${t}`);
      for (const [id, want] of [
        ['admins', users.filter((u) => u.state === 'active' && u.role === 'admin').length],
        ['disabled', users.filter((u) => u.state === 'disabled').length],
      ]) {
        await b.clickSel(`main [role=tab][data-tab="${id}"]`);
        await sleep(400);
        const n = (await b.eval(MEASURE)).setsize;
        check(`${t}: ${id} shows its ${want} rows`, n === want, `setsize=${n}`);
      }
      await b.clickSel('main [role=tab][data-tab="all"]');
      await sleep(300);
      // Master-detail: open a user.
      await b.clickSel('main [data-wl-index="1"] button');
      await sleep(900);
      const md = await b.eval(`({ panel: !!document.querySelector('[data-detail-panel]'), sheet: !!document.querySelector('[role=dialog]'), list: document.querySelectorAll('main [data-wl-index]').length })`);
      if (size.mobile) check(`${t}: a user opens as a sheet on a phone`, md.sheet && !md.panel, JSON.stringify(md));
      else check(`${t}: a user opens beside the list on a desktop (the list stays)`, md.panel && !md.sheet && md.list > 3, JSON.stringify(md));
      await b.shot(`admin-users-detail-${t}`);
      // Step-up: End sessions answers REAUTH_REQUIRED; the password confirms and the action runs by itself (once per pass: fresh after).
      if (size.name === '390' || (size.name === '1280' && !dark)) {
        await b.eval(`[...document.querySelectorAll('button')].find((e) => e.textContent.trim() === 'End sessions')?.click()`);
        await sleep(400);
        await b.eval(`[...document.querySelectorAll('[role=dialog] button[type=submit]')].find((e) => e.textContent.trim() === 'End')?.click()`);
        await sleep(700);
        const asked = await b.eval(`!!document.querySelector('[role=dialog][aria-label="Confirm it’s you"]')`);
        if (!dark) check(`${t}: a step-up asks once, calmly`, asked);
        if (asked) {
          await b.shot(`admin-stepup-${t}`);
          await b.focusSel('[role=dialog][aria-label="Confirm it’s you"] input[type=password]');
          await b.type('correct horse');
          await b.eval(`[...document.querySelectorAll('[role=dialog] button[type=submit]')].find((e) => e.textContent.trim() === 'Confirm')?.click()`);
          await sleep(900);
          check(`${t}: after the password the action ran by itself`, (await b.eval('window.__ended')) === 1, `ended=${await b.eval('window.__ended')}`);
        }
      }
      await b.key('Escape');
      await sleep(300);
      await b.key('Escape');
      await sleep(300);

      // Orgs: master-detail and its tabs.
      await b.eval(`location.hash = 'orgs'`);
      await b.waitFor(`document.querySelectorAll('main [data-wl-index]').length > 0`, 8000, 'orgs').catch(() => {});
      await b.clickSel('main [data-wl-index="0"] button');
      await sleep(900);
      const orgTabs = await b.eval(`[...document.querySelectorAll('[data-detail-panel] [role=tab], [role=dialog] [role=tab]')].map((e) => e.getAttribute('data-tab'))`);
      check(`${t}: the org opens with Overview, Members, Objects, Invitations, Break-glass`, JSON.stringify(orgTabs) === JSON.stringify(['overview', 'members', 'objects', 'invitations', 'breakglass']), JSON.stringify(orgTabs));
      await b.clickSel('[data-tab="members"]');
      await sleep(400);
      check(`${t}: one org section at a time`, await b.eval(`document.querySelector('[data-org-tab]')?.getAttribute('data-org-tab') === 'members'`));
      await b.shot(`admin-org-members-${t}`);
      await b.key('Escape');
      await sleep(300);

      // Audit: tabs, windowed, paging.
      await b.eval(`location.hash = 'audit'`);
      await b.waitFor(`document.querySelectorAll('main [data-wl-index]').length > 3`, 8000, 'audit').catch(() => {});
      await sleep(400);
      f = await b.eval(MEASURE);
      check(`${t}: Audit has All, Refused, Org, Security`, JSON.stringify(f.tabs) === JSON.stringify(['all', 'refused', 'org', 'security']), JSON.stringify(f.tabs));
      check(`${t}: Audit is windowed`, f.rendered > 3 && f.rendered < 100, `rendered=${f.rendered}`);
      if (!size.mobile) check(`${t}: Audit fills the pane and scrolls inside`, f.mode === 'fill' && f.listScrolls && f.paneGrows === false && !f.docScrolls, JSON.stringify(f));
      if (size.name === '1280' && !dark) {
        for (let i = 0; i < 6; i++) {
          await b.eval(`(() => { const s = document.querySelector('main [data-windowed-scroll]'); s.scrollTo({ top: s.scrollHeight }); })()`);
          await sleep(500);
        }
        const g = await b.eval(MEASURE);
        check(`${t}: Audit loads the next page at the end`, g.maxIndex >= 50, `max index ${g.maxIndex}`);
      }
      await b.shot(`admin-audit-all-${t}`);
      await b.clickSel('main [role=tab][data-tab="refused"]');
      await sleep(600);
      const kinds = await b.eval(`[...document.querySelectorAll('main [data-wl-index] .font-medium')].map((e) => e.textContent)`);
      check(`${t}: Refused shows only refused sign-ins`, kinds.length > 0 && kinds.every((k) => k === 'admin.signin_refused'), JSON.stringify(kinds.slice(0, 3)));
      await b.shot(`admin-audit-refused-${t}`);
    }
  }

  // ---------- Owner need 2026-11-01 (feat/admin-member-token): New token (a user's Tokens) and Add member (an org's Members tab) ----------
  const inDialog = (label) => `[...document.querySelectorAll('[role=dialog]')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(label)})`;
  /** A box (a sheet, or the side panel) against the viewport: its controls under 44 px (a visually hidden radio is not a target), sideways scroll, its selects' options. */
  const boxFacts = (sel) =>
    b.eval(`(() => { const d = ${sel}; if (!d) return null; const r = d.getBoundingClientRect(); const doc = document.scrollingElement;
      const small = [...d.querySelectorAll('button, input, select, textarea')].filter((e) => { const x = e.getBoundingClientRect(); return x.width > 2 && x.height > 0 && x.height < 43.5; })
        .map((e) => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 30));
      const options = (i) => [...(d.querySelectorAll('select')[i]?.options ?? [])].map((o) => o.value);
      return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, small, sideways: doc.scrollWidth > doc.clientWidth + 1 || d.scrollWidth > d.clientWidth + 1, options: [options(0), options(1), options(2)] }; })()`);
  const pickIn = (label, nth, value) =>
    b.eval(`(() => { const el = ${inDialog(label)}.querySelectorAll('select')[${nth}];
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`);
  const fill = async (selector, text) => {
    await b.focusSel(selector);
    await b.type(text);
  };
  const fits = (f) => !!f && f.left >= 0 && f.right <= f.vw && !f.sideways && f.small.length === 0;
  // The detail: the side panel on a desktop, the sheet on a phone.
  const DETAIL = `(document.querySelector('[data-detail-panel]') ?? [...document.querySelectorAll('[role=dialog]')].at(0))`;
  const base = URL_.replace(/[?#].*$/, '');
  for (const size of [
    { name: '390', w: 390, h: 844, mobile: true },
    { name: '1280', w: 1280, h: 900, mobile: false },
  ]) {
    for (const dark of [false, true]) {
      const t = `${size.name}-${dark ? 'dark' : 'light'}`;
      console.log(`${t} sheets`);
      await b.setViewport(size.w, size.h, size.mobile);
      await b.media({ dark });
      await b.goto(`${base}?pass=${t}#users`, 2500);
      await b.waitFor(`document.querySelectorAll('main [data-wl-index] button').length > 2`, 15_000, 'the users');
      // Person 1 is an active member.
      await b.clickSel('main [data-wl-index="1"] button');
      await b.waitFor(`!!document.querySelector('button[aria-label="New token"]')`, 8000, 'the New token button');
      await b.clickSel('button[aria-label="New token"]');
      await b.waitFor(`!!${inDialog('New token')}`, 8000, 'the New token sheet');
      await sleep(400);
      let f = await boxFacts(inDialog('New token'));
      check(`${t}: New token offers read and operate only to a member`, JSON.stringify(f.options[0]) === JSON.stringify(['read', 'operate']), JSON.stringify(f.options[0]));
      check(`${t}: New token offers 7, 30, 90, 365 days`, JSON.stringify(f.options[1]) === JSON.stringify(['7', '30', '90', '365']));
      check(`${t}: New token lists the workspaces it may operate`, JSON.stringify(f.options[2]) === JSON.stringify(['', 'docker/konf-api']), JSON.stringify(f.options[2]));
      check(`${t}: New token fits the width, 44 px targets`, fits(f), JSON.stringify(f));
      await fill('[role=dialog][aria-label="New token"] input', 'Afgan');
      await pickIn('New token', 2, 'docker/konf-api');
      await sleep(200);
      await b.shot(`admin-token-new-${t}`);
      await b.eval(`${inDialog('New token')}.querySelector('button[type=submit]').click()`);
      await b.waitFor(`!!${inDialog('Afgan')}`, 8000, 'the secret sheet');
      await sleep(400);
      const sent = await b.eval(`window.__calls.filter((c) => c.startsWith('POST /admin-api/users/u_1/tokens')).at(-1) || ''`);
      check(
        `${t}: the request names the label, scope, lifetime and workspace`,
        sent.includes('"label":"Afgan"') && sent.includes('"scope":"operate"') && sent.includes('"expiresInDays":90') && sent.includes('"defaultWorkspaceId":"docker/konf-api"'),
        sent,
      );
      const shown = await b.eval(`(() => { const d = ${inDialog('Afgan')}; return { token: !!d.querySelector('input[aria-label=Token]')?.value.startsWith('cpat_'), url: d.querySelector('input[aria-label="MCP URL"]')?.value ?? null, once: /shown once/.test(d.textContent) }; })()`);
      check(`${t}: the secret is shown once with the MCP URL`, shown.token && shown.url === 'https://pilot.konfersi.example/mcp' && shown.once, JSON.stringify(shown));
      f = await boxFacts(inDialog('Afgan'));
      check(`${t}: the secret sheet fits, 44 px targets`, fits(f), JSON.stringify(f));
      await b.shot(`admin-token-secret-${t}`);

      await b.goto(`${base}?pass=${t}-orgs#orgs`, 2500);
      await b.waitFor(`!!document.querySelector('main [data-wl-index] button')`, 15_000, 'the orgs');
      await b.clickSel('main [data-wl-index="0"] button');
      await b.waitFor(`!!document.querySelector('[data-tab="members"]')`, 8000, 'the org tabs');
      await b.clickSel('[data-tab="members"]');
      await b.waitFor(`!!document.querySelector('button[aria-label="Add member"]')`, 8000, 'the Add member button');
      await sleep(300);
      const removable = await b.eval(`${DETAIL}.querySelectorAll('button[aria-label^="Remove "]').length`);
      check(`${t}: Remove is offered for the member, not the owner`, removable === 1, String(removable));
      f = await boxFacts(DETAIL);
      check(`${t}: the org's Members tab with its buttons fits, 44 px targets`, fits(f), JSON.stringify(f));
      await b.shot(`admin-org-members-buttons-${t}`);
      await b.clickSel('button[aria-label="Add member"]');
      await b.waitFor(`!!${inDialog('Add member')}`, 8000, 'the Add member sheet');
      await sleep(400);
      f = await boxFacts(inDialog('Add member'));
      check(`${t}: Add member roles are admin, member, guest`, JSON.stringify(f.options[1]) === JSON.stringify(['admin', 'member', 'guest']), JSON.stringify(f.options[1]));
      check(`${t}: Add member offers no current member`, !f.options[0].includes('u_0') && !f.options[0].includes('u_1') && f.options[0].includes('u_2'));
      check(`${t}: Add member fits the width, 44 px targets`, fits(f), JSON.stringify(f));
      await b.shot(`admin-member-add-${t}`);
      await b.eval(`[...${inDialog('Add member')}.querySelectorAll('label')].find((l) => /New account/.test(l.textContent))?.click()`);
      await sleep(200);
      await fill('[role=dialog][aria-label="Add member"] input[type=email]', 'afgan.ai@konfersi.example');
      await b.shot(`admin-member-new-${t}`);
      await b.eval(`${inDialog('Add member')}.querySelector('button[type=submit]').click()`);
      await sleep(600);
      const added = await b.eval(`window.__calls.filter((c) => c.startsWith('POST /admin-api/orgs/o_1/members')).at(-1) || ''`);
      check(`${t}: Add member sends the new account's email and the member role`, added.includes('"email":"afgan.ai@konfersi.example"') && added.includes('"role":"member"'), added);
      check(`${t}: the sheet closes after adding`, !(await b.eval(`!!${inDialog('Add member')}`)));
    }
  }

  // The OIDC popup step-up resumes the action: the popup page's message (sent here on the channel it uses) runs it, with no second tap.
  await b.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stub.identifier });
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB(true) });
  await b.setViewport(1280, 900, false);
  await b.media({ dark: false });
  await b.goto(`${URL_}?r=popup#users`, 2500);
  await b.waitFor(`document.querySelectorAll('main [data-wl-index]').length > 3`, 10_000, 'users').catch(() => {});
  await b.eval(`window.open = () => ({ closed: false, close() {} })`);
  await b.clickSel('main [data-wl-index="2"] button');
  await sleep(800);
  await b.eval(`[...document.querySelectorAll('button')].find((e) => e.textContent.trim() === 'End sessions')?.click()`);
  await sleep(400);
  await b.eval(`[...document.querySelectorAll('[role=dialog] button[type=submit]')].find((e) => e.textContent.trim() === 'End')?.click()`);
  await sleep(700);
  await b.clickSel('[data-step-up-oidc]');
  await sleep(400);
  check('popup: the dialog waits for the provider', await b.eval(`/Waiting for git\\.isnan\\.me/.test(document.querySelector('[data-step-up-oidc]')?.textContent ?? '')`));
  await b.shot('admin-stepup-popup-waiting-1280');
  await b.eval(`(async () => { await fetch('/admin-api/session/step-up', { method: 'POST' }); const c = new BroadcastChannel('pilot-admin-step-up'); c.postMessage({ type: 'admin-step-up', outcome: 'stepped' }); c.close(); })()`);
  await sleep(1200);
  check('popup: the stepped message runs the interrupted action by itself', (await b.eval('window.__ended')) === 1, `ended=${await b.eval('window.__ended')}`);
  check('popup: the dialog closes', !(await b.eval(`!!document.querySelector('[role=dialog][aria-label="Confirm it’s you"]')`)));

  const errors = b.errors.filter((e) => !/ResizeObserver/.test(e));
  check('no page errors', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
} finally {
  await b.close();
}
console.log(failed ? `FAILED ${failed}` : 'PASS');
process.exit(failed ? 1 : 0);
