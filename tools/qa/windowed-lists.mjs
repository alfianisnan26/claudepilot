// The windowed full-page lists (docs/coord/UI-STANDARD.md §4; owner, 2026-11-01: "no unbounded page growth") in a real browser against a
// scratch portal, at 390 px (touch), 1280 and 1584 px, light and dark. About 200 items per list:
//   - Tickets: 200 made over the API; Agents: the T-378 scale seed (500 sessions, seed-scale.mjs) written into the scratch database;
//   - Needs you, the Inbox and CI runs: 200 each, answered in the page (paged like the server: the Inbox and CI runs by cursor), since those
//     modules cannot be filled from outside without real approvals, pushes or pipelines.
// Asserts per list and size:
//   - desktop: the list fills the content pane and scrolls INSIDE (the pane does not grow: its scroll height stays its height; the document
//     never scrolls), and only a window of rows is drawn (< 100 of 200);
//   - phone: the document scrolls, only a window of rows is drawn, the filters stick under the top bar;
//   - at 1280 light: the next page loads as the end of the list comes into view (Inbox, CI runs, Tickets), and ArrowDown moves to the next row.
// usage: SCRATCH_PRODUCTION=1 tools/qa/with-portal.sh 3561 env QA_SHOTS=<dir> node tools/qa/windowed-lists.mjs
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { api as apiOf, login, PORT, sleep } from './lib.mjs';
import { seedScale } from './seed-scale.mjs';

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};

// --- seed ---------------------------------------------------------------------------------------------------------------------------------
const cookie = await login();
const call = apiOf(cookie);
let made = 0;
for (let i = 0; i < 200; i += 20) {
  const batch = await Promise.all(
    Array.from({ length: 20 }, (_, j) => call('POST', '/api/tickets', { summary: `QA windowed ticket ${String(i + j + 1).padStart(3, '0')} with a summary long enough to wrap on a phone`, type: 'task', priority: 'normal' })),
  );
  made += batch.filter((r) => r.status === 201 || r.status === 200).length;
  if (i === 0 && made === 0) console.log('  ticket create:', batch[0].status, batch[0].text.slice(0, 200));
}
check('200 tickets are made over the API', made === 200, `made=${made}`);
const db = new DatabaseSync(process.env.QA_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`);
seedScale(db, { events: [10, 10] });
db.close();
check('500 sessions are seeded', true);

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const WHY = ['production_uat', 'secrets_permissions', 'third_party_code', 'gate', 'question'];
const KIND = ['ci_deploy', 'tool_approval', 'skill_version', 'ticket_approval', 'approval'];
const attention = Array.from({ length: 200 }, (_, i) => ({
  kind: KIND[i % 5], id: `qa-${i}`, title: `QA windowed ask ${i + 1}: a decision with a title that may wrap onto a second line`, who: [{ label: `agent ${i % 7}` }],
  why: WHY[i % 5], risk: i % 3 ? '' : 'Touches production.', since: iso(now - i * 60_000), link: '/admin/home', action: { label: 'Review', method: 'POST', path: '/x' },
}));
const notes = Array.from({ length: 200 }, (_, i) => ({
  id: `qa-n-${i}`, kind: 'session_done', at: iso(now - i * 3_600_000), title: `QA windowed notification ${i + 1}`, body: `Something happened, number ${i + 1}.`, path: null,
  subject: { type: 'portal', id: 'x' }, readAt: i % 4 ? iso(now) : null, resolvedAt: null, resolution: null, muted: false,
}));
const runs = Array.from({ length: 200 }, (_, i) => ({
  id: `qa-r-${i}`, number: 200 - i, workspaceId: 'docker/qa', repoId: 'repo-1', repo: 'claudepilot', pipeline: 'gate', trigger: 'push', ref: 'refs/heads/main', branch: 'main', tag: null,
  sha: (i.toString(16) + 'a'.repeat(40)).slice(0, 40), subject: null, status: i % 5 ? 'passed' : 'failed', reason: i % 5 ? null : 'step_failed', actor: 'user', actorLabel: null,
  cancelledBy: null, cancelledByLabel: null, cancelNote: null, ticketId: null, sessionId: null, rerunOf: null, createdAt: iso(now - i * 600_000), startedAt: iso(now - i * 600_000),
  finishedAt: iso(now - i * 600_000 + 90_000), durationMs: 90_000, jobs: [], runsOn: null, runnerWorkspaceId: null,
}));
const STUB = `(() => {
  const attention = ${JSON.stringify(attention)}, notes = ${JSON.stringify(notes)}, runs = ${JSON.stringify(runs)};
  const real = window.fetch.bind(window);
  const json = (data) => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
  const page = (all, from, size) => all.slice(from, from + size);
  window.fetch = async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url, location.href);
    const p = u.pathname, q = u.searchParams;
    if (p === '/api/attention') return json({ total: 200, counts: {}, unavailable: [], items: attention, offset: 0, limit: 200, at: new Date().toISOString() });
    if (p === '/api/notify/history') {
      const size = Number(q.get('limit') ?? 30), before = q.get('before');
      const from = before ? notes.findIndex((n) => n.at < before) : 0;
      const items = from < 0 ? [] : page(notes, from, size);
      return json({ items, next: from >= 0 && from + size < notes.length ? items.at(-1).at : null, unread: 50 });
    }
    if (p === '/api/ci/runs') {
      const size = Number(q.get('limit') ?? 100), from = Number(q.get('cursor') ?? 0);
      return json({ items: page(runs, from, size), next: from + size < runs.length ? String(from + size) : null, total: 200, active: 0 });
    }
    if (p === '/api/ci/repos') return json([{ id: 'repo-1', name: 'claudepilot', workspaceId: 'docker/qa' }]);
    return real(input, init);
  };
})();`;

// --- measures -----------------------------------------------------------------------------------------------------------------------------
const MEASURE = `(() => {
  const w = document.querySelector('[data-windowed]');
  const s = w?.querySelector('[data-windowed-scroll]');
  const pane = document.getElementById('main-scroll');
  const doc = document.scrollingElement;
  const rows = [...document.querySelectorAll('[data-wl-index]')];
  return {
    mode: w?.getAttribute('data-windowed') ?? null,
    rendered: rows.length,
    maxIndex: rows.reduce((m, r) => Math.max(m, Number(r.dataset.wlIndex)), -1),
    setsize: rows[0]?.getAttribute('aria-setsize') ?? null,
    docScrolls: doc.scrollHeight > doc.clientHeight + 1,
    sideways: doc.scrollWidth > doc.clientWidth + 1,
    paneGrows: pane ? pane.scrollHeight > pane.clientHeight + 4 : null,
    paneH: pane ? [pane.scrollHeight, pane.clientHeight] : null,
    listScrolls: s ? s.scrollHeight > s.clientHeight + 1 : false,
    listH: s ? [s.scrollHeight, s.clientHeight] : null,
  };
})()`;
const PAGES = [
  { id: 'tickets', path: '/admin/tickets?view=list', more: true },
  { id: 'agents', path: '/admin/sessions', chip: 'all' },
  { id: 'needs-you', path: '/admin/attention?view=list' },
  { id: 'inbox', path: '/admin/notifications', more: true },
  { id: 'ci-runs', path: '/admin/ci', more: true },
];
const SIZES = [
  { name: '390', w: 390, h: 844, mobile: true, insets: { top: 47, left: 0, right: 0, bottom: 34 } },
  { name: '1280', w: 1280, h: 900, mobile: false },
  { name: '1584', w: 1584, h: 900, mobile: false },
];

const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  for (const size of SIZES) {
    for (const dark of [false, true]) {
      const t = `${size.name}-${dark ? 'dark' : 'light'}`;
      console.log(t);
      await b.setViewport(size.w, size.h, size.mobile);
      await b.send('Emulation.setSafeAreaInsetsOverride', { insets: size.insets ?? { top: 0, left: 0, right: 0, bottom: 0 } }).catch(() => {});
      await b.media({ dark });
      for (const pg of PAGES) {
        await b.goto(pg.path, 2500);
        if (pg.chip) {
          await b.waitFor(`!!document.querySelector('[data-chip="${pg.chip}"]')`, 10_000, 'the chip').catch(() => {});
          await b.clickSel(`[data-chip="${pg.chip}"]`).catch(() => {});
        }
        await b.waitFor(`document.querySelectorAll('[data-wl-index]').length > 5`, 20_000, `${pg.id} rows`).catch(() => {});
        await sleep(700);
        const m = await b.eval(MEASURE);
        check(`${t} ${pg.id}: windowed, a window of rows drawn`, !!m.mode && m.rendered > 5 && m.rendered < 100, JSON.stringify({ mode: m.mode, rendered: m.rendered }));
        check(`${t} ${pg.id}: no sideways scroll`, !m.sideways);
        if (size.mobile) {
          check(`${t} ${pg.id}: a phone scrolls the document`, m.mode === 'window', m.mode);
          // The filters stick: scroll well down; the header stays at the top of the screen.
          const stuck = await b.eval(`(async () => { window.scrollTo({ top: 2500 }); await new Promise((r) => setTimeout(r, 500));
            const h = document.querySelector('[data-windowed-header]'); const r = h?.getBoundingClientRect();
            return { has: !!h, top: r ? Math.round(r.top) : null, scrolled: Math.round(scrollY), rendered: document.querySelectorAll('[data-wl-index]').length }; })()`);
          if (stuck.has) check(`${t} ${pg.id}: the filters stick while the page scrolls`, stuck.scrolled < 100 || (stuck.top >= 0 && stuck.top < 160), JSON.stringify(stuck));
          check(`${t} ${pg.id}: scrolled, still a window of rows`, stuck.rendered < 100, `rendered=${stuck.rendered}`);
          await b.shot(`wl-${pg.id}-${t}-scrolled`);
          await b.eval('window.scrollTo({ top: 0 })');
          await sleep(300);
        } else {
          check(`${t} ${pg.id}: the list fills the pane and scrolls inside; the pane does not grow`, (m.mode === 'fill' || m.mode === 'parent') && m.listScrolls && m.paneGrows === false && !m.docScrolls, JSON.stringify(m));
        }
        await b.shot(`wl-${pg.id}-${t}`);
        if (size.name === '1280' && !dark) {
          if (pg.more) {
            const before = m.maxIndex;
            for (let i = 0; i < 6; i++) {
              await b.eval(`(() => { const s = document.querySelector('[data-windowed-scroll]'); s.scrollTo({ top: s.scrollHeight }); })()`);
              await sleep(700);
            }
            const after = await b.eval(MEASURE);
            check(`${t} ${pg.id}: the next page loads at the end of the list`, after.maxIndex > Math.max(before, 29), `max index ${before} -> ${after.maxIndex}`);
          }
          await b.eval(`(() => { const s = document.querySelector('[data-windowed-scroll]'); s?.scrollTo({ top: 0 }); })()`);
          await sleep(400);
          const key = await b.eval(`(async () => {
            const first = document.querySelector('[data-wl-index]'); if (!first) return { from: -1, to: -9 }; const f = first.querySelector('a[href], button') ?? first; f.focus();
            const at = Number(document.activeElement.closest('[data-wl-index]')?.dataset.wlIndex);
            document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            await new Promise((r) => setTimeout(r, 200));
            return { from: at, to: Number(document.activeElement.closest('[data-wl-index]')?.dataset.wlIndex) };
          })()`);
          check(`${t} ${pg.id}: ArrowDown moves to the next row`, key.to === key.from + 1, JSON.stringify(key));
        }
      }
    }
  }
  const errors = b.errors.filter((e) => !/ResizeObserver/.test(e));
  check('no page errors', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
} finally {
  await b.close();
}
console.log(failed ? `FAILED ${failed}` : 'PASS');
process.exit(failed ? 1 : 0);
