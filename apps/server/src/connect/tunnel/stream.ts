// One stream of the tunnel (docs/prd/targets-connect.md §9.3): a Duplex that looks enough like a connected socket for Node's HTTP client
// and server to run over it (the `net.Socket` methods an http.Agent calls on a pooled connection are there: setKeepAlive, setNoDelay,
// setTimeout, ref, unref; P1's spike proved dockerode and `http.Server` work on that shape).
//
// The session (mux.ts) owns the wire. A stream queues what the application writes and the session's scheduler asks it for one frame at a
// time, so many streams share the connection round-robin and a keystroke never waits behind a bulk transfer. Flow control is the yamux
// kind: each direction has a window (256 KiB), the sender never exceeds what the peer granted, and the receiver grants more as the
// APPLICATION reads (not as bytes arrive), so a reader that stops reading stops the sender. A write's callback fires when its last byte
// has been handed to the socket, which is what gives `write()` its backpressure.
//
// A stream the application does not read from is never finished (Node's own rule for sockets): call `resume()` on one you only write to.
//
// Shared by the portal and the agent: only `node:*` and the contract are imported.

import { Duplex } from 'node:stream';
import { FRAME_FLAG, dataFrame, finFrame, rstFrame, windowUpdateFrame } from './frame.js';

const noop = () => undefined;

export type ControlKind = 'window' | 'fin' | 'rst';

/** What a stream needs from its session. */
export interface StreamHost {
  readonly limits: { initialWindow: number; windowUpdateAt: number; maxFramePayload: number };
  /** The stream has data to send, or got window while it had some: put it in the scheduler. */
  wake(s: MuxStream): void;
  /** A control frame for `s`, built when it goes out (so SYN and ACK ride on the first frame the stream really sends). */
  control(s: MuxStream, kind: ControlKind, value?: number): void;
  /** Finished at the protocol level (both sides sent FIN, or it was reset): forget its id. */
  release(s: MuxStream): void;
  /** The peer broke the rules: the session answers GO_AWAY and closes. */
  violation(message: string): void;
}

interface Chunk {
  data: Buffer;
  offset: number;
  cb: (error?: Error | null) => void;
}

/** The stream ended because the peer reset it (RST) or the session went away; `code` tells which. */
export class StreamReset extends Error {
  override readonly name = 'StreamReset';
  constructor(
    message: string,
    readonly code: 'ECONNRESET' | 'ECONNABORTED' = 'ECONNRESET',
  ) {
    super(message);
  }
}

export class MuxStream extends Duplex {
  readonly id: number;
  /** In the session's round-robin ring (maintained by the session). */
  inRing = false;
  /** The next frame this stream sends carries SYN (it opened) or ACK (it accepted). */
  synPending: boolean;
  ackPending: boolean;
  /** Its SYN reached the wire, so the peer knows the stream (an RST for one it doesn't know would be a protocol error there). */
  synSent: boolean;
  /** Placeholders so code that reads a socket's addresses (HTTP servers, logs) finds something: the tunnel has no network address. */
  readonly remoteAddress = '127.0.0.1';
  readonly remotePort = 1;
  readonly localAddress = '127.0.0.1';
  readonly localPort = 2;

  readonly #host: StreamHost;
  #queue: Chunk[] = [];
  #sendWindow: number;
  #finQueued = false;
  #finSent = false;
  #finCb: ((error?: Error | null) => void) | null = null;
  #inbox: Buffer[] = [];
  /** Node's `_read` asked for more and `push` has not said "enough" since: only then is the inbox handed over (that is the backpressure). */
  #wantMore = true;
  #recvWindow: number;
  #credit = 0;
  #remoteFin = false;
  #readEnded = false;
  #rstReceived = false;
  #gone = false;
  #released = false;
  #idleMs = 0;
  #idle: NodeJS.Timeout | null = null;

  constructor(host: StreamHost, id: number, opened: boolean) {
    super({ allowHalfOpen: true, readableHighWaterMark: 65_536, writableHighWaterMark: 65_536 });
    this.#host = host;
    this.id = id;
    this.#sendWindow = host.limits.initialWindow;
    this.#recvWindow = host.limits.initialWindow;
    this.synPending = opened;
    this.ackPending = !opened;
    this.synSent = !opened;
    // A peer's RST, or the tunnel ending, fails every stream: normal events of a link that drops. An `error` nobody listens to would be an
    // uncaught exception, so there is always a listener; whoever uses the stream adds its own to react.
    this.on('error', noop);
  }

  /** Both directions finished: nothing more will cross the wire for this stream. */
  get protocolClosed(): boolean {
    return this.#finSent && this.#remoteFin;
  }

  /** The peer's RST ended it. */
  get reset(): boolean {
    return this.#rstReceived;
  }

  /** Bytes the application wrote that are not yet on the wire. */
  get queuedBytes(): number {
    let n = 0;
    for (const c of this.#queue) n += c.data.length - c.offset;
    return n;
  }

  // ---- net.Socket stubs ------------------------------------------------------------------------------------------------------------

  setKeepAlive(_enable?: boolean, _ms?: number): this {
    return this;
  }

  setNoDelay(_on?: boolean): this {
    return this;
  }

  /** An idle timeout like a socket's: `timeout` is emitted after `ms` without data either way (0 turns it off). */
  setTimeout(ms: number, cb?: () => void): this {
    if (cb) this.once('timeout', cb);
    this.#idleMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
    this.#touch();
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  #touch() {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    if (!this.#idleMs || this.destroyed) return;
    this.#idle = setTimeout(() => {
      this.#idle = null;
      this.emit('timeout');
    }, this.#idleMs);
    this.#idle.unref();
  }

  // ---- Duplex ----------------------------------------------------------------------------------------------------------------------

  override _read(): void {
    this.#wantMore = true;
    this.#deliver();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, cb: (error?: Error | null) => void): void {
    if (!chunk.length) return cb();
    this.#touch();
    this.#queue.push({ data: chunk, offset: 0, cb });
    this.#host.wake(this);
  }

  /** Writes that piled up while one was on its way arrive together and share frames. Only the last one's callback matters. */
  override _writev(chunks: { chunk: Buffer; encoding: BufferEncoding }[], cb: (error?: Error | null) => void): void {
    this.#touch();
    for (const { chunk } of chunks) if (chunk.length) this.#queue.push({ data: chunk, offset: 0, cb: noop });
    const tail = this.#queue.at(-1);
    if (!tail) return cb();
    tail.cb = cb;
    this.#host.wake(this);
  }

  /** The end of the writable side: the FIN goes out after the data, and `finish` waits until it has. */
  override _final(cb: (error?: Error | null) => void): void {
    this.#finQueued = true;
    this.#finCb = cb;
    if (this.#queue.length === 0) this.#host.control(this, 'fin');
  }

  override _destroy(error: Error | null, cb: (error?: Error | null) => void): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    const why = error ?? new StreamReset('The stream was closed.', 'ECONNABORTED');
    for (const c of this.#queue.splice(0)) c.cb(why);
    this.#queue = [];
    const fin = this.#finCb;
    this.#finCb = null;
    fin?.(why);
    this.#inbox = [];
    if (!this.protocolClosed && !this.#rstReceived && !this.#gone && this.synSent) this.#host.control(this, 'rst');
    this.#release();
    cb(error);
  }

  // ---- what the session calls ------------------------------------------------------------------------------------------------------

  /** The scheduler has room: the stream has data it may send now. */
  hasData(): boolean {
    return !this.destroyed && this.#queue.length > 0 && this.#sendWindow > 0;
  }

  /** Flags for the next frame this stream sends: SYN on its first (it opened), ACK on its first (it accepted). */
  #flags(extra = 0): number {
    let f = extra;
    if (this.synPending) {
      f |= FRAME_FLAG.syn;
      this.synPending = false;
      this.synSent = true;
    }
    if (this.ackPending) {
      f |= FRAME_FLAG.ack;
      this.ackPending = false;
    }
    return f;
  }

  /** A zero-length frame that carries only the SYN: sent when a later stream's SYN is about to go first (ids must reach the wire in order). */
  synFrame(): Buffer {
    return dataFrame(this.id, this.#flags());
  }

  /** The next DATA frame, carved from what was written (several small writes share one frame), or null. */
  dataFrame(): Buffer | null {
    if (!this.hasData()) return null;
    const room = Math.min(this.#host.limits.maxFramePayload, this.#sendWindow);
    const parts: Buffer[] = [];
    const done: Chunk[] = [];
    let taken = 0;
    while (taken < room && this.#queue.length) {
      const head = this.#queue[0]!;
      const n = Math.min(room - taken, head.data.length - head.offset);
      parts.push(head.data.subarray(head.offset, head.offset + n));
      head.offset += n;
      taken += n;
      if (head.offset === head.data.length) done.push(this.#queue.shift()!);
    }
    this.#sendWindow -= taken;
    const frame = dataFrame(this.id, this.#flags(), parts);
    this.#touch();
    if (done.length) process.nextTick(() => done.forEach((c) => !this.destroyed && c.cb()));
    if (this.#queue.length === 0 && this.#finQueued && !this.#finSent) this.#host.control(this, 'fin');
    return frame;
  }

  /** A control frame this stream queued, built now; null when it no longer applies. */
  controlFrame(kind: ControlKind, value = 0): Buffer | null {
    if (kind === 'window') {
      if (this.destroyed || this.#remoteFin) return null;
      return windowUpdateFrame(this.id, this.#flags(), value);
    }
    if (kind === 'fin') {
      if (this.#finSent || this.destroyed) return null;
      this.#finSent = true;
      const frame = finFrame(this.id, this.#flags());
      const cb = this.#finCb;
      this.#finCb = null;
      if (cb) process.nextTick(() => cb());
      if (this.protocolClosed) this.#release();
      return frame;
    }
    // rst: a stream whose SYN never went out is unknown to the peer, and an RST for an unknown stream would be a protocol error there
    return this.synSent ? rstFrame(this.id) : null;
  }

  /** The peer's DATA frame. A payload past the window is a protocol error (the session closes). */
  onData(payload: Buffer): void {
    if (this.destroyed) return;
    if (this.#remoteFin) return void this.destroy(new StreamReset('The other end sent data after closing its side.')); // the RST goes out from _destroy
    if (payload.length > this.#recvWindow) return this.#host.violation(`stream ${this.id} sent past its window`);
    this.#recvWindow -= payload.length;
    this.#touch();
    this.#inbox.push(payload);
    this.#deliver();
  }

  /** The peer granted `delta` more bytes. */
  onWindow(delta: number): void {
    if (this.destroyed) return;
    this.#sendWindow += delta;
    if (this.#sendWindow > this.#host.limits.initialWindow) return this.#host.violation(`stream ${this.id} window overflow`);
    if (this.#queue.length) this.#host.wake(this);
  }

  /** The peer sent FIN: no more data from it. Data after this gets an RST. */
  onFin(): void {
    if (this.#remoteFin) return;
    this.#remoteFin = true;
    this.#deliver();
    if (this.protocolClosed) this.#release();
  }

  /** The peer reset the stream: what was queued is gone and the stream fails with ECONNRESET. */
  onRst(): void {
    if (this.destroyed) return;
    this.#rstReceived = true;
    this.destroy(new StreamReset('The stream was reset by the other end.'));
  }

  /** The session ended: fail with `error`, without an RST (there is no wire left). */
  abort(error: Error): void {
    this.#gone = true;
    if (!this.destroyed) this.destroy(error);
    else this.#release();
  }

  /** The application read some: hand it what arrived, and grant the sender more window once enough was consumed. */
  #deliver(): void {
    if (this.destroyed || this.#readEnded) return;
    while (this.#wantMore && this.#inbox.length) {
      const chunk = this.#inbox.shift()!;
      this.#credit += chunk.length;
      if (!this.push(chunk)) this.#wantMore = false;
    }
    if (this.#credit >= this.#host.limits.windowUpdateAt && !this.#remoteFin) {
      const delta = this.#credit;
      this.#credit = 0;
      this.#recvWindow += delta;
      this.#host.control(this, 'window', delta);
    }
    if (this.#remoteFin && this.#inbox.length === 0 && !this.#readEnded) {
      this.#readEnded = true;
      this.push(null);
    }
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#host.release(this);
  }
}
