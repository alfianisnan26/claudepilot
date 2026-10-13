// The session screen's chrome on phones and desktops (docs/prd/chat-sessions.md §12.3-12.4, docs/prd/web-app-pwa.md §9.1): runs the REAL
// session page in headless Chromium over CDP against a scripted session (btw-fake.js), with the iPhone's safe areas emulated
// (Emulation.setSafeAreaInsetsOverride: 59 px top, 34 px bottom in portrait), and asserts:
//   - Bypass does not squash the composer: its box, its row and the model chip are the same with Bypass on and off, keyboard down and up;
//   - the composer floats the same gap from the left, right and bottom edges of the screen (the physical edge, home indicator or not),
//     keyboard down and up; the floating header is inset by the same gap and sits under the status bar; the phone tab bar likewise;
//   - the transcript runs under the header and the status bar (it scrolls from the top of the screen);
//   - the context ring: the same box in every state, the percentage only when the window size is known, an empty ring otherwise;
//   - the permission picker lists Plan, Manual, Edit, Auto and Bypass, each on one line, inside the screen at 390 px;
//   - no horizontal scroll; no page errors;
//   - text on the glass (header, composer, tab bar) and the white status-bar text over the band under it keep 4.5:1 over solid black, solid
//     white and black/white stripes scrolled under them: the pixels behind the text are SAMPLED from a screenshot with the text made
//     transparent, so blur, saturation and the backdrop squeeze are all in the number.
// usage: SC_PORT=3405 SC_CODE=<server code> SC_CDP=9605 node tools/qa/session-chrome.mjs [--only name] [--shots dir]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import WebSocket from 'ws';

const PORT = Number(process.env.SC_PORT ?? 3405);
const CODE = process.env.SC_CODE ?? '24681372';
const CDP = Number(process.env.SC_CDP ?? 9605);
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url));
const fake = readFileSync(join(here, 'btw-fake.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHONE = { top: 59, bottom: 34, left: 0, right: 0 };
const MATRIX = [
  { name: 'phone-390-light', w: 390, h: 844, mobile: true, insets: PHONE },
  { name: 'phone-390-dark', w: 390, h: 844, mobile: true, insets: PHONE, dark: true },
  { name: 'phone-375-light', w: 375, h: 667, mobile: true, insets: { top: 20, bottom: 0, left: 0, right: 0 } },
  { name: 'phone-landscape-dark', w: 844, h: 390, mobile: true, insets: { top: 0, bottom: 21, left: 59, right: 59 }, dark: true },
  { name: 'desktop-1280-light', w: 1280, h: 800 },
  { name: 'desktop-1280-dark', w: 1280, h: 800, dark: true },
];

const login = async () => {
  const r = await fetch(`http://localhost:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${PORT}` }, body: JSON.stringify({ code: CODE }) });
  const m = /portal_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  if (!m) throw new Error(`login failed ${r.status}`);
  return m[1];
};

const profile = mkdtempSync(join(tmpdir(), 'ux-sc-profile-'));
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
const shot = async (name) => { if (shots) writeFileSync(join(shots, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); };
const waitFor = async (expr, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(50); } return false; };

// ---- a small PNG decoder (8-bit RGB/RGBA, non-interlaced: what Chromium writes), for sampling pixels
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp, raw = inflateSync(Buffer.concat(idat)), out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0, b = y ? out[row - stride + x] : 0, c = x >= bpp && y ? out[row - stride + x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      out[row + x] = (src[x] + pred) & 255;
    }
  }
  return { w, h, px: (x, y) => { const i = Math.round(y) * stride + Math.round(x) * bpp; return [out[i], out[i + 1], out[i + 2]]; } };
}
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// ---- measurements (run in the page)
const Q = {
  composer: `document.querySelector('textarea[aria-label="Message"]')`,
  box: `document.querySelector('textarea[aria-label="Message"]').closest('.glass-card')`,
  header: `document.querySelector('[data-session-header]')`,
  model: `document.querySelector('button[aria-label^="Model and effort"]')`,
  mode: `document.querySelector('button[aria-label^="Permission mode"]')`,
  ring: `document.querySelector('[data-context-ring]')`,
  log: `document.querySelector('[role=log]')`,
};
const rect = (sel) => `(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; })()`;
const view = `({ w: innerWidth, h: visualViewport.height + visualViewport.offsetTop })`;
const hscroll = `(() => { const bad = []; for (const e of document.querySelectorAll('body *')) { const r = e.getBoundingClientRect(); if (r.width && (r.right > innerWidth + 1 || r.left < -1) && !e.closest('[aria-hidden=true],.sr-only,[role=log]>*,[inert]')) { const s = getComputedStyle(e); if (s.position !== 'fixed' && s.visibility !== 'hidden') bad.push(e.tagName + '.' + String(e.className).slice(0, 40)); } } return { doc: document.scrollingElement.scrollWidth - innerWidth, bad: bad.slice(0, 3) }; })()`;

const results = [];
let cfgName = '';
const check = (name, ok, detail = '') => { results.push({ cfg: cfgName, name, ok: !!ok, detail }); if (!ok) console.log(`  FAIL ${cfgName} / ${name} ${detail}`); };
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const same = (a, b) => !!a && !!b && ['x', 'y', 'w', 'h'].every((k) => near(a[k], b[k]));

// The harness's own routes, layered over btw-fake's: where Bypass stands (so the picker shows its row).
const harness = `(() => {
  const real = window.fetch;
  window.fetch = (input, init) => {
    const p = new URL(typeof input === 'string' ? input : input.url, location.origin).pathname;
    if (p.endsWith('/bypass') && (!init || !init.method || init.method === 'GET'))
      return Promise.resolve(new Response(JSON.stringify({ data: { allowed: true, capable: true, active: false, busy: false, reauthed: true, facts: { workspace: 'bv-ws', isolated: true, network: 'open', credentials: [] } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
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
  const ready = `!!${Q.composer} && !!${Q.header} && ${Q.log}.scrollHeight > 0`;
  if (!(await waitFor(ready, 20000))) { await send('Page.reload'); if (!(await waitFor(ready, 30000))) return false; }
  await sleep(700);
  await ev(`${Q.log}.scrollTop = ${Q.log}.scrollHeight`);
  await sleep(300);
  return true;
}
const geometry = async () => ({ box: await ev(rect(Q.box)), header: await ev(rect(Q.header)), model: await ev(rect(Q.model)), mode: await ev(rect(Q.mode)), ring: await ev(rect(Q.ring)), view: await ev(view) });
const keyboard = async (cfg, up) => {
  // An on-screen keyboard: the composer focused on a touch screen and the visible area shorter.
  if (up) { await send('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: Math.round(cfg.h * 0.55), deviceScaleFactor: 1, mobile: true }); await send('Emulation.setSafeAreaInsetsOverride', { insets: { ...cfg.insets, bottom: 0 } }); await ev(`${Q.composer}.focus()`); }
  else { await ev(`document.activeElement?.blur()`); await send('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: !!cfg.mobile }); await send('Emulation.setSafeAreaInsetsOverride', { insets: cfg.insets }); }
  await sleep(500);
};

const BASE = { model: 'claude-opus-5-5', effort: 'medium', context: { usedTokens: 84_000, windowTokens: 200_000 }, bypassCapable: true };

async function scenario(cfg) {
  cfgName = cfg.name;
  await setup(cfg);
  if (!(await openSession({ ...BASE, mode: 'default' }))) return check('page loads', false, errors.join(' | '));
  const phone = cfg.w < 640;
  const ins = cfg.insets ?? { top: 0, bottom: 0, left: 0, right: 0 };

  // 1. Bypass off vs on (live, the same page): nothing in the composer or the header moves or shrinks.
  const off = await geometry();
  await shot(`${cfg.name}-1-default`);
  await ev(`__fake.patch({ mode: 'bypassPermissions' })`);
  await sleep(400);
  const on = await geometry();
  await shot(`${cfg.name}-1-bypass`);
  check('Bypass: composer box unchanged', same(off.box, on.box), JSON.stringify({ off: off.box, on: on.box }));
  check('Bypass: model chip not squashed', same(off.model, on.model) && on.model.w >= 64, JSON.stringify({ off: off.model, on: on.model }));
  // From 640 px the chip names the mode, so only phones (an icon of a fixed size) keep the very same box.
  if (phone) check('Bypass: mode chip same box', same(off.mode, on.mode), JSON.stringify({ off: off.mode, on: on.mode }));
  check('Bypass: header box unchanged', same(off.header, on.header), JSON.stringify({ off: off.header, on: on.header }));
  check('Bypass: title keeps room', (await ev(`document.querySelector('[data-session-header] button[aria-haspopup=dialog]').getBoundingClientRect().width`)) >= (phone ? 120 : 200));
  check('Bypass: the header says so', await ev(`!!document.querySelector('[data-session-header] button[aria-label^="Bypass is on"]')`));

  // 2. Symmetry: the composer's gap to the left, right and bottom edge of the screen is one number; the header's sides match it.
  const g = on;
  // The chat column (a side panel may sit beside it from 1280 px): the transcript's box.
  const col = await ev(rect(Q.log));
  const left = g.box.x - col.x, right = col.r - g.box.r, bottom = g.view.h - g.box.b;
  const gap = await ev(`parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar-gap')) * (getComputedStyle(document.documentElement).getPropertyValue('--bar-gap').includes('rem') ? parseFloat(getComputedStyle(document.documentElement).fontSize) : 1)`);
  if (phone && !ins.left) {
    check('composer: left gap = right gap = bottom gap (screen edge)', near(left, right) && near(left, bottom), JSON.stringify({ left, right, bottom }));
    check('header: same side gaps as the composer', near(g.header.x, left) && near(g.view.w - g.header.r, right), JSON.stringify(g.header));
  } else {
    check('composer: left gap = right gap', near(left, right), JSON.stringify({ left, right }));
    check('composer: bottom gap is the bar gap', near(bottom, gap), JSON.stringify({ bottom, gap }));
    if (ins.left) check('composer clears the side insets', left >= ins.left - 1 && right >= ins.right - 1, JSON.stringify({ left, right, ins }));
  }
  check('header: under the status bar, floating', near(g.header.y, Math.max(gap, ins.top)), JSON.stringify({ y: g.header.y, top: ins.top, gap }));
  const log = await ev(rect(Q.log));
  check('the transcript runs under the header and the status bar', log.y <= 0.5, JSON.stringify(log));
  check('no horizontal scroll', (await ev(hscroll)).doc <= 1, JSON.stringify(await ev(hscroll)));

  // 3. Keyboard up (touch screens): the same box with Bypass on and off, and the same gap under it as beside it.
  if (cfg.mobile) {
    await keyboard(cfg, true);
    const kOn = await geometry();
    await ev(`__fake.patch({ mode: 'default' })`);
    await sleep(400);
    const kOff = await geometry();
    await shot(`${cfg.name}-3-keyboard`);
    check('keyboard up: composer box the same, Bypass on or off', same(kOn.box, kOff.box) && same(kOn.model, kOff.model), JSON.stringify({ on: kOn.box, off: kOff.box }));
    check('keyboard up: gap under the composer = its side gap', near(kOff.view.h - kOff.box.b, kOff.box.x) || ins.left > 0, JSON.stringify({ under: kOff.view.h - kOff.box.b, side: kOff.box.x }));
    check('keyboard up: the header stays on screen', kOff.header.y >= 0 && kOff.header.y < 80, JSON.stringify(kOff.header));
    await keyboard(cfg, false);
    const back = await geometry();
    check('keyboard down again: composer back where it was', same(back.box, off.box), JSON.stringify({ back: back.box, before: off.box }));
  } else await ev(`__fake.patch({ mode: 'default' })`);

  // 4. The context ring: the same box in every state; the number only when there is a window size to divide by.
  const ringStates = [
    [{ usedTokens: 84_000, windowTokens: 200_000 }, 'accent', '42'],
    [{ usedTokens: 170_000, windowTokens: 200_000 }, 'gold', '85'],
    [{ usedTokens: 199_000, windowTokens: 200_000 }, 'danger', '100'],
    [{ usedTokens: 84_000, windowTokens: null }, 'none', ''],
    [null, 'none', ''],
  ];
  const ring0 = await ev(rect(Q.ring));
  for (const [context, tone, text] of ringStates) {
    await ev(`__fake.patch({ context: ${JSON.stringify(context)} })`);
    await sleep(150);
    const r = await ev(rect(Q.ring));
    const got = await ev(`({ tone: ${Q.ring}.dataset.contextRing, text: ${Q.ring}.querySelector('button').innerText.trim(), label: ${Q.ring}.querySelector('button').getAttribute('aria-label') })`);
    check(`ring ${JSON.stringify(context)}: tone ${tone}, shows "${text}"`, got.tone === tone && got.text === text && same(r, ring0), JSON.stringify({ got, r }));
  }
  check('ring: unknown says so, invents nothing', /not reported/.test(await ev(`${Q.ring}.querySelector('button').getAttribute('aria-label')`)));
  await ev(`__fake.patch({ context: ${JSON.stringify(BASE.context)} })`);

  // 5. The permission picker: five modes, each on one line, inside the screen.
  await ev(`${Q.mode}.click()`);
  await waitFor(`document.querySelectorAll('[role=radiogroup][aria-label="Permission mode"] [role=radio]').length >= 5`, 3000);
  await sleep(400);
  const picker = await ev(`(() => { const rows = [...document.querySelectorAll('[role=radiogroup][aria-label="Permission mode"] [role=radio]')]; const dlg = rows[0]?.closest('[role=dialog]'); const d = dlg?.getBoundingClientRect();
    return { labels: rows.map((r) => r.querySelector('span > span').innerText), lines: rows.map((r) => Math.round(r.querySelector('span > span').getBoundingClientRect().height)), dialog: d && { y: d.y, b: d.bottom, x: d.x, r: d.right }, h: innerHeight, w: innerWidth }; })()`);
  await shot(`${cfg.name}-5-picker`);
  check('picker: Plan, Manual, Edit, Auto, Bypass', ['Plan', 'Manual', 'Edit', 'Auto', 'Bypass'].every((l) => picker.labels.includes(l)), JSON.stringify(picker.labels));
  check('picker: each label on one line', picker.lines.every((h) => h <= 24), JSON.stringify(picker.lines));
  check('picker: inside the screen', picker.dialog && picker.dialog.y >= -1 && picker.dialog.b <= picker.h + 1 && picker.dialog.x >= -1 && picker.dialog.r <= picker.w + 1, JSON.stringify(picker));
  check('picker: no horizontal scroll', (await ev(hscroll)).doc <= 1);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);

  // 6. Contrast on the glass over the worst backgrounds, sampled from pixels.
  await contrast(cfg, 'session', ['[data-session-header]', '[data-composer]']);

  // 7. The phone tab bar on a page with one: floating, symmetric, the same glass.
  if (phone) {
    await send('Page.navigate', { url: `http://localhost:${PORT}/admin/workspaces` });
    if (await waitFor(`!!document.querySelector('[data-tabbar]')`, 15000)) {
      await sleep(800);
      const t = await ev(rect(`document.querySelector('[data-tabbar]')`));
      const v = await ev(view);
      const [tl, tr, tb] = [t.x, v.w - t.r, v.h - t.b];
      check('tab bar: left gap = right gap = bottom gap (screen edge)', near(tl, tr) && near(tl, tb), JSON.stringify({ tl, tr, tb }));
      check('tab bar: the same gap as the composer', near(tl, left), JSON.stringify({ tl, composer: left }));
      check('tab bar: no horizontal scroll', (await ev(hscroll)).doc <= 1);
      await shot(`${cfg.name}-7-tabbar`);
      await contrast(cfg, 'tabbar', ['[data-tabbar]']);
    } else check('tab bar shows', false);
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
  errors.length = 0;
}

/**
 * Puts a solid black, a solid white and a striped layer under the bars (in the page, under the glass), makes every text and icon in
 * the bars transparent, screenshots, and compares each text's colour with the pixels sampled where it sits; the white status-bar
 * text (the band under the status bar, top 59 px) is checked the same way. 4.5:1 for text, 3:1 for icons.
 */
async function contrast(cfg, label, bars) {
  const fills = { black: '#000', white: '#fff', stripes: 'repeating-linear-gradient(0deg,#000 0 6px,#fff 6px 12px)' };
  const worst = [];
  // Colours are read while nothing transitions (a chip's transition-colors would hand back a half-way colour).
  await ev(`(() => { const st = document.createElement('style'); st.id = '__still'; st.textContent = ${JSON.stringify(JSON.stringify(bars.map((b) => `${b}, ${b} *`).join(',') + '{transition:none!important}'))}; document.head.appendChild(st); })()`);
  await sleep(100);
  let items = null;
  for (const [fillName, fill] of Object.entries(fills)) {
    // What is read (colours, places) is read once, before anything is hidden; each fill only changes what is under the glass.
    const read = await ev(`(() => {
      const under = document.createElement('div'); under.id = '__under'; under.style.cssText = 'position:fixed;inset:0;z-index:1;background:${fill}';
      (document.querySelector('[role=log]')?.parentElement ?? document.querySelector('main') ?? document.body).appendChild(under);
      if (${items ? 1 : 0}) return null;
      const out = [];
      for (const sel of ${JSON.stringify(bars)}) {
        const bar = document.querySelector(sel); if (!bar) continue;
        for (const el of bar.querySelectorAll('*')) {
          const s = getComputedStyle(el); const r = el.getBoundingClientRect();
          let o = 1; for (let e = el; e; e = e.parentElement) o *= +getComputedStyle(e).opacity;
          if (!r.width || o < 0.05 || s.visibility === 'hidden' || s.display === 'none' || el.closest('.sr-only,[disabled]') || (el.tagName !== 'svg' && el.closest('[aria-hidden=true]'))) continue;
          const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
          if (el.tagName === 'TEXTAREA' && !el.value) { const ph = getComputedStyle(el, '::placeholder'); out.push({ kind: 'text', what: 'placeholder', color: ph.color, x: r.x + 24, y: r.y + r.height / 2, need: 4.5 }); continue; }
          if (own) out.push({ kind: 'text', what: el.innerText.trim().slice(0, 24), color: s.color, x: r.x + 3, y: r.y + r.height / 2, x2: r.right - 3, need: parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && +s.fontWeight >= 700) ? 3 : 4.5 });
          else if (el.tagName === 'svg' && !el.closest('[data-context-ring]')) out.push({ kind: 'icon', what: (el.closest('[aria-label]')?.getAttribute('aria-label') ?? 'icon').slice(0, 24), color: s.color, x: r.x + r.width / 2, y: r.y + r.height / 2, need: 3 });
        }
      }
      return out;
    })()`);
    items ??= read;
    await ev(`(() => {
      const st = document.createElement('style'); st.id = '__hide'; st.textContent = ${JSON.stringify(bars.map((b) => `${b} *`).join(','))} + '{color:transparent!important;caret-color:transparent!important} ' + ${JSON.stringify(bars.map((b) => `${b} svg`).join(','))} + '{visibility:hidden!important} ' + ${JSON.stringify(bars.map((b) => `${b} textarea::placeholder`).join(','))} + '{color:transparent!important}';
      document.head.appendChild(st);
    })()`);
    await sleep(350);
    const png = decodePng(Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
    if (shots) writeFileSync(join(shots, `${cfg.name}-6-${label}-under-${fillName}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
    await ev(`document.getElementById('__under')?.remove(); document.getElementById('__hide')?.remove()`);
    const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { rgb: p.slice(0, 3), a: p[3] ?? 1 }; };
    for (const it of items) {
      const fg = parse(it.color);
      // Where the text sits: the darkest/lightest of a few samples across it (stripes give both).
      const xs = it.x2 ? [it.x, (it.x + it.x2) / 2, it.x2] : [it.x];
      let min = Infinity, pick = null;
      for (const x of xs) for (const dy of [-3, 0, 3]) {
        const bg = png.px(Math.max(0, Math.min(png.w - 1, x)), Math.max(0, Math.min(png.h - 1, it.y + dy)));
        const eff = fg.rgb.map((v, i) => v * fg.a + bg[i] * (1 - fg.a));
        const cr = ratio(eff, bg);
        if (cr < min) { min = cr; pick = bg; }
      }
      worst.push({ ...it, fill: fillName, ratio: min, bg: pick });
    }
    // The status-bar band: white text over what is sampled at the clock's place.
    if (cfg.insets?.top > 20 && label === 'session') {
      let min = Infinity;
      for (const x of [30, 60, cfg.w - 60]) for (const y of [cfg.insets.top * 0.3, cfg.insets.top * 0.5, cfg.insets.top * 0.7]) min = Math.min(min, ratio([255, 255, 255], png.px(x, y)));
      worst.push({ kind: 'text', what: 'status bar (white)', fill: fillName, ratio: min, need: 4.5 });
    }
  }
  await ev(`document.getElementById('__still')?.remove()`);
  const bad = worst.filter((w) => w.ratio < w.need);
  const low = worst.reduce((a, b) => (b.ratio / b.need < a.ratio / a.need ? b : a), worst[0] ?? { ratio: 99, need: 1 });
  check(`${label}: contrast over black, white and stripes (lowest ${low.ratio?.toFixed(2)}:1 "${low.what}" on ${low.fill})`, bad.length === 0 && worst.length > 3,
    JSON.stringify(bad.slice(0, 6).map((b) => [b.what, b.fill, b.ratio.toFixed(2), b.need, b.color, b.bg])));
  if (process.env.SC_DEBUG) for (const w of worst) console.log('   ', label, w.fill, w.kind, JSON.stringify(w.what), w.ratio.toFixed(2), w.color);
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
    errors.length = 0;
    try { await scenario(cfg); } catch (e) { await shot(`${cfg.name}-x-error`); check('scenario ran', false, String(e.message ?? e).slice(0, 300) + ' ' + errors.join(' | ').slice(0, 400)); }
  }
} finally {
  // Chromium writes to its profile for a moment after the kill: remove it once it has gone.
  try { chrome.kill(); } catch {}
  await new Promise((r) => (chrome.exitCode !== null || chrome.signalCode !== null ? r() : chrome.once('exit', r)));
  cleanup();
}
const failed = results.filter((r) => !r.ok);
for (const r of results.filter((x) => x.ok && /contrast/.test(x.name))) console.log(`  ok ${r.cfg} / ${r.name}`);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`FAIL ${f.cfg} / ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
