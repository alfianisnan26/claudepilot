// HTTP/1.1 written straight onto a `kube` stream (PILOT-1170; first in the G6 spike's test/spike/wire.ts): what the portal's loopback
// listener carried for the kube client, without a node:net port. The agent's KubeProxy (apps/server/src/connect/agent/services/kube/proxy.ts)
// reads it as the server side of an HTTP connection.
//
//  - ByteReader: reads a Duplex (a MuxStream) by delimiter or by length, holding at most `maxHeld` bytes.
//  - writeRequest / readHead / readResponse: one request, one response (Content-Length or chunked); the stream stays usable (keep-alive).

import type { Duplex } from 'node:stream';

/** Reads a stream by delimiter or by length. Throws when the stream ended, or when the peer sent more than `maxHeld` unread bytes. */
export class ByteReader {
  #held: Buffer = Buffer.alloc(0);
  #ended = false;
  #over = false;
  #wake: (() => void) | null = null;

  constructor(
    stream: Duplex,
    private readonly maxHeld = Infinity,
  ) {
    stream.on('data', (chunk: Buffer) => {
      if (this.#over) return;
      this.#held = Buffer.concat([this.#held, chunk]);
      if (this.#held.length > this.maxHeld) {
        this.#over = true;
        this.#held = Buffer.alloc(0);
        stream.destroy();
      }
      this.#wake?.();
    });
    stream.on('end', () => {
      this.#ended = true;
      this.#wake?.();
    });
    stream.on('close', () => {
      this.#ended = true;
      this.#wake?.();
    });
  }

  async #more(): Promise<void> {
    if (this.#over) throw new Error('the answer is too large');
    if (this.#ended) throw new Error('the stream ended');
    await new Promise<void>((resolve) => (this.#wake = resolve));
    this.#wake = null;
    if (this.#over) throw new Error('the answer is too large');
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
    if (n > this.maxHeld) throw new Error('the answer is too large');
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

/** A whole response: Content-Length or chunked (what the API server sends for lists), at most `maxBody` bytes of body. */
export async function readResponse(r: ByteReader, maxBody = Infinity): Promise<Http1Head & { body: Buffer }> {
  const head = await readHead(r);
  if (head.headers.get('transfer-encoding')?.toLowerCase() === 'chunked') {
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const size = parseInt((await r.until('\r\n')).toString('latin1'), 16);
      if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
      total += size;
      if (total > maxBody) throw new Error('the answer is too large');
      const chunk = await r.take(size);
      await r.until('\r\n');
      if (size === 0) break;
      parts.push(chunk);
    }
    return { ...head, body: Buffer.concat(parts) };
  }
  const length = Number(head.headers.get('content-length') ?? 0);
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('bad content length');
  if (length > maxBody) throw new Error('the answer is too large');
  return { ...head, body: await r.take(length) };
}
