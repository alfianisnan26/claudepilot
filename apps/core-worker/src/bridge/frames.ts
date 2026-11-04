// The few Connect mux (yamux) headers the bridge reads in phase 1 (PILOT-1144): a ping to answer, a ping to send, a go-away. The framing is
// the contract's (`CONNECT_MUX`, `CONNECT_LIMITS.frameHeader`), byte for byte as apps/server/src/connect/tunnel/frame.ts; nothing is rewritten.
// 12 bytes, big-endian: [version u8 = 0][type u8][flags u16][stream id u32][length u32].

import { CONNECT_LIMITS, CONNECT_MUX } from '@portal/contracts';

export interface MuxHeader {
  version: number;
  type: number;
  flags: number;
  streamId: number;
  length: number;
}

/** The header at the start of a binary message, or null when the message is shorter than one. */
export function readMuxHeader(data: ArrayBuffer): MuxHeader | null {
  if (data.byteLength < CONNECT_LIMITS.frameHeader) return null;
  const v = new DataView(data);
  return { version: v.getUint8(0), type: v.getUint8(1), flags: v.getUint16(2), streamId: v.getUint32(4), length: v.getUint32(8) };
}

/** A PING frame: `ack` answers one (same value), otherwise it asks (SYN). */
export function muxPing(ack: boolean, value: number): ArrayBuffer {
  const b = new ArrayBuffer(CONNECT_LIMITS.frameHeader);
  const v = new DataView(b);
  v.setUint8(0, CONNECT_MUX.version);
  v.setUint8(1, CONNECT_MUX.type.ping);
  v.setUint16(2, ack ? CONNECT_MUX.flag.ack : CONNECT_MUX.flag.syn);
  v.setUint32(4, 0);
  v.setUint32(8, value >>> 0);
  return b;
}
