// UI reporter connect, end to end in a real browser (PILOT-1111): the SDK on a host page of ANOTHER origin frames the panel; Connect opens
// the popup; the person approves; the panel is connected. Four ways in:
//   first   signed in, first attempt
//   stale   a popup of an earlier attempt left open, the host page reloaded, Connect again
//   reload  the panel iframe reloaded while its popup is open, Connect again from the new panel
//   signin  signed out: "Sign in first" in the popup, the portal's /login (Cross-Origin-Opener-Policy: same-origin cuts the popup off
//           from the panel, window.opener is null for good), back to the connect page, Approve: the panel claims the held approval
// Then one real report (Full capture -> File ticket) so the SDK's own evidence goes through the server's validator (no 422).
//
// Runs with playwright-core (the devcontainer lacks Chromium's libraries: run it in mcr.microsoft.com/playwright:v1.56.1-noble):
//   PORTAL=http://<portal host>:<port> CODE=<server code> node tools/qa/reporter-connect.mjs [browser=chromium|webkit] [shots dir]
// The portal must allow the site http://127.0.0.1:4700 (HOST_ORIGIN; another SITE than the portal's localhost, as in production) for bucket KONF (PUT /api/reporter/buckets/KONF/config); this script serves that
// host page itself. A plain-http portal that is not localhost is not a secure context, so Chromium is told to treat it as one (WebCrypto).
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import * as pw from 'playwright-core';

const PORTAL = process.env.PORTAL ?? 'http://localhost:3403';
const CODE = process.env.CODE ?? '24681372';
const ENGINE = process.argv[2] ?? 'chromium';
const SHOTS = process.argv[3] ?? null;
const HOST = process.env.HOST_ORIGIN ?? 'http://127.0.0.1:4700';
const BUCKET = 'KONF';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Host</title>
<style>body{margin:0;font:16px system-ui;background:#0f172a;color:#fff}main{padding:24px}h1{margin:120px 0 24px}</style></head>
<body><main><h1 id="hero">Fixture host</h1><p>A page on another origin.</p></main>
<script src="${PORTAL}/reporter/v1/reporter.js" data-portal="${PORTAL}" data-bucket="${BUCKET}" data-repo="platform/konfersi-landing-page" data-version="1.0.0" data-commit="abc1234def" data-branch="stg" data-env="stg" async></script>
</body></html>`;
const server = http.createServer((_q, s) => s.writeHead(200, { 'content-type': 'text/html' }).end(page)).listen(4700);

const engine = pw[ENGINE];
const args = ENGINE === 'chromium' ? [`--unsafely-treat-insecure-origin-as-secure=${PORTAL}`, '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests'] : [];
const browser = await engine.launch({ args });
const results = [];
let failed = false;
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  console.log(results.at(-1));
  if (!ok) failed = true;
};

async function newContext({ signedIn, phone = false, theme = 'light' }) {
  const ctx = await browser.newContext({
    colorScheme: theme,
    ...(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: ENGINE === 'chromium', hasTouch: true } : { viewport: { width: 1280, height: 800 } }),
  });
  if (signedIn) {
    const r = await ctx.request.post(`${PORTAL}/api/login`, { headers: { origin: PORTAL, 'content-type': 'application/json' }, data: { code: CODE } });
    if (!r.ok()) throw new Error(`login ${r.status()}`);
  }
  const p = await ctx.newPage();
  const errors = [];
  p.on('response', async (r) => {
    if (r.status() >= 400 && r.url().startsWith(PORTAL)) errors.push(`${r.status()} ${r.url().replace(PORTAL, '')} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  });
  ctx.on('page', (pp) => pp.on('response', async (r) => {
    if (r.status() >= 400 && r.url().startsWith(PORTAL)) errors.push(`${r.status()} ${r.url().replace(PORTAL, '')}`);
  }));
  await p.goto(HOST, { waitUntil: 'load' });
  return { ctx, p, errors };
}

const frame = (p) => p.frames().find((f) => f.url().includes('/reporter/v1/embed'));
async function openPanel(p) {
  // The SDK's button lives in a shadow root; Playwright's locators pierce it.
  await p.getByRole('button', { name: 'Report a UI issue' }).first().click({ timeout: 20000 });
  for (let i = 0; i < 40 && !frame(p); i++) await p.waitForTimeout(250);
  const f = frame(p);
  await f.getByRole('button', { name: 'Connect' }).or(f.getByRole('tablist')).first().waitFor({ timeout: 15000 });
  return f;
}
async function clickConnect(ctx, f) {
  const [pop] = await Promise.all([ctx.waitForEvent('page'), f.getByRole('button', { name: 'Connect' }).click()]);
  await pop.waitForLoadState('load');
  return pop;
}
async function connected(p, ms = 12000) {
  try {
    await frame(p).getByRole('tablist', { name: 'Sections' }).waitFor({ timeout: ms });
    return true;
  } catch {
    return false;
  }
}
const shot = async (p, name) => SHOTS && p.screenshot({ path: `${SHOTS}/${name}.png` });

// first
{
  const { ctx, p, errors } = await newContext({ signedIn: true });
  const f = await openPanel(p);
  const pop = await clickConnect(ctx, f);
  check('first: popup has the pilot mark and Approve', (await pop.locator('svg.mark').count()) === 1 && (await pop.getByRole('button', { name: 'Approve' }).count()) === 1);
  check('first: popup opener is alive', await pop.evaluate(() => !!window.opener));
  await pop.getByRole('button', { name: 'Approve' }).click();
  check('first: connected', await connected(p), errors.join(' | '));
  await ctx.close();
}

// stale
{
  const { ctx, p, errors } = await newContext({ signedIn: true });
  let f = await openPanel(p);
  const old = await clickConnect(ctx, f);
  await p.reload({ waitUntil: 'load' });
  f = await openPanel(p);
  const pop = await clickConnect(ctx, f);
  check('stale: a new window, not the old one navigated', pop !== old && !old.isClosed(), `pages=${ctx.pages().length}`);
  await pop.getByRole('button', { name: 'Approve' }).click();
  check('stale: connected', await connected(p), errors.join(' | '));
  await ctx.close();
}

// reload
{
  const { ctx, p, errors } = await newContext({ signedIn: true });
  let f = await openPanel(p);
  await clickConnect(ctx, f);
  await f.evaluate(() => location.reload());
  await p.waitForTimeout(1500);
  f = frame(p);
  await f.getByRole('button', { name: 'Connect' }).waitFor({ timeout: 15000 });
  const pop = await clickConnect(ctx, f);
  await pop.getByRole('button', { name: 'Approve' }).click();
  check('reload: connected', await connected(p), errors.join(' | '));
  await ctx.close();
}

// signin (the owner's case)
{
  const { ctx, p, errors } = await newContext({ signedIn: false });
  const f = await openPanel(p);
  const pop = await clickConnect(ctx, f);
  check('signin: the popup asks to sign in first', (await pop.getByRole('heading', { name: 'Sign in first' }).count()) === 1);
  await pop.getByRole('link', { name: 'Sign in' }).click();
  await pop.waitForURL(/\/login/);
  const coop = await pop.evaluate(async () => (await fetch(location.href, { method: 'HEAD' })).headers.get('cross-origin-opener-policy'));
  await pop.locator('input').first().click();
  await pop.keyboard.type(CODE, { delay: 30 });
  await pop.waitForURL(/\/reporter\/v1\/connect/, { timeout: 20000 });
  await pop.waitForLoadState('load');
  const opener = await pop.evaluate(() => (window.opener ? 'alive' : 'null'));
  results.push(`INFO signin: /login sends Cross-Origin-Opener-Policy: ${coop}; back on /reporter/v1/connect window.opener is ${opener}`);
  await shot(pop, `signin-popup-${ENGINE}`);
  await pop.getByRole('button', { name: 'Approve' }).click();
  await pop.waitForTimeout(500);
  const msg = await pop.locator('#msg').innerText().catch(() => '(popup closed)');
  check('signin: no dead end in the popup', !/window is gone/.test(msg), msg);
  check('signin: connected through the held approval', await connected(p, 15000), errors.join(' | '));

  // One real report: the SDK's own evidence through the server's validator.
  const fr = frame(p);
  await fr.getByRole('tab', { name: 'Report' }).click();
  const full = fr.getByRole('button', { name: /^(Full|Screen|Page|Whole page|Full page)$/i }).first();
  if (await full.count()) {
    await full.click();
    await fr.getByRole('button', { name: 'File ticket' }).waitFor({ timeout: 60000 });
    const summary = fr.getByPlaceholder(/What is wrong/i);
    if (await summary.count()) await summary.fill('[connect e2e] evidence goes through');
    const uploads = [];
    p.on('response', (r) => /attachments/.test(r.url()) && uploads.push(r.status()));
    await fr.getByRole('button', { name: 'File ticket' }).click();
    await p.waitForTimeout(6000);
    check('report: evidence and screenshot uploads accepted', uploads.length > 0 && uploads.every((s) => s < 300), `statuses=${uploads.join(',')} ${errors.filter((e) => /attachments/.test(e)).join(' | ')}`);
  } else {
    results.push(`SKIP report: no full-capture button (${(await fr.getByRole('button').allInnerTexts()).join(', ').slice(0, 200)})`);
  }
  await ctx.close();
}

// Screenshots (with a shots dir): the Connect screen and the connected sheet / card header, phone 390 and desktop 1280, light and dark.
// The panel draws no close of its own: one "Close" on the whole page (the SDK's desktop card); none in the panel frame.
for (const phone of SHOTS ? [true, false] : []) {
  for (const theme of ['light', 'dark']) {
    const tag = `${phone ? 'phone' : 'desktop'}-${theme}`;
    const { ctx, p } = await newContext({ signedIn: true, phone, theme });
    const f = await openPanel(p);
    await p.waitForTimeout(600);
    await shot(p, `connect-${tag}`);
    check(`${tag}: the panel frame has no close button`, (await f.getByRole('button', { name: 'Close' }).count()) === 0);
    const pop = await clickConnect(ctx, f);
    await shot(pop, `popup-${tag}`);
    await pop.getByRole('button', { name: 'Approve' }).click();
    await connected(p);
    await p.waitForTimeout(800);
    await shot(p, `connected-${tag}`);
    await frame(p).locator('body').press('Escape');
    await p.waitForTimeout(800);
    check(`${tag}: Esc in the panel closes it`, (await p.getByRole('button', { name: 'Report a UI issue' }).first().getAttribute('aria-expanded')) === 'false');
    await ctx.close();
  }
}

await browser.close();
server.close();
console.log(results.join('\n'));
process.exit(failed ? 1 : 0);
