// The tunnel's frame codec (docs/prd/targets-connect.md §9.3): yamux's wire format, a 12-byte big-endian header
//   [version u8 = 0][type u8][flags u16][stream id u32][length u32]
// followed, for DATA only, by `length` payload bytes. For the other types `length` is a value: a window delta, a ping value or a
// GO_AWAY code. The vectors in `CONNECT_TEST_VECTORS.frames` fix the bytes; frame.test.ts checks them.
//
// Shared by the portal and the agent (the agent bundle includes this file): only `node:*` and the contract are imported.

import { CONNECT_LIMITS, CONNECT_MUX } from '@portal/contracts';

export const FRAME_TYPE = CONNECT_MUX.type;
export const FRAME_FLAG = CONNECT_MUX.flag;
export const HEADER_BYTES = CONNECT_LIMITS.frameHeader;

/** A violation of the wire rules: the session answers GO_AWAY(1), closes with 1002 and logs `message` (never payload bytes). */
export class ProtocolError extends Error {
  override readonly name = 'ProtocolError';
}

export interface FrameHeader {
  type: number;
  flags: number;
  streamId: number;
  /** DATA: the payload's length. WINDOW_UPDATE: the delta. PING: the opaque value. GO_AWAY: the code. */
  length: number;
}

export interface Frame extends FrameHeader {
  /** The DATA payload (empty for every other type). */
  payload: Buffer;
}

const EMPTY = Buffer.alloc(0);

export function encodeHeader(h: FrameHeader): Buffer {
  const b = Buffer.allocUnsafe(HEADER_BYTES);
  writeHeader(b, 0, h);
  return b;
}

function writeHeader(b: Buffer, at: number, h: FrameHeader) {
  b[at] = CONNECT_MUX.version;
  b[at + 1] = h.type;
  b.writeUInt16BE(h.flags, at + 2);
  b.writeUInt32BE(h.streamId, at + 4);
  b.writeUInt32BE(h.length, at + 8);
}

/** DATA frame, header and payload in one allocation (one WebSocket message carries one frame). */
export function dataFrame(streamId: number, flags: number, payload: Buffer | readonly Buffer[] = EMPTY): Buffer {
  const parts = Buffer.isBuffer(payload) ? [payload] : payload;
  let n = 0;
  for (const p of parts) n += p.length;
  const b = Buffer.allocUnsafe(HEADER_BYTES + n);
  writeHeader(b, 0, { type: FRAME_TYPE.data, flags, streamId, length: n });
  let at = HEADER_BYTES;
  for (const p of parts) {
    p.copy(b, at);
    at += p.length;
  }
  return b;
}

export const windowUpdateFrame = (streamId: number, flags: number, delta: number): Buffer =>
  encodeHeader({ type: FRAME_TYPE.window, flags, streamId, length: delta });

/** `ack` answers a ping (same value); otherwise it asks (SYN). */
export const pingFrame = (ack: boolean, value: number): Buffer => encodeHeader({ type: FRAME_TYPE.ping, flags: ack ? FRAME_FLAG.ack : FRAME_FLAG.syn, streamId: 0, length: value });

export const goAwayFrame = (code: number): Buffer => encodeHeader({ type: FRAME_TYPE.goAway, flags: 0, streamId: 0, length: code });

export const finFrame = (streamId: number, extraFlags = 0): Buffer => dataFrame(streamId, FRAME_FLAG.fin | extraFlags);

export const rstFrame = (streamId: number): Buffer => windowUpdateFrame(streamId, FRAME_FLAG.rst, 0);

export function decodeHeader(b: Buffer, at = 0): FrameHeader {
  if (b.length - at < HEADER_BYTES) throw new ProtocolError('short frame header');
  const version = b[at]!;
  if (version !== CONNECT_MUX.version) throw new ProtocolError(`unknown frame version ${version}`);
  const type = b[at + 1]!;
  if (type > FRAME_TYPE.goAway) throw new ProtocolError(`unknown frame type ${type}`);
  return { type, flags: b.readUInt16BE(at + 2), streamId: b.readUInt32BE(at + 4), length: b.readUInt32BE(at + 8) };
}

/**
 * Turns a byte stream into frames. A WebSocket message normally holds one frame but a receiver must also cope with several in one
 * message and with a frame split over messages. The first violation throws a ProtocolError and kills the decoder (the session ends).
 */
export class FrameDecoder {
  #chunks: Buffer[] = [];
  #have = 0;
  #header: FrameHeader | null = null;
  #dead = false;

  constructor(private readonly maxPayload: number = CONNECT_LIMITS.maxFramePayload) {}

  /** Bytes held back, waiting for the rest of a frame. */
  get buffered(): number {
    return this.#have;
  }

  push(chunk: Buffer): Frame[] {
    if (this.#dead) throw new ProtocolError('the decoder stopped after an error');
    if (chunk.length) {
      this.#chunks.push(chunk);
      this.#have += chunk.length;
    }
    const out: Frame[] = [];
    try {
      for (;;) {
        if (!this.#header) {
          if (this.#have < HEADER_BYTES) break;
          const h = decodeHeader(this.#take(HEADER_BYTES));
          if (h.type === FRAME_TYPE.data) {
            if (h.length > this.maxPayload) throw new ProtocolError(`data frame of ${h.length} bytes (at most ${this.maxPayload})`);
            if (h.length > 0) {
              this.#header = h;
              continue;
            }
          }
          out.push({ ...h, payload: EMPTY });
        } else {
          if (this.#have < this.#header.length) break;
          out.push({ ...this.#header, payload: this.#take(this.#header.length) });
          this.#header = null;
        }
      }
    } catch (e) {
      this.#dead = true;
      this.#chunks = [];
      this.#have = 0;
      throw e;
    }
    return out;
  }

  /** The next `n` bytes, without copying when they sit in one chunk. */
  #take(n: number): Buffer {
    const first = this.#chunks[0]!;
    this.#have -= n;
    if (first.length >= n) {
      if (first.length === n) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    while (at < n) {
      const c = this.#chunks[0]!;
      const take = Math.min(c.length, n - at);
      c.copy(out, at, 0, take);
      at += take;
      if (take === c.length) this.#chunks.shift();
      else this.#chunks[0] = c.subarray(take);
    }
    return out;
  }
}
