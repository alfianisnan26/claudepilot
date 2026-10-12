// An in-memory pair of MuxSockets for tests (docs/prd/targets-connect.md §19.3 T-MUX): ordered like a WebSocket, with a per-message delay that
// can be random, and a link speed so that `bufferedAmount` behaves like a real socket's (bytes given to `send` count until they have
// "left"). The conformance suite runs over it and over a real `ws` pair on loopback; the agent's tests use it too.
//
// Test support: nothing in the portal or the agent imports this file.

import type { MuxSocket } from './mux.js';

export interface MemoryPairOptions {
  /** One-way delay in ms: a number, or `[min, max]` drawn per message (delivery stays in order). Default 0. */
  delayMs?: number | [number, number];
  /** Link speed in bytes per second; 0 or absent is unlimited. A message takes `size / bytesPerSec` to leave. */
  bytesPerSec?: number;
  /** Seed of the random delays, so a failing run can be repeated. */
  seed?: number;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One ordered queue of timed events for a pair, run from a single timer: independent timers of unequal delays can fire out of order. */
class Clock {
  #events: { at: number; seq: number; fn: () => void }[] = [];
  #seq = 0;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  at(at: number, fn: () => void): void {
    if (this.#stopped) return;
    const e = { at, seq: this.#seq++, fn };
    let i = this.#events.length;
    while (i > 0 && this.#events[i - 1]!.at > at) i--;
    this.#events.splice(i, 0, e);
    this.#arm();
  }

  stop(): void {
    this.#stopped = true;
    this.#events = [];
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #arm(): void {
    if (this.#timer || !this.#events.length || this.#stopped) return;
    const wait = Math.max(0, this.#events[0]!.at - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const now = Date.now();
      while (this.#events.length && this.#events[0]!.at <= now && !this.#stopped) this.#events.shift()!.fn();
      this.#arm();
    }, wait);
  }
}

class Direction {
  /** When the last message finishes leaving the sender, and when the last one arrives (arrivals stay in order). */
  leaveAt = 0;
  arriveAt = 0;
  buffered = 0;
}

export class MemorySocket implements MuxSocket {
  peer!: MemorySocket;
  #messageFns: ((data: Buffer, isBinary: boolean) => void)[] = [];
  #closeFns: ((code: number, reason: string) => void)[] = [];
  #errorFns: ((error: Error) => void)[] = [];
  #closed = false;
  /** `close` was called: sends are refused from now on, while what was sent before is still delivered. */
  #closing = false;
  /** Messages sent to the peer are counted here (a test may look). */
  sent = 0;
  sentBytes = 0;

  constructor(
    private readonly out: Direction,
    private readonly opts: Required<Pick<MemoryPairOptions, 'bytesPerSec'>> & { delay: () => number },
    private readonly clock: Clock,
  ) {}

  get bufferedAmount(): number {
    return this.out.buffered;
  }

  /** Whether `close` or `terminate` ran on either end. */
  get isClosed(): boolean {
    return this.#closed;
  }

  send(data: Buffer, cb: (error?: Error | null) => void): void {
    if (this.#closed || this.#closing) return void queueMicrotask(() => cb(new Error(`WebSocket is not open: readyState ${this.#closed ? 3 : 2}`)));
    this.sent++;
    this.sentBytes += data.length;
    const now = Date.now();
    const { out, opts } = this;
    out.buffered += data.length;
    const leaveAt = Math.max(out.leaveAt, now) + (opts.bytesPerSec ? (data.length / opts.bytesPerSec) * 1000 : 0);
    out.leaveAt = leaveAt;
    const arriveAt = Math.max(out.arriveAt, leaveAt + opts.delay());
    out.arriveAt = arriveAt;
    const copy = Buffer.from(data);
    this.clock.at(leaveAt, () => {
      out.buffered -= data.length;
      cb();
    });
    this.clock.at(arriveAt, () => this.peer.#deliver(copy));
  }

  #deliver(data: Buffer): void {
    if (this.#closed) return;
    for (const fn of this.#messageFns) fn(data, true);
  }

  /** A text message, as a handshake would send it (tests of the handshake's error paths). */
  sendText(text: string): void {
    const at = Math.max(this.out.arriveAt, Date.now() + this.opts.delay());
    this.out.arriveAt = at;
    this.clock.at(at, () => this.peer.#deliverText(text));
  }

  #deliverText(text: string): void {
    if (this.#closed) return;
    for (const fn of this.#messageFns) fn(Buffer.from(text), false);
  }

  close(code: number, reason = ''): void {
    if (this.#closed || this.#closing) return;
    this.#closing = true;
    // what was sent before the close is delivered first, then both ends see the close
    this.clock.at(Math.max(this.out.arriveAt, Date.now()), () => {
      this.#end(code, reason);
      this.peer.#end(code, reason);
    });
  }

  terminate(): void {
    this.#end(1006, '');
    this.peer.#end(1006, '');
  }

  #end(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.clock.stop();
    queueMicrotask(() => this.#closeFns.forEach((fn) => fn(code, reason)));
  }

  onMessage(fn: (data: Buffer, isBinary: boolean) => void): void {
    this.#messageFns.push(fn);
  }

  onClose(fn: (code: number, reason: string) => void): void {
    this.#closeFns.push(fn);
  }

  onError(fn: (error: Error) => void): void {
    this.#errorFns.push(fn);
  }

  /** Raises an error on this end, as a broken socket would. */
  fail(error: Error): void {
    this.#errorFns.forEach((fn) => fn(error));
  }
}

/** Two connected sockets: what one sends the other receives, in order. */
export function memoryPair(opts: MemoryPairOptions = {}): [MemorySocket, MemorySocket] {
  const random = rng(opts.seed ?? 1);
  const delay = (): number => {
    const d = opts.delayMs ?? 0;
    return Array.isArray(d) ? d[0] + random() * (d[1] - d[0]) : d;
  };
  const config = { bytesPerSec: opts.bytesPerSec ?? 0, delay };
  const clock = new Clock();
  const a = new MemorySocket(new Direction(), config, clock);
  const b = new MemorySocket(new Direction(), config, clock);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
