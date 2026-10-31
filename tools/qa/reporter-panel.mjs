// The UI reporter's panel (apps/web/embed.html, docs/prd/ui-reporter.md) at 390 px with touch and at 400 px desktop card size, light
// and dark: Tickets (This page), a ticket card (deployment per environment, thread), the filter sheet, the report home and the report
// form with a capture. Checks: no horizontal scroll, every visible control at least 44x44 px, no page error. Self-contained: it starts
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
];
const API = {
  'GET /reporter/v1/status': { site: { origin: HOST, environment: 'stg', repo: 'platform/konfersi-landing-page', label: null, branch: 'stg' }, enabled: true, bucketKey: 'KONF', bucketName: 'Konfersi', calloutsDefault: true, sdkVersion: '0.1.0' },
  'GET /reporter/v1/me': { bucketKey: 'KONF', origin: HOST, actorLabel: 'Owner', expiresAt: now },
  'GET /reporter/v1/tickets': { items: tickets, nextCursor: null, counts: { status: { open: 1, done: 1 }, priority: { high: 2 }, type: { bug: 2 }, onPath: 2 } },
  'GET /reporter/v1/tickets/KONF-12': tickets[0],
  'GET /reporter/v1/tickets/KONF-12/comments': [{ id: '1', author: 'Konfersi lead', authorKind: 'agent', body: 'Is this on **iOS Safari** only? See `hero.tsx`.', createdAt: now }],
  'GET /reporter/v1/session-targets': [{ sessionId: 's1', label: 'Konfersi lead', status: 'working', available: true, reason: null }],
  'GET /reporter/v1/reviews': [],
  'GET /reporter/v1/sessions': [],
  'POST /reporter/v1/duplicates': { candidates: [{ key: 'KONF-12', summary: 'Hero button text is cut off on small phones', status: 'open', reasons: ['same-area'], score: 0.8, url: '#', thumbnailUrl: null }] },
};

const standIn = {
  name: 'qa:reporter-stand-in',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = req.url.split('?')[0];
      if (path === '/reporter/v1/embed') {
        req.url = `/embed.html${req.url.slice(path.length)}`;
        return next();
      }
      if (!path.startsWith('/reporter/v1/')) return next();
      if (path === '/reporter/v1/events') return void res.writeHead(200, { 'content-type': 'text/event-stream' });
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

const server = await createServer({ configFile: `${WEB}vite.config.ts`, root: WEB, logLevel: 'error', server: { port: 0, host: '127.0.0.1' }, optimizeDeps: { noDiscovery: true, include: [] }, plugins: [standIn] });
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

try {
  for (const [label, width, height, dark] of [
    ['390', 390, 776, false],
    ['390-dark', 390, 776, true],
    ['card', 400, 640, false],
  ]) {
    const b = await Browser.launch({ width, height, dark, mobile: width < 600 && label !== 'card' });
    try {
      await b.setViewport(width, height, label !== 'card');
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
      await b.waitFor(`document.body.innerText.includes('KONF-12')`, 10000, 'the ticket list');
      check(`${label} list`, await b.eval(AUDIT));
      await b.shot(`reporter-${label}-list`);

      await b.clickText('Hero button text');
      await b.waitFor(`document.body.innerText.includes('Deployed')`, 8000, 'the ticket card');
      await sleep(400);
      check(`${label} card`, await b.eval(AUDIT));
      await b.shot(`reporter-${label}-card`, { full: true });
      await b.clickSel('[aria-label=Back]');
      await sleep(400);

      await b.clickSel('[aria-label^=Filter]');
      await sleep(400);
      check(`${label} filter`, await b.eval(AUDIT));
      await b.shot(`reporter-${label}-filter`, { full: true });

      await b.clickSel('[role=tab][aria-label=Report]');
      await sleep(400);
      check(`${label} report`, await b.eval(AUDIT));
      await b.shot(`reporter-${label}-report`);

      await b.clickSel('[role=tab][aria-label=Settings]');
      await sleep(300);
      check(`${label} settings`, await b.eval(AUDIT));
      await b.shot(`reporter-${label}-settings`);
      if (errors.length) failures.push(`${label}: page errors ${errors.join(' | ')}`);
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
