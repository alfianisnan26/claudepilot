// PILOT-1159 (G6 spike): the small pieces a Durable Object needs to speak to the agent's `kube` service without @kubernetes/client-node and
// without a node:net loopback port. Test support for test/spike/muxOnWorkerd.test.ts only; nothing in src imports it.
//
//  - cfMuxSocket: the mux's `MuxSocket` (@portal/connect-tunnel/mux) on a Cloudflare WebSocket (what ws.ts is for `ws`).
//  - ByteReader, writeRequest, readHead, readResponse: HTTP/1.1 on a `kube` stream; in src/bridge/http1.ts since PILOT-1170 (BridgeDO uses them).
//  - wsFrame / readWsFrame: RFC 6455 frames, for exec over v4/v5.channel.k8s.io after the 101 on the same stream.

import type { MuxSocket } from '@portal/connect-tunnel/mux';
import { ByteReader } from '../../src/bridge/http1.js';

export { ByteReader, readHead, readResponse, writeRequest, type Http1Head, type Http1Request } from '../../src/bridge/http1.js';

export interface CfMuxSocket extends MuxSocket {
  /** The size of every binary message this end sent, to check against CONNECT_LIMITS.wsMaxPayload. */
  readonly sentSizes: number[];
}

/**
 * The MuxSocket on a Cloudflare WebSocket. Cloudflare's `send` has no callback and no `bufferedAmount`: a message is queued by the runtime at
 * once, so the callback fires on the next microtask and `bufferedAmount` is 0. The mux's high/low water marks then never hold the sender
 * back (see the finding in docs/prd/cf-bridge.md, G6).
 */
export function cfMuxSocket(ws: WebSocket): CfMuxSocket {
  const onMessage: ((data: Buffer, isBinary: boolean) => void)[] = [];
  const onClose: ((code: number, reason: string) => void)[] = [];
  const onError: ((error: Error) => void)[] = [];
  const sentSizes: number[] = [];
  // A binary message may arrive as a Blob; keep the order while one is being read.
  let order: Promise<void> = Promise.resolve();
  ws.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as unknown;
    order = order.then(async () => {
      if (typeof d === 'string') return onMessage.forEach((fn) => fn(Buffer.from(d, 'utf8'), false));
      const bytes = d instanceof Blob ? await d.arrayBuffer() : (d as ArrayBuffer);
      onMessage.forEach((fn) => fn(Buffer.from(bytes), true));
    });
  });
  ws.addEventListener('close', (e: CloseEvent) => {
    void order.then(() => onClose.forEach((fn) => fn(e.code, e.reason)));
  });
  ws.addEventListener('error', () => onError.forEach((fn) => fn(new Error('websocket error'))));
  return {
    sentSizes,
    get bufferedAmount() {
      return 0;
    },
    send(data, cb) {
      try {
        ws.send(data);
        sentSizes.push(data.length);
        queueMicrotask(() => cb());
      } catch (e) {
        queueMicrotask(() => cb(e instanceof Error ? e : new Error(String(e))));
      }
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    terminate() {
      // Cloudflare has no abortive close: 1011 is the nearest.
      try {
        ws.close(1011, 'terminated');
      } catch {
        // already closed
      }
    },
    onMessage: (fn) => void onMessage.push(fn),
    onClose: (fn) => void onClose.push(fn),
    onError: (fn) => void onError.push(fn),
  };
}

/** An RFC 6455 frame. A client's frames are masked; the server's are not. */
export function wsFrame(opcode: number, payload: Uint8Array, mask: boolean): Buffer {
  const len = payload.length;
  const ext = len < 126 ? 0 : len < 65_536 ? 2 : 8;
  const head = Buffer.alloc(2 + ext + (mask ? 4 : 0));
  head[0] = 0x80 | opcode;
  head[1] = (mask ? 0x80 : 0) | (ext === 0 ? len : ext === 2 ? 126 : 127);
  if (ext === 2) head.writeUInt16BE(len, 2);
  if (ext === 8) head.writeBigUInt64BE(BigInt(len), 2);
  const body = Buffer.from(payload);
  if (mask) {
    const key = crypto.getRandomValues(new Uint8Array(4));
    head.set(key, 2 + ext);
    for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ key[i % 4]!;
  }
  return Buffer.concat([head, body]);
}

export async function readWsFrame(r: ByteReader): Promise<{ opcode: number; payload: Buffer }> {
  const [b0, b1] = await r.take(2);
  let len = b1! & 0x7f;
  if (len === 126) len = (await r.take(2)).readUInt16BE(0);
  else if (len === 127) len = Number((await r.take(8)).readBigUInt64BE(0));
  const key = b1! & 0x80 ? await r.take(4) : null;
  const payload = Buffer.from(await r.take(len));
  if (key) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ key[i % 4]!;
  return { opcode: b0! & 0x0f, payload };
}

/** Sec-WebSocket-Accept for a key (RFC 6455 §4.2.2), on WebCrypto. */
export async function wsAccept(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`));
  return Buffer.from(digest).toString('base64');
}
