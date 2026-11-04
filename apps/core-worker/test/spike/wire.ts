// PILOT-1159 (G6 spike): the small pieces a Durable Object needs to speak to the agent's `kube` service without @kubernetes/client-node and
// without a node:net loopback port. Test support for test/spike/muxOnWorkerd.test.ts only; nothing in src imports it.
//
//  - cfMuxSocket: the mux's `MuxSocket` (@portal/connect-tunnel/mux) on a Cloudflare WebSocket (what ws.ts is for `ws`).
//  - ByteReader: reads a Duplex (a MuxStream) by delimiter or by length.
//  - writeRequest / readResponse: HTTP/1.1 written straight onto a `kube` stream (what the loopback listener carried for the kube client).
//  - wsFrame / readWsFrame: RFC 6455 frames, for exec over v4/v5.channel.k8s.io after the 101 on the same stream.

import type { Duplex } from 'node:stream';
import type { MuxSocket } from '@portal/connect-tunnel/mux';

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

/** Reads a stream by delimiter or by length; `end` when the stream ended. */
export class ByteReader {
  #held: Buffer = Buffer.alloc(0);
  #ended = false;
  #wake: (() => void) | null = null;

  constructor(stream: Duplex) {
    stream.on('data', (chunk: Buffer) => {
      this.#held = Buffer.concat([this.#held, chunk]);
      this.#wake?.();
    });
    stream.on('end', () => {
      this.#ended = true;
      this.#wake?.();
    });
  }

  async #more(): Promise<void> {
    if (this.#ended) throw new Error('the stream ended');
    await new Promise<void>((resolve) => (this.#wake = resolve));
    this.#wake = null;
  }

  async until(delimiter: string, max = 64 * 1024): Promise<Buffer> {
    for (;;) {
      const at = this.#held.indexOf(delimiter);
      if (at >= 0) {
        const out = this.#held.subarray(0, at);
        this.#held = this.#held.subarray(at + delimiter.length);
        return out;
      }
      if (this.#held.length > max) throw new Error('line too long');
      await this.#more();
    }
  }

  async take(n: number): Promise<Buffer> {
    while (this.#held.length < n) await this.#more();
    const out = this.#held.subarray(0, n);
    this.#held = this.#held.subarray(n);
    return out;
  }
}

export interface Http1Head {
  status: number;
  headers: Map<string, string>;
}

export interface Http1Request {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

/** One HTTP/1.1 request, written onto the stream as the kube client's socket would have written it. */
export function writeRequest(stream: Duplex, req: Http1Request): void {
  const body = req.body === undefined ? null : Buffer.from(req.body, 'utf8');
  const lines = [`${req.method} ${req.path} HTTP/1.1`, 'Host: kubernetes'];
  for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${v}`);
  if (body) lines.push(`Content-Length: ${body.length}`);
  stream.write(Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'));
  if (body) stream.write(body);
}

export async function readHead(r: ByteReader): Promise<Http1Head> {
  const [statusLine, ...rest] = (await r.until('\r\n\r\n')).toString('latin1').split('\r\n');
  const m = /^HTTP\/1\.1 (\d{3}) /.exec(statusLine ?? '');
  if (!m) throw new Error('not an HTTP/1.1 response');
  const headers = new Map<string, string>();
  for (const line of rest) {
    const i = line.indexOf(':');
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return { status: Number(m[1]), headers };
}

/** A whole response: Content-Length or chunked (what the API server sends for lists). The stream stays usable for the next request. */
export async function readResponse(r: ByteReader): Promise<Http1Head & { body: Buffer }> {
  const head = await readHead(r);
  if (head.headers.get('transfer-encoding')?.toLowerCase() === 'chunked') {
    const parts: Buffer[] = [];
    for (;;) {
      const size = parseInt((await r.until('\r\n')).toString('latin1'), 16);
      if (!Number.isFinite(size)) throw new Error('bad chunk size');
      const chunk = await r.take(size);
      await r.until('\r\n');
      if (size === 0) break;
      parts.push(chunk);
    }
    return { ...head, body: Buffer.concat(parts) };
  }
  return { ...head, body: await r.take(Number(head.headers.get('content-length') ?? 0)) };
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
