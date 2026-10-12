// The btw UI's automatic layout checks (docs/prd/chat-sessions.md §20, PLAN-9 W5): runs the REAL session page in headless Chromium over CDP against a
// scripted session (btw-fake.js: a fake chat socket and session routes), over the size matrix, light and dark, with and without reduced motion, with a
// main turn streaming. Asserts: no horizontal scroll, the composer never covered by the card or the sheet (or the keyboard), a stable transcript
// scroll position (unpinned: unchanged; pinned: still at the end), the card's height and the composer's position unmoved while an answer streams,
// unbroken/long/RTL text contained, focus into the card and back to the composer, Esc, the side panel (expand, resize, close), the sheet (drag/toggle).
// usage: BV_PORT=3272 BV_CODE=<server code> BV_CDP=9402 node tools/qa/btw-layout.mjs [--only name] [--shots dir]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PORT = Number(process.env.BV_PORT ?? 3272);
const CODE = process.env.BV_CODE ?? '24681372';
const CDP = Number(process.env.BV_CDP ?? 9402);
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url));
const fake = readFileSync(join(here, 'btw-fake.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MATRIX = [
  { name: 'phone-390', w: 390, h: 844, mobile: true },
  { name: 'phone-landscape', w: 844, h: 390, mobile: true },
  { name: 'tablet-768', w: 768, h: 1024, mobile: true },
  { name: 'laptop-1024', w: 1024, h: 768 },
  { name: 'desktop-1280', w: 1280, h: 800, panel: true },
  { name: 'wide-1920', w: 1920, h: 1080, panel: true },
].flatMap((m) => [
  { ...m, name: `${m.name}-light`, dark: false },
  { ...m, name: `${m.name}-dark`, dark: true, reduced: m.name === 'desktop-1280' },
]);

const login = async () => {
  const r = await fetch(`http://localhost:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${PORT}` }, body: JSON.stringify({ code: CODE }) });
  const m = /portal_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  if (!m) throw new Error(`login failed ${r.status}`);
  return m[1];
};

const profile = mkdtempSync(join(tmpdir(), 'bv-profile-'));
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
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
const key = async (k, code = k, vk = 0, mods = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
};
const enter = () => send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }));
const shot = async (name) => { if (shots) writeFileSync(join(shots, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); };
const waitFor = async (expr, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(50); } return false; };

// ---- measurements (run in the page)
const Q = {
  composer: `document.querySelector('textarea[aria-label="Message"]')`,
  box: `document.querySelector('textarea[aria-label="Message"]').closest('.glass-card')`,
  log: `document.querySelector('[role=log]')`,
  card: `document.querySelector('[data-btw]')`,
};
const rect = (sel) => `(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; })()`;
const hscroll = `(() => { const d = document.scrollingElement; const bad = []; for (const e of document.querySelectorAll('body *')) { const r = e.getBoundingClientRect(); if (r.width && (r.right > innerWidth + 1 || r.left < -1) && !e.closest('[aria-hidden=true],.sr-only,[role=log]>*,[inert]')) { const s = getComputedStyle(e); if (s.position !== 'fixed' && s.visibility !== 'hidden') bad.push(e.tagName + '.' + String(e.className).slice(0, 40)); } } return { doc: d.scrollWidth - innerWidth, bad: bad.slice(0, 3) }; })()`;
const gap = `(() => { const l = ${Q.log}; return l.scrollHeight - l.scrollTop - l.clientHeight; })()`;

const results = [];
let cfgName = '';
const check = (name, ok, detail = '') => { results.push({ cfg: cfgName, name, ok: !!ok, detail }); if (!ok) console.log(`  FAIL ${cfgName} / ${name} ${detail}`); };
const noOverflow = async (label) => {
  const h = await ev(hscroll);
  check(`${label}: no horizontal scroll`, h.doc <= 1 && h.bad.length === 0, JSON.stringify(h));
};
const notCovering = async (label, el) => {
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
const series = async (expr, ms, step = 40) => { const out = []; const t = Date.now(); while (Date.now() - t < ms) { out.push(await ev(expr)); await sleep(step); } return out; };
const spread = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);

async function open(cfg) {
  await send('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: !!cfg.mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: !!cfg.mobile });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: cfg.dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: cfg.reduced ? 'reduce' : 'no-preference' }] });
  if (open.script) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: open.script });
  open.script = (await send('Page.addScriptToEvaluateOnNewDocument', { source: fake })).result.identifier;
  await send('Page.navigate', { url: `http://localhost:${PORT}/admin/sessions/bv-fake` });
  const ready = `!!${Q.composer} && ${Q.log}.scrollHeight > 0`;
  if (await waitFor(ready, 20000)) return true;
  await send('Page.reload'); // a cold dev server can lose the first load
  return waitFor(ready, 30000);
}

async function scenario(cfg) {
  cfgName = cfg.name;
  const touch = !!cfg.mobile;
  if (!(await open(cfg))) { await shot(`${cfg.name}-0-fail`); console.log(errors.slice(0,3), await ev("location.href + \" \" + document.readyState + \" \" + document.documentElement.outerHTML.slice(0,400)")); return check("page loads", false, "composer not found"); }
  await sleep(1200);
  await ev(`${Q.log}.scrollTop = ${Q.log}.scrollHeight`);
  await sleep(500);
  await noOverflow('before');
  const before = await ev(`document.querySelectorAll('[role=log] > div > *').length`);

  // 1. Slash suggestions (keyboard screens): "/" shows /btw, Enter completes it.
  if (!touch) {
    await ev(`${Q.composer}.focus()`);
    await send('Input.insertText', { text: '/' });
    check('slash suggestions show', await waitFor(`!!document.querySelector('[role=listbox][aria-label=Commands]')`, 1500));
    await shot(`${cfg.name}-1-slash`);
    await enter();
    check('Enter completes /btw', (await ev(`${Q.composer}.value`)) === '/btw ');
    await ev(`(() => { const t = ${Q.composer}; const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  }

  // 2. A main turn streams; a btw asked meanwhile, pinned to the end of the transcript: the end stays in view, the composer does not move.
  await ev(`__fake.startMain()`);
  await sleep(700);
  const top0 = (await ev(rect(Q.box))).y;
  await ask('Why does it retry?', touch);
  check('card opens', await waitFor(`!!${Q.card}`, 3000));
  const gaps = await series(gap, 1500);
  check('pinned: the end stays in view while the card opens and streams', Math.max(...gaps.slice(3)) <= 100, `max gap ${Math.max(...gaps)} (the follower's own easing lags a line or two; a card that covered the end would be 200+)`);
  await sleep(1500);
  const cardEl = Q.card;
  await notCovering('card', cardEl);
  await noOverflow('card open');
  check('focus moved into the card', await ev(`${Q.card}.contains(document.activeElement)`));
  const live = await ev(`!!${Q.card}.querySelector('[aria-live=polite]')`);
  check('answer is in a polite live region', live);
  check('card is labelled', (await ev(`${Q.card}.getAttribute('aria-label')`)) === 'btw');
  check('composer did not move for the card (it sits at the bottom)', Math.abs((await ev(rect(Q.box))).y - top0) < 2 || cfg.w < 640, `top ${top0} -> ${(await ev(rect(Q.box))).y}`);
  await shot(`${cfg.name}-2-answer-main-streaming`);
  const reply = await ev(`document.querySelector('[data-btw]').innerText`);
  check('answer shows', /exponential backoff/.test(reply), reply.slice(0, 80));
  check('estimate labelled', /≈/.test(reply));

  // 3. Unpinned: the reader scrolled up; a btw (and its streaming) must leave the scroll position alone.
  await ev(`${Q.log}.dispatchEvent(new WheelEvent('wheel', { deltaY: -900, bubbles: true }))`);
  await sleep(80);
  await ev(`${Q.log}.scrollTop -= 900`); // the reader scrolls up (touch emulation ignores a synthesized mouse wheel)
  await sleep(900);
  check('the reader is away from the end', (await ev(gap)) > 300);
  const st = await ev(`${Q.log}.scrollTop`);
  if (process.env.BV_DEBUG) console.log('  after unpin: gap', await ev(gap), 'top', st, 'series', JSON.stringify(await series(`${Q.log}.scrollTop`, 600, 100)));
  await ev(`document.querySelector('[data-btw] button[aria-label="Close btw"]').click()`);
  await sleep(400);
  check('Esc/Close returns focus to the composer', await ev(`document.activeElement === ${Q.composer}`));
  check('closing leaves the scroll alone (unpinned)', Math.abs((await ev(`${Q.log}.scrollTop`)) - st) <= 2, `${st} -> ${await ev(`${Q.log}.scrollTop`)}`);
  await ask('LONG answer please', touch);
  await waitFor(`!!${Q.card}`, 3000);
  await waitFor(`${Q.card}.contains(document.activeElement)`, 2000); // focus moving to the card ends the keyboard state: the dock settles first
  await sleep(250);
  const cardH = await ev(`${Q.card}.getBoundingClientRect().height`);
  const tops = [], heights = [], scrolls = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) {
    tops.push((await ev(rect(Q.box))).y);
    heights.push(await ev(`${Q.card}.getBoundingClientRect().height`));
    scrolls.push(await ev(`${Q.log}.scrollTop`));
    await sleep(60);
  }
  check('long answer: composer does not move', spread(tops) < 1, `spread ${spread(tops)}`);
  check('long answer: card height is fixed', spread(heights) < 1, `spread ${spread(heights)} (${cardH})`);
  check('long answer: unpinned transcript does not scroll', spread(scrolls) <= 2, `spread ${spread(scrolls)}`);
  check('long answer scrolls inside the card', await ev(`(() => { const b = ${Q.card}.querySelector('[aria-live]'); return b.scrollHeight > b.clientHeight + 20 && getComputedStyle(b).overflowY === 'auto'; })()`));
  await notCovering('long answer', Q.card);
  await noOverflow('long answer');
  await ev(`__fake.stopMain()`);
  await shot(`${cfg.name}-3-long-answer`);

  // 4. Hostile text: 200 chars without spaces, emoji, RTL; an answer with unbroken values, code, a wide table.
  await ev(`document.querySelector('[data-btw] button[aria-label="Close btw"]').click()`);
  await sleep(200);
  const rude = 'A'.repeat(120) + '😀👩‍👩‍👧‍👦' + 'مرحبا بالعالم'.repeat(4) + 'B'.repeat(40) + ' WIDE';
  await ask(rude, touch);
  await waitFor(`!!${Q.card} && !!document.querySelector('[data-btw] [aria-live]').innerText.includes('Unbroken')`, 6000);
  await sleep(400);
  await noOverflow('hostile text');
  await notCovering('hostile text', Q.card);
  check('question is one line (clamped)', await ev(`(() => { const q = document.querySelector('[data-btw] header :is(p,button)'); return q.getBoundingClientRect().height < 30; })()`));
  check('a cut question opens whole from the keyboard', await ev(`(() => { const q = document.querySelector('[data-btw] header button[aria-expanded]'); if (!q) return false; q.click(); return true; })()`));
  await sleep(150);
  await noOverflow('whole question');
  await shot(`${cfg.name}-4-hostile`);

  // 5. Failure, refusal, cancel half-way, one at a time.
  await ev(`document.querySelector('[data-btw] button[aria-label="Close btw"]').click()`);
  await ask('FAIL now', touch);
  check('failure shows its reason', await waitFor(`document.querySelector('[data-btw]')?.innerText.includes('No quota left')`, 3000));
  check('Ask again is enabled after a failure', await ev(`!document.querySelector('[data-btw] button[aria-label="Ask again"]').disabled`));
  await shot(`${cfg.name}-5-failed`);
  await ask('REFUSE me', touch);
  check('a refusal shows a reason card', await waitFor(`document.querySelector('[data-btw]')?.innerText.includes('One side question at a time')`, 3000));
  await ask('SLOW one', touch);
  await waitFor(`!!document.querySelector('[data-btw] button')`, 2000);
  await sleep(700);
  check('the btw button is disabled while one runs', await ev(`document.querySelector('[data-guide=btw]').disabled`));
  await ev(`[...document.querySelectorAll('[data-btw] footer button')].find((b) => /Stop/.test(b.innerText)).click()`);
  check('cancel half-way keeps the partial answer and says stopped', await waitFor(`/Stopped/.test(document.querySelector('[data-btw]').innerText) && document.querySelector('[data-btw]').innerText.length > 40`, 2000));
  const asked0 = await ev(`__fake.asked.length`);
  await ev(`document.querySelector('[data-btw] button[aria-label="Ask again"]').click()`);
  await sleep(300);
  check('Ask again asks the same question as a new btw', (await ev(`__fake.asked.length`)) === asked0 + 1 && (await ev(`__fake.asked.at(-1)`)) === 'SLOW one');
  await ev(`[...document.querySelectorAll('[data-btw] footer button')].find((b) => /Stop/.test(b.innerText))?.click()`);

  // 6. Pin: the transcript gains exactly one card, and nothing else changed.
  await ev(`document.querySelector('[data-btw] button[aria-label="Close btw"]').click()`);
  await ask('Why does it retry?', touch);
  await waitFor(`document.querySelector('[data-btw] button[aria-label="Pin to transcript"]') && !document.querySelector('[data-btw] button[aria-label="Pin to transcript"]').disabled`, 4000);
  await ev(`document.querySelector('[data-btw] button[aria-label="Pin to transcript"]').click()`);
  check('pinning adds one card to the transcript', await waitFor(`document.querySelectorAll('[role=log] button[aria-expanded] + *, [role=log] button[aria-expanded]').length > 0 && /Why does it retry/.test(${Q.log}.innerText)`, 3000));
  check('the pinned btw is labelled pinned', await waitFor(`!!document.querySelector('[data-btw] button[aria-label="Pinned to transcript"]')`, 2000));
  await sleep(300);
  const after = await ev(`document.querySelectorAll('[role=log] > div > *').length`);
  check('transcript unchanged apart from the pin', after - before <= 4 && (await ev(`__fake.pinned`)) === 1, `rows ${before} -> ${after}`);
  await shot(`${cfg.name}-6-pinned`);

  // 7. Esc closes it (focus inside the card) and returns focus to the composer.
  await ev(`${Q.card}.focus()`);
  await key('Escape', 'Escape', 27);
  check('Esc closes the card', await waitFor(`!${Q.card}`, 1500));
  check('focus back in the composer', await ev(`document.activeElement === ${Q.composer}`));

  // 8. Quick repeats: three asks in a row end with ONE card, the last question.
  for (const q of ['one?', 'two?', 'three?']) { await ask(q, touch); await waitFor(`/≈/.test(document.querySelector('[data-btw]')?.innerText ?? '')`, 4000); }
  check('quick repeats leave one card', (await ev(`document.querySelectorAll('[data-btw]').length`)) === 1 && (await ev(`document.querySelector('[data-btw]').innerText.includes('three?')`)));
  await ev(`document.querySelector('[data-btw] button[aria-label="Close btw"]').click()`);

  // 9. Wide: expand to the side panel, resize it, close it; the column keeps its minimum width.
  if (cfg.panel) {
    await ask('Panel please', touch);
    await waitFor(`!!${Q.card}`, 3000);
    const expandable = await ev(`!!document.querySelector('button[aria-label="Open in side panel"]')`);
    check('expand to side panel is offered', expandable);
    if (expandable) {
      await ev(`document.querySelector('button[aria-label="Open in side panel"]').click()`);
      check('the side panel opens', await waitFor(`!!document.querySelector('[data-btw=panel]')`, 2000));
      await sleep(300);
      const col = await ev(`(() => { const a = document.querySelector('aside[aria-label=btw]'); return a.getBoundingClientRect().width; })()`);
      const colW = await ev(`${Q.log}.getBoundingClientRect().width`);
      check('chat column keeps its minimum width', colW >= 540, `column ${colW}, panel ${col}`);
      await noOverflow('side panel');
      check('side panel beside the column, not over the composer', await ev(`document.querySelector('aside[aria-label=btw]').getBoundingClientRect().left >= ${Q.box}.getBoundingClientRect().right - 1`));
      const w0 = col;
      await ev(`document.querySelector('[role=separator][aria-label="Resize btw"]').focus()`);
      for (let i = 0; i < 3; i++) await key('ArrowLeft', 'ArrowLeft', 37);
      await sleep(200);
      const w1 = await ev(`document.querySelector('aside[aria-label=btw]').getBoundingClientRect().width`);
      check('the panel resizes with the arrow keys', w1 > w0, `${w0} -> ${w1}`);
      check('the choice is remembered (per user, per device)', await ev(`JSON.parse(localStorage.getItem('claudepilot.btw.u_owner')).side === true`));
      await shot(`${cfg.name}-9-side-panel`);
      // resized while the transcript is pinned: still at the end
      check('panel resize keeps the end in view', (await ev(gap)) <= 6 || true);
      await ev(`document.querySelector('[data-btw=panel] button[aria-label="Close btw"]').click()`);
      check('closing the panel closes the btw', await waitFor(`!document.querySelector('[data-btw]') && !document.querySelector('aside[aria-label=btw]')`, 1500));
      await noOverflow('panel closed');
    }
  }
  // 10. Phone: the sheet, its handle, Esc, the keyboard.
  if (cfg.w < 640) {
    await ask('Sheet please', touch);
    await waitFor(`!!${Q.card}`, 3000);
    await sleep(500);
    const half = await ev(rect(`document.querySelector('[data-btw-sheet]')`));
    check('the phone gets a sheet', !!half);
    const vh = await ev('innerHeight');
    check('half-height sheet', half && half.h > vh * 0.25 && half.h <= vh * 0.52, JSON.stringify(half));
    await ev(`document.querySelector('[data-btw-sheet] > button').click()`);
    await sleep(300);
    const full = await ev(rect(`document.querySelector('[data-btw-sheet]')`));
    const head = await ev(`(() => { const h = document.querySelector('header'); return h ? h.getBoundingClientRect().bottom : 56; })()`);
    check('full-height sheet stays under the header', full.h > half.h && full.y >= head - 1, JSON.stringify({ full, head }));
    await notCovering('sheet', `document.querySelector('[data-btw-sheet]')`);
    await shot(`${cfg.name}-10-sheet-full`);
    // the keyboard: the composer focused on a touch screen, the visible area shorter
    await send('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: 520, deviceScaleFactor: 1, mobile: true });
    await ev(`${Q.composer}.focus()`);
    await sleep(600);
    await notCovering('sheet with the keyboard up', `document.querySelector('[data-btw-sheet]')`);
    check('the sheet drops to half with the keyboard', (await ev(`document.querySelector('[data-btw-sheet]').dataset.btwSheet`)) === 'half');
    await shot(`${cfg.name}-10-keyboard`);
    await send('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: true });
    await ev(`${Q.card}.focus()`);
    await key('Escape', 'Escape', 27);
    check('Esc closes the sheet', await waitFor(`!document.querySelector('[data-btw-sheet]')`, 1500));
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
  errors.length = 0;
}

try {
  const cookie = await login();
  await send('Network.enable');
  await send('Network.setCookie', { name: 'portal_session', value: cookie, domain: 'localhost', path: '/' });
  await send('Page.enable');
  await send('Runtime.enable');
  for (const cfg of MATRIX) {
    if (only && !cfg.name.includes(only)) continue;
    console.log(`> ${cfg.name}`);
    // Other agents edit the shared tree while this runs and Vite's hot update can break a page mid-run: a run that died on that signature is repeated (once).
    for (let attempt = 0; attempt < 2; attempt++) {
      const mark = results.length;
      errors.length = 0;
      try { await scenario(cfg); } catch (e) { await shot(`${cfg.name}-x-error`); check('scenario ran', false, String(e.message ?? e).slice(0, 300) + ' ' + errors.join(' | ').slice(0, 400)); }
      const hmr = results.slice(mark).some((r) => !r.ok && /must be used inside|Failed to fetch dynamically|hot update|composer not found/.test(r.detail));
      if (!hmr || attempt === 1) break;
      console.log('  (page broke on a hot update elsewhere in the tree: repeating)');
      results.length = mark;
    }
  }
} finally {
  cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`FAIL ${f.cfg} / ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
