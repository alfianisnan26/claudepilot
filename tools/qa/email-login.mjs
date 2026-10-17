// T-118 live check: an email account signs in through the real sign-in page at 390 x 844 with touch. Makes a throwaway account through the
// API (signed in with the server code), signs in with it in a fresh browser, checks the app opens signed in, then removes the account.
// The password is generated here and never printed.
// usage: EL_URL=https://pilot.example [EL_PROXY=socks5://127.0.0.1:1080] EL_CODE=<server code, from a file> node tools/qa/email-login.mjs
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const P = process.env.EL_URL ?? 'http://localhost:3403';
const CODE = process.env.EL_CODE ?? process.env.PORTAL_SERVER_CODE;
const CDP = Number(process.env.EL_CDP ?? 9618);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const email = `qa-email-login-${randomBytes(3).toString('hex')}@example.com`;
const password = `qa-${randomBytes(18).toString('base64url')}`;

const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', ...(process.env.EL_PROXY ? [`--proxy-server=${process.env.EL_PROXY}`] : []), `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'el-'))}`, 'about:blank'], { stdio: 'ignore' });
let t;
for (let i = 0; i < 50; i++) {
  try { t = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((x) => x.type === 'page'); if (t) break; } catch {}
  await sleep(200);
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let n = 0;
const pend = new Map();
ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const cmd = (method, params = {}) => new Promise((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const done = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${msg}`); chrome.kill(); process.exit(ok ? 0 : 1); };

await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cmd('Page.navigate', { url: `${P}/` });
await sleep(4000);
// 1. As the owner (server code), make the throwaway account; then sign this browser out again.
const mk = await ev(`(async()=>{await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:${JSON.stringify(CODE)}})});
  const r=await fetch('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:${JSON.stringify(email)},displayName:'QA email login',password:${JSON.stringify(password)},role:'admin'})});
  const j=await r.json(); await fetch('/api/logout',{method:'POST'}); return r.status+' '+(j.data?j.data.id:JSON.stringify(j.error))})()`);
if (!/^201 u_/.test(mk ?? '')) done(false, `could not create the test account: ${mk}`);
const userId = mk.split(' ')[1];
await cmd('Page.navigate', { url: `${P}/` });
await sleep(5000);
// 2. The sign-in page offers email first; type and submit like a person.
const form = await ev(`!!document.querySelector('input[type=email]') && !!document.querySelector('input[type=password]')`);
if (!form) done(false, 'the sign-in page shows no email and password fields');
const type = async (sel, text) => {
  await ev(`document.querySelector(${JSON.stringify(sel)}).focus()`);
  await cmd('Input.insertText', { text });
};
await type('input[type=email]', email);
await type('input[type=password]', password);
await ev(`document.querySelector('form button[type=submit]').click()`);
await sleep(5000);
const after = await ev(`(async()=>{const s=await (await fetch('/api/session')).json(); return JSON.stringify({in:s.data.authenticated, path:location.pathname, pw:!!document.querySelector('input[type=password]')})})()`);
const st = JSON.parse(after ?? '{}');
// 3. Clean up with the session the email gave (it is a working session), then report.
const rm = await ev(`fetch('/api/admin/users/${userId}',{method:'DELETE'}).then(r=>r.status)`);
if (!st.in) done(false, `not signed in after the email sign-in (${after})`);
done(rm === 200, `signed in with an email account at 390 px (path ${st.path}); test account removed (${rm})`);
