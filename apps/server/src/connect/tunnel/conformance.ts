// The mux conformance suite (docs/prd/targets-connect.md §19.3 T-MUX). Both ends of the tunnel are written against the same library, and each
// runs this one suite over its own way of making a connected pair of sessions: the portal over a memory pair and a real `ws` pair on
// loopback (mux.test.ts), the agent over the sessions its client makes (`dialTunnel` against an in-test hub). A behaviour added to the mux
// belongs here, so every user of the library is held to it.
//
// Test support: imported by test files only (it imports `node:test`), never by the portal's or the agent's runtime code.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { MuxClosedError, MuxLimitError, type MuxLimits, type MuxSession, type MuxStream } from './mux.js';

/** Where the sessions put the streams the peer opens. */
export interface PairHandlers {
  onClientStream(stream: MuxStream): void;
  onServerStream(stream: MuxStream): void;
}

/** A connected pair: `client` is the agent's role (odd stream ids), `server` the portal's (even). */
export interface SessionPair {
  client: MuxSession;
  server: MuxSession;
  close(): Promise<void> | void;
}

export interface PairOptions {
  client?: Partial<MuxLimits>;
  server?: Partial<MuxLimits>;
  closeError?: (reason: string) => Error;
}

export type MakeSessionPair = (handlers: PairHandlers, options?: PairOptions) => SessionPair | Promise<SessionPair>;

export interface ConformanceOptions {
  /** The worst round trip (95th percentile) a one-byte echo may take while four bulk transfers run. Depends on the link. */
  echoBudgetMs?: number;
}

class Queue<T> {
  #items: T[] = [];
  #waiting: ((v: T) => void)[] = [];
  push(v: T): void {
    const w = this.#waiting.shift();
    if (w) w(v);
    else this.#items.push(v);
  }
  next(): Promise<T> {
    const v = this.#items.shift();
    return v !== undefined ? Promise.resolve(v) : new Promise((resolve) => this.#waiting.push(resolve));
  }
}

const noop = () => undefined;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exactly `n` bytes from a stream (waiting for them), or an error when it ends first. */
function readExactly(s: Readable, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      s.off('readable', attempt);
      s.off('end', attempt);
      s.off('error', onError);
      s.off('close', attempt);
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    function attempt() {
      const b = s.read(n) as Buffer | null;
      if (b) {
        cleanup();
        resolve(b);
      } else if (s.readableEnded || s.destroyed) {
        cleanup();
        reject(new Error(`the stream ended before ${n} bytes arrived`));
      }
    }
    s.on('readable', attempt);
    s.once('end', attempt);
    s.once('close', attempt);
    s.once('error', onError);
    attempt();
  });
}

/** Resolves when the stream wants more, or when it is gone (a destroyed stream never drains). */
const drained = (s: MuxStream): Promise<void> =>
  new Promise((resolve) => {
    const done = () => {
      s.off('drain', done);
      s.off('close', done);
      resolve();
    };
    s.once('drain', done);
    s.once('close', done);
  });

/** Writes `data` in pieces, honouring backpressure. */
async function writeAll(s: MuxStream, data: Buffer, piece = 100_000): Promise<void> {
  for (let at = 0; at < data.length; at += piece) {
    if (!s.write(data.subarray(at, at + piece))) await drained(s);
    if (s.destroyed) return;
  }
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function runMuxConformance(label: string, make: MakeSessionPair, conf: ConformanceOptions = {}): void {
  const echoBudgetMs = conf.echoBudgetMs ?? 250;
  const open = async (options?: PairOptions) => {
    const client = new Queue<MuxStream>();
    const server = new Queue<MuxStream>();
    // A session that ends fails its streams with an error, and an error nobody listens to ends the test run: every stream gets a listener.
    const p = await make(
      {
        onClientStream: (s) => (s.on('error', noop), client.push(s)),
        onServerStream: (s) => (s.on('error', noop), server.push(s)),
      },
      options,
    );
    const openClient = () => p.client.open().on('error', noop);
    const openServer = () => p.server.open().on('error', noop);
    return { ...p, accepted: { client, server }, openClient, openServer };
  };

  describe(`mux conformance: ${label}`, { timeout: 120_000 }, () => {
    test('moves bytes both ways, and each side opens its own parity of ids', async () => {
      const p = await open();
      try {
        const a = p.openClient();
        assert.equal(a.id % 2, 1);
        a.write('hello');
        const b = await p.accepted.server.next();
        assert.equal(b.id, a.id);
        assert.equal((await readExactly(b, 5)).toString(), 'hello');
        b.write('world!');
        assert.equal((await readExactly(a, 6)).toString(), 'world!');
        const c = p.openServer();
        assert.equal(c.id % 2, 0);
        c.write('from portal');
        const d = await p.accepted.client.next();
        assert.equal((await readExactly(d, 11)).toString(), 'from portal');
        a.destroy();
        c.destroy();
      } finally {
        await p.close();
      }
    });

    test('FIN ends one direction only, and a stream is closed once both ended', async () => {
      const p = await open();
      try {
        const a = p.openClient();
        a.write('request');
        a.end();
        a.resume();
        const b = await p.accepted.server.next();
        assert.equal((await readExactly(b, 7)).toString(), 'request');
        b.resume();
        await once(b, 'end'); // a's side ended
        b.write('response'); // b may still write
        b.end();
        b.resume();
        await Promise.all([once(a, 'close'), once(b, 'close')]);
        assert.equal(p.client.openStreams, 0);
        assert.equal(p.server.openStreams, 0);
      } finally {
        await p.close();
      }
    });

    test('a stream may be opened and ended without writing anything', async () => {
      const p = await open();
      try {
        const a = p.openClient();
        a.end();
        a.resume();
        const b = await p.accepted.server.next();
        b.resume();
        await once(b, 'end');
        b.end();
        await once(a, 'close');
      } finally {
        await p.close();
      }
    });

    test('RST ends a stream at once and discards what was queued; the session carries on', async () => {
      const p = await open();
      try {
        const a = p.openClient();
        a.on('error', () => undefined);
        a.write(randomBytes(2_000_000));
        const b = await p.accepted.server.next();
        const failure = new Promise<Error>((resolve) => b.once('error', resolve));
        a.destroy();
        const e = (await failure) as Error & { code?: string };
        assert.equal(e.code, 'ECONNRESET');
        // another stream still works
        const x = p.openClient();
        x.write('ok');
        const y = await p.accepted.server.next();
        y.on('error', () => undefined);
        assert.equal((await readExactly(y, 2)).toString(), 'ok');
        x.destroy();
      } finally {
        await p.close();
      }
    });

    test('a reader that stops reading stops the sender at the window, and no byte is lost when it reads again', async () => {
      const limits = { initialWindow: 32_768, windowUpdateAt: 16_384, maxFramePayload: 8_192 };
      const p = await open({ client: limits, server: limits });
      try {
        const data = randomBytes(1_000_000);
        const a = p.openClient();
        const written = writeAll(a, data, 50_000);
        const b = await p.accepted.server.next(); // nobody reads b yet
        await sleep(250);
        assert.ok(p.server.stats().bytesIn < 300_000, `the sender pushed ${p.server.stats().bytesIn} bytes at a reader that was not reading`);
        const got = readExactly(b, data.length);
        await written;
        assert.equal(sha(await got), sha(data));
        a.destroy();
      } finally {
        await p.close();
      }
    });

    test('bulk both ways at once does not deadlock and arrives intact', async () => {
      const p = await open();
      try {
        const up = randomBytes(4_000_000);
        const down = randomBytes(4_000_000);
        const a = p.openClient();
        a.write(Buffer.alloc(1)); // the SYN
        const b = await p.accepted.server.next();
        await readExactly(b, 1);
        const results = await Promise.all([
          writeAll(a, up),
          writeAll(b, down),
          readExactly(b, up.length),
          readExactly(a, down.length),
        ]);
        assert.equal(sha(results[2] as Buffer), sha(up));
        assert.equal(sha(results[3] as Buffer), sha(down));
        a.destroy();
        b.destroy();
      } finally {
        await p.close();
      }
    });

    test('a one-byte echo stays quick under four bulk transfers (fair scheduling)', async () => {
      const p = await open();
      try {
        const bulk: MuxStream[] = [];
        for (let i = 0; i < 4; i++) {
          const s = p.openClient();
          s.on('error', () => undefined);
          s.write(Buffer.alloc(1));
          const r = await p.accepted.server.next();
          r.on('error', () => undefined);
          r.resume(); // the receiver drains
          bulk.push(s);
        }
        const echoC = p.openClient();
        echoC.write(Buffer.alloc(1));
        const echoS = await p.accepted.server.next();
        await readExactly(echoS, 1);
        echoS.on('data', (d: Buffer) => echoS.write(d)); // echo
        const stop = { v: false };
        const chunk = Buffer.alloc(65_536, 9);
        const pumps = bulk.map(async (s) => {
          while (!stop.v && !s.destroyed) if (!s.write(chunk)) await drained(s);
        });
        await sleep(100); // let the transfers fill the pipe
        const times: number[] = [];
        for (let i = 0; i < 40; i++) {
          const t0 = performance.now();
          echoC.write(Buffer.from([i]));
          await readExactly(echoC, 1);
          times.push(performance.now() - t0);
          await sleep(5);
        }
        stop.v = true;
        bulk.forEach((s) => s.destroy());
        echoC.destroy();
        await Promise.allSettled(pumps);
        times.sort((x, y) => x - y);
        const p95 = times[Math.floor(times.length * 0.95)]!;
        assert.ok(p95 <= echoBudgetMs, `95th percentile of the echo was ${p95.toFixed(1)} ms (budget ${echoBudgetMs} ms)`);
      } finally {
        await p.close();
      }
    });

    test('many small writes arrive in order', async () => {
      const p = await open();
      try {
        const a = p.openClient();
        const n = 5_000;
        for (let i = 0; i < n; i++) {
          const b4 = Buffer.alloc(4);
          b4.writeUInt32BE(i);
          a.write(b4);
        }
        const b = await p.accepted.server.next();
        const all = await readExactly(b, n * 4);
        for (let i = 0; i < n; i++) assert.equal(all.readUInt32BE(i * 4), i);
        a.destroy();
      } finally {
        await p.close();
      }
    });

    test('ids reach the wire in order even when a later stream writes first', async () => {
      const p = await open();
      try {
        const s1 = p.openClient();
        const s2 = p.openClient();
        const s3 = p.openClient();
        s3.write('three');
        s2.write('two');
        s1.write('one');
        const got = [await p.accepted.server.next(), await p.accepted.server.next(), await p.accepted.server.next()];
        const byId = new Map(got.map((s) => [s.id, s]));
        assert.equal((await readExactly(byId.get(s1.id)!, 3)).toString(), 'one');
        assert.equal((await readExactly(byId.get(s2.id)!, 3)).toString(), 'two');
        assert.equal((await readExactly(byId.get(s3.id)!, 5)).toString(), 'three');
        [s1, s2, s3].forEach((s) => s.destroy());
      } finally {
        await p.close();
      }
    });

    test('a SYN beyond the acceptor’s stream cap is answered with RST, and the opener’s own cap is enforced', async () => {
      const p = await open({ client: { maxStreams: 6 }, server: { maxStreams: 3 } });
      try {
        const opened: MuxStream[] = [];
        for (let i = 0; i < 3; i++) {
          const s = p.openClient();
          s.write('x');
          opened.push(s);
          await p.accepted.server.next();
        }
        const over = p.openClient();
        const failed = new Promise<Error>((resolve) => over.once('error', resolve));
        over.write('x');
        assert.equal(((await failed) as Error & { code?: string }).code, 'ECONNRESET');
        const more = [p.openClient(), p.openClient(), p.openClient()];
        assert.throws(() => p.client.open(), MuxLimitError);
        [...opened, ...more].forEach((s) => s.destroy());
      } finally {
        await p.close();
      }
    });

    test('GO_AWAY stops new streams on both sides and lets the open ones finish', async () => {
      const p = await open();
      try {
        const a = p.openClient();
        a.write('a');
        const b = await p.accepted.server.next();
        p.server.goAway();
        assert.throws(() => p.server.open(), MuxClosedError);
        await sleep(100);
        assert.equal(p.client.remoteGoAway, 0);
        assert.throws(() => p.client.open(), MuxClosedError);
        b.write('still here');
        assert.equal((await readExactly(a, 10)).toString(), 'still here');
        a.destroy();
      } finally {
        await p.close();
      }
    });

    test('pings measure the round trip', async () => {
      const limits = { pingEveryMs: 30, deadAfterMs: 5_000 };
      const p = await open({ client: limits, server: limits });
      try {
        await sleep(200);
        assert.ok(p.client.rttMs !== null && p.client.rttMs >= 0 && p.client.rttMs < 1_000);
        assert.ok(p.server.rttMs !== null);
      } finally {
        await p.close();
      }
    });

    test('closing the session fails every stream with the close error, and the peer sees the close', async () => {
      const p = await open({ closeError: (reason) => Object.assign(new Error(`gone: ${reason}`), { code: 'GONE' }) });
      try {
        const a = p.openClient();
        a.write('x');
        const b = await p.accepted.server.next();
        const bClosed = new Promise<unknown>((resolve) => b.once('error', resolve));
        const aClosed = new Promise<unknown>((resolve) => a.once('error', resolve));
        const serverClosed = new Promise<void>((resolve) => p.server.onClose(() => resolve()));
        p.client.close(1000, 'bye');
        const [ea, eb] = (await Promise.all([aClosed, bClosed, serverClosed])) as unknown as [Error & { code?: string }, Error & { code?: string }];
        assert.equal(ea.code, 'GONE');
        assert.equal(eb.code, 'GONE');
        assert.throws(() => p.client.open(), MuxClosedError);
        assert.equal(p.server.closed, true);
      } finally {
        await p.close();
      }
    });
  });
}
