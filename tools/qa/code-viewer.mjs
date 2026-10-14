// The read-only code viewer (T-148, slice 1) in the chat's file preview, against the REAL engine: the real session page in headless Chromium
// over CDP, a scratch portal whose local workspace runs the real Claude Code CLI with the stand-in Messages API (tools/qa/mock-anthropic.mjs);
// `[[write <path> <text>]]` writes a YAML file, whose card opens the preview. Asserts: no CodeMirror code is fetched before a file opens; the
// file opens in CodeMirror with line numbers, the YAML label and colours from the portal's tokens (light and dark); the lines drawn are the
// file; it is read-only (typing and a paste change nothing); wrapped by default with no horizontal page scroll, and with wrap off only the code
// scrolls sideways; the text can be selected (native selection, what a long press uses on iOS); 44 px targets on touch; Escape closes it;
// no page errors. At 390 px (touch, the iPhone's safe areas) and 1280 px, light and dark.
//
// Set-up (as tool-rows.mjs):
//   node tools/qa/mock-anthropic.mjs 4631 /tmp/cp-cv-mock.jsonl &
//   PORTAL_LOCAL_ENABLED=true scripts/scratch-portal.sh start 3431
//   printf '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4631","ANTHROPIC_API_KEY":"fake-mock-key"}}' > /tmp/scratch-portal-3431/home/.claude/settings.json
// usage: CV_PORT=3431 CV_CODE=24681372 CV_CDP=9632 CV_FILE=/tmp/scratch-portal-3431/home/image-build-job.yaml node tools/qa/code-viewer.mjs [--only name] [--shots dir]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.env.CV_PORT ?? 3431);
const CODE = process.env.CV_CODE ?? '24681372';
const CDP = Number(process.env.CV_CDP ?? 9632);
const FILE = process.env.CV_FILE ?? `/tmp/scratch-portal-${PORT}/home/image-build-job.yaml`;
const NAME = FILE.split('/').pop();
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
// The token colours of apps/web/src/index.css (--code-flag: a YAML key).
const FLAG = { light: 'rgb(29, 78, 216)', dark: 'rgb(147, 197, 253)' };

// The file: a Job manifest like the owner's screenshot, with one long line to wrap. No `]` (the stand-in reads the directive up to it).
const LONG = `echo ${'building-the-image-with-kaniko-and-pushing-it '.repeat(5).trim()}`;
const YAML = [
  'apiVersion: batch/v1',
  'kind: Job',
  'metadata:',
  '  name: image-build # one build per commit',
  '  namespace: isnan-claudepilot',
  'spec:',
  '  backoffLimit: 0',
  '  ttlSecondsAfterFinished: 3600',
  '  template:',
  '    spec:',
  '      restartPolicy: Never',
  '      containers:',
  '        - name: kaniko',
  '          image: "gcr.io/kaniko-project/executor:v1.23.2"',
  '          args:',
  '            - --dockerfile=Dockerfile',
  `            - ${LONG}`,
  '          resources:',
  '            requests:',
  '              cpu: 500m',
  '              memory: 1Gi',
  '            limits:',
  '              memory: 4Gi',
  '',
].join('\n');

const BASE = `http://localhost:${PORT}`;
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
/** The chat socket: sends a turn, allows what it asks, waits for idle. */
const openChat = async () => {
  const ws = new WebSocket(`ws://localhost:${PORT}/api/chat/live`, { headers: { Cookie: `portal_session=${cookie}`, Origin: BASE } });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const chat = { ws, state: null, acks: new Map() };
  let n = 0;
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'session') chat.state = m.session.state;
    if (m.type === 'ack') chat.acks.set(m.uuid, m);
    if (m.type === 'events') for (const e of m.items) if (e.kind === 'request' && e.request) ws.send(JSON.stringify({ type: 'respond', session: SID, requestId: e.request.requestId, decision: 'allow' }));
  });
  ws.send(JSON.stringify({ type: 'subscribe', session: SID, afterSeq: 0 }));
  chat.send = async (text) => { const uuid = `cv-${Date.now()}-${++n}`; ws.send(JSON.stringify({ type: 'send', session: SID, uuid, text })); for (let i = 0; i < 80 && !chat.acks.has(uuid); i++) await sleep(100); return chat.acks.get(uuid); };
  chat.idle = async (ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (chat.state === 'idle') return true; await sleep(150); } return false; };
  return chat;
};

const profile = mkdtempSync(join(tmpdir(), 'cp-cv-profile-'));
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

const DIALOG = `document.querySelector('[role=dialog][aria-label=${JSON.stringify(NAME)}]')`;
const VIEWER = `${DIALOG}?.querySelector('[data-testid=code-viewer]')`;
const CONTENT = `${VIEWER}?.querySelector('.cm-content')`;
const SCROLLER = `${VIEWER}?.querySelector('.cm-scroller')`;
const WRAP = `${DIALOG}?.querySelector('button[aria-label="Wrap lines"]')`;
const CARD = `[...document.querySelectorAll('button[aria-haspopup=dialog]')].find((b) => b.innerText.includes(${JSON.stringify(NAME)}))`;
const hscroll = `(() => { const scrollsX = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; }; const d = document.scrollingElement; const bad = []; for (const e of document.querySelectorAll('body *')) { const r = e.getBoundingClientRect(); if (r.width && (r.right > innerWidth + 1 || r.left < -1) && !e.closest('[aria-hidden=true],.sr-only,[inert]')) { const s = getComputedStyle(e); if (s.position !== 'fixed' && s.visibility !== 'hidden' && !scrollsX(e)) bad.push(e.tagName + '.' + String(e.className).slice(0, 40)); } } return { doc: d.scrollWidth - innerWidth, bad: bad.slice(0, 3) }; })()`;
const small = (root) => `(() => [...(${root})?.querySelectorAll('button') ?? []].filter((b) => { const r = b.getBoundingClientRect(); return r.width && (r.height < 43.5 || r.width < 43.5) && !b.closest('[aria-hidden=true]'); }).map((b) => (b.getAttribute('aria-label') ?? b.innerText).slice(0, 30) + ' ' + Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height)))()`;
const cmLoaded = `performance.getEntriesByType('resource').some((r) => /CodeMirrorView|codemirror/i.test(r.name))`;

const results = [];
let cfgName = '';
const check = (name, ok, detail = '') => { results.push({ cfg: cfgName, name, ok: !!ok, detail }); if (!ok) console.log(`  FAIL ${cfgName} / ${name} ${detail}`); };
const noOverflow = async (label) => { const h = await ev(hscroll); check(`${label}: no horizontal page scroll`, h.doc <= 1 && h.bad.length === 0, JSON.stringify(h)); };

async function run(cfg) {
  cfgName = cfg.name;
  await send('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: !!cfg.mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: !!cfg.mobile });
  await send('Emulation.setSafeAreaInsetsOverride', { insets: cfg.insets ?? { top: 0, bottom: 0, left: 0, right: 0 } });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: cfg.dark ? 'dark' : 'light' }] });
  await send('Page.navigate', { url: `${BASE}/admin/sessions/${SID}` });
  if (!(await waitFor(`!!document.querySelector('textarea[aria-label="Message"]')`, 20000))) return check('page loads', false);
  check('the file card is in the chat', await waitFor(`!!${CARD}`, 8000));
  check('no CodeMirror code fetched before a file opens', (await ev(cmLoaded)) === false);
  await ev(`${CARD}.scrollIntoView({ block: 'center' })`);
  await ev(`${CARD}.click()`);
  check('the file opens in CodeMirror', await waitFor(`!!${CONTENT}`, 8000));
  check('its chunk was fetched on open', await ev(cmLoaded));
  await waitFor(`${CONTENT}?.querySelector('span[class]') !== null`, 4000); // the grammar loads on its own
  await sleep(200);

  check('the language label says YAML', (await ev(`${DIALOG}.querySelector('[data-testid=code-language]')?.innerText`)) === 'YAML');
  const drawn = await ev(`[...${CONTENT}.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\\n')`);
  check('the lines drawn are the file, whole and in order', drawn.trimEnd() === YAML.trimEnd(), JSON.stringify(drawn.slice(0, 80)));
  const nums = await ev(`[...${VIEWER}.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].map((e) => e.textContent).filter(Boolean)`);
  check('line numbers 1 to the end', nums.includes('1') && nums.includes(String(YAML.trimEnd().split('\n').length)), JSON.stringify(nums.slice(0, 4)));
  const keyColour = await ev(`getComputedStyle([...${CONTENT}.querySelectorAll('.cm-line')][0].querySelector('span')).color`);
  check('a key is coloured with the theme’s --code-flag', keyColour === FLAG[cfg.dark ? 'dark' : 'light'], keyColour);
  check('several token colours (key, string, comment, number)', (await ev(`new Set([...${CONTENT}.querySelectorAll('span')].map((s) => getComputedStyle(s).color)).size`)) >= 3);
  check('the code font', /monospace/.test(await ev(`getComputedStyle(${SCROLLER}).fontFamily`)));

  // Read-only: typing and a paste into the focused text change nothing.
  check('not editable', (await ev(`${CONTENT}.getAttribute('contenteditable')`)) === 'false');
  await ev(`${CONTENT}.focus()`);
  await send('Input.insertText', { text: 'pwned' });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await ev(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'pasted'); ${CONTENT}.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  await sleep(150);
  check('typing and a paste change nothing', (await ev(`[...${CONTENT}.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\\n')`)) === drawn);

  // Selection: native, so a long press selects on a phone and Copy works.
  check('the text is selectable', (await ev(`getComputedStyle(${CONTENT}.querySelector('.cm-line')).userSelect`)) !== 'none');
  const selected = await ev(`(() => { const l = ${CONTENT}.querySelectorAll('.cm-line')[1]; const r = document.createRange(); r.selectNodeContents(l); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); })()`);
  check('a line can be selected', selected === 'kind: Job', JSON.stringify(selected));
  await ev(`getSelection().removeAllRanges()`);

  // Wrap: on by default, the long line wraps and nothing scrolls sideways; off, only the code scrolls sideways.
  check('wrapped by default', (await ev(`${WRAP}?.getAttribute('aria-pressed')`)) === 'true' && (await ev(`${CONTENT}.classList.contains('cm-lineWrapping')`)));
  const longLine = `[...${CONTENT}.querySelectorAll('.cm-line')].find((l) => l.textContent.includes('kaniko-and-pushing'))`;
  const lh = await ev(`parseFloat(getComputedStyle(${longLine}).lineHeight)`);
  if (cfg.mobile) check('the long line wraps onto more rows', (await ev(`${longLine}.getBoundingClientRect().height`)) > lh * 1.5);
  check('the code does not scroll sideways while wrapped', (await ev(`${SCROLLER}.scrollWidth - ${SCROLLER}.clientWidth`)) <= 1);
  await noOverflow('wrapped');
  await shot(`${cfg.name}-1-wrapped`);
  await ev(`${WRAP}.click()`);
  await sleep(200);
  check('wrap off', (await ev(`${WRAP}.getAttribute('aria-pressed')`)) === 'false' && !(await ev(`${CONTENT}.classList.contains('cm-lineWrapping')`)));
  check('with wrap off the long line is one row', (await ev(`${longLine}.getBoundingClientRect().height`)) < lh * 1.5);
  check('with wrap off only the code scrolls sideways', (await ev(`${SCROLLER}.scrollWidth - ${SCROLLER}.clientWidth`)) > 10);
  await noOverflow('not wrapped');
  await shot(`${cfg.name}-2-nowrap`);
  await ev(`${WRAP}.click()`);

  if (cfg.mobile) {
    const tiny = await ev(small(DIALOG));
    check('44 px targets in the sheet', tiny.length === 0, JSON.stringify(tiny));
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  check('Escape closes it', await waitFor(`!${DIALOG}`, 3000));
  check('no page errors', errors.length === 0, errors.join(' | '));
  errors.length = 0;
}

try {
  cookie = await login();
  await api('POST', '/api/workspaces/local/local/start').catch(() => undefined);
  SID = (await api('POST', '/api/chat/sessions', { workspaceId: 'local/local', title: 'Code viewer QA' })).id;
  console.log(`session ${SID}`);
  const chat = await openChat();
  await chat.idle(60000);
  const ack = await chat.send(`[[write ${FILE} ${YAML}]]`);
  if (!ack?.ok) console.log(`  send refused: ${JSON.stringify(ack)}`);
  await sleep(500);
  await chat.idle(60000);
  await send('Network.enable');
  await send('Network.setCookie', { name: 'portal_session', value: cookie, domain: 'localhost', path: '/' });
  await send('Page.enable');
  await send('Runtime.enable');
  for (const cfg of MATRIX) {
    if (only && !cfg.name.includes(only)) continue;
    console.log(`> ${cfg.name}`);
    try { await run(cfg); } catch (e) { await shot(`${cfg.name}-x-error`); check('scenario ran', false, String(e.message ?? e).slice(0, 300)); }
  }
  chat.ws.close();
} finally {
  cleanup();
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`FAIL ${f.cfg} / ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
