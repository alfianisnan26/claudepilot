import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { serveTestPages, type TestPages } from './testpages.js';

/**
 * `cpb-view` (images/browser/cpb/cpb-view), the container's end of the proxy browser (PRD §22), against a real
 * Chromium on a loopback port: the narrow protocol in both directions, and what it refuses. Frames and events come
 * back framed on stdout exactly as the portal reads them.
 */

const CPB = fileURLToPath(new URL('../../../../images/browser/cpb/', import.meta.url));
const CHROMIUM = process.env.CPB_CHROME_BIN ?? '/usr/bin/chromium';
const opts = { skip: existsSync(CHROMIUM) ? false : 'Chromium is not installed here' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How much longer the waits are on a busy machine: CP_TEST_TIME_SCALE, which scripts/gate.sh sets (1 to 10). */
const TIME_SCALE = Math.min(10, Math.max(1, Number(process.env.CP_TEST_TIME_SCALE ?? 1) || 1));

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

interface Ev {
  e: string;
  [k: string]: unknown;
}
interface Frame {
  header: { dw: number; dh: number; tab: string; emu: boolean };
  jpeg: Buffer;
}

/** The helper, as the portal runs it: JSON lines in, framed events and JPEG frames out. */
class View {
  readonly events: Ev[] = [];
  readonly frames: Frame[] = [];
  readonly stderr: string[] = [];
  #buf = Buffer.alloc(0);
  constructor(readonly child: ChildProcess) {
    child.stdout!.on('data', (d: Buffer) => {
      this.#buf = Buffer.concat([this.#buf, d]);
      for (;;) {
        if (this.#buf.length < 5) return;
        const len = this.#buf.readUInt32BE(1);
        if (this.#buf.length < 5 + len) return;
        const kind = this.#buf[0];
        const payload = this.#buf.subarray(5, 5 + len);
        this.#buf = this.#buf.subarray(5 + len);
        if (kind === 1) this.events.push(JSON.parse(payload.toString('utf8')) as Ev);
        else if (kind === 2) {
          const h = payload.readUInt32BE(0);
          this.frames.push({ header: JSON.parse(payload.subarray(4, 4 + h).toString('utf8')) as Frame['header'], jpeg: Buffer.from(payload.subarray(4 + h)) });
        }
      }
    });
    child.stderr!.on('data', (d: Buffer) => this.stderr.push(String(d)));
  }
  send(m: unknown) {
    this.child.stdin!.write(`${JSON.stringify(m)}\n`);
  }
  /** Polls `find` until it answers; the timeout (times CP_TEST_TIME_SCALE) says what was seen: the last events and frames. */
  async until<T>(what: string, find: () => T | undefined, ms = 8000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = find();
      if (v !== undefined) return v;
      if (Date.now() - t0 > ms * TIME_SCALE) {
        const frames = this.frames.slice(-4).map((f) => f.header);
        throw new Error(`timed out waiting for ${what}; events ${JSON.stringify(this.events.slice(-6))}; ${this.frames.length} frames, last ${JSON.stringify(frames)}; stderr ${this.stderr.join('').slice(-300)}`);
      }
      await sleep(40);
    }
  }
  /** The title the current tab last reported. */
  title = () => [...this.events].reverse().find((e) => e.e === 'url')?.title as string | undefined;
  /** The newest frame's size: what mouse fractions are relative to. */
  size = () => this.frames.at(-1)?.header;
  close() {
    this.child.stdin!.end();
    this.child.kill('SIGTERM');
  }
}

describe('cpb-view', opts, () => {
  let chrome: ChildProcess;
  let port: number;
  let dir: string;
  let pages: TestPages;

  const start = () => {
    const child = spawn(process.execPath, [join(CPB, 'cpb-view')], { env: { ...process.env, CPB_CDP_PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'] });
    return new View(child);
  };
  /** A click at a fixed position of the test page (CSS pixels), as the fractions the protocol carries. */
  const click = (v: View, px: number, py: number, b = 0) => {
    const { dw, dh } = v.size()!;
    v.send({ t: 'mouse', a: 'move', x: px / dw, y: py / dh });
    v.send({ t: 'mouse', a: 'down', x: px / dw, y: py / dh, b, cc: 1 });
    v.send({ t: 'mouse', a: 'up', x: px / dw, y: py / dh, b, cc: 1 });
  };

  /** One tab on the test page, a fresh helper, and the helper's end: what each test starts from. */
  const fresh = async (fn: (v: View) => Promise<void>) => {
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { id: string; type: string; url: string }[];
    const old = list.filter((t) => t.type === 'page' && !t.url.startsWith('chrome://'));
    // A new tab on the page, then the old ones go: every test starts from the same single tab.
    const made = (await (await fetch(`http://127.0.0.1:${port}/json/new?${pages.url('/view')}`, { method: 'PUT' })).json()) as { id: string };
    for (const t of old) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
    await fetch(`http://127.0.0.1:${port}/json/activate/${made.id}`);
    const v = start();
    try {
      await v.until('ready', () => v.events.find((e) => e.e === 'ready'), 15_000);
      await v.until('a frame', () => v.frames[0]);
      await fn(v);
    } finally {
      v.close();
    }
  };

  before(async () => {
    port = await freePort();
    dir = mkdtempSync(join(tmpdir(), 'cpbv-test-'));
    pages = await serveTestPages();
    chrome = spawn(CHROMIUM, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'p')}`, '--window-size=1000,700', pages.url('/view')], { stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
      if (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false)) break;
      await sleep(150);
    }
  });
  after(async () => {
    chrome?.kill('SIGTERM');
    await pages?.close();
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  });

  test('it announces itself, lists the tabs and streams JPEG frames of the front tab', async () => {
    await fresh(async (view) => {
    const tabs = await view.until('tabs', () => view.events.find((e) => e.e === 'tabs' && (e.tabs as unknown[]).length > 0));
    assert.equal((tabs.tabs as { url: string }[])[0]!.url, pages.url('/view'));
    const frame = await view.until('a frame', () => view.frames[0]);
    assert.deepEqual([...frame.jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'a JPEG');
    assert.equal(frame.header.dw, 1000);
    assert.equal(frame.header.emu, false);
    assert.ok(frame.header.tab);
    });
  });

  test('a click and a typed key reach the page, with positions as fractions of the frame', async () => {
    await fresh(async (view) => {
    await view.until('the page title', () => (view.title() === 'view-ready' ? true : undefined));
    click(view, 60, 30);
    await view.until('the click', () => (view.title() === 'clicked' ? true : undefined));
    click(view, 100, 85);
    await sleep(200);
    for (const ch of 'hi') {
      view.send({ t: 'key', a: 'down', key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch });
      view.send({ t: 'key', a: 'up', key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0) });
    }
    await view.until('typed text', () => (view.title() === 'typed:hi' ? true : undefined));
    view.send({ t: 'text', text: ' there' });
    await view.until('inserted text', () => (view.title() === 'typed:hi there' ? true : undefined));
    });
  });

  test('the wheel scrolls the page, and a right click is a right click', async () => {
    await fresh(async (view) => {
    const { dw, dh } = view.size()!;
    view.send({ t: 'mouse', a: 'wheel', x: 0.5, y: 0.6, dx: 0, dy: 500 });
    await view.until('the scroll', () => (/^scroll:[1-9]/.test(view.title() ?? '') ? true : undefined));
    click(view, dw / 2, dh / 2, 2);
    await view.until('the context menu event', () => (view.title() === 'context' ? true : undefined));
    });
  });

  test('navigation: back, forward, reload and an address; only web addresses', async () => {
    await fresh(async (view) => {
    const before = view.events.length;
    view.send({ t: 'go', url: pages.url('/second') });
    await view.until('the new page', () => (view.title() === 'CP Second' ? true : undefined));
    view.send({ t: 'back' });
    await view.until('back', () => (view.events.slice(before).some((e) => e.e === 'url' && String(e.url).endsWith('/view')) ? true : undefined));
    view.send({ t: 'forward' });
    await view.until('forward', () => (view.title() === 'CP Second' ? true : undefined));
    view.send({ t: 'reload' });
    await view.until('loading', () => view.events.slice(before).find((e) => e.e === 'loading' && e.on === true));
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,hi', 'nospaces here', 'http:/', '']) {
      const n = view.events.length;
      view.send({ t: 'go', url: bad });
      await view.until(`refusal of ${JSON.stringify(bad)}`, () => view.events.slice(n).find((e) => e.e === 'error'));
    }
    assert.equal(view.title(), 'CP Second', 'none of them went anywhere');
    // A bare host or host:port gets a scheme: http for loopback and IPs, https otherwise.
    view.send({ t: 'go', url: pages.url('/view').replace('http://', '') });
    await view.until('a bare host:port', () => (view.title() === 'view-ready' ? true : undefined));
    });
  });

  test('tabs: a new tab is watched at once, tabs can be switched and closed', async () => {
    await fresh(async (view) => {
    const before = view.frames.length;
    const first = view.frames.at(-1)!.header.tab;
    const seen = view.events.length;
    view.send({ t: 'newTab', url: pages.url('/second') });
    // The list can go out while the view is still moving to the new tab (current is the first tab, or null between the
    // two): only the one that names the new tab as current says which tab the frames will be of (T-272).
    const tabs = await view.until('two tabs, the new one current', () =>
      view.events.slice(seen).reverse().find((e) => e.e === 'tabs' && (e.tabs as unknown[]).length === 2 && typeof e.current === 'string' && e.current !== first),
    );
    const current = tabs.current as string;
    await view.until('frames of the new tab', () => view.frames.slice(before).find((f) => f.header.tab === current));
    const other = (tabs.tabs as { id: string }[]).find((t) => t.id !== current)!;
    const mark = view.frames.length;
    view.send({ t: 'tab', id: other.id, activate: true });
    await view.until('switching', () => view.frames.slice(mark).find((f) => f.header.tab === other.id));
    view.send({ t: 'closeTab', id: current });
    await view.until('one tab left', () => view.events.slice(-8).reverse().find((e) => e.e === 'tabs' && (e.tabs as unknown[]).length === 1));
    view.send({ t: 'tab', id: 'not-a-tab' }); // ignored
    view.send({ t: 'follow', on: true });
    });
  });

  test('it follows the front tab: one opened or brought forward by someone else becomes the one watched', async () => {
    await fresh(async (view) => {
      const first = view.frames.at(-1)!.header.tab;
      const made = (await (await fetch(`http://127.0.0.1:${port}/json/new?${pages.url('/second')}`, { method: 'PUT' })).json()) as { id: string };
      await view.until('frames of the new front tab', () => view.frames.slice(-8).find((f) => f.header.tab === made.id), 10_000);
      await fetch(`http://127.0.0.1:${port}/json/activate/${first}`);
      await view.until('frames of the first tab again', () => view.frames.slice(-8).find((f) => f.header.tab === first), 10_000);
      // A person's own choice (activated, as the portal asks it) doesn't end the following: the chosen tab is the front one.
      view.send({ t: 'tab', id: made.id, activate: true });
      await view.until('the chosen tab', () => view.frames.slice(-8).find((f) => f.header.tab === made.id));
      await fetch(`http://127.0.0.1:${port}/json/activate/${first}`);
      await view.until('following again', () => view.frames.slice(-8).find((f) => f.header.tab === first), 10_000);
    });
  });

  test('viewport: a phone size with its pixel ratio, and back to the window’s own', async () => {
    await fresh(async (view) => {
    let mark = view.frames.length;
    view.send({ t: 'viewport', w: 390, h: 700, dpr: 2, mobile: true });
    const emu = await view.until('an emulated frame', () => view.frames.slice(mark).find((f) => f.header.emu && f.header.dw === 390));
    assert.equal(emu.header.dw, 390);
    mark = view.frames.length;
    view.send({ t: 'viewport', reset: true });
    await view.until('the window’s size again', () => view.frames.slice(mark).find((f) => !f.header.emu && f.header.dw === 1000));
    // Out-of-range values are clamped, not passed on as they are.
    mark = view.frames.length;
    view.send({ t: 'viewport', w: 99999, h: -5, dpr: 40 });
    const clamped = await view.until('a clamped frame', () => view.frames.slice(mark).find((f) => f.header.emu));
    assert.ok(clamped.header.dw <= 4096 && clamped.header.dh >= 100);
    mark = view.frames.length;
    view.send({ t: 'viewport', reset: true });
    await view.until('reset', () => view.frames.slice(mark).find((f) => !f.header.emu));
    });
  });

  test('viewport: every change shows on a still page, and no frame is labelled with a size it does not have', async () => {
    await fresh(async (view) => {
      // A still page paints nothing by itself: the frame of the new size must come from the view, every time (T-331).
      for (let i = 0; i < 4; i++) {
        let mark = view.frames.length;
        view.send({ t: 'viewport', w: 390 + i * 10, h: 700, dpr: 2, mobile: true });
        await view.until(`phone frame ${i}`, () => view.frames.slice(mark).find((f) => f.header.emu && f.header.dw === 390 + i * 10));
        mark = view.frames.length;
        view.send({ t: 'viewport', reset: true });
        await view.until(`window frame ${i}`, () => view.frames.slice(mark).find((f) => !f.header.emu && f.header.dw === 1000));
      }
      assert.equal(view.frames.filter((f) => f.header.emu && f.header.dw === 1000).length, 0, 'no window-size frame called emulated');
      assert.equal(view.events.filter((e) => e.e === 'error').length, 0);
    });
  });

  test('quality: a lighter stream can be asked for while one is running, and the same ask twice is not an error', async () => {
    await fresh(async (view) => {
      const before = view.frames.at(-1)!.jpeg.length;
      const mark = view.frames.length;
      view.send({ t: 'quality', q: 20, maxW: 320, fps: 5 });
      view.send({ t: 'quality', q: 20, maxW: 320, fps: 5 });
      await view.until('a frame after the change', () => (view.frames.length > mark ? true : undefined), 10_000);
      assert.ok(view.frames.at(-1)!.jpeg.length < before, 'smaller frames');
      assert.equal(view.events.filter((e) => e.e === 'error').length, 0);
    });
  });

  test('a JavaScript dialog is reported, and answered when the person does', async () => {
    await fresh(async (view) => {
    await view.until('the page', () => (view.title() === 'view-ready' ? true : undefined));
    click(view, 60, 140);
    const dialog = await view.until('the dialog', () => view.events.find((e) => e.e === 'dialog'));
    assert.equal(dialog.kind, 'alert');
    assert.equal(dialog.message, 'hello from the page');
    view.send({ t: 'dialog', accept: true });
    await view.until('the dialog to close', () => view.events.find((e) => e.e === 'dialog-closed'));
    await view.until('the page to go on', () => (view.title() === 'alert closed' ? true : undefined));
    });
  });

  test('malformed, oversized and unknown messages are ignored, and it keeps answering', async () => {
    await fresh(async (view) => {
    view.child.stdin!.write('not json\n');
    view.child.stdin!.write(`${JSON.stringify({ t: 'text', text: 'x'.repeat(100_000) })}\n`);
    view.child.stdin!.write(`${JSON.stringify({ t: 'evaluate', expression: 'document.cookie' })}\n`);
    view.child.stdin!.write(`${JSON.stringify({ t: 'cdp', method: 'Network.getAllCookies' })}\n`);
    view.child.stdin!.write(`${JSON.stringify({ t: 'key', a: 'down', key: 'k'.repeat(100), code: 'x' })}\n`);
    view.child.stdin!.write(`${JSON.stringify({ t: 'mouse', a: 'move', x: 'a', y: null })}\n`);
    view.send({ t: 'ping' });
    await view.until('pong', () => view.events.slice(-4).find((e) => e.e === 'pong'));
    assert.equal(view.events.filter((e) => e.e === 'error' && /cookie/i.test(String(e.message))).length, 0);
    });
  });

  test('it never writes a frame to disk, and ends when the portal closes the pipe', async () => {
    const v = start();
    await v.until('ready', () => v.events.find((e) => e.e === 'ready'), 15_000);
    await v.until('a frame', () => v.frames[0]);
    const exited = new Promise<number | null>((resolve) => v.child.once('exit', resolve));
    v.child.stdin!.end();
    assert.equal(await exited, 0);
    // Nothing of its own in the temp folder (frames would be the only thing it could leave).
    const { readdirSync } = await import('node:fs');
    assert.ok(!readdirSync(tmpdir()).some((f) => /^cpb-view|screencast/.test(f)));
  });

  test('without a browser it says so and exits', async () => {
    const child = spawn(process.execPath, [join(CPB, 'cpb-view')], { env: { ...process.env, CPB_CDP_PORT: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const v = new View(child);
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.equal(code, 1);
    assert.match(String(v.events.find((e) => e.e === 'error')?.message), /not available/);
  });
});
