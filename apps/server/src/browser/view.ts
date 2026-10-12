import { isAppError } from '@isnanme/core';
import type { WebSocket } from 'ws';
import type { ExecStream } from './companion.js';
import { RfbClientFilter, RfbClientHandshake, RfbViolation, UpstreamReader, type RfbRole } from './rfb.js';
import type { BrowserService } from './service.js';

/**
 * One live view of a browser's screen over VNC (browser & desktop PRD §12.1–§12.3). The browser's noVNC talks RFB to
 * this bridge over a WebSocket; the bridge talks to the display through `cpb-vnc` in the browser container, which
 * logs in with the role's password. What the bridge enforces, and why it is the only way to the display:
 *
 * - the browser-facing handshake is the bridge's own (RFB 3.8, no security): the socket is already signed in;
 * - every message from the viewer passes `RfbClientFilter`: a viewer's keys and pointer are dropped, nobody's
 *   clipboard goes through, unknown messages close the socket;
 * - a viewer is a viewer unless this device holds control, and only over HTTPS or localhost;
 * - when who holds control changes, the socket closes with 4001 and the client reconnects with its new role (the
 *   display's stream can't be cut and rejoined mid-message), and while control is Private a viewer's socket closes
 *   with 4002 and reconnects into a connection that is sent no pixels at all.
 *
 * Only binary frames carry RFB; noVNC would choke on text. Everything else (who holds control, the handoff) the page
 * reads from the status route.
 */

/** Close codes the page acts on. */
export const CLOSE = { roleChanged: 4001, private: 4002, refused: 4003, unavailable: 4004 } as const;

/** Input events per second a socket may send before the rest are dropped (a person types and drags far below this). */
const INPUT_PER_SECOND = 400;
const PING_MS = 25_000;

export interface VncSessionOptions {
  ws: WebSocket;
  service: BrowserService;
  workspaceId: string;
  device: string;
  /** Whether input is allowed from this connection (HTTPS or localhost). */
  secure: boolean;
}

export class VncSession {
  readonly #o: VncSessionOptions;
  #upstream: ExecStream | null = null;
  #unwatch: (() => void) | null = null;
  #release: (() => void) | null = null;
  #closed = false;
  #counted = false;
  /** The role the upstream was opened with: a socket's role is fixed for its life. */
  #role: RfbRole = 'viewer';
  #private = false;
  #serverInit: Buffer | null = null;
  #held = { tokens: INPUT_PER_SECOND, at: Date.now() };

  constructor(o: VncSessionOptions) {
    this.#o = o;
  }

  /** The role now: the holder of control (over a secure connection) drives, everyone else watches. */
  #roleNow(): RfbRole {
    return this.#o.secure ? this.#o.service.roleOf(this.#o.workspaceId, this.#o.device) : 'viewer';
  }

  async run() {
    const { ws, service, workspaceId, device } = this.#o;
    try {
      this.#release = service.openViewer(workspaceId);
    } catch (e) {
      return this.#close(CLOSE.refused, isAppError(e) ? e.message : 'Too many viewers.');
    }
    service.leases.opened(workspaceId, device, 1);
    this.#counted = true;
    this.#role = this.#roleNow();
    this.#private = service.isPrivate(workspaceId) && this.#role !== 'controller';
    this.#unwatch = service.leases.watch(workspaceId, () => this.#onControlChange());

    const alive = { ok: true };
    const ping = setInterval(() => {
      if (!alive.ok) return ws.terminate();
      alive.ok = false;
      ws.ping();
    }, PING_MS);
    ws.on('pong', () => (alive.ok = true));
    ws.on('close', () => {
      clearInterval(ping);
      this.#teardown();
    });
    ws.on('error', () => this.#teardown());

    // The filter reads the role and Private state for every message.
    const filter = new RfbClientFilter({
      role: () => this.#role,
      private: () => this.#private,
    });
    const reader = new UpstreamReader();
    let handshake: RfbClientHandshake | null = null;
    let upstream: ExecStream;
    try {
      upstream = await service.openVnc(workspaceId, this.#role);
    } catch (e) {
      return this.#close(CLOSE.unavailable, isAppError(e) ? e.message : 'The display isn’t answering.');
    }
    if (this.#closed) return upstream.close();
    this.#upstream = upstream;
    upstream.onData((d) => reader.push(d));
    upstream.onExit(() => this.#close(CLOSE.unavailable, 'The display closed.'));
    reader.onError = (m) => this.#close(CLOSE.unavailable, m);
    reader.onData = (d) => ws.readyState === ws.OPEN && ws.send(d, { binary: true });
    // The greeting waits for the display's ServerInit, which the handshake ends with.
    reader.onInit = (init) => {
      this.#serverInit = init;
      handshake = new RfbClientHandshake((b) => ws.readyState === ws.OPEN && ws.send(b, { binary: true }), () => init);
      handshake.start();
    };

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return; // control rides the status route, not this socket
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      service.leases.seen(workspaceId, device);
      try {
        if (!handshake?.done) {
          const rest = handshake?.push(chunk) ?? null;
          if (rest && rest.length) this.#fromClient(filter, rest);
          return;
        }
        this.#fromClient(filter, chunk);
      } catch (e) {
        if (e instanceof RfbViolation) return this.#close(1008, 'Not a message a viewer may send.');
        throw e;
      }
    });
  }

  /** Input is rate-limited per socket; the rest of the viewer's messages are filtered. */
  #fromClient(filter: RfbClientFilter, chunk: Buffer) {
    const now = Date.now();
    this.#held.tokens = Math.min(INPUT_PER_SECOND, this.#held.tokens + ((now - this.#held.at) / 1000) * INPUT_PER_SECOND);
    this.#held.at = now;
    const before = filter.stats.keys + filter.stats.pointers;
    const { forward } = filter.push(chunk);
    const events = filter.stats.keys + filter.stats.pointers - before;
    if (events > 0 && (this.#held.tokens -= events) < 0) return; // a flood of input: dropped, not forwarded
    for (const m of forward) this.#upstream?.write(m);
  }

  #onControlChange() {
    if (this.#closed) return;
    const { service, workspaceId } = this.#o;
    if (this.#roleNow() !== this.#role) return this.#close(CLOSE.roleChanged, 'Control changed.');
    const priv = service.isPrivate(workspaceId) && this.#role !== 'controller';
    if (priv && !this.#private) return this.#close(CLOSE.private, 'Private.');
    if (!priv && this.#private) {
      // Hand-back: the viewer's requests were dropped, so ask for the whole screen once on its behalf.
      this.#private = false;
      const init = this.#serverInit;
      if (init) this.#upstream?.write(Buffer.from([3, 0, 0, 0, 0, 0, init[0]!, init[1]!, init[2]!, init[3]!]));
    }
  }

  #close(code: number, reason: string) {
    if (this.#closed) return;
    const { ws } = this.#o;
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason.slice(0, 120));
    this.#teardown();
  }

  #teardown() {
    if (this.#closed) return;
    this.#closed = true;
    this.#unwatch?.();
    this.#upstream?.close();
    this.#release?.();
    if (this.#counted) this.#o.service.leases.opened(this.#o.workspaceId, this.#o.device, -1);
  }
}
