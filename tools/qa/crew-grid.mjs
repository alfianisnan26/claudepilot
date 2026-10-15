// T-600 QA: how many columns the summary tiles take, and how wide the Crew card is, on Home (/) and Usage > Crew, at 390 and 1280 px, light and dark.
// Expected: Home Pace card 2 columns at 390 and 3 at 1280; Crew block 5 columns at 1280 (the author assumed the card is 576 px or wider).
// usage: tools/qa/with-portal.sh 3472 env QA_SHOTS=job-out/qa-ui-r3 node tools/qa/crew-grid.mjs
import { Browser } from './browser.mjs';
import { login, sleep } from './lib.mjs';

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra.slice(0, 300)}` : ''}`);
  if (!ok) failed++;
};

const SCRIPT = `(() => {
  const fig = (value, basis = 'measured') => ({ value, basis, source: 'fixture' });
  const win = (k) => ({
    fromMs: 0, toMs: 1, requestsPerHour: fig(120 * k), usdPerHour: fig(2.5 * k, 'estimate'), resolved: fig(45 * k), wontDo: fig(3),
    resolvedByProgram: [{ program: 'p', title: 'ClaudePilot', count: 45 }], perResolvedUsd: fig(0.42 * k, 'estimate'), createdPerClosed: fig(2.87 * k),
    createdPerClosedByProgram: [{ program: 'p', title: 'ClaudePilot', created: 158, closed: 55, ratio: fig(2.87) }],
  });
  const headline = { pace: { ratio: fig(0.75), unusedAtResetPct: 25, weekly: { value: null, basis: 'unavailable', source: 'x', reason: 'no_source' }, claudes: [] }, current: win(1), previous: null };
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await orig(input, init);
    const url = typeof input === 'string' ? input : input.url;
    if (!/scorecard/.test(url) || !res.ok) return res;
    const j = await res.clone().json().catch(() => null);
    if (!j) return res;
    (j.data ?? j).headline = headline;
    return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
  };
})()`;

const MEASURE = `(() => {
  const root = document.querySelector('[data-crew-summary]');
  if (!root) return null;
  const tiles = [...root.querySelectorAll('[data-summary-tile]')].map((t) => t.getBoundingClientRect());
  const cols = new Set(tiles.map((r) => Math.round(r.left))).size;
  const rows = new Set(tiles.map((r) => Math.round(r.top))).size;
  const card = root.closest('section, article, [class*="rounded"]') ?? root.parentElement;
  const doc = document.scrollingElement;
  return { cols, rows, rootW: Math.round(root.getBoundingClientRect().width), cardW: Math.round(card.getBoundingClientRect().width), tileW: tiles.map((r) => Math.round(r.width)), scroll: [doc.scrollWidth, doc.clientWidth] };
})()`;

const cookie = await login();
const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);
await b.send('Page.addScriptToEvaluateOnNewDocument', { source: SCRIPT });
const EXPECT = { '/': { 390: 2, 1280: 3 }, '/admin/usage?tab=crew': { 390: null, 1280: 5 } };
try {
  for (const [path, want] of Object.entries(EXPECT)) {
    for (const [w, h, mobile] of [[390, 844, true], [1280, 900, false]]) {
      for (const dark of [false, true]) {
        const tag = `${path} ${w} ${dark ? 'dark' : 'light'}`;
        await b.setViewport(w, h, mobile);
        await b.media({ dark });
        await b.goto(path, 2500);
        await b.waitFor(`document.querySelector('[data-crew-summary]')`, 20_000, 'summary').catch(() => {});
        await sleep(400);
        const m = await b.eval(MEASURE);
        console.log(`  info ${tag}: ${JSON.stringify(m)}`);
        check(`${tag}: block present`, !!m);
        if (!m) continue;
        check(`${tag}: no sideways scroll`, m.scroll[0] <= m.scroll[1] + 1, JSON.stringify(m.scroll));
        if (want[w] != null) check(`${tag}: ${want[w]} columns`, m.cols === want[w], `got ${m.cols}`);
        if (path.includes('usage') && w === 1280) check(`${tag}: card >= 576 px`, m.cardW >= 576, `card ${m.cardW}, block ${m.rootW}`);
        await b.shot(`grid-${path.replace(/\W+/g, '_')}-${w}-${dark ? 'dark' : 'light'}`);
      }
    }
  }
} finally {
  await b.close?.();
}
console.log(failed ? `${failed} FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
