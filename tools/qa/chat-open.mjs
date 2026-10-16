// Opening a chat with a long transcript (T-376): the owner's phone lagged when he opened a long session. Against a scratch portal, this seeds ONE
// ended session with a long, heavy transcript (10,000 events by default; every 15th tool result 120 KB, every 150th 600 KB, and one 400 KB result
// among the newest three that ends in a marker), then in a fresh Chromium per config (390x844 touch and 1280x800, light and dark) it measures:
//   1. open time: ms from the navigate to the first "Turn n:" row (firstRow) and until the transcript sits still at the bottom (settled);
//   2. the bytes of the open from CDP Network events: the events reads (status, content-encoding, encoded and decoded KB, latency), the total
//      encoded KB of the open, and whether compression is on;
//   3. sideways scroll and 44 px targets at the open (390 px: small targets are listed, as a note, not a failure);
//   5. a cut tool result opens whole: the "Show all (" button, its height, the marker absent before and present after a real tap, time to whole,
//      events reads it caused;
//   6. scrolling up: older pages are prepended and the row you read does not move (worst shift <= 1 px), one older read ("before=") per page;
//   7. the oldest: "Start of the chat" shows, the lowest Turn number is 1, no more reads after it, no duplicate Turn numbers, no sideways scroll.
// Rows are found by their TEXT ("Turn n:"), never by a data attribute. Every wait is a poll with a ceiling. One line per check; exit 1 on any FAIL;
// the last line names every failure. Screenshots (open, whole, older, oldest per config) and summary.json go to --out.
// Seeds at runtime in the scratch portal's database (rows `qaopen-*`); no real transcript, no token-shaped literal.
//   --out <dir> (default qa-shots/t376-chat-open)   --events <n> (10000)   --open-only (stop after step 3: an old build has no pages)
//   --cfg 390px-light (one config: 390px|1280px - light|dark)   --keep (leave the seed)
//   --budget-first-ms 2000  --budget-settled-ms 4000  --budget-kb 1024   (the open's pass/fail budget; every request over 500 KB is printed)
//   T-376 S4 (done-when 4), on the same built app:
//   8. a fresh open under a CPU throttle (CDP Emulation.setCPUThrottlingRate, --throttle 4) with a PerformanceObserver 'longtask' from the first
//      script on: the longest task must stay within --budget-longtask-ms 200 (every task over 50 ms is listed);
//   6b. DOM node count and JS heap (CDP Performance.getMetrics after a garbage collection) before and after the older pages load, recorded;
//   6c. one older page, from the scroll that triggers its read (the page's fetch of "before=") to its rows painted (two animation frames after
//      they land), must stay within --budget-page-ms 300 (the render alone, landing to painted, is printed too).
// The whole log is also written to <out>/run.log (kept with the screenshots, so a lost Job output cannot hide the evidence).
// Run it against the BUILT app (SCRATCH_PRODUCTION=1): a dev-mode scratch portal serves ~600 Vite modules (14 MB) per open, which is not what a user gets.
// usage: scripts/job-run.sh --ref <branch> --out job-out/ -- 'SCRATCH_PRODUCTION=1 tools/qa/with-portal.sh 3476 node tools/qa/chat-open.mjs --out job-out/chat-open; exit $?'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Browser } from './browser.mjs';
import { login, PORT, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const OUT = opt('--out', 'qa-shots/t376-chat-open');
const EVENTS = Number(opt('--events', 10_000));
const OPEN_ONLY = args.includes('--open-only');
const ONLY_CFG = opt('--cfg', null);
// The open budget (pass/fail): ms to the first row, ms to settled, KB encoded for the whole open.
const BUDGET_FIRST_MS = Number(opt('--budget-first-ms', 2000));
const BUDGET_SETTLED_MS = Number(opt('--budget-settled-ms', 4000));
const BUDGET_KB = Number(opt('--budget-kb', 1024));
const THROTTLE = Number(opt('--throttle', 4));
const BUDGET_LONGTASK_MS = Number(opt('--budget-longtask-ms', 200));
const BUDGET_PAGE_MS = Number(opt('--budget-page-ms', 300));
mkdirSync(OUT, { recursive: true });
// Keep the log next to the screenshots: every console.log line is also appended to <out>/run.log.
const LOG = join(OUT, 'run.log');
writeFileSync(LOG, '');
const stdoutLog = console.log.bind(console);
console.log = (...a) => {
  stdoutLog(...a);
  appendFileSync(LOG, `${a.join(' ')}\n`);
};
const dbPath = process.env.SCALE_DB ?? `/tmp/scratch-portal-${PORT}/data/portal.db`;
const SID = 'qaopen-long-1';
const MARKER = 'END-OF-NEWEST-BIG-RESULT';
const KB = (n) => Math.round((n / 1024) * 10) / 10;

const failures = [];
const summary = { events: EVENTS, seed: null, configs: {} };
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failures.push(name);
};

// ---------- seed ----------
function bigText(bytes, tag) {
  const lines = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const l = `src/some/file${i}.ts:${i} match line ${tag}`;
    lines.push(l);
    size += l.length + 1;
  }
  return lines.join('\n');
}

function seed(db) {
  db.exec(`DELETE FROM chat_events WHERE session_id = '${SID}'; DELETE FROM chat_sessions WHERE id = '${SID}'`);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const rows = []; // [seq, kind, uuid, payload JSON]
  const results = []; // indexes of tool_result rows
  const B120 = bigText(120 * 1024, 'A');
  const B600 = bigText(600 * 1024, 'B');
  let turn = 0;
  let nres = 0;
  const put = (kind, payload, uuid = null) => {
    if (rows.length < EVENTS) rows.push([rows.length + 1, kind, uuid, JSON.stringify(payload)]);
  };
  while (rows.length < EVENTS) {
    turn++;
    put('user', { text: `Turn ${turn}: please look at module ${turn % 37} and fix what is wrong.` }, `${SID}-u${turn}`);
    put('assistant', { text: `Looking at module ${turn % 37}. Running the checks first.` }, `${SID}-a${turn}`);
    if (turn % 5 === 0) put('thinking', { text: `Thinking about module ${turn % 37} and what the tests say.` });
    const pairs = 1 + (turn % 4);
    for (let k = 0; k < pairs; k++) {
      nres++;
      const tu = `tu-${turn}-${k}`;
      put('tool_use', { text: `grep -rn "f${turn}" src/`, toolName: 'Bash', toolUseId: tu }, `${SID}-t${turn}-${k}`);
      const text = nres % 150 === 0 ? B600 : nres % 15 === 0 ? B120 : `src/features/chat/File${turn}.tsx:${k + 1}: match line for f${turn}\n`.repeat(6);
      results.push(rows.length);
      put('tool_result', { text, toolName: 'Bash', toolUseId: tu });
    }
    put('result', { text: 'done', costUsd: turn * 0.004, turnCostUsd: 0.004, durationMs: 4000, tokens: { input: 1200, output: 300, cacheRead: 5000, cacheWrite: 100 } });
  }
  // The newest big result: the last tool_result, 400 KB, ending in the marker.
  // (the cut-off at EVENTS can drop the last put, so keep only indexes that exist)
  const last = rows[results.filter((i) => i < rows.length).pop()];
  const lastPayload = JSON.parse(last[3]);
  lastPayload.text = `${bigText(400 * 1024, 'N')}\n${MARKER}`;
  last[3] = JSON.stringify(lastPayload);
  const start = now - 3 * 86_400_000;
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO chat_sessions (id, workspace_id, cwd, title, origin, state, state_since, process, segment, last_seq, model, mode, cost_est_usd, turns, launch, created_at, last_activity_at, ended_reason, archived_at, effort, claude_id, context_used, context_window)
      VALUES (?, 'docker/qa-ws1', '/home/node', 'QA open long chat', 'ui', 'ended', ?, 'gone', 1, ?, 'claude-opus-5-5', 'default', 0, ?, '{}', ?, ?, 'QA seed', NULL, 'medium', '', 1000, 1000000)`)
      .run(SID, iso(now), rows.length, turn, iso(start), iso(now));
    const ev = db.prepare('INSERT INTO chat_events (session_id, seq, at, kind, uuid, payload) VALUES (?, ?, ?, ?, ?, ?)');
    let t = start;
    for (const [seq, kind, uuid, payload] of rows) ev.run(SID, seq, iso((t += 1500)), kind, uuid, payload);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const sql = db.prepare(`SELECT COUNT(*) AS n, SUM(LENGTH(payload)) AS bytes, SUM(CASE WHEN LENGTH(payload) > 100000 THEN LENGTH(payload) ELSE 0 END) AS big FROM chat_events WHERE session_id = ?`).get(SID);
  const newest = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT payload FROM chat_events WHERE session_id = ? AND kind = 'tool_result' ORDER BY seq DESC LIMIT 3) WHERE payload LIKE ?`).get(SID, `%${MARKER}%`);
  const first = db.prepare(`SELECT payload FROM chat_events WHERE session_id = ? AND kind = 'user' ORDER BY seq LIMIT 1`).get(SID);
  const info = { events: Number(sql.n), turns: turn, payloadMB: Math.round(Number(sql.bytes) / 1048576 * 10) / 10, bigMB: Math.round(Number(sql.big) / 1048576 * 10) / 10 };
  console.log(`seeded ${info.events} events, ${info.turns} turns, ${info.payloadMB} MB of payload, ${info.bigMB} MB in big results`);
  check('seed: the event count matches', info.events === EVENTS, `${info.events}/${EVENTS}`);
  check('seed: the marker result is among the newest 3 results', Number(newest.n) === 1);
  check('seed: the first Turn number is 1', /^\{"text":"Turn 1:/.test(first.payload));
  return info;
}

// ---------- in-page helpers ----------
const SCROLLER = `(() => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n; while ((n = w.nextNode())) {
    if (!/Turn \\d+:/.test(n.nodeValue)) continue;
    for (let e = n.parentElement; e; e = e.parentElement) {
      const o = getComputedStyle(e).overflowY;
      if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight) return e;
    }
  }
  return null;
})()`;
const TURNS = `(() => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const out = []; let n;
  while ((n = w.nextNode())) { const m = /^\\s*Turn (\\d+):/.exec(n.nodeValue); if (m) out.push(Number(m[1])); }
  return out;
})()`;
const STATE = `(() => { const s = ${SCROLLER}; return s ? { sh: s.scrollHeight, ch: s.clientHeight, st: s.scrollTop, sw: s.scrollWidth, cw: s.clientWidth } : null; })()`;
const OVERFLOW = `(() => {
  const s = ${SCROLLER};
  const d = document.documentElement;
  const wide = [...document.querySelectorAll('body *')].filter((e) => {
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.right > innerWidth + 1 && !e.closest('pre, code, table, [data-allow-overflow], .overflow-x-auto');
  }).slice(0, 5).map((e) => e.tagName.toLowerCase() + ' ' + Math.round(e.getBoundingClientRect().right));
  return { doc: d.scrollWidth <= d.clientWidth + 1, scroller: !s || s.scrollWidth <= s.clientWidth + 1, wide };
})()`;
const SMALL = `(() => [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea')].filter((e) => {
  const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
  return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && (r.width < 43.5 || r.height < 43.5);
}).slice(0, 12).map((e) => { const r = e.getBoundingClientRect(); return (e.getAttribute('aria-label') || e.innerText || e.tagName).trim().slice(0, 24) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }))()`;
// The anchor probe: finds rows by their Turn text, remembers the first visible one and its top inside the scroller; when an older page lands
// (the lowest loaded Turn number gets smaller) it logs where that row went at once, after 120 ms and after 450 ms.
const PROBE = `(() => {
  const scroller = ${SCROLLER};
  const rowOf = () => {
    const out = []; const w = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { const m = /^\\s*Turn (\\d+):/.exec(n.nodeValue); if (m && n.parentElement) out.push({ n: Number(m[1]), el: n.parentElement }); }
    return out;
  };
  const top = (el) => el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  window.__prepends = [];
  window.__fetchAt = [];
  const f0 = window.fetch.bind(window);
  window.fetch = (...a) => { const u = String(a[0] && a[0].url ? a[0].url : a[0]); if (/before=/.test(u)) window.__fetchAt.push(performance.now()); return f0(...a); };
  let ref = null; let pending = false; let lowest = Math.min(...rowOf().map((r) => r.n));
  const tick = () => {
    if (!pending) {
      const sr = scroller.getBoundingClientRect();
      const vis = rowOf().filter((r) => r.el.getBoundingClientRect().bottom > sr.top + 1).sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top)[0];
      if (vis) ref = { n: vis.n, top: top(vis.el) };
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const at = (n) => { const r = rowOf().find((x) => x.n === n); return r ? top(r.el) : null; };
  new MutationObserver(() => {
    const now = Math.min(...rowOf().map((r) => r.n));
    if (now >= lowest || !ref) return;
    lowest = now; pending = true; window.__pending = true;
    const rec = { ref: ref.n, before: ref.top, after: at(ref.n), later: [], lowest: now, landed: performance.now(), trigger: window.__fetchAt.length ? window.__fetchAt[window.__fetchAt.length - 1] : null, painted: null };
    window.__prepends.push(rec);
    requestAnimationFrame(() => requestAnimationFrame(() => { rec.painted = performance.now(); }));
    setTimeout(() => rec.later.push(at(ref.n)), 120);
    setTimeout(() => { rec.later.push(at(ref.n)); pending = false; window.__pending = false; }, 450);
  }).observe(scroller, { childList: true, subtree: true });
  return true;
})()`;

// ---------- one config ----------
async function runConfig(cookie, cfg) {
  const { width, height, dark, name } = cfg;
  const mobile = width < 600;
  const res = { cfg: name };
  summary.configs[name] = res;
  const tag = `${name}:`;
  const b = await Browser.launch({ width, height, mobile, cookie });
  try {
    await b.cookie(cookie);
    await b.setViewport(width, height, mobile);
    await b.media({ dark });
    if (mobile) await b.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 59, bottom: 34, left: 0, right: 0 } }).catch(() => {});
    await b.send('Network.setCacheDisabled', { cacheDisabled: true });
    // The network log, from CDP events.
    const net = new Map();
    b.ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      const p = m.params;
      if (m.method === 'Network.requestWillBeSent') net.set(p.requestId, { url: p.request.url, method: p.request.method, t0: p.timestamp, decoded: 0, encoded: 0, status: null, enc: 'none' });
      else if (m.method === 'Network.responseReceived' && net.has(p.requestId)) {
        const r = net.get(p.requestId);
        r.status = p.response.status;
        const h = Object.fromEntries(Object.entries(p.response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
        r.enc = h['content-encoding'] ?? 'none';
        r.type = h['content-type'] ?? '';
      } else if (m.method === 'Network.dataReceived' && net.has(p.requestId)) net.get(p.requestId).decoded += p.dataLength;
      else if (m.method === 'Network.loadingFinished' && net.has(p.requestId)) {
        const r = net.get(p.requestId);
        r.encoded = p.encodedDataLength;
        r.ms = Math.round((p.timestamp - r.t0) * 1000);
      }
    });
    const reads = () => [...net.values()].filter((r) => r.url.includes(`/${SID}/`) && /\/events(\/|\?|$)/.test(new URL(r.url).pathname + new URL(r.url).search) && r.method === 'GET');
    const shot = async (what) => {
      const r = await b.send('Page.captureScreenshot', { format: 'png' });
      const file = join(OUT, `${name}-${what}.png`);
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      console.log(`     shot ${file}`);
    };
    await b.send('Performance.enable').catch(() => {});
    const metrics = async () => {
      await b.send('HeapProfiler.collectGarbage').catch(() => {});
      const r = await b.send('Performance.getMetrics');
      const m = Object.fromEntries(r.metrics.map((x) => [x.name, x.value]));
      return { nodes: m.Nodes, heapMB: Math.round((m.JSHeapUsedSize / 1048576) * 10) / 10 };
    };
    const wheel = (dy) => b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: width / 2, y: height / 2, deltaX: 0, deltaY: dy });

    // Sign in, open /, clear the stored detail choice and the network log, then navigate to the chat.
    await b.goto('/', 800);
    // Warm the portal's database cache first (the first read of a 36 MB transcript is cold; a person opens a chat that was open before).
    await b.eval(`fetch('/api/chat/sessions/${SID}/events?limit=200', { credentials: 'same-origin' }).then((r) => r.status)`).catch(() => {});
    await b.eval(`localStorage.removeItem('claudepilot.chat-details')`);
    net.clear();
    const t0 = Date.now();
    await b.send('Page.navigate', { url: `http://localhost:${PORT}/admin/sessions/${SID}` });

    // 1. Open time, by polling.
    let firstRow = null;
    while (Date.now() - t0 < 30_000) {
      if (await b.eval(`/Turn \\d+:/.test(document.body.innerText)`).catch(() => false)) { firstRow = Date.now() - t0; break; }
      await sleep(25);
    }
    check(`${tag} a first Turn row shows within 30 s`, firstRow !== null, firstRow !== null ? `firstRow ${firstRow} ms` : '');
    res.firstRow = firstRow;
    if (firstRow === null) {
      await shot('open-failed');
      return;
    }
    let settled = null;
    let prev = null;
    while (Date.now() - t0 < 60_000) {
      const s = await b.eval(STATE).catch(() => null);
      if (s && prev && s.sh === prev.sh && s.sh - s.st - s.ch <= 1 && prev.sh - prev.st - prev.ch <= 1) { settled = Date.now() - t0; break; }
      prev = s;
      await sleep(100);
    }
    check(`${tag} the transcript settles at the bottom`, settled !== null, settled !== null ? `settled ${settled} ms` : 'never sat still at the bottom within 60 s');
    res.settled = settled;

    // 2. Bytes and encoding of the open.
    await sleep(1500);
    const ev = reads();
    const all = [...net.values()];
    res.eventsReads = ev.map((r) => ({ url: new URL(r.url).pathname + new URL(r.url).search, status: r.status, encoding: r.enc, encodedKB: KB(r.encoded), decodedKB: KB(r.decoded), ms: r.ms }));
    res.openEncodedKB = KB(all.reduce((s, r) => s + r.encoded, 0));
    res.openDecodedKB = KB(all.reduce((s, r) => s + r.decoded, 0));
    const evEnc = ev.reduce((s, r) => s + r.encoded, 0);
    const evDec = ev.reduce((s, r) => s + r.decoded, 0);
    const compressed = ev.length > 0 && ev.every((r) => /gzip|br|deflate|zstd/.test(r.enc));
    console.log(`     open: ${ev.length} events reads, ${KB(evEnc)} KB encoded, ${KB(evDec)} KB decoded, content-encoding ${[...new Set(ev.map((r) => r.enc))].join(',') || '-'}; compression ${compressed ? 'ON' : 'OFF'}; whole open ${res.openEncodedKB} KB encoded over ${all.length} requests`);
    for (const r of res.eventsReads) console.log(`     read ${r.url} -> ${r.status} ${r.encoding} ${r.encodedKB} KB on the wire, ${r.decodedKB} KB decoded, ${r.ms} ms`);
    // Every request over 500 KB, biggest first (T-376 S3: the 14 MB of an open must be named, not guessed).
    const heavy = all.filter((r) => Math.max(r.encoded, r.decoded) > 500 * 1024).sort((a, b) => b.encoded - a.encoded);
    res.heavyRequests = heavy.map((r) => ({ url: r.url.replace(/^https?:\/\/[^/]+/, ''), status: r.status, encoding: r.enc, type: r.type, encodedKB: KB(r.encoded), decodedKB: KB(r.decoded), ms: r.ms }));
    for (const r of res.heavyRequests) console.log(`     heavy ${r.url.slice(0, 160)} -> ${r.status} ${r.encoding} ${r.type} ${r.encodedKB} KB on the wire, ${r.decodedKB} KB decoded, ${r.ms} ms`);
    if (!heavy.length) console.log('     heavy: no request over 500 KB');
    const devModules = all.filter((r) => /\/@vite\/|\/node_modules\/\.vite\/|\/src\/.*\.tsx?(\?|$)/.test(r.url)).length;
    check(`${tag} the portal serves the built app (not Vite dev modules)`, devModules === 0, devModules ? `${devModules} dev-server modules: start the portal with SCRATCH_PRODUCTION=1` : '');
    // The open budget (pass/fail): first row, settled, and what the open moves.
    check(`${tag} open budget: first row within ${BUDGET_FIRST_MS} ms`, firstRow <= BUDGET_FIRST_MS, `${firstRow} ms`);
    check(`${tag} open budget: settled within ${BUDGET_SETTLED_MS} ms`, settled !== null && settled <= BUDGET_SETTLED_MS, `${settled} ms`);
    check(`${tag} open budget: the open moves at most ${BUDGET_KB} KB encoded`, res.openEncodedKB <= BUDGET_KB, `${res.openEncodedKB} KB`);
    check(`${tag} the open made an events read that succeeded`, ev.length > 0 && ev.every((r) => r.status === 200), `${ev.length} reads`);
    res.compression = compressed;
    await shot('open');

    // 3. Sideways scroll and 44 px.
    const of = await b.eval(OVERFLOW);
    check(`${tag} no sideways scroll at the open`, of.doc && of.scroller && of.wide.length === 0, of.wide.length ? `wide: ${of.wide.join('; ')}` : '');
    if (mobile) {
      const small = await b.eval(SMALL);
      res.small = small;
      console.log(`     note: ${small.length} visible targets under 43.5 px (known kit gaps T-639, T-681)${small.length ? `: ${small.join('; ')}` : ''}`);
    }
    if (OPEN_ONLY) return;

    // 5. A cut tool result opens whole.
    const findShowAll = `(() => { const e = [...document.querySelectorAll('button')].filter((x) => /Show all \\(/.test(x.innerText || x.textContent) && x.getBoundingClientRect().height > 0).pop(); if (!e) return null; e.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height, label: (e.innerText || e.textContent).trim() }; })()`;
    let sa = await b.eval(findShowAll);
    // The newest result is the LAST "Show all (" in the page (the first belongs to an older 600 KB result, not the marker's). Its row sits in a
    // folded run ("n steps. Latest: ...") and a closed Bash row, so the way to it is the menu's own Show all details switch.
    if (!sa) {
      // Show all details (the menu's own switch, remembered in localStorage): every row open, so the cut result's Output is in the page.
      await b.eval(`localStorage.setItem('claudepilot.chat-details', '1')`);
      await b.send('Page.reload', {});
      for (let i = 0; i < 100 && !(await b.eval(`/Turn \\d+:/.test(document.body.innerText)`).catch(() => false)); i++) await sleep(100);
      await sleep(800);
      await b.eval(`(() => { const s = ${SCROLLER}; if (s) s.scrollTop = s.scrollHeight; })()`);
      await sleep(800);
      sa = await b.eval(findShowAll);
      console.log(`     with Show all details on: Show all ${sa ? 'found' : 'not found'}`);
      res.showAllVia = sa ? 'details' : null;
      if (sa) console.log(`     the newest Show all reads "${sa.label}" (the marker result is 409,657 chars whole)`);
    }
    if (!sa) {
      // Diagnostics for a miss: what the newest page holds as its last tool results, and which Output blocks the page shows.
      const diag = await b.eval(`(async () => {
        const r = await fetch('/api/chat/sessions/${SID}/events?limit=200', { credentials: 'same-origin' }).then((x) => x.json());
        const page = r.data ?? r;
        const evs = page.events ?? page;
        const results = evs.filter((e) => e.kind === 'tool_result').slice(-3).map((e) => ({ seq: e.seq, id: e.toolUseId, len: (e.text || '').length, whole: e.textLength ?? null }));
        const outs = [...document.querySelectorAll('section[aria-label=Output]')].map((s) => ({ chars: s.innerText.length, preview: /preview/.test(s.innerText.slice(0, 60)) }));
        const last = evs.slice(-6).map((e) => e.kind + ':' + (e.toolUseId || ''));
        return { more: page.more, lastKinds: last, results, outs };
      })()`).catch((e) => String(e));
      console.log(`     diag: ${JSON.stringify(diag)}`);
      res.diag = diag;
    }
    check(`${tag} a "Show all (" button is in the DOM`, !!sa, sa ? `"${sa.label}"` : 'no Show all in the DOM');
    if (sa) {
      res.showAll = { label: sa.label, height: Math.round(sa.h) };
      if (mobile) check(`${tag} Show all is at least 44 px tall`, sa.h >= 43.5, `${Math.round(sa.h)} px`);
      const markerBefore = await b.eval(`document.body.innerText.includes(${JSON.stringify(MARKER)})`);
      check(`${tag} the marker is not in the page before the tap`, !markerBefore);
      await shot('cut');
      const readsBefore = reads().length;
      const tTap = Date.now();
      await b.clickAt(sa.x, sa.y);
      let whole = null;
      while (Date.now() - tTap < 30_000) {
        if (await b.eval(`document.body.innerText.includes(${JSON.stringify(MARKER)})`).catch(() => false)) { whole = Date.now() - tTap; break; }
        await sleep(50);
      }
      check(`${tag} the tap opens the whole result (marker appears)`, whole !== null, whole !== null ? `${whole} ms, ${reads().length - readsBefore} events reads` : 'marker never appeared in 30 s');
      res.wholeMs = whole;
      res.wholeReads = reads().length - readsBefore;
      await shot('whole');
      await b.eval(`(() => { const s = ${SCROLLER}; if (s) s.scrollTop = s.scrollHeight; })()`);
      await sleep(400);
    }

    // Back to the default view (rows folded) for the paging steps.
    if (await b.eval(`localStorage.getItem('claudepilot.chat-details') === '1'`)) {
      await b.eval(`localStorage.removeItem('claudepilot.chat-details')`);
      await b.send('Page.reload', {});
      for (let i = 0; i < 100 && !(await b.eval(`/Turn \\d+:/.test(document.body.innerText)`).catch(() => false)); i++) await sleep(100);
      await sleep(1000);
      await b.eval(`(() => { const s = ${SCROLLER}; if (s) s.scrollTop = s.scrollHeight; })()`);
      await sleep(500);
    }
    // 6. Scroll up: the anchor holds still.
    await b.eval(PROBE);
    const memBefore = await metrics();
    const readsBeforeUp = reads().length;
    let tries = 0;
    while (tries++ < 40 && (await b.eval('window.__prepends.length')) < 3) {
      await wheel(-900);
      await sleep(800);
      // A page can land late on a heavy render: no input until its 450 ms window has closed (else the next wheel is read as a shift).
      for (let i = 0; i < 100 && (await b.eval('window.__pending === true')); i++) await sleep(50);
    }
    await sleep(900);
    const pre = await b.eval('window.__prepends');
    const olderReads = reads().filter((r) => /before=/.test(r.url));
    res.prepends = pre.length;
    res.olderReads = olderReads.map((r) => ({ encodedKB: KB(r.encoded), ms: r.ms, status: r.status }));
    const shifts = pre.flatMap((p) => [p.after, ...p.later].filter((v) => v !== null).map((v) => Math.abs(v - p.before)));
    const worst = shifts.length ? Math.max(...shifts) : null;
    res.worstShiftPx = worst;
    for (const r of olderReads) console.log(`     older read ${new URL(r.url).search} -> ${r.status} ${r.enc} ${KB(r.encoded)} KB on the wire, ${r.ms} ms`);
    check(`${tag} scrolling up prepends older pages`, pre.length >= 1, `${pre.length} prepends in ${tries - 1} wheel steps`);
    check(`${tag} one older read ("before=") per prepend`, olderReads.length === pre.length, `${olderReads.length} reads, ${pre.length} prepends (${reads().length - readsBeforeUp} events reads in all)`);
    check(`${tag} the row you read holds still when a page lands (<= 1 px)`, pre.length > 0 && worst !== null && worst <= 1, `worst ${worst === null ? 'n/a' : Math.round(worst * 10) / 10} px over ${pre.length} prepends ${JSON.stringify(pre.map((p) => ({ ref: p.ref, before: Math.round(p.before), after: p.after === null ? null : Math.round(p.after), later: p.later.map((v) => (v === null ? null : Math.round(v))) })))}`);
    await shot('older');
    // 6b. DOM and heap, before and after the older pages; 6c. one older page, trigger to painted.
    const memAfter = await metrics();
    res.memory = { before: memBefore, after: memAfter, prepends: pre.length };
    console.log(`     memory: DOM nodes ${memBefore.nodes} -> ${memAfter.nodes}, JS heap ${memBefore.heapMB} -> ${memAfter.heapMB} MB over ${pre.length} older pages`);
    const pageMs = pre.filter((p) => p.trigger !== null && p.painted !== null).map((p) => Math.round(p.painted - p.trigger));
    const renderMs = pre.filter((p) => p.painted !== null).map((p) => Math.round(p.painted - p.landed));
    res.olderPageMs = pageMs;
    res.olderRenderMs = renderMs;
    console.log(`     older pages: trigger to painted ${JSON.stringify(pageMs)} ms, landed to painted ${JSON.stringify(renderMs)} ms`);
    check(`${tag} an older page renders within ${BUDGET_PAGE_MS} ms (scroll trigger to painted)`, pageMs.length > 0 && Math.max(...pageMs) <= BUDGET_PAGE_MS, `worst ${pageMs.length ? Math.max(...pageMs) : 'n/a'} ms of ${JSON.stringify(pageMs)}`);

    // 7. The oldest.
    const tTop = Date.now();
    let oldest = null;
    let stableSince = null;
    while (Date.now() - tTop < 120_000) {
      await wheel(-9000);
      await sleep(120);
      const s = await b.eval(`(() => { const sc = ${SCROLLER}; const t = document.body.innerText; return { shown: t.includes('Start of the chat'), loading: /Loading/i.test(t), top: sc ? sc.scrollTop : -1 }; })()`);
      if (s.shown && !s.loading && s.top === 0) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= 500) { oldest = Date.now() - tTop; break; }
      } else stableSince = null;
    }
    check(`${tag} "Start of the chat" shows at the oldest`, oldest !== null, oldest !== null ? `${oldest} ms, ${reads().length - readsBeforeUp} events reads since the first scroll` : 'not reached in 120 s');
    res.oldestMs = oldest;
    res.totalReads = reads().length;
    const turns = await b.eval(TURNS);
    check(`${tag} the lowest loaded Turn number is 1`, turns.length > 0 && Math.min(...turns) === 1, `lowest ${turns.length ? Math.min(...turns) : 'none'}, ${turns.length} turn rows`);
    const dups = turns.filter((n, i) => turns.indexOf(n) !== i);
    check(`${tag} no duplicate Turn numbers`, dups.length === 0, dups.length ? `e.g. ${dups.slice(0, 5).join(', ')}` : '');
    const readsAtOldest = reads().length;
    for (let i = 0; i < 5; i++) { await wheel(-3000); await sleep(150); }
    await sleep(600);
    check(`${tag} five more wheel-ups cause no new events reads`, reads().length === readsAtOldest, `${reads().length - readsAtOldest} new`);
    const of2 = await b.eval(OVERFLOW);
    check(`${tag} no sideways scroll at the oldest`, of2.doc && of2.scroller && of2.wide.length === 0, of2.wide.length ? `wide: ${of2.wide.join('; ')}` : '');
    await shot('oldest');
    // 8. A fresh open under a CPU throttle: no long task over the budget.
    await b.eval(`localStorage.removeItem('claudepilot.chat-details')`);
    const lt = await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ s: Math.round(e.startTime), d: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true }); } catch (e) { window.__ltErr = String(e); }` });
    await b.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    try {
      const tT = Date.now();
      await b.send('Page.navigate', { url: `http://localhost:${PORT}/admin/sessions/${SID}` });
      let throttledFirst = null;
      while (Date.now() - tT < 90_000) {
        if (await b.eval(`/Turn \\d+:/.test(document.body.innerText)`).catch(() => false)) { throttledFirst = Date.now() - tT; break; }
        await sleep(100);
      }
      await sleep(3000);
      const tasks = await b.eval('window.__lt').catch(() => null);
      const supported = Array.isArray(tasks);
      const longest = supported && tasks.length ? Math.max(...tasks.map((t) => t.d)) : 0;
      res.throttled = { rate: THROTTLE, firstRow: throttledFirst, longtasks: supported ? tasks.length : null, longestMs: supported ? longest : null };
      console.log(`     throttled ${THROTTLE}x open: first row ${throttledFirst} ms; ${supported ? tasks.length : '?'} long tasks (>50 ms), longest ${longest} ms: ${supported ? JSON.stringify(tasks.filter((t) => t.d > 50)) : 'observer unavailable'}`);
      check(`${tag} ${THROTTLE}x CPU throttle: a first Turn row shows`, throttledFirst !== null, `${throttledFirst} ms`);
      check(`${tag} ${THROTTLE}x CPU throttle: the observer ran`, supported);
      check(`${tag} ${THROTTLE}x CPU throttle: no long task over ${BUDGET_LONGTASK_MS} ms at the open`, supported && longest <= BUDGET_LONGTASK_MS, `longest ${longest} ms of ${supported ? tasks.length : '?'} long tasks`);
    } finally {
      await b.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
      await b.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: lt.identifier }).catch(() => {});
    }
    if (b.errors.length) console.log(`     page errors: ${b.errors.slice(0, 3).join(' | ').slice(0, 300)}`);
  } catch (e) {
    check(`${tag} ran without an error`, false, String(e.message ?? e).slice(0, 300));
  } finally {
    await b.close();
  }
}

// ---------- main ----------
const db = new DatabaseSync(dbPath, { timeout: 30_000 });
summary.seed = seed(db);
const cookie = await login();
const cfgs = [];
for (const [w, h] of [[390, 844], [1280, 800]]) for (const dark of [false, true]) cfgs.push({ width: w, height: h, dark, name: `${w}px-${dark ? 'dark' : 'light'}` });
for (const c of cfgs) if (!ONLY_CFG || ONLY_CFG === c.name) await runConfig(cookie, c);
if (!args.includes('--keep')) db.exec(`DELETE FROM chat_events WHERE session_id = '${SID}'; DELETE FROM chat_sessions WHERE id = '${SID}'`);
db.close();
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ ...summary, failures }, null, 2));
console.log(`summary ${join(OUT, 'summary.json')}`);
console.log(failures.length ? `FAILED: ${failures.length} failing: ${failures.join('; ')}` : 'passed: 0 failing');
process.exit(failures.length ? 1 : 0);
