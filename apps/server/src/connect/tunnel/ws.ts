// The `ws` adapter (docs/prd/targets-connect.md §9.1, §9.2): a WebSocket as the mux's socket, and the agent's side of the handshake.
//
//   wss://<portal>/connect/v1/tunnel, subprotocol `pilot.tunnel.v1`, permessage-deflate OFF, maxPayload 1 MiB, no Origin header.
//   TEXT messages are the handshake (challenge, auth, welcome or reject); after `welcome` only BINARY messages, one mux frame each.
//
// `dialTunnel` is the whole client: connect, read the challenge, sign it, say hello, and hand back a MuxSession on the open socket. The agent
// (connect/agent/client.ts) wraps it with its reconnect policy; tests and the stub agent (connect/qa/stubAgent.ts) use it as it is. The
// portal's own side of the handshake is in hub.ts, which decides what to accept.
//
// Shared by the portal and the agent: imports `ws`, `node:*` and the contract only.

import { WebSocket, type ClientOptions, type RawData } from 'ws';
import {
  CONNECT_LIMITS,
  CONNECT_PROTOCOL,
  CONNECT_REJECT_CODES,
  CONNECT_SUBPROTOCOL,
  type ConnectAgentHello,
  type ConnectAuth,
  type ConnectChallenge,
  type ConnectRejectCode,
  type ConnectReject,
  type ConnectWelcome,
} from '@portal/contracts';
import { signChallenge } from './auth.js';
import { MuxSession, type MuxLimits, type MuxSocket, type MuxStream } from './mux.js';

/** Options for the portal's `WebSocketServer` and the agent's `WebSocket`: no compression, a 1 MiB message cap. */
export const TUNNEL_WS_OPTIONS = { perMessageDeflate: false, maxPayload: CONNECT_LIMITS.wsMaxPayload } as const;

const toBuffer = (data: RawData): Buffer => (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));

/** A WebSocket as a MuxSocket. */
export class WsMuxSocket implements MuxSocket {
  constructor(readonly ws: WebSocket) {}

  send(data: Buffer, cb: (error?: Error | null) => void): void {
    this.ws.send(data, { binary: true, compress: false }, cb);
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  close(code: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  terminate(): void {
    this.ws.terminate();
  }

  onMessage(fn: (data: Buffer, isBinary: boolean) => void): void {
    this.ws.on('message', (data, isBinary) => fn(toBuffer(data), isBinary));
  }

  onClose(fn: (code: number, reason: string) => void): void {
    this.ws.on('close', (code, reason) => fn(code, reason.toString('utf8')));
  }

  onError(fn: (error: Error) => void): void {
    this.ws.on('error', fn);
  }
}

/** The portal refused the connection with a `reject` message. */
export class TunnelRejected extends Error {
  override readonly name = 'TunnelRejected';
  constructor(
    readonly code: ConnectRejectCode,
    message: string,
    readonly retryAfterS?: number,
    /** The WebSocket close code that followed, when it was seen. */
    readonly closeCode?: number,
  ) {
    super(message);
  }
}

/** The connection could not be made or did not finish the handshake: an HTTP refusal at the upgrade (`status`), a network error, a timeout. */
export class TunnelConnectError extends Error {
  override readonly name = 'TunnelConnectError';
  constructor(
    message: string,
    readonly status?: number,
    readonly closeCode?: number,
    /** The portal's `Retry-After` (seconds) on an HTTP refusal such as 429, when it sent one. */
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

export interface DialOptions {
  /** `wss://…/connect/v1/tunnel` (`connectTunnelUrl(origin)`). */
  url: string;
  nodeId: string;
  /** PKCS8 DER, base64url. */
  privateKey: string;
  /** Built after the challenge arrives, so the clock it reports is current. */
  hello: () => ConnectAgentHello;
  /** Extra options for the `ws` client: an `agent` (a CONNECT proxy), `ca`, `headers`. Never `origin`, never `rejectUnauthorized: false`. */
  ws?: ClientOptions;
  /** The handshake's overall time (default `CONNECT_LIMITS.handshakeMs`). */
  handshakeMs?: number;
  /** Streams the portal opens, once the tunnel is up. */
  onStream?: (stream: MuxStream) => void;
  limits?: Partial<MuxLimits>;
  closeError?: (reason: string) => Error;
  log?: (line: string) => void;
}

export interface Dialled {
  session: MuxSession;
  welcome: ConnectWelcome;
  ws: WebSocket;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Connects, completes the handshake and returns the mux session; rejects with TunnelRejected or TunnelConnectError. */
export function dialTunnel(opts: DialOptions): Promise<Dialled> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(opts.url, [CONNECT_SUBPROTOCOL], {
      ...TUNNEL_WS_OPTIONS,
      handshakeTimeout: opts.handshakeMs ?? CONNECT_LIMITS.handshakeMs,
      followRedirects: false,
      ...opts.ws,
    });
    let settled = false;
    let stage: 'connecting' | 'challenge' | 'welcome' = 'connecting';
    let rejected: TunnelRejected | null = null;
    const timer = setTimeout(() => fail(new TunnelConnectError('The handshake took too long.')), opts.handshakeMs ?? CONNECT_LIMITS.handshakeMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
      ws.off('unexpected-response', onUnexpected);
    };
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      ws.on('error', () => undefined); // the close that follows may still report one
      ws.terminate();
      reject(e);
    };
    const onUnexpected = (_req: unknown, res: { statusCode?: number; headers?: Record<string, string | string[] | undefined>; resume(): void }) => {
      res.resume();
      const after = Number(res.headers?.['retry-after']);
      fail(new TunnelConnectError(`The portal answered the upgrade with HTTP ${res.statusCode ?? '?'}.`, res.statusCode, undefined, Number.isFinite(after) && after > 0 && after <= 3600 ? after : undefined));
    };
    const onError = (e: Error) => fail(new TunnelConnectError(e.message || 'The connection failed.'));
    const onClose = (code: number) => fail(rejected ?? new TunnelConnectError('The portal closed the connection during the handshake.', undefined, code));
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (settled) return;
      if (isBinary) return fail(new TunnelConnectError('The portal sent frames before the handshake finished.'));
      let msg: unknown;
      try {
        msg = JSON.parse(toBuffer(data).toString('utf8'));
      } catch {
        return fail(new TunnelConnectError('The portal sent a handshake message that is not JSON.'));
      }
      if (!isObject(msg)) return fail(new TunnelConnectError('The portal sent a handshake message that is not understood.'));
      if (msg.t === 'reject' && isObject(msg) && typeof msg.code === 'string') {
        const r = msg as unknown as ConnectReject;
        const code = (CONNECT_REJECT_CODES as readonly string[]).includes(r.code) ? r.code : 'bad_request';
        rejected = new TunnelRejected(code, typeof r.message === 'string' ? r.message.slice(0, 300) : 'Refused.', typeof r.retryAfterS === 'number' ? r.retryAfterS : undefined);
        // the close frame follows; fail now so the caller need not wait for it
        return fail(rejected);
      }
      if (stage === 'challenge') {
        const c = msg as unknown as ConnectChallenge;
        if (c.t !== 'challenge' || c.v !== 1 || typeof c.connId !== 'string' || typeof c.nonce !== 'string') return fail(new TunnelConnectError('The portal sent a challenge that is not understood.'));
        const lo = c.protocol?.min ?? 0;
        const hi = c.protocol?.max ?? 0;
        if (CONNECT_PROTOCOL < lo || CONNECT_PROTOCOL > hi) return fail(new TunnelRejected('upgrade_required', `The portal speaks protocol ${lo} to ${hi}; this agent speaks ${CONNECT_PROTOCOL}.`));
        const auth: ConnectAuth = { t: 'auth', node: opts.nodeId, sig: signChallenge(opts.privateKey, c.connId, c.nonce, opts.nodeId), hello: opts.hello() };
        stage = 'welcome';
        ws.send(JSON.stringify(auth));
        return;
      }
      if (stage === 'welcome') {
        const w = msg as unknown as ConnectWelcome;
        if (w.t !== 'welcome' || w.v !== 1) return fail(new TunnelConnectError('The portal answered the handshake in a way that is not understood.'));
        settled = true;
        cleanup();
        // The session takes over the socket in this very turn: frames may follow the welcome in the same read.
        const session = new MuxSession({ role: 'client', socket: new WsMuxSocket(ws), onStream: opts.onStream, limits: opts.limits, closeError: opts.closeError, log: opts.log });
        resolve({ session, welcome: w, ws });
      }
    };
    ws.on('unexpected-response', onUnexpected);
    ws.on('error', onError);
    ws.on('close', onClose);
    ws.on('message', onMessage);
    ws.once('open', () => {
      stage = 'challenge';
    });
  });
}
