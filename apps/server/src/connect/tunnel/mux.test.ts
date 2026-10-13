// T-MUX (docs/prd/targets-connect.md §19.3): the conformance suite over a memory pair with random delays and a finite link, and over a real `ws` pair
// on loopback; then what only a test with the raw socket can see (violations, the high-water mark, liveness on fake timers, fuzz).

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, mock, test } from 'node:test';
import { CONNECT_LIMITS, CONNECT_MUX } from '@portal/contracts';
import { WebSocket, WebSocketServer } from 'ws';
import { runMuxConformance, type MakeSessionPair, type SessionPair } from './conformance.js';
import { FRAME_FLAG, FRAME_TYPE, dataFrame, encodeHeader, goAwayFrame, pingFrame, windowUpdateFrame } from './frame.js';
import { memoryPair, type MemorySocket } from './memory.js';
import { CONTROL_BACKLOG, MuxSession, defaultMuxLimits, type MuxCloseInfo, type MuxSocket, type MuxStream } from './mux.js';
import { TUNNEL_WS_OPTIONS, WsMuxSocket } from './ws.js';

const makeMemory =
  (opts: Parameters<typeof memoryPair>[0]): MakeSessionPair =>
  (handlers, options) => {
    const [a, b] = memoryPair(opts);
    const client = new MuxSession({ role: 'client', socket: a, onStream: handlers.onClientStream, limits: options?.client, closeError: options?.closeError });
    const server = new MuxSession({ role: 'server', socket: b, onStream: handlers.onServerStream, limits: options?.server, closeError: options?.closeError });
    return { client, server, close: () => (client.destroy(), server.destroy()) };
  };

/** A real WebSocket pair on loopback, each end wrapped in a MuxSession the way the hub and the agent do it (but with no handshake). */
const makeWs: MakeSessionPair = async (handlers, options) => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, ...TUNNEL_WS_OPTIONS, handleProtocols: () => 'pilot.tunnel.v1' });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  const serverWs = new Promise<WebSocket>((resolve) => wss.once('connection', resolve));
  const clientWs = new WebSocket(`ws://127.0.0.1:${port}/`, ['pilot.tunnel.v1'], TUNNEL_WS_OPTIONS);
  await once(clientWs, 'open');
  const sws = await serverWs;
  const client = new MuxSession({ role: 'client', socket: new WsMuxSocket(clientWs), onStream: handlers.onClientStream, limits: options?.client, closeError: options?.closeError });
  const server = new MuxSession({ role: 'server', socket: new WsMuxSocket(sws), onStream: handlers.onServerStream, limits: options?.server, closeError: options?.closeError });
  return {
    client,
    server,
    close: async () => {
      client.destroy();
      server.destroy();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  } satisfies SessionPair;
};

runMuxConformance('memory pair, random delay, 20 MB/s link', makeMemory({ delayMs: [0, 4], bytesPerSec: 20_000_000, seed: 7 }), { echoBudgetMs: 120 });
runMuxConformance('ws pair on loopback', makeWs, { echoBudgetMs: 250 });

// ---- what the raw socket shows -----------------------------------------------------------------------------------------------------

/** Polls until `cond` holds (the machine may be busy: a fixed sleep is a flaky test), or `ms` pass. Resolves whether it held. */
async function waitFor(cond: () => boolean, ms = 1_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 2));
  }
  return true;
}

/** A session on one end of a memory pair, and the other end as a raw socket the test writes frames to and reads frames from. */
function rawPeer(role: 'client' | 'server' = 'server', limits: Partial<ReturnType<typeof defaultMuxLimits>> = {}) {
  const [mine, theirs] = memoryPair();
  const streams: MuxStream[] = [];
  const log: string[] = [];
  const closed: MuxCloseInfo[] = [];
  const session = new MuxSession({ role, socket: mine, onStream: (s) => streams.push(s), limits, log: (l) => log.push(l) });
  session.onClose((i) => closed.push(i));
  const received: Buffer[] = [];
  theirs.onMessage((d) => received.push(d));
  const closes: { code: number; reason: string }[] = [];
  theirs.onClose((code, reason) => closes.push({ code, reason }));
  const tick = () => new Promise<void>((r) => setImmediate(r));
  return { session, theirs, streams, log, closed, received, closes, tick };
}

/** The headers of what a raw peer received, as `type/flags/id/length` text. */
const headers = (received: Buffer[]): string[] =>
  received.map((b) => `${b[1]}/${b.readUInt16BE(2)}/${b.readUInt32BE(4)}/${b.readUInt32BE(8)}`);

describe('mux violations', () => {
  const violate = async (frame: Buffer, role: 'client' | 'server' = 'server', prepare?: (p: ReturnType<typeof rawPeer>) => Promise<void> | void) => {
    const p = rawPeer(role);
    await prepare?.(p);
    p.theirs.send(frame, () => undefined);
    await waitFor(() => p.closes.length > 0, 400);
    return p;
  };
  const clientId = 1; // a `server` session's peer opens odd ids

  test('a wrong version byte answers GO_AWAY(1) and closes with 1002', async () => {
    const bad = encodeHeader({ type: 0, flags: 0, streamId: 1, length: 0 });
    bad[0] = 1;
    const p = await violate(bad);
    assert.equal(p.session.closed, true);
    assert.equal(p.closed[0]?.protocolError, true);
    assert.equal(p.closes[0]?.code, 1002);
    assert.ok(p.received.some((b) => b[1] === FRAME_TYPE.goAway && b.readUInt32BE(8) === CONNECT_MUX.goAway.protocol));
  });

  test('an unknown type, an oversize data frame, and a text message are violations', async () => {
    const unknownType = encodeHeader({ type: 9, flags: 0, streamId: 1, length: 0 });
    assert.equal((await violate(unknownType)).closes[0]?.code, 1002);
    const oversize = Buffer.concat([encodeHeader({ type: 0, flags: FRAME_FLAG.syn, streamId: clientId, length: 65_537 }), Buffer.alloc(65_537)]);
    assert.equal((await violate(oversize)).closes[0]?.code, 1002);
    const p = rawPeer();
    p.theirs.sendText('{"t":"auth"}');
    await waitFor(() => p.closes.length > 0, 400);
    assert.equal(p.closes[0]?.code, 1002);
    assert.match(p.log.join('\n'), /text message/);
  });

  test('a stream id of the wrong parity, a reused id, and data for a stream never opened are violations', async () => {
    const even = dataFrame(2, FRAME_FLAG.syn, Buffer.from('x')); // a server session's peer is the client: even ids are the server's own
    assert.equal((await violate(even)).closes[0]?.code, 1002);
    const p = await violate(dataFrame(7, 0, Buffer.from('x'))); // never opened
    assert.equal(p.closes[0]?.code, 1002);
    const reuse = await violate(dataFrame(1, FRAME_FLAG.syn, Buffer.from('y')), 'server', async (q) => {
      q.theirs.send(dataFrame(3, FRAME_FLAG.syn, Buffer.from('x')), () => undefined);
      await q.tick();
    });
    assert.equal(reuse.closes[0]?.code, 1002, 'id 1 after id 3: ids must rise');
  });

  test('a window overflow and stream 0 carrying data are violations', async () => {
    const p = rawPeer();
    p.theirs.send(dataFrame(1, FRAME_FLAG.syn, Buffer.from('x')), () => undefined);
    p.theirs.send(windowUpdateFrame(1, 0, 1), () => undefined); // grants more than it consumed: the window would pass its start
    await waitFor(() => p.closes.length > 0, 400);
    assert.equal(p.closes[0]?.code, 1002);
    assert.match(p.log.join('\n'), /window overflow/);
    assert.equal((await violate(dataFrame(0, 0, Buffer.from('x')))).closes[0]?.code, 1002);
  });

  test('data past the window is a violation', async () => {
    // Nobody reads, so after the Readable's own buffer (64 KiB) the inbox fills; the fourth 64 KiB frame passes a 200 000 byte window.
    const p = rawPeer('server', { initialWindow: 200_000, windowUpdateAt: 100_000 });
    p.theirs.send(dataFrame(1, FRAME_FLAG.syn, Buffer.alloc(65_536)), () => undefined);
    for (let i = 0; i < 3; i++) p.theirs.send(dataFrame(1, 0, Buffer.alloc(65_536)), () => undefined);
    await waitFor(() => p.closes.length > 0, 400);
    assert.equal(p.closes[0]?.code, 1002);
    assert.match(p.log.join('\n'), /past its window/);
  });

  test('data after the peer’s FIN is answered with RST, not with the end of the session', async () => {
    const p = rawPeer();
    p.theirs.send(dataFrame(1, FRAME_FLAG.syn | FRAME_FLAG.fin, Buffer.from('x')), () => undefined);
    await new Promise((r) => setTimeout(r, 10));
    const s = p.streams[0]!;
    s.on('error', () => undefined);
    s.resume();
    p.theirs.send(dataFrame(1, 0, Buffer.from('late')), () => undefined);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(p.session.closed, false);
    assert.ok(headers(p.received).some((h) => h.startsWith(`${FRAME_TYPE.window}/${FRAME_FLAG.rst}/1/`)), `no RST in ${headers(p.received).join(' ')}`);
    p.session.destroy();
  });

  test('data for a stream that was reset a moment ago is dropped silently', async () => {
    const p = rawPeer();
    p.theirs.send(dataFrame(1, FRAME_FLAG.syn, Buffer.from('x')), () => undefined);
    await new Promise((r) => setTimeout(r, 10));
    p.streams[0]!.on('error', () => undefined);
    p.streams[0]!.destroy(); // our RST goes out
    await new Promise((r) => setTimeout(r, 10));
    p.theirs.send(dataFrame(1, 0, Buffer.from('in flight when the RST went out')), () => undefined);
    p.theirs.send(windowUpdateFrame(1, 0, 10), () => undefined);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(p.session.closed, false);
    p.session.destroy();
  });

  test('a ping is answered with the same value, and GO_AWAY is remembered', async () => {
    const p = rawPeer();
    p.theirs.send(pingFrame(false, 0x01020304), () => undefined);
    p.theirs.send(goAwayFrame(0), () => undefined);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(headers(p.received).includes(`${FRAME_TYPE.ping}/${FRAME_FLAG.ack}/0/${0x01020304}`));
    assert.equal(p.session.remoteGoAway, 0);
    p.session.destroy();
  });

  test('several frames in one message, and a frame split over messages, both parse', async () => {
    const p = rawPeer();
    const a = dataFrame(1, FRAME_FLAG.syn, Buffer.from('one'));
    const b = dataFrame(3, FRAME_FLAG.syn, Buffer.from('two'));
    p.theirs.send(Buffer.concat([a, b]), () => undefined);
    const c = dataFrame(5, FRAME_FLAG.syn, Buffer.from('three'));
    p.theirs.send(c.subarray(0, 7), () => undefined);
    p.theirs.send(c.subarray(7), () => undefined);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(p.streams.map((s) => s.id), [1, 3, 5]);
    assert.equal(p.session.closed, false);
    p.session.destroy();
  });
});

describe('a peer that reads nothing (T6)', () => {
  /** A socket whose peer never reads: nothing handed to it ever leaves, so the mux stays over its high-water mark. The test injects what the peer sends. */
  function stuckSocket() {
    let deliver: (data: Buffer, isBinary: boolean) => void = () => undefined;
    const closes: number[] = [];
    let sent = 0;
    const socket: MuxSocket = {
      send: (data) => void (sent += data.length),
      get bufferedAmount() {
        return 1 << 20;
      },
      close: (code) => void closes.push(code),
      terminate: () => void closes.push(1006),
      onMessage: (fn) => void (deliver = fn),
      onClose: () => undefined,
      onError: () => undefined,
    };
    return { socket, closes, sent: () => sent, push: (data: Buffer) => deliver(data, true) };
  }
  const burst = (frame: (i: number) => Buffer, n: number) => Buffer.concat(Array.from({ length: n }, (_, i) => frame(i)));

  test('a flood of pings it never reads the answers to ends the session instead of growing the queue', () => {
    const peer = stuckSocket();
    const log: string[] = [];
    const session = new MuxSession({ role: 'server', socket: peer.socket, log: (l) => log.push(l) });
    // one message holds about 87,000 pings (1 MiB); twenty such would have queued 1.7 million answers before the fix
    for (let i = 0; i < 20 && !session.closed; i++) peer.push(burst((j) => pingFrame(false, i * 1000 + j), 1000));
    assert.equal(session.closed, true, 'the session ended');
    assert.equal(peer.closes[0], 1002);
    assert.match(log.join('\n'), /asks for more than it reads/);
  });

  test('so does a flood of SYNs past the stream cap (each one would be answered with an RST)', () => {
    const peer = stuckSocket();
    const held: MuxStream[] = [];
    const session = new MuxSession({ role: 'server', socket: peer.socket, limits: { maxStreams: 4 }, onStream: (s) => void held.push(s) });
    for (let i = 0; i < 10 && !session.closed; i++) peer.push(burst((j) => dataFrame(1 + 2 * (i * 1000 + j), FRAME_FLAG.syn, Buffer.alloc(0)), 1000));
    assert.equal(session.closed, true);
    assert.equal(peer.closes[0], 1002);
  });

  test('a few pings while the link is busy are still answered (a legitimate slow link is not cut off)', () => {
    const peer = stuckSocket();
    const session = new MuxSession({ role: 'server', socket: peer.socket });
    peer.push(burst((j) => pingFrame(false, j), Math.min(100, CONTROL_BACKLOG - 1)));
    assert.equal(session.closed, false);
    session.destroy();
  });
});

describe('mux scheduling', () => {
  test('DATA frames are at most 64 KiB, and no more than the peer’s window is sent', async () => {
    const [mine, theirs] = memoryPair();
    const frames: Buffer[] = [];
    theirs.onMessage((d) => frames.push(d));
    const session = new MuxSession({ role: 'client', socket: mine });
    const a = session.open();
    a.write(Buffer.alloc(300_000, 1)); // more than the window: it is sent in frames of at most 64 KiB, up to the window
    await new Promise((r) => setTimeout(r, 50));
    const sizes = frames.filter((f) => f[1] === FRAME_TYPE.data).map((f) => f.readUInt32BE(8));
    assert.ok(sizes.length >= 4);
    assert.ok(sizes.every((n) => n <= 65_536));
    assert.ok(sizes.reduce((x, y) => x + y, 0) <= CONNECT_LIMITS.initialWindow, 'never more than the peer’s window');
    session.destroy();
  });

  test('the sender stops at the high-water mark and resumes under the low-water mark', async () => {
    // a link that takes 1 s per 100 kB, and no reader: the mux may hand over at most about 128 KiB plus one frame at a time
    const [mine, theirs] = memoryPair({ bytesPerSec: 100_000 });
    theirs.onMessage(() => undefined);
    const session = new MuxSession({ role: 'client', socket: mine });
    const streams = [session.open(), session.open(), session.open(), session.open()];
    for (const s of streams) s.write(Buffer.alloc(200_000, 3));
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(mine.bufferedAmount <= CONNECT_LIMITS.sendHighWater + CONNECT_LIMITS.maxFramePayload + 24, `buffered ${mine.bufferedAmount}`);
    assert.ok(mine.bufferedAmount >= CONNECT_LIMITS.sendHighWater, 'it filled up to the mark');
    session.destroy();
  });

  test('a control frame waits at most for the buffer to fall below the low-water mark', async () => {
    const [mine, theirs] = memoryPair({ bytesPerSec: 200_000 });
    const frames: { at: number; type: number }[] = [];
    const t0 = Date.now();
    theirs.onMessage((d) => frames.push({ at: Date.now() - t0, type: d[1]! }));
    const session = new MuxSession({ role: 'client', socket: mine });
    const bulk = session.open();
    bulk.write(Buffer.alloc(250_000, 3));
    await new Promise((r) => setTimeout(r, 20));
    const queuedAt = Date.now() - t0;
    theirs.send(pingFrame(false, 5), () => undefined); // the peer pings: the answer is a control frame
    await new Promise((r) => setTimeout(r, 1_500));
    const answer = frames.find((f) => f.type === FRAME_TYPE.ping);
    assert.ok(answer, 'the ping was answered');
    // 128 KiB buffered at 200 kB/s drains to 32 KiB in about 0.5 s; far less than the whole transfer (1.25 s)
    assert.ok(answer.at - queuedAt < 1_000, `answered after ${answer.at - queuedAt} ms`);
    session.destroy();
  });
});

describe('mux liveness (fake timers)', () => {
  test('both sides ping every 15 s; 45 s of silence ends the connection with 1011', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
    const [mine, theirs] = memoryPair();
    const sent: Buffer[] = [];
    theirs.onMessage((d) => sent.push(d)); // the peer never answers
    const closes: number[] = [];
    theirs.onClose((c) => closes.push(c));
    const infos: MuxCloseInfo[] = [];
    const session = new MuxSession({ role: 'server', socket: mine });
    session.onClose((i) => infos.push(i));
    t.mock.timers.tick(15_000);
    t.mock.timers.tick(15_000);
    assert.equal(sent.filter((b) => b[1] === FRAME_TYPE.ping).length, 2);
    assert.equal(session.closed, false);
    t.mock.timers.tick(15_000);
    assert.equal(session.closed, true, 'closed at 45 s of silence');
    assert.equal(infos[0]?.code, 1011);
    assert.equal(infos[0]?.reason, 'ping timeout');
    mock.timers.reset();
    void closes;
  });

  test('anything received counts as life: a busy link is not dead', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
    const [mine, theirs] = memoryPair();
    theirs.onMessage(() => undefined);
    const session = new MuxSession({ role: 'client', socket: mine });
    for (let i = 0; i < 6; i++) {
      t.mock.timers.tick(14_000);
      await Promise.resolve();
      theirs.send(pingFrame(false, i), () => undefined); // a ping from the peer, delivered on a microtask
      await Promise.resolve();
    }
    assert.equal(session.closed, false);
    session.destroy();
  });
});

describe('mux fuzz', () => {
  /** A small deterministic generator, so a failing seed can be replayed. */
  const lcg = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

  test('random frame sequences never crash; a violation always ends in GO_AWAY(1) and close 1002', async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = lcg(seed);
      const p = rawPeer('server');
      const state = { ids: [] as number[] };
      for (let i = 0; i < 40 && !p.session.closed; i++) {
        const r = rnd();
        let frame: Buffer;
        if (r < 0.3) {
          const id = 1 + 2 * Math.floor(rnd() * 12);
          state.ids.push(id);
          frame = dataFrame(id, FRAME_FLAG.syn, Buffer.alloc(Math.floor(rnd() * 100), 1));
        } else if (r < 0.55) frame = dataFrame(state.ids[Math.floor(rnd() * state.ids.length)] ?? 1, rnd() < 0.2 ? FRAME_FLAG.fin : 0, Buffer.alloc(Math.floor(rnd() * 3000), 2));
        else if (r < 0.7) frame = windowUpdateFrame(state.ids[Math.floor(rnd() * state.ids.length)] ?? 3, rnd() < 0.2 ? FRAME_FLAG.rst : 0, Math.floor(rnd() * 70_000));
        else if (r < 0.8) frame = pingFrame(rnd() < 0.5, Math.floor(rnd() * 1e9));
        else if (r < 0.85) frame = goAwayFrame(Math.floor(rnd() * 3));
        else {
          // raw noise of random length, sometimes starting like a frame
          frame = Buffer.from(Array.from({ length: Math.floor(rnd() * 30) }, () => Math.floor(rnd() * 256)));
          if (rnd() < 0.5 && frame.length) frame[0] = 0;
        }
        p.theirs.send(frame, () => undefined);
      }
      await waitFor(() => p.session.closed, 30);
      if (p.session.closed && p.closed[0]?.protocolError) await waitFor(() => p.closes.length > 0, 400);
      if (p.session.closed) {
        const info = p.closed[0]!;
        if (info.protocolError) {
          assert.equal(p.closes[0]?.code, 1002, `seed ${seed}`);
          assert.ok(p.received.some((b) => b[1] === FRAME_TYPE.goAway && b.readUInt32BE(8) === 1), `seed ${seed}: no GO_AWAY(1)`);
        }
      }
      p.session.destroy();
    }
  });
});
