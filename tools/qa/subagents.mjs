// Sub-agents in the chat (docs/prd/chat-sessions.md §22; tickets T-5 and T-31) against the REAL engine: the real session page in headless Chromium
// over CDP, a scratch portal whose local workspace runs the real Claude Code CLI with the stand-in Messages API (tools/qa/mock-anthropic.mjs) behind
// it. The stand-in's [[agent <models> <directive>]] starts one sub-agent per model in one message (background agents, as Claude Code runs them), each
// prompted with [[<directive>]]: `[[agent sonnet,fable,- steps 6 2 <file>]]` gives three agents that each work for about 12 s ("Step k." and a Read,
// one stored line at a time; Claude Code doesn't stream a sub-agent's text) while the main agent is already idle. Asserts: the main reply slot never shows an agent's text (it folds into the activity row of the turn that started it, shimmering); the header
// says "Working · 3 agents" ("Working" on a phone) while they run (the main turn is over: T-41), and the Sessions row too; the Agents panel's rows carry the model as reported
// (sonnet, fable, and the inherited one), open on a tap; the detail view shows type, model, status, tokens, tool uses, time, its own transcript
// (live while it runs, newest at the bottom), Stop, and back returns to the list; an agent row in the transcript opens the same view; Stop stops one;
// 44 px targets on touch, no horizontal scroll, no page errors; at 390 px (touch, the iPhone's safe areas) and 1280 px, light and dark.
// The panel's list (T-149): three background commands first ([[bg …]]: one Claude described, one named by its long command line, one that
// fails) and then the agents give it every group; checked: rows of one height that hold still while lines change (bounding boxes before and
// after a live update), short labels (never the command line), the sticky groups with counts (Agents, Failed open, Done folded), the chips
// as filters, search (a field on 1280, behind an icon on a phone), a command's detail (the whole command in the code block, exit code, copy)
// and back to the same filter; Stop on a running command's row, once, on a session of its own (it can end the session: see commandStop).
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
// Its own title each run: the Sessions row check finds the row by its title, and an earlier run's session (ended, say) must not answer.
const TITLE = `Sub-agents QA ${Date.now().toString(36)}`;
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
  const allowed = new Set();
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    // [[bg …]] asks to run its commands (Manual mode): allowed here, each once.
    if (m.type === 'events') for (const e of m.items ?? []) if (e.kind === 'request' && e.request?.requestId && !allowed.has(e.request.requestId)) (allowed.add(e.request.requestId), ws.send(JSON.stringify({ type: 'respond', session: SID, requestId: e.request.requestId, decision: 'allow' })));
    if (m.type === 'session') (chat.state = m.session.state), (chat.tasksOnly = !!m.session.tasksOnly);
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

/** The panel's rows: task id, the text of each line, the group it sits in, and its box. */
const panelRows = `[...document.querySelectorAll('#agents-panel li[data-task]')].map((li) => { const r = li.getBoundingClientRect(); const b = li.querySelector('button'); const spans = b.querySelectorAll(':scope > span:nth-of-type(2) > span'); return { id: li.dataset.task, label: spans[0]?.querySelector('span')?.innerText ?? '', l1: spans[0]?.innerText ?? '', line: spans[1]?.innerText ?? '', group: li.closest('section')?.querySelector('h3, button[aria-expanded]')?.innerText.replace(/\\s+/g, ' ') ?? '', top: Math.round(r.top), h: Math.round(r.height) }; })`;
/** The group headers: their text ("AGENTS 3"), and whether a folded one is open. */
const groupHeads = `[...document.querySelectorAll('#agents-panel section')].map((s) => { const h = s.querySelector('h3, button[aria-expanded]'); return { text: [...h.querySelectorAll('span')].map((x) => x.innerText.trim()).join(' '), folded: h.getAttribute('aria-expanded') === 'false', rows: s.querySelectorAll('li').length }; })`;
const chip = (id) => `document.querySelector('#agents-panel [data-chip=${id}]')`;
/** Types into the panel's search field the way a person does (React reads the input event). */
const typeSearch = (text) => `(() => { const i = document.querySelector('#agents-search'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;

const results = [];
/** The chat tab (its tasks: what the counts must equal). */
let chat0 = null;
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
  if (await ev(`!!${Q.panel}`)) return true; // restored open from the last look: a click would close it
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

  // 0. Three background commands (T-149): one Claude described, one named by its long command line, one that fails; done before the agents.
  const bg = await chat.send(`[[bg QA described::sleep 1 && echo ok;;cd /tmp && timeout 30 node --import tsx --test /tmp/qa-none.test.mjs 2>&1 | tail -3;;ls /tmp/qa-missing-dir]]`);
  check('background commands accepted', bg?.ok === true, JSON.stringify(bg));
  check('the background commands end', await chat.settled(40000), `${chat.state} ${chat.running()}`);

  // 1. Three background agents (sonnet, fable, and one without a model argument: it inherits), working after the main turn ends.
  const ack = await chat.send(`[[agent sonnet,fable,- steps 8 2 ${NOTES}]]`);
  check('turn accepted', ack?.ok === true, JSON.stringify(ack));
  const idleWhileRunning = async () => { const t = Date.now(); while (Date.now() - t < 30000) { if (chat.state === 'working' && chat.tasksOnly && chat.running() >= 3) return true; await sleep(150); } return false; };
  check('the main turn is over, and the session works on while its three agents run (tasksOnly)', await idleWhileRunning(), `${chat.state} ${chat.tasksOnly} ${chat.running()}`);
  // The commands' turns above make the transcript longer than a phone: keep its end in view while the lines come. An agent's "Step k."
  // shows for a moment only (its Read follows at once), so its latest line in the activity row counts too ("QA agent 2 (fable) · Read …").
  check('the agents’ lines show on the page', await waitFor(`(${Q.log}.scrollTop = ${Q.log}.scrollHeight, /Step \\d|QA agent \\d[^\\n·]*· Read/.test(${Q.log}.innerText))`, 15000));
  await ev(`${Q.log}.scrollTop = ${Q.log}.scrollHeight`);
  await sleep(1200);
  const placed = await ev(stepsPlaced);
  // The line may name the agent's latest tool rather than a "Step" line: none is fine, any one outside an agent's place fails.
  check('an agent’s text never stands as a reply: only in the activity line or an agent row', placed.every(Boolean), JSON.stringify(placed));
  check('the activity line names a running agent and shimmers', await ev(`!!document.querySelector('[role=log] button[aria-label*="Latest: QA agent"] .shimmer')`));
  const badge = await ev(`${Q.header}.innerText`);
  check('header: working with agents', cfg.w < 640 ? /Working/.test(badge) : /Working · 3 agents/.test(badge), badge.replace(/\s+/g, ' ').slice(0, 120));
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
  await listChecks(cfg);

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
  check('detail: Done, with the result and its stored text, newest at the bottom', await waitFor(`/Done/.test(${Q.panel}.innerText) && /Result/i.test(${Q.panel}.innerText) && /All 8 steps done/.test(${Q.panel}.querySelector('section').innerText)`, 8000), (await ev(`${Q.panel}.innerText`)).replace(/\s+/g, ' ').slice(0, 300));
  check('detail: no Stop once done', !(await ev(`!!${Q.panel}.querySelector('button[aria-label^="Stop QA agent"]')`)));
  await noOverflow('detail done');
  await shot(`${cfg.name}-4-detail-done`);
  await click(`${Q.panel}.querySelector('button[aria-label="Back to agents"]')`);
  check('back returns to the list', await waitFor(`/^Agents$/.test(${Q.panel}.querySelector('h2')?.innerText ?? '')`, 2000));
  await listAfter(cfg);
  await click(`document.querySelector('button[aria-label="Close agents"], button[aria-label="Hide agents"]')`);
  await waitFor(`!${Q.panel}`, 2000);

  // 4. Done: the header is plain Idle; the activity row opens to the agent rows, and one opens the same detail view.
  const plain = await ev(`${Q.header}.innerText`);
  check('header: plain idle once they are done', /Idle/.test(plain) && !/·\s*\d+ agents?|(^|\s)Agents(\s|$)/.test(plain), plain.replace(/\s+/g, ' ').slice(0, 80));
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
    // Gone, not still sliding out: openAgents takes a panel it finds for an open one.
    await waitFor(`!${Q.panel}`, 2000);
    await chat.settled(30000);
  }
  check('no page errors', errors.length === 0, errors.join(' | '));
  errors.length = 0;
}

/** The panel's list while the three agents run (T-149): rows of one height that hold still, short labels, the groups. The panel is open. */
async function listChecks(cfg) {
  const rows = await ev(panelRows);
  const heights = [...new Set(rows.map((r) => r.h))];
  check('every row is the same height (two lines)', heights.length === 1 && heights[0] >= 44 && heights[0] <= 64, JSON.stringify(heights));
  check('no label is a command line (no &&, |, 2>&1)', rows.every((r) => !/&&|\||2>&1/.test(r.label)), JSON.stringify(rows.map((r) => r.label)));
  const heads = await ev(groupHeads);
  check('groups: Agents first, with its count', /^AGENTS ?3$/i.test(heads[0]?.text ?? ''), JSON.stringify(heads));
  check('groups: Failed is open (never folded away)', heads.some((h) => /^FAILED ?\d+$/i.test(h.text) && !h.folded && h.rows >= 1), JSON.stringify(heads));
  check('groups: Done is folded, its count shown', heads.some((h) => /^DONE ?\d+$/i.test(h.text) && h.folded && h.rows === 0), JSON.stringify(heads));
  const failed = rows.find((r) => r.label === 'ls /tmp/qa-missing-dir');
  check('the failing command sits in Failed with its exit code', !!failed && /FAILED/i.test(failed.group) && /^exit 2/.test(failed.line), JSON.stringify(failed));
  check('the first screen shows every running agent', await ev(`(() => { const s = ${Q.panel}.querySelector('section').parentElement.getBoundingClientRect(); return [...${Q.panel}.querySelectorAll('section:first-of-type li')].every((li) => li.getBoundingClientRect().bottom <= s.bottom + 1); })()`));

  // Rows hold still: the boxes of every row before and after a live update (an agent's next line, the clock) are the same.
  const before = await ev(panelRows);
  const changed = await waitFor(`(() => { const now = ${panelRows}; const was = ${JSON.stringify(before.map((r) => [r.id, r.l1 + r.line]))}; return now.some((r) => { const w = was.find(([id]) => id === r.id); return w && w[1] !== r.l1 + r.line; }); })()`, 4000);
  const after = await ev(panelRows);
  const moved = after.filter((r) => { const b = before.find((x) => x.id === r.id); return b && (b.top !== r.top || b.h !== r.h); });
  check('rows hold still while a line changes (same boxes before and after)', changed && moved.length === 0, JSON.stringify({ changed, moved }));
}

/** The panel's chips, a command's detail and search, once the agents are done (T-149). The panel is open on the list. */
async function listAfter(cfg) {
  // Chips filter: Agents keeps the agents, counted in full; Done opens the done group (and only it); a second tap clears.
  await click(chip('agents'));
  await sleep(250);
  const agentHeads = await ev(groupHeads);
  const agentRows = await ev(panelRows);
  const agents = new Set(chat0.tasks.filter((t) => t.subagentType || t.model).map((t) => t.taskId)).size;
  const counted = agentHeads.reduce((n, h) => n + Number(/(\d+)$/.exec(h.text)?.[1] ?? 0), 0);
  check('the Agents chip keeps sub-agents only, every one counted', counted === agents && agentRows.every((r) => /QA agent/.test(r.label)) && (await ev(`${chip('agents')}.getAttribute('aria-label')`)) === `Agents ${agents}`, JSON.stringify({ agents, agentHeads }));
  await click(chip('agents'));
  await click(chip('done'));
  await sleep(250);
  const doneOnly = await ev(groupHeads);
  check('the Done chip shows the done group open, and nothing else', doneOnly.length === 1 && /^DONE/i.test(doneOnly[0].text) && doneOnly[0].rows >= 2, JSON.stringify(doneOnly));
  const labels = (await ev(panelRows)).map((r) => r.label);
  check('a described command is labelled by its description; one named by its command line by a short label', labels.includes('QA described') && labels.includes('node test: qa-none.test.mjs'), JSON.stringify(labels));
  await noOverflow('done filter');
  await shot(`${cfg.name}-2b-done-filter`);

  // A command's detail: the whole command in the code block, exit code, copy; back returns to the same filter.
  await click(byText(`#agents-panel li > button`, /node test: qa-none/));
  check('a command opens its detail', await waitFor(`/^Command$/m.test(${Q.panel}.querySelector('h2')?.innerText ?? '')`, 3000));
  const code = await ev(`${Q.panel}.querySelector('section[aria-label=Input] pre')?.innerText ?? ''`);
  check('detail: the whole command, in the code block', /timeout 30 node --import tsx --test \/tmp\/qa-none\.test\.mjs 2>&1 \| tail -3/.test(code), code);
  check('detail: exit code and a copy button', /Exit code\s+0/.test(await ev(`${Q.panel}.innerText`)) && (await ev(`!!${Q.panel}.querySelector('section[aria-label=Input] button[aria-label=Copy]')`)), (await ev(`${Q.panel}.innerText`)).replace(/\s+/g, ' ').slice(0, 300));
  if (cfg.mobile) check('command detail targets are 44 px on touch', (await ev(small(Q.panel))).length === 0, JSON.stringify(await ev(small(Q.panel))));
  await noOverflow('command detail');
  await shot(`${cfg.name}-2c-command-detail`);
  await click(`${Q.panel}.querySelector('button[aria-label="Back to agents"]')`);
  check('back keeps the filter', await waitFor(`${chip('done')}?.getAttribute('aria-pressed') === 'true'`, 2000));
  await click(chip('done'));

  // Search: a field on a laptop; behind the search button on a phone.
  if (cfg.mobile) {
    check('phone: the search field hides behind its button', !(await ev(`!!document.querySelector('#agents-search')?.offsetParent`)));
    await click(`${Q.panel}.querySelector('button[aria-label=Search]')`);
  }
  check('the search field shows', await waitFor(`!!document.querySelector('#agents-search')?.offsetParent`, 2000));
  await ev(typeSearch('qa-none'));
  await sleep(250);
  const found = await ev(panelRows);
  check('search finds by the command, folded work included', found.length >= 1 && found.every((r) => r.label === 'node test: qa-none.test.mjs'), JSON.stringify(found.map((r) => r.label)));
  await shot(`${cfg.name}-2d-search`);
  await ev(typeSearch(''));
  if (cfg.mobile) await click(`${Q.panel}.querySelector('button[aria-label=Search]')`);
  await sleep(250);
}

/**
 * Stop on a running command's row (T-149), on a session of its own: stopped, the command moves to Failed (never folded away) as Stopped.
 * The session must live on. Found 2026-10-14: Claude Code reports the stopped command with a replayed user line whose origin is
 * `task-notification` without the `session-task` producer, and the portal ends the session for integrity (a server matter, not the panel's).
 */
async function commandStop(cfg, chat) {
  cfgName = `${cfg.name}-command-stop`;
  if (!(await open(cfg))) return check('page loads', false);
  await sleep(800);
  await chat.send('[[bg QA wait::sleep 40]]');
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !chat.tasks.some((t) => t.description === 'QA wait' && t.status === 'running')) await sleep(150);
  check('the Agents panel opens on a running command', await openAgents(cfg));
  await sleep(400); // the sheet has slid in
  const stopCmd = `${Q.panel}?.querySelector('button[aria-label="Stop QA wait"]')`;
  check('a running command has Stop on its row, in the Commands group', await waitFor(`!!${stopCmd} && /Commands/i.test(${stopCmd}.closest('section').innerText)`, 5000), JSON.stringify(await ev(groupHeads)));
  if (cfg.mobile) {
    const box = await ev(`(() => { const r = ${stopCmd}?.getBoundingClientRect(); return r ? [r.width, r.height] : [0, 0]; })()`);
    check('the row’s Stop is 44 px on touch', box[0] >= 43.5 && box[1] >= 43.5, JSON.stringify(box));
  }
  await noOverflow('command running');
  await shot(`${cfg.name}-9-command-running`);
  await click(stopCmd);
  check('Stop on the row stops the command: Stopped, in the Failed group', await waitFor(`(${panelRows}).some((r) => r.label === 'QA wait' && /Stopped/.test(r.line) && /FAILED/i.test(r.group))`, 20000), JSON.stringify(await ev(panelRows)).slice(0, 400));
  await shot(`${cfg.name}-9b-command-stopped`);
  await sleep(3000);
  const s = await api('GET', `/api/chat/sessions/${SID}`);
  check('the session lives on after a stopped command', s.state !== 'ended', `${s.state}: ${s.endedReason ?? ''}`);
  check('no page errors', errors.length === 0, errors.join(' | '));
  errors.length = 0;
}

/** The Sessions row while agents run and the main agent is idle. */
async function sessionsRow(cfg, chat) {
  cfgName = `${cfg.name}-sessions`;
  await chat.settled(60000);
  await chat.send(`[[agent sonnet,- steps 6 2 ${NOTES}]]`);
  const t = Date.now();
  while (Date.now() - t < 30000 && !(chat.tasksOnly && chat.running() >= 2)) await sleep(150);
  if (!(await open(cfg, '/admin/sessions'))) return check('sessions page loads', false);
  // It counts as working (T-41): the list opens on Idle, so pick the Working chip.
  await waitFor(`!!${byText('main button', /^Working/)}`, 5000);
  await click(byText('main button', /^Working/));
  const want = cfg.w < 640 ? /Working/ : /Working · 2 agents/;
  // The row's own line (its title and state), not the filter chips (one of them says Working too).
  const rowText = `([...document.querySelectorAll('main p')].find((p) => p.innerText.trim() === ${JSON.stringify(TITLE)})?.parentElement?.innerText ?? '')`;
  check('the Sessions row says agents still run', await waitFor(`${want}.test(${rowText})`, 8000), (await ev(rowText)).replace(/\s+/g, ' ').slice(0, 200));
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
    SID = (await api('POST', '/api/chat/sessions', { workspaceId: 'local/local', title: TITLE })).id;
    console.log(`session ${SID}`);
  }
  const chat = await openChat();
  chat0 = chat;
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
  // Stopping a command once, on a session of its own (it can end the session: see commandStop).
  const light = MATRIX.find((c) => !c.dark && (!only || c.name.includes(only)));
  if (light) {
    SID = (await api('POST', '/api/chat/sessions', { workspaceId: 'local/local', title: `${TITLE}: Stop a command` })).id;
    const chat2 = await openChat();
    try { await commandStop(light, chat2); } catch (e) { await shot(`${light.name}-x-command-stop`); check('command stop ran', false, String(e.message ?? e).slice(0, 300)); }
    chat2.ws.close();
  }
} finally {
  cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`FAIL ${f.cfg} / ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
