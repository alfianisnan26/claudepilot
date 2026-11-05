// PILOT-1185 slice 2: the server-code field in a real browser, at 390 x 844 (touch) and 1280 x 800, light and dark. Against a portal
// whose code is long (26 to 64): the sign-in field is one text field, typing the first 8 characters sends nothing, the whole code with
// Enter signs in, Access shows the code wrapped. Against an 8-character code: the boxes send themselves at the 8th, as before. Every
// width checks no horizontal scroll and a field at least 44 px high. Screenshots go to SC_OUT. The code comes from the environment and
// is never printed.
// usage: SC_URL=http://localhost:3403 SC_CODE=<the portal's code> SC_OUT=/tmp/sc-shots node tools/qa/signin-code.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const P = process.env.SC_URL ?? 'http://localhost:3403';
const CODE = (process.env.SC_CODE ?? '').replace(/[\s-]+/g, '').toUpperCase();
const OUT = process.env.SC_OUT ?? '/tmp/sc-shots';
const CDP = Number(process.env.SC_CDP ?? 9619);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!CODE) throw new Error('SC_CODE is not set');
mkdirSync(OUT, { recursive: true });

const chrome = spawn(
  'chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'sc-'))}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
let t;
for (let i = 0; i < 50 && !t; i++) {
  try {
    t = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((x) => x.type === 'page');
  } catch {}
  if (!t) await sleep(200);
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let n = 0;
const pend = new Map();
ws.on('message', (m) => {
  const d = JSON.parse(m);
  if (d.id && pend.has(d.id)) (pend.get(d.id)(d), pend.delete(d.id));
});
const cmd = (method, params = {}) =>
  new Promise((r) => {
    const id = ++n;
    pend.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expr) =>
  (await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const fails = [];
const check = (ok, msg) => (console.log(`${ok ? 'PASS' : 'FAIL'}: ${msg}`), ok || fails.push(msg));
const shot = async (name) => {
  const r = await cmd('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
  writeFileSync(join(OUT, `${name}.jpg`), Buffer.from(r.result.data, 'base64'));
};
const session = () => ev(`fetch('/api/session').then(r=>r.json()).then(j=>j.data)`);
const noHScroll = () => ev(`document.scrollingElement.scrollWidth <= window.innerWidth`);
const fieldHeight = () =>
  ev(
    `(()=>{const i=document.querySelector('input[aria-label="Server code"]');if(!i)return 0;const b=(i.offsetHeight>0&&getComputedStyle(i).opacity!=='0')?i:i.parentElement;return b.getBoundingClientRect().height})()`,
  );
const type = async (text) => {
  for (const ch of text) {
    await cmd('Input.insertText', { text: ch });
    await sleep(30);
  }
};

await cmd('Page.enable');
const long = (await (await fetch(`${P}/api/session`)).json()).data.longCode === true;
check(long === CODE.length > 8, `the session answer says ${long ? 'long' : 'short'} for a ${CODE.length}-character code`);

for (const [w, h, mobile] of [
  [390, 844, true],
  [1280, 800, false],
])
  for (const scheme of ['light', 'dark']) {
    const tag = `${long ? 'long' : 'short'}-${w}-${scheme}`;
    await cmd('Network.enable');
    await cmd('Network.clearBrowserCookies');
    await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await cmd('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
    await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await cmd('Page.navigate', { url: `${P}/` });
    await sleep(3500);
    await ev(`document.querySelector('input[aria-label="Server code"]')?.focus()`);
    await shot(`${tag}-1-login`);
    check(await noHScroll(), `${tag}: the sign-in page has no horizontal scroll`);
    check((await fieldHeight()) >= 44, `${tag}: the code field is at least 44 px high`);

    if (long) {
      await type(CODE.slice(0, 8));
      await sleep(800);
      check((await session())?.authenticated === false, `${tag}: 8 characters of a long code send nothing`);
      await type(CODE.slice(8));
      await shot(`${tag}-2-typed`);
      check(await noHScroll(), `${tag}: no horizontal scroll with the whole code in`);
      await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    } else await type(CODE);
    await sleep(2500);
    check((await session())?.authenticated === true, `${tag}: ${long ? 'Enter' : 'the 8th character'} signs in`);

    await cmd('Page.navigate', { url: `${P}/admin/access` });
    await sleep(3000);
    await ev(`document.querySelector('button[aria-label="Show code"]')?.click()`);
    await sleep(500);
    await shot(`${tag}-3-access`);
    check(await noHScroll(), `${tag}: Access has no horizontal scroll with the code shown`);
    const shown = await ev(
      `(()=>{const p=document.querySelector('[aria-label^="Server code "]');if(!p)return null;return {text:p.textContent,clipped:p.scrollWidth>p.clientWidth}})()`,
    );
    check(
      !!shown && shown.text.replace(/-/g, '') === CODE && !shown.clipped,
      `${tag}: Access shows the whole code${long ? ', in groups of 4' : ''}, not cut off`,
    );
    await ev(`fetch('/api/logout',{method:'POST'})`);
  }

console.log(fails.length ? `FAIL: ${fails.length} check(s)` : 'PASS: all checks');
chrome.kill();
process.exit(fails.length ? 1 : 0);
