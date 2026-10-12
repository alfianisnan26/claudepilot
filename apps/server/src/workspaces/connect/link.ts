// What every tunnelled runtime shares (docs/prd/targets-connect.md §12.5, §12.7): when a node was last reachable, the rule that a call
// made while its tunnel is down fails with `TargetUnreachableError` (an outage, not a state change), and the portal's half of a `host`
// stream (records: DATA, STDERR, RESIZE, EOF, RESULT, SIGNAL).
import { CONNECT_LIMITS, type ConnectHostOpen, type ConnectHostResult } from '@portal/contracts';
import { ConnectError, type NodeLink, type TunnelStream } from '../../connect/seams.js';
import { chunkRecords, encodeRecord, parseResult, RECORD, RecordParser, writeBuffer } from '../../connect/tunnel/records.js';
import { TargetUnreachableError } from '../runtime.js';

/** Remembers when a node was last connected, so "unreachable since 14:02" can be said. Seeded from the stored snapshot's time. */
export class Reachability {
  #since: string | null;

  constructor(
    readonly link: NodeLink,
    readonly targetId: string,
    seed: string | null,
  ) {
    this.#since = link.connected() ? null : seed;
    link.onChange((up) => {
      this.#since = up ? null : new Date().toISOString();
    });
  }

  /** ISO time it was last reachable (null while it is up, or when never seen). */
  get downSince(): string | null {
    return this.link.connected() ? null : this.#since;
  }

  /** Throws `TargetUnreachableError` while the tunnel is down. */
  assertUp() {
    if (!this.link.connected()) throw new TargetUnreachableError(this.targetId, this.#since);
  }

  /** `fn`'s failures caused by the tunnel (it dropped, or was down when the stream was asked for) become `TargetUnreachableError`. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.assertUp();
    try {
      return await fn();
    } catch (e) {
      throw this.translate(e);
    }
  }

  translate(e: unknown): unknown {
    if (e instanceof TargetUnreachableError) return e;
    const offline = (e instanceof ConnectError && (e.code === 'agent_offline' || e.code === 'target_removed')) || !this.link.connected();
    return offline ? new TargetUnreachableError(this.targetId, this.#since ?? new Date().toISOString()) : e;
  }
}

/** "Last seen 4 min ago". */
export function lastSeenText(at: string | null, now = Date.now()): string {
  if (!at) return 'Not reached yet';
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (s < 60) return 'Last seen just now';
  const m = Math.round(s / 60);
  if (m < 60) return `Last seen ${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `Last seen ${h} h ago` : `Last seen ${Math.round(h / 24)} days ago`;
}

/** The portal's side of one `host` stream: records out, records in, one RESULT at the end. */
export class HostCall {
  readonly #parser = new RecordParser();
  readonly #data: ((chunk: Buffer, stderr: boolean) => void)[] = [];
  readonly #done: Promise<ConnectHostResult>;
  #result: ConnectHostResult | null = null;

  constructor(readonly stream: TunnelStream) {
    this.#done = new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        let records;
        try {
          records = this.#parser.push(chunk);
        } catch (e) {
          stream.destroy();
          return reject(e);
        }
        for (const r of records) {
          if (r.kind === RECORD.data || r.kind === RECORD.stderr) this.#data.forEach((fn) => fn(r.payload, r.kind === RECORD.stderr));
          else if (r.kind === RECORD.result) {
            this.#result = parseResult(r.payload);
            resolve(this.#result);
          }
        }
      });
      // The agent ends its side after RESULT; the portal then ends its own (the stream is done both ways).
      stream.on('end', () => {
        if (!stream.writableEnded) stream.end();
        if (!this.#result) reject(new ConnectError('internal', 'The host stream ended without a result.'));
      });
      stream.on('close', () => {
        if (!this.#result) reject(new ConnectError('agent_offline', 'The host stream closed without a result.'));
      });
      stream.on('error', () => undefined);
    });
    this.#done.catch(() => undefined);
  }

  /** Opens `op` on `link`. */
  static async open(link: NodeLink, op: ConnectHostOpen): Promise<HostCall> {
    return new HostCall(await link.open('host', op));
  }

  onData(fn: (chunk: Buffer, stderr: boolean) => void) {
    this.#data.push(fn);
  }

  /** Resolves with the agent's RESULT; rejects when the stream ends without one. */
  result(): Promise<ConnectHostResult> {
    return this.#done;
  }

  /** stdin or a file's bytes, in records of at most 64 KiB; resolves when the stream took them (its window is the backpressure). */
  async write(data: Buffer | string) {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    for (const rec of chunkRecords(RECORD.data, bytes)) await writeBuffer(this.stream, rec);
  }

  /** Fire and forget, for a terminal's keystrokes. */
  send(data: Buffer | string) {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (this.stream.destroyed || this.stream.writableEnded) return;
    for (let at = 0; at < bytes.length; at += CONNECT_LIMITS.maxFramePayload) this.stream.write(encodeRecord(RECORD.data, bytes.subarray(at, at + CONNECT_LIMITS.maxFramePayload)));
  }

  eof() {
    if (!this.stream.destroyed && !this.stream.writableEnded) this.stream.write(encodeRecord(RECORD.eof));
  }

  resize(cols: number, rows: number) {
    if (!this.stream.destroyed && !this.stream.writableEnded) this.stream.write(encodeRecord(RECORD.resize, JSON.stringify({ cols, rows })));
  }

  /** A reset: the agent kills the process (SIGHUP to a terminal's group, SIGTERM then SIGKILL otherwise). */
  kill() {
    this.stream.destroy();
  }
}
