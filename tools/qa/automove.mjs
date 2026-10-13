// Auto move's web half (docs/prd/auto-transfer.md FR15, FR18, FR19, FR20, §13), checked in headless Chromium over CDP: the REAL session page against a
// scripted session (btw-fake.js) plus a stand-in for `/api/autotransfer` (the card of `ask` mode, a chat that was moved by itself an hour ago, and its
// Undo), and the REAL Settings page of the portal it runs on (the "Auto move" rows). At 390 px with touch and the iPhone's safe areas (59 top, 34
// bottom) and at 1280 px, light and dark. Asserts: the card's words and numbers with their basis, its buttons (44 px on touch), clear of the composer,
// no horizontal scroll (long names too), the divider's "auto" mark and Undo (opens the Move dialog with the Claude the chat left chosen; disabled
// with the reason in the ⓘ when it can't), the session ⋯ item and its choices (Automatic only when the platform allows it; no item when it is off),
// Later and Move call their routes and the card goes. Optionally (AM_WORKSPACE=<name of a running workspace>) the Claudes list's "Auto move…" dialog of a real workspace.
// T-105: the line shown while the engine holds a chat ("Waiting for quota: next Claude free at <time>", "Waiting for quota" when no reset is known,
// "Moving at the end of this turn"; cases waiting, waitnotime, pending), and against the scratch portal's REAL server: the new defaults, the dry run
// switch, `GET /api/autotransfer/state` and the Auto move ⓘ that explains R1 to R3. The engine's moves themselves are proven on the fake clock
// (apps/server/src/autotransfer/t105.test.ts): a stand-in Claude has no plan reading, so a scratch portal's engine never has a reason to move.
// usage: AM_PORT=3411 AM_CODE=24681372 AM_CDP=9611 node tools/qa/automove.mjs [--only name] [--shots dir]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PORT = Number(process.env.AM_PORT ?? 3411);
const CODE = process.env.AM_CODE ?? '24681372';
const CDP = Number(process.env.AM_CDP ?? 9611);
const WORKSPACE = process.env.AM_WORKSPACE ?? null;
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url));
const fake = readFileSync(join(here, 'btw-fake.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHONE = { top: 59, bottom: 34, left: 0, right: 0 };
const NONE = { top: 0, bottom: 0, left: 0, right: 0 };
const SIZES = [
  { name: 'phone-390', w: 390, h: 844, mobile: true, insets: PHONE },
  { name: 'desktop-1280', w: 1280, h: 800, insets: NONE },
];
// Scenarios: the ordinary card and divider; long names and an Undo that can't be done; a platform that only asks; a platform that is off.
const CASES = [
  { id: 'card', platform: 'auto' },
  { id: 'long', platform: 'auto', long: true, undoBlocked: true, exhausted: true },
  { id: 'ask', platform: 'ask' },
  { id: 'off', platform: 'off' },
  { id: 'waiting', platform: 'auto', hold: 'waiting' },
  { id: 'waitnotime', platform: 'auto', hold: 'waiting', noTime: true, long: true },
  { id: 'pending', platform: 'auto', hold: 'pending', long: true },
];
const MATRIX = SIZES.flatMap((s) => [false, true].flatMap((dark) => CASES.map((c) => ({ ...s, ...c, dark, name: `${s.name}-${dark ? 'dark' : 'light'}-${c.id}` }))));

// Runs in the page before btw-fake.js: the chat is on "Home" now, moved there from "Work" by auto move an hour ago.
const pre = (c) => `window.__AM = ${JSON.stringify(c)}; window.__FAKE_SESSION = { claudeId: 'c-home', claudeName: ${JSON.stringify(c.long ? 'Home-with-a-very-long-name-that-has-no-spaces-at-all-0123456789' : 'Home')} };`;
// Runs after btw-fake.js: the "Moved to" divider in the transcript, and the stand-in for /api/autotransfer and the Move dialog's options.
const post = `(() => {
  const SID = 'bv-fake', c = window.__AM, f = window.__fake;
  const work = c.long ? 'Work-account-with-a-name-far-too-long-for-a-phone-screen-ABCDEFGHIJKLMNOP' : 'Work';
  const home = f.session.claudeName, spare = c.long ? 'Spare-Claude-another-very-long-name-without-any-break-in-it' : 'Spare';
  const ago = new Date(Date.now() - 3600e3).toISOString();
  let seq = f.events[f.events.length - 1].seq;
  // The divider sits a few messages from the end, where the transcript opens.
  f.events.splice(f.events.length - 3, 0, { seq: 0, at: ago, kind: 'system', text: 'Moved to ' + home, transfer: { fromClaude: work, toClaude: home, sourceSessionId: SID, path: '/work/.claude/handoff.md', messages: 40, truncated: false, handoff: true, handoffId: 'h-auto' } });
  f.events.forEach((e, i) => (e.seq = i + 1));
  f.session.lastSeq = f.events.length;
  const moved = { id: 7, at: ago, userId: 'u_owner', sessionId: SID, workspaceId: 'bv-ws', kind: 'moved', mode: 'auto', reason: 'low', from: { id: 'c-work', name: work }, to: { id: 'c-home', name: home }, facts: null, handoff: 'ask', handoffId: 'h-auto', code: null, actor: 'portal:autotransfer' };
  const fig = (value) => ({ value, basis: 'measured' });
  const pending = { id: 'sug_00aa11bb22cc', sessionId: SID, at: new Date().toISOString(), reason: c.exhausted ? 'exhausted' : 'low', from: { id: 'c-home', name: home }, to: { id: 'c-spare', name: spare },
    alternatives: [{ id: 'c-third', name: c.long ? 'Third-one-with-a-long-name-as-well-xxxxxxxxxxxxxxxx' : 'Third' }],
    facts: { leftPct: fig(c.exhausted ? 0 : 8), thresholdPct: 10, resetsAt: fig(new Date(Date.now() + 7200e3).toISOString()), destLeftPct: fig(40) },
    handoff: c.exhausted ? 'skip' : 'ask', dropped: { approvals: 0, queued: 0, agents: 1 }, state: 'open' };
  const effective = (m) => (c.platform === 'off' ? 'off' : (m ?? c.platform) === 'auto' && c.platform !== 'auto' ? 'ask' : (m ?? c.platform));
  const resetAt = new Date(Date.now() + 3 * 3600e3);
  window.__amReset = resetAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const waiting = c.hold ? { since: ago, code: 'no_destination', nextFreeAt: c.noTime ? null : resetAt.toISOString() } : null;
  const pendingMove = c.hold === 'pending' ? { to: { id: 'c-spare', name: spare }, reason: 'low', steeredAt: ago } : null;
  const state = { sessionId: SID, mode: null, effectiveMode: effective(null), applicable: c.platform !== 'off', why: c.platform === 'off' ? 'mode_off' : null,
    pending: c.platform === 'off' || c.hold ? null : pending, pausedUntil: null, movesToday: 1, waiting, pendingMove,
    lastMove: { event: moved, undo: c.undoBlocked ? { ok: false, reason: 'Out of quota until it resets.' } : { ok: true, reason: null } } };
  const settings = { mode: c.platform, thresholdPct: 10, useProjection: true, minPauseMin: 30, maxPerSessionPerDay: 2, maxPerDay: 6, maxPerDestination: 2, sameModelOnly: false, allowApiKey: false };
  const claude = (id, name) => ({ id, workspaceId: 'bv-ws', name, directory: id, removedAt: null, createdAt: ago });
  const options = { sessionId: SID, via: 'own', folder: '/work', worktree: null, handoff: { ok: true, reason: null }, working: false, dropped: { approvals: 0, queued: 0, agents: 0 },
    options: [ { claude: claude('c-spare', spare), ok: true, reason: null, fix: null }, { claude: claude('c-work', work), ok: !c.undoBlocked, reason: c.undoBlocked ? 'Out of quota.' : null, fix: null } ] };
  const calls = (window.__am = { calls: [] }).calls;
  const json = (d) => Promise.resolve(new Response(JSON.stringify({ data: d }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const inner = window.fetch;
  window.fetch = (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.url, location.origin), p = u.pathname, m = (init?.method ?? 'GET').toUpperCase();
    if (p === '/api/chat/sessions/' + SID + '/switch-options') return json(options);
    if (p.startsWith('/api/autotransfer') && !(c.realOverview && p === '/api/autotransfer')) {
      calls.push(m + ' ' + p + (init?.body ? ' ' + init.body : ''));
      if (p === '/api/autotransfer') return json({ platform: settings, prefs: { mode: null, thresholdPct: null, useProjection: null, sameModelOnly: null, allowApiKey: null }, effective: settings, claudes: [] });
      if (p === '/api/autotransfer/events') return json([moved]);
      if (p === '/api/autotransfer/sessions/' + SID) {
        if (m === 'PUT') { state.mode = JSON.parse(init.body).mode; state.effectiveMode = effective(state.mode); }
        return json(state);
      }
      if (p.startsWith('/api/autotransfer/suggestions/')) { state.pending = null; return json(state); }
    }
    return inner(input, init);
  };
})();`;

const login = async () => {
  const r = await fetch(`http://localhost:${PORT}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${PORT}` }, body: JSON.stringify({ code: CODE }) });
  const m = /portal_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  if (!m) throw new Error(`login failed ${r.status}`);
  return m[1];
};

const profile = mkdtempSync(join(tmpdir(), 'am-profile-'));
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
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
  if (r.result?.exceptionDetails) throw new Error(`eval: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text} in ${expr.slice(0, 80)}`);
  return r.result?.result?.value;
};
const shot = async (name) => { if (shots) writeFileSync(join(shots, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); };
const waitFor = async (expr, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(50); } return false; };
const key = async (k, code = k, vk = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
};
// A real tap or click at an element's centre (touch screens get a touch, so `tap:` sizes and pointer handlers are the real ones).
const press = async (sel, touch) => {
  // The element must be the one under the finger: a card or the composer floating over it would take the tap.
  const r = await ev(`(() => { const e = ${sel}; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); const x = b.x + b.width / 2, y = b.y + b.height / 2; const top = document.elementFromPoint(x, y); return { x, y, hit: !!top && (e === top || e.contains(top) || top.contains(e)) }; })()`);
  if (!r) return false;
  if (!r.hit) { check(`tap target uncovered: ${sel.slice(0, 70)}`, false); return false; }
  if (touch) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  }
  return true;
};

const Q = {
  composer: `document.querySelector('textarea[aria-label="Message"]')`,
  box: `document.querySelector('textarea[aria-label="Message"]').closest('.glass-card')`,
  log: `document.querySelector('[role=log]')`,
  card: `document.querySelector('[role=group][aria-label="Move suggested"]')`,
  mark: `document.querySelector('[data-automove-mark]')`,
  hold: `[...document.querySelectorAll('[role=status]')].find((e) => /Waiting for quota|Moving at the end of this turn/.test(e.textContent))`,
  undo: `document.querySelector('[data-automove-mark] button[aria-label^="Undo"]')`,
  button: (text, within = 'document') => `[...${within}.querySelectorAll('button,[role=button]')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`,
  dialog: (title) => `[...document.querySelectorAll('[role=dialog]')].find((d) => d.textContent.includes(${JSON.stringify(title)}))`,
};
const rect = (sel) => `(() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right }; })()`;
const hscroll = `(() => { const d = document.scrollingElement; const bad = []; for (const e of document.querySelectorAll('body *')) { const r = e.getBoundingClientRect(); if (r.width && (r.right > innerWidth + 1 || r.left < -1) && !e.closest('[aria-hidden=true],.sr-only,[inert]')) { const s = getComputedStyle(e); if (s.position !== 'fixed' && s.visibility !== 'hidden' && s.overflow !== 'hidden') bad.push(e.tagName + '.' + String(e.className).slice(0, 50) + ' ' + Math.round(r.right)); } } return { doc: d.scrollWidth - innerWidth, bad: bad.slice(0, 3) }; })()`;

// Text that spills out of the card or the divider (a button that won't wrap a long name): the boxes stay on screen, so the scroll check misses it.
// Measured on the text itself (a Range per text node), so a 44 px hit area with negative margins (InfoTip on a phone) is not counted.
const spill = (sel) => `(() => { const root = ${sel}; if (!root) return []; const box = root.getBoundingClientRect(); const out = []; const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let t = w.nextNode(); t; t = w.nextNode()) { if (!t.textContent.trim()) continue; const r = document.createRange(); r.selectNodeContents(t); const b = r.getBoundingClientRect(); if (b.width && (b.right > box.right + 1 || b.left < box.left - 1)) out.push(t.textContent.slice(0, 40) + ' ' + Math.round(b.right) + '>' + Math.round(box.right)); } return out.slice(0, 3); })()`;
const results = [];
let cfgName = '';
const check = (name, ok, detail = '') => { results.push({ cfg: cfgName, name, ok: !!ok, detail }); if (!ok) console.log(`  FAIL ${cfgName} / ${name} ${detail}`); };
const noOverflow = async (label) => {
  const h = await ev(hscroll);
  check(`${label}: no horizontal scroll`, h.doc <= 1 && h.bad.length === 0, JSON.stringify(h));
};
const tall = async (label, sel, touch) => {
  const r = await ev(rect(sel));
  const min = touch ? 44 : 28;
  check(`${label}: ${min} px or more`, r && r.h >= min - 0.5 && (!touch || r.w >= 44 - 0.5), JSON.stringify(r));
};

let scripts = [];
async function setup(cfg) {
  await send('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: !!cfg.mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: !!cfg.mobile, maxTouchPoints: cfg.mobile ? 5 : 1 });
  await send('Emulation.setSafeAreaInsetsOverride', { insets: cfg.insets ?? NONE });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: cfg.dark ? 'dark' : 'light' }] });
  for (const id of scripts) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id });
  scripts = [];
  for (const source of [pre(cfg), fake, post]) scripts.push((await send('Page.addScriptToEvaluateOnNewDocument', { source })).result.identifier);
}

async function scenario(cfg) {
  cfgName = cfg.name;
  const touch = !!cfg.mobile;
  await setup(cfg);
  await send('Page.navigate', { url: `http://localhost:${PORT}/admin/sessions/bv-fake` });
  const ready = `!!${Q.composer} && ${Q.log}.scrollHeight > 0`;
  if (!(await waitFor(ready, 20000))) { await send('Page.reload'); if (!(await waitFor(ready, 30000))) return check('page loads', false, 'composer not found'); }
  await sleep(1200);

  // 0. The line of a held chat (T-105), read only, instead of the card.
  if (cfg.hold) {
    check('hold line shows', await waitFor(`!!${Q.hold}`, 4000));
    const text = (await ev(`${Q.hold}?.innerText ?? ''`)).trim();
    const want = cfg.hold === 'pending' ? 'Moving at the end of this turn' : cfg.noTime ? 'Waiting for quota' : `Waiting for quota: next Claude free at ${await ev('window.__amReset')}`;
    check(`hold line says "${want}"`, text === want, text);
    check('no card while held', !(await ev(`!!${Q.card}`)));
    // The house InfoTip: 44 px on touch, 24 px with a pointer (as everywhere else).
    const tip0 = await ev(rect(`${Q.hold}.querySelector('button[aria-label="About this wait"]')`));
    check(`hold ⓘ: ${touch ? 44 : 24} px or more`, tip0 && tip0.h >= (touch ? 44 : 24) - 0.5 && tip0.w >= (touch ? 44 : 24) - 0.5, JSON.stringify(tip0));
    const l = await ev(rect(Q.hold)), b = await ev(rect(Q.box));
    check('hold line clear of the composer', l && b && l.b <= b.y + 1, JSON.stringify({ line: l?.b, composer: b?.y }));
    await noOverflow('hold line');
    const spilt = await ev(spill(Q.hold));
    check('hold line: no text spills out of its box', spilt.length === 0, JSON.stringify(spilt));
    await press(`${Q.hold}.querySelector('button[aria-label="About this wait"]')`, touch);
    const tip = cfg.hold === 'pending' ? /finish its step and stop/ : /looks again every 2 minutes/;
    check('hold ⓘ says what happens next', await waitFor(`[...document.querySelectorAll('body *')].some((e) => e.childElementCount === 0 && ${tip}.test(e.textContent) && e.getBoundingClientRect().height > 0)`, 2000));
    await shot(`${cfg.name}-0-hold`);
    await key('Escape', 'Escape', 27);
    check('no page errors', errors.length === 0, errors.join(' | '));
    errors.length = 0;
    return;
  }

  // 1. The card (ask mode), or none when auto move is off.
  if (cfg.platform === 'off') {
    check('no card when auto move is off', !(await ev(`!!${Q.card}`)));
  } else {
    check('card shows', await waitFor(`!!${Q.card}`, 4000));
    const text = await ev(`${Q.card}.innerText`);
    if (cfg.exhausted) check('card: used up', /is used up/.test(text), text);
    else check('card: what is low, measured', /Home has 8 % left/.test(text), text);
    check('card: where to, with its percent left', /Move to .*\(40 % left\)/s.test(text), text);
    check('card: what a move drops', /Drops 1 agent/.test(text), text);
    check('card: Move and Later', !!(await ev(`!!${Q.button('Move', Q.card)} && !!${Q.button('Later', Q.card)}`)));
    check(`card: Always automatic ${cfg.platform === 'auto' ? 'shows' : 'hidden'} (platform ${cfg.platform})`, (await ev(`!!${Q.button('Always automatic', Q.card)}`)) === (cfg.platform === 'auto'));
    for (const b of ['Move', 'Later', ...(cfg.platform === 'auto' ? ['Always automatic'] : [])]) await tall(`card ${b}`, Q.button(b, Q.card), touch);
    await tall('card Other', Q.button('Other', Q.card), touch);
    await press(Q.button('Other', Q.card), touch);
    check('Other: the other Claudes, inline', await waitFor(`!!${Q.card}.querySelector('[role=group][aria-label="Other Claudes"] button')`, 2000));
    await tall('card Move to <other>', `${Q.card}.querySelector('[role=group][aria-label="Other Claudes"] button')`, touch);
    const c = await ev(rect(Q.card)), b = await ev(rect(Q.box));
    check('card clear of the composer', c && b && c.b <= b.y + 1, JSON.stringify({ card: c?.b, composer: b?.y }));
    check('composer on screen', b && b.y >= 0 && b.b <= cfg.h + 1, JSON.stringify(b));
    await noOverflow('card');
    const spilt = await ev(spill(Q.card));
    check('card: no text spills out of its box', spilt.length === 0, JSON.stringify(spilt));
  }

  // 2. The divider of the automatic move: the "auto" mark and Undo.
  check('divider mark shows', await waitFor(`!!${Q.mark}`, 3000));
  // Into the part of the transcript the floating dock (composer, card) leaves free: a third of the way down.
  await ev(`(() => { const l = ${Q.log}, m = ${Q.mark}; l.scrollTop += m.getBoundingClientRect().top - innerHeight * 0.3; })()`);
  await sleep(400);
  check('divider: auto chip', /auto/.test(await ev(`${Q.mark}.innerText`)));
  check('divider: in a group named for the move (a button in a separator is lost)', (await ev(`${Q.mark}.closest('[role=group]')?.getAttribute('aria-label') ?? ''`)).startsWith('Moved to'));
  await tall('divider Undo', Q.undo, touch);
  check(`divider: Undo ${cfg.undoBlocked ? 'disabled' : 'enabled'}`, (await ev(`${Q.undo}.disabled`)) === !!cfg.undoBlocked);
  await noOverflow('divider');
  const spiltMark = await ev(spill(`${Q.mark}.closest('[role=group]')`));
  check('divider: no text spills out of its box', spiltMark.length === 0, JSON.stringify(spiltMark));
  await shot(`${cfg.name}-1-card-divider`);

  // 3. The ⓘ: on the card, why and the basis; on the mark, the reason Undo can't run.
  if (cfg.platform !== 'off') {
    await press(`${Q.card}.querySelector('button[aria-label="Why this move"]')`, touch);
    const note = await waitFor(`[...document.querySelectorAll('[role=tooltip],[role=note],[id]')].some((e) => /measured/.test(e.textContent) && /handoff|conversation/.test(e.textContent) && e.getBoundingClientRect().height > 0)`, 2000);
    check('card ⓘ explains the reason and the basis', note);
    await shot(`${cfg.name}-2-card-why`);
    await key('Escape', 'Escape', 27);
    await sleep(200);
  }
  if (cfg.undoBlocked) {
    await press(`${Q.mark}.querySelector('button[aria-label="About this move"]')`, touch);
    check('mark ⓘ says why Undo is unavailable', await waitFor(`[...document.querySelectorAll('body *')].some((e) => e.childElementCount === 0 && /Undo is unavailable now: Out of quota/.test(e.textContent))`, 2000));
    await shot(`${cfg.name}-3-undo-why`);
    await key('Escape', 'Escape', 27);
    await sleep(200);
  } else {
    // Undo opens the normal Move dialog with the Claude the chat left chosen (FR19).
    await press(Q.undo, touch);
    check('Undo opens the Move dialog', await waitFor(`!!${Q.dialog('Move chat')}`, 3000));
    check('… with the Claude the chat left chosen', await waitFor(`(() => { const d = ${Q.dialog('Move chat')}; const r = d && [...d.querySelectorAll('input[type=radio]')].find((i) => i.checked); return !!r && r.closest('div').textContent.includes('Work'); })()`, 3000));
    await shot(`${cfg.name}-3-undo-dialog`);
    await key('Escape', 'Escape', 27);
    await waitFor(`!${Q.dialog('Move chat')}`, 2000);
  }

  // 4. The session ⋯ menu: "Auto move: <mode>" and its choices; no item when the platform is off.
  await press(`document.querySelector('[aria-label^="Session actions"]')`, touch);
  await waitFor(`!!document.querySelector('[role=menu]')`, 2000);
  const item = `[...document.querySelectorAll('[role=menuitem]')].find((e) => e.textContent.includes('Auto move'))`;
  if (cfg.platform === 'off') {
    check('no Auto move item when the platform is off', !(await ev(`!!${item}`)));
    await key('Escape', 'Escape', 27);
  } else {
    check('menu: Auto move item with the mode', /Auto move: (Automatic|Ask)/.test((await ev(`${item}?.textContent ?? ''`)) || ''), await ev(`${item}?.textContent ?? 'none'`));
    await press(item, touch);
    check('Auto move dialog opens', await waitFor(`!!${Q.dialog('Auto move')}`, 2000));
    const opts = await ev(`[...${Q.dialog('Auto move')}.querySelectorAll('[role=radio],button')].map((b) => b.textContent.trim()).filter((t) => ['Default', 'Off', 'Ask', 'Automatic'].includes(t))`);
    check(`dialog: choices (${cfg.platform})`, JSON.stringify(opts) === JSON.stringify(cfg.platform === 'auto' ? ['Default', 'Off', 'Ask', 'Automatic'] : ['Default', 'Off', 'Ask']), JSON.stringify(opts));
    for (const o of opts) await tall(`dialog ${o}`, `[...${Q.dialog('Auto move')}.querySelectorAll('[role=radio],button')].find((b) => b.textContent.trim() === ${JSON.stringify(o)})`, touch);
    await noOverflow('auto move dialog');
    await shot(`${cfg.name}-4-menu-dialog`);
    // A sheet still sliding in moves the row between the measure and the tap: wait until it holds still.
    const offRow = `[...${Q.dialog('Auto move')}.querySelectorAll('[role=radio],button')].find((b) => b.textContent.trim() === 'Off')`;
    for (let i = 0, prev = ''; i < 40; i++) { const now = JSON.stringify(await ev(rect(offRow))); if (now === prev) break; prev = now; await sleep(100); }
    await press(offRow, touch);
    check('choosing Off sets this chat’s mode', await waitFor(`__am.calls.some((c) => c.startsWith('PUT /api/autotransfer/sessions/bv-fake') && c.includes('"off"'))`, 2000), JSON.stringify(await ev('__am.calls')));
    await key('Escape', 'Escape', 27);
    await waitFor(`!${Q.dialog('Auto move')}`, 2000);
  }

  // 5. Later (or Move) answers the card through its route, and the card goes.
  if (cfg.platform !== 'off') {
    const which = cfg.long ? 'Move' : 'Later';
    await press(Q.button(which, Q.card), touch);
    check(`${which} calls its route`, await waitFor(`__am.calls.some((c) => c.startsWith('POST /api/autotransfer/suggestions/sug_00aa11bb22cc/${which.toLowerCase()}'))`, 2000), JSON.stringify(await ev('__am.calls')));
    check(`${which}: the card goes`, await waitFor(`!${Q.card}`, 2000));
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
  errors.length = 0;
}

// The real Settings page: the "Auto move" group's rows (the server's `automove.*` settings).
async function settingsPage(cfg) {
  cfgName = `${cfg.name.replace(/-(card|long|ask|off)$/, '')}-settings`;
  const touch = !!cfg.mobile;
  await setup({ ...cfg, realOverview: true });
  await send('Page.navigate', { url: `http://localhost:${PORT}/admin/settings` });
  check('settings page loads', await waitFor(`!!document.body && document.body.innerText.includes('Without asking')`, 20000));
  const labels = ['Auto move', 'Without asking', 'Threshold', 'Projection', 'Pause', 'Per chat', 'Per day', 'Per Claude', 'Same model', 'API keys'];
  const body = await ev('document.body.innerText');
  check('settings: every Auto move row', labels.every((l) => body.includes(l)), labels.filter((l) => !body.includes(l)).join(', '));
  await ev(`[...document.querySelectorAll('body *')].find((e) => e.childElementCount === 0 && e.textContent.trim() === 'Without asking')?.scrollIntoView({ block: 'center' })`);
  await sleep(400);
  await noOverflow('settings');
  // The Auto move ⓘ explains R1 to R3 in one place (T-105).
  check('settings: a Dry run row', body.includes('Dry run'));
  await press(`document.querySelector('button[aria-label="About Auto move"]')`, touch);
  check('Auto move ⓘ: at the threshold, at once when out, the wait and the resume', await waitFor(`[...document.querySelectorAll('body *')].some((e) => e.childElementCount === 0 && /moves at once/.test(e.textContent) && /every 2 minutes/.test(e.textContent) && /goes on by itself/.test(e.textContent) && e.getBoundingClientRect().height > 0)`, 2000));
  await shot(`${cfgName}`);
  await key('Escape', 'Escape', 27);
  check('no page errors', errors.length === 0, errors.join(' | '));
  errors.length = 0;
  void touch;
}

// A real workspace's Claudes list: a Claude's ⋯ "Auto move…" dialog (its threshold and destinations).
async function claudeDialog(cfg) {
  cfgName = `${cfg.name.replace(/-(card|long|ask|off)$/, '')}-claude`;
  const touch = !!cfg.mobile;
  await setup({ ...cfg, realOverview: true });
  await send('Page.navigate', { url: `http://localhost:${PORT}/admin/workspaces` });
  // AM_WORKSPACE is the workspace's name on the list (a running one: its sheet shows its Claudes); AM_CLAUDE the Claude to open (default "Default").
  const row = `document.querySelector('button[aria-label^="Details for ${WORKSPACE}"]')`;
  if (!(await waitFor(`!!${row}`, 20000))) return check('workspace on the list', false, await ev(`document.body.innerText.slice(0, 300)`));
  await press(row, touch);
  const trigger = `document.querySelector('[aria-label="Actions for ${process.env.AM_CLAUDE ?? 'Default'}"]')`;
  if (!(await waitFor(`!!${trigger}`, 10000))) return check('workspace sheet shows its Claudes', false, await ev(`document.body.innerText.slice(0, 300)`));
  await press(trigger, touch);
  const item = `[...document.querySelectorAll('[role=menuitem]')].find((e) => e.textContent.includes('Auto move'))`;
  check('Claude ⋯ has Auto move…', await waitFor(`!!${item}`, 2000));
  await press(item, touch);
  check('Claude auto move dialog opens', await waitFor(`!!${Q.dialog('Auto move')} && !!document.querySelector('input[inputmode=numeric]')`, 4000));
  await sleep(300);
  await noOverflow('claude dialog');
  for (const b of await ev(`[...${Q.dialog('Auto move')}.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim())`)) {
    if (/^(Move .* (up|down)|Remove .*)$/.test(b)) await tall(`claude dialog ${b}`, `[...${Q.dialog('Auto move')}.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(b)})`, touch);
  }
  await shot(`${cfgName}`);
  await key('Escape', 'Escape', 27);
  check('no page errors', errors.length === 0, errors.join(' | '));
  errors.length = 0;
}

// The scratch portal's real server (T-105): the new defaults, `GET /api/autotransfer/state`, the dry run switch on and off again.
async function engineApi(cookie) {
  cfgName = 'server';
  const call = async (method, path, body) => {
    const r = await fetch(`http://localhost:${PORT}${path}`, { method, headers: { Cookie: `portal_session=${cookie}`, Origin: `http://localhost:${PORT}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const o = await call('GET', '/api/autotransfer');
  const p = o.json?.data?.platform ?? {};
  check('defaults: pause 5, per chat 8, per day 30, per Claude 3, dry run off', p.minPauseMin === 5 && p.maxPerSessionPerDay === 8 && p.maxPerDay === 30 && p.maxPerDestination === 3 && p.dryRun === false, JSON.stringify(p));
  let st = await call('GET', '/api/autotransfer/state');
  check('state route answers (dry run off, a list of chats)', st.status === 200 && st.json?.data?.dryRun === false && Array.isArray(st.json?.data?.sessions), JSON.stringify(st));
  const on = await call('PUT', '/api/settings/automove.dryRun', { value: true });
  st = await call('GET', '/api/autotransfer/state');
  check('dry run on: the state says so', on.status === 200 && st.json?.data?.dryRun === true, JSON.stringify({ on: on.status, st: st.json?.data?.dryRun }));
  await call('PUT', '/api/settings/automove.dryRun', { value: false });
  st = await call('GET', '/api/autotransfer/state');
  check('dry run off again', st.json?.data?.dryRun === false);
  const anon = await fetch(`http://localhost:${PORT}/api/autotransfer/state`);
  check('state route needs a session', anon.status === 401 || anon.status === 404, String(anon.status));
}

try {
  const cookie = await login();
  if (!only || only === 'server') await engineApi(cookie);
  await send('Network.enable');
  await send('Network.setCookie', { name: 'portal_session', value: cookie, domain: 'localhost', path: '/' });
  await send('Page.enable');
  await send('Runtime.enable');
  for (const cfg of MATRIX) {
    if (only && !cfg.name.includes(only)) continue;
    console.log(`> ${cfg.name}`);
    try { await scenario(cfg); } catch (e) { await shot(`${cfg.name}-x-error`); check('scenario ran', false, String(e.message ?? e).slice(0, 300) + ' ' + errors.join(' | ').slice(0, 400)); }
    if (cfg.id === 'card') {
      try { await settingsPage(cfg); } catch (e) { check('settings ran', false, String(e.message ?? e).slice(0, 300)); }
      if (WORKSPACE) try { await claudeDialog(cfg); } catch (e) { check('claude dialog ran', false, String(e.message ?? e).slice(0, 300)); }
    }
  }
} finally {
  cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`FAIL ${f.cfg} / ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
