// T-600 QA: the Crew summary block (Usage > Crew) and the Home Pace card, with a FIXTURE `headline` laid over the real scorecard response
// (the server does not send it yet), at 390 px (touch) and 1280 px, light and dark. Measures: label truncation, sideways scroll, InfoTip and
// control sizes, NaN text, the "unavailable" state, expanded details; screenshots per view.
// usage: tools/qa/with-portal.sh 3471 env QA_SHOTS=job-out/qa-ui-2 node tools/qa/crew-summary.mjs
import { Browser } from './browser.mjs';
import { login, sleep } from './lib.mjs';

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
  if (!ok) failed++;
};
const note = (s) => console.log(`  note ${s}`);

const FIXTURE = `(() => {
  const scen = window.__SCEN;
  const fig = (value, basis = 'measured', reason) => ({ value, basis, source: 'chat_usage and the quota windows', ...(reason ? { reason } : {}) });
  const gone = (reason) => fig(null, 'unavailable', reason);
  const win = (k) => ({
    fromMs: 0, toMs: 1,
    requestsPerHour: scen === 'none' ? gone('no_samples') : fig(120 * k),
    usdPerHour: scen === 'none' ? gone('no_samples') : fig(2.5 * k, 'estimate'),
    resolved: scen === 'none' ? gone('no_samples') : fig(45 * k),
    wontDo: fig(3),
    resolvedByProgram: [{ program: 'p', title: 'ClaudePilot with a very long program title that must wrap somewhere sensible', count: 45 }, { program: 'q', title: 'Konfersi', count: 64 }],
    perResolvedUsd: scen === 'none' ? gone('no_samples') : fig(0.42 * k, 'estimate'),
    createdPerClosed: scen === 'none' ? gone('no_samples') : fig(2.87 * k),
    createdPerClosedByProgram: [{ program: 'p', title: 'ClaudePilot', created: 158, closed: 55, ratio: fig(2.87) }, { program: 'q', title: 'Konfersi', created: 100, closed: 62, ratio: fig(1.61) }],
  });
  const pace = scen === 'none'
    ? { ratio: gone('windows_just_reset'), unusedAtResetPct: null, weekly: gone('no_source'), claudes: [] }
    : { ratio: fig(0.75), unusedAtResetPct: 25, weekly: gone('no_source'), claudes: [
        { claude: 'a', label: 'one.claude', usedPct: 49, evenPct: 50, ratio: fig(0.98), projectedPct: 98 },
        { claude: 'b', label: 'fadlilah.with.a.rather.long.account.label@example.com', usedPct: 21, evenPct: 50, ratio: fig(0.42), projectedPct: 42 } ] };
  return { pace, current: win(1), previous: scen === 'none' ? null : win(0.8) };
})()`;

const SCRIPT = (scen) => `(() => {
  window.__SCEN = ${JSON.stringify(scen)};
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await orig(input, init);
    const url = typeof input === 'string' ? input : input.url;
    if (!/scorecard/.test(url) || !res.ok) return res;
    const j = await res.clone().json().catch(() => null);
    if (!j) return res;
    j.headline = ${FIXTURE};
    if (!/compare=1/.test(url)) j.headline.previous = null;
    return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
  };
})()`;

const MEASURE = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const doc = document.scrollingElement;
  const root = document.querySelector('[data-crew-summary]');
  if (!root) return { present: false, docScroll: doc.scrollWidth, docClient: doc.clientWidth, text: (document.querySelector('main') || document.body).innerText.slice(0, 400) };
  const tiles = [...root.querySelectorAll('[data-summary-tile]')];
  const labels = tiles.map((t) => { const l = t.querySelector('dt > span'); return { key: t.dataset.summaryTile, text: l.textContent, truncated: l.scrollWidth > l.clientWidth + 1, w: Math.round(l.clientWidth), sw: l.scrollWidth }; });
  const tips = [...root.querySelectorAll('button')].filter(vis).map((e) => { const r = e.getBoundingClientRect(); return { label: e.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height) }; });
  const overflow = [...root.querySelectorAll('*')].filter((e) => vis(e) && e.getBoundingClientRect().right > innerWidth + 1).length;
  return {
    present: true, docScroll: doc.scrollWidth, docClient: doc.clientWidth, tiles: tiles.length, labels, tips, overflow,
    states: tiles.map((t) => t.dataset.state), heights: tiles.map((t) => Math.round(t.getBoundingClientRect().height)),
    title: document.querySelector('[data-summary-title]')?.textContent ?? null,
    text: root.innerText, bad: /\\b(NaN|undefined|null)\\b/.test(root.innerText),
  };
})()`;

const cookie = await login();
const b = await Browser.launch({ width: 390, height: 844, mobile: true, cookie });
await b.cookie(cookie);
const SIZES = [
  { name: '390', w: 390, h: 844, mobile: true },
  { name: '1280', w: 1280, h: 900, mobile: false },
];
try {
  for (const scen of ['full', 'none']) {
    await b.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: b.scriptId ?? '0' }).catch(() => {});
    const r = await b.send('Page.addScriptToEvaluateOnNewDocument', { source: SCRIPT(scen) });
    b.scriptId = r.identifier;
    for (const size of SIZES) {
      for (const dark of [false, true]) {
        const tag = `${scen}-${size.name}-${dark ? 'dark' : 'light'}`;
        console.log(tag);
        await b.setViewport(size.w, size.h, size.mobile);
        await b.media({ dark });
        await b.goto('/admin/usage?tab=crew', 2500);
        await b.waitFor(`document.querySelector('[data-crew-summary]')`, 20_000, 'summary').catch(() => {});
        await sleep(400);
        let s = await b.eval(MEASURE);
        check(`${tag}: summary block present`, s.present, s.present ? '' : s.text);
        if (!s.present) continue;
        check(`${tag}: title is one word`, s.title === 'Summary', s.title);
        check(`${tag}: 5 tiles, no NaN`, s.tiles === 5 && !s.bad, JSON.stringify(s.states));
        check(`${tag}: no sideways scroll`, s.docScroll <= s.docClient + 1 && s.overflow === 0, JSON.stringify([s.docScroll, s.docClient, s.overflow]));
        const cut = s.labels.filter((l) => l.truncated);
        check(`${tag}: no tile label truncated`, cut.length === 0, JSON.stringify(cut));
        console.log(`  info labels ${JSON.stringify(s.labels.map((l) => [l.text, l.w, l.sw]))} tile heights ${JSON.stringify(s.heights)}`);
        const small = s.tips.filter((t) => t.w < 43.5 || t.h < 43.5);
        if (size.mobile) check(`${tag}: controls >= 44 px`, small.length === 0, JSON.stringify(small));
        else note(`${tag}: controls under 44 px (1280 note): ${small.length}`);
        if (scen === 'none') check(`${tag}: reads "unavailable" with a reason`, /unavailable/.test(s.text) && /just reset/.test(s.text) && !/\d : 1/.test(s.text), s.text.replace(/\s+/g, ' ').slice(0, 200));
        else check(`${tag}: pace reads "0.75 : 1" and created closed "2.87 : 1"`, /0\.75 : 1/.test(s.text) && /2\.87 : 1/.test(s.text));
        await b.shot(`summary-${tag}`);
        // InfoTip by touch / keyboard
        await b.clickSel('[data-summary-tile="pace"] button');
        await sleep(300);
        const tipOpen = await b.eval(`(() => { const t = [...document.querySelectorAll('[role=tooltip], [role=dialog], [data-infotip-open]')].filter((e) => e.getBoundingClientRect().width > 0); return t.map((e) => e.innerText.slice(0, 160)); })()`);
        check(`${tag}: pace InfoTip opens on click`, tipOpen.length > 0, JSON.stringify(tipOpen));
        await b.shot(`summary-tip-${tag}`);
        await b.key('Escape');
        await b.focusSel('[data-summary-tile="usage"] button');
        await b.key('Enter');
        await sleep(300);
        const kb = await b.eval(`[...document.querySelectorAll('[role=tooltip], [role=dialog], [data-infotip-open]')].filter((e) => e.getBoundingClientRect().width > 0).length`);
        check(`${tag}: usage InfoTip opens by keyboard Enter`, kb > 0);
        await b.key('Escape');
        // expand
        await b.clickSel('button[aria-label="Show summary details"]');
        await sleep(300);
        s = await b.eval(MEASURE);
        check(`${tag}: details: no sideways scroll, no NaN`, s.docScroll <= s.docClient + 1 && s.overflow === 0 && !s.bad, JSON.stringify([s.docScroll, s.docClient, s.overflow]));
        await b.shot(`summary-details-${tag}`, { full: true });

        // Home
        await b.goto('/', 2500);
        await b.waitFor(`document.querySelector('[data-crew-summary]')`, 15_000, 'home pace').catch(() => {});
        const h = await b.eval(MEASURE);
        check(`${tag}: Home shows the Pace card`, h.present, h.present ? '' : 'not found on /');
        check(`${tag}: Home no sideways scroll`, h.docScroll <= h.docClient + 1 && (h.overflow ?? 0) === 0, JSON.stringify([h.docScroll, h.docClient, h.overflow]));
        if (h.present) {
          const cut2 = h.labels.filter((l) => l.truncated);
          check(`${tag}: Home no tile label truncated`, cut2.length === 0, JSON.stringify(cut2));
          await b.eval(`document.querySelector('[data-crew-summary]').scrollIntoView({ block: 'center' })`);
        }
        await b.shot(`home-pace-${tag}`);
      }
    }
  }
} finally {
  await b.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
