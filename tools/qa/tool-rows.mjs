// Tool rows and approvals (docs/prd/chat-sessions.md FR7; ticket T-24) against the REAL engine: the real session page in headless Chromium over
// CDP, a scratch portal whose local workspace runs the real Claude Code CLI with the stand-in Messages API (tools/qa/mock-anthropic.mjs) behind
// it; `[[bash <command>]]` and `[[write <path> <text>]]` make the tool calls. Asserts: the approval card shows the whole command in the shared
// renderer (coloured, wrapped, the tail behind 150 spaces reachable, Allow only once read to the end); a row opens to Input and Output; Input
// is the command as written (real line breaks, a heredoc's lines, unicode, a disguising character marked as its escape), coloured, with
// Copy, a wrap switch and "N lines"; a Write shows its path and added lines; Output shows a 5,000-line output as its ends and "Show all (5,000
// lines)", then all of it; a failure opens by itself with its exit status in the danger tone; a row's open state survives its activity row
// closing; 44 px targets on touch, no horizontal scroll, no page errors; at 390 px (touch, the iPhone's safe areas) and 1280 px, light and dark.
//
// Set-up (as subagents.mjs, port 3421):
//   node tools/qa/mock-anthropic.mjs 4621 /tmp/cp-tr-mock.jsonl &
//   PORTAL_LOCAL_ENABLED=true scripts/scratch-portal.sh start 3421
//   printf '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4621","ANTHROPIC_API_KEY":"fake-mock-key"}}' > /tmp/scratch-portal-3421/home/.claude/settings.json
// usage: TR_PORT=3421 TR_CODE=24681372 TR_CDP=9622 node tools/qa/tool-rows.mjs [--only name] [--shots dir]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.env.TR_PORT ?? 3421);
const CODE = process.env.TR_CODE ?? '24681372';
const CDP = Number(process.env.TR_CDP ?? 9622);
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHONE = { top: 59, bottom: 34, left: 0, right: 0 };
const MATRIX = [
  { name: 'phone-390-light', w: 390, h: 844, mobile: true, insets: PHONE },
  { name: 'phone-390-dark', w: 390, h: 844, mobile: true, insets: PHONE, dark: true },
  { name: 'desktop-1280-light', w: 1280, h: 800 },
  { name: 'desktop-1280-dark', w: 1280, h: 800, dark: true },
];

const BASE = `http://localhost:${PORT}`;
const RLO = '\u202E';
// The commands, each its own turn. The stand-in reads `[[bash <command>]]` up to the first `]`: none of them has one.
const CMD = {
  pipes: `cd /tmp && printf 'alpha\\nbeta\\ngamma\\n' | grep -v beta | sort -r | sed -e 's/a/A/g' | tee /tmp/cp-tr-out.txt | wc -l # count what is left after the filter`,
  heredoc: `cat <<'EOF' > /tmp/cp-tr-heredoc.sh\n#!/bin/sh\necho "héllo wörld ✓ — 你好 😀"\nfor i in 1 2 3; do echo "line $i"; done\nEOF\nsh /tmp/cp-tr-heredoc.sh`,
  many: 'yes ok | head -n 5000',
  seq: 'seq 1 5000',
  rlo: `echo "abc${RLO}def" && echo 'ünïcødé 😀'`,
  fail: 'ls /nonexistent-cp-tr && echo never',
};
// Claude Code runs a plain echo without asking: the tail writes a file, so it asks.
const HIDDEN_TAIL = `echo safe${' '.repeat(150)}; touch /tmp/cp-tr-tail-visible`;

let cookie = '';
let SID = null;
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: `portal_session=${cookie}` }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.data;
};
const login = async () => {
  const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ code: CODE }) });
  const m = /portal_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '');
  if (!m) throw new Error(`login failed ${r.status}`);
  return m[1];
};
/** A second tab on the chat socket: sends turns, answers requests, watches the state. */
const openChat = async () => {
  const ws = new WebSocket(`ws://localhost:${PORT}/api/chat/live`, { headers: { Cookie: `portal_session=${cookie}`, Origin: BASE } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const chat = { ws, state: null, acks: new Map(), requests: [], resolved: new Set(), autoAllow: true, seen: [] };
  let n = 0;
  const allow = (requestId) => ws.send(JSON.stringify({ type: 'respond', session: SID, requestId, decision: 'allow' }));
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'session') chat.state = m.session.state;
    if (m.type === 'ack') chat.acks.set(m.uuid, m);
    if (m.type === 'events') for (const e of m.items) {
      chat.seen.push(`${e.kind}${e.outcome ? `:${e.outcome}` : ''}`);
      if (e.kind === 'request' && e.request) { chat.requests.push(e.request); if (chat.autoAllow) allow(e.request.requestId); }
      if (e.kind === 'resolved' && e.requestId) chat.resolved.add(e.requestId);
    }
  });
  ws.send(JSON.stringify({ type: 'subscribe', session: SID, afterSeq: 0 }));
  chat.allow = allow;
  chat.control = (op, a) => ws.send(JSON.stringify({ type: 'control', session: SID, op, uuid: `tr-c-${++n}`, args: a }));
  chat.send = async (text) => { const uuid = `tr-${Date.now()}-${++n}`; ws.send(JSON.stringify({ type: 'send', session: SID, uuid, text })); for (let i = 0; i < 80 && !chat.acks.has(uuid); i++) await sleep(100); return chat.acks.get(uuid); };
  chat.idle = async (ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (chat.state === 'idle') return true; await sleep(150); } return false; };
  return chat;
};

const profile = mkdtempSync(join(tmpdir(), 'cp-tr-profile-'));
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
const waitFor = async (expr, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(80); } return false; };
/** A screenshot with `el` at the top of the transcript (the transcript keeps to its bottom while rows open: scroll again once it settles). */
const shotAt = async (el, name) => {
  // Only the reader leaves the bottom (a scroll right after a wheel, touch or key): a wheel first, then the scroll.
  await ev(`${LOG}.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }))`);
  await ev(`(() => { const e = ${el}; const l = ${LOG}; if (e) l.scrollTop += e.getBoundingClientRect().top - l.getBoundingClientRect().top - 120; })()`);
  await sleep(300);
  if (process.env.TR_DEBUG) console.log(name, await ev(`(() => { const e = ${el}; const l = ${LOG}; return { found: !!e, top: e && Math.round(e.getBoundingClientRect().top), st: Math.round(l.scrollTop), sh: l.scrollHeight, ch: l.clientHeight, scroller: getComputedStyle(l).overflowY }; })()`));
  await shot(name);
};
const click = (sel) => ev(`(() => { const e = ${sel}; if (!e) return false; e.click(); return true; })()`);

const LOG = `document.querySelector('[role=log][aria-label=Transcript]')`;
const CARD = `document.querySelector('[data-approval=card]')`;
const REVIEW = `${CARD}?.querySelector('[aria-label="What is being allowed"]')`;
const hscroll = `(() => { const scrollsX = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; }; const d = document.scrollingElement; const bad = []; for (const e of document.querySelectorAll('body *')) { const r = e.getBoundingClientRect(); if (r.width && (r.right > innerWidth + 1 || r.left < -1) && !e.closest('[aria-hidden=true],.sr-only,[inert]')) { const s = getComputedStyle(e); if (s.position !== 'fixed' && s.visibility !== 'hidden' && !scrollsX(e)) bad.push(e.tagName + '.' + String(e.className).slice(0, 40)); } } return { doc: d.scrollWidth - innerWidth, bad: bad.slice(0, 3) }; })()`;
/** Buttons inside `root` under 44 px on touch. */
const small = (root) => `(() => [...(${root})?.querySelectorAll('button') ?? []].filter((b) => { const r = b.getBoundingClientRect(); return r.width && (r.height < 43.5 || r.width < 43.5) && !b.closest('[aria-hidden=true]'); }).map((b) => (b.getAttribute('aria-label') ?? b.innerText).slice(0, 30) + ' ' + Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height)))()`;
/** The tool row's button whose one-line summary starts like `cmd` (folded as the portal folds it). */
const rowButton = (cmd) => `[...${LOG}.querySelectorAll('button[aria-expanded]:not([aria-label*="Latest:"])')].find((b) => b.innerText.startsWith('Bash') && b.innerText.replace(/\\s+/g, ' ').includes(${JSON.stringify(cmd.replace(/\s+/g, ' ').replaceAll(RLO, '⟦U+202E⟧').slice(0, 24))}))`;
/** The open body of a row (the element its button controls). */
const rowBody = (cmd) => `(() => { const b = ${rowButton(cmd)}; return b ? document.getElementById(b.getAttribute('aria-controls')) : null; })()`;

const results = [];
let cfgName = '';
const check = (name, ok, detail = '') => { results.push({ cfg: cfgName, name, ok: !!ok, detail }); if (!ok) console.log(`  FAIL ${cfgName} / ${name} ${detail}`); };
const noOverflow = async (label) => { const h = await ev(hscroll); check(`${label}: no horizontal scroll`, h.doc <= 1 && h.bad.length === 0, JSON.stringify(h)); };

async function open(cfg) {
  await send('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: !!cfg.mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: !!cfg.mobile });
  await send('Emulation.setSafeAreaInsetsOverride', { insets: cfg.insets ?? { top: 0, bottom: 0, left: 0, right: 0 } });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: cfg.dark ? 'dark' : 'light' }] });
  await send('Page.navigate', { url: `${BASE}/admin/sessions/${SID}` });
  return waitFor(`!!document.querySelector('textarea[aria-label="Message"]')`, 20000);
}

/** Opens every activity row, so the tool rows are on the page. */
const openActivities = () => ev(`(() => { let k = 0; for (const b of ${LOG}.querySelectorAll('button[aria-label*="Latest:"][aria-expanded=false]')) { b.click(); k++; } return k; })()`);
/** Opens one tool row (if closed) and scrolls it into view. */
async function openRow(cmd) {
  await openActivities();
  await sleep(150);
  if (!(await waitFor(`!!${rowButton(cmd)}`, 4000))) return false;
  if ((await ev(`${rowButton(cmd)}.getAttribute('aria-expanded')`)) !== 'true') await click(rowButton(cmd));
  await ev(`${rowButton(cmd)}.scrollIntoView({ block: 'start' })`);
  return waitFor(`!!${rowBody(cmd)}?.querySelector('section[aria-label=Input]')`, 3000);
}

async function approval(cfg) {
  cfgName = `${cfg.name}-approval`;
  if (!(await open(cfg))) return check('page loads', false);
  check('the card shows', await waitFor(`!!${CARD}`, 8000));
  const text = await ev(`${REVIEW}?.innerText ?? ''`);
  check('the whole command, its tail included', text.includes('; touch /tmp/cp-tr-tail-visible') && text.includes(' '.repeat(150)), JSON.stringify(text.slice(-40)));
  check('coloured as shell (commands and operators marked)', await ev(`${REVIEW}.querySelectorAll('span.font-semibold').length >= 3`));
  check('always wrapped', (await ev(`getComputedStyle(${REVIEW}).whiteSpace`)) === 'pre-wrap');
  check('the same code font as the rows', /monospace/.test(await ev(`getComputedStyle(${REVIEW}).fontFamily`)));
  const allowState = `[...${CARD}.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Allow')?.disabled`;
  const overflows = await ev(`${REVIEW}.scrollHeight - ${REVIEW}.clientHeight > 1`);
  if (overflows) {
    check('Allow waits until the text is read to the end', (await ev(allowState)) === true);
    await ev(`${REVIEW}.scrollTop = ${REVIEW}.scrollHeight`);
    check('read to the end, Allow can be pressed', await waitFor(`${allowState} === false`, 2000));
  } else check('it fits: Allow can be pressed', (await ev(allowState)) === false);
  await noOverflow('approval');
  await shot(`${cfg.name}-1-approval`);
  check('no page errors', errors.length === 0, errors.join(' | '));
  errors.length = 0;
}

async function rows(cfg) {
  cfgName = cfg.name;
  if (!(await open(cfg))) return check('page loads', false);
  await sleep(800);

  // 1. A pipe chain: the command as written, coloured; Copy, wrap, and the switch to one long line that scrolls on its own.
  check('the pipe row opens to Input and Output', await openRow(CMD.pipes));
  const body = rowBody(CMD.pipes);
  const input = `${body}.querySelector('section[aria-label=Input] pre')`;
  check('Input is the command as written', (await ev(`${input}.innerText`)) === CMD.pipes, JSON.stringify((await ev(`${input}.innerText`)).slice(0, 80)));
  check('pipes and && are operators, the comment a comment', await ev(`(() => { const s = [...${input}.querySelectorAll('span')]; return s.filter((e) => e.innerText === '|' && e.className.includes('font-semibold')).length >= 4 && s.some((e) => e.className.includes('italic') && e.innerText.startsWith('# count')); })()`));
  check('Output shows what it printed', /2/.test(await ev(`${body}.querySelector('section[aria-label=Output] pre')?.innerText ?? ''`)));
  check('Copy and the wrap switch', await ev(`!!${body}.querySelector('button[aria-label=Copy]') && !!${body}.querySelector('button[aria-pressed]')`));
  if (cfg.mobile) check('block buttons are 44 px on touch', (await ev(small(body))).length === 0, JSON.stringify(await ev(small(body))));
  await shotAt(rowButton(CMD.pipes), `${cfg.name}-2-pipes`);
  await click(`${body}.querySelector('section[aria-label=Input] button[aria-pressed]')`);
  await sleep(100);
  check('unwrapped, the line scrolls inside its block', await ev(`getComputedStyle(${input}).whiteSpace === 'pre' && ${input}.scrollWidth > ${input}.clientWidth`) || !cfg.mobile);
  await noOverflow('unwrapped command');
  await click(`${body}.querySelector('section[aria-label=Input] button[aria-pressed]')`);

  // 2. A heredoc: its lines kept, "6 lines", unicode in and out.
  check('the heredoc row opens', await openRow(CMD.heredoc));
  const hd = rowBody(CMD.heredoc);
  const hdText = await ev(`${hd}.querySelector('section[aria-label=Input] pre').innerText`);
  check('the heredoc keeps its lines', hdText === CMD.heredoc, JSON.stringify(hdText.slice(0, 120)));
  check('"6 lines"', /6 lines/.test(await ev(`${hd}.querySelector('section[aria-label=Input]').innerText`)));
  check('the body is one heredoc colour, nothing in it a comment', await ev(`(() => { const s = [...${hd}.querySelectorAll('section[aria-label=Input] pre span')]; return !s.some((e) => e.className.includes('italic')) && s.some((e) => e.innerText.includes('#!/bin/sh') && e.className.includes('emerald')); })()`));
  check('unicode comes out whole', (await ev(`${hd}.querySelector('section[aria-label=Output]').innerText`)).includes('héllo wörld ✓ — 你好 😀'));
  await noOverflow('heredoc');
  await shotAt(rowButton(CMD.heredoc), `${cfg.name}-3-heredoc`);

  // 3. 5,000 lines: its ends and Show all, then all of it.
  check('the 5,000-line row opens', await openRow(CMD.many));
  const many = rowBody(CMD.many);
  const outText = `${many}.querySelector('section[aria-label=Output]').innerText`;
  check('"5,000 lines" and Show all', /5,000 lines/.test(await ev(outText)) && !!(await ev(`!!${many}.querySelector('section[aria-label=Output] pre button')`)));
  check('only the ends are drawn at first', (await ev(`${many}.querySelector('section[aria-label=Output] pre').innerText.split('\\n').length`)) < 100);
  await shotAt(rowButton(CMD.many), `${cfg.name}-4-many-clipped`);
  const t0 = Date.now();
  await click(`${many}.querySelector('section[aria-label=Output] pre button')`);
  check('Show all draws every line', await waitFor(`${many}.querySelector('section[aria-label=Output] pre').innerText.split('\\n').filter(Boolean).length >= 5000`, 3000));
  check('quickly', Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
  await noOverflow('5,000 lines');
  await shotAt(rowButton(CMD.many), `${cfg.name}-5-many-all`);

  // 4. Longer than the portal keeps: the head, the tail and what was left out between.
  check('the seq row opens', await openRow(CMD.seq));
  check('what was not kept is said, and the tail is there', await ev(`(() => { const t = ${rowBody(CMD.seq)}.querySelector('section[aria-label=Output]').innerText; return /characters not kept/.test(t) || /5000\\s*$/.test(t); })()`));

  // 5. A disguising character is marked as its escape.
  check('the RLO row opens', await openRow(CMD.rlo));
  check('the override shows as ⟦U+202E⟧, marked', await ev(`[...${rowBody(CMD.rlo)}.querySelectorAll('section[aria-label=Input] span')].some((s) => s.innerText === '⟦U+202E⟧' && s.className.includes('danger'))`));
  check('nor does the row’s line or the output carry the raw override', await ev(`!${rowButton(CMD.rlo)}.innerText.includes('\u202E') && !${rowBody(CMD.rlo)}.innerText.includes('\u202E') && ${rowBody(CMD.rlo)}.querySelector('section[aria-label=Output]').innerText.includes('⟦U+202E⟧')`));
  await shotAt(rowButton(CMD.rlo), `${cfg.name}-6-escape`);

  // 6. A failure opens by itself, its exit status in the danger tone.
  await openActivities();
  await sleep(150);
  check('a failing row is open without a tap', (await ev(`${rowButton(CMD.fail)}?.getAttribute('aria-expanded')`)) === 'true');
  const failOut = `${rowBody(CMD.fail)}?.querySelector('section[aria-label=Output]')`;
  check('its exit status, in the danger tone', await ev(`/exit [1-9]/.test(${failOut}.innerText) && ${failOut}.querySelector('pre').className.includes('text-danger')`), await ev(`${failOut}?.innerText.slice(0, 80) ?? ''`));
  await ev(`${rowButton(CMD.fail)}.scrollIntoView({ block: 'center' })`);
  await shotAt(rowButton(CMD.fail), `${cfg.name}-7-failure`);

  // 7. A Write: its path and its lines, added.
  const write = `[...${LOG}.querySelectorAll('button[aria-expanded]:not([aria-label*="Latest:"])')].find((b) => b.innerText.startsWith('Write'))`;
  if (await waitFor(`!!${write}`, 2000)) {
    if ((await ev(`${write}.getAttribute('aria-expanded')`)) !== 'true') await click(write);
    const w = `document.getElementById(${write}.getAttribute('aria-controls'))`;
    check('a Write shows its path and its added lines', await waitFor(`/cp-tr-w\\.txt/.test(${w}?.innerText ?? '') && /hello from qa/.test(${w}.innerText) && !!${w}.querySelector('.bg-accent-soft')`, 2000));
    await ev(`${write}.scrollIntoView({ block: 'start' })`);
    await shot(`${cfg.name}-8-write`);
  } else check('the Write row is there', false);

  // 8. A row stays as it was left when its activity row closes and opens again.
  const act = `${rowButton(CMD.pipes)}.closest('[id]')?.parentElement?.querySelector('button[aria-label*="Latest:"]') ?? [...${LOG}.querySelectorAll('button[aria-label*="Latest:"]')].find((b) => b.nextElementSibling?.contains(${rowButton(CMD.pipes)}))`;
  const actEl = await ev(`!!(${act})`);
  if (actEl) {
    await ev(`window.__trAct = ${act}; window.__trAct.click()`);
    await sleep(200);
    await ev(`window.__trAct.click()`);
    check('the pipe row is still open after its activity row closed and opened', await waitFor(`${rowButton(CMD.pipes)}?.getAttribute('aria-expanded') === 'true'`, 2000));
  }
  await noOverflow('all rows');
  check('no page errors', errors.length === 0, errors.join(' | '));
  errors.length = 0;
}

try {
  cookie = await login();
  await api('POST', '/api/workspaces/local/local/start').catch(() => undefined);
  SID = (await api('POST', '/api/chat/sessions', { workspaceId: 'local/local', title: 'Tool rows QA' })).id;
  console.log(`session ${SID}`);
  const chat = await openChat();
  await send('Network.enable');
  await send('Network.setCookie', { name: 'portal_session', value: cookie, domain: 'localhost', path: '/' });
  await send('Page.enable');
  await send('Runtime.enable');

  // The approval: a command whose tail sits behind 150 spaces, held open while every configuration looks at the card.
  await chat.idle(60000);
  chat.control('mode', { mode: 'default' });
  await sleep(500);
  chat.autoAllow = false;
  await chat.send(`[[bash ${HIDDEN_TAIL}]]`);
  const t = Date.now();
  while (Date.now() - t < 30000 && !chat.requests.length) await sleep(150);
  if (chat.requests.length) {
    for (const cfg of MATRIX) if (!only || cfg.name.includes(only)) await approval(cfg);
    for (const r of chat.requests) chat.allow(r.requestId);
  } else console.log(`  (no approval asked: the session runs Bash without asking; the card was not looked at; events ${chat.seen.join(' ')})`);
  chat.autoAllow = true;
  await chat.idle(60000);

  for (const cmd of Object.values(CMD)) {
    const ack = await chat.send(`[[bash ${cmd}]]`);
    if (!ack?.ok) console.log(`  send refused: ${JSON.stringify(ack)}`);
    await sleep(500);
    await chat.idle(60000);
  }
  await chat.send('[[write /tmp/cp-tr-w.txt hello from qa]]');
  await sleep(500);
  await chat.idle(60000);

  for (const cfg of MATRIX) {
    if (only && !cfg.name.includes(only)) continue;
    console.log(`> ${cfg.name}`);
    try { await rows(cfg); } catch (e) { await shot(`${cfg.name}-x-error`); check('scenario ran', false, String(e.message ?? e).slice(0, 300)); }
  }
  chat.ws.close();
} finally {
  cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`FAIL ${f.cfg} / ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
