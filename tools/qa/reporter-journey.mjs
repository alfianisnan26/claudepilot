// The UI reporter's whole report journey as a first-time user (owner, 2026-11-01: "ensure the UI/UX journey is clean and easy to use"),
// in a real browser, the panel framed by a stand-in host as the SDK frames it, with a stand-in API. At 390x844 with touch and at 1280x800
// with a mouse and keys, light and dark:
//   Tickets (empty state) -> Report -> Screen -> the editor opens by itself on Rectangle -> a box, Undo, Redo -> Cancel asks "Discard your
//   marks?" (Keep) -> (desktop: ? lists the shortcuts, Esc closes them, Esc steps back to the question, Esc answers Keep) -> Done -> the
//   form with a suggested title -> details typed -> X asks "Discard this report?" (Keep) -> priority High -> File ticket shows "Filing…" /
//   "Uploading n/m" -> Filed -> Report again: Crop -> the editor opens on the tool used last -> Done -> priority still High, Crop is the
//   filled mode -> X discards a lone fresh shot without asking.
// Also: the motion classes play with no preference and are off with prefers-reduced-motion; every visible control is at least 44x44 px;
// no horizontal scroll; no page error. Self-contained (Vite dev server, stand-in API).
//   QA_SHOTS=<dir> node tools/qa/reporter-journey.mjs   ->  <dir>/journey-*.png, exit 1 on a failed check
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { Browser } from './browser.mjs';
import { sleep } from './lib.mjs';

const WEB = fileURLToPath(new URL('../../apps/web/', import.meta.url));
const HOST = 'https://stg.konfersi.example';
const now = new Date().toISOString();
const uploads = [];
const filed = [];
const API = {
  'GET /reporter/v1/status': { site: { origin: HOST, environment: 'stg', repo: 'platform/konfersi-landing-page', label: null, branch: 'stg' }, enabled: true, bucketKey: 'KONF', bucketName: 'Konfersi', calloutsDefault: true, sdkVersion: '0.1.0' },
  'GET /reporter/v1/me': { bucketKey: 'KONF', origin: HOST, actorLabel: 'Owner', expiresAt: now, clientIp: null, clientIpFamily: null },
  'GET /reporter/v1/tickets': { items: [], nextCursor: null, counts: { status: {}, priority: {}, type: {}, onPath: 0 } },
  'GET /reporter/v1/session-targets': [],
  'GET /reporter/v1/reviews': [],
  'GET /reporter/v1/sessions': [],
  'POST /reporter/v1/duplicates': { candidates: [] },
  'POST /reporter/v1/tickets': { key: 'KONF-15', url: '#' },
};

const HOST_PAGE = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0">
<iframe id="panel" style="position:fixed;left:0;right:0;bottom:0;width:100%;height:92vh;border:0"></iframe>
<script>
const f = document.getElementById('panel');
f.src = '/reporter/v1/embed?bucket=KONF&origin=' + encodeURIComponent(location.origin);
const build = { version: '1.2.0', commit: '${'b'.repeat(40)}', branch: 'stg', environment: 'stg', builtAt: null, repo: 'platform/konfersi-landing-page' };
const anchor = { path: '/', selector: '#hero-cta', relative: null, rect: { x: 20, y: 300, w: 200, h: 80 }, viewport: { w: 390, h: 844, dpr: 1 }, mode: 'viewport' };
const evidence = () => ({ schema: 1, sdkVersion: '0.1.0', capturedAt: new Date().toISOString(),
  page: { url: '${HOST}/', origin: '${HOST}', host: 'stg.konfersi.example', path: '/', search: '', hash: '', title: 'Home', referrer: '', lang: 'en', route: null, historyLength: 1 },
  device: { userAgent: navigator.userAgent, browser: { name: null, version: null }, os: { name: null, version: null }, mobile: true, touch: true, screen: { w: 390, h: 844, dpr: 1, orientation: null }, viewport: { w: 390, h: 844 }, hardwareConcurrency: null, deviceMemoryGb: null, connection: { effectiveType: null, downlinkMbps: null, rttMs: null, saveData: null }, timezone: null, locale: null },
  state: { scroll: { x: 0, y: 0, maxY: 0 }, visibility: 'visible', online: true, colorScheme: 'light', reducedMotion: false, focused: null, storageKeys: { local: [], session: [], cookies: [] }, app: null },
  build, anchor, dom: null, components: [], framework: null, console: [], network: [],
  performance: { navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null, type: null }, vitals: { lcpMs: null, cls: null, inpMs: null, fcpMs: null }, longTasks: { count: 0, totalMs: 0 }, memory: { usedJsHeapBytes: null, totalJsHeapBytes: null } },
  interactions: [], checks: { ran: true, findings: [] }, errorSignatures: [] });
addEventListener('message', async (e) => {
  if (e.source !== f.contentWindow || e.origin !== location.origin) return;
  const m = e.data;
  if (m.type === 'pilot-reporter:ready' && !window.said) { window.said = 1; f.contentWindow.postMessage({ type: 'pilot-reporter:hello', bridge: 1, sdkVersion: '0.1.0', page: { url: '${HOST}/', title: 'Home' }, build }, location.origin); }
  if (m.type === 'pilot-reporter:capture-request') {
    window.lastMode = m.mode;
    const c = document.createElement('canvas'); c.width = 390; c.height = 844; const g = c.getContext('2d');
    g.fillStyle = '#eef1f6'; g.fillRect(0, 0, 390, 844); g.fillStyle = '#1b2533'; g.fillRect(0, 0, 390, 64);
    g.fillStyle = '#c33'; g.fillRect(20, 300, 200, 80); g.fillStyle = '#111'; g.font = 'bold 22px sans-serif'; g.fillText('Get started', 40, 348);
    const buf = await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer();
    f.contentWindow.postMessage({ type: 'pilot-reporter:capture-result', requestId: m.requestId, screenshot: buf, mediaType: 'image/png', evidence: evidence() }, location.origin, [buf]);
  }
});
</script>`;

const standIn = {
  name: 'qa:reporter-journey-stand-in',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const path = req.url.split('?')[0];
      if (path === '/__qa-host') {
        res.setHeader('content-type', 'text/html');
        return res.end(HOST_PAGE);
      }
      if (path === '/reporter/v1/embed') {
        req.url = `/embed.html${req.url.slice(path.length)}`;
        return next();
      }
      if (!path.startsWith('/reporter/v1/')) return next();
      if (path === '/reporter/v1/events') return void res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && /\/attachments$/.test(path)) {
        // Slow enough that the progress line can be seen.
        await sleep(350);
        uploads.push({ kind: req.headers['x-reporter-kind'], size: body.length });
        return res.end(JSON.stringify({ data: { ok: true } }));
      }
      if (req.method === 'POST' && path === '/reporter/v1/tickets') {
        await sleep(350);
        filed.push(JSON.parse(body.toString('utf8')));
      }
      const key = `${req.method} ${path}`;
      if (!(key in API)) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found.' } }));
      }
      res.end(JSON.stringify({ data: API[key] }));
    });
  },
};

const server = await createServer({ configFile: `${WEB}vite.config.ts`, root: WEB, logLevel: 'error', server: { port: 0, host: '127.0.0.1' }, optimizeDeps: { entries: ['embed.html'] }, plugins: [standIn] });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const token = ['cprt', 'q'.repeat(24)].join('_');

const AUDIT = (doc) => `(() => {
  const doc = ${doc};
  const root = doc.documentElement;
  const small = [...doc.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=tab], [role=radio]')].filter((e) => {
    const r = e.getBoundingClientRect(); const s = doc.defaultView.getComputedStyle(e);
    if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || e.closest('.sr-only')) return false;
    // A select drawn invisibly over its chip (priority) is as big as the chip.
    if (s.opacity === '0') return false;
    return e.offsetWidth < 43.5 || e.offsetHeight < 43.5;
  }).map((e) => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 40) + ' ' + e.offsetWidth + 'x' + e.offsetHeight);
  return { overflow: root.scrollWidth - root.clientWidth, small };
})()`;

const failures = [];
const fail = (m) => {
  failures.push(m);
  console.log(`FAIL ${m}`);
};
const check = (name, a) => {
  if (a.overflow > 0) fail(`${name}: horizontal scroll ${a.overflow}px`);
  if (a.small.length) fail(`${name}: small targets ${a.small.join(', ')}`);
  console.log(`${name}: overflow ${a.overflow}px, small ${a.small.length}`);
};

try {
  for (const [label, width, height, dark, touch] of [
    ['390', 390, 844, false, true],
    ['390-dark', 390, 844, true, true],
    ['1280', 1280, 800, false, false],
    ['1280-dark', 1280, 800, true, false],
  ]) {
    uploads.length = 0;
    filed.length = 0;
    const b = await Browser.launch({ width, height, mobile: touch, dark });
    let step = 0;
    const shot = (n) => sleep(300).then(() => b.shot(`journey-${label}-${String(++step).padStart(2, '0')}-${n}`));
    try {
      await b.setViewport(width, height, touch);
      await b.media({ dark, reducedMotion: false });
      const F = `document.getElementById('panel').contentDocument`;
      const q = (sel) => `${F}.querySelector(${JSON.stringify(sel)})`;
      const has = (sel) => b.eval(`!!${q(sel)}`);
      const text = () => b.eval(`${F}.body.innerText`);
      const clickIn = (sel) => b.eval(`${q(sel)}.click()`);
      const clickButton = (re, scope = '') => b.eval(`[...${F}.querySelectorAll('${scope} button')].find((x) => x.offsetWidth > 0 && ${re}.test(x.textContent.trim())).click()`);
      const audit = async (name) => check(`${label} ${name}`, await b.eval(AUDIT(F)));
      const focusPanel = () => b.eval(`document.getElementById('panel').contentWindow.focus()`);
      const drawBox = async () => {
        const r = await b.eval(`(() => { const fr = document.getElementById('panel').getBoundingClientRect(); const s = ${q('[data-stage] canvas')}.getBoundingClientRect(); return { x: fr.x + s.x, y: fr.y + s.y, w: s.width, h: s.height }; })()`);
        const pts = Array.from({ length: 9 }, (_, i) => ({ x: r.x + r.w * (0.1 + 0.05 * i), y: r.y + r.h * (0.3 + 0.02 * i) }));
        if (touch) {
          await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...pts[0], id: 1 }] });
          for (const p of pts.slice(1)) {
            await b.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...p, id: 1 }] });
            await sleep(16);
          }
          await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
          await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pts[0] });
          await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pts[0], button: 'left', buttons: 1, clickCount: 1 });
          for (const p of pts.slice(1)) {
            await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, button: 'left', buttons: 1 });
            await sleep(16);
          }
          await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pts.at(-1), button: 'left', buttons: 0, clickCount: 1 });
        }
        await sleep(150);
      };
      const marks = () => b.eval(`Number(${q('[data-annotator]')}?.dataset.marks ?? -1)`);

      await b.goto(`${base}/__qa-host`, 2500);
      await b.eval(`${F}.defaultView.localStorage.setItem('pilot-reporter:token:KONF:' + location.origin, JSON.stringify({ token: '${token}', expiresAt: new Date(Date.now() + 36e5).toISOString(), actorLabel: 'Owner', bucketKey: 'KONF' }))`);
      await b.goto(`${base}/__qa-host`, 3000);
      await b.waitFor(`!!${q('[role=tab][aria-label=Report]')}`, 10000, 'the panel');
      await sleep(600);
      if (!/No open tickets/.test(await text())) fail(`${label}: the empty Tickets state does not say so in words`);
      if (!(await has('header svg'))) fail(`${label}: no pilot mark in the title row`);
      await audit('tickets');
      await shot('tickets-empty');

      // Motion: the tab change fades (pr-fade), the active tab's line grows; with reduced motion neither plays.
      await clickIn('[role=tab][aria-label=Report]');
      const anim = await b.eval(`getComputedStyle(${q('#panel-main > .anim-fade')}).animationName`);
      if (anim !== 'pr-fade') fail(`${label}: the tab change did not fade (${anim})`);
      await sleep(400);
      if ((await b.eval(`${q('[data-last]')}?.textContent.trim()`)) !== 'Screen') fail(`${label}: Screen is not the filled mode the first time`);
      await audit('report home');
      await shot('report-home');

      // Capture: the editor opens by itself, on Rectangle.
      await clickButton('/^Screen$/');
      await b.waitFor(`!!${q('[data-annotator] [data-stage] canvas')}`, 10000, 'the editor opens by itself after a capture');
      await sleep(500);
      const tool = await b.eval(`${q('[data-annotator]')}.dataset.tool`);
      if (tool !== 'rect') fail(`${label}: the editor opened on ${tool}, expected rect`);
      await audit('editor');
      await shot('editor-auto');
      await focusPanel();
      await drawBox();
      if ((await marks()) !== 1) fail(`${label}: the box did not register (${await marks()})`);
      await clickIn('[data-annotator] [aria-label=Undo]');
      await sleep(120);
      if ((await marks()) !== 0) fail(`${label}: Undo did not take the box back`);
      await clickIn('[data-annotator] [aria-label=Redo]');
      await sleep(120);
      if ((await marks()) !== 1) fail(`${label}: Redo did not bring it back`);
      await shot('editor-box');

      // Cancel with a mark asks first; Keep stays.
      await clickIn('[data-annotator] [aria-label=Cancel]');
      await sleep(250);
      if (!/Discard your marks\?/.test(await text())) fail(`${label}: Cancel with marks did not ask`);
      await audit('editor discard question');
      await shot('editor-discard-question');
      await clickButton('/^Keep$/', '[data-annotator]');
      await sleep(200);
      if (!(await has('[data-annotator]')) || /Discard your marks\?/.test(await text())) fail(`${label}: Keep did not keep the editor`);

      if (!touch) {
        // Keys: ? lists the shortcuts; Esc closes them first, then asks, then answers Keep; Enter is Done.
        await focusPanel();
        await b.key('?');
        await sleep(250);
        if (!(await has('[data-shortcuts]'))) fail(`${label}: ? did not list the shortcuts`);
        await shot('shortcuts');
        await b.key('Escape');
        await sleep(150);
        if (await has('[data-shortcuts]')) fail(`${label}: Esc did not close the shortcuts first`);
        if (!(await has('[data-annotator]'))) fail(`${label}: Esc closed the editor while the shortcuts were open`);
        await b.key('Escape');
        await sleep(150);
        if (!/Discard your marks\?/.test(await text())) fail(`${label}: Esc with changed marks did not ask`);
        await b.key('Escape');
        await sleep(150);
        if (/Discard your marks\?/.test(await text()) || !(await has('[data-annotator]'))) fail(`${label}: Esc on the question did not answer Keep`);
        await b.eval(`${F}.activeElement?.blur()`);
        await b.key('Enter');
      } else {
        await clickButton('/Done/', '[data-annotator]');
      }
      await b.waitFor(`!${q('[data-annotator]')}`, 8000, 'Done closes the editor');
      await sleep(400);

      // The form: a suggested title, details, X asks before throwing it away.
      const title = await b.eval(`${q('input[aria-label=Title]')}.value`);
      if (!/hero cta on Home/.test(title)) fail(`${label}: title suggestion "${title}"`);
      await clickButton('/^Details/');
      await sleep(150);
      await b.eval(`${q('textarea[aria-label=Details]')}.focus()`);
      await b.type('The button is cut off on narrow screens.');
      await audit('form');
      await shot('form');
      await clickIn('[aria-label=Discard]');
      await sleep(250);
      if (!(await has('[data-confirm]'))) fail(`${label}: X with work did not ask`);
      await shot('form-discard-question');
      await clickButton('/^Keep$/', '[data-confirm]');
      await sleep(200);
      if (await has('[data-confirm]')) fail(`${label}: Keep did not close the question`);
      if (!(await has('input[aria-label=Title]'))) fail(`${label}: Keep threw the report away`);

      // Priority High is remembered for the next report.
      await b.eval(`(() => { const s = ${q('select[aria-label=Priority]')}; s.value = 'high'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(150);

      // File: the button says Filing…, then Uploading n/m.
      const seen = new Set();
      await clickButton('/^File ticket$/');
      for (let i = 0; i < 60 && !/Filed KONF-15/.test(await text()); i++) {
        const t = await text();
        const m = /Filing…|Uploading \d+\/\d+/.exec(t);
        if (m) seen.add(m[0].startsWith('Uploading') ? 'Uploading' : 'Filing');
        if (i === 2) await shot('filing');
        await sleep(80);
      }
      if (!seen.has('Filing') || !seen.has('Uploading')) fail(`${label}: progress seen ${[...seen].join(', ') || 'none'}`);
      await b.waitFor(`${F}.body.innerText.includes('Filed KONF-15')`, 10000, 'the Filed row');
      if (filed[0]?.priority !== 'high') fail(`${label}: filed with priority ${filed[0]?.priority}`);
      await sleep(300);
      await audit('filed');
      await shot('filed');

      // The next report starts on what was used last.
      if (!touch) {
        await clickButton('/^Crop$/');
        await b.waitFor(`!!${q('[data-annotator] [data-stage] canvas')}`, 10000, 'the editor opens by itself after the second capture');
        await sleep(300);
        await clickButton('/Done/', '[data-annotator]');
        await b.waitFor(`!${q('[data-annotator]')}`, 8000, 'Done (no marks) closes the editor');
        await sleep(300);
        const pr = await b.eval(`${q('select[aria-label=Priority]')}.value`);
        if (pr !== 'high') fail(`${label}: the priority was not remembered (${pr})`);
        // A lone fresh shot goes without a question.
        await clickIn('[aria-label=Discard]');
        await sleep(300);
        if (await has('[data-confirm]')) fail(`${label}: a lone fresh shot asked before discarding`);
        if ((await b.eval(`${q('[data-last]')}?.textContent.trim()`)) !== 'Crop') fail(`${label}: Crop is not the filled mode after a crop`);
        await shot('report-home-remembered');
      }

      // Reduced motion: the same tab change plays nothing.
      await b.media({ dark, reducedMotion: true });
      await clickIn('[role=tab][aria-label=Tickets]');
      const still = await b.eval(`getComputedStyle(${q('#panel-main > .anim-fade')}).animationName`);
      if (still !== 'none') fail(`${label}: reduced motion still animates the tab change (${still})`);
      if (b.errors.length) fail(`${label}: page errors ${b.errors.join(' | ')}`);
    } finally {
      await b.close();
    }
  }
} finally {
  await server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} failed:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('\nreporter journey: all checks passed');
