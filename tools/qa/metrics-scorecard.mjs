// Usage → Metrics (T-2360: the Scorecard) over 390 px (touch, safe areas) then 1280 px, light and dark, against a scratch portal seeded with
// eleven closed tickets of a `program-qa` program (flow events, merges, verdicts), open tickets in review and blocked, and snapshots for the trend.
// It takes a screenshot of each view and asserts (QA-STANDARDS A1-A9, measured):
//   - the cards are there: scores (two score tiles), scores over time (a chart), closed, lead time, flow time, leads, account pace, findings;
//   - an unavailable figure says "unavailable" and never reads 0 (the memor.id program, and a score with no input);
//   - A2: no horizontal scroll (document and the page's content); A5: every visible control is at least 44 px tall and wide AT 390 PX
//     (a FAIL; InfoTips are counted, not failed; at 1280 px a note);
//   - a tap on a stage row opens the drill-down with a link per ticket to its page;
//   - the Glance widget's full form (`?glance=metrics`) shows the four numbers;
//   - nothing reads NaN, undefined or null.
// usage: tools/qa/with-portal.sh 3472 env QA_SHOTS=dir node tools/qa/metrics-scorecard.mjs [--keep]
//   Seeds /tmp/scratch-portal-$QA_PORT/data/portal.db (METRICS_DB overrides): tickets 9401-9414, snapshots of the programs `all` and `qa`;
//   removes them at the end.
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { login, PORT, sleep } from './lib.mjs';

const args = process.argv.slice(2);
mkdirSync(process.env.QA_SHOTS ?? '/tmp/qa-shots', { recursive: true });
const dbPath = process.env.METRICS_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`;
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
const H = 3_600_000;
const NUMBERS = Array.from({ length: 14 }, (_, i) => 9401 + i);
const purge = () => {
  db.exec(`DELETE FROM tickets WHERE number BETWEEN 9401 AND 9414; DELETE FROM lab_metric_snapshots WHERE program IN ('all', 'qa')`);
};
const seed = () => {
  purge();
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const ago = (h) => iso(now - h * H);
  const tk = db.prepare(`INSERT INTO tickets (number, type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at, closed_at)
    VALUES (?, ?, ?, 2, ?, ?, 'human', 'ui', 'owner', ?, ?, ?)`);
  const tag = db.prepare('INSERT INTO ticket_tags (ticket_number, tag) VALUES (?, ?)');
  const ev = db.prepare(`INSERT INTO ticket_events (ticket_number, at, kind, actor, actor_label, body, data) VALUES (?, ?, ?, ?, 'qa', ?, ?)`);
  const merge = db.prepare(`INSERT INTO ticket_merge_status (ticket_number, repo, pr, pr_head, state, actor, actor_label, at) VALUES (?, 'claudepilot', 7, ?, 'merged', 'system', 'gate', ?)`);
  const sha = 'ab12'.repeat(10);
  // Eleven closed tickets: created c hours ago, started +1, an agent comment, a self-test line, merged, closed d hours ago.
  const closed = [
    [1, 20, 0.4, 'area-web'], [2, 19, 1.2, 'area-web'], [3, 15, 2.5, 'area-api'], [4, 14, 3.1, 'area-api'], [5, 13, 3.8, 'area-web'],
    [6, 12, 5.0, 'area-api'], [7, 11, 7.5, 'area-web'], [8, 9, 8.2, 'area-web'], [9, 8, 10, 'area-api'], [10, 6, 12, 'area-web'], [11, 40, 16, 'area-api'],
  ];
  closed.forEach(([i, created, closedAgo, area], k) => {
    const n = 9400 + i;
    tk.run(n, k % 3 === 0 ? 'bug' : 'feature', k % 4 === 0 ? 'high' : 'normal', 'done', `QA metrics done ${i}`, ago(created), ago(closedAgo), ago(closedAgo));
    tag.run(n, 'program-qa');
    tag.run(n, area);
    ev.run(n, ago(created - 1), 'status', 'session:qa-w1', null, JSON.stringify({ from: 'open', to: 'in_progress' }));
    ev.run(n, ago(created - 1.5), 'comment', 'session:qa-w1', 'Plan: the loader first.', null);
    ev.run(n, ago(closedAgo + 2), 'comment', 'session:qa-w1', `Done.\nSelf-test: claudepilot-job-${i} on ${sha} pass ${i}`, null);
    merge.run(n, sha, ago(closedAgo + 0.5));
  });
  tk.run(9412, 'bug', 'normal', 'wont_do', 'QA metrics won\'t do', ago(10), ago(2), ago(2));
  tag.run(9412, 'program-qa');
  tk.run(9413, 'feature', 'high', 'in_review', 'QA metrics in review', ago(30), ago(5), null);
  tag.run(9413, 'program-qa');
  ev.run(9413, ago(5), 'status', 'session:qa-w1', null, JSON.stringify({ from: 'in_progress', to: 'in_review' }));
  tk.run(9414, 'task', 'normal', 'blocked', 'QA metrics blocked', ago(30), ago(28), null);
  tag.run(9414, 'program-qa');
  // Snapshots every 90 minutes over the last day; one reading with no effectiveness (a gap, not a zero).
  const snap = db.prepare('INSERT INTO lab_metric_snapshots (at_ms, program, metrics) VALUES (?, ?, ?)');
  for (let i = 16; i >= 0; i--) {
    const eff = 52 + Math.round(18 * Math.sin(i / 3)) + (16 - i);
    const eft = i === 6 ? null : 61 + Math.round(10 * Math.cos(i / 4)) + Math.floor((16 - i) / 2);
    for (const program of ['all', 'qa']) snap.run(now - i * 1.5 * H, program, JSON.stringify({ efficiency: eff, effectiveness: eft }));
  }
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
  const bad = [...root.querySelectorAll('li, span, p, dd, dt, text')].filter((e) => vis(e) && e.children.length === 0 && /\\b(NaN|undefined|null)\\b/.test(e.textContent || '')).map(desc);
  const cards = [...root.querySelectorAll('[data-metric-card]')].map((e) => e.getAttribute('data-metric-card'));
  return {
    vw: innerWidth, docScroll: doc.scrollWidth, docClient: doc.clientWidth, rootScroll: root.scrollWidth, rootClient: root.clientWidth,
    small: ctl.filter((e) => !tip(e) && small(e)).map((e) => { const r = e.getBoundingClientRect(); return desc(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }),
    smallTips: ctl.filter((e) => tip(e) && small(e)).length,
    bad, text: root.innerText, cards,
    scores: root.querySelectorAll('[data-metric-score]').length,
    svgs: root.querySelectorAll('svg[aria-label], svg [role=img][aria-label]').length,
    tips: [...root.querySelectorAll('[data-metric-card]')].filter((c) => c.querySelector('[aria-label^="About"]')).length,
  };
})()`;
const m = (b) => b.eval(MEASURE);
const noScroll = (s) => s.docScroll <= s.docClient + 1 && s.rootScroll <= s.rootClient + 1;
const clickLabel = (b, text) =>
  b.eval(`(() => { const e = [...document.querySelectorAll('button, [role=tab], [role=radio], label')].find((x) => (x.innerText || x.getAttribute('aria-label') || '').trim() === ${JSON.stringify(text)}); if (!e) return false; e.click(); return true; })()`);

const cookie = await login();
const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);
const SIZES = [
  { name: '390', w: 390, h: 844, mobile: true, insets: { top: 47, left: 0, right: 0, bottom: 34 } },
  { name: '1280', w: 1280, h: 900, mobile: false, insets: { top: 0, left: 0, right: 0, bottom: 0 } },
];
const CARDS = ['scores', 'trend', 'closed', 'leadtime', 'stages', 'leads', 'pace', 'insights'];
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
      await b.goto('/admin/usage?tab=metrics', 2500);
      await b.waitFor(`document.querySelectorAll('[data-metric-card]').length >= 6`, LOAD_MS, 'the metric cards').catch(() => {});
      await sleep(1500);

      // The program picker: `all` first; select the seeded program.
      check(`${tag}: Metrics tab lists a Program picker and a Window picker`, await b.eval(`/Program/.test(document.body.innerText) && [...document.querySelectorAll('button, label, [role=radio]')].some((x) => (x.innerText || '').trim() === '24h') && [...document.querySelectorAll('button, label, [role=radio]')].some((x) => (x.innerText || '').trim() === '7d')`));
      let s = await m(b);
      check(`${tag}: all programs: both score tiles and every card`, s.scores === 2 && CARDS.every((c) => s.cards.includes(c)), JSON.stringify([s.scores, s.cards]));
      check(`${tag}: charts have a label (an SVG with a name)`, s.svgs >= 3, `svgs=${s.svgs}`);
      check(`${tag}: no NaN, undefined or null text`, s.bad.length === 0, JSON.stringify(s.bad));
      check(`${tag}: no sideways scroll`, noScroll(s), JSON.stringify([s.docScroll, s.docClient, s.rootScroll, s.rootClient]));
      sizes(`${tag}: controls >= 44 px`, size.mobile, s.small);
      console.log(`  info InfoTips under 44 px: ${s.smallTips}; cards with a tip: ${s.tips}/${s.cards.length}`);
      await b.shot(`metrics-all-${tag}`, { full: true });

      // The seeded program (a program-* tag adds one by itself).
      const picked = (await clickLabel(b, 'qa')) || (await b.eval(`(() => { const sel = document.querySelector('select'); if (!sel) return false; sel.value = 'qa'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`));
      check(`${tag}: the program qa can be chosen`, picked);
      await sleep(2500);
      s = await m(b);
      check(`${tag}: program qa: scores, trend, stages and findings show`, s.scores === 2 && CARDS.every((c) => s.cards.includes(c)), JSON.stringify(s.cards));
      check(`${tag}: program qa: no NaN, no sideways scroll`, s.bad.length === 0 && noScroll(s));
      check(`${tag}: program qa: the stage rows carry median and p90 in words`, /Start|Implement|Deliver/.test(s.text) && /median|p90|\d+\s?(m|h|d)/.test(s.text));
      await b.shot(`metrics-qa-${tag}`, { full: true });

      // The drill-down: a tap on a stage row lists the tickets behind it, a link each.
      const opened = await b.eval(`(() => { const row = document.querySelector('[data-metric-card="stages"] button[aria-pressed]'); if (!row) return false; row.click(); return true; })()`);
      check(`${tag}: a stage row can be tapped`, opened);
      await b.waitFor(`document.querySelectorAll('[data-metric-drill] a[href^="/admin/tickets/"]').length > 0`, LOAD_MS, 'drill links').catch(() => {});
      await sleep(400);
      const drill = await b.eval(`(() => { const links = [...document.querySelectorAll('[data-metric-drill] a[href^="/admin/tickets/"]')]; const small = links.filter((a) => { const r = a.getBoundingClientRect(); return r.height < 43.5; }).length; return { n: links.length, small, first: links[0]?.getAttribute('href') ?? null, vw: document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth + 1 }; })()`);
      check(`${tag}: the drill-down links the tickets behind the number`, drill.n > 0 && /^\/admin\/tickets\/T?-?\d+/.test(drill.first ?? ''), JSON.stringify(drill));
      check(`${tag}: drill-down rows are at least 44 px tall, no sideways scroll`, drill.small === 0 && drill.vw, JSON.stringify(drill));
      await b.shot(`metrics-drill-${tag}`);
      await b.key('Escape');
      await sleep(300);

      // The window picker.
      check(`${tag}: window 7d clicks`, await clickLabel(b, '7d'));
      await sleep(2500);
      s = await m(b);
      check(`${tag}: 7d: the cards still show, no sideways scroll, no NaN`, CARDS.every((c) => s.cards.includes(c)) && noScroll(s) && s.bad.length === 0);
      await b.shot(`metrics-qa-7d-${tag}`, { full: true });

      // An unavailable program says so (memor.id has no tickets in the portal).
      const memor = (await clickLabel(b, 'memor.id')) || (await b.eval(`(() => { const sel = document.querySelector('select'); if (!sel) return false; const o = [...sel.options].find((x) => /memor/.test(x.textContent)); if (!o) return false; sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`));
      if (memor) {
        await sleep(2000);
        s = await m(b);
        check(`${tag}: an unavailable program says "unavailable" with its reason, and no score is 0`, /unavailable/i.test(s.text) && !/\b0\b\s*\/\s*100/.test(s.text) && s.bad.length === 0);
        await b.shot(`metrics-unavailable-${tag}`);
      } else console.log('  note: no memor.id program in this portal; the unavailable program is not exercised');

      // The Glance widget's full form.
      await b.goto('/admin/home?glance=metrics', 2500);
      await b.waitFor(`!!document.querySelector('[data-metrics-card]')`, LOAD_MS, 'the glance card').catch(() => {});
      await sleep(800);
      const g = await b.eval(`(() => { const c = document.querySelector('[data-metrics-card]'); return c ? { text: c.innerText, w: c.scrollWidth <= c.clientWidth + 1 } : null; })()`);
      check(`${tag}: the Glance widget shows Efficiency, Effective, Resolved and Median`, !!g && /Efficiency/.test(g.text) && /Effective/.test(g.text) && /Resolved/.test(g.text) && /Median/.test(g.text) && !/\b(NaN|undefined|null)\b/.test(g.text), JSON.stringify(g));
      await b.shot(`metrics-glance-${tag}`);
    }
  }
} finally {
  if (!args.includes('--keep')) purge();
  await b.close();
}
console.log(failed ? `\n${failed} check(s) FAILED; screenshots in ${process.env.QA_SHOTS ?? '/tmp/qa-shots'}` : `\nall checks passed; screenshots in ${process.env.QA_SHOTS ?? '/tmp/qa-shots'}`);
process.exit(failed ? 1 : 0);
