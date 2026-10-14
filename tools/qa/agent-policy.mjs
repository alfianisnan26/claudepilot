// The agent policy (T-285) in a real browser: Settings, Agents, and the workspace's Configuration sheet, against a scratch portal with
// "This machine" (PORTAL_LOCAL_ENABLED=true), in headless Chromium over CDP at 390 px (touch, the iPhone's safe areas) and 1280 px, light and
// dark (QA-STANDARDS A1-A9). Asserts:
//   - Settings: the Agents section has the five rows; each label is one or two words, has its InfoTip (which names its source and the restart
//     and opens inside the screen); every control is at least 44 px tall (the 5m/1h choice: each segment 44 x 44); a tap on 5m sends the
//     change and the choice follows; nothing scrolls sideways;
//   - the Configuration sheet: the agent-policy line says Unavailable while nothing landed (the real server), and, with a fixture answer,
//     Applied with "1 overridden by policy", its InfoTip naming BASH_MAX_OUTPUT_LENGTH and the set; nothing wider than the screen;
//   - no page errors.
// usage: QA_PORT=3481 QA_CDP=9681 node tools/qa/agent-policy.mjs [--shots dir]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.env.QA_PORT ?? 3481);
const CODE = process.env.QA_CODE ?? '24681372';
const CDP = Number(process.env.QA_CDP ?? 9681);
const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
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
const cookie = await login();
const profile = mkdtempSync(join(tmpdir(), 'cp-ap-profile-'));
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


async function setup(cfg) {
  await send('Emulation.setDeviceMetricsOverride', { width: cfg.w, height: cfg.h, deviceScaleFactor: 1, mobile: !!cfg.mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: !!cfg.mobile });
  await send('Emulation.setSafeAreaInsetsOverride', { insets: cfg.insets ?? { top: 0, bottom: 0, left: 0, right: 0 } });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: cfg.dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
}
await send('Network.enable');
await send('Network.setCookie', { name: 'portal_session', value: cookie, domain: 'localhost', path: '/' });
await send('Runtime.enable');
await send('Page.enable');

// A fixture for the sheet's second look: applied, with a pool entry the policy overrides.
const FIXTURE = {
  workspaceId: 'local/local',
  state: 'applied',
  appliedAt: '2026-10-14T05:00:00.000Z',
  values: [
    ['agents.subagentCacheTtl', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', '1h', null],
    ['agents.maxSubagents', 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', '5', null],
    ['agents.spawnDepth', 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', '3', null],
    ['agents.bashOutputMax', 'BASH_MAX_OUTPUT_LENGTH', '8000', 'agent-limits'],
    ['agents.mcpOutputMax', 'MAX_MCP_OUTPUT_TOKENS', '25000', null],
  ].map(([key, env, v, pool]) => ({ key, env, desired: v, applied: v, overriddenPool: pool })),
};
let fixtureScript = null;
const useFixture = async (on) => {
  if (fixtureScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: fixtureScript });
  fixtureScript = null;
  if (!on) return;
  const src = `(() => { const real = window.fetch; window.fetch = (input, init) => { const p = new URL(typeof input === 'string' ? input : input.url, location.origin).pathname;
    if (p.startsWith('/api/settings/agent-env/')) return Promise.resolve(new Response(JSON.stringify({ success: true, data: ${JSON.stringify(FIXTURE)} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    return real(input, init); }; })();`;
  fixtureScript = (await send('Page.addScriptToEvaluateOnNewDocument', { source: src })).result.identifier;
};

const AGENT_KEYS = ['agents.subagentCacheTtl', 'agents.maxSubagents', 'agents.spawnDepth', 'agents.bashOutputMax', 'agents.mcpOutputMax'];
const ROWS = `(() => {
  const keys = ${JSON.stringify(AGENT_KEYS)};
  const rows = keys.map((k) => { const label = document.getElementById('setting-' + k); if (!label) return null; const li = label.closest('li');
    const ctl = li.querySelector('input, [role=radiogroup]'); const r = ctl ? ctl.getBoundingClientRect() : null; const lr = li.getBoundingClientRect();
    const segs = [...li.querySelectorAll('[role=radio]')].map((b) => { const q = b.getBoundingClientRect(); return { w: q.width, h: q.height, on: b.getAttribute('aria-checked') === 'true', t: b.textContent }; });
    return { key: k, label: label.textContent, words: label.textContent.trim().split(/\s+/).length, tip: !!li.querySelector('button[aria-label^="About "]'), h: r ? r.height : 0, r: r ? r.right : 0, liR: lr.right, segs }; });
  const sec = document.getElementById('settings-agents');
  return { rows, section: sec ? sec.textContent : null, sw: document.documentElement.scrollWidth, w: innerWidth };
})()`;

async function open(path, ready) {
  await send('Page.navigate', { url: `http://localhost:${PORT}${path}` });
  if (!(await waitFor(ready, 20000))) {
    await send('Page.reload');
    return waitFor(ready, 30000);
  }
  await sleep(500);
  return true;
}
const tipBox = (text) => `(() => { const t = [...document.querySelectorAll('[role=note]')].find((e) => e.innerText.includes(${JSON.stringify(text)})); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.x, r: r.right, y: r.y, b: r.bottom, w: innerWidth, h: innerHeight, text: t.innerText }; })()`;
const inside = (t) => !!t && t.x >= 0 && t.r <= t.w + 1 && t.y >= 0 && t.b <= t.h + 1;
const closeTips = () => ev(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

for (const cfg of MATRIX) {
  cfgName = cfg.name;
  await setup(cfg);
  await useFixture(false);
  // ---- Settings, Agents
  if (!(await open('/admin/settings', `!!document.getElementById('setting-agents.mcpOutputMax')`))) {
    check('the Agents settings show', false);
    continue;
  }
  const s = await ev(ROWS);
  check('the Agents section has the five rows', s.rows.every(Boolean) && /Agents/.test(s.section ?? ''), JSON.stringify(s.rows.map((r) => r && r.key)));
  const rows = s.rows.filter(Boolean);
  check('labels are one or two words', rows.every((r) => r.words <= 2), JSON.stringify(rows.map((r) => r.label)));
  check('every row has its InfoTip', rows.every((r) => r.tip));
  check('every control is at least 44 px tall', rows.every((r) => Math.round(r.h) >= 44), JSON.stringify(rows.map((r) => [r.key, r.h])));
  check('controls inside their row', rows.every((r) => r.r <= r.liR + 1));
  const ttl = rows.find((r) => r.key === 'agents.subagentCacheTtl');
  check('the cache is a 5m/1h choice, 1h on', !!ttl && ttl.segs.map((x) => x.t).join() === '5m,1h' && ttl.segs[1].on, JSON.stringify(ttl && ttl.segs));
  check('each choice is 44 x 44', !!ttl && ttl.segs.every((x) => Math.round(x.w) >= 44 && Math.round(x.h) >= 44), JSON.stringify(ttl && ttl.segs));
  check('no sideways scroll (Settings)', s.sw <= s.w + 1, `${s.sw} > ${s.w}`);
  await shot(`settings-${cfg.name}`);
  // The InfoTip names the variable, the source and the restart, inside the screen.
  await ev(`(() => { const b = document.getElementById('setting-agents.bashOutputMax').closest('li').querySelector('button[aria-label^="About "]'); b.scrollIntoView({ block: 'center' }); b.click(); })()`);
  await sleep(300);
  const tip = await ev(tipBox('BASH_MAX_OUTPUT_LENGTH'));
  check('the InfoTip names the variable, the source and the restart', !!tip && /Source:/.test(tip.text) && /next start/.test(tip.text), tip && tip.text);
  check('the InfoTip opens inside the screen', inside(tip), JSON.stringify(tip));
  await shot(`settings-${cfg.name}-tip`);
  await closeTips();
  // A tap on 5m changes it (the real server), then back to 1h.
  for (const want of ['5m', '1h']) {
    await ev(`[...document.getElementById('setting-agents.subagentCacheTtl').closest('li').querySelectorAll('[role=radio]')].find((b) => b.textContent === '${want}').click()`);
    const ok = await waitFor(`[...document.getElementById('setting-agents.subagentCacheTtl').closest('li').querySelectorAll('[role=radio]')].find((b) => b.textContent === '${want}').getAttribute('aria-checked') === 'true'`, 5000);
    check(`a tap on ${want} sets it`, ok);
  }
  const saved = await (await fetch(`http://localhost:${PORT}/api/settings`, { headers: { Cookie: `portal_session=${cookie}` } })).json();
  check('the server holds 1h again', saved.data.settings.find((x) => x.key === 'agents.subagentCacheTtl')?.value === '1h');

  // ---- The Configuration sheet: real (nothing landed), then the fixture
  for (const fixture of [false, true]) {
    await useFixture(fixture);
    const which = fixture ? 'fixture' : 'real';
    if (!(await open('/admin/workspaces', `!!document.querySelector('button[aria-label^="Actions for "]')`))) {
      check(`the workspace list shows (${which})`, false);
      continue;
    }
    await ev(`document.querySelector('button[aria-label^="Actions for "]').click()`);
    await waitFor(`[...document.querySelectorAll('[role=menuitem]')].some((b) => /Configuration/.test(b.textContent))`, 3000);
    await ev(`[...document.querySelectorAll('[role=menuitem]')].find((b) => /Configuration/.test(b.textContent)).click()`);
    const shown = await waitFor(`!!document.querySelector('[data-testid=agent-env-line]')`, 8000);
    check(`the sheet has the agent-policy line (${which})`, shown);
    if (!shown) continue;
    await sleep(300);
    const line = await ev(`(() => { const e = document.querySelector('[data-testid=agent-env-line]'); const r = e.getBoundingClientRect(); const b = e.querySelector('button[aria-label="About the agent policy"]'); const q = b ? b.getBoundingClientRect() : null;
      return { text: e.innerText, x: r.x, r: r.right, w: innerWidth, sw: document.documentElement.scrollWidth, tipW: q ? q.width : 0, tipH: q ? q.height : 0 }; })()`);
    if (!fixture) check('nothing landed: Unavailable, never a guess', /Unavailable/.test(line.text) && /Agent policy/.test(line.text), line.text);
    else check('the fixture: Applied, 1 overridden by policy', /Applied/.test(line.text) && /1 overridden by policy/.test(line.text), line.text);
    check(`the line inside the screen (${which})`, line.x >= 0 && line.r <= line.w + 1, JSON.stringify(line));
    check(`no sideways scroll (sheet, ${which})`, line.sw <= line.w + 1, `${line.sw} > ${line.w}`);
    await shot(`sheet-${cfg.name}-${which}`);
    await ev(`(() => { const b = document.querySelector('[data-testid=agent-env-line] button[aria-label="About the agent policy"]'); b.scrollIntoView({ block: 'center' }); b.click(); })()`);
    await sleep(300);
    const t = await ev(tipBox('next start'));
    check(`the line's InfoTip inside the screen (${which})`, inside(t), JSON.stringify(t));
    if (!fixture) check('the InfoTip says unavailable per value', !!t && (t.text.match(/unavailable/g) ?? []).length === 5, t && t.text);
    else check('the InfoTip names the overridden variable and the set', !!t && /BASH_MAX_OUTPUT_LENGTH: 8000 \(overridden by policy: the entry in “agent-limits” is skipped\)/.test(t.text), t && t.text);
    await shot(`sheet-${cfg.name}-${which}-tip`);
    await closeTips();
  }
}

check('no page errors', errors.length === 0, errors.join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`agent-policy: ${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} failed` : ''}`);
ws.close();
cleanup();
process.exit(failed.length ? 1 : 0);
