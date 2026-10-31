// The UI reporter's panel (apps/web/embed.html, docs/prd/ui-reporter.md) at 390 px with touch and at 1280 px, light and dark: Tickets
// (This page, text rows and thumbnail rows), a ticket card (one meta line, thread, pinned composer), the screenshot viewer, the filter
// sheet and sort popover, Sessions and the in-panel chat, the Context sheet, the report home, and (framed by a stand-in host) the report
// form with a capture, Ask lead now, the direct ask landing in the chat, and the Filed row. Checks: no horizontal scroll, every visible control at least 44x44 px, no page error. Self-contained: it starts
// a Vite dev server for apps/web with a stand-in /reporter/v1 API (no portal, no database), so it runs anywhere chromium is.
//   node tools/qa/reporter-panel.mjs            ->  $QA_SHOTS/reporter-*.png, exit 1 on a failed check
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { Browser } from './browser.mjs';
import { sleep } from './lib.mjs';

const WEB = fileURLToPath(new URL('../../apps/web/', import.meta.url));
const HOST = 'https://stg.konfersi.example';
const now = new Date().toISOString();
const anchor = (path, y) => ({ path, selector: 'main h1', relative: null, rect: { x: 20, y, w: 200, h: 80 }, viewport: { w: 390, h: 844, dpr: 3 }, mode: 'crop' });
const deployments = [
  { environment: 'stg', status: 'deployed', currentCommit: 'b'.repeat(40), seenAt: now, fixCommit: 'a'.repeat(40), reason: null },
  { environment: 'uat', status: 'not-deployed', currentCommit: 'c'.repeat(40), seenAt: now, fixCommit: null, reason: null },
  { environment: 'prod', status: 'unknown', currentCommit: null, seenAt: null, fixCommit: null, reason: 'no-build-seen' },
];
const site = { bucketKey: 'KONF', origin: HOST, environment: 'stg', repo: 'platform/konfersi-landing-page', declaredMismatch: null };
const ticket = (key, summary, phase, y, extra = {}) => ({
  key, summary, status: phase === 'deployed' ? 'done' : 'open', type: 'bug', priority: 'high', createdAt: now, updatedAt: now, url: `/tickets/${key}`,
  captures: [
    { captureId: `${key}-1`, index: 1, pageUrl: `${HOST}/`, anchor: anchor('/', y), note: null, createdAt: now, screenshotUrl: null },
    { captureId: `${key}-2`, index: 2, pageUrl: `${HOST}/pricing`, anchor: anchor('/pricing', 40), note: null, createdAt: now, screenshotUrl: null },
  ],
  build: null, phase, fix: null, site, target: { kind: 'ticket' }, fixCommits: phase === 'deployed' ? ['a'.repeat(40)] : [], deployments,
  unread: 1, awaitingReporter: key === 'KONF-12', repro: { steps: ['Open /', 'Tap “Pricing” link'], playwright: '' }, checkCounts: { critical: 1, serious: 0, moderate: 2, minor: 0 }, ...extra,
});
const tickets = [
  ticket('KONF-12', 'Hero button text is cut off on small phones, and the second line of the headline wraps under the image', 'working', 300),
  ticket('KONF-9', 'Footer links overlap the cookie banner', 'deployed', 1400, { target: { kind: 'session', sessionId: 's1', label: 'Konfersi lead', status: 'delivery-failed' } }),
  ticket('KONF-14', '[Pricing] The annual toggle resets when the page reloads', 'open', 0, { captures: [], priority: 'normal', unread: 0, awaitingReporter: false, deployments: [] }),
  ticket('KONF-15', '[Pricing] Currency symbol is missing on the enterprise plan card', 'review', 0, { captures: [], priority: 'urgent', unread: 0, awaitingReporter: false }),
];
// KONF-12's shots have screenshots (thumbnail rows, the viewer); the rest are filed without one (compact text rows).
tickets[0].captures = tickets[0].captures.map((c) => ({ ...c, screenshotUrl: `/reporter/v1/tickets/KONF-12/captures/${c.captureId}/screenshot` }));
const SHOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844"><rect width="390" height="844" fill="#eef1f6"/><rect width="390" height="64" fill="#1b2533"/><text x="20" y="40" font-family="sans-serif" font-size="22" fill="#fff">KONFERSI</text><text x="20" y="200" font-family="sans-serif" font-size="30" font-weight="700" fill="#1b2533">Run better events</text><rect x="20" y="300" width="200" height="80" rx="12" fill="#c33"/><text x="40" y="350" font-family="sans-serif" font-size="20" fill="#fff">Book a dem</text></svg>`;
const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
const chatLines = [
  { seq: 1, at: ago(30), kind: 'user', text: 'Why is the hero button cut off on small phones?', from: 'Owner (reporter, https://stg.konfersi.example)', tool: null, images: [{ url: '/reporter/v1/sessions/s1/blobs/' + 'a'.repeat(64), mediaType: 'image/svg+xml', width: 390, height: 844 }] },
  { seq: 2, at: ago(29), kind: 'tool', text: 'grep -rn "Book a demo" src/components', from: null, tool: 'Bash', images: [] },
  { seq: 3, at: ago(29), kind: 'tool', text: 'src/components/Hero.tsx', from: null, tool: 'Read', images: [] },
  { seq: 4, at: ago(28), kind: 'assistant', text: 'The button has a fixed `width: 160px` and the label wraps at 390 px. I will switch it to `min-width` with padding and check iOS Safari.', from: null, tool: null, images: [] },
  { seq: 5, at: ago(2), kind: 'approval', text: 'Run a command: npm run build', from: null, tool: null, images: [] },
];
const chatSession = { id: 's1', title: 'mo-T-2430 Konfersi lead', state: 'waiting', waiting: 1, waitingFor: 'Run a command: npm run build', lastSeq: 5, ticketKey: 'KONF-12', url: '#' };
const API = {
  'GET /reporter/v1/status': { site: { origin: HOST, environment: 'stg', repo: 'platform/konfersi-landing-page', label: null, branch: 'stg' }, enabled: true, bucketKey: 'KONF', bucketName: 'Konfersi', calloutsDefault: true, sdkVersion: '0.1.0' },
  'GET /reporter/v1/me': { bucketKey: 'KONF', origin: HOST, actorLabel: 'Owner', expiresAt: now, clientIp: '203.0.113.7', clientIpFamily: 4 },
  'GET /reporter/v1/tickets': { items: tickets, nextCursor: null, counts: { status: { open: 1, done: 1 }, priority: { high: 2 }, type: { bug: 2 }, onPath: 2 } },
  'GET /reporter/v1/tickets/KONF-12': tickets[0],
  'GET /reporter/v1/tickets/KONF-12/comments': [
    { id: '1', author: 'Konfersi lead', authorKind: 'agent', body: 'Is this on **iOS Safari** only? See `hero.tsx`.', createdAt: ago(50) },
    { id: '2', author: 'Konfersi lead', authorKind: 'agent', body: 'Build log:\n```\n' + Array.from({ length: 14 }, (_, i) => `step ${i + 1}: ok`).join('\n') + '\n```', createdAt: ago(48) },
    { id: '3', author: 'You', authorKind: 'reporter', body: 'Yes, iPhone 13 mini. Chrome is fine.', createdAt: ago(20) },
    { id: '4', author: 'Konfersi lead', authorKind: 'agent', body: 'Thanks. A long answer that goes on to show how a clamped body reads in the compact thread: the label wraps because the button has a fixed width, and at 390 px the second word drops to a new line, which pushes the icon out of the button. The fix is a min-width with horizontal padding, and a check on the smallest supported phone. It is deployed to stg in the next build.', createdAt: ago(5) },
  ],
  'GET /reporter/v1/tickets/KONF-9': tickets[1],
  'GET /reporter/v1/tickets/KONF-9/comments': [],
  'GET /reporter/v1/tickets/KONF-15': tickets[3],
  'GET /reporter/v1/tickets/KONF-15/comments': [],
  'GET /reporter/v1/sessions/s1/messages': { items: chatLines, before: null, session: chatSession },
  'POST /reporter/v1/sessions/s1/messages': { uuid: 'x' },
  'POST /reporter/v1/tickets': { key: 'KONF-15', url: '#', sessionDelivery: { sessionId: 's1', delivered: false, error: null } },
  'POST /reporter/v1/tickets/KONF-15/attachments': { ok: true },
  'GET /reporter/v1/session-targets': [{ sessionId: 's1', label: 'Konfersi lead', status: 'working', available: true, reason: null }],
  'GET /reporter/v1/reviews': [],
  'GET /reporter/v1/sessions': [
    { id: 's1', title: 'mo-T-2430 Konfersi lead', status: 'waiting', ticketKey: 'KONF-12', updatedAt: now, url: '#' },
    { id: 's2', title: 'Pricing page fixes', status: 'idle', ticketKey: 'KONF-14', updatedAt: now, url: '#' },
  ],
  'POST /reporter/v1/duplicates': { candidates: [{ key: 'KONF-12', summary: 'Hero button text is cut off on small phones', status: 'open', reasons: ['same-area'], score: 0.8, url: '#', thumbnailUrl: null }] },
};

/**
 * A stand-in host page (the SDK's part): frames the panel as the SDK does, answers `ready` with `hello`, and answers a capture request
 * with a drawn screenshot and an evidence bundle, so the bridge and the report form run end to end.
 */
const HOST_PAGE = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0">
<iframe id="panel" style="position:fixed;left:0;right:0;bottom:0;width:100%;height:92vh;border:0"></iframe>
<script>
const f = document.getElementById('panel');
window.got = [];
f.src = '/reporter/v1/embed?bucket=KONF&origin=' + encodeURIComponent(location.origin);
const build = { version: '1.2.0', commit: '${'b'.repeat(40)}', branch: 'stg', environment: 'stg', builtAt: null, repo: 'platform/konfersi-landing-page' };
const anchor = { path: '/', selector: 'main h1', relative: null, rect: { x: 20, y: 300, w: 200, h: 80 }, viewport: { w: 390, h: 844, dpr: 1 }, mode: 'crop' };
const evidence = () => ({ schema: 1, sdkVersion: '0.1.0', capturedAt: new Date().toISOString(),
  page: { url: '${HOST}/', origin: '${HOST}', host: 'stg.konfersi.example', path: '/', search: '', hash: '', title: 'Home', referrer: '', lang: 'en', route: null, historyLength: 1 },
  device: { userAgent: navigator.userAgent, browser: { name: null, version: null }, os: { name: null, version: null }, mobile: true, touch: true, screen: { w: 390, h: 844, dpr: 1, orientation: null }, viewport: { w: 390, h: 844 }, hardwareConcurrency: null, deviceMemoryGb: null, connection: { effectiveType: null, downlinkMbps: null, rttMs: null, saveData: null }, timezone: null, locale: null },
  state: { scroll: { x: 0, y: 0, maxY: 0 }, visibility: 'visible', online: true, colorScheme: 'light', reducedMotion: false, focused: null, storageKeys: { local: [], session: [], cookies: [] }, app: null },
  build, anchor, dom: null, components: [], framework: null, console: [{ ts: 1, level: 'error', text: 'TypeError: x is undefined' }], network: [],
  performance: { navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null, type: null }, vitals: { lcpMs: null, cls: null, inpMs: null, fcpMs: null }, longTasks: { count: 0, totalMs: 0 }, memory: { usedJsHeapBytes: null, totalJsHeapBytes: null } },
  interactions: [], checks: { ran: true, findings: [{ source: 'target-size', rule: 'target-size', severity: 'serious', message: 'Button is 32x32', selector: 'main button', help: null }] }, errorSignatures: ['TypeError: x is undefined'] });
addEventListener('message', async (e) => {
  if (e.source !== f.contentWindow || e.origin !== location.origin) return;
  const m = e.data; window.got.push(m.type);
  if (m.type === 'pilot-reporter:ready' && !window.said) { window.said = 1; f.contentWindow.postMessage({ type: 'pilot-reporter:hello', bridge: 1, sdkVersion: '0.1.0', page: { url: '${HOST}/', title: 'Home' }, build }, location.origin);
    const ev = evidence(); f.contentWindow.postMessage({ type: 'pilot-reporter:context', page: ev.page, device: ev.device, build, counts: { console: 4, consoleErrors: 1, network: 23, networkFailed: 1, interactions: 6 } }, location.origin); }
  if (m.type === 'pilot-reporter:capture-request') {
    const c = document.createElement('canvas'); c.width = 390; c.height = 844; const g = c.getContext('2d'); g.fillStyle = '#eef'; g.fillRect(0, 0, 390, 844); g.fillStyle = '#c33'; g.fillRect(20, 300, 200, 80);
    const buf = await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer();
    f.contentWindow.postMessage({ type: 'pilot-reporter:capture-result', requestId: m.requestId, screenshot: buf, mediaType: 'image/png', evidence: evidence() }, location.origin, [buf]);
  }
});
</script>`;

const standIn = {
  name: 'qa:reporter-stand-in',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
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
      if (/\/screenshot$|\/blobs\//.test(path)) {
        res.setHeader('content-type', 'image/svg+xml');
        return res.end(SHOT_SVG);
      }
      if (/^\/reporter\/v1\/sessions\/s1\/stream$/.test(path)) {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        return void res.write(JSON.stringify({ type: 'hello', session: chatSession }) + '\n');
      }
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
const embed = `${base}/reporter/v1/embed?bucket=KONF&origin=${encodeURIComponent(HOST)}`;
// Built at run time: no token-shaped literal in the repository.
const token = ['cprt', 'q'.repeat(24)].join('_');

/** Evaluated in the panel: horizontal overflow and controls under 44x44 px. */
const AUDIT = `(() => {
  const doc = document.documentElement;
  const small = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=tab], [role=radio], summary')].filter((e) => {
    const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || e.closest('.sr-only')) return false;
    if (e.matches('input[type=checkbox]')) return false; // inside a 44 px label row
    return r.width < 43.5 || r.height < 43.5;
  }).map((e) => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 40) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height));
  return { overflow: doc.scrollWidth - doc.clientWidth, small, text: document.body.innerText.length };
})()`;

const failures = [];
const check = (name, a) => {
  if (a.overflow > 0) failures.push(`${name}: horizontal scroll ${a.overflow}px`);
  if (a.small.length) failures.push(`${name}: small targets ${a.small.join(', ')}`);
  if (a.text < 20) failures.push(`${name}: nothing rendered`);
  console.log(`${name}: overflow ${a.overflow}px, small ${a.small.length}`);
};

const sleepShot = async (b, name, opts) => {
  await sleep(350);
  return b.shot(name, opts);
};

try {
  for (const [label, width, height, dark] of [
    ['390', 390, 776, false],
    ['390-dark', 390, 776, true],
    ['1280', 1280, 800, false],
    ['1280-dark', 1280, 800, true],
  ]) {
    const mobile = width < 600;
    const b = await Browser.launch({ width, height, dark, mobile });
    try {
      await b.setViewport(width, height, mobile);
      await b.media({ dark });
      await b.send('Runtime.enable');
      const errors = [];
      b.ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      });
      await b.goto(embed, 2500);
      await b.eval(`localStorage.setItem('pilot-reporter:token:KONF:${HOST}', JSON.stringify({ token: '${token}', expiresAt: new Date(Date.now() + 36e5).toISOString(), actorLabel: 'Owner', bucketKey: 'KONF' }))`);
      await b.goto(embed, 2500);
      try {
        await b.waitFor(`document.body.innerText.includes('KONF-12')`, 10000, 'the ticket list');
      } catch (e) {
        await b.shot(`reporter-${label}-stuck`);
        console.error(`${label}: stuck on`, JSON.stringify(await b.eval('document.body.innerText.slice(0, 300)')), errors.join(' | '));
        throw e;
      }
      await sleep(600);
      check(`${label} list`, await b.eval(AUDIT));
      const rows = await b.eval(`[...document.querySelectorAll('[data-row]')].map((r) => r.dataset.row).join(',')`);
      if (!/thumb/.test(rows) || !/text/.test(rows)) failures.push(`${label} list: expected thumbnail and text rows, got ${rows}`);
      if (await b.eval(`[...document.querySelectorAll('[data-row=text] [role=img], [data-row=text] img, [data-row=text] .skeleton')].length`)) failures.push(`${label} list: a text row has a placeholder`);
      await sleepShot(b, `reporter-${label}-list`);

      await b.clickSel('[aria-label^=Sort]');
      await sleepShot(b, `reporter-${label}-sort`);
      check(`${label} sort`, await b.eval(AUDIT));
      await b.key('Escape');
      await b.clickSel('[aria-label^=Filter]');
      await sleep(300);
      check(`${label} filter`, await b.eval(AUDIT));
      await sleepShot(b, `reporter-${label}-filter`);
      await b.clickText('Close filters', { selector: 'button[aria-label="Close filters"]:not([tabindex="-1"])' }).catch(() => b.key('Escape'));
      await sleep(300);

      await b.clickText('Hero button text');
      await b.waitFor(`document.body.innerText.includes('Thread')`, 8000, 'the ticket card');
      await sleep(500);
      if (await b.eval(`!!document.querySelector('[role=tablist]')`)) failures.push(`${label} card: the tabs should hide in a detail view`);
      check(`${label} card`, await b.eval(AUDIT));
      await sleepShot(b, `reporter-${label}-card`);
      await b.eval(`document.querySelector('#panel-main [class*=overflow-y-auto]')?.scrollTo(0, 99999)`);
      await sleepShot(b, `reporter-${label}-thread`);
      await b.eval(`document.querySelector('#panel-main [class*=overflow-y-auto]')?.scrollTo(0, 0)`);
      await sleep(200);
      await b.clickSel('[aria-label="View shot 1"]');
      await b.waitFor(`!!document.querySelector('[role=dialog] img')`, 6000, 'the viewer');
      await sleepShot(b, `reporter-${label}-viewer`);
      await b.key('Escape');
      await sleep(300);
      if (await b.eval(`!!document.querySelector('[role=dialog]')`)) failures.push(`${label} viewer: Esc did not close it`);
      await b.clickSel('[aria-label=Back]');
      await sleep(400);

      await b.clickSel('[role=tab][aria-label=Sessions]');
      await sleep(500);
      check(`${label} sessions`, await b.eval(AUDIT));
      await sleepShot(b, `reporter-${label}-sessions`);
      await b.clickText('Konfersi lead');
      await b.waitFor(`document.body.innerText.includes('fixed')`, 8000, 'the chat');
      await sleep(500);
      check(`${label} chat`, await b.eval(AUDIT));
      const chatText = await b.eval('document.body.innerText');
      if (!/Answer in pilot/.test(chatText)) failures.push(`${label} chat: no approval banner`);
      if (/mo-T-2430/.test(chatText)) failures.push(`${label} chat: the internal prefix shows`);
      await sleepShot(b, `reporter-${label}-chat`);
      await b.focusSel('textarea[aria-label=Message]');
      await b.type('Thanks, and the icon too?');
      await sleepShot(b, `reporter-${label}-chat-typed`);
      await b.clickSel('[aria-label=Back]');
      await sleep(300);

      await b.clickSel('[aria-label=Context]');
      await sleep(400);
      check(`${label} context`, await b.eval(AUDIT));
      await sleepShot(b, `reporter-${label}-context`);
      await b.clickSel('[role=dialog] [aria-label=Back]');
      await sleep(300);

      await b.clickSel('[role=tab][aria-label=Report]');
      await sleep(400);
      check(`${label} report`, await b.eval(AUDIT));
      await sleepShot(b, `reporter-${label}-report`);

      await b.clickSel('[role=tab][aria-label=Settings]');
      await sleep(300);
      check(`${label} settings`, await b.eval(AUDIT));
      await sleepShot(b, `reporter-${label}-settings`);
      if (errors.length) failures.push(`${label}: page errors ${errors.join(' | ')}`);
    } finally {
      await b.close();
    }
  }

  // Framed by the stand-in host: ready, settings and callouts reach the host; a capture comes back as the report form; Ask lead now sends
  // and lands in the chat; Queue files and shows the Filed row.
  for (const [label, dark] of [
    ['390', false],
    ['390-dark', true],
  ]) {
    const b = await Browser.launch({ width: 390, height: 844, mobile: true, dark });
    try {
      await b.setViewport(390, 844, true);
      await b.media({ dark });
      const frame = `document.getElementById('panel').contentDocument`;
      const inFrame = (sel) => `${frame}.querySelector(${JSON.stringify(sel)})`;
      const clickIn = (sel) => b.eval(`${inFrame(sel)}.click()`);
      const clickTextIn = (re) => b.eval(`[...${frame}.querySelectorAll('button')].find((x) => ${re}.test(x.textContent)).click()`);
      await b.goto(`${base}/__qa-host`, 2500);
      await b.eval(`${frame}.defaultView.localStorage.setItem('pilot-reporter:token:KONF:' + location.origin, JSON.stringify({ token: '${token}', expiresAt: new Date(Date.now() + 36e5).toISOString(), actorLabel: 'Owner', bucketKey: 'KONF' }))`);
      await b.goto(`${base}/__qa-host`, 3000);
      await b.waitFor(`window.got.includes('pilot-reporter:callouts') && window.got.includes('pilot-reporter:settings')`, 10000, 'ready, settings and callouts from the panel');
      await clickIn('[role=tab][aria-label=Report]');
      await sleep(400);
      await clickTextIn('/^Screen$/');
      await b.waitFor(`${frame}.body.innerText.includes('File ticket') && ${frame}.body.innerText.includes('Looks like KONF-12')`, 10000, 'the report form with the capture and a duplicate');
      await sleep(500);
      check(`framed ${label} report form`, await b.eval(AUDIT.replaceAll('document.', `${frame}.`)));
      const text = await b.eval(`${frame}.body.innerText`);
      if (!/1 serious/.test(text)) failures.push('framed report form: the UI check chip is missing');
      await sleepShot(b, `reporter-${label}-framed-report`);

      await clickIn('[aria-label="View shot 1"]');
      await sleep(600);
      await sleepShot(b, `reporter-${label}-framed-viewer`);
      // A key reaches the focused element (here the body), so the viewer's capture listener takes Esc before the panel's close.
      await b.eval(`${frame}.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
      await sleep(200);
      if (await b.eval(`window.got.includes('pilot-reporter:close')`)) failures.push(`framed ${label}: Esc in the viewer closed the panel`);
      await sleep(300);

      await clickIn('[role=radio][aria-checked=false]');
      await sleep(300);
      const ask = await b.eval(`${frame}.body.innerText`);
      if (!/Send to Konfersi lead/.test(ask) || !/A ticket is created for tracking/.test(ask)) failures.push(`framed ${label}: Ask lead now did not change the button and note`);
      await clickTextIn('/^Send to/');
      await sleep(300);
      if (!/Write your question/.test(await b.eval(`${frame}.body.innerText`))) failures.push(`framed ${label}: the question was not required`);
      await b.eval(`(() => { const t = ${inFrame('textarea[aria-label="Your question"]')}; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Is this only on iOS Safari?'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(200);
      check(`framed ${label} ask`, await b.eval(AUDIT.replaceAll('document.', `${frame}.`)));
      await sleepShot(b, `reporter-${label}-framed-ask`);
      if (!(await b.eval(`window.got.includes('pilot-reporter:target')`))) failures.push(`framed ${label}: the toolbar was not told the destination`);
      await clickTextIn('/^Send to/');
      await b.waitFor(`${frame}.body.innerText.includes('KONF-15') && !!${inFrame('textarea[aria-label=Message]')}`, 10000, 'the direct ask landing in the chat');
      await sleep(600);
      await sleepShot(b, `reporter-${label}-framed-ask-chat`);

      // Back to Queue, then file a ticket: the Filed row.
      await clickIn('[aria-label=Back]');
      await clickIn('[role=tab][aria-label=Report]');
      await sleep(300);
      await clickTextIn('/^Screen$/');
      await b.waitFor(`${frame}.body.innerText.includes('Ask lead now')`, 10000, 'the report form again');
      await sleep(300);
      await b.eval(`[...${frame}.querySelectorAll('[role=radio]')].find((x) => x.textContent === 'Queue').click()`);
      await sleep(200);
      await clickTextIn('/^File ticket$/');
      await b.waitFor(`${frame}.body.innerText.includes('Filed KONF-15')`, 10000, 'the Filed row');
      await sleepShot(b, `reporter-${label}-framed-filed`);
      console.log('host got', await b.eval(`window.got.join(',')`));
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
console.log('PASS reporter panel');
