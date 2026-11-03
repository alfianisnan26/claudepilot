// The reporter panel's WebMCP tools (PILOT-1128, docs/prd/ui-reporter-webmcp.md) in a real Chromium with WebMCP on, against a real portal
// (a throwaway one: scripts/scratch-portal.sh), on a test bucket made here (WMCP, one site: this script's host page). As an agent sees them:
// the DevTools protocol's WebMCP domain (toolsAdded, invokeTool, toolResponded), which reaches tools in every frame.
//   A  sdk         the real SDK (/reporter/v1/reporter.js) frames the panel cross-origin, as today (allow="clipboard-write" only)
//   B  allow-tools a stand-in host frames the panel cross-origin with allow="tools" (what the SDK needs): register, context, my reports,
//                  the Allow sheet (screenshot), Deny sends nothing, Allow files a report; the ticket is closed afterwards
//   C  top-level   the panel opened as the page itself (same origin as its own document): register, context
//   D  no WebMCP   Chromium without the feature: no model context, the Report form files a ticket as before (closed afterwards)
// Runs where Chromium is (the workspace image: /usr/bin/chromium), with playwright-core:
//   PORTAL=http://localhost:3403 CODE=<sign-in code> QA_SHOTS=<dir> node tools/qa/reporter-webmcp.mjs     exit 1 on a failed check
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import * as pw from 'playwright-core';

const PORTAL = process.env.PORTAL ?? 'http://localhost:3403';
const CODE = process.env.CODE ?? '24681372';
const SHOTS = process.env.QA_SHOTS ?? '/tmp/qa-shots';
const CHROME = process.env.CHROME ?? '/usr/bin/chromium';
const HOST = 'http://127.0.0.1:4700';
const BUCKET = 'WMCP';
// Chromium's runtime feature for imperative WebMCP is "WebMCP" (third_party/blink/renderer/platform/runtime_enabled_features.json5).
const WEBMCP_ARGS = ['--enable-features=WebMCP', '--enable-blink-features=WebMCP'];
const NET_ARGS = [
  '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests',
];
mkdirSync(SHOTS, { recursive: true });

const results = [];
let failed = false;
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`);
  console.log(results.at(-1));
  if (!ok) failed = true;
};
const info = (line) => {
  results.push(`INFO ${line}`);
  console.log(results.at(-1));
};

/* ---------- host pages ---------- */

const sdkPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Host</title></head><body><h1>Fixture host (SDK)</h1>
<script src="${PORTAL}/reporter/v1/reporter.js" data-portal="${PORTAL}" data-bucket="${BUCKET}" data-repo="qa/webmcp-fixture" data-version="1.0.0" data-commit="abc1234def" data-branch="main" data-env="dev" async></script>
</body></html>`;

// The SDK's bridge, by hand, with the iframe allowed to use WebMCP. Screenshots are a canvas; evidence names this page (the server checks it).
const standinPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Host</title></head><body style="margin:0">
<h1 id="hero" style="margin:16px">Fixture host (allow=tools)</h1>
<iframe id="panel" allow="clipboard-write; tools" style="position:fixed;right:0;bottom:0;width:420px;height:680px;border:0"></iframe>
<script>
const f = document.getElementById('panel');
f.src = '${PORTAL}/reporter/v1/embed?bucket=${BUCKET}&origin=' + encodeURIComponent(location.origin);
const build = { version: '1.0.0', commit: 'abc1234def', branch: 'main', environment: 'dev', builtAt: null, repo: 'qa/webmcp-fixture' };
const evidence = (mode) => ({ schema: 1, sdkVersion: '0.1.0', capturedAt: new Date().toISOString(),
  page: { url: location.origin + '/standin', origin: location.origin, host: location.host, path: '/standin', search: '', hash: '', title: 'Host', referrer: '', lang: 'en', route: null, historyLength: 1 },
  device: { userAgent: navigator.userAgent, browser: { name: null, version: null }, os: { name: null, version: null }, mobile: false, touch: false, screen: { w: 1280, h: 800, dpr: 1, orientation: null }, viewport: { w: 1280, h: 800 }, hardwareConcurrency: null, deviceMemoryGb: null, connection: { effectiveType: null, downlinkMbps: null, rttMs: null, saveData: null }, timezone: null, locale: null },
  state: { scroll: { x: 0, y: 0, maxY: 0 }, visibility: 'visible', online: true, colorScheme: 'light', reducedMotion: false, focused: null, storageKeys: { local: [], session: [], cookies: [] }, app: null },
  build, anchor: { path: '/standin', selector: '#hero', relative: null, rect: { x: 0, y: 0, w: 1280, h: 800 }, viewport: { w: 1280, h: 800, dpr: 1 }, mode },
  dom: null, components: [], framework: null, console: [], network: [],
  performance: { navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null, type: null }, vitals: { lcpMs: null, cls: null, inpMs: null, fcpMs: null }, longTasks: { count: 0, totalMs: 0 }, memory: { usedJsHeapBytes: null, totalJsHeapBytes: null } },
  interactions: [], checks: { ran: true, findings: [] }, errorSignatures: [] });
addEventListener('message', async (e) => {
  if (e.source !== f.contentWindow || e.origin !== '${PORTAL}') return;
  const m = e.data;
  if (m.type === 'pilot-reporter:ready') f.contentWindow.postMessage({ type: 'pilot-reporter:hello', bridge: 1, sdkVersion: '0.1.0', page: { url: location.origin + '/standin', title: 'Host' }, build }, '${PORTAL}');
  if (m.type === 'pilot-reporter:capture-request') {
    window.captures = (window.captures || 0) + 1;
    const c = document.createElement('canvas'); c.width = 640; c.height = 400; const g = c.getContext('2d');
    g.fillStyle = '#eef1f6'; g.fillRect(0, 0, 640, 400); g.fillStyle = '#c33'; g.fillRect(40, 120, 300, 80);
    const buf = await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer();
    f.contentWindow.postMessage({ type: 'pilot-reporter:capture-result', requestId: m.requestId, screenshot: buf, mediaType: 'image/png', evidence: evidence(m.mode) }, '${PORTAL}', [buf]);
  }
});
</script></body></html>`;

const server = http
  .createServer((q, s) => s.writeHead(200, { 'content-type': 'text/html' }).end(q.url.startsWith('/standin') ? standinPage : sdkPage))
  .listen(4700, '127.0.0.1');

/* ---------- the portal: sign in, the test bucket and its site ---------- */

const api = await pw.request.newContext({ baseURL: PORTAL, extraHTTPHeaders: { origin: PORTAL } });
{
  const r = await api.post('/api/login', { data: { code: CODE } });
  if (!r.ok()) throw new Error(`login ${r.status()}`);
  const b = await api.post('/api/tickets/buckets', { data: { key: BUCKET, name: 'WebMCP QA' } });
  info(`bucket ${BUCKET}: ${b.status()}`);
  const c = await api.put(`/api/reporter/buckets/${BUCKET}/config`, {
    data: {
      enabled: true,
      sites: [{ origin: HOST, environment: 'dev', repo: 'qa/webmcp-fixture', label: 'QA', branch: null }],
      sessionTargets: [],
      calloutsDefault: true,
    },
  });
  check('setup: test bucket WMCP has the reporter on for the fixture host', c.ok(), `${c.status()} ${(await c.text()).slice(0, 200)}`);
}

/** The portal's own ticket (owner API) by its key, and closing it. */
async function portalTicket(key) {
  const r = await api.get(`/api/tickets/${encodeURIComponent(key)}`);
  // GET /api/tickets/:id answers TicketDetail ({ ticket, events, ... }).
  if (r.ok()) {
    const d = (await r.json()).data ?? null;
    return d?.ticket ? { ...d.ticket, events: d.events ?? [] } : null;
  }
  return null;
}
async function closeTicket(key) {
  const r = await api.post(`/api/tickets/${encodeURIComponent(key)}/close`, {
    data: { outcome: 'wont_do', summary: 'QA test ticket (WebMCP check), closed by the test.' },
  });
  const t = await portalTicket(key);
  check(`cleanup: ${key} closed`, r.ok() && t?.status === 'wont_do', `${r.status()} status=${t?.status}`);
}

/* ---------- browser helpers ---------- */

async function launch(webmcp) {
  return pw.chromium.launch({ executablePath: CHROME, args: [...(webmcp ? WEBMCP_ARGS : []), ...NET_ARGS] });
}
const panelFrame = (p) => p.frames().find((f) => f.url().includes('/reporter/v1/embed'));

async function signedInPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const r = await ctx.request.post(`${PORTAL}/api/login`, {
    headers: { origin: PORTAL, 'content-type': 'application/json' },
    data: { code: CODE },
  });
  if (!r.ok()) throw new Error(`login ${r.status()}`);
  const p = await ctx.newPage();
  const sent = [];
  p.on(
    'request',
    (q) => q.url().startsWith(PORTAL) && q.method() !== 'GET' && sent.push(`${q.method()} ${q.url().replace(PORTAL, '').split('?')[0]}`),
  );
  p.on('pageerror', (e) => info(`pageerror ${e.message}`));
  return { ctx, p, sent };
}

/** Connect in the panel frame: the popup, Approve, the tabs show. */
async function connect(ctx, f) {
  await f.getByRole('button', { name: 'Connect' }).waitFor({ timeout: 20000 });
  const [pop] = await Promise.all([ctx.waitForEvent('page'), f.getByRole('button', { name: 'Connect' }).click()]);
  await pop.waitForLoadState('load');
  await pop.getByRole('button', { name: 'Approve' }).click();
  await f.getByRole('tablist', { name: 'Sections' }).waitFor({ timeout: 20000 });
}

/** The agent's view: CDP WebMCP on the page's session and (an out-of-process iframe has its own) on the panel frame's. */
async function agent(ctx, p, f) {
  const tools = [];
  const responses = new Map();
  const sessions = [];
  const attach = async (target, label) => {
    let s;
    try {
      s = await ctx.newCDPSession(target);
    } catch (e) {
      info(`cdp ${label}: no session (${e.message.split('\n')[0]})`);
      return;
    }
    s.on('WebMCP.toolsAdded', (e) => tools.push(...e.tools.map((t) => ({ ...t, session: s, label }))));
    s.on('WebMCP.toolResponded', (e) => responses.set(e.invocationId, e));
    try {
      await s.send('WebMCP.enable');
      sessions.push(s);
    } catch (e) {
      info(`cdp ${label}: WebMCP.enable failed (${e.message.split('\n')[0]})`);
    }
  };
  await attach(p, 'page');
  if (f) await attach(f, 'panel frame');
  const invoke = async (name, input = {}, wait = 30000) => {
    const t = [...tools].reverse().find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    const { invocationId } = await t.session.send('WebMCP.invokeTool', { frameId: t.frameId, toolName: name, input });
    for (let i = 0; i < wait / 100 && !responses.has(invocationId); i++) await p.waitForTimeout(100);
    const r = responses.get(invocationId);
    if (!r) throw new Error(`${name}: no response`);
    let out = r.output;
    if (typeof out === 'string')
      try {
        out = JSON.parse(out);
      } catch {
        // as given
      }
    return { status: r.status, out, errorText: r.errorText };
  };
  return { tools, invoke, ok: sessions.length > 0 };
}
const names = (tools) => [...new Set(tools.map((t) => t.name))].sort();
const inPage = (f) =>
  f.evaluate(async () => {
    const mc = document.modelContext;
    const policy = document.permissionsPolicy ?? document.featurePolicy;
    const allowed = policy?.allowsFeature ? policy.allowsFeature('tools') : 'unknown';
    if (!mc) return { modelContext: false, allowed };
    let tools = 'no getTools';
    if (typeof mc.getTools === 'function')
      try {
        tools = (await mc.getTools()).map((t) => t.name).sort();
      } catch (e) {
        tools = `getTools threw ${e.name}`;
      }
    return { modelContext: true, allowed, tools };
  });

const EXPECTED = [
  'reporter_attach_screenshots',
  'reporter_capture_screenshot',
  'reporter_comment_on_report',
  'reporter_create_report',
  'reporter_get_context',
  'reporter_list_my_reports',
];

/* ---------- A: the real SDK, cross-origin, no allow="tools" ---------- */
{
  const browser = await launch(true);
  const { ctx, p } = await signedInPage(browser);
  await p.goto(`${HOST}/sdk`, { waitUntil: 'load' });
  await p.getByRole('button', { name: 'Report a UI issue' }).first().click({ timeout: 20000 });
  for (let i = 0; i < 40 && !panelFrame(p); i++) await p.waitForTimeout(250);
  const f = panelFrame(p);
  await connect(ctx, f);
  const a = await agent(ctx, p, f);
  await p.waitForTimeout(1500);
  const seen = await inPage(f);
  info(`A sdk: in the panel frame ${JSON.stringify(seen)}; the agent (CDP) sees ${JSON.stringify(names(a.tools))}`);
  check('A sdk: the browser has document.modelContext in the panel frame (WebMCP on)', seen.modelContext === true, JSON.stringify(seen));
  check(
    'A sdk: without allow="tools" the frame may not use WebMCP, so no tool is registered (the SDK change is needed)',
    seen.allowed === false && !names(a.tools).length,
    JSON.stringify(seen),
  );
  await browser.close();
}

/* ---------- B: cross-origin with allow="tools" ---------- */
{
  const browser = await launch(true);
  const { ctx, p, sent } = await signedInPage(browser);
  await p.goto(`${HOST}/standin`, { waitUntil: 'load' });
  for (let i = 0; i < 40 && !panelFrame(p); i++) await p.waitForTimeout(250);
  const f = panelFrame(p);
  const a = await agent(ctx, p, f);
  await f.getByRole('button', { name: 'Connect' }).waitFor({ timeout: 20000 });
  check(
    'B signed out: only reporter_get_context is offered',
    JSON.stringify(names(a.tools)) === JSON.stringify(['reporter_get_context']),
    JSON.stringify(names(a.tools)),
  );
  await connect(ctx, f);
  for (let i = 0; i < 50 && names(a.tools).length < 6; i++) await p.waitForTimeout(100);
  check(
    'B: the agent (CDP WebMCP) sees all six tools in the panel frame',
    EXPECTED.every((n) => names(a.tools).includes(n)),
    `${JSON.stringify(names(a.tools))} via ${[...new Set(a.tools.map((t) => t.label))]}`,
  );
  info(`B in the panel frame: ${JSON.stringify(await inPage(f))}`);
  const tool = a.tools.find((t) => t.name === 'reporter_create_report');
  check(
    'B: annotations reach the agent (create is consequential, list is read-only)',
    !!tool?.annotations?.consequential && !!a.tools.find((t) => t.name === 'reporter_list_my_reports')?.annotations?.readOnly,
    JSON.stringify(tool?.annotations),
  );

  const ctxOut = await a.invoke('reporter_get_context');
  check(
    'B: reporter_get_context',
    ctxOut.status === 'Completed' && ctxOut.out?.ok === true && ctxOut.out?.connected === true && ctxOut.out?.project?.bucket === BUCKET,
    JSON.stringify(ctxOut),
  );
  const list0 = await a.invoke('reporter_list_my_reports', { status: 'all' });
  check(
    'B: reporter_list_my_reports',
    list0.status === 'Completed' && list0.out?.ok === true && Array.isArray(list0.out?.reports),
    JSON.stringify(list0),
  );

  const cap = await a.invoke('reporter_capture_screenshot', { mode: 'viewport' });
  check(
    'B: reporter_capture_screenshot holds a shot (no editor opened over the panel)',
    cap.out?.ok === true && (await f.locator('[role=dialog]').count()) === 0,
    JSON.stringify(cap),
  );

  // Deny: the sheet shows, nothing is sent.
  const before = sent.length;
  const denyCall = a.invoke(
    'reporter_create_report',
    { summary: '[webmcp qa] deny case', description: 'Should never be filed.', steps: ['Open the fixture'], expected: 'x', actual: 'y' },
    60000,
  );
  const sheet = f.getByRole('dialog', { name: 'File a report' });
  await sheet.waitFor({ timeout: 15000 });
  await p.screenshot({ path: `${SHOTS}/webmcp-allow-sheet.png` });
  check(
    'B: the Allow / Deny sheet shows for reporter_create_report (screenshot webmcp-allow-sheet.png)',
    (await sheet.getByRole('button', { name: 'Allow' }).count()) === 1 && (await sheet.getByText('[webmcp qa] deny case').count()) >= 1,
  );
  await sheet.getByRole('button', { name: 'Deny' }).click();
  const denied = await denyCall;
  await p.waitForTimeout(1000);
  const posted = sent.slice(before).filter((s) => /\/reporter\/v1\/tickets/.test(s));
  check(
    'B: Deny answers DENIED and sends nothing',
    denied.out?.code === 'DENIED' && posted.length === 0,
    `${JSON.stringify(denied.out)} sent=${JSON.stringify(posted)}`,
  );

  // Allow: a ticket in the test bucket, tagged webmcp, with the shot.
  const allowCall = a.invoke(
    'reporter_create_report',
    {
      summary: '[webmcp qa] allow case',
      description: 'Filed by the WebMCP QA run.',
      type: 'bug',
      priority: 'low',
      steps: ['Open the fixture'],
      expected: 'One line',
      actual: 'Two lines',
    },
    60000,
  );
  await sheet.waitFor({ timeout: 15000 });
  await sheet.getByRole('button', { name: 'Allow' }).click();
  const filed = await allowCall;
  const key = filed.out?.key;
  check(
    'B: Allow files a report',
    filed.out?.ok === true && new RegExp(`^${BUCKET}-\\d+$`).test(key ?? '') && filed.out?.uploadFailed?.length === 0,
    JSON.stringify(filed),
  );
  await p.screenshot({ path: `${SHOTS}/webmcp-after-allow.png` });
  if (key) {
    const t = await portalTicket(key);
    check(
      `B: ${key} is in the portal, tagged webmcp and ui-report, steps in its description`,
      !!t && (t.tags ?? []).includes('webmcp') && (t.tags ?? []).includes('ui-report') && /Steps to reproduce/.test(t.description ?? ''),
      JSON.stringify({ tags: t?.tags, status: t?.status }),
    );
    const list1 = await a.invoke('reporter_list_my_reports', { status: 'open' });
    check(
      'B: the new report is in my reports, by its project key',
      (list1.out?.reports ?? []).some((r) => r.key === key),
      JSON.stringify(list1.out?.reports?.map((r) => r.key)),
    );
    const cm = a.invoke('reporter_comment_on_report', { key, body: 'QA comment through WebMCP.' }, 60000);
    await f.getByRole('dialog', { name: `Comment on ${key}` }).waitFor({ timeout: 15000 });
    await f
      .getByRole('dialog', { name: `Comment on ${key}` })
      .getByRole('button', { name: 'Allow' })
      .click();
    const cmo = await cm;
    check('B: reporter_comment_on_report after Allow', cmo.out?.ok === true, JSON.stringify(cmo));
    await closeTicket(key);
  }
  await browser.close();
}

/* ---------- C: the panel as the page itself (same origin) ---------- */
{
  const browser = await launch(true);
  const { ctx, p } = await signedInPage(browser);
  await p.goto(`${PORTAL}/reporter/v1/embed?bucket=${BUCKET}&origin=${encodeURIComponent(HOST)}`, { waitUntil: 'load' });
  const a = await agent(ctx, p, null);
  await connect(ctx, p.mainFrame());
  for (let i = 0; i < 50 && names(a.tools).length < 6; i++) await p.waitForTimeout(100);
  const seen = await inPage(p.mainFrame());
  check(
    'C top-level: the six tools register on document.modelContext',
    EXPECTED.every((n) => names(a.tools).includes(n)),
    `cdp=${JSON.stringify(names(a.tools))} page=${JSON.stringify(seen)}`,
  );
  const c = await a.invoke('reporter_get_context').catch((e) => ({ error: e.message }));
  check('C top-level: reporter_get_context', c.out?.ok === true && c.out?.connected === true, JSON.stringify(c));
  await browser.close();
}

/* ---------- D: no WebMCP, the form as before ---------- */
{
  const browser = await launch(false);
  const { ctx, p, sent } = await signedInPage(browser);
  await p.goto(`${HOST}/standin`, { waitUntil: 'load' });
  for (let i = 0; i < 40 && !panelFrame(p); i++) await p.waitForTimeout(250);
  const f = panelFrame(p);
  await connect(ctx, f);
  const seen = await inPage(f);
  check('D: no model context without the feature', seen.modelContext === false, JSON.stringify(seen));
  await f.getByRole('tab', { name: 'Report' }).click();
  await f.getByRole('button', { name: /^Screen$/ }).click();
  // The editor opens by itself on a person's shot; Done with no marks is the skip.
  await f.getByRole('button', { name: 'Done' }).click({ timeout: 15000 });
  await f.getByLabel('Title').fill('[webmcp qa] form without WebMCP');
  await f.getByRole('button', { name: 'File ticket' }).click();
  await f
    .getByText(/^Filed /)
    .first()
    .waitFor({ timeout: 30000 });
  await p.screenshot({ path: `${SHOTS}/form-no-webmcp-filed.png` });
  const keyText = (
    await f
      .getByText(new RegExp(`${BUCKET}-\\d+`))
      .first()
      .innerText()
  ).match(new RegExp(`${BUCKET}-\\d+`))?.[0];
  const t = keyText ? await portalTicket(keyText) : null;
  check(
    'D: the Report form files a ticket (no webmcp tag), screenshot form-no-webmcp-filed.png',
    !!t && !(t.tags ?? []).includes('webmcp') && sent.some((s) => s === 'POST /reporter/v1/tickets'),
    `${keyText} ${JSON.stringify(t?.tags)}`,
  );
  if (keyText) await closeTicket(keyText);
  await browser.close();
}

await api.dispose();
server.close();
console.log(`\n${results.join('\n')}`);
process.exit(failed ? 1 : 0);
