// Test helper: the portal's side of one `host` stream (what T3's HostRuntime does over the tunnel), wired straight to a service with no
// tunnel in between. Records the agent sends are collected; the helpers write the portal's records.
import type { Duplex } from 'node:stream';
import { CONNECT_LIMITS, type ConnectHostOpen, type ConnectHostResult } from '@portal/contracts';
import { encodeRecord, REC, RecordParser, type HostRecord, type RecordKind } from '../services/host/channel.js';
import type { HostService } from '../services/host/index.js';
import { streamPair } from './streams.js';

export class HostOp {
  readonly records: HostRecord[] = [];
  readonly #waiters: (() => void)[] = [];
  #result: ConnectHostResult | null = null;
  readonly #decoder = new RecordParser();
  readonly closed: Promise<void>;
  ended = false;

  constructor(readonly stream: Duplex) {
    stream.on('data', (chunk: Buffer) => {
      for (const rec of this.#decoder.push(chunk)) {
        this.records.push(rec);
        if (rec.kind === REC.result) this.#result = JSON.parse(rec.payload.toString('utf8')) as ConnectHostResult;
      }
      this.#waiters.splice(0).forEach((w) => w());
    });
    // The portal closes its side once the agent has ended (it has read the RESULT), as the real HostRuntime does.
    stream.on('end', () => {
      this.ended = true;
      stream.end();
    });
    stream.on('error', () => undefined);
    this.closed = new Promise<void>((resolve) => stream.on('close', () => resolve()));
  }

  /** Bytes of the DATA records so far. */
  stdout(): Buffer {
    return Buffer.concat(this.records.filter((r) => r.kind === REC.data).map((r) => r.payload));
  }

  stderr(): Buffer {
    return Buffer.concat(this.records.filter((r) => r.kind === REC.stderr).map((r) => r.payload));
  }

  text(): string {
    return this.stdout().toString('utf8');
  }

  /** Resolves with the RESULT record (and rejects after `ms` without one). */
  result(ms = 10_000): Promise<ConnectHostResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no RESULT within ${ms} ms; records: ${this.records.map((r) => r.kind).join(',')}`)), ms);
      const check = () => {
        if (!this.#result) return void this.#waiters.push(check);
        clearTimeout(timer);
        resolve(this.#result);
      };
      check();
    });
  }

  /** Waits until the DATA so far contains `text`. */
  async waitFor(text: string, ms = 10_000): Promise<void> {
    const start = Date.now();
    while (!this.text().includes(text)) {
      if (Date.now() - start > ms) throw new Error(`did not see ${JSON.stringify(text)} in ${JSON.stringify(this.text().slice(-300))}`);
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  send(kind: RecordKind, payload?: Buffer | string): boolean {
    return this.stream.write(encodeRecord(kind, payload));
  }

  /** DATA records of at most 64 KiB. */
  write(data: Buffer | string): void {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    for (let at = 0; at < bytes.length; at += CONNECT_LIMITS.maxFramePayload) this.send(REC.data, bytes.subarray(at, at + CONNECT_LIMITS.maxFramePayload));
  }

  eof(): void {
    this.send(REC.eof);
  }

  resize(cols: number, rows: number): void {
    this.send(REC.resize, JSON.stringify({ cols, rows }));
  }

  signal(signal: string): void {
    this.send(REC.signal, JSON.stringify({ signal }));
  }

  /** A reset: the portal gives up on the stream. */
  reset(): void {
    this.stream.destroy();
  }
}

/** Opens `op` on a fresh stream pair against `service` (as the tunnel client does after an `ok` answer). */
export async function openHost(service: HostService, op: ConnectHostOpen, trace = 'test0001'): Promise<HostOp> {
  const refusal = await service.accept(op);
  if (refusal) throw new Error(`refused: ${refusal.code}: ${refusal.message}`);
  const [portal, agent] = streamPair();
  service.handle(agent, trace, op);
  return new HostOp(portal);
}
