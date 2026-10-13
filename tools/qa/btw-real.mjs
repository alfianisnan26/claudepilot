// The btw UI against the REAL engine (docs/prd/chat-sessions.md §20.12, S2b): the real session page in headless Chromium over CDP, against a
// scratch portal whose local workspace runs the real Claude Code CLI with the stand-in Messages API (tools/qa/mock-anthropic.mjs) behind it. No
// fake socket: every `btw`, `btw_delta`, `ack` and `events` message the page sees comes from apps/server/src/chat/btw.ts. The stand-in's directives
// in the question choose the engine's path: [[slow N]] streams ticks, [[long N]] a long answer, [[md]] markdown, [[err 429]] an api_limit, [[bash ls]]
// a tool call the tool-free run refuses (`unsafe`). Asserts the card's states in the order the engine sends them (running with an estimate ->
// streaming -> answered with the reported numbers; cancelled keeps the partial answer; failed shows the reason), replay on reload, a stable
// transcript while a real main turn streams, the sheet on the phone and the side panel at 1280, no horizontal scroll, no page errors.
//
// Set-up (scripts/scratch-portal.sh, the "THE REAL ENGINE ANSWERS" recipe of docs/coord/outbox-s1.md moved to the local runtime):
//   node tools/qa/mock-anthropic.mjs 4599 /tmp/cp-mock.jsonl &
//   PORTAL_LOCAL_ENABLED=true scripts/scratch-portal.sh start 3405
//   printf '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4599","ANTHROPIC_API_KEY":"fake-mock-key"}}' > /tmp/scratch-portal-3405/home/.claude/settings.json
//   POST /api/workspaces/local/local/start; PUT /api/settings/chat.btw.limit {value: 60}; POST /api/chat/sessions {workspaceId: 'local/local'}; send a few turns
// usage: BR_PORT=3405 BR_CODE=<server code> BR_CDP=9607 node tools/qa/btw-real.mjs <sessionId> [--only name] [--shots dir]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.env.BR_PORT ?? 3405);
const CODE = process.env.BR_CODE ?? '24681372';
const CDP = Number(process.env.BR_CDP ?? 9607);
const args = process.argv.slice(2);
const SID = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--only' && args[args.indexOf(a) - 1] !== '--shots');
if (!SID) { console.error('usage: node tools/qa/btw-real.mjs <sessionId> [--only name] [--shots dir]'); process.exit(2); }
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHONE = { top: 59, bottom: 34, left: 0, right: 0 };
const MATRIX = [
  { name: 'phone-390-light', w: 390, h: 844, mobile: true, insets: PHONE },
  { name: 'phone-390-dark', w: 390, h: 844, mobile: true, insets: PHONE, dark: true },
  { name: 'desktop-1280-light', w: 1280, h: 800, panel: true },
  { name: 'desktop-1280-dark', w: 1280, h: 800, panel: true, dark: true },
];

const BASE = `http://localhost:${PORT}`;
const login = async () => {
  const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ code: CODE }) });
  const m = /portal_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  if (!m) throw new Error(`login failed ${r.status}`);
  return m[1];
};
/** A second tab of the same person on the chat socket: sends a main turn and watches the session's state (never the btw: that is the page's). */
const openChat = async (cookie) => {
  const ws = new WebSocket(`ws://localhost:${PORT}/api/chat/live`, { headers: { Cookie: `portal_session=${cookie}`, Origin: BASE } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const chat = { ws, state: null, acks: new Map() };
  ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'session') chat.state = m.session.state; if (m.type === 'ack') chat.acks.set(m.uuid, m); });
  ws.send(JSON.stringify({ type: 'subscribe', session: SID, afterSeq: 0 }));
  let n = 0;
  chat.send = async (text) => { const uuid = `br-${Date.now()}-${++n}`; ws.send(JSON.stringify({ type: 'send', session: SID, uuid, text })); for (let i = 0; i < 50 && !chat.acks.has(uuid); i++) await sleep(100); return chat.acks.get(uuid); };
  chat.stop = () => ws.send(JSON.stringify({ type: 'control', session: SID, op: 'stop', uuid: `br-stop-${++n}` }));
  chat.idle = async (ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (chat.state && chat.state !== 'working' && chat.state !== 'starting') return true; await sleep(150); } return false; };
  return chat;
};

const profile = mkdtempSync(join(tmpdir(), 'cpb-profile-'));
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
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
  if (r.result?.exceptionDetails) throw new Error(`eval: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text} in ${expr.slice(0, 80)}`);
  return r.result?.result?.value;
};
const key = async (k, code = k, vk = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
};
const enter = () => send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }));
const shot = async (name) => { if (shots) writeFileSync(join(shots, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); };
const waitFor = async (expr, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(60); } return false; };

const Q = {
  composer: `document.querySelector('textarea[aria-label="Message"]')`,
  box: `document.querySelector('textarea[aria-label="Message"]').closest('.glass-card')`,
  log: `document.querySelector('[role=log]')`,
  card: `document.querySelector('[data-btw]')`,
  text: `(document.querySelector('[data-btw]')?.innerText ?? '')`,
};
const rect = (sel) => `(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; })()`;
const hscroll = `(() => { const scrollsX = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; }; const d = document.scrollingElement; const bad = []; for (const e of document.querySelectorAll('body *')) { const r = e.getBoundingClientRect(); if (r.width && (r.right > innerWidth + 1 || r.left < -1) && !e.closest('[aria-hidden=true],.sr-only,[role=log]>*,[inert]')) { const s = getComputedStyle(e); if (s.position !== 'fixed' && s.visibility !== 'hidden' && !scrollsX(e)) bad.push(e.tagName + '.' + String(e.className).slice(0, 40)); } } return { doc: d.scrollWidth - innerWidth, bad: bad.slice(0, 3) }; })()`;
const gap = `(() => { const l = ${Q.log}; return l.scrollHeight - l.scrollTop - l.clientHeight; })()`;

const results = [];
let cfgName = '';
const check = (name, ok, detail = '') => { results.push({ cfg: cfgName, name, ok: !!ok, detail }); if (!ok) console.log(`  FAIL ${cfgName} / ${name} ${detail}`); };
const noOverflow = async (label) => { const h = await ev(hscroll); check(`${label}: no horizontal scroll`, h.doc <= 1 && h.bad.length === 0, JSON.stringify(h)); };
const notCovering = async (label, el = Q.card) => {
  const c = await ev(rect(el)), b = await ev(rect(Q.box));
  check(`${label}: clear of the composer`, c && b && c.b <= b.y + 1, JSON.stringify({ c: c && c.b, composerTop: b && b.y }));
  check(`${label}: composer on screen`, b && b.y >= 0 && b.b <= (await ev('innerHeight')) + 1, JSON.stringify(b));
};
const ask = async (q, touch) => {
  await ev(`(() => { const t = ${Q.composer}; t.focus(); })()`);
  await send('Input.insertText', { text: touch ? q : `/btw ${q}` });
  if (touch) await ev(`document.querySelector('[data-guide=btw]').click()`);
  else await enter();
};
const closeCard = async () => { await ev(`document.querySelector('[data-btw] button[aria-label="Close btw"]')?.click()`); await waitFor(`!${Q.card}`, 1500); };
const stopCard = () => ev(`[...document.querySelectorAll('[data-btw] footer button')].find((b) => /Stop/.test(b.innerText))?.click()`);
const settled = (ms = 30000) => waitFor(`(() => { const c = ${Q.card}; return !!c && !c.querySelector('[role=status][aria-label=Answering]') && !/Stop/.test([...c.querySelectorAll('footer button')].map((b) => b.innerText).join()); })()`, ms);
const series = async (expr, ms, step = 40) => { const out = []; const t = Date.now(); while (Date.now() - t < ms) { out.push(await ev(expr)); await sleep(step); } return out; };
const spread = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);

async function open(cfg) {
  await send('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: !!cfg.mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: !!cfg.mobile });
  await send('Emulation.setSafeAreaInsetsOverride', { insets: cfg.insets ?? { top: 0, bottom: 0, left: 0, right: 0 } });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: cfg.dark ? 'dark' : 'light' }] });
  await send('Page.navigate', { url: `${BASE}/admin/sessions/${SID}` });
  const ready = `!!${Q.composer} && ${Q.log}.scrollHeight > 0`;
  if (await waitFor(ready, 20000)) return true;
  await send('Page.reload');
  return waitFor(ready, 30000);
}

async function scenario(cfg, chat) {
  cfgName = cfg.name;
  const touch = !!cfg.mobile;
  if (!(await open(cfg))) return check('page loads', false, 'composer not found');
  await sleep(1200);
  await ev(`localStorage.removeItem('claudepilot.btw.u_owner')`);
  await ev(`${Q.log}.scrollTop = ${Q.log}.scrollHeight`);
  await sleep(400);
  await noOverflow('before');

  // 1. A plain question: the engine says running (a size estimate, the context it saw), streams, then answered with the run's own numbers.
  await ask('What does module 1 do about retries?', touch);
  check('card opens as running', await waitFor(`!!${Q.card} && !!document.querySelector('[data-btw] [role=status][aria-label=Answering]')`, 5000));
  check('focus moved into the card', await ev(`${Q.card}.contains(document.activeElement)`));
  await shot(`${cfg.name}-1-running`);
  check('answered', await settled(40000), (await ev(Q.text)).slice(0, 120));
  const t1 = await ev(Q.text);
  check('the answer is the engine\'s (echo)', /Echo: What does module 1/.test(t1), t1.slice(0, 100));
  check('the reported numbers replace the estimate', /≈ 50 tokens/.test(t1) && /\$0\.0005/.test(t1), t1.slice(-120));
  check('Pin is offered on an answered btw', await ev(`!!document.querySelector('[data-btw] button[aria-label="Pin to transcript"]') && !document.querySelector('[data-btw] button[aria-label="Pin to transcript"]').disabled`));
  await notCovering('answered');
  await noOverflow('answered');
  await shot(`${cfg.name}-1-answered`);

  // 2. A slow stream, stopped half-way: the engine's `cancelled` keeps the partial answer; the btw button is disabled while one runs.
  await closeCard();
  await ask('[[slow 8]] keep ticking', touch);
  check('slow: streams ticks', await waitFor(`/tick 2/.test(${Q.text})`, 8000), (await ev(Q.text)).slice(0, 80));
  check('the btw button is disabled while one runs', await ev(`document.querySelector('[data-guide=btw]').disabled`));
  check('running: the size estimate shows before the run reports', /≈ \d+ tokens$/m.test(await ev(Q.text)) && !/\$/.test(await ev(Q.text)), (await ev(Q.text)).slice(-60));
  await ev(`document.querySelector('[data-btw] footer button[aria-label="About this answer"]')?.click()`);
  await sleep(200);
  check('running: the InfoTip says how many messages it saw', /from the last \d+ messages/.test(await ev(`document.body.innerText`)));
  await ev(`document.querySelector('[data-btw] footer button[aria-label="About this answer"]')?.click()`);
  await sleep(150);
  check('the tip closes and the card stays', !!(await ev(Q.card)) && !/from the last/.test(await ev(`document.body.innerText`)));
  await stopCard();
  check('stopped half-way: Stopped. with the partial answer', await waitFor(`/Stopped\\./.test(${Q.text}) && /tick 1/.test(${Q.text})`, 4000), (await ev(Q.text)).slice(0, 120));
  await sleep(300);
  check('Pin is disabled on a stopped btw', await ev(`document.querySelector('[data-btw] button[aria-label="Pin to transcript"]')?.disabled === true`));
  check('a stopped run keeps the size estimate and books no cost', /≈ \d+ tokens$/m.test(await ev(Q.text)) && !/\$/.test(await ev(Q.text)), (await ev(Q.text)).slice(-60));
  await shot(`${cfg.name}-2-stopped`);

  // 3. Failures the engine maps: an API 429 is api_limit; a tool call in the answer is unsafe (an empty answer, no numbers).
  await closeCard();
  await ask('[[err 429]] please', touch);
  check('429: Rate limited', await waitFor(`/Rate limited/.test(${Q.text})`, 30000), (await ev(Q.text)).slice(0, 120));
  // The real 429 carries a retry wait the scripted socket never sent: Ask again waits it out, counting down.
  check('429: a countdown, Ask again disabled meanwhile', /Try again in \d+ s\./.test(await ev(Q.text)) && (await ev(`document.querySelector('[data-btw] button[aria-label="Ask again"]').disabled`)), (await ev(Q.text)).slice(0, 120));
  await shot(`${cfg.name}-3-api-limit`);
  await closeCard();
  await ask('[[bash ls]] run it', touch);
  check('tool answer: unsafe', await waitFor(`/tools were not off/.test(${Q.text})`, 30000), (await ev(Q.text)).slice(0, 120));
  check('Ask again after a failure without a wait', await ev(`!document.querySelector('[data-btw] button[aria-label="Ask again"]').disabled`));
  check('unsafe: no answer text shown', !/Running it/.test(await ev(Q.text)));
  await shot(`${cfg.name}-3-unsafe`);

  // 4. Markdown and a long answer: contained, scrolling inside the card, the composer and the card's height unmoved while it streams.
  await closeCard();
  await ask('[[md]] show me', touch);
  check('markdown answered', await settled(40000));
  check('markdown renders (a table and code)', await ev(`!!document.querySelector('[data-btw] table') && !!document.querySelector('[data-btw] pre')`));
  await noOverflow('markdown');
  await notCovering('markdown');
  await shot(`${cfg.name}-4-markdown`);
  await closeCard();
  await ask('[[long 12]] a long one', touch);
  await waitFor(`/Paragraph 2/.test(${Q.text})`, 15000);
  const top0 = (await ev(rect(Q.box))).y;
  const tops = [], heights = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 1200) { tops.push((await ev(rect(Q.box))).y); heights.push(await ev(`${Q.card}.getBoundingClientRect().height`)); await sleep(60); }
  check('long: composer does not move while it streams', spread(tops) < 1, `spread ${spread(tops)} from ${top0}`);
  check('long: card height fixed while it streams', spread(heights) < 1, `spread ${spread(heights)}`);
  check('long answered', await settled(40000));
  check('long answer scrolls inside the card', await ev(`(() => { const b = ${Q.card}.querySelector('[aria-live]'); return b.scrollHeight > b.clientHeight + 20 && getComputedStyle(b).overflowY === 'auto'; })()`));
  await shot(`${cfg.name}-4-long`);

  // 5. Replay: a running btw survives a reload (the engine sends the open card with the answer so far when the tab subscribes).
  await closeCard();
  await ask('[[slow 10]] survive a reload', touch);
  await waitFor(`/tick 1/.test(${Q.text})`, 8000);
  await send('Page.reload');
  check('after a reload the running card is back', await waitFor(`!!${Q.card} && /tick/.test(${Q.text})`, 15000), (await ev(Q.text) ?? '').slice(0, 80));
  await sleep(600);
  check('and it keeps streaming', await waitFor(`/tick 6/.test(${Q.text})`, 8000));
  await sleep(300);
  await shot(`${cfg.name}-5-replayed`);
  // The replayed card is placed like an asked one: on the dock, opaque, not over the composer.
  const place = await ev(`(() => { const s = document.querySelector('[data-btw-sheet]') ?? ${Q.card}; const c = getComputedStyle(s); const r = s.getBoundingClientRect(); const b = ${Q.box}.getBoundingClientRect(); return { bottom: r.bottom, composerTop: b.y, opacity: c.opacity, bg: c.backgroundColor }; })()`);
  check('replayed: placed like an asked one (above the composer, opaque)', place.bottom <= place.composerTop + 1 && place.opacity === '1' && !/rgba\(.*, 0\)$/.test(place.bg), JSON.stringify(place));
  await stopCard();
  await waitFor(`/Stopped/.test(${Q.text})`, 4000);

  // 6. A real main turn streams; a btw asked meanwhile: the transcript's end stays in view, the composer does not move, the turn ends by itself.
  await closeCard();
  await ev(`${Q.log}.scrollTop = ${Q.log}.scrollHeight`);
  const ack = await chat.send('[[slow 9]] main turn');
  check('main turn accepted', ack?.ok === true, JSON.stringify(ack));
  check('main turn streams on the page', await waitFor(`/tick 1/.test(${Q.log}.innerText)`, 15000));
  const topM = (await ev(rect(Q.box))).y;
  await ask('Why does it retry? [[long 3]]', touch);
  check('card opens during the main turn', await waitFor(`!!${Q.card}`, 5000));
  const gaps = await series(gap, 1500);
  check('pinned: the end stays in view while the card opens and the turn streams', Math.max(...gaps.slice(3)) <= 100, `max gap ${Math.max(...gaps)}`);
  check('composer did not move for the card', Math.abs((await ev(rect(Q.box))).y - topM) < 2 || cfg.w < 640, `${topM} -> ${(await ev(rect(Q.box))).y}`);
  check('btw answered during the main turn', await settled(40000));
  await shot(`${cfg.name}-6-main-streaming`);
  check('the main turn ends by itself', await chat.idle(30000), chat.state);
  check('the main turn did not touch the card', /Paragraph 3/.test(await ev(Q.text)));

  // 7. Pin: one card in the transcript, from the portal's copy.
  const rows0 = await ev(`document.querySelectorAll('[role=log] > div > *').length`);
  await ev(`document.querySelector('[data-btw] button[aria-label="Pin to transcript"]').click()`);
  check('pinned: the transcript gains the card', await waitFor(`/Why does it retry/.test(${Q.log}.innerText)`, 5000));
  check('the card says pinned', await waitFor(`!!document.querySelector('[data-btw] button[aria-label="Pinned to transcript"]')`, 3000));
  await sleep(400);
  const rows1 = await ev(`document.querySelectorAll('[role=log] > div > *').length`);
  check('the transcript gained one card', rows1 - rows0 >= 1 && rows1 - rows0 <= 2, `${rows0} -> ${rows1}`);
  await ev(`${Q.log}.scrollTop = ${Q.log}.scrollHeight`);
  await sleep(300);
  await shot(`${cfg.name}-7-pinned`);

  // 8. Esc closes it; a closed card does not come back on a reload.
  await ev(`${Q.card}.focus()`);
  await key('Escape', 'Escape', 27);
  check('Esc closes the card', await waitFor(`!${Q.card}`, 1500));
  check('focus back in the composer', await ev(`document.activeElement === ${Q.composer}`));
  await send('Page.reload');
  await waitFor(`!!${Q.composer}`, 20000);
  await sleep(1500);
  check('a closed btw is not replayed', !(await ev(`!!${Q.card}`)));

  // 9. Wide: the side panel; phone: the sheet, half and full, over the header.
  if (cfg.panel) {
    await ask('Panel please', touch);
    await waitFor(`!!${Q.card}`, 5000);
    await ev(`document.querySelector('button[aria-label="Open in side panel"]')?.click()`);
    check('the side panel opens', await waitFor(`!!document.querySelector('[data-btw=panel]')`, 3000));
    await settled(40000);
    await sleep(300);
    check('chat column keeps its minimum width', (await ev(`${Q.log}.getBoundingClientRect().width`)) >= 540);
    await noOverflow('side panel');
    await shot(`${cfg.name}-9-side-panel`);
    await ev(`document.querySelector('[data-btw=panel] button[aria-label="Close btw"]').click()`);
    check('closing the panel closes the btw', await waitFor(`!document.querySelector('[data-btw]')`, 2000));
  }
  if (cfg.w < 640) {
    await ask('Sheet please', touch);
    await waitFor(`!!${Q.card}`, 5000);
    await sleep(500);
    const half = await ev(rect(`document.querySelector('[data-btw-sheet]')`));
    const vh = await ev('innerHeight');
    check('the phone gets a half sheet', half && half.h > vh * 0.25 && half.h <= vh * 0.52, JSON.stringify(half));
    await settled(40000);
    await shot(`${cfg.name}-10-sheet-half`);
    await ev(`document.querySelector('[data-btw-sheet] > button').click()`);
    await sleep(350);
    const full = await ev(rect(`document.querySelector('[data-btw-sheet]')`));
    const head = await ev(`(() => { const h = document.querySelector('header'); return h ? h.getBoundingClientRect().bottom : 56; })()`);
    check('the full sheet stays under the header', full.h > half.h && full.y >= head - 1, JSON.stringify({ full, head }));
    await notCovering('sheet', `document.querySelector('[data-btw-sheet]')`);
    await shot(`${cfg.name}-10-sheet-full`);
    await ev(`${Q.card}.focus()`);
    await key('Escape', 'Escape', 27);
    check('Esc closes the sheet', await waitFor(`!document.querySelector('[data-btw-sheet]')`, 1500));
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
  errors.length = 0;
}

try {
  const cookie = await login();
  const chat = await openChat(cookie);
  await send('Network.enable');
  await send('Network.setCookie', { name: 'portal_session', value: cookie, domain: 'localhost', path: '/' });
  await send('Page.enable');
  await send('Runtime.enable');
  for (const cfg of MATRIX) {
    if (only && !cfg.name.includes(only)) continue;
    console.log(`> ${cfg.name}`);
    try { await scenario(cfg, chat); } catch (e) { await shot(`${cfg.name}-x-error`); check('scenario ran', false, String(e.message ?? e).slice(0, 300)); }
  }
  chat.ws.close();
} finally {
  cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`FAIL ${f.cfg} / ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
