// The tunnel's multiplexer (docs/prd/targets-connect.md §9.3): many streams over one connection, yamux's format (frame.ts), our own
// scheduling. One MuxSession per WebSocket, on both ends; the agent is the `client` (odd stream ids) and the portal the `server` (even).
//
//  - Fair and bounded: control frames (window updates, pings, FIN, RST, GO_AWAY) go first; DATA is drained round-robin over the streams
//    that have some, one frame each (at most 64 KiB), and frames are handed to the socket only while the bytes already given to it and not
//    yet written out are under `sendHighWater` (128 KiB); a stopped sender resumes under `sendLowWater` (32 KiB). A keystroke therefore
//    waits behind at most that much, never behind a whole transfer.
//  - Flow control per stream (stream.ts): 256 KiB windows, granted as the application reads.
//  - Liveness: both sides ping every 15 s; nothing received for 45 s ends the connection (close 1011). The round trip is `rttMs`.
//  - Violations (wrong version, unknown type, an id of the wrong parity or reused, a window overflow, an oversize frame, a stream that was
//    never opened) answer GO_AWAY(1), close 1002 and log a line without payload. Data for a stream that was closed or reset a moment ago
//    is dropped: it is a race with our own RST, not a violation (yamux does the same); data after the peer's FIN is answered with RST.
//  - SYN rides on a stream's first frame (the open request line) and ids reach the wire in order: if a later stream sends first, the
//    earlier ones' SYNs go out ahead of it as empty frames.
//
// Shared by the portal and the agent: only `node:*` and the contract are imported.

import { CONNECT_LIMITS, CONNECT_MUX } from '@portal/contracts';
import {
  FRAME_FLAG,
  FRAME_TYPE,
  FrameDecoder,
  ProtocolError,
  goAwayFrame,
  pingFrame,
  rstFrame,
  type Frame,
} from './frame.js';
import { MuxStream, StreamReset, type ControlKind, type StreamHost } from './stream.js';

export { MuxStream, StreamReset };

/** What the mux needs from a connection: a WebSocket in production (ws.ts), a memory pair in tests. */
export interface MuxSocket {
  /** Hand over one or more frames; `cb` fires when they were written out (or failed). */
  send(data: Buffer, cb: (error?: Error | null) => void): void;
  /** Bytes given to `send` that are not yet written out, as the connection itself counts them (ws: `bufferedAmount`). */
  readonly bufferedAmount: number;
  /** Starts the close handshake (the data sent before it is delivered first). */
  close(code: number, reason?: string): void;
  /** Drops the connection now. */
  terminate(): void;
  onMessage(fn: (data: Buffer, isBinary: boolean) => void): void;
  onClose(fn: (code: number, reason: string) => void): void;
  onError(fn: (error: Error) => void): void;
}

export interface MuxLimits {
  initialWindow: number;
  windowUpdateAt: number;
  maxFramePayload: number;
  maxStreams: number;
  sendHighWater: number;
  sendLowWater: number;
  pingEveryMs: number;
  deadAfterMs: number;
}

export const defaultMuxLimits = (): MuxLimits => ({
  initialWindow: CONNECT_LIMITS.initialWindow,
  windowUpdateAt: CONNECT_LIMITS.windowUpdateAt,
  maxFramePayload: CONNECT_LIMITS.maxFramePayload,
  maxStreams: CONNECT_LIMITS.maxStreams,
  sendHighWater: CONNECT_LIMITS.sendHighWater,
  sendLowWater: CONNECT_LIMITS.sendLowWater,
  pingEveryMs: CONNECT_LIMITS.pingEveryMs,
  deadAfterMs: CONNECT_LIMITS.deadAfterMs,
});

/** The session is closed or going away: no stream can be opened. */
export class MuxClosedError extends Error {
  override readonly name = 'MuxClosedError';
}

/** Too many streams are open (`maxStreams`). */
export class MuxLimitError extends Error {
  override readonly name = 'MuxLimitError';
}

export interface MuxOptions {
  role: 'client' | 'server';
  socket: MuxSocket;
  /** Called for each stream the peer opens (after the cap check). The first bytes it sent are already in the stream. */
  onStream?: (stream: MuxStream) => void;
  limits?: Partial<MuxLimits>;
  /** What the streams fail with when the session ends. The portal's hub passes a `ConnectError('agent_offline')`. */
  closeError?: (reason: string) => Error;
  /** One line per notable event (never payload bytes, keys or tokens). */
  log?: (line: string) => void;
}

export interface MuxCloseInfo {
  /** The WebSocket close code (ours when we closed it, the peer's otherwise); 1006 when the connection just broke. */
  code: number;
  reason: string;
  /** The peer broke the rules (or we did and closed with 1002). */
  protocolError: boolean;
  /** The peer ended it (a close frame, or silence), as opposed to us calling `close`/`destroy`. */
  remote: boolean;
  error: Error | null;
}

function remove<T>(list: T[], item: T): void {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
}

interface ControlItem {
  raw?: Buffer;
  stream?: MuxStream;
  kind?: ControlKind;
  value?: number;
}

export class MuxSession implements StreamHost {
  readonly role: 'client' | 'server';
  readonly limits: MuxLimits;
  readonly #socket: MuxSocket;
  readonly #onStream: ((s: MuxStream) => void) | undefined;
  readonly #closeError: (reason: string) => Error;
  readonly #log: (line: string) => void;
  readonly #decoder: FrameDecoder;
  readonly #streams = new Map<number, MuxStream>();
  readonly #control: ControlItem[] = [];
  readonly #ring: MuxStream[] = [];
  /** Streams this side opened whose SYN has not reached the wire, by id. */
  #unsynced: MuxStream[] = [];
  readonly #closeListeners: ((info: MuxCloseInfo) => void)[] = [];
  readonly #rttListeners: ((rttMs: number) => void)[] = [];
  readonly #pings = new Map<number, number>();
  #nextId: number;
  #lastLocalId = 0;
  #lastRemoteId = 0;
  #inflight = 0;
  #paused = false;
  #pumping = false;
  #closed = false;
  #goneAway = false;
  #remoteGoAway: number | null = null;
  #timer: NodeJS.Timeout | null = null;
  #lastReceived = Date.now();
  #pingSeq = 0;
  #rtt: number | null = null;
  #bytesIn = 0;
  #bytesOut = 0;
  #framesIn = 0;
  #framesOut = 0;

  constructor(opts: MuxOptions) {
    this.role = opts.role;
    this.limits = { ...defaultMuxLimits(), ...opts.limits };
    this.#socket = opts.socket;
    this.#onStream = opts.onStream;
    this.#closeError = opts.closeError ?? ((reason) => new StreamReset(`The tunnel ended: ${reason}`, 'ECONNABORTED'));
    this.#log = opts.log ?? (() => undefined);
    this.#decoder = new FrameDecoder(this.limits.maxFramePayload);
    this.#nextId = opts.role === 'client' ? 1 : 2;
    this.#socket.onMessage((data, isBinary) => this.#onMessage(data, isBinary));
    this.#socket.onClose((code, reason) => this.#shutdown({ code, reason, protocolError: false, remote: true, error: null }));
    this.#socket.onError((error) => {
      this.#log(`socket error: ${error.message}`);
      // ws follows an error with a close event; this covers sockets that do not
      this.#shutdown({ code: 1006, reason: 'socket error', protocolError: false, remote: true, error });
    });
    this.#timer = setInterval(() => this.#tick(), this.limits.pingEveryMs);
    this.#timer.unref();
  }

  // ---- public ----------------------------------------------------------------------------------------------------------------------

  get closed(): boolean {
    return this.#closed;
  }

  /** We sent GO_AWAY or the peer did: no new streams. */
  get goingAway(): boolean {
    return this.#goneAway || this.#remoteGoAway !== null;
  }

  /** The code of the peer's GO_AWAY, when it sent one. */
  get remoteGoAway(): number | null {
    return this.#remoteGoAway;
  }

  get openStreams(): number {
    return this.#streams.size;
  }

  /** The last measured round trip of a ping, in ms (null before the first answer). */
  get rttMs(): number | null {
    return this.#rtt;
  }

  /** When something was last received, ms since the epoch. */
  get lastReceivedAt(): number {
    return this.#lastReceived;
  }

  stats(): { bytesIn: number; bytesOut: number; framesIn: number; framesOut: number; streams: number } {
    return { bytesIn: this.#bytesIn, bytesOut: this.#bytesOut, framesIn: this.#framesIn, framesOut: this.#framesOut, streams: this.#streams.size };
  }

  onClose(fn: (info: MuxCloseInfo) => void): () => void {
    this.#closeListeners.push(fn);
    return () => remove(this.#closeListeners, fn);
  }

  onRtt(fn: (rttMs: number) => void): () => void {
    this.#rttListeners.push(fn);
    return () => remove(this.#rttListeners, fn);
  }

  /** Opens a stream. Its SYN goes out with the first thing written to it. Throws when the session is closed or going away. */
  open(): MuxStream {
    if (this.#closed) throw new MuxClosedError('The tunnel is closed.');
    if (this.goingAway) throw new MuxClosedError('The tunnel is closing.');
    if (this.#streams.size >= this.limits.maxStreams) throw new MuxLimitError(`${this.limits.maxStreams} streams are open.`);
    if (this.#nextId > 0xffff_fffd) throw new MuxClosedError('Out of stream ids: the tunnel must be re-made.');
    const id = this.#nextId;
    this.#nextId += 2;
    this.#lastLocalId = id;
    const s = new MuxStream(this, id, true);
    this.#streams.set(id, s);
    this.#unsynced.push(s);
    return s;
  }

  /** Tells the peer no more streams will be opened; the ones open finish. Code 0 is a normal leave. */
  goAway(code: number = CONNECT_MUX.goAway.normal): void {
    if (this.#closed || this.#goneAway) return;
    this.#goneAway = true;
    this.#control.push({ raw: goAwayFrame(code) });
    this.#pump();
  }

  /** Ends the connection: GO_AWAY, then the WebSocket close (the data already sent is delivered first). Streams fail now. */
  close(code = 1000, reason = ''): void {
    if (this.#closed) return;
    if (!this.#goneAway) {
      this.#goneAway = true;
      this.#write(goAwayFrame(CONNECT_MUX.goAway.normal));
    }
    try {
      this.#socket.close(code, reason);
    } catch {
      this.#socket.terminate();
    }
    this.#shutdown({ code, reason, protocolError: false, remote: false, error: null });
  }

  /** Drops the connection without a close handshake. */
  destroy(reason = 'destroyed'): void {
    if (this.#closed) return;
    this.#socket.terminate();
    this.#shutdown({ code: 1006, reason, protocolError: false, remote: false, error: null });
  }

  // ---- StreamHost ------------------------------------------------------------------------------------------------------------------

  wake(s: MuxStream): void {
    if (this.#closed) return;
    if (!s.inRing && s.hasData()) {
      s.inRing = true;
      this.#ring.push(s);
    }
    this.#pump();
  }

  control(s: MuxStream, kind: ControlKind, value = 0): void {
    if (this.#closed) return;
    this.#control.push({ stream: s, kind, value });
    this.#pump();
  }

  release(s: MuxStream): void {
    if (this.#streams.get(s.id) === s) this.#streams.delete(s.id);
    this.#synced(s);
  }

  violation(message: string): void {
    this.#protocolError(message);
  }

  // ---- receiving -------------------------------------------------------------------------------------------------------------------

  #onMessage(data: Buffer, isBinary: boolean): void {
    if (this.#closed) return;
    if (!isBinary) return this.#protocolError('a text message after the handshake');
    this.#lastReceived = Date.now();
    this.#bytesIn += data.length;
    let frames: Frame[];
    try {
      frames = this.#decoder.push(data);
    } catch (e) {
      return this.#protocolError(e instanceof ProtocolError ? e.message : 'unreadable frame');
    }
    for (const f of frames) {
      if (this.#closed) return;
      this.#framesIn++;
      this.#handle(f);
    }
  }

  #remoteParity(id: number): boolean {
    return id % 2 === (this.role === 'client' ? 0 : 1);
  }

  #handle(f: Frame): void {
    switch (f.type) {
      case FRAME_TYPE.ping:
        if (f.streamId !== 0) return this.#protocolError('a ping on a stream');
        if (f.flags & FRAME_FLAG.syn) {
          this.#control.push({ raw: pingFrame(true, f.length) });
          this.#pump();
        } else if (f.flags & FRAME_FLAG.ack) {
          const sentAt = this.#pings.get(f.length);
          if (sentAt !== undefined) {
            this.#pings.delete(f.length);
            this.#rtt = Math.max(0, Date.now() - sentAt);
            for (const fn of [...this.#rttListeners]) fn(this.#rtt);
          }
        }
        return;
      case FRAME_TYPE.goAway:
        if (f.streamId !== 0) return this.#protocolError('a go-away on a stream');
        this.#remoteGoAway = f.length;
        return;
      default:
        return this.#handleStreamFrame(f);
    }
  }

  #handleStreamFrame(f: Frame): void {
    const id = f.streamId;
    if (id === 0) return this.#protocolError('stream 0 carries no data');
    let s = this.#streams.get(id);
    if (f.flags & FRAME_FLAG.syn) {
      if (s) return this.#protocolError(`stream ${id} opened twice`);
      if (!this.#remoteParity(id)) return this.#protocolError(`stream id ${id} has the wrong parity`);
      if (id <= this.#lastRemoteId) return this.#protocolError(`stream id ${id} was used before`);
      this.#lastRemoteId = id;
      if (this.#goneAway || this.#streams.size >= this.limits.maxStreams) {
        this.#control.push({ raw: rstFrame(id) });
        this.#pump();
        return;
      }
      s = new MuxStream(this, id, false);
      this.#streams.set(id, s);
      this.#apply(s, f);
      if (!s.destroyed && this.#onStream) {
        try {
          this.#onStream(s);
        } catch (e) {
          this.#log(`stream handler failed: ${(e as Error).message}`);
          s.destroy();
        }
      } else if (!this.#onStream) {
        s.destroy();
      }
      return;
    }
    if (!s) {
      const known = this.#remoteParity(id) ? id <= this.#lastRemoteId : id <= this.#lastLocalId;
      if (!known) this.#protocolError(`stream ${id} was never opened`);
      return; // closed or reset a moment ago: what the peer sent meanwhile is dropped
    }
    this.#apply(s, f);
  }

  #apply(s: MuxStream, f: Frame): void {
    if (f.flags & FRAME_FLAG.rst) return s.onRst();
    if (f.type === FRAME_TYPE.data) {
      if (f.payload.length) s.onData(f.payload);
    } else if (f.length) s.onWindow(f.length);
    if (this.#closed) return;
    if (f.flags & FRAME_FLAG.fin) s.onFin();
  }

  // ---- sending ---------------------------------------------------------------------------------------------------------------------

  /** Bytes handed to the socket and not yet written out. */
  #buffered(): number {
    return Math.max(this.#inflight, this.#socket.bufferedAmount);
  }

  #pump(): void {
    if (this.#pumping || this.#closed) return;
    this.#pumping = true;
    try {
      for (;;) {
        if (this.#closed) return;
        if (this.#paused) {
          if (this.#buffered() >= this.limits.sendLowWater) return;
          this.#paused = false;
        }
        if (this.#buffered() >= this.limits.sendHighWater) {
          this.#paused = true;
          return;
        }
        const frame = this.#nextFrame();
        if (!frame) return;
        this.#write(frame);
      }
    } finally {
      this.#pumping = false;
    }
  }

  #nextFrame(): Buffer | null {
    while (this.#control.length) {
      const item = this.#control.shift()!;
      if (item.raw) return item.raw;
      const s = item.stream!;
      if (s.synPending && item.kind !== 'rst') this.#flushSyn(s);
      const frame = s.controlFrame(item.kind!, item.value);
      if (!s.synPending) this.#synced(s);
      if (frame) return frame;
    }
    while (this.#ring.length) {
      const s = this.#ring.shift()!;
      s.inRing = false;
      if (s.synPending) this.#flushSyn(s);
      const frame = s.dataFrame();
      if (!s.synPending) this.#synced(s);
      if (s.hasData()) {
        s.inRing = true;
        this.#ring.push(s);
      }
      if (frame) return frame;
    }
    return null;
  }

  /** `s` is about to send its SYN: the SYNs of the streams opened before it go first, as empty frames, so ids reach the wire in order. */
  #flushSyn(s: MuxStream): void {
    for (const lower of this.#unsynced.filter((x) => x.id < s.id)) {
      if (lower.synPending && !lower.destroyed) this.#write(lower.synFrame());
      this.#synced(lower);
    }
  }

  #synced(s: MuxStream): void {
    const i = this.#unsynced.indexOf(s);
    if (i >= 0) this.#unsynced.splice(i, 1);
  }

  #write(frame: Buffer): void {
    this.#inflight += frame.length;
    this.#bytesOut += frame.length;
    this.#framesOut++;
    try {
      this.#socket.send(frame, (error) => {
        this.#inflight -= frame.length;
        if (error) return this.#fail(error);
        this.#pump();
      });
    } catch (e) {
      this.#inflight -= frame.length;
      this.#fail(e instanceof Error ? e : new Error(String(e)));
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#log(`send failed: ${error.message}`);
    this.#socket.terminate();
    this.#shutdown({ code: 1006, reason: 'send failed', protocolError: false, remote: false, error });
  }

  // ---- liveness and the end --------------------------------------------------------------------------------------------------------

  #tick(): void {
    if (this.#closed) return;
    const now = Date.now();
    if (now - this.#lastReceived >= this.limits.deadAfterMs) {
      this.#log(`nothing received for ${Math.round((now - this.#lastReceived) / 1000)} s: closing`);
      try {
        this.#socket.close(1011, 'ping timeout');
      } catch {
        this.#socket.terminate();
      }
      this.#shutdown({ code: 1011, reason: 'ping timeout', protocolError: false, remote: true, error: null });
      return;
    }
    const value = ++this.#pingSeq >>> 0;
    this.#pings.set(value, now);
    if (this.#pings.size > 8) this.#pings.delete(this.#pings.keys().next().value as number);
    this.#control.push({ raw: pingFrame(false, value) });
    this.#pump();
  }

  #protocolError(message: string): void {
    if (this.#closed) return;
    this.#log(`protocol error: ${message}`);
    this.#write(goAwayFrame(CONNECT_MUX.goAway.protocol));
    try {
      this.#socket.close(1002, 'protocol error');
    } catch {
      this.#socket.terminate();
    }
    this.#shutdown({ code: 1002, reason: message, protocolError: true, remote: false, error: null });
  }

  #shutdown(info: MuxCloseInfo): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    const error = this.#closeError(info.reason || 'closed');
    const streams = [...this.#streams.values()];
    this.#streams.clear();
    this.#control.length = 0;
    this.#ring.length = 0;
    this.#unsynced = [];
    this.#pings.clear();
    for (const s of streams) s.abort(error);
    for (const fn of [...this.#closeListeners]) {
      try {
        fn(info);
      } catch (e) {
        this.#log(`close listener failed: ${(e as Error).message}`);
      }
    }
  }
}
