// T-2591: a tab far behind subscribes after its last seq; the portal answers the newest events only (its cap, T-2589) and says `gap`.
// useChatSession mounted over a stubbed fetch and WebSocket: without the re-seed the transcript shows the old events, then the newest ones
// after a silent hole; with it the newest page replaces what is held, the older events come back through the paged read, and a live
// event that came meanwhile stays. A page that cannot be read seeds from the backlog itself.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { ChatEvent, ChatServerMessage } from '@portal/contracts';
import { mountHook, type Mounted } from './hookHarness';
import { useChatSession, type ChatSessionApi } from './useChatSocket';

interface Call {
  url: string;
  done?: true;
  reply(status: number, body: unknown): void;
}

class FakeSocket {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  push(msg: ChatServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const g = globalThis as Record<string, unknown>;
const saved = { fetch: g.fetch, WebSocket: g.WebSocket, window: g.window, location: g.location, raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
let calls: Call[] = [];
let mounted: Mounted<ChatSessionApi> | null = null;

beforeEach(() => {
  calls = [];
  FakeSocket.all = [];
  g.fetch = (url: unknown) =>
    new Promise<Response>((resolve) => {
      calls.push({ url: String(url), reply: (status, body) => resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) });
    });
  g.WebSocket = FakeSocket;
  g.window ??= globalThis;
  g.location ??= { protocol: 'http:', host: 'portal.test' };
  g.requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0) as unknown as number;
  g.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  g.fetch = saved.fetch;
  g.WebSocket = saved.WebSocket;
  g.window = saved.window;
  g.location = saved.location;
  g.requestAnimationFrame = saved.raf;
  g.cancelAnimationFrame = saved.caf;
});

const tick = () => new Promise<void>((r) => setImmediate(r));
async function until<T>(f: () => T | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const v = f();
    if (v) return v;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** The next unanswered request whose URL matches. */
const take = async (match: RegExp): Promise<Call> => {
  const c = await until(() => calls.find((x) => !x.done && match.test(x.url)), `a request matching ${match}`);
  c.done = true;
  return c;
};

const at = new Date().toISOString();
const ev = (seq: number): ChatEvent => ({ seq, at, kind: 'assistant', text: `e${seq}` });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));
const seqs = () => mounted!.current.events.map((e) => e.seq);
const NEWEST = /\/api\/chat\/sessions\/s1\/events\?limit=200$/;

/** Mounts the hook for session s1, seeds it with events 1..3 (the whole chat), opens the socket and checks it subscribed after 3. */
async function start(): Promise<FakeSocket> {
  mounted = mountHook(() => useChatSession('s1'), { context: () => undefined });
  (await take(NEWEST)).reply(200, { data: { events: range(1, 3), more: false, before: null } });
  await until(() => seqs().length === 3, 'the first page');
  const sock = await until(() => FakeSocket.all[0], 'the socket');
  sock.open();
  assert.deepEqual(sock.sent[0], { type: 'subscribe', session: 's1', afterSeq: 3 });
  return sock;
}

test('a backlog with a gap re-seeds from the newest page: no hole, older events through the paged read, live ones kept', async () => {
  const sock = await start();
  // The tab slept; 96 events later the portal sends only the newest of them (101..120), and says some were left out.
  sock.push({ type: 'events', session: 's1', items: range(101, 120), gap: true });
  sock.push({ type: 'events', session: 's1', items: [ev(121)] }); // live, while the page is read
  const reread = await take(NEWEST);
  assert.deepEqual(seqs().slice(0, 3), [1, 2, 3], 'until the page comes, nothing is put after the hole');
  reread.reply(200, { data: { events: range(111, 120), more: true, before: 111 } });
  await until(() => seqs()[0] === 111, 'the re-seed');
  assert.deepEqual(seqs(), [...range(111, 121).map((e) => e.seq)], 'the newest page and the live event, no old events before a hole');
  assert.equal(mounted!.current.paging.more, true, 'older events are there to page back to');

  mounted!.current.loadOlder();
  const older = await take(/\/api\/chat\/sessions\/s1\/events\?before=111&limit=200$/);
  older.reply(200, { data: { events: range(101, 110), more: true, before: 101 } });
  await until(() => seqs()[0] === 101, 'the older page');
  assert.deepEqual(seqs(), range(101, 121).map((e) => e.seq), 'in order, no hole');
});

test('a backlog without a gap is appended as before; one with a gap whose page fails seeds from the backlog itself', async () => {
  const sock = await start();
  sock.push({ type: 'events', session: 's1', items: range(4, 6) });
  await until(() => seqs().length === 6, 'the appended backlog');
  assert.equal(calls.filter((c) => NEWEST.test(c.url)).length, 1, 'no second page read without a gap');

  sock.push({ type: 'events', session: 's1', items: range(201, 210), gap: true });
  (await take(NEWEST)).reply(500, { error: { code: 'INTERNAL_ERROR', message: 'down' } });
  await until(() => seqs()[0] === 201, 'the fallback re-seed');
  assert.deepEqual(seqs(), range(201, 210).map((e) => e.seq));
  assert.equal(mounted!.current.paging.more, true);
  mounted!.current.loadOlder();
  await take(/\/api\/chat\/sessions\/s1\/events\?before=201&limit=200$/);
});
