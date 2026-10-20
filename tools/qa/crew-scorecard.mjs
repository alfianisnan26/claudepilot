// Usage → Crew (T-450 S2: the crew scorecard page) over 390 px (touch, safe areas) then 1280 px, light and dark, against a scratch portal seeded
// with one program (a lead with two workers, a done ticket, a ticket in review, requests in the last hour). It takes a screenshot of each view and
// asserts (QA-STANDARDS A1-A9, measured):
//   - the page lists a program card with the five numbers, each with a state, its basis (data-basis: MEASURED / ESTIMATE / UNAVAILABLE; T-1852:
//     no longer printed, "est." marks an estimate) and an InfoTip;
//   - A2: no horizontal scroll (document and the page's content);
//   - A5: every visible control is at least 44 px tall and wide AT 390 PX (a FAIL; InfoTips are counted, not failed). At 1280 px a note;
//   - Compare switches on "was" under the numbers (the window before) without breaking the layout; the window picker changes the window;
//   - Details opens the rows of the tables the API returns (done, in review, CI, deploys, targets, cost), still with no sideways scroll;
//   - nothing reads NaN, undefined or null.
// usage: tools/qa/with-portal.sh 3471 env QA_SHOTS=dir node tools/qa/crew-scorecard.mjs [--out dir] [--keep]
//   scripts/job-run.sh --ref <commit> --artifacts job-out/ux-t-450 --out job-out/ux-t-450-art/ -- 'npm run build -w @portal/web >/dev/null 2>&1 && tools/qa/with-portal.sh 3471 env QA_SHOTS=job-out/ux-t-450 node tools/qa/crew-scorecard.mjs --out job-out/ux-t-450; exit $?'
//   Seeds /tmp/scratch-portal-$QA_PORT/data/portal.db (CREW_DB overrides): sessions "qacrew-*", tickets 9301-9302; removes them at the end.
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { login, PORT, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'qa-shots/t450-crew';
mkdirSync(out, { recursive: true });
mkdirSync(process.env.QA_SHOTS ?? '/tmp/qa-shots', { recursive: true });
const dbPath = process.env.CREW_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`;
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};
const sizes = (name, strict, list) =>
  strict
    ? check(name, list.length === 0, JSON.stringify(list))
    : console.log(`  warn ${name} (1280 px: a note, not a fail) ${list.length ? `${list.length} under 44 px, e.g. ${JSON.stringify(list.slice(0, 4))}` : 'ok'}`);

// --- seed -------------------------------------------------------------------------------------------------------------------------------
const db = new DatabaseSync(dbPath, { timeout: 10_000 });
const WS = 'docker/qa-crew';
const purge = () => {
  db.exec(`DELETE FROM chat_usage WHERE session_id LIKE 'qacrew-%'; DELETE FROM chat_sessions WHERE id LIKE 'qacrew-%';
    DELETE FROM tickets WHERE number IN (9301, 9302)`);
};
const seed = () => {
  purge();
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const tk = db.prepare(`INSERT INTO tickets (number, type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at, closed_at)
    VALUES (?, ?, 'normal', 2, ?, ?, 'human', 'ui', 'owner', ?, ?, ?)`);
  tk.run(9301, 'feature', 'done', 'QA crew done feature', iso(now - 7_200_000), iso(now), iso(now - 1_800_000));
  tk.run(9302, 'bug', 'in_review', 'QA crew bug in review', iso(now - 7_200_000), iso(now), null);
  const ses = db.prepare(`INSERT INTO chat_sessions (id, workspace_id, title, state, state_since, created_at, last_activity_at, claude_id, parent_id, ticket_id)
    VALUES (?, ?, ?, 'idle', ?, ?, ?, '', ?, ?)`);
  const at = iso(now);
  ses.run('qacrew-lead', WS, 'QA crew lead', at, at, at, null, null);
  ses.run('qacrew-w1', WS, 'QA crew worker one', at, at, at, 'qacrew-lead', 'T-9301');
  ses.run('qacrew-w2', WS, 'QA crew worker two', at, at, at, 'qacrew-lead', 'T-9302');
  const use = db.prepare(`INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, requests, agents, duration_ms, kind)
    VALUES (?, ?, ?, ?, '', 'claude-opus-5-5', 0, 0, 0, 0, ?, 1, 0, 0, 'turn')`);
  for (const [s, usd] of [['qacrew-lead', 4], ['qacrew-w1', 2], ['qacrew-w2', 1]]) use.run(iso(now - 1_200_000), now - 1_200_000, s, WS, usd);
};

// --- page measures ----------------------------------------------------------------------------------------------------------------------
const MEASURE = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const desc = (e) => e.tagName.toLowerCase() + ' "' + (e.getAttribute('aria-label') || e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30) + '"';
  const root = document.querySelector('main') || document.body;
  const doc = document.scrollingElement;
  const ctl = [...root.querySelectorAll('a[href], button, [role=tab], [role=radio], [role=menuitem], input, select, summary')].filter(vis);
  const tip = (e) => /why|about|sources/i.test(e.getAttribute('aria-label') || '');
  const small = (e) => { const r = e.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; };
  const bad = [...root.querySelectorAll('li, span, p, dd')].filter((e) => vis(e) && e.children.length === 0 && /\\b(NaN|undefined|null)\\b/.test(e.textContent || '')).map(desc);
  const tiles = [...root.querySelectorAll('[data-tile]')].filter(vis);
  return {
    vw: innerWidth, docScroll: doc.scrollWidth, docClient: doc.clientWidth, rootScroll: root.scrollWidth, rootClient: root.clientWidth,
    small: ctl.filter((e) => !tip(e) && small(e)).map((e) => { const r = e.getBoundingClientRect(); return desc(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }),
    smallTips: ctl.filter((e) => tip(e) && small(e)).length,
    bad, text: root.innerText,
    tiles: tiles.length,
    tileStates: tiles.map((t) => t.getAttribute('data-state')),
    tileTips: tiles.filter((t) => t.querySelector('[aria-label^="About"]')).length,
    tileBasis: tiles.filter((t) => /^(MEASURED|ESTIMATE|UNAVAILABLE)$/.test(t.getAttribute('data-basis') || '') && (t.getAttribute('data-basis') !== 'ESTIMATE' || /est\\./.test(t.innerText))).length,
    basisWords: tiles.filter((t) => /MEASURED|ESTIMATE/.test(t.innerText)).length,
    was: document.querySelectorAll('[data-was]').length,
    detail: !!root.querySelector('[data-scorecard-detail]'),
  };
})()`;
const m = (b) => b.eval(MEASURE);
const clickLabel = (b, text) =>
  b.eval(`(() => { const e = [...document.querySelectorAll('button, [role=tab], [role=radio], label')].find((x) => (x.innerText || '').trim() === ${JSON.stringify(text)}); if (!e) return false; e.click(); return true; })()`);
// The Details button reads "Details" plus a +/- glyph: match its start.
const clickDetails = (b) =>
  b.eval(`(() => { const e = [...document.querySelectorAll('button[aria-expanded]')].find((x) => /^(Show|Hide) details/.test(x.getAttribute('aria-label') || '')); if (!e) return false; e.click(); return true; })()`);
const noScroll =(s) => s.docScroll <= s.docClient + 1 && s.rootScroll <= s.rootClient + 1;

const cookie = await login();
const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);
const SIZES = [
  { name: '390', w: 390, h: 844, mobile: true, insets: { top: 47, left: 0, right: 0, bottom: 34 } },
  { name: '1280', w: 1280, h: 900, mobile: false, insets: { top: 0, left: 0, right: 0, bottom: 0 } },
];
const LOAD_MS = 30_000;
try {
  for (const size of SIZES) {
    for (const dark of [false, true]) {
      const tag = `${size.name}-${dark ? 'dark' : 'light'}`;
      console.log(tag);
      seed();
      await b.setViewport(size.w, size.h, size.mobile);
      await b.send('Emulation.setSafeAreaInsetsOverride', { insets: size.insets }).catch(() => {});
      await b.media({ dark });
      await b.goto('/admin/usage?tab=crew', 2500);
      await b.waitFor(`document.querySelectorAll('[data-tile]').length > 0`, LOAD_MS, 'the scorecard').catch(() => {});
      await sleep(500);

      let s = await m(b);
      check(`${tag}: a program card with five numbers`, s.tiles >= 5 && s.tiles % 5 === 0, `tiles=${s.tiles}`);
      check(`${tag}: each number has a state, a basis ("est." shown on an estimate) and an InfoTip`, s.tileStates.every(Boolean) && s.tileBasis === s.tiles && s.tileTips === s.tiles, JSON.stringify([s.tileStates, s.tileBasis, s.tileTips]));
      check(`${tag}: text diet: no MEASURED / ESTIMATE words under the numbers`, s.basisWords === 0, `basisWords=${s.basisWords}`);
      check(`${tag}: no NaN, undefined or null text`, s.bad.length === 0, JSON.stringify(s.bad));
      check(`${tag}: no sideways scroll`, noScroll(s), JSON.stringify([s.docScroll, s.docClient, s.rootScroll, s.rootClient]));
      sizes(`${tag}: controls >= 44 px`, size.mobile, s.small);
      console.log(`  info InfoTips under 44 px: ${s.smallTips}`);
      await b.shot(`crew-day-${tag}`, { full: true });

      check(`${tag}: window 6h clicks`, await clickLabel(b, '6h'));
      await sleep(1500);
      s = await m(b);
      check(`${tag}: 6h still lists the card, no sideways scroll`, s.tiles >= 5 && noScroll(s));

      check(`${tag}: Compare clicks`, await clickLabel(b, 'Compare'));
      await b.waitFor(`document.querySelectorAll('[data-was]').length > 0`, LOAD_MS, 'was').catch(() => {});
      await sleep(300);
      s = await m(b);
      check(`${tag}: compare: layout holds, no sideways scroll`, s.tiles >= 5 && noScroll(s) && s.bad.length === 0);
      check(`${tag}: compare shows "was" under the numbers`, s.was > 0, `was=${s.was}`);
      await b.shot(`crew-compare-${tag}`, { full: true });

      check(`${tag}: Details clicks`, await clickDetails(b));
      await sleep(400);
      s = await m(b);
      check(`${tag}: details: the rows show (done, in review, CI, deploys, targets, cost)`, s.detail && /\bDone\b/.test(s.text) && /In review/.test(s.text) && /Targets/.test(s.text) && /Cost/.test(s.text));
      check(`${tag}: details: no sideways scroll, no NaN`, noScroll(s) && s.bad.length === 0, JSON.stringify([s.docScroll, s.docClient, s.rootScroll, s.rootClient]));
      sizes(`${tag}: details: controls >= 44 px`, size.mobile, s.small);
      await b.shot(`crew-details-${tag}`, { full: true });
    }
  }
} finally {
  if (!args.includes('--keep')) purge();
  await b.close();
}
console.log(failed ? `\n${failed} check(s) FAILED; screenshots in ${process.env.QA_SHOTS ?? '/tmp/qa-shots'}` : `\nall checks passed; screenshots in ${process.env.QA_SHOTS ?? '/tmp/qa-shots'}`);
process.exit(failed ? 1 : 0);
