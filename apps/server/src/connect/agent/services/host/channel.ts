// A `host` stream as records with the two directions of backpressure (docs/prd/targets-connect.md §9.5). The wire format
// (`[kind u8][length u32 BE][payload]`, at most `maxFramePayload` bytes) is the tunnel library's `records.ts`, shared with the portal.
import type { Duplex } from 'node:stream';
import { CONNECT_LIMITS, type ConnectHostResult } from '@portal/contracts';
import { encodeRecord, RECORD, RecordError, RecordParser, type HostRecord, type RecordKind } from '../../../tunnel/records.js';

export const REC = RECORD;
export { encodeRecord, RecordError, RecordParser };
export type { HostRecord, RecordKind };

/** One `host` stream seen as records, with the two directions of backpressure. */
export class HostChannel {
  readonly #decoder = new RecordParser();
  #waiting: (() => void)[] = [];
  #closed = false;
  #sent = false;

  constructor(readonly stream: Duplex) {
    stream.on('drain', () => this.#flush());
    stream.on('close', () => {
      this.#closed = true;
      this.#flush();
    });
    stream.on('error', () => undefined); // the 'close' that follows is what ends things
  }

  /** Calls `fn` for each record the portal sends; returns after wiring. A bad record ends the stream. */
  onRecord(fn: (rec: HostRecord) => void): void {
    this.stream.on('data', (chunk: Buffer) => {
      try {
        for (const rec of this.#decoder.push(chunk)) fn(rec);
      } catch {
        this.stream.destroy();
      }
    });
  }

  /** The portal closed its side (it will send nothing more); not a reset. */
  onEnd(fn: () => void): void {
    this.stream.on('end', fn);
  }

  /** The stream is gone (reset, or finished both ways). */
  onClose(fn: () => void): void {
    if (this.#closed || this.stream.destroyed) queueMicrotask(fn);
    else this.stream.on('close', fn);
  }

  get closed(): boolean {
    return this.#closed || this.stream.destroyed;
  }

  pause(): void {
    this.stream.pause();
  }

  resume(): void {
    this.stream.resume();
  }

  /** Writes one record. Returns false when the stream wants a pause: wait for `drained()` before sending more. */
  send(kind: RecordKind, payload?: Buffer | string): boolean {
    if (this.closed || this.#sent) return false;
    return this.stream.write(encodeRecord(kind, payload));
  }

  /** Sends bytes as DATA (or STDERR) records of at most `maxFramePayload` bytes. Returns false when the stream wants a pause. */
  sendBytes(kind: RecordKind, bytes: Buffer): boolean {
    let ok = true;
    for (let at = 0; at < bytes.length; at += CONNECT_LIMITS.maxFramePayload) {
      ok = this.send(kind, bytes.subarray(at, at + CONNECT_LIMITS.maxFramePayload)) && ok;
    }
    return ok;
  }

  /** Resolves when the stream accepts more (or is gone). */
  drained(): Promise<void> {
    return new Promise((resolve) => {
      if (this.closed || !this.stream.writableNeedDrain) return resolve();
      this.#waiting.push(resolve);
    });
  }

  /** The last record, then the end of our side. Safe to call more than once. */
  finish(result: ConnectHostResult): void {
    if (this.#sent) return;
    this.#sent = true;
    if (!this.closed) {
      this.stream.write(encodeRecord(REC.result, JSON.stringify(result)));
      this.stream.end();
    }
  }

  get finished(): boolean {
    return this.#sent;
  }

  #flush(): void {
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const fn of waiting) fn();
  }
}
