// The UI reporter's annotation editor (PILOT-1111, owner 2026-10-31) in a real browser, framed by a stand-in host as the SDK frames the
// panel: a capture comes back, the shot's pencil opens the editor, and every tool draws (pen, line, arrow, rectangle, ellipse, highlight,
// blur, numbers, text with inline editing); select moves a mark; undo and redo; a two-finger pinch zooms and never draws; Done returns to
// the form; filing uploads what it should: with a blur ONLY the flattened image as the screenshot, without one the original and the
// annotated image. At 390 px with touch (blur path) and at 1280 px with a mouse and keyboard shortcuts (no blur), light and dark.
// Checks: no horizontal scroll, every visible control at least 44x44 px, no page error. Self-contained (Vite dev server, stand-in API).
//   QA_SHOTS=<dir> node tools/qa/reporter-annotate.mjs   ->  <dir>/annotate-*.png, exit 1 on a failed check
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
window.got = [];
f.src = '/reporter/v1/embed?bucket=KONF&origin=' + encodeURIComponent(location.origin);
const build = { version: '1.2.0', commit: '${'b'.repeat(40)}', branch: 'stg', environment: 'stg', builtAt: null, repo: 'platform/konfersi-landing-page' };
const anchor = { path: '/', selector: 'main h1', relative: null, rect: { x: 20, y: 300, w: 200, h: 80 }, viewport: { w: 390, h: 844, dpr: 1 }, mode: 'viewport' };
const evidence = () => ({ schema: 1, sdkVersion: '0.1.0', capturedAt: new Date().toISOString(),
  page: { url: '${HOST}/', origin: '${HOST}', host: 'stg.konfersi.example', path: '/', search: '', hash: '', title: 'Home', referrer: '', lang: 'en', route: null, historyLength: 1 },
  device: { userAgent: navigator.userAgent, browser: { name: null, version: null }, os: { name: null, version: null }, mobile: true, touch: true, screen: { w: 390, h: 844, dpr: 1, orientation: null }, viewport: { w: 390, h: 844 }, hardwareConcurrency: null, deviceMemoryGb: null, connection: { effectiveType: null, downlinkMbps: null, rttMs: null, saveData: null }, timezone: null, locale: null },
  state: { scroll: { x: 0, y: 0, maxY: 0 }, visibility: 'visible', online: true, colorScheme: 'light', reducedMotion: false, focused: null, storageKeys: { local: [], session: [], cookies: [] }, app: null },
  build, anchor, dom: null, components: [], framework: null, console: [], network: [],
  performance: { navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null, type: null }, vitals: { lcpMs: null, cls: null, inpMs: null, fcpMs: null }, longTasks: { count: 0, totalMs: 0 }, memory: { usedJsHeapBytes: null, totalJsHeapBytes: null } },
  interactions: [], checks: { ran: true, findings: [] }, errorSignatures: [] });
addEventListener('message', async (e) => {
  if (e.source !== f.contentWindow || e.origin !== location.origin) return;
  const m = e.data; window.got.push(m.type);
  if (m.type === 'pilot-reporter:ready' && !window.said) { window.said = 1; f.contentWindow.postMessage({ type: 'pilot-reporter:hello', bridge: 1, sdkVersion: '0.1.0', page: { url: '${HOST}/', title: 'Home' }, build }, location.origin); }
  if (m.type === 'pilot-reporter:capture-request') {
    // A page with a "secret" line in the middle: what the blur must hide in the uploaded pixels.
    const c = document.createElement('canvas'); c.width = 390; c.height = 844; const g = c.getContext('2d');
    g.fillStyle = '#eef1f6'; g.fillRect(0, 0, 390, 844); g.fillStyle = '#1b2533'; g.fillRect(0, 0, 390, 64);
    g.fillStyle = '#c33'; g.fillRect(20, 300, 200, 80); g.fillStyle = '#111'; g.font = 'bold 22px sans-serif'; g.fillText('API KEY 1234-5678-9999', 20, 470);
    const buf = await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer();
    f.contentWindow.postMessage({ type: 'pilot-reporter:capture-result', requestId: m.requestId, screenshot: buf, mediaType: 'image/png', evidence: evidence() }, location.origin, [buf]);
  }
});
</script>`;

const standIn = {
  name: 'qa:reporter-annotate-stand-in',
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
      if (req.method === 'POST' && /\/attachments$/.test(path)) {
        uploads.push({ kind: req.headers['x-reporter-kind'], capture: req.headers['x-reporter-capture'], type: req.headers['content-type'], size: body.length, png: body.subarray(1, 4).toString('ascii') === 'PNG' });
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ data: { ok: true } }));
      }
      if (req.method === 'POST' && path === '/reporter/v1/tickets') filed.push(JSON.parse(body.toString('utf8')));
      const key = `${req.method} ${path}`;
      res.setHeader('content-type', 'application/json');
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
    // Inside a horizontally scrolled tool row, a control cut by the edge is still 44 px.
    return e.offsetWidth < 43.5 || e.offsetHeight < 43.5;
  }).map((e) => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 40) + ' ' + e.offsetWidth + 'x' + e.offsetHeight);
  return { overflow: root.scrollWidth - root.clientWidth, small };
})()`;

const failures = [];
const check = (name, a) => {
  if (a.overflow > 0) failures.push(`${name}: horizontal scroll ${a.overflow}px`);
  if (a.small.length) failures.push(`${name}: small targets ${a.small.join(', ')}`);
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
    const shot = (n) => sleep(300).then(() => b.shot(`annotate-${label}-${n}`));
    try {
      await b.setViewport(width, height, touch);
      await b.media({ dark });
      const F = `document.getElementById('panel').contentDocument`;
      const q = (sel) => `${F}.querySelector(${JSON.stringify(sel)})`;
      const clickIn = (sel) => b.eval(`${q(sel)}.click()`);
      const marks = () => b.eval(`Number(${q('[data-annotator]')}?.dataset.marks ?? -1)`);
      const scale = () => b.eval(`Number(${q('[data-annotator]')}?.dataset.scale ?? 0)`);
      /** Page coordinates of a point given in fractions of the editor's stage. */
      const at = async (fx, fy) =>
        b.eval(`(() => { const fr = document.getElementById('panel').getBoundingClientRect(); const s = ${q('[data-stage] canvas')}.getBoundingClientRect(); return { x: fr.x + s.x + s.width * ${fx}, y: fr.y + s.y + s.height * ${fy} }; })()`);
      const drag = async (pts) => {
        const p = [];
        for (const [fx, fy] of pts) p.push(await at(fx, fy));
        if (touch) {
          await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p[0].x, y: p[0].y, id: 1 }] });
          for (const x of p.slice(1)) {
            await b.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x.x, y: x.y, id: 1 }] });
            await sleep(16);
          }
          await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
          await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p[0].x, y: p[0].y });
          await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p[0].x, y: p[0].y, button: 'left', buttons: 1, clickCount: 1 });
          for (const x of p.slice(1)) {
            await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x.x, y: x.y, button: 'left', buttons: 1 });
            await sleep(16);
          }
          const l = p.at(-1);
          await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: l.x, y: l.y, button: 'left', buttons: 0, clickCount: 1 });
        }
        await sleep(120);
      };
      const line = (x1, y1, x2, y2, n = 8) => Array.from({ length: n + 1 }, (_, i) => [x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n]);
      const pick = async (toolLabel, key) => {
        if (!touch && key) {
          await b.key(key);
          await sleep(80);
          const on = await b.eval(`${F}.querySelector('[aria-label^="${toolLabel} ("]:not([class*=hidden])')?.getAttribute('aria-pressed')`);
          const pressed = await b.eval(`[...${F}.querySelectorAll('[aria-label^="${toolLabel} ("]')].some((e) => e.offsetWidth > 0 && e.getAttribute('aria-pressed') === 'true')`);
          if (!pressed) failures.push(`${label}: key ${key} did not pick ${toolLabel} (${on})`);
          return;
        }
        await b.eval(`[...${F}.querySelectorAll('[aria-label^="${toolLabel} ("]')].find((e) => e.offsetWidth > 0).click()`);
        await sleep(80);
      };
      const expectMarks = async (n, what) => {
        const m = await marks();
        if (m !== n) failures.push(`${label}: after ${what} expected ${n} marks, got ${m}`);
      };

      await b.goto(`${base}/__qa-host`, 2500);
      await b.eval(`${F}.defaultView.localStorage.setItem('pilot-reporter:token:KONF:' + location.origin, JSON.stringify({ token: '${token}', expiresAt: new Date(Date.now() + 36e5).toISOString(), actorLabel: 'Owner', bucketKey: 'KONF' }))`);
      await b.goto(`${base}/__qa-host`, 3000);
      await b.waitFor(`!!${q('[role=tab][aria-label=Report]')}`, 10000, 'the panel');
      await clickIn('[role=tab][aria-label=Report]');
      await sleep(400);
      await b.eval(`[...${F}.querySelectorAll('button')].find((x) => /^Screen$/.test(x.textContent)).click()`);
      await b.waitFor(`!!${q('[aria-label="Annotate shot 1"]')}`, 10000, 'the report form with the shot');
      await sleep(300);
      check(`${label} form`, await b.eval(AUDIT(F)));

      await clickIn('[aria-label="Annotate shot 1"]');
      await b.waitFor(`!!${q('[data-annotator] [data-stage] canvas')}`, 8000, 'the editor');
      await sleep(500);
      check(`${label} editor`, await b.eval(AUDIT(F)));
      await shot('empty');
      // Keys go to the focused frame: the panel's, as after a click in it.
      await b.eval(`document.getElementById('panel').contentWindow.focus()`);

      let n = 0;
      await pick('Pen', 'p');
      await drag([[0.1, 0.12], [0.2, 0.16], [0.3, 0.12], [0.4, 0.16], [0.5, 0.12]]);
      await expectMarks(++n, 'pen');
      await pick('Line', 'l');
      await drag(line(0.1, 0.22, 0.5, 0.22));
      await expectMarks(++n, 'line');
      await pick('Arrow', 'a');
      await drag(line(0.8, 0.25, 0.6, 0.38));
      await expectMarks(++n, 'arrow');
      await pick('Rectangle', 'r');
      await drag(line(0.04, 0.34, 0.6, 0.47));
      await expectMarks(++n, 'rectangle');
      await pick('Ellipse', 'o');
      await drag(line(0.6, 0.6, 0.95, 0.75));
      await expectMarks(++n, 'ellipse');
      await pick('Highlight', 'h');
      await drag(line(0.05, 0.2, 0.55, 0.2));
      await expectMarks(++n, 'highlight');
      if (touch) {
        await pick('Blur', 'b');
        await drag(line(0.03, 0.53, 0.75, 0.58));
        await expectMarks(++n, 'blur');
        const note = await b.eval(`${F}.body.innerText`);
        if (!/Blurred areas are removed from the uploaded image/.test(note)) failures.push(`${label}: the blur note is missing`);
      }
      await pick('Number', 'n');
      await drag([[0.85, 0.1]]);
      await drag([[0.85, 0.2]]);
      n += 2;
      await expectMarks(n, 'two steps');
      await pick('Text', 't');
      await drag([[0.1, 0.8]]);
      await b.waitFor(`!!${q('[data-annotator] textarea[aria-label=Text]')}`, 4000, 'the inline text box');
      await b.type('Too small');
      await shot('text-editing');
      await b.key('Enter');
      await sleep(200);
      await expectMarks(++n, 'text');

      // Undo and redo (buttons on touch, Ctrl+Z / Ctrl+Shift+Z with a keyboard).
      if (touch) await clickIn('[aria-label=Undo]');
      else await b.key('z', { modifiers: 2 });
      await sleep(150);
      await expectMarks(n - 1, 'undo');
      if (touch) await clickIn('[aria-label=Redo]');
      else await b.key('z', { modifiers: 2 | 8 });
      await sleep(150);
      await expectMarks(n, 'redo');

      // Select and move the rectangle: still the same count.
      await pick('Select', 'v');
      await drag(line(0.04, 0.4, 0.2, 0.42, 6));
      await expectMarks(n, 'move');

      if (touch) {
        // A pinch: two fingers apart. It zooms and never draws (even with a drawing tool on).
        await pick('Pen', null);
        const s0 = await scale();
        const c = await at(0.5, 0.5);
        await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x - 20, y: c.y, id: 1 }] });
        await sleep(16);
        await b.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x - 20, y: c.y, id: 1 }, { x: c.x + 20, y: c.y, id: 2 }] });
        for (let i = 1; i <= 8; i++) {
          await b.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x - 20 - i * 12, y: c.y, id: 1 }, { x: c.x + 20 + i * 12, y: c.y, id: 2 }] });
          await sleep(16);
        }
        await b.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await sleep(200);
        const s1 = await scale();
        if (!(s1 > s0 * 1.2)) failures.push(`${label}: the pinch did not zoom (${s0} -> ${s1})`);
        await expectMarks(n, 'pinch (it must not draw)');
        await shot('zoomed');
      }

      check(`${label} editor with marks`, await b.eval(AUDIT(F)));
      await shot('marks');
      await b.eval(`[...${F}.querySelectorAll('[data-annotator] button')].find((x) => /Done/.test(x.textContent)).click()`);
      await b.waitFor(`!${q('[data-annotator]')}`, 8000, 'Done closes the editor');
      await sleep(400);
      await shot('form-annotated');

      const queue = await b.eval(`!![...${F}.querySelectorAll('[role=radio]')].find((x) => x.textContent === 'Queue')`);
      if (queue) await b.eval(`[...${F}.querySelectorAll('[role=radio]')].find((x) => x.textContent === 'Queue').click()`);
      await b.eval(`[...${F}.querySelectorAll('button')].find((x) => /^File ticket$/.test(x.textContent)).click()`);
      await b.waitFor(`${F}.body.innerText.includes('Filed KONF-15')`, 10000, 'the Filed row');
      await sleep(500);
      const sent = filed[0]?.captures?.[0]?.annotations ?? [];
      const types = [...new Set(sent.map((m) => m.type))].sort().join(',');
      const want = touch ? 'arrow,blur,ellipse,highlight,line,pen,rect,step,text' : 'arrow,ellipse,highlight,line,pen,rect,step,text';
      if (types !== want) failures.push(`${label}: the capture carried marks ${types}, expected ${want}`);
      if (!sent.some((m) => m.type === 'text' && m.text === 'Too small')) failures.push(`${label}: the text mark is missing`);
      const kinds = uploads.filter((u) => u.kind !== 'evidence').map((u) => u.kind).join(',');
      if (touch && kinds !== 'screenshot') failures.push(`${label}: with a blur only the flattened screenshot may upload, got ${kinds}`);
      if (!touch && kinds !== 'screenshot,annotated') failures.push(`${label}: without blur the original and the annotated image upload, got ${kinds}`);
      if (uploads.some((u) => u.kind !== 'evidence' && !u.png)) failures.push(`${label}: an image upload is not a PNG`);
      console.log(`${label}: marks ${types}; uploads ${uploads.map((u) => `${u.kind}:${u.size}`).join(' ')}`);
      await shot('filed');
      if (b.errors.length) failures.push(`${label}: page errors ${b.errors.join(' | ')}`);
    } finally {
      await b.close();
    }
  }
} finally {
  await server.close();
}

if (failures.length) {
  console.error(`FAIL\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('PASS reporter annotate');
