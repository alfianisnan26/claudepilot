import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The browser container's supervisor (images/browser/cpb/supervisor.mjs) with a real Chromium, run directly
 * (no init, no display): its loopback API and its rules for waking, idling, control and handoffs (PRD §11.3,
 * §12.3, §12.4, §14.2). The init, the display and the user split are checked in the container itself
 * (container.integration.test.ts).
 */

const CPB = fileURLToPath(new URL('../../../../images/browser/cpb/', import.meta.url));
const CHROMIUM = process.env.CPB_CHROME_BIN ?? '/usr/bin/chromium';
const opts = { skip: existsSync(CHROMIUM) ? false : 'Chromium is not installed here' };

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rig {
  port: number;
  cdp: number;
  run: string;
  child: ChildProcess;
  get: (path: string) => Promise<{ status: number; json: any }>;
  post: (path: string, body?: unknown) => Promise<{ status: number; json: any }>;
  ctl: (cmd: string, ...args: string[]) => any;
  status: () => Promise<any>;
  stop: () => Promise<void>;
}

async function rig(config: Record<string, unknown> = {}, env: Record<string, string> = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'cpb-sup-'));
  const [port, cdp] = [await freePort(), await freePort()];
  const run = join(dir, 'run');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ tier: 'headless', profile: 'fresh', sandbox: false, idleMinutes: 0, profileDir: join(dir, 'profile'), ...config }));
  const child = spawn(process.execPath, [join(CPB, 'supervisor.mjs')], {
    env: { ...process.env, CPB_DIRECT: '1', CPB_CONFIG: join(dir, 'config.json'), CPB_RUN: run, CPB_PORT: String(port), CPB_CDP_PORT: String(cdp), CPB_CHROME_BIN: CHROMIUM, HOME: dir, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const errors: string[] = [];
  child.stderr!.on('data', (d: Buffer) => errors.push(String(d)));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'X-CPB': '1', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${port}/status`, { headers: { 'X-CPB': '1' } }).then((r) => r.ok, () => false)) break;
    await sleep(100);
  }
  const r: Rig = {
    port,
    cdp,
    run,
    child,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    ctl: (cmd, ...args) => {
      const out = spawnSync(process.execPath, [join(CPB, 'cpb-ctl'), cmd, ...args], { env: { ...process.env, CPB_CTL_SOCK: join(run, 'ctl.sock') }, encoding: 'utf8' });
      const json = JSON.parse(out.stdout || '{"ok":false,"error":"no output"}');
      if (!json.ok) throw new Error(json.error);
      return json.result;
    },
    status: async () => (await call('GET', '/status')).json,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((resolve) => (child.exitCode !== null ? resolve(null) : child.once('exit', resolve)));
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return r;
}

describe('the supervisor', opts, () => {
  let r: Rig;
  afterEach(async () => r?.stop());

  test('its loopback API refuses anything a web page could send (PRD §13 Loopback services)', async () => {
    r = await rig();
    const base = `http://127.0.0.1:${r.port}`;
    assert.equal((await fetch(`${base}/status`)).status, 403, 'no X-CPB');
    assert.equal((await fetch(`${base}/status`, { headers: { 'X-CPB': '1', Origin: 'https://evil.example' } })).status, 403, 'any Origin');
    // A rebinding attack arrives with its own hostname in Host.
    const raw = await new Promise<string>((resolve) => {
      import('node:net').then(({ connect }) => {
        const s = connect(r.port, '127.0.0.1', () => s.write('GET /status HTTP/1.1\r\nHost: attacker.example:' + r.port + '\r\nX-CPB: 1\r\nConnection: close\r\n\r\n'));
        let out = '';
        s.on('data', (d) => (out += d));
        s.on('close', () => resolve(out));
      });
    });
    assert.match(raw, /^HTTP\/1.1 403/);
    const form = await fetch(`${base}/wake`, { method: 'POST', headers: { 'X-CPB': '1', 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(form.status, 415, 'a form post');
    assert.equal((await r.get('/nope')).status, 404);
    assert.equal((await r.get('/status')).status, 200);
  });

  test('Chrome starts on the first wake, not before, and a second wake changes nothing', async () => {
    r = await rig();
    let s = await r.status();
    assert.equal(s.chrome.state, 'asleep');
    assert.equal(s.protocol, 1);
    const woke = await r.post('/wake');
    assert.equal(woke.status, 200);
    assert.equal(woke.json.chrome.state, 'up');
    const boot = woke.json.chrome.bootId;
    assert.ok(boot);
    const version = (await (await fetch(`http://127.0.0.1:${r.cdp}/json/version`)).json()) as { Browser: string };
    assert.match(version.Browser, /Chrome\//);
    s = (await r.post('/wake')).json;
    assert.equal(s.chrome.bootId, boot);
    assert.equal(s.chrome.starts, 1);
    assert.deepEqual((await r.get('/tabs')).json.tabs.map((t: { url: string }) => t.url), ['about:blank']);
  });

  test('activity and sessions are recorded for idle stop and the gate', async () => {
    r = await rig();
    await r.post('/wake');
    await r.post('/activity', { tool: 'browser_click', session: 'g1' });
    await r.post('/activity', { tool: 'browser_navigate', session: 'g2' });
    const s = await r.status();
    assert.equal(s.activity.tool, 'browser_navigate');
    assert.equal(s.activity.session, 'g2');
    assert.equal(s.sessions, 2);
  });

  test('Chrome closes after the idle time, never while a viewer or a person has it, and wakes again', async () => {
    r = await rig({ idleMinutes: 1 }, { CPB_IDLE_MS: '1200', CPB_TICK_MS: '200' });
    await r.post('/wake');
    r.ctl('viewers', '--n', '1');
    await sleep(2000);
    assert.equal((await r.status()).chrome.state, 'up', 'a viewer keeps it open');
    r.ctl('viewers', '--n', '0');
    // Idle time counts from the last viewer activity.
    await sleep(2600);
    let s = await r.status();
    assert.equal(s.chrome.state, 'asleep', 'closed when idle');
    assert.equal(s.chrome.pid, null);
    s = (await r.post('/wake')).json;
    assert.equal(s.chrome.state, 'up');
    assert.equal(s.chrome.starts, 2);
  });

  test('the control lease: held, shown to the gate, renewed by the same holder, released, and expired when nobody renews', async () => {
    r = await rig({}, { CPB_MIN_TTL: '1' });
    await r.post('/wake');
    const on = r.ctl('control', '--on', '--holder', 'dev1', '--label', 'Alfian’s iPhone', '--ttl', '60', '--private');
    assert.equal(on.held, true);
    assert.equal(on.private, true);
    const since = on.since;
    await sleep(30);
    const renewed = r.ctl('control', '--on', '--holder', 'dev1', '--label', 'Alfian’s iPhone', '--ttl', '60');
    assert.equal(renewed.since, since, 'renewing keeps the start time');
    assert.equal((await r.status()).control.label, 'Alfian’s iPhone');
    assert.deepEqual(r.ctl('control', '--off'), { held: false });
    assert.equal((await r.status()).control.held, false);
    r.ctl('control', '--on', '--holder', 'dev2', '--ttl', '1');
    await sleep(2300);
    assert.equal((await r.status()).control.held, false, 'a portal that stops renewing ends control');
  });

  test('take-over off refuses control', async () => {
    r = await rig({ takeOver: false });
    assert.throws(() => r.ctl('control', '--on', '--holder', 'dev1'), /Take-over is off/);
  });

  test('a handoff: waits with the tab’s origin, is answered by a person, and the long poll sees it', async () => {
    r = await rig({ tier: 'browser' }, { CPB_NO_DISPLAY: '1' });
    await r.post('/wake');
    const made = await r.post('/handoff', { reason: 'Sign in to github.com', session: 'g1' });
    assert.equal(made.json.state, 'waiting');
    assert.equal(made.json.reason, 'Sign in to github.com');
    const id = made.json.id as string;
    // The same session asking again gets the same handoff.
    assert.equal((await r.post('/handoff', { reason: 'again', session: 'g1' })).json.id, id);
    const poll = r.get(`/handoff/${id}?state=waiting`);
    await sleep(300);
    r.ctl('handoff-answer', '--id', id, '--state', 'handed_back', '--note', 'signed in');
    const done = await poll;
    assert.equal(done.json.state, 'handed_back');
    assert.equal(done.json.note, 'signed in');
  });

  test('a handoff nobody answers expires, and the clock stops while someone has control', async () => {
    r = await rig({ tier: 'browser' }, { CPB_NO_DISPLAY: '1', CPB_HANDOFF_MS: '3000', CPB_MIN_TTL: '1' });
    await r.post('/wake');
    const id = (await r.post('/handoff', { reason: 'x', session: 'g1' })).json.id as string;
    r.ctl('control', '--on', '--holder', 'dev1', '--ttl', '600');
    await sleep(3600);
    assert.equal((await r.status()).handoffs[0].state, 'waiting', 'not counted while a person has control');
    r.ctl('control', '--off');
    await sleep(3600);
    assert.equal((await r.status()).handoffs.find((h: { id: string }) => h.id === id).state, 'expired');
  });

  test('a person who leaves mid-handoff (the lease runs out) is not "handed back"', async () => {
    r = await rig({ tier: 'browser' }, { CPB_NO_DISPLAY: '1', CPB_MIN_TTL: '1' });
    await r.post('/wake');
    const id = (await r.post('/handoff', { reason: 'x', session: 'g1' })).json.id as string;
    r.ctl('control', '--on', '--holder', 'dev1', '--ttl', '1');
    r.ctl('handoff-answer', '--id', id, '--state', 'in_control');
    await sleep(2500);
    const s = await r.status();
    assert.equal(s.control.held, false);
    assert.equal(s.handoffs.find((h: { id: string }) => h.id === id).state, 'left');
  });

  test('the headless tier has no live view, so no handoff', async () => {
    r = await rig({ tier: 'headless' });
    const made = await r.post('/handoff', { reason: 'x', session: 'g1' });
    assert.equal(made.json.state, 'unavailable');
    assert.match(made.json.note, /No live view for sign-in/);
  });

  test('a crash is recorded and the next wake starts again; three in ten minutes is an error until restarted', async () => {
    r = await rig();
    for (let n = 1; n <= 3; n++) {
      const up = (await r.post('/wake')).json;
      assert.equal(up.chrome.state, 'up', `wake ${n}`);
      process.kill(up.chrome.pid, 'SIGKILL');
      for (let i = 0; i < 50 && (await r.status()).chrome.state === 'up'; i++) await sleep(100);
      const s = await r.status();
      assert.equal(s.chrome.state, n < 3 ? 'crashed' : 'error', `after crash ${n}`);
    }
    const refused = await r.post('/wake');
    assert.equal(refused.status, 503);
    assert.match(refused.json.error, /crashed 3 times/);
    const restarted = r.ctl('chrome', '--action', 'restart');
    assert.equal(restarted.chrome.state, 'up');
  });

  test('closing the last window ends Chrome by itself, and that reads as "closed", not a crash', async () => {
    r = await rig();
    const up = (await r.post('/wake')).json;
    const { webSocketDebuggerUrl } = (await (await fetch(`http://127.0.0.1:${r.cdp}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener('open', resolve));
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    for (let i = 0; i < 50 && (await r.status()).chrome.state === 'up'; i++) await sleep(100);
    const s = await r.status();
    assert.equal(s.chrome.state, 'closed');
    assert.equal(s.chrome.crashes, 0);
    assert.equal((await r.post('/wake')).json.chrome.state, 'up');
    void up;
  });

  test('stop closes Chrome cleanly and restart brings a new one', async () => {
    r = await rig();
    const first = (await r.post('/wake')).json.chrome;
    assert.equal(r.ctl('chrome', '--action', 'stop').chrome.state, 'asleep');
    const second = r.ctl('chrome', '--action', 'restart').chrome;
    assert.equal(second.state, 'up');
    assert.notEqual(second.bootId, first.bootId);
  });
});
