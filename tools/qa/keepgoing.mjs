// Keep going on the session screen (T-259 slice 1): runs the REAL session page in headless Chromium over CDP against a scripted session
// (btw-fake.js, which answers PUT keep-going like the server), at 390 px (touch, the iPhone's safe areas) and 1280 px, light and dark, and
// asserts:
//   - with Keep going on: the header's chip is there, 44 x 44 px, inside the header, overlapping none of its other controls, with a long
//     title and Bypass on too; the title still truncates;
//   - a tap on the chip opens Session info with the Keep going row: the switch on, today's counts and the last action, the text wrapping
//     inside the dialog, its InfoTip opening inside the screen; nothing scrolls sideways;
//   - turning the switch off sends the PUT and the chip goes; a chat that never had a policy shows no chip and the switch off;
//   - slice 2, the Home card "Autonomy" (GET /api/keepgoing answered by the harness): the card is there, the chat left down first, the
//     figures (watched, down, reported, today) from the answer, every row a 44 px link to its chat, a long title cut inside the card, nothing
//     wider than the card, no sideways scroll, the card's InfoTip inside the screen, the pause and the empty list as words;
//   - no page errors.
// usage: KG_PORT=3471 KG_CDP=9671 node tools/qa/keepgoing.mjs [--shots dir]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PORT = Number(process.env.KG_PORT ?? 3471);
const CODE = process.env.KG_CODE ?? '24681372';
const CDP = Number(process.env.KG_CDP ?? 9671);
const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url));
const fake = readFileSync(join(here, 'btw-fake.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IPHONE = { top: 59, bottom: 34, left: 0, right: 0 };
const SIZES = [
  { name: '390', w: 390, h: 844, mobile: true, insets: IPHONE },
  { name: '1280', w: 1280, h: 800 },
];
const MATRIX = SIZES.flatMap((s) => [{ ...s, name: `${s.name}-light` }, { ...s, name: `${s.name}-dark`, dark: true }]);

const login = async () => {
  const r = await fetch(`http://localhost:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${PORT}` }, body: JSON.stringify({ code: CODE }) });
  const m = /portal_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  if (!m) throw new Error(`login failed ${r.status}`);
  return m[1];
};

const profile = mkdtempSync(join(tmpdir(), 'cp-kg-profile-'));
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => {
  try {
    chrome.kill();
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
};
process.on('exit', cleanup);

let targets;
for (let i = 0; i < 60; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
    if (targets.some((t) => t.type === 'page')) break;
  } catch {}
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
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++n;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(`eval: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text} in ${expr.slice(0, 80)}`);
  return r.result?.result?.value;
};
const shot = async (name) => {
  if (shots) writeFileSync(join(shots, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
};
const waitFor = async (expr, ms = 4000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await ev(expr)) return true;
    await sleep(50);
  }
  return false;
};

const results = [];
let cfgName = '';
const check = (name, ok, detail = '') => {
  results.push({ cfg: cfgName, name, ok: !!ok, detail });
  if (!ok) console.log(`  FAIL ${cfgName} / ${name} ${detail}`);
};

const harness = `(() => {
  const real = window.fetch;
  window.fetch = (input, init) => {
    const p = new URL(typeof input === 'string' ? input : input.url, location.origin).pathname;
    if (p.endsWith('/bypass') && (!init || !init.method || init.method === 'GET'))
      return Promise.resolve(new Response(JSON.stringify({ data: { allowed: true, capable: true, active: true, busy: false, reauthed: true, facts: { workspace: 'bv-ws', isolated: true, network: 'open', credentials: [] } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (p.endsWith('/keep-going') && init && init.method === 'PUT') window.__kgPuts = (window.__kgPuts || 0) + 1;
    return real(input, init);
  };
})();`;

async function setup(cfg) {
  await send('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: !!cfg.mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: !!cfg.mobile });
  await send('Emulation.setSafeAreaInsetsOverride', { insets: cfg.insets ?? { top: 0, bottom: 0, left: 0, right: 0 } });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: cfg.dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
}
async function openSession(init) {
  if (openSession.script) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: openSession.script });
  openSession.script = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__FAKE_SESSION = ${JSON.stringify(init)};\n${fake}\n${harness}` })).result.identifier;
  await send('Page.navigate', { url: `http://localhost:${PORT}/admin/sessions/bv-fake` });
  const ready = `!!document.querySelector('[data-session-header]') && !!document.querySelector('textarea[aria-label="Message"]')`;
  if (!(await waitFor(ready, 20000))) {
    await send('Page.reload');
    if (!(await waitFor(ready, 30000))) return false;
  }
  await sleep(700);
  return true;
}

const R = `(e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; }`;
const HEADER = `(() => {
  const R = ${R};
  const header = document.querySelector('[data-session-header]');
  const chip = header?.querySelector('[data-keep-going-chip]');
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const others = header ? [...header.querySelectorAll('a[href], button')].filter(vis).filter((e) => e !== chip).map((e) => ({ what: (e.getAttribute('aria-label') || '').slice(0, 30), ...R(e) })) : [];
  const title = header?.querySelector('button[aria-haspopup=dialog] span');
  return { header: R(header), chip: chip && { ...R(chip), label: chip.getAttribute('aria-label') }, others, titleCut: title ? title.scrollWidth > title.clientWidth + 1 : null, sw: document.scrollingElement.scrollWidth, w: innerWidth };
})()`;
const DIALOG = `(() => {
  const R = ${R};
  const row = document.querySelector('[data-keep-going]');
  const dlg = row?.closest('[role=dialog]');
  const sw = row?.querySelector('[role=switch]');
  const tip = row?.querySelector('button[aria-label="About Keep going"]');
  const wide = row ? [...row.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > (dlg?.getBoundingClientRect().right ?? innerWidth) + 1).length : -1;
  return { row: R(row), dialog: R(dlg), on: sw?.getAttribute('aria-checked'), text: row?.innerText ?? '', tip: R(tip), wide, sw: document.scrollingElement.scrollWidth, w: innerWidth, h: innerHeight };
})()`;
const overlap = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.y, b.y));

const KG = { enabled: true, nudgeAfterMin: 4, prompt: null, statusFile: null, maxNudgesPerDay: 60, maxWakesPerDay: 20, nudgesToday: 3, wakesToday: 1, last: { at: new Date().toISOString(), kind: 'nudged', cause: null, reason: 'Idle for 4 min: told to continue.' }, paused: false };
const LONG_TITLE = 'Orchestrator: ClaudePilot dev, a title long enough to be cut in the header on a phone';

const cookie = await login();
await send('Network.enable');
await send('Network.setCookie', { name: 'portal_session', value: cookie, domain: 'localhost', path: '/' });
await send('Page.enable');
await send('Runtime.enable');

for (const cfg of MATRIX) {
  cfgName = cfg.name;
  await setup(cfg);
  const touch = !!cfg.mobile;

  // On, with a long title and Bypass on: the chip and the header.
  if (!(await openSession({ title: LONG_TITLE, mode: 'bypassPermissions', bypassCapable: true, keepGoing: KG }))) {
    check('the page opens', false);
    continue;
  }
  let h = await ev(HEADER);
  check('chip shown when on', !!h.chip, JSON.stringify(h.chip));
  if (h.chip) {
    check('chip is 44 x 44', Math.round(h.chip.w) >= 44 && Math.round(h.chip.h) >= 44, `${h.chip.w}x${h.chip.h}`);
    check('chip inside the header', h.chip.x >= h.header.x - 1 && h.chip.r <= h.header.r + 1 && h.chip.y >= h.header.y - 1 && h.chip.b <= h.header.b + 1);
    const hit = h.others.filter((o) => overlap(o, h.chip) > 1);
    check('chip overlaps no other control', hit.length === 0, JSON.stringify(hit));
    check('chip names the counts', /3 nudges · 1 wake/.test(h.chip.label ?? ''), h.chip.label);
  }
  if (touch) check('long title truncates', h.titleCut === true);
  check('no sideways scroll (header)', h.sw <= h.w + 1, `${h.sw} > ${h.w}`);
  await shot(`${cfg.name}-header-on`);

  // A tap on the chip: Session info with the Keep going row.
  await ev(`document.querySelector('[data-keep-going-chip]').click()`);
  const opened = await waitFor(`!!document.querySelector('[data-keep-going]')`, 3000);
  check('chip opens Session info', opened);
  await sleep(400);
  let d = await ev(DIALOG);
  check('switch on', d.on === 'true', d.on);
  check('counts shown', /Today: 3 nudges · 1 wake/.test(d.text), d.text);
  check('last action shown', /Idle for 4 min: told to continue\./.test(d.text), d.text);
  check('row inside the dialog', !!d.dialog && d.row.x >= d.dialog.x - 1 && d.row.r <= d.dialog.r + 1, JSON.stringify({ row: d.row, dialog: d.dialog }));
  check('nothing wider than the dialog', d.wide === 0, String(d.wide));
  check('no sideways scroll (dialog)', d.sw <= d.w + 1);
  if (touch && d.tip) check('InfoTip target 44 px on touch', Math.round(d.tip.w) >= 44 || Math.round(d.tip.h) >= 44, `${d.tip.w}x${d.tip.h}`);
  await shot(`${cfg.name}-info-on`);
  // Its InfoTip opens inside the screen and wraps.
  await ev(`document.querySelector('[data-keep-going] button[aria-label="About Keep going"]').click()`);
  await sleep(400);
  const tip = await ev(`(() => { const t = [...document.querySelectorAll('[role=tooltip], [role=note], [data-infotip]')].find((e) => /every minute/.test(e.innerText)); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.x, r: r.right, y: r.y, b: r.bottom, w: innerWidth, h: innerHeight }; })()`);
  check('InfoTip opens', !!tip);
  if (tip) check('InfoTip inside the screen', tip.x >= 0 && tip.r <= tip.w + 1 && tip.y >= 0 && tip.b <= tip.h + 1, JSON.stringify(tip));
  await shot(`${cfg.name}-info-tip`);
  await ev(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await sleep(200);

  // Off: the PUT goes, the payload comes back off, the chip goes.
  await ev(`document.querySelector('[data-keep-going] [role=switch]').click()`);
  const off = await waitFor(`document.querySelector('[data-keep-going] [role=switch]')?.getAttribute('aria-checked') === 'false'`, 3000);
  check('switch turns off', off);
  check('the PUT was sent', (await ev(`window.__kgPuts || 0`)) >= 1);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(500);
  h = await ev(HEADER);
  check('chip gone when off', !h.chip);

  // Never had a policy: no chip, the switch off, no counts.
  await openSession({ title: 'A chat without Keep going' });
  h = await ev(HEADER);
  check('no chip without a policy', !h.chip);
  await ev(`document.querySelector('[data-session-header] button[aria-haspopup=dialog]').click()`);
  await waitFor(`!!document.querySelector('[data-keep-going]')`, 3000);
  await sleep(300);
  d = await ev(DIALOG);
  check('switch off without a policy', d.on === 'false', d.on);
  check('no counts without a policy', !/Today:/.test(d.text), d.text);
  await shot(`${cfg.name}-info-none`);
}

// ---------- Slice 2: the Home card "Autonomy" ----------
const kgOf = (over) => ({ ...KG, standing: [], ...over });
const LIST = {
  paused: false,
  chats: [
    { sessionId: 'kg-down', title: LONG_TITLE, workspaceId: 'kubernetes/kohi-event', state: 'ended', mode: 'default', keepGoing: kgOf({ standing: ['down'], nudgesToday: 0, wakesToday: 0, last: { at: new Date().toISOString(), kind: 'reported', cause: 'down', reason: 'Reported: left down (T-12).' } }) },
    { sessionId: 'kg-wait', title: 'Konfersi: migration', workspaceId: 'kubernetes/kohi-event', state: 'waiting', mode: 'default', keepGoing: kgOf({ standing: ['approval'], nudgesToday: 2, wakesToday: 0 }) },
    { sessionId: 'kg-work', title: 'Event: program', workspaceId: 'kubernetes/kohi-event', state: 'working', mode: 'bypassPermissions', keepGoing: kgOf({ nudgesToday: 5, wakesToday: 2 }) },
  ],
};
const homeHarness = (list) => `(() => {
  const real = window.fetch;
  window.fetch = (input, init) => {
    const p = new URL(typeof input === 'string' ? input : input.url, location.origin).pathname;
    if (p === '/api/keepgoing') return Promise.resolve(new Response(JSON.stringify({ data: ${JSON.stringify(list)} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    return real(input, init);
  };
})();`;
async function openHome(list) {
  if (openSession.script) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: openSession.script });
  openSession.script = (await send('Page.addScriptToEvaluateOnNewDocument', { source: homeHarness(list) })).result.identifier;
  await send('Page.navigate', { url: `http://localhost:${PORT}/admin/home` });
  const ready = `!!document.querySelector('[data-home-card="autonomy"] [data-autonomy]')`;
  if (!(await waitFor(ready, 20000))) {
    await send('Page.reload');
    if (!(await waitFor(ready, 30000))) return false;
  }
  // The card is the last on Home: brought into view as a person would scroll to it.
  await ev(`document.querySelector('[data-home-card="autonomy"]').scrollIntoView({ block: 'start' })`);
  await sleep(500);
  return true;
}
const CARD = `(() => {
  const R = ${R};
  const card = document.querySelector('[data-home-card="autonomy"]');
  const rows = card ? [...card.querySelectorAll('ul[aria-label="Chats kept going"] a')] : [];
  const cr = card?.getBoundingClientRect();
  const wide = card ? [...card.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > cr.right + 1 || r.left < cr.left - 1); }).length : -1;
  const first = rows[0]?.querySelector('span.block.truncate');
  const stats = card ? [...card.querySelectorAll('[role=group]')].map((e) => e.getAttribute('aria-label')) : [];
  const tip = card?.querySelector('header button[aria-label="About Autonomy"]');
  return { card: R(card), rows: rows.map((a) => ({ href: a.getAttribute('href'), ...R(a) })), firstCut: first ? first.scrollWidth > first.clientWidth + 1 : null, wide, stats, text: card?.innerText ?? '', tip: R(tip), sw: document.scrollingElement.scrollWidth, w: innerWidth };
})()`;

for (const cfg of MATRIX) {
  cfgName = `home-${cfg.name}`;
  await setup(cfg);
  const touch = !!cfg.mobile;
  if (!(await openHome(LIST))) {
    check('the Home card shows', false);
    continue;
  }
  const c = await ev(CARD);
  check('three rows, the chat left down first', c.rows.length === 3 && c.rows[0].href === '/admin/sessions/kg-down', JSON.stringify(c.rows.map((r) => r.href)));
  check('every row is a 44 px link', c.rows.every((r) => Math.round(r.h) >= 44), JSON.stringify(c.rows.map((r) => r.h)));
  check('rows inside the card', c.rows.every((r) => r.x >= c.card.x - 1 && r.r <= c.card.r + 1));
  check('figures from the answer', ['Watched: 3', 'Down: 1', 'Reported: 1', 'Today: 9'].every((x) => c.stats.includes(x)), JSON.stringify(c.stats));
  check('state and what stands in words', /Ended · left down/.test(c.text) && /Waiting · a tool approval waits/.test(c.text) && /Working · Idle for 4 min/.test(c.text), c.text);
  if (touch) check('a long title is cut inside the card', c.firstCut === true);
  check('nothing wider than the card', c.wide === 0, String(c.wide));
  check('no sideways scroll (Home)', c.sw <= c.w + 1, `${c.sw} > ${c.w}`);
  check('the card has its InfoTip', !!c.tip);
  await shot(`home-${cfg.name}-autonomy`);
  if (c.tip) {
    await ev(`(() => { const b = document.querySelector('[data-home-card="autonomy"] header button[aria-label="About Autonomy"]'); b.scrollIntoView({ block: 'center' }); b.click(); })()`);
    await sleep(400);
    const tip = await ev(`(() => { const t = [...document.querySelectorAll('[role=tooltip], [role=note], [data-infotip]')].find((e) => /never turns Bypass on/.test(e.innerText)); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.x, r: r.right, y: r.y, b: r.bottom, w: innerWidth, h: innerHeight }; })()`);
    check('the InfoTip opens inside the screen', !!tip && tip.x >= 0 && tip.r <= tip.w + 1 && tip.y >= 0 && tip.b <= tip.h + 1, JSON.stringify(tip));
    await shot(`home-${cfg.name}-autonomy-tip`);
    await ev(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  }
  // Paused, and nothing watched: words, not a guessed figure.
  await openHome({ paused: true, chats: [] });
  const e = await ev(CARD);
  check('the pause is said', /Paused/.test(e.text), e.text);
  check('the empty list is said', /No chat has Keep going on\./.test(e.text), e.text);
  check('no sideways scroll (empty)', e.sw <= e.w + 1);
  await shot(`home-${cfg.name}-autonomy-empty`);
}

check('no page errors', errors.length === 0, errors.join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`keepgoing: ${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} failed` : ''}`);
ws.close();
cleanup();
process.exit(failed.length ? 1 : 0);
