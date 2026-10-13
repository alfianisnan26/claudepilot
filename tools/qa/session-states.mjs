// The session screen's chrome in every state (docs/prd/web-app-pwa.md §10.5, docs/prd/chat-sessions.md §12.3, track C item 2): the sibling of
// session-chrome.mjs (which owns the gaps, Bypass's squash and the glass's contrast), over the size matrix 360, 390, 430, phone landscape, 768 and
// 1280 px, light and dark, with the iPhone's safe areas emulated. Runs the REAL session page against a scripted session (btw-fake.js) and puts it
// in each state: idle, a long title with Bypass on while it works, the six modes the chip can show, an approval waiting (a long one), a session
// that restarts (the "Tools changed" chip, the restart under way, the chip gone), an interrupted one with a long reason, the btw sheet (half and
// full, with an approval under it), each with the keyboard down and, on touch screens, up. In every state it asserts:
//   - nothing scrolls sideways; the page itself never scrolls (one scroller: the transcript; the approval text and the btw answer are their own);
//   - the header: 52 px, inside the screen, its controls inside it, none overlapping another, 44 px targets on touch screens;
//   - the stack above the composer (approval, btw card, glance, Tools changed, Resume, the composer) never reaches under the header, and each
//     piece is inside the screen; the composer's controls do not overlap; the approval's Deny is on screen;
//   - the transcript's last line can sit above the stack and its first line below the header (nothing hides behind the glass for good);
//   - the btw sheet starts below the header and is tall enough to read;
//   - the composer does not move or change size when the state changes (working, a mode, the chip coming and going), only when what is above
//     it is meant to grow.
// usage: SS_PORT=3415 SS_CODE=<server code> SS_CDP=9615 node tools/qa/session-states.mjs [--only name] [--state name] [--shots dir]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PORT = Number(process.env.SS_PORT ?? 3415);
const CODE = process.env.SS_CODE ?? '24681372';
const CDP = Number(process.env.SS_CDP ?? 9615);
const args = process.argv.slice(2);
const arg = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const only = arg('--only');
const onlyState = arg('--state');
const shots = arg('--shots');
if (shots) mkdirSync(shots, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url));
const fake = readFileSync(join(here, 'btw-fake.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IPHONE = { top: 59, bottom: 34, left: 0, right: 0 };
const SIZES = [
  // A small Android phone, edge to edge (gesture bar).
  { name: '360', w: 360, h: 740, mobile: true, insets: { top: 24, bottom: 16, left: 0, right: 0 } },
  { name: '390', w: 390, h: 844, mobile: true, insets: IPHONE },
  { name: '430', w: 430, h: 932, mobile: true, insets: IPHONE },
  { name: 'landscape', w: 844, h: 390, mobile: true, insets: { top: 0, bottom: 21, left: 59, right: 59 } },
  { name: '768', w: 768, h: 1024, mobile: true, insets: { top: 24, bottom: 20, left: 0, right: 0 } },
  { name: '1280', w: 1280, h: 800 },
];
const MATRIX = SIZES.flatMap((s) => [{ ...s, name: `${s.name}-light` }, { ...s, name: `${s.name}-dark`, dark: true }]);

const login = async () => {
  const r = await fetch(`http://localhost:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${PORT}` }, body: JSON.stringify({ code: CODE }) });
  const m = /portal_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  if (!m) throw new Error(`login failed ${r.status}`);
  return m[1];
};

const profile = mkdtempSync(join(tmpdir(), 'ux-ss-profile-'));
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

const Q = {
  composer: `document.querySelector('textarea[aria-label="Message"]')`,
  box: `document.querySelector('[data-composer]')`,
  header: `document.querySelector('[data-session-header]')`,
  log: `document.querySelector('[role=log]')`,
};
const rect = (sel) => `(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; })()`;

/** Everything measured at once, in the page. */
const MEASURE = `(() => {
  const R = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; };
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && +s.opacity > 0.05; };
  const name = (e) => (e.getAttribute('aria-label') || e.innerText || e.tagName).trim().replace(/\\s+/g, ' ').slice(0, 30);
  const view = { w: innerWidth, h: visualViewport.height + visualViewport.offsetTop };
  const header = document.querySelector('[data-session-header]');
  const dock = document.querySelector('[data-session-dock]');
  const box = document.querySelector('[data-composer]');
  // The pieces stacked above the composer: the dock's column's children (the composer's own wrapper included).
  const col = dock?.firstElementChild;
  const stack = col ? [...col.children].filter(vis).map((e) => ({ what: e.getAttribute('aria-label') || e.getAttribute('role') || (e.contains(box) ? 'composer' : e.tagName.toLowerCase()), ...R(e) })) : [];
  const controls = (root) => root ? [...root.querySelectorAll('a[href], button, [role=button], input:not([type=file]):not([hidden]), textarea')].filter(vis).filter((e) => !e.closest('[role=menu],[role=listbox],[aria-hidden=true]')).map((e) => ({ what: name(e), ...R(e) })) : [];
  // Scrollers that scroll now (vertically): the page itself, and every element with overflow-y auto/scroll and more content than room.
  const scrollers = [...document.querySelectorAll('body *')].filter((e) => { const s = getComputedStyle(e); return /auto|scroll/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1 && vis(e); })
    .map((e) => e.getAttribute('aria-label') || e.getAttribute('role') || e.getAttribute('data-btw') || (e.closest('[data-btw]') ? 'btw body' : e.tagName.toLowerCase() + '.' + String(e.className).split(' ').slice(0, 3).join('.')));
  // Past the screen's edge and not clipped by a box that is itself inside the screen (a truncated line's inline span is wide but clipped).
  const clipped = (e) => { for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== 'visible') { const r = a.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; } } return false; };
  const bad = [];
  for (const e of document.querySelectorAll('body *')) { const r = e.getBoundingClientRect(); if (r.width && (r.right > innerWidth + 1 || r.left < -1) && !e.closest('[aria-hidden=true],.sr-only,[inert]')) { const s = getComputedStyle(e); if (s.position !== 'fixed' && s.visibility !== 'hidden' && !clipped(e)) bad.push(e.tagName + '.' + String(e.className).slice(0, 40) + ' ' + (e.innerText || '').slice(0, 30)); } }
  const log = document.querySelector('[role=log]');
  const sheet = document.querySelector('[data-btw-sheet]');
  const approval = document.querySelector('[role=group][aria-label="Approval needed"]');
  const title = header?.querySelector('button[aria-haspopup=dialog] span');
  const modelName = box?.querySelector('button[aria-label^="Model and effort"] .truncate');
  return {
    view, header: R(header), box: R(box), stack, log: R(log), sheet: sheet && { ...R(sheet), mode: sheet.dataset.btwSheet },
    headerControls: controls(header), composerControls: controls(box),
    approval: approval && { ...R(approval), kind: approval.dataset.approval, review: R([...approval.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Review')), deny: R([...approval.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Deny')), block: approval.querySelector('pre') && { ...R(approval.querySelector('pre')), sh: approval.querySelector('pre').scrollHeight, shownB: Math.min(R(approval.querySelector('pre')).b, R(approval.firstElementChild).b) } },
    title: title && { cut: title.scrollWidth > title.clientWidth + 1, ellipsis: getComputedStyle(title).textOverflow === 'ellipsis', w: title.getBoundingClientRect().width },
    page: { sh: document.scrollingElement.scrollHeight, ch: innerHeight, sw: document.scrollingElement.scrollWidth, scrollY },
    model: modelName && { cut: modelName.scrollWidth > modelName.clientWidth + 1, w: modelName.getBoundingClientRect().width, text: modelName.innerText },
    // A box that cannot scroll by hand (overflow hidden) can still be scrolled by a focus() or scrollIntoView: the whole screen then sits
    // shifted. Every box around the header and the dock must be at 0.
    shifted: [...new Set([header, dock])].flatMap((e) => { const out = []; for (let a = e?.parentElement; a; a = a.parentElement) if (a.scrollTop || a.scrollLeft) out.push(a.tagName + '.' + String(a.className).slice(0, 30) + ' ' + a.scrollTop); return out; }),
    scrollers, hbad: bad.slice(0, 4),
  };
})()`;

const results = [];
let cfgName = '';
let stateName = '';
const check = (name, ok, detail = '') => { results.push({ cfg: cfgName, state: stateName, name, ok: !!ok, detail }); if (!ok) console.log(`  FAIL ${cfgName} / ${stateName} / ${name} ${detail}`); };
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const same = (a, b) => !!a && !!b && ['x', 'y', 'w', 'h'].every((k) => near(a[k], b[k]));
const overlap = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.y, b.y));
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v));

// Where Bypass stands (the picker reads it), as in session-chrome.mjs.
const harness = `(() => {
  const real = window.fetch;
  window.fetch = (input, init) => {
    const p = new URL(typeof input === 'string' ? input : input.url, location.origin).pathname;
    if (p.endsWith('/bypass') && (!init || !init.method || init.method === 'GET'))
      return Promise.resolve(new Response(JSON.stringify({ data: { allowed: true, capable: true, active: false, busy: false, reauthed: true, facts: { workspace: 'bv-ws', isolated: true, network: 'open', credentials: [] } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    return real(input, init);
  };
})();`;

async function setup(cfg, kb = false) {
  await send('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: kb ? Math.round(cfg.h * 0.55) : cfg.h, deviceScaleFactor: 1, mobile: !!cfg.mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: !!cfg.mobile });
  await send('Emulation.setSafeAreaInsetsOverride', { insets: kb ? { ...cfg.insets, bottom: 0 } : (cfg.insets ?? { top: 0, bottom: 0, left: 0, right: 0 }) });
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
/** The on-screen keyboard (touch screens): the visible area 55 % of the screen, no bottom inset, the composer focused. */
// As on a phone: the field takes focus first, then the visible area shrinks (the page sees focusin, then a resize).
const keyboard = async (cfg, up) => {
  if (up) { await ev(`${Q.composer}.focus()`); await setup(cfg, true); }
  else { await ev(`document.activeElement?.blur()`); await setup(cfg, false); }
  await sleep(500);
};

const BASE = { model: 'claude-opus-5-5', effort: 'medium', context: { usedTokens: 84_000, windowTokens: 200_000 }, bypassCapable: true, mode: 'default' };
const LONG_TITLE = 'Refactor the retry loop in the delivery reconciler so a failing workspace does not hold up every other workspace behind it';
const UNBROKEN_TITLE = 'x'.repeat(120);
const LONG_APPROVAL = {
  title: 'Run a command: ' + 'npm run test -- --reporter=verbose '.repeat(6),
  agentLabel: 'toolu_01',
  full: Array.from({ length: 40 }, (_, i) => `step ${i}: kubectl -n dev-rig-ui rollout status deploy/api-${i} --timeout=120s && echo ok-${'z'.repeat(i % 7 === 0 ? 90 : 4)}`).join('\n'),
};

const review = async () => {
  await ev(`[...document.querySelectorAll('[data-approval=bar] button')].find((b) => b.innerText.trim() === 'Review').click()`);
  await sleep(400);
};

/** The checks every state must pass. */
async function invariants(cfg, label, { kb = false, reviewed = false } = {}) {
  const m = await ev(MEASURE);
  const touch = !!cfg.mobile;
  const t = (s) => `${label}: ${s}`;
  check(t('no horizontal scroll'), m.page.sw - m.view.w <= 1 && m.hbad.length === 0, J({ sw: m.page.sw, w: m.view.w, bad: m.hbad }));
  check(t('the page itself does not scroll'), m.page.sh <= m.page.ch + 1 && m.page.scrollY === 0, J(m.page));
  check(t('nothing around the header and the dock is scrolled (no shifted screen)'), m.shifted.length === 0, J(m.shifted));
  const allowed = ['Transcript', 'What is being allowed', 'btw body'];
  const extra = m.scrollers.filter((s) => !allowed.includes(s));
  check(t('one scroller (plus the approval text and the btw answer)'), extra.length === 0, J(m.scrollers));
  // The header.
  // The keyboard up on a short screen (under 320 px left): the header steps aside (SessionPage `cramped`); the stack may then rise to
  // the bar's top.
  const cramped = kb && Math.round(cfg.h * 0.55) < 320;
  let h = m.header;
  if (cramped) {
    check(t('cramped: the header steps aside'), !h || h.h === 0, J(h));
    h = { x: 0, y: 0, r: m.view.w, h: 0, b: Math.max(12, cfg.insets?.top ?? 0) };
  } else {
    check(t('header 52 px, under the status bar'), h && near(h.h, 52) && h.x >= -0.5 && h.r <= m.view.w + 0.5 && near(h.y, Math.max(12, cfg.insets?.top ?? 0)), J(h));
    const hc = m.headerControls;
    check(t('header controls inside the header'), hc.every((c) => c.x >= h.x - 0.5 && c.r <= h.r + 0.5 && c.y >= h.y - 0.5 && c.b <= h.b + 0.5), J(hc.filter((c) => !(c.x >= h.x - 0.5 && c.r <= h.r + 0.5))));
    const hOver = [];
    for (let i = 0; i < hc.length; i++) for (let j = i + 1; j < hc.length; j++) if (overlap(hc[i], hc[j]) > 1) hOver.push([hc[i].what, hc[j].what]);
    check(t('header controls do not overlap'), hOver.length === 0, J(hOver));
    if (touch) check(t('header targets 44 px'), hc.every((c) => c.w >= 43.5 && c.h >= 43.5), J(hc.filter((c) => c.w < 43.5 || c.h < 43.5)));
  }
  // The stack above the composer.
  const top = Math.min(...m.stack.map((s) => s.y));
  // What gives way so the transcript keeps its quarter is an approval's text and a btw answer (chat PRD, Dock): checked when one is
  // there. Review on a short screen is the person asking for the whole card: the room may go to it then.
  const yielding = m.stack.some((x) => x.what === 'Approval needed' || x.what === 'btw');
  if (!cramped && !reviewed && yielding) check(t('the transcript keeps a quarter of the screen below the header'), top - h.b >= m.view.h * 0.25 - 1, J({ room: top - h.b, quarter: m.view.h * 0.25 }));
  check(t('the stack stays below the header'), m.stack.every((s) => s.y >= h.b + 3), J({ headerBottom: h.b, stack: m.stack.map((s) => [s.what, s.y, s.h]) }));
  check(t('the stack is inside the screen'), m.stack.every((s) => s.b <= m.view.h + 0.5 && s.x >= -0.5 && s.r <= m.view.w + 0.5), J({ view: m.view, stack: m.stack.map((s) => [s.what, s.x, s.r, s.b]) }));
  check(t('composer on screen'), m.box && m.box.y >= h.b && m.box.b <= m.view.h + 0.5, J({ box: m.box, view: m.view }));
  const cc = m.composerControls;
  const cOver = [];
  for (let i = 0; i < cc.length; i++) for (let j = i + 1; j < cc.length; j++) if (overlap(cc[i], cc[j]) > 1) cOver.push([cc[i].what, cc[j].what]);
  check(t('composer controls do not overlap, inside the composer'), cOver.length === 0 && cc.every((c) => c.x >= m.box.x - 0.5 && c.r <= m.box.r + 0.5), J({ cOver, out: cc.filter((c) => c.x < m.box.x - 0.5 || c.r > m.box.r + 0.5) }));
  if (m.model) check(t('the model\'s name is whole'), !m.model.cut, J(m.model));
  // A short screen (under 500 px to see) or the keyboard up: an approval waits as a 56 px bar until Review (chat PRD, Dock).
  const short = Math.round(kb ? cfg.h * 0.55 : cfg.h) < 500;
  if (m.approval && (kb || short) && !reviewed) {
    check(t('approval: a 56 px bar (keyboard up or a short screen), Review on screen'), m.approval.kind === 'bar' && near(m.approval.h, 56) && m.approval.review && m.approval.review.b <= m.view.h, J(m.approval));
  } else if (m.approval) {
    check(t('approval: at most 45 % of the screen'), m.approval.h <= m.view.h * 0.45 + 1, J({ h: m.approval.h, view: m.view.h }));
    check(t('approval: Deny on screen, clear of the header'), m.approval.deny && m.approval.deny.y >= h.b && m.approval.deny.b <= m.view.h, J(m.approval));
    if (m.approval.block && m.approval.deny) check(t('approval: the buttons sit below its text, not over it'), m.approval.deny.y >= m.approval.block.shownB, J({ block: m.approval.block, deny: m.approval.deny }));
    if (m.approval.block) check(t('approval: its text has room (2 lines, or all of it)'), m.approval.block.shownB - m.approval.block.y >= Math.min(36, m.approval.block.sh), J(m.approval.block));
  }
  if (m.sheet) {
    check(t('btw sheet starts below the header'), m.sheet.y >= h.b - 0.5, J({ sheet: m.sheet, headerBottom: h.b }));
    if (!cramped) check(t('btw sheet is tall enough to read (120 px)'), m.sheet.h >= 120, J(m.sheet));
    // It sits on the composer (and its notes), over an approval or the glance strip if one is there.
    const base = m.stack.find((x) => x.what === 'composer');
    check(t('btw sheet sits on the composer'), base && near(m.sheet.b, base.y - 8, 2), J({ sheet: m.sheet.b, composerTop: base?.y }));
  }
  // The transcript: where its first line sits when scrolled to the top and its last when scrolled to the end, computed from the content's
  // own coordinates (scrolling it would fight the follow-the-end of a streaming turn).
  const ends = await ev(`(() => {
    const log = ${Q.log}; const items = log.firstElementChild?.children; if (!items?.length) return null;
    const box = log.getBoundingClientRect(); const at = (e) => e.getBoundingClientRect();
    const firstIn = at(items[0]).top - box.top + log.scrollTop, lastIn = at(items[items.length - 1]).bottom - box.top + log.scrollTop;
    return { first: box.top + firstIn, last: box.top + lastIn - Math.max(0, log.scrollHeight - log.clientHeight) };
  })()`);
  // Cramped (a landscape keyboard), the composer and its notes take the screen; nothing is left to show the transcript in.
  if (ends && !reviewed && !cramped) {
    check(t('the transcript\'s end clears the stack'), ends.last <= top + 0.5, J({ last: ends.last, stackTop: top }));
    check(t('the transcript\'s start clears the header'), ends.first >= h.b - 0.5, J({ first: ends.first, headerBottom: h.b }));
  }
  return m;
}

const STATES = {
  async idle(cfg) {
    if (!(await openSession(BASE))) return check('page loads', false, errors.join(' | '));
    await invariants(cfg, 'idle');
    await shot(`${cfg.name}-idle`);
    if (cfg.mobile) {
      await keyboard(cfg, true);
      await invariants(cfg, 'idle, keyboard up', { kb: true });
      await shot(`${cfg.name}-idle-kb`);
      await keyboard(cfg, false);
    }
  },

  // A long title, Bypass on, working, a reconnect: the header keeps its parts; the title gives way (ellipsis) and nothing else does.
  async title(cfg) {
    for (const [what, title] of [['long', LONG_TITLE], ['unbroken', UNBROKEN_TITLE]]) {
      if (!(await openSession({ ...BASE, title, mode: 'bypassPermissions' }))) return check('page loads', false, errors.join(' | '));
      await ev(`__fake.startMain()`);
      await sleep(400);
      const m = await invariants(cfg, `${what} title, Bypass, working`);
      check(`${what} title: cut with an ellipsis`, m.title?.cut && m.title.ellipsis, J(m.title));
      check(`${what} title: keeps room`, m.title?.w >= (cfg.w < 640 ? 100 : 200), J(m.title));
      await shot(`${cfg.name}-title-${what}`);
      await ev(`__fake.stopMain()`);
    }
  },

  // The six modes the chip can show (five offered, and Don't ask, the longest): the composer and the header keep their boxes.
  async modes(cfg) {
    if (!(await openSession(BASE))) return check('page loads', false, errors.join(' | '));
    const base = await ev(MEASURE);
    for (const mode of ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']) {
      await ev(`__fake.patch({ mode: ${JSON.stringify(mode)} })`);
      await sleep(250);
      const m = await invariants(cfg, `mode ${mode}`);
      check(`mode ${mode}: the composer keeps its box`, same(m.box, base.box), J({ was: base.box, now: m.box }));
      check(`mode ${mode}: the header keeps its box`, same(m.header, base.header), J({ was: base.header, now: m.header }));
      const chip = await ev(`(() => { const b = document.querySelector('button[aria-label^="Permission mode"]'); const r = b.getBoundingClientRect(); return { h: r.height, w: r.width, lines: [...b.querySelectorAll('span')].map((s) => s.getBoundingClientRect().height).filter(Boolean) }; })()`);
      check(`mode ${mode}: the chip's label on one line`, chip.lines.every((x) => x <= 24), J(chip));
      if (mode === 'dontAsk' || mode === 'bypassPermissions') await shot(`${cfg.name}-mode-${mode}`);
    }
    // While it works, with words in the box (the wider Steer pill).
    await ev(`__fake.patch({ mode: 'acceptEdits' })`);
    await ev(`__fake.startMain()`);
    await ev(`(() => { const t = ${Q.composer}; t.focus(); })()`);
    await send('Input.insertText', { text: 'and also check the tests' });
    await sleep(300);
    const w = await invariants(cfg, 'working, Steer');
    check('working, Steer: the composer keeps its box', near(w.box.y, base.box.y) && near(w.box.h, base.box.h), J({ was: base.box, now: w.box }));
    await shot(`${cfg.name}-steer`);
    await ev(`__fake.stopMain()`);
  },

  // An approval waiting: a long one (a long title, an agent, 3 waiting, 40 lines of text), keyboard down and up.
  async approval(cfg) {
    if (!(await openSession(BASE))) return check('page loads', false, errors.join(' | '));
    await ev(`__fake.request(${JSON.stringify({ title: 'Run a command: npm test', full: 'npm test' })})`);
    await sleep(300);
    await invariants(cfg, 'short approval');
    await shot(`${cfg.name}-approval-short`);
    await ev(`__fake.request(${JSON.stringify(LONG_APPROVAL)}); __fake.request({}); __fake.request({})`);
    // The long one first: resolve the short one.
    await ev(`__fake.resolve(__fake.events.find((x) => x.kind === 'request').request.requestId)`);
    await sleep(400);
    await invariants(cfg, 'long approval, 3 waiting');
    await shot(`${cfg.name}-approval-long`);
    if (cfg.h < 500) {
      await review();
      await invariants(cfg, 'long approval, Review on a short screen', { reviewed: true });
      await shot(`${cfg.name}-approval-long-review`);
    }
    if (cfg.mobile) {
      await keyboard(cfg, true);
      await invariants(cfg, 'long approval, keyboard up', { kb: true });
      await shot(`${cfg.name}-approval-long-kb`);
      await review();
      check('Review puts the keyboard away and shows the card', await ev(`!!document.querySelector('[data-approval=card]') && document.activeElement !== ${Q.composer}`));
      await keyboard(cfg, false);
    }
  },

  // A session that restarts: the chip, Restart under way, the chip gone. The composer stays where it was once the chip has gone.
  async restart(cfg) {
    if (!(await openSession(BASE))) return check('page loads', false, errors.join(' | '));
    const before = await ev(MEASURE);
    await ev(`__fake.patch({ configChangedAt: new Date().toISOString() })`);
    await sleep(300);
    const chip = await invariants(cfg, 'Tools changed');
    check('Tools changed: the composer keeps its box', same(chip.box, before.box), J({ was: before.box, now: chip.box }));
    await shot(`${cfg.name}-restart-chip`);
    await ev(`__fake.patch({ restarting: true, state: 'starting' })`);
    await sleep(300);
    await invariants(cfg, 'restarting');
    await shot(`${cfg.name}-restart-busy`);
    await ev(`__fake.patch({ restarting: false, configChangedAt: null, state: 'idle' })`);
    await sleep(300);
    const after = await invariants(cfg, 'restarted');
    check('restarted: the composer back in its place', same(after.box, before.box), J({ was: before.box, now: after.box }));
    // Interrupted, with a long reason: the Resume note.
    await ev(`__fake.patch({ state: 'interrupted', process: 'gone', endedReason: 'The workspace restarted at 14:02 and the background agents were lost: ' + 'kohi-event-'.repeat(8) })`);
    await sleep(300);
    await invariants(cfg, 'interrupted, Resume');
    await shot(`${cfg.name}-resume`);
    if (cfg.mobile) {
      await ev(`__fake.patch({ state: 'idle', process: 'live', endedReason: null, configChangedAt: new Date().toISOString() })`);
      await keyboard(cfg, true);
      await invariants(cfg, 'Tools changed, keyboard up', { kb: true });
      await shot(`${cfg.name}-restart-chip-kb`);
      await keyboard(cfg, false);
    }
  },

  // btw: the phone's sheet, half and full, never over the header; with an approval under it; with the keyboard up. Wider screens: the card.
  async btw(cfg) {
    if (!(await openSession(BASE))) return check('page loads', false, errors.join(' | '));
    const touch = !!cfg.mobile;
    const ask = async (q) => {
      await ev(`(() => { const t = ${Q.composer}; t.focus(); })()`);
      await send('Input.insertText', { text: touch ? q : `/btw ${q}` });
      if (touch) await ev(`document.querySelector('[data-guide=btw]').click()`);
      else {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      }
      await waitFor(`!!document.querySelector('[data-btw]')`, 4000);
      await ev(`document.activeElement?.blur()`);
      await sleep(700);
    };
    await ask('how does LONG retry work?');
    await invariants(cfg, 'btw');
    await shot(`${cfg.name}-btw`);
    const sheet = await ev(`!!document.querySelector('[data-btw-sheet]')`);
    if (sheet) {
      await ev(`document.querySelector('[data-btw-sheet] > button').click()`);
      await sleep(400);
      await invariants(cfg, 'btw sheet full');
      await shot(`${cfg.name}-btw-full`);
      await ev(`document.querySelector('[data-btw-sheet] > button').click()`);
      await sleep(300);
    }
    await ev(`__fake.request(${JSON.stringify(LONG_APPROVAL)})`);
    await sleep(400);
    await invariants(cfg, 'btw over an approval');
    await shot(`${cfg.name}-btw-approval`);
    if (touch) {
      await keyboard(cfg, true);
      await invariants(cfg, 'btw over an approval, keyboard up', { kb: true });
      await shot(`${cfg.name}-btw-approval-kb`);
      await keyboard(cfg, false);
    }
  },
};

try {
  const cookie = await login();
  await send('Network.enable');
  await send('Network.setCookie', { name: 'portal_session', value: cookie, domain: 'localhost', path: '/' });
  await send('Page.enable');
  await send('Runtime.enable');
  // A headless page has no window focus: without this, focus() fires no focusin and the page never sees the keyboard come up.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  for (const cfg of MATRIX) {
    if (only && !cfg.name.includes(only)) continue;
    console.log(`> ${cfg.name}`);
    cfgName = cfg.name;
    for (const [name, run] of Object.entries(STATES)) {
      if (onlyState && name !== onlyState) continue;
      stateName = name;
      errors.length = 0;
      await setup(cfg);
      try { await run(cfg); } catch (e) { await shot(`${cfg.name}-${name}-x-error`); check('state ran', false, String(e.message ?? e).slice(0, 300)); }
      check('no page errors', errors.length === 0, errors.join(' | '));
    }
  }
} finally {
  try { chrome.kill(); } catch {}
  await new Promise((r) => (chrome.exitCode !== null || chrome.signalCode !== null ? r() : chrome.once('exit', r)));
  cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
const byName = new Map();
for (const f of failed) { const k = `${f.state} / ${f.name.replace(/^[^:]*: /, '')}`; byName.set(k, [...(byName.get(k) ?? []), f.cfg]); }
for (const [k, cfgs] of byName) console.log(`FAIL ${k}  [${[...new Set(cfgs)].join(', ')}]`);
process.exit(failed.length ? 1 : 0);
