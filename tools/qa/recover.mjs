// T-136 slice 2: Resume on a session ended for integrity, in a real browser. The sessions list (a harmless and a suspicious ending, beside
// a live session) and the session page of each, at 390 px (touch, the iPhone's safe areas) and 1280 px, light and dark. Runs the REAL web
// app against scripted sessions (btw-fake.js for the session page; the list's fetch answered here): no portal engine, no Claude. Asserts:
//   - Resume shows on the ended-for-integrity rows only, and on the ended page's note; it is at least 44 x 44 px; icon-only on the phone
//     (its label in aria-label), "Resume" written out at 1280 px; nothing scrolls sideways;
//   - a tap on a suspicious one opens the confirmation sheet with the origin and the classification, inside the screen; a harmless one
//     opens no sheet (it resumes at once).
// usage: RC_PORT=3501 RC_CODE=<code> RC_CDP=9651 node tools/qa/recover.mjs [--shots dir]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PORT = Number(process.env.RC_PORT ?? 3501);
const CODE = process.env.RC_CODE ?? '24681372';
const CDP = Number(process.env.RC_CDP ?? 9651);
const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url));
const fake = readFileSync(join(here, 'btw-fake.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIZES = [
  { name: '390', w: 390, h: 844, mobile: true, insets: { top: 59, bottom: 34, left: 0, right: 0 } },
  { name: '1280', w: 1280, h: 800 },
].flatMap((s) => [{ ...s, name: `${s.name}-light` }, { ...s, name: `${s.name}-dark`, dark: true }]);

const now = new Date().toISOString();
const base = (id, title, extra) => ({
  id, workspaceId: 'bv-ws', cwd: '/work', title, state: 'idle', origin: 'ui', model: 'claude-opus-5-5', mode: 'default', effort: null, ultracode: false,
  ultracodeAvailable: false, process: 'live', context: null, costUsd: 106.96, turns: 40, lastSeq: 0, waiting: 0, waitingFor: null, createdAt: now,
  lastActivityAt: now, endedReason: null, endedFor: null, claudeId: '', claudeName: 'fadlilah', predecessorId: null, successorId: null, archivedAt: null,
  pinnedAt: null, ticketId: null, parentId: null, worktree: null, startedBy: 'ui', bypassCapable: true, claudeSessionId: id, previousClaudes: [], switching: null, ...extra,
});
const HARMLESS_WHY = "a message this portal didn't send reached Claude Code (61cd4959, origin peer)";
const SUSPICIOUS_WHY = "a message this portal didn't send reached Claude Code (3def4bde, origin channel)";
const harmless = { state: 'ended', process: 'gone', endedReason: `integrity: ${HARMLESS_WHY}`, endedFor: { reason: HARMLESS_WHY, classified: 'harmless', case: 'replay-peer', origin: 'a sub-agent of this process' } };
const suspicious = { state: 'ended', process: 'gone', endedReason: `integrity: ${SUSPICIOUS_WHY}`, endedFor: { reason: SUSPICIOUS_WHY, classified: 'suspicious', case: 'replay-unknown', origin: 'unknown origin: channel' } };
const LIST = [
  base('rc-1', 'Orchestrator: ClaudePilot dev, a long title that has to wrap or cut on a phone', { ...harmless, pinnedAt: now }),
  base('rc-2', 'Konfersi: migration', suspicious),
  base('rc-3', 'Event: program', { state: 'idle' }),
  base('rc-4', 'Closed by a person', { state: 'ended', process: 'gone', endedReason: 'closed by operator' }),
];
const listFake = `(() => { const rows = ${JSON.stringify(LIST)}; const real = window.fetch.bind(window);
  window.fetch = (input, init) => { const p = new URL(typeof input === 'string' ? input : input.url, location.origin).pathname;
    if (p === '/api/chat/sessions' && (!init || !init.method || init.method === 'GET')) return Promise.resolve(new Response(JSON.stringify({ data: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (/^\\/api\\/chat\\/sessions\\/rc-[0-9]\\/recover$/.test(p)) { window.__recovered = (window.__recovered || []).concat(p); return Promise.resolve(new Response(JSON.stringify({ data: rows[0] }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
    return real(input, init); }; })();`;

const login = async () => {
  const r = await fetch(`http://localhost:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${PORT}` }, body: JSON.stringify({ code: CODE }) });
  const m = /portal_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  if (!m) throw new Error(`login failed ${r.status}`);
  return m[1];
};

const profile = mkdtempSync(join(tmpdir(), 'ux-rc-profile-'));
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => {
  try { chrome.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

let targets;
for (let i = 0; i < 60; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); if (targets.some((t) => t.type === 'page')) break; } catch {}
  await sleep(200);
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let n = 0;
const pending = new Map();
const errors = [];
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) pending.get(m.id)(m);
  if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
});
const send = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(`eval: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
  return r.result?.result?.value;
};
const shot = async (name) => { if (shots) writeFileSync(join(shots, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); };
const waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(80); } return false; };

const cookie = await login();
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCookie', { name: 'portal_session', value: cookie, domain: 'localhost', path: '/' });

const BUTTONS = `[...document.querySelectorAll('button[aria-label="Resume"]')].map((b) => { const r = b.getBoundingClientRect(); const s = getComputedStyle(b); return { w: r.width, h: r.height, x: r.x, r: r.right, text: b.innerText.trim(), visible: r.width > 0 && s.visibility !== 'hidden', row: b.closest('li')?.innerText.split('\\n')[0] ?? null }; })`;
const SIDEWAYS = `document.scrollingElement.scrollWidth > innerWidth + 1`;
let script = null;
const results = [];
const fail = (cfg, what) => results.push(`${cfg.name}: ${what}`);

for (const cfg of SIZES) {
  await send('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: !!cfg.mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: !!cfg.mobile });
  await send('Emulation.setSafeAreaInsetsOverride', { insets: cfg.insets ?? { top: 0, bottom: 0, left: 0, right: 0 } });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: cfg.dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });

  // 1. The list.
  if (script) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script });
  script = (await send('Page.addScriptToEvaluateOnNewDocument', { source: listFake })).result.identifier;
  await send('Page.navigate', { url: `http://localhost:${PORT}/admin/sessions` });
  if (!(await waitFor(`document.body.innerText.includes('Konfersi: migration')`, 20000))) {
    // The list may open on a filter that hides ended rows: show all.
    await ev(`localStorage.setItem('claudepilot.sessions-view', JSON.stringify({ groupBy: 'none', filter: 'all', query: '', archived: false }))`);
    await send('Page.reload');
    if (!(await waitFor(`document.body.innerText.includes('Konfersi: migration')`, 20000))) { fail(cfg, 'list did not show the sessions'); await shot(`${cfg.name}-list-missing`); continue; }
  }
  await sleep(600);
  let b = await ev(BUTTONS);
  if (b.length !== 2) fail(cfg, `list: ${b.length} Resume buttons, expected 2 (${b.map((x) => x.row).join(' | ')})`);
  for (const x of b) {
    if (x.w < 44 || x.h < 44) fail(cfg, `list: Resume is ${x.w}x${x.h}`);
    if (cfg.mobile ? x.text !== '' : x.text !== 'Resume') fail(cfg, `list: Resume label "${x.text}"`);
    if (x.r > cfg.w + 1) fail(cfg, 'list: Resume past the edge');
  }
  if (await ev(SIDEWAYS)) fail(cfg, 'list scrolls sideways');
  await shot(`${cfg.name}-list`);
  // A suspicious one asks first.
  await ev(`[...document.querySelectorAll('li')].find((l) => l.innerText.includes('Konfersi: migration'))?.querySelector('button[aria-label="Resume"]')?.click()`);
  if (!(await waitFor(`!!document.querySelector('[role=dialog], [role=alertdialog]')`, 4000))) fail(cfg, 'suspicious: no sheet');
  else {
    const sheet = await ev(`(() => { const d = document.querySelector('[role=dialog], [role=alertdialog]'); const r = d.getBoundingClientRect(); return { text: d.innerText, x: r.x, r: r.right, y: r.y, b: r.bottom }; })()`);
    if (!/unknown origin: channel/.test(sheet.text) || !/suspicious/.test(sheet.text)) fail(cfg, `suspicious sheet text: ${sheet.text.slice(0, 120)}`);
    if (sheet.x < -1 || sheet.r > cfg.w + 1 || sheet.y < -1 || sheet.b > cfg.h + 1) fail(cfg, `sheet outside the screen ${JSON.stringify(sheet)}`);
    await sleep(300);
    await shot(`${cfg.name}-sheet`);
    await ev(`[...document.querySelectorAll('[role=dialog] button, [role=alertdialog] button')].find((x) => x.innerText.trim() === 'Cancel')?.click()`);
    await sleep(300);
  }
  // A harmless one resumes at once: no sheet, one call.
  await ev(`window.__recovered = []; [...document.querySelectorAll('li')].find((l) => l.innerText.includes('Orchestrator'))?.querySelector('button[aria-label="Resume"]')?.click()`);
  await sleep(500);
  if (await ev(`!!document.querySelector('[role=dialog], [role=alertdialog]')`)) fail(cfg, 'harmless: a sheet opened');
  if ((await ev(`(window.__recovered || []).length`)) !== 1) fail(cfg, 'harmless: no recover call');

  // 2. The session page of an ended-for-integrity session (suspicious: the note and Resume).
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script });
  script = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__FAKE_SESSION = ${JSON.stringify({ ...suspicious, title: 'Konfersi: migration', claudeName: 'fadlilah', costUsd: 106.96 })};\n${fake}` })).result.identifier;
  await send('Page.navigate', { url: `http://localhost:${PORT}/admin/sessions/bv-fake` });
  if (!(await waitFor(`!!document.querySelector('button[aria-label="Resume"]')`, 20000))) { fail(cfg, 'page: no Resume'); await shot(`${cfg.name}-page-missing`); continue; }
  await sleep(700);
  b = await ev(BUTTONS);
  if (b.length !== 1) fail(cfg, `page: ${b.length} Resume buttons`);
  for (const x of b) {
    if (x.w < 44 || x.h < 44) fail(cfg, `page: Resume is ${x.w}x${x.h}`);
    if (x.r > cfg.w + 1 || x.x < 0) fail(cfg, 'page: Resume outside the screen');
  }
  if (!(await ev(`document.body.innerText.includes('Ended for integrity')`))) fail(cfg, 'page: no "Ended for integrity"');
  if (await ev(SIDEWAYS)) fail(cfg, 'page scrolls sideways');
  await shot(`${cfg.name}-page`);
}

if (errors.length) results.push(...errors.map((e) => `page error: ${e}`));
console.log(results.length ? `FAIL\n${results.join('\n')}` : `PASS: ${SIZES.length} sizes (list, sheet, page)`);
cleanup();
process.exit(results.length ? 1 : 0);
