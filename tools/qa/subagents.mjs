// Sub-agents in the chat (docs/prd/chat-sessions.md §22; tickets T-5 and T-31) against the REAL engine: the real session page in headless Chromium
// over CDP, a scratch portal whose local workspace runs the real Claude Code CLI with the stand-in Messages API (tools/qa/mock-anthropic.mjs) behind
// it. The stand-in's [[agent <models> <directive>]] starts one sub-agent per model in one message (background agents, as Claude Code runs them), each
// prompted with [[<directive>]]: `[[agent sonnet,fable,- steps 6 2 <file>]]` gives three agents that each work for about 12 s ("Step k." and a Read,
// one stored line at a time; Claude Code doesn't stream a sub-agent's text) while the main agent is already idle. Asserts: the main reply slot never shows an agent's text (it folds into the activity row of the turn that started it, shimmering); the header
// says "Idle · 3 agents" ("Agents" on a phone) while they run, and the Sessions row too; the Agents panel's rows carry the model as reported
// (sonnet, fable, and the inherited one), open on a tap; the detail view shows type, model, status, tokens, tool uses, time, its own transcript
// (live while it runs, newest at the bottom), Stop, and back returns to the list; an agent row in the transcript opens the same view; Stop stops one;
// 44 px targets on touch, no horizontal scroll, no page errors; at 390 px (touch, the iPhone's safe areas) and 1280 px, light and dark.
//
// Set-up (scripts/scratch-portal.sh; the recipe of btw-real.mjs on port 3421):
//   node tools/qa/mock-anthropic.mjs 4621 /tmp/cp-sa-mock.jsonl &
//   PORTAL_LOCAL_ENABLED=true scripts/scratch-portal.sh start 3421
//   printf '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4621","ANTHROPIC_API_KEY":"fake-mock-key"}}' > /tmp/scratch-portal-3421/home/.claude/settings.json
// The harness starts the local workspace and a session itself when no session id is given.
// usage: SA_PORT=3421 SA_CODE=24681372 SA_CDP=9621 node tools/qa/subagents.mjs [sessionId] [--only name] [--shots dir]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.env.SA_PORT ?? 3421);
const CODE = process.env.SA_CODE ?? '24681372';
const CDP = Number(process.env.SA_CDP ?? 9621);
const args = process.argv.slice(2);
const flagged = (a) => ['--only', '--shots'].includes(args[args.indexOf(a) - 1]);
let SID = args.find((a) => !a.startsWith('--') && !flagged(a)) ?? null;
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHONE = { top: 59, bottom: 34, left: 0, right: 0 };
const MATRIX = [
  { name: 'phone-390-light', w: 390, h: 844, mobile: true, insets: PHONE },
  { name: 'phone-390-dark', w: 390, h: 844, mobile: true, insets: PHONE, dark: true },
  { name: 'desktop-1280-light', w: 1280, h: 800, wide: true },
  { name: 'desktop-1280-dark', w: 1280, h: 800, wide: true, dark: true },
];

const BASE = `http://localhost:${PORT}`;
// The file the agents read, in the scratch portal's private home (the local workspace's folder).
const NOTES = `/tmp/scratch-portal-${PORT}/home/qa-notes.txt`;
if (existsSync(dirname(NOTES))) writeFileSync(NOTES, 'QA notes for the sub-agent harness.\n');
const STEP = /Step \d/;
let cookie = '';
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
/** A second tab on the chat socket: sends main turns and watches the session's state and tasks. */
const openChat = async () => {
  const ws = new WebSocket(`ws://localhost:${PORT}/api/chat/live`, { headers: { Cookie: `portal_session=${cookie}`, Origin: BASE } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const chat = { ws, state: null, tasks: [], acks: new Map() };
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'session') chat.state = m.session.state;
    if (m.type === 'tasks') chat.tasks = m.tasks;
    if (m.type === 'ack') chat.acks.set(m.uuid, m);
  });
  ws.send(JSON.stringify({ type: 'subscribe', session: SID, afterSeq: 0 }));
  let n = 0;
  chat.send = async (text) => { const uuid = `sa-${Date.now()}-${++n}`; ws.send(JSON.stringify({ type: 'send', session: SID, uuid, text })); for (let i = 0; i < 80 && !chat.acks.has(uuid); i++) await sleep(100); return chat.acks.get(uuid); };
  chat.idle = async (ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (chat.state === 'idle') return true; await sleep(150); } return false; };
  chat.running = () => chat.tasks.filter((t) => t.status === 'running').length;
  chat.settled = async (ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (chat.state === 'idle' && chat.running() === 0) return true; await sleep(200); } return false; };
  return chat;
};

const profile = mkdtempSync(join(tmpdir(), 'cp-sa-profile-'));
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
const click = (sel) => ev(`(() => { const e = ${sel}; if (!e) return false; e.click(); return true; })()`);

const Q = {
  composer: `document.querySelector('textarea[aria-label="Message"]')`,
  log: `document.querySelector('[role=log][aria-label=Transcript]')`,
  panel: `document.querySelector('#agents-panel')`,
  header: `document.querySelector('header')`,
};
const byText = (sel, re) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => ${re}.test(e.innerText ?? e.getAttribute('aria-label') ?? ''))`;
const hscroll = `(() => { const scrollsX = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; }; const d = document.scrollingElement; const bad = []; for (const e of document.querySelectorAll('body *')) { const r = e.getBoundingClientRect(); if (r.width && (r.right > innerWidth + 1 || r.left < -1) && !e.closest('[aria-hidden=true],.sr-only,[inert]')) { const s = getComputedStyle(e); if (s.position !== 'fixed' && s.visibility !== 'hidden' && !scrollsX(e)) bad.push(e.tagName + '.' + String(e.className).slice(0, 40)); } } return { doc: d.scrollWidth - innerWidth, bad: bad.slice(0, 3) }; })()`;
/** Every text in the transcript that shows an agent's steps, and whether it sits in an activity line or an agent row (never a reply of its own). */
const stepsPlaced = `(() => { const out = []; const w = document.createTreeWalker(${Q.log}, NodeFilter.SHOW_TEXT); for (let t = w.nextNode(); t; t = w.nextNode()) { if (!/Step \\d/.test(t.data)) continue; const el = t.parentElement; out.push(!!el.closest('button[aria-label*="Latest:"],button[aria-label^="Open agent"],[aria-label^="Open agent"]')); } return out; })()`;
/** Tap targets in the panel under 44 px on touch. */
const small = (root) => `(() => [...(${root})?.querySelectorAll('button') ?? []].filter((b) => { const r = b.getBoundingClientRect(); return r.width && (r.height < 43.5 || r.width < 43.5) && !b.closest('[aria-hidden=true]'); }).map((b) => (b.getAttribute('aria-label') ?? b.innerText).slice(0, 30) + ' ' + Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height)))()`;

const results = [];
let cfgName = '';
const check = (name, ok, detail = '') => { results.push({ cfg: cfgName, name, ok: !!ok, detail }); if (!ok) console.log(`  FAIL ${cfgName} / ${name} ${detail}`); };
const noOverflow = async (label) => { const h = await ev(hscroll); check(`${label}: no horizontal scroll`, h.doc <= 1 && h.bad.length === 0, JSON.stringify(h)); };

async function open(cfg, path = `/admin/sessions/${SID}`) {
  await send('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: !!cfg.mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: !!cfg.mobile });
  await send('Emulation.setSafeAreaInsetsOverride', { insets: cfg.insets ?? { top: 0, bottom: 0, left: 0, right: 0 } });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: cfg.dark ? 'dark' : 'light' }] });
  await send('Page.navigate', { url: `${BASE}${path}` });
  return waitFor(path.includes(SID) ? `!!${Q.composer}` : `!!document.querySelector('main')`, 20000);
}

/** Opens the Agents panel (an icon on 1280, ⋯ → Agents on a phone). */
async function openAgents(cfg) {
  if (cfg.wide || cfg.w >= 640) await click(`document.querySelector('header button[aria-label^="Agents"]')`);
  else {
    await click(`document.querySelector('header [aria-haspopup="menu"]')`);
    await waitFor(byText('[role=menuitem]', /^Agents/), 2000);
    await click(byText('[role=menuitem]', /^Agents/));
  }
  return waitFor(`!!${Q.panel}`, 3000);
}

async function scenario(cfg, chat) {
  cfgName = cfg.name;
  if (!(await open(cfg))) return check('page loads', false);
  await sleep(800);
  await chat.settled(60000);

  // 1. Three background agents (sonnet, fable, and one without a model argument: it inherits), working after the main turn ends.
  const ack = await chat.send(`[[agent sonnet,fable,- steps 6 2 ${NOTES}]]`);
  check('turn accepted', ack?.ok === true, JSON.stringify(ack));
  const idleWhileRunning = async () => { const t = Date.now(); while (Date.now() - t < 30000) { if (chat.state === 'idle' && chat.running() >= 3) return true; await sleep(150); } return false; };
  check('the main agent is idle while its three agents run', await idleWhileRunning(), `${chat.state} ${chat.running()}`);
  check('the agents’ lines show on the page', await waitFor(`/Step \\d/.test(${Q.log}.innerText)`, 15000));
  await ev(`${Q.log}.scrollTop = ${Q.log}.scrollHeight`);
  await sleep(1200);
  const placed = await ev(stepsPlaced);
  check('an agent’s text never stands as a reply: only in the activity line or an agent row', placed.length > 0 && placed.every(Boolean), JSON.stringify(placed));
  check('the activity line names a running agent and shimmers', await ev(`!!document.querySelector('[role=log] button[aria-label*="Latest: QA agent"] .shimmer')`));
  const badge = await ev(`${Q.header}.innerText`);
  check('header: idle with agents', cfg.w < 640 ? /Agents/.test(badge) : /Idle · 3 agents/.test(badge), badge.replace(/\s+/g, ' ').slice(0, 120));
  check('header: a spinner says agents still work', await ev(`!!${Q.header}.querySelector('.animate-spin, [class*=spin]')`));
  await noOverflow('agents running');
  await shot(`${cfg.name}-1-idle-agents-running`);

  // 2. The Agents panel: models as reported, rows that open.
  check('the Agents panel opens', await openAgents(cfg));
  await sleep(400);
  const rows = await ev(`[...${Q.panel}.querySelectorAll('li > button')].map((b) => b.innerText.replace(/\\s+/g, ' '))`);
  check('three rows', rows.length >= 3, JSON.stringify(rows));
  const modelOf = (re) => rows.find((r) => re.test(r)) ?? '';
  check('the sonnet agent says sonnet', /sonnet/i.test(modelOf(/QA agent \d \(sonnet\)/)), modelOf(/\(sonnet\)/));
  check('the fable agent says fable', /fable/i.test(modelOf(/QA agent \d \(fable\)/)), modelOf(/\(fable\)/));
  const inherited = rows.find((r) => /QA agent \d(?! \()/.test(r)) ?? '';
  check('the agent without a model argument shows the one it runs on, not "unavailable"', /(sonnet|opus|fable|haiku)/i.test(inherited.replace(/QA agent \d/, '')) && !/unavailable/i.test(inherited), inherited);
  if (cfg.mobile) check('panel targets are 44 px on touch', (await ev(small(Q.panel))).length === 0, JSON.stringify(await ev(small(Q.panel))));
  await noOverflow('panel');
  await shot(`${cfg.name}-2-panel`);

  // 3. The detail view of the fable agent, while it runs: facts, live transcript, Stop; back returns to the list.
  await click(byText(`#agents-panel li > button`, /\(fable\)/));
  check('the detail view opens', await waitFor(`/^Agent$/m.test(${Q.panel}.querySelector('h2')?.innerText ?? '')`, 3000));
  const facts = await ev(`${Q.panel}.innerText`);
  check('detail: type, model, status, tokens, tool uses, time', /general-purpose/i.test(facts) && /Model\s+fable/i.test(facts) && /Running/.test(facts) && /Tokens/.test(facts) && /Tool uses/.test(facts) && /Time\s+\d/.test(facts), facts.replace(/\s+/g, ' ').slice(0, 300));
  check('detail: Stop while it runs', await ev(`!!${Q.panel}.querySelector('button[aria-label^="Stop QA agent"]')`));
  const n0 = await ev(`(${Q.panel}.querySelector('section')?.innerText.match(/Step \\d/g) ?? []).length`);
  check('detail: its transcript is live (new lines while it runs)', await waitFor(`(${Q.panel}.querySelector('section')?.innerText.match(/Step \\d/g) ?? []).length > ${n0}`, 8000), `from ${n0}`);
  check('detail: newest at the bottom, in view', await ev(`(() => { const s = ${Q.panel}.querySelector('section').parentElement; return s.scrollHeight - s.scrollTop - s.clientHeight < 90; })()`));
  if (cfg.mobile) check('detail targets are 44 px on touch', (await ev(small(Q.panel))).length === 0, JSON.stringify(await ev(small(Q.panel))));
  await noOverflow('detail running');
  await shot(`${cfg.name}-3-detail-running`);
  check('the agents finish', await chat.settled(40000), `${chat.state} ${chat.running()}`);
  check('detail: Done, with the result and its stored text, newest at the bottom', await waitFor(`/Done/.test(${Q.panel}.innerText) && /Result/.test(${Q.panel}.innerText) && /All 6 steps done/.test(${Q.panel}.querySelector('section').innerText)`, 8000), (await ev(`${Q.panel}.innerText`)).replace(/\s+/g, ' ').slice(0, 300));
  check('detail: no Stop once done', !(await ev(`!!${Q.panel}.querySelector('button[aria-label^="Stop QA agent"]')`)));
  await noOverflow('detail done');
  await shot(`${cfg.name}-4-detail-done`);
  await click(`${Q.panel}.querySelector('button[aria-label="Back to agents"]')`);
  check('back returns to the list', await waitFor(`/^Agents$/.test(${Q.panel}.querySelector('h2')?.innerText ?? '')`, 2000));
  await click(`document.querySelector('button[aria-label="Close agents"], button[aria-label="Hide agents"]')`);
  await waitFor(`!${Q.panel}`, 2000);

  // 4. Done: the header is plain Idle; the activity row opens to the agent rows, and one opens the same detail view.
  const plain = await ev(`${Q.header}.innerText`);
  check('header: plain idle once they are done', /Idle/.test(plain) && !/agents/.test(plain), plain.replace(/\s+/g, ' ').slice(0, 80));
  const act = `[...document.querySelectorAll('[role=log] button[aria-label*="Latest:"]')].at(-1)`;
  await click(act);
  check('the activity row lists the agent rows', await waitFor(`!!document.querySelector('[role=log] button[aria-label^="Open agent QA agent"]')`, 3000));
  check('no step text outside them', (await ev(stepsPlaced)).every(Boolean), JSON.stringify(await ev(stepsPlaced)));
  if (cfg.mobile) {
    const h = await ev(`document.querySelector('[role=log] button[aria-label^="Open agent"]').getBoundingClientRect().height`);
    check('agent row is 44 px on touch', h >= 43.5, String(h));
  }
  await noOverflow('activity open');
  await shot(`${cfg.name}-5-activity-agents`);
  await click(`document.querySelector('[role=log] button[aria-label^="Open agent QA agent"]')`);
  check('an agent row opens its detail view', await waitFor(`!!${Q.panel} && /^Agent$/m.test(${Q.panel}.querySelector('h2')?.innerText ?? '')`, 3000));
  await shot(`${cfg.name}-6-detail-from-transcript`);
  await click(`document.querySelector('button[aria-label="Close agents"], button[aria-label="Hide agents"]')`);
  await waitFor(`!${Q.panel}`, 2000);

  // 5. Stop one agent from its detail view.
  if (cfg.name.endsWith('light')) {
    await chat.send(`[[agent haiku steps 30 2 ${NOTES}]]`);
    await waitFor(`/QA agent 1 \\(haiku\\)/.test(${Q.log}.innerText)`, 20000);
    await openAgents(cfg);
    await click(byText(`#agents-panel li > button`, /\(haiku\)/));
    await waitFor(`!!${Q.panel}.querySelector('button[aria-label^="Stop QA agent"]')`, 3000);
    await click(`${Q.panel}.querySelector('button[aria-label^="Stop QA agent"]')`);
    check('Stop stops it', await waitFor(`/Stopped/.test(${Q.panel}.innerText)`, 20000), (await ev(`${Q.panel}.innerText`)).replace(/\s+/g, ' ').slice(0, 200));
    await shot(`${cfg.name}-7-stopped`);
    await click(`document.querySelector('button[aria-label="Close agents"], button[aria-label="Hide agents"]')`);
    await chat.settled(30000);
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
  errors.length = 0;
}

/** The Sessions row while agents run and the main agent is idle. */
async function sessionsRow(cfg, chat) {
  cfgName = `${cfg.name}-sessions`;
  await chat.settled(60000);
  await chat.send(`[[agent sonnet,- steps 6 2 ${NOTES}]]`);
  const t = Date.now();
  while (Date.now() - t < 30000 && !(chat.state === 'idle' && chat.running() >= 2)) await sleep(150);
  if (!(await open(cfg, '/admin/sessions'))) return check('sessions page loads', false);
  const want = cfg.w < 640 ? /Agents/ : /Idle · 2 agents/;
  check('the Sessions row says agents still run', await waitFor(`${want}.test(document.querySelector('main').innerText)`, 8000), (await ev(`document.querySelector('main').innerText`)).replace(/\s+/g, ' ').slice(0, 200));
  await noOverflow('sessions');
  await shot(`${cfg.name}-8-sessions-row`);
  await chat.settled(40000);
  check('no page errors', errors.length === 0, errors.join(' | '));
  errors.length = 0;
}

try {
  cookie = await login();
  if (!SID) {
    await api('POST', '/api/workspaces/local/local/start').catch(() => undefined);
    SID = (await api('POST', '/api/chat/sessions', { workspaceId: 'local/local', title: 'Sub-agents QA' })).id;
    console.log(`session ${SID}`);
  }
  const chat = await openChat();
  await send('Network.enable');
  await send('Network.setCookie', { name: 'portal_session', value: cookie, domain: 'localhost', path: '/' });
  await send('Page.enable');
  await send('Runtime.enable');
  for (const cfg of MATRIX) {
    if (only && !cfg.name.includes(only)) continue;
    console.log(`> ${cfg.name}`);
    try { await scenario(cfg, chat); } catch (e) { await shot(`${cfg.name}-x-error`); check('scenario ran', false, String(e.message ?? e).slice(0, 300)); }
    if (!cfg.dark) try { await sessionsRow(cfg, chat); } catch (e) { check('sessions row ran', false, String(e.message ?? e).slice(0, 300)); }
  }
  chat.ws.close();
} finally {
  cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`FAIL ${f.cfg} / ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
