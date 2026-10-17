// The crew line's lead pill opens the lead (owner, 2026-10-17: it bounced back to the worker; SessionPage's alias redirect ran on the
// render where the route changed, with the worker still loaded: aliasRedirect.ts). Taps the pill of a worker session at 390 x 844 with
// touch, then clicks it with a mouse, and fails unless both land on the lead.
// usage: CL_URL=https://pilot.example CL_CODE=<server code, from a file> [CL_PROXY=socks5://127.0.0.1:1080] node tools/qa/crew-lead-nav.mjs <worker session id>
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
const P = process.env.CL_URL ?? 'http://localhost:3403', CHILD = process.argv[2], CDP = Number(process.env.CL_CDP ?? 9617);
if (!CHILD) { console.error('usage: node tools/qa/crew-lead-nav.mjs <worker session id>'); process.exit(2); }
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', ...(process.env.CL_PROXY ? [`--proxy-server=${process.env.CL_PROXY}`] : []), `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cl-'))}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t; for (let i = 0; i < 50; i++) { try { t = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((x) => x.type === 'page'); if (t) break; } catch {} await sleep(200); }
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
let n = 0; const pend = new Map();
ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const cmd = (method, params = {}) => new Promise((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cmd('Page.navigate', { url: `${P}/` }); await sleep(4000);
const code = process.env.CL_CODE ?? process.env.PORTAL_SERVER_CODE;
console.log('login', await ev(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:${JSON.stringify(code)}})}).then(r=>r.status)`));
await cmd('Page.navigate', { url: `${P}/admin/sessions/${CHILD}` }); await sleep(7000);
const box = await ev(`(()=>{const a=document.querySelector('a[data-crew-lead]'); if(!a) return null; const r=a.getBoundingClientRect(); const x=r.left+Math.min(60,r.width/2), y=r.top+r.height/2; const top=document.elementFromPoint(x,y); return {href:a.getAttribute('href'),x,y,w:r.width,h:r.height, topTag: top&&top.tagName, topInside: a.contains(top), topClass: top && String(top.className).slice(0,120)}})()`);
console.log('pill', JSON.stringify(box));
if (box) {
  for (const type of ['touchStart', 'touchEnd']) await cmd('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: box.x, y: box.y }] });
  await sleep(3000);
  const tapped = await ev('location.pathname');
  console.log('after tap', tapped);
  await cmd('Page.navigate', { url: `${P}/admin/sessions/${CHILD}` }); await sleep(6000);
  await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(3000);
  const clicked = await ev('location.pathname');
  console.log('after click', clicked);
  const want = box.href;
  const ok = tapped === want && clicked === want;
  console.log(ok ? `PASS: the lead pill opens ${want}` : `FAIL: wanted ${want}, tap went to ${tapped}, click to ${clicked}`);
  chrome.kill(); process.exit(ok ? 0 : 1);
}
console.log('FAIL: no lead pill on this session (is it a worker of a lead?)');
chrome.kill(); process.exit(1);
