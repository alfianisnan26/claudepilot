import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { BrowserPoolContent, PreviewServerEvent } from '@portal/contracts';
import { WebSocket, WebSocketServer } from 'ws';
import { encodeFrame, HelperDemux, MAX_FRAME_BYTES, PreviewSession, sanitizeEvent, validateClientMessage } from './preview.js';
import { VIEWERS_PER_BROWSER } from './service.js';
import { browserHarness, type FakeHelper } from './testkit.js';

const WS = 'docker/dev';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TAB = 'A1B2C3D4E5F60718A1B2C3D4E5F60718';

/* ---------- What the container says, framed as cpb-view frames it ---------- */

const framed = (kind: 1 | 2, payload: Buffer) => {
  const head = Buffer.alloc(5);
  head[0] = kind;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
};
const ev = (e: Record<string, unknown>) => framed(1, Buffer.from(JSON.stringify(e)));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const fr = (header: Record<string, unknown>, jpeg = JPEG) => {
  const h = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length);
  return framed(2, Buffer.concat([len, h, jpeg]));
};

/* ---------- Validation ---------- */

test('validateClientMessage: the narrow vocabulary, clamped; everything else is refused', () => {
  assert.deepEqual(validateClientMessage({ t: 'ping' }), { t: 'ping' });
  assert.deepEqual(validateClientMessage({ t: 'reload', extra: 1 }), { t: 'reload' });
  assert.deepEqual(validateClientMessage({ t: 'mouse', a: 'down', x: 0.5, y: 0.25, b: 2, cc: 2 }), { t: 'mouse', a: 'down', x: 0.5, y: 0.25, b: 2, cc: 2, dx: 0, dy: 0, m: 0 });
  // Out-of-range numbers are brought into range, not passed on.
  assert.deepEqual(validateClientMessage({ t: 'mouse', a: 'wheel', x: 4, y: -2, dy: 99999 }), { t: 'mouse', a: 'wheel', x: 1, y: 0, b: 0, cc: 1, dx: 0, dy: 4000, m: 0 });
  assert.deepEqual(validateClientMessage({ t: 'viewport', w: 99999, h: 3, dpr: 40, mobile: true }), { t: 'viewport', w: 4096, h: 100, dpr: 4, mobile: true });
  assert.deepEqual(validateClientMessage({ t: 'viewport', reset: true }), { t: 'viewport', reset: true });
  assert.deepEqual(validateClientMessage({ t: 'quality', q: 500, fps: 0 }), { t: 'quality', q: 95, fps: 1 });
  assert.deepEqual(validateClientMessage({ t: 'key', a: 'down', key: 'a', text: 'a', vk: 65 }), { t: 'key', a: 'down', key: 'a', code: '', vk: 65, m: 0, text: 'a' });
  assert.deepEqual(validateClientMessage({ t: 'key', a: 'down', key: 'Enter', code: 'Enter', vk: 13, text: '\r' }), { t: 'key', a: 'down', key: 'Enter', code: 'Enter', vk: 13, m: 0, text: '\r' });
  assert.deepEqual(validateClientMessage({ t: 'text', text: 'héllo\nworld' }), { t: 'text', text: 'héllo\nworld' });
  assert.deepEqual(validateClientMessage({ t: 'tab', id: TAB }), { t: 'tab', id: TAB });
  assert.deepEqual(validateClientMessage({ t: 'newTab' }), { t: 'newTab' });
  assert.deepEqual(validateClientMessage({ t: 'dialog', accept: true, text: 'Ann' }), { t: 'dialog', accept: true, text: 'Ann' });

  for (const bad of [
    null,
    'ping',
    [],
    {},
    { t: 'cdp', method: 'Network.getAllCookies' },
    { t: 'evaluate', expression: 'document.cookie' },
    { t: 'follow', on: false },
    { t: 'mouse', a: 'teleport', x: 0, y: 0 },
    { t: 'mouse', a: 'move', x: 'a', y: 0 },
    { t: 'mouse', a: 'move', x: Number.NaN, y: 0 },
    { t: 'key', a: 'down', key: 'k'.repeat(33) },
    { t: 'key', a: 'sideways', key: 'a' },
    { t: 'key', a: 'down', key: 'a\u0000' },
    { t: 'text', text: '' },
    { t: 'text', text: 'x'.repeat(2001) },
    { t: 'go', url: 'https://x.test/\nHost: evil' },
    { t: 'go', url: 'x'.repeat(2049) },
    { t: 'tab', id: 'not a tab id' },
    { t: 'closeTab' },
    { t: 'viewport', w: 'wide', h: 3 },
    { t: 'dialog', accept: 'yes' },
  ])
    assert.equal(validateClientMessage(bad), null, JSON.stringify(bad));
});

/* ---------- The container's output ---------- */

test('HelperDemux: events and frames across chunk boundaries; nothing that is not a JPEG is a frame', () => {
  const d = new HelperDemux();
  const events: unknown[] = [];
  const frames: { tab: string; dw: number; bytes: number }[] = [];
  const problems: string[] = [];
  d.onEvent = (e) => events.push(e);
  d.onFrame = (h, jpeg) => frames.push({ tab: h.tab, dw: h.dw, bytes: jpeg.length });
  d.onProblem = (m) => problems.push(m);
  const bytes = Buffer.concat([ev({ e: 'ready' }), fr({ dw: 390, dh: 700, tab: TAB, emu: true }), ev({ e: 'loading', on: true })]);
  for (let i = 0; i < bytes.length; i += 7) d.push(bytes.subarray(i, i + 7)); // a few bytes at a time
  assert.deepEqual(events, [{ e: 'ready' }, { e: 'loading', on: true }]);
  assert.deepEqual(frames, [{ tab: TAB, dw: 390, bytes: JPEG.length }]);
  assert.deepEqual(problems, []);

  d.push(fr({ dw: 10, dh: 10, tab: TAB }, Buffer.from('<html>not a jpeg</html>')));
  assert.equal(problems.length, 1, 'a frame that is not a JPEG is refused');
  assert.equal(frames.length, 1);

  const huge = Buffer.alloc(5);
  huge[0] = 2;
  huge.writeUInt32BE(MAX_FRAME_BYTES + 1, 1);
  d.push(huge);
  assert.equal(problems.length, 2, 'a frame past the cap is refused');
  d.push(Buffer.from([9, 0, 0, 0, 1, 0]));
  assert.equal(problems.length, 3, 'an unknown kind is refused');
  d.push(ev({ e: 'pong' }));
  assert.deepEqual(events.at(-1), { e: 'pong' }, 'and it carries on after');
});

test('sanitizeEvent: known shapes only, text bounded, ids checked', () => {
  assert.equal(sanitizeEvent({ e: 'ready' }), null, '`ready` is the session’s own');
  assert.equal(sanitizeEvent({ e: 'cdp', method: 'x' }), null);
  assert.deepEqual(sanitizeEvent({ e: 'loading', on: 1 }), { e: 'loading', on: false });
  const tabs = sanitizeEvent({
    e: 'tabs',
    current: TAB,
    tabs: [{ id: TAB, title: 'T'.repeat(500), url: `http://x.test/${'u'.repeat(5000)}` }, { id: 'bad id!', title: 'x', url: 'y' }, null, 'x'],
  }) as Extract<PreviewServerEvent, { e: 'tabs' }>;
  assert.equal(tabs.tabs.length, 1);
  assert.equal(tabs.tabs[0]!.title.length, 200);
  assert.equal(tabs.tabs[0]!.url.length, 2000);
  assert.equal(tabs.current, TAB);
  assert.equal(sanitizeEvent({ e: 'url', id: 'bad id!', url: 'x', title: 'y' }), null);
  assert.deepEqual(sanitizeEvent({ e: 'dialog', kind: 'launch-missiles', message: 'm'.repeat(900), prompt: 'p' }), { e: 'dialog', kind: 'alert', message: 'm'.repeat(500), prompt: 'p' });
  assert.deepEqual(sanitizeEvent({ e: 'error', message: 'e'.repeat(300), fatal: true }), { e: 'error', message: 'e'.repeat(200), fatal: true });
});

test('encodeFrame: a 16-bit header length, the header, then the JPEG as it was', () => {
  const out = encodeFrame({ dw: 390, dh: 700, tab: TAB, emu: false }, JPEG);
  const n = out.readUInt16BE(0);
  assert.deepEqual(JSON.parse(out.subarray(2, 2 + n).toString('utf8')), { dw: 390, dh: 700, tab: TAB, emu: false });
  assert.deepEqual(out.subarray(2 + n), JPEG);
});

/* ---------- The session, on a real WebSocket pair with a fake browser container ---------- */

class Client {
  readonly events: PreviewServerEvent[] = [];
  readonly frames: Buffer[] = [];
  closed: { code: number; reason: string } | null = null;
  readonly ws: WebSocket;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data, isBinary) => (isBinary ? this.frames.push(Buffer.from(data as Buffer)) : this.events.push(JSON.parse(String(data)) as PreviewServerEvent)));
    this.ws.on('close', (code, reason) => (this.closed = { code, reason: String(reason) }));
    this.ws.on('error', () => undefined);
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  async until<T>(what: string, find: () => T | undefined | null | false, ms = 3000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = find();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}; events ${JSON.stringify(this.events.slice(-4))}; closed ${JSON.stringify(this.closed)}`);
      await sleep(10);
    }
  }
  header(i: number) {
    const f = this.frames[i]!;
    return JSON.parse(f.subarray(2, 2 + f.readUInt16BE(0)).toString('utf8')) as { dw: number; dh: number; tab: string; emu: boolean };
  }
}

async function rig(content: Partial<BrowserPoolContent> = {}) {
  const h = await browserHarness();
  h.target.addWorkspace('dev');
  const p = h.create('Dev browser', content);
  h.pools.setAssignments(WS, 'browser', [{ poolId: p.id }]);
  await h.service.converge(WS, 'test');
  const wss = new WebSocketServer({ noServer: true });
  const http: Server = createServer();
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    wss.handleUpgrade(req, socket, head, (ws) => {
      void new PreviewSession({ ws, service: h.service, workspaceId: WS, device: url.searchParams.get('device') ?? '', secure: url.searchParams.get('secure') !== '0' }).run().catch(() => ws.close(1011));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  const clients: Client[] = [];
  const connect = (device: string, secure = true) => {
    const c = new Client(`ws://127.0.0.1:${port}/?device=${device}&secure=${secure ? 1 : 0}`);
    clients.push(c);
    return c;
  };
  const helper = async (i = 0): Promise<FakeHelper> => {
    for (let n = 0; n < 300; n++) {
      const found = h.target.state.helpers[i];
      if (found) return found;
      await sleep(10);
    }
    throw new Error('the browser container never ran the helper');
  };
  /** A device holds control (as `PUT …/browser/control` would have recorded). */
  const control = (device: string, priv = false) => h.service.leases.set(WS, { device, label: 'Phone', private: priv, handoffId: null });
  const done = async () => {
    for (const c of clients) c.ws.terminate();
    wss.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    h.done();
  };
  return { h, connect, helper, control, done };
}

const VIEWER = 'viewer-device-1';
const OWNER = 'holder-device-1';

test('a viewer watches: frames and events reach it, what it types does not, and a lighter stream can be asked for', async () => {
  const r = await rig();
  try {
    const c = r.connect(VIEWER);
    const helper = await r.helper();
    assert.deepEqual(helper.cmd, ['cpb-view']);
    helper.say(ev({ e: 'ready' }));
    const ready = await c.until('ready', () => c.events.find((e) => e.e === 'ready'));
    assert.equal((ready as { role: string }).role, 'viewer');

    helper.say(Buffer.concat([ev({ e: 'tabs', tabs: [{ id: TAB, title: 'Home', url: 'http://localhost:5173/' }], current: TAB }), fr({ dw: 1280, dh: 800, tab: TAB, emu: false })]));
    await c.until('a frame', () => c.frames[0]);
    assert.deepEqual(c.header(0), { dw: 1280, dh: 800, tab: TAB, emu: false });
    assert.deepEqual(c.frames[0]!.subarray(2 + c.frames[0]!.readUInt16BE(0)), JPEG);
    await c.until('the tabs', () => c.events.find((e) => e.e === 'tabs'));

    for (const m of [
      { t: 'mouse', a: 'down', x: 0.5, y: 0.5 },
      { t: 'key', a: 'down', key: 'a', text: 'a' },
      { t: 'text', text: 'my password' },
      { t: 'go', url: 'https://example.test/' },
      { t: 'viewport', w: 390, h: 700 },
      { t: 'dialog', accept: true },
      { t: 'tab', id: TAB },
      { t: 'cdp', method: 'Page.navigate' },
    ])
      c.send(m);
    c.send({ t: 'quality', q: 40, fps: 8 });
    c.send({ t: 'ping' });
    await c.until('pong', () => c.events.find((e) => e.e === 'pong'));
    await sleep(60);
    assert.deepEqual(helper.sent(), [{ t: 'quality', q: 40, fps: 8 }], 'only the lighter stream reached the container');
  } finally {
    await r.done();
  }
});

test('the holder of control drives: validated messages reach the container, a tab choice brings the tab forward, nothing else', async () => {
  const r = await rig();
  try {
    r.control(OWNER);
    const c = r.connect(OWNER);
    const helper = await r.helper();
    helper.say(ev({ e: 'ready' }));
    assert.equal(((await c.until('ready', () => c.events.find((e) => e.e === 'ready'))) as { role: string }).role, 'controller');

    c.send({ t: 'mouse', a: 'down', x: 0.5, y: 2, b: 0 });
    c.send({ t: 'key', a: 'down', key: 'Enter', code: 'Enter', vk: 13 });
    c.send({ t: 'text', text: 'hello' });
    c.send({ t: 'go', url: 'example.test' });
    c.send({ t: 'tab', id: TAB });
    c.send({ t: 'viewport', w: 390, h: 700, dpr: 3, mobile: true });
    c.send({ t: 'evaluate', expression: 'document.cookie' });
    c.send({ t: 'cdp', method: 'Network.getAllCookies' });
    c.send({ t: 'mouse', a: 'sideways', x: 0, y: 0 });
    c.ws.send('not json');
    c.ws.send(Buffer.from([1, 2, 3])); // binary: not a message
    c.send({ t: 'ping' });
    await c.until('pong', () => c.events.find((e) => e.e === 'pong'));
    await sleep(60);
    assert.deepEqual(helper.sent(), [
      { t: 'mouse', a: 'down', x: 0.5, y: 1, b: 0, cc: 1, dx: 0, dy: 0, m: 0 },
      { t: 'key', a: 'down', key: 'Enter', code: 'Enter', vk: 13, m: 0 },
      { t: 'text', text: 'hello' },
      { t: 'go', url: 'example.test' },
      { t: 'tab', id: TAB, activate: true },
      { t: 'viewport', w: 390, h: 700, dpr: 3, mobile: true },
    ]);
  } finally {
    await r.done();
  }
});

test('over plain HTTP even the holder only watches (a password would cross the network in the clear)', async () => {
  const r = await rig();
  try {
    r.control(OWNER);
    const c = r.connect(OWNER, false);
    const helper = await r.helper();
    helper.say(ev({ e: 'ready' }));
    assert.equal(((await c.until('ready', () => c.events.find((e) => e.e === 'ready'))) as { role: string }).role, 'viewer');
    c.send({ t: 'text', text: 'secret' });
    c.send({ t: 'ping' });
    await c.until('pong', () => c.events.find((e) => e.e === 'pong'));
    await sleep(40);
    assert.deepEqual(helper.sent(), []);
  } finally {
    await r.done();
  }
});

test('a slow viewer gets the newest frame, not a backlog; frames are only ever forwarded, never kept', async () => {
  const r = await rig();
  try {
    const c = r.connect(VIEWER);
    const helper = await r.helper();
    helper.say(ev({ e: 'ready' }));
    await c.until('ready', () => c.events.find((e) => e.e === 'ready'));
    // Sixty frames in one burst: the first goes out, the rest replace each other while it is being sent.
    helper.say(Buffer.concat(Array.from({ length: 60 }, (_, i) => fr({ dw: 100 + i, dh: 50, tab: TAB, emu: false }))));
    await c.until('the newest frame', () => c.frames.length >= 2 && c.header(c.frames.length - 1).dw === 159);
    assert.ok(c.frames.length <= 4, `${c.frames.length} frames arrived of 60`);
    assert.equal(c.header(0).dw, 100);
  } finally {
    await r.done();
  }
});

test('control changing hands closes the socket with 4001 so the page reconnects with its new role', async () => {
  const r = await rig();
  try {
    r.control(OWNER);
    const holder = r.connect(OWNER);
    const watcher = r.connect(VIEWER);
    (await r.helper(0)).say(ev({ e: 'ready' }));
    (await r.helper(1)).say(ev({ e: 'ready' }));
    await holder.until('ready', () => holder.events.find((e) => e.e === 'ready'));
    await watcher.until('ready', () => watcher.events.find((e) => e.e === 'ready'));
    // Someone else takes control: the old holder's socket and the new holder's both reconnect; a bystander's doesn't.
    const third = r.connect('third-device-1');
    (await r.helper(2)).say(ev({ e: 'ready' }));
    await third.until('ready', () => third.events.find((e) => e.e === 'ready'));
    r.control(VIEWER);
    await holder.until('the old holder closed', () => holder.closed);
    await watcher.until('the new holder closed', () => watcher.closed);
    assert.equal(holder.closed!.code, 4001);
    assert.equal(watcher.closed!.code, 4001);
    assert.equal(third.closed, null, 'a viewer stays a viewer');
    assert.equal((await r.helper(0)).state.closed, true, 'the helper of a closed socket is closed with it');
  } finally {
    await r.done();
  }
});

test('Private: a bystander is sent nothing, the container’s helper is never started for it, and one already watching is cut', async () => {
  const r = await rig();
  try {
    const early = r.connect('early-device-1');
    (await r.helper(0)).say(ev({ e: 'ready' }));
    await early.until('ready', () => early.events.find((e) => e.e === 'ready'));
    r.control(OWNER, true);
    await early.until('cut', () => early.closed);
    assert.equal(early.closed!.code, 4002);

    const late = r.connect('late-device-1');
    await late.until('refused', () => late.closed);
    assert.equal(late.closed!.code, 4002);
    assert.equal(r.h.target.state.helpers.length, 1, 'no helper for the one that came after');

    // The holder itself still sees the page, and after hand-back a bystander can watch again.
    const holder = r.connect(OWNER);
    (await r.helper(1)).say(ev({ e: 'ready' }));
    assert.equal(((await holder.until('ready', () => holder.events.find((e) => e.e === 'ready'))) as { role: string }).role, 'controller');
    r.h.service.leases.clear(WS);
    await holder.until('role change', () => holder.closed);
    assert.equal(holder.closed!.code, 4001);
    const again = r.connect('late-device-1');
    (await r.helper(2)).say(ev({ e: 'ready' }));
    await again.until('ready', () => again.events.find((e) => e.e === 'ready'));
  } finally {
    await r.done();
  }
});

test('the helper failing, or the preview being off, ends the socket with a code the page can act on', async () => {
  const r = await rig();
  try {
    const a = r.connect(VIEWER);
    (await r.helper(0)).say(ev({ e: 'error', message: 'The browser closed.', fatal: true }));
    await a.until('closed', () => a.closed);
    assert.equal(a.closed!.code, 4004);
    assert.equal(a.closed!.reason, 'The browser closed.');

    const b = r.connect('viewer-device-2');
    (await r.helper(1)).exit(1);
    await b.until('closed', () => b.closed);
    assert.equal(b.closed!.code, 4004);
  } finally {
    await r.done();
  }
  const off = await rig({ proxyView: false });
  try {
    const c = off.connect(VIEWER);
    await c.until('refused', () => c.closed);
    assert.equal(c.closed!.code, 4003);
    assert.match(c.closed!.reason, /preview is off/);
    assert.equal(off.h.target.state.helpers.length, 0);
  } finally {
    await off.done();
  }
});

test('a browser has a cap on viewers; one closing makes room', async () => {
  const r = await rig();
  try {
    const open: Client[] = [];
    for (let i = 0; i < VIEWERS_PER_BROWSER; i++) {
      const c = r.connect(`viewer-device-${i + 1}`);
      (await r.helper(i)).say(ev({ e: 'ready' }));
      await c.until('ready', () => c.events.find((e) => e.e === 'ready'));
      open.push(c);
    }
    const extra = r.connect('one-too-many-1');
    await extra.until('refused', () => extra.closed);
    assert.equal(extra.closed!.code, 4003);
    assert.equal(r.h.service.viewerCount(WS), VIEWERS_PER_BROWSER);

    open[0]!.ws.close();
    for (let i = 0; i < 100 && r.h.service.viewerCount(WS) >= VIEWERS_PER_BROWSER; i++) await sleep(10);
    const next = r.connect('one-more-device-1');
    (await r.helper(VIEWERS_PER_BROWSER)).say(ev({ e: 'ready' }));
    await next.until('ready', () => next.events.find((e) => e.e === 'ready'));
  } finally {
    await r.done();
  }
});

test('input is rate-limited per socket, and everything is released when the socket closes', async () => {
  const r = await rig();
  try {
    r.control(OWNER);
    const c = r.connect(OWNER);
    const helper = await r.helper();
    helper.say(ev({ e: 'ready' }));
    await c.until('ready', () => c.events.find((e) => e.e === 'ready'));
    assert.equal(r.h.service.leases.isOpen(WS, OWNER), true, 'an open view keeps the holder from being "away"');
    for (let i = 0; i < 1500; i++) c.send({ t: 'mouse', a: 'move', x: (i % 100) / 100, y: 0.5 });
    c.send({ t: 'ping' });
    await c.until('pong', () => c.events.find((e) => e.e === 'pong'));
    await sleep(50);
    const n = helper.sent().length;
    assert.ok(n >= 300 && n < 800, `${n} of 1500 moves reached the container`);

    c.ws.close();
    for (let i = 0; i < 100 && !helper.state.closed; i++) await sleep(10);
    assert.equal(helper.state.closed, true);
    assert.equal(r.h.service.viewerCount(WS), 0);
    assert.equal(r.h.service.leases.isOpen(WS, OWNER), false);
  } finally {
    await r.done();
  }
});
