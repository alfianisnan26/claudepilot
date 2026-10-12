// The agent's `control` stream (docs/prd/targets-connect.md §9.5): the one stream the agent opens, right after `welcome`. JSON lines both
// ways. The agent sends `status` (every `statusEveryS` and on a change, at most one line per 2 s), `log` (at most 20 a minute), `rekey` and
// `bye`; the portal sends `config`, `rekey-answer`, `notice` and `revoked`. A line over 256 KiB or malformed JSON ends the stream and the
// connection; a message type this agent doesn't know is logged once and ignored (new types are additive, §9.7).
import {
  CONNECT_LIMITS,
  type ConnectAgentMessage,
  type ConnectByeMessage,
  type ConnectConfigMessage,
  type ConnectNoticeMessage,
  type ConnectPortalMessage,
  type ConnectRekeyAnswer,
  type ConnectRevokedMessage,
  type ConnectStatusMessage,
} from '@portal/contracts';
import { readJsonLines, writeLine } from '../tunnel/lines.js';
import { openService, type MuxSession, type MuxStream } from '../tunnel/index.js';
import type { Logger } from './log.js';

export interface ControlHandlers {
  onConfig(config: ConnectConfigMessage): void;
  onNotice(notice: ConnectNoticeMessage): void;
  onRevoked(revoked: ConnectRevokedMessage): void;
  onRekeyAnswer(answer: ConnectRekeyAnswer): void;
  /** The stream or the connection should end: a protocol error on the control stream. */
  onFatal(reason: string): void;
}

export interface ControlOptions {
  session: MuxSession;
  log: Logger;
  handlers: ControlHandlers;
  /** Time source and timers, for tests. */
  now?: () => number;
}

const MIN_STATUS_GAP_MS = 2000;
const LOGS_PER_MINUTE = 20;

export class ControlChannel {
  readonly #stream: MuxStream;
  readonly #log: Logger;
  readonly #now: () => number;
  #lastStatus = 0;
  #pending: ReturnType<typeof setTimeout> | null = null;
  #pendingBuild: (() => Promise<ConnectStatusMessage>) | null = null;
  #logWindow: number[] = [];
  #closed = false;
  readonly #unknown = new Set<string>();

  private constructor(stream: MuxStream, opts: ControlOptions) {
    this.#stream = stream;
    this.#log = opts.log;
    this.#now = opts.now ?? Date.now;
    stream.on('error', () => undefined);
    stream.once('close', () => (this.#closed = true));
    void this.#read(opts.handlers);
  }

  /** Opens the control stream (the first one the agent opens) and starts reading the portal's messages. */
  static async open(opts: ControlOptions): Promise<ControlChannel> {
    const stream = await openService(opts.session, { service: 'control' });
    return new ControlChannel(stream, opts);
  }

  get open(): boolean {
    return !this.#closed && !this.#stream.destroyed;
  }

  async #read(h: ControlHandlers): Promise<void> {
    try {
      for await (const raw of readJsonLines(this.#stream, CONNECT_LIMITS.maxControlLine)) {
        const msg = raw as Partial<ConnectPortalMessage> | null;
        switch (msg?.t) {
          case 'config':
            h.onConfig(msg as ConnectConfigMessage);
            break;
          case 'rekey-answer':
            h.onRekeyAnswer(msg as ConnectRekeyAnswer);
            break;
          case 'notice':
            h.onNotice(msg as ConnectNoticeMessage);
            break;
          case 'revoked':
            h.onRevoked(msg as ConnectRevokedMessage);
            break;
          default: {
            const t = (msg as { t?: unknown } | null)?.t;
            const kind = typeof t === 'string' ? t.slice(0, 40) : '?';
            if (!this.#unknown.has(kind)) {
              this.#unknown.add(kind);
              this.#log.info('control.unknown_message', { type: kind });
            }
          }
        }
      }
    } catch (e) {
      if (!this.#closed) h.onFatal((e as Error).message);
    }
  }

  async #send(msg: ConnectAgentMessage): Promise<void> {
    if (!this.open) return;
    await writeLine(this.#stream, msg, CONNECT_LIMITS.maxControlLine);
  }

  /**
   * Sends a status now, or as soon as the 2-second gap since the last one allows. `build` is called at send time, so a status that waited
   * carries the newest figures; asking again while one waits just replaces what it will build.
   */
  status(build: () => Promise<ConnectStatusMessage>): void {
    this.#pendingBuild = build;
    if (this.#pending) return;
    const wait = Math.max(0, this.#lastStatus + MIN_STATUS_GAP_MS - this.#now());
    this.#pending = setTimeout(() => {
      this.#pending = null;
      const run = this.#pendingBuild;
      this.#pendingBuild = null;
      if (!run || !this.open) return;
      this.#lastStatus = this.#now();
      void run().then((msg) => this.#send(msg)).catch(() => undefined);
    }, wait);
    this.#pending.unref();
  }

  /** A warning or error for the target's audit view, at most 20 a minute (the rest are dropped; the local log has them all). */
  logLine(level: 'info' | 'warn' | 'error', message: string): void {
    const now = this.#now();
    this.#logWindow = this.#logWindow.filter((t) => now - t < 60_000);
    if (this.#logWindow.length >= LOGS_PER_MINUTE) return;
    this.#logWindow.push(now);
    void this.#send({ t: 'log', level, message: message.slice(0, 500), at: new Date(now).toISOString() }).catch(() => undefined);
  }

  rekey(publicKey: string, sig: string): Promise<void> {
    return this.#send({ t: 'rekey', publicKey, sig });
  }

  /** Says goodbye, then lets the data out before the caller closes the connection. */
  async bye(reason: ConnectByeMessage['reason'], message?: string): Promise<void> {
    clearTimeout(this.#pending ?? undefined);
    this.#pending = null;
    try {
      await this.#send({ t: 'bye', reason, ...(message ? { message: message.slice(0, 200) } : {}) });
    } catch {
      // the connection is already going
    }
  }

  close(): void {
    clearTimeout(this.#pending ?? undefined);
    this.#pending = null;
    this.#closed = true;
    this.#stream.destroy();
  }
}
