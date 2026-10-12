// The `host` service's records (docs/prd/targets-connect.md §9.5, `CONNECT_HOST_RECORD` in the contract): after the open answer a `host`
// stream carries `[kind u8][length u32 BE][payload]`, a payload at most 64 KiB. `RESULT` is always the last record. A new record kind is a
// protocol bump, so a kind this code does not know is an error, not something to skip.
//
// Shared by the portal and the agent: only `node:*` and the contract are imported.

import type { Readable, Writable } from 'node:stream';
import { CONNECT_HOST_RECORD, CONNECT_LIMITS, type ConnectHostResult } from '@portal/contracts';

export const RECORD = CONNECT_HOST_RECORD;
export type RecordKind = (typeof CONNECT_HOST_RECORD)[keyof typeof CONNECT_HOST_RECORD];

const KINDS = new Set<number>(Object.values(CONNECT_HOST_RECORD));
export const RECORD_HEADER = 5;

/** A record the receiver cannot accept: an unknown kind, or a payload over the limit. The stream is reset. */
export class RecordError extends Error {
  override readonly name = 'RecordError';
}

export interface HostRecord {
  kind: number;
  payload: Buffer;
}

export function encodeRecord(kind: RecordKind, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length > CONNECT_LIMITS.maxFramePayload) throw new RecordError(`A record of ${body.length} bytes is over the limit of ${CONNECT_LIMITS.maxFramePayload}.`);
  const out = Buffer.allocUnsafe(RECORD_HEADER + body.length);
  out[0] = kind;
  out.writeUInt32BE(body.length, 1);
  body.copy(out, RECORD_HEADER);
  return out;
}

export const jsonRecord = (kind: RecordKind, value: unknown): Buffer => encodeRecord(kind, JSON.stringify(value));

/** `data` split into records of at most 64 KiB (stdin, stdout, a file's bytes). */
export function chunkRecords(kind: RecordKind, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < data.length; at += CONNECT_LIMITS.maxFramePayload) out.push(encodeRecord(kind, data.subarray(at, at + CONNECT_LIMITS.maxFramePayload)));
  return out;
}

/** Turns a byte stream into records, across any split of the bytes. */
export class RecordParser {
  #held: Buffer[] = [];
  #have = 0;
  #kind = -1;
  #length = 0;

  push(chunk: Buffer): HostRecord[] {
    if (chunk.length) {
      this.#held.push(chunk);
      this.#have += chunk.length;
    }
    const out: HostRecord[] = [];
    for (;;) {
      if (this.#kind < 0) {
        if (this.#have < RECORD_HEADER) break;
        const head = this.#take(RECORD_HEADER);
        const kind = head[0]!;
        const length = head.readUInt32BE(1);
        if (!KINDS.has(kind)) throw new RecordError(`Unknown record kind ${kind}.`);
        if (length > CONNECT_LIMITS.maxFramePayload) throw new RecordError(`A record of ${length} bytes is over the limit of ${CONNECT_LIMITS.maxFramePayload}.`);
        this.#kind = kind;
        this.#length = length;
      }
      if (this.#have < this.#length) break;
      out.push({ kind: this.#kind, payload: this.#length ? this.#take(this.#length) : Buffer.alloc(0) });
      this.#kind = -1;
    }
    return out;
  }

  /** Bytes held back for a record that has not arrived whole. */
  get buffered(): number {
    return this.#have;
  }

  #take(n: number): Buffer {
    this.#have -= n;
    const first = this.#held[0]!;
    if (first.length >= n) {
      if (first.length === n) this.#held.shift();
      else this.#held[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    while (at < n) {
      const c = this.#held[0]!;
      const take = Math.min(c.length, n - at);
      c.copy(out, at, 0, take);
      at += take;
      if (take === c.length) this.#held.shift();
      else this.#held[0] = c.subarray(take);
    }
    return out;
  }
}

/** The records of a stream, one at a time, with the stream's own backpressure (it is read as fast as the loop consumes). */
export async function* readRecords(stream: Readable): AsyncGenerator<HostRecord> {
  const parser = new RecordParser();
  for await (const chunk of stream as AsyncIterable<Buffer>) yield* parser.push(chunk);
  if (parser.buffered) throw new RecordError('The stream ended inside a record.');
}

/** Writes a buffer and resolves when the stream took it (waiting for `drain` when its buffer is full). */
export function writeBuffer(stream: Writable, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) return reject(new Error('The stream is closed.'));
    const ok = stream.write(buf, (e) => e && reject(e));
    if (ok) return resolve();
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('The stream closed.'));
    };
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('close', onClose);
    };
    stream.once('drain', onDrain);
    stream.once('close', onClose);
  });
}

export const writeRecord = (stream: Writable, kind: RecordKind, payload?: Buffer | string): Promise<void> => writeBuffer(stream, encodeRecord(kind, payload));

/** Parses a `RESULT` record's payload. */
export function parseResult(payload: Buffer): ConnectHostResult {
  try {
    const v = JSON.parse(payload.toString('utf8')) as ConnectHostResult;
    if (v && typeof v === 'object' && 'code' in v) return v;
  } catch {
    // falls through
  }
  throw new RecordError('A result record is not valid.');
}
