// T-376 S2 check: opening a chat session reads only the newest page of history; older pages load on scroll up.
// Seeds one long session (tools/qa/seed-perf.mjs) into the scratch portal's database, then at 390 px and 1280 px, light and dark:
//   1. open: exactly ONE GET /api/chat/sessions/<id>/events, and the newest row is at the bottom (gap 0)
//   2. scroll up: exactly ONE more read (before=...) and the row the reader looks at moves at most 1 px
//   3. scroll to the oldest page ("Start of the chat"): no read after the last page
// Run against a PRODUCTION web build (apps/web/dist), never the Vite dev server:
//   scripts/job-run.sh --ref <commit> --out job-out/ -- 'tools/qa/with-portal.sh 3481 node tools/qa/chat-paging.mjs --out job-out/chat-paging; exit $?'
// Needs Chromium (the dev image, or a Job). Options: --out <dir> (screenshots and summary.json, default /tmp/qa-shots/chat-paging),
// --events <n> (seeded transcript length, default 6000). Env QA_PORT, QA_CODE as in lib.mjs. Exit 1 when a check fails.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const OUT = resolve(arg('out', '/tmp/qa-shots/chat-paging'));
const EVENTS = Number(arg('events', '6000'));
mkdirSync(OUT, { recursive: true });
process.env.QA_SHOTS = OUT; // browser.mjs reads it at import
const { Browser } = await import('./browser.mjs');
const { PORT, sleep } = await import('./lib.mjs');

// The seed writes the scratch portal's database directly (the portal runs; sqlite waits on the lock).
const db = process.env.QA_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`;
const seeded = execFileSync('node', ['tools/qa/seed-perf.mjs', db, String(EVENTS), '1', '0'], { encoding: 'utf8' });
const SID = /session (qaperf-[0-9a-f-]+)/.exec(seeded)?.[1];
if (!SID) { console.error('seed failed: ' + seeded.slice(0, 300)); process.exit(2); }
console.log(seeded.trim().slice(0, 200));
const EVENTS_ROUTE = `/api/chat/sessions/${SID}/events`;

const results = [];
const note = (cfg, name, ok, detail) => { results.push({ cfg, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} [${cfg}] ${name}: ${detail}`); };

// In the page: find the transcript scroller, and record, for every prepend (the first row changes), how far the row the reader was looking at moved.
const INSTALL = `(() => {
  const sc = [...document.querySelectorAll('div')].find((e) => /overflow-y-auto/.test(e.className) && /overscroll-contain/.test(e.className) && e.querySelector('[data-anchor]'));
  if (!sc) return false;
  window.__sc = sc; window.__log = []; window.__snap = null; window.__pending = false;
  const rows = () => [...sc.querySelectorAll('[data-anchor]')];
  const firstKey = () => { const e = sc.querySelector('[data-anchor]'); return e ? e.dataset.anchor : null; };
  const pick = () => { const sr = sc.getBoundingClientRect(); for (const e of rows()) { const r = e.getBoundingClientRect(); if (r.bottom > sr.top + 1) return { key: e.dataset.anchor, top: r.top - sr.top }; } return null; };
  const topOf = (k) => { const e = rows().find((x) => x.dataset.anchor === k); return e ? e.getBoundingClientRect().top - sc.getBoundingClientRect().top : null; };
  window.__lastFirst = firstKey();
  const frame = () => { if (!window.__pending) window.__snap = pick(); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  new MutationObserver(() => {
    const f = firstKey();
    if (f === window.__lastFirst) return;
    window.__lastFirst = f;
    const snap = window.__snap; if (!snap) return;
    const rec = { ref: snap.key, before: snap.top, after: topOf(snap.key), later: [] };
    window.__log.push(rec);
    window.__pending = true;
    for (const ms of [120, 450]) setTimeout(() => { rec.later.push(topOf(snap.key)); if (ms === 450) window.__pending = false; }, ms);
  }).observe(sc, { childList: true, subtree: true });
  return true;
})()`;
const STATE = `(() => { const sc = window.__sc; const k = [...sc.querySelectorAll('[data-anchor]')].map((e) => e.dataset.anchor); return { st: Math.round(sc.scrollTop), gap: sc.scrollHeight - sc.scrollTop - sc.clientHeight, rows: k.length, loading: /Loading earlier/.test(sc.innerText), start: /Start of the chat/.test(sc.innerText), dup: k.length - new Set(k).size }; })()`;
const wheel = (b, w, dy) => b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(w / 2), y: 400, deltaX: 0, deltaY: dy });

async function run(w, dark) {
  const cfg = `${w}px-${dark ? 'dark' : 'light'}`;
  const h = w < 600 ? 844 : 800;
  const b = await Browser.launch({ width: w, height: h, dark, mobile: w < 600 });
  const reads = [];
  b.ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.method === 'Network.requestWillBeSent' && m.params.request.method === 'GET' && m.params.request.url.includes(EVENTS_ROUTE)) reads.push(m.params.request.url.replace(/^.*\/api/, '/api'));
  });
  try {
    await b.signedIn();
    await b.setViewport(w, h, w < 600);
    await b.media({ dark });
    await b.goto('/', 800);
    await b.eval(`localStorage.removeItem('claudepilot.chat-details')`);
    reads.length = 0;
    await b.goto(`/admin/sessions/${SID}`, 4000);
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) { ok = await b.eval(INSTALL); if (!ok) await sleep(500); }
    if (!ok) { note(cfg, 'open', false, `no transcript scroller with rows; ${await b.shot(`fail-open-${cfg}`)}`); return; }
    await sleep(1000);
    const s0 = await b.eval(STATE);
    const f0 = await b.shot(`open-${cfg}`);
    note(cfg, 'open: one events read', reads.length === 1 && !/before=/.test(reads[0] ?? ''), `reads=${JSON.stringify(reads)}`);
    note(cfg, 'open: newest at the bottom', s0.gap === 0 && s0.rows > 0 && s0.rows < EVENTS / 2 && s0.dup === 0, `gap=${s0.gap} rows=${s0.rows} dup=${s0.dup} ${f0}`);

    // Scroll up until the first older page lands, then hold still.
    const base = reads.length;
    // One wheel step, then no input while the page may load and prepend: a later wheel would move the row and look like a jump.
    for (let i = 0; i < 100 && (await b.eval('window.__log.length')) < 1; i++) { await wheel(b, w, -700); await sleep(700); }
    await sleep(900);
    const older1 = reads.slice(base);
    const log = await b.eval('window.__log');
    let worst = 0;
    for (const l of log) for (const x of [l.after, ...l.later]) if (typeof x === 'number') worst = Math.max(worst, Math.abs(x - l.before));
    const f1 = await b.shot(`after-older-${cfg}`);
    note(cfg, 'scroll up: exactly one older read', older1.length === 1 && /before=/.test(older1[0] ?? '') && log.length === 1, `older reads=${JSON.stringify(older1)} prepends=${log.length}`);
    note(cfg, 'scroll up: anchor row moves <= 1px', log.length >= 1 && worst <= 1, `worstShift=${worst.toFixed(2)}px deltas=${JSON.stringify(log.map((l) => [l.after - l.before, ...l.later.map((x) => (typeof x === 'number' ? x - l.before : x))]))} ${f1}`);

    // To the oldest page, then more scrolling must read nothing.
    let top = null;
    for (let i = 0; i < 600; i++) {
      await wheel(b, w, -6000);
      await sleep(150);
      top = await b.eval(STATE);
      if (top.start && !top.loading && top.st === 0) { await sleep(500); top = await b.eval(STATE); if (top.start && top.st === 0) break; }
    }
    const f2 = await b.shot(`oldest-${cfg}`);
    const settled = reads.length;
    for (let i = 0; i < 5; i++) { await wheel(b, w, -3000); await sleep(200); }
    await sleep(800);
    note(cfg, 'oldest: start shown, no further reads', top.start && top.dup === 0 && reads.length === settled, `start=${top.start} rows=${top.rows} dup=${top.dup} totalReads=${settled} afterExtraScroll=${reads.length} ${f2}`);
  } catch (e) {
    note(cfg, 'script error', false, String(e.stack || e).slice(0, 600));
  } finally {
    await b.close();
  }
}

for (const [w, d] of [[390, false], [390, true], [1280, false], [1280, true]]) await run(w, d);
writeFileSync(`${OUT}/summary.json`, JSON.stringify({ session: SID, events: EVENTS, results }, null, 1));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} checks passed; summary: ${OUT}/summary.json`);
process.exit(failed ? 1 : 0);
