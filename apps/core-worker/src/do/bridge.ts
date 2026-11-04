// BridgeDO (PILOT-1144, D4): one per cluster (`locate(env.BRIDGE, cluster)`), holding the cluster's one live dial-out link from cp-bridge.
// It speaks the Connect handshake of apps/server/src/connect/hub.ts: challenge -> auth -> welcome | reject, the Ed25519 signature checked
// with WebCrypto (`connectVerifyChallenge`, packages/contracts/src/connectSign.ts). After the welcome only binary mux frames flow; phase 1
// reads only their headers (answers pings, honours go-away) and never rewrites one.
//
// Differences from hub.ts, on purpose: a new link REPLACES the live one (hub.ts refuses a healthy duplicate): the old one is closed 4409 and
// the replacement is written to the audit table. Sockets use the Hibernation API, so an idle link costs no duration; the state a socket
// needs lives in its attachment, and an alarm does the pings and the timeouts.

import {
  CONNECT_CLOSE,
  CONNECT_CLOSE_OF,
  CONNECT_LIMITS,
  CONNECT_MUX,
  CONNECT_PROTOCOL,
  CONNECT_PROTOCOL_MIN,
  CONNECT_SUBPROTOCOL,
  connectB64u,
  connectVerifyChallenge,
  type ConnectChallenge,
  type ConnectReject,
  type ConnectRejectCode,
  type ConnectWelcome,
} from '@portal/contracts';
import { muxPing, readMuxHeader } from '../bridge/frames.js';
import { BRIDGE_INTERNAL, notFound } from '../bridge/route.js';
import type { Env } from '../env.js';
import { SchemaDO } from './schema.js';

const BASELINE = 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)';
/** Append only: index i is schema version i + 1. */
const BRIDGE_MIGRATIONS = [
  BASELINE,
  'CREATE TABLE IF NOT EXISTS used_nonce (nonce TEXT PRIMARY KEY, at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS bridge_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, conn_id TEXT, detail TEXT)',
] as const;

/** Unauthenticated sockets one cluster may hold at once (each one already passed the bearer token). */
const PENDING_MAX = 8;
/** How long a used nonce is remembered (far past any challenge's life). */
const NONCE_KEEP_MS = 3_600_000;
/** lastReceived is written at most this often (each write is an attachment serialisation). */
const SEEN_EVERY_MS = 1_000;

interface Pending {
  stage: 'pending' | 'verifying';
  connId: string;
  nonce: string;
  issuedAt: number;
  cluster: string;
  node: string;
  publicKey: string;
}

interface Live {
  stage: 'live';
  connId: string;
  cluster: string;
  node: string;
  since: number;
  lastReceived: number;
}

type Attachment = Pending | Live;

export interface BridgeAuditRow {
  at: number;
  event: string;
  connId: string | null;
  detail: string | null;
}

export interface BridgeLinks {
  live: number;
  pending: number;
}

const attachment = (ws: WebSocket): Attachment | null => (ws.deserializeAttachment() as Attachment | null) ?? null;
const textBytes = (s: string): number => new TextEncoder().encode(s).length;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export class BridgeDO extends SchemaDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, 'bridge', BRIDGE_MIGRATIONS);
  }

  /** The upgrade, already authorised by the Worker (bridge/route.ts). */
  override async fetch(req: Request): Promise<Response> {
    const cluster = req.headers.get(BRIDGE_INTERNAL.cluster);
    const node = req.headers.get(BRIDGE_INTERNAL.node);
    const publicKey = req.headers.get(BRIDGE_INTERNAL.key);
    if (!cluster || !node || !publicKey || (req.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') return notFound();

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    const pending: Pending = {
      stage: 'pending',
      connId: crypto.randomUUID(),
      nonce: connectB64u(crypto.getRandomValues(new Uint8Array(32))),
      issuedAt: now,
      cluster,
      node,
      publicKey,
    };
    server.serializeAttachment(pending);

    if (this.#count().pending > PENDING_MAX) {
      this.#reject(server, pending.connId, 'rate_limited', 'Too many links are opening for this cluster.');
    } else {
      const challenge: ConnectChallenge = {
        t: 'challenge',
        v: 1,
        connId: pending.connId,
        nonce: pending.nonce,
        serverTime: new Date(now).toISOString(),
        protocol: { min: CONNECT_PROTOCOL_MIN, max: CONNECT_PROTOCOL },
      };
      server.send(JSON.stringify(challenge));
      await this.#scheduleAt(now + CONNECT_LIMITS.handshakeMs);
    }
    return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': CONNECT_SUBPROTOCOL } });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = attachment(ws);
    if (!att) return ws.close(CONNECT_CLOSE.internal, 'No state for this link.');
    if (att.stage === 'live') return this.#onFrame(ws, att, message);
    if (att.stage === 'verifying') return this.#reject(ws, att.connId, 'bad_request', 'Send nothing until the answer.');
    return this.#onAuth(ws, att, message);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const att = attachment(ws);
    if (att?.stage === 'live') this.#audit('bridge.closed', att.connId, `code ${code}`);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const att = attachment(ws);
    if (att?.stage === 'live') this.#audit('bridge.error', att.connId, null);
  }

  /** Pings live links, ends silent ones, and ends handshakes that ran out of time. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    let next = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachment(ws);
      if (!att) continue;
      if (att.stage === 'live') {
        if (now - att.lastReceived > CONNECT_LIMITS.deadAfterMs) {
          this.#audit('bridge.dead', att.connId, `silent ${now - att.lastReceived} ms`);
          ws.serializeAttachment(null);
          ws.close(CONNECT_CLOSE.timeout, 'No answer to pings.');
          continue;
        }
        ws.send(muxPing(false, Math.floor(now / 1000)));
        next = Math.min(next, now + CONNECT_LIMITS.pingEveryMs);
      } else if (now - att.issuedAt >= CONNECT_LIMITS.handshakeMs) {
        this.#reject(ws, att.connId, 'bad_request', 'No auth arrived in time.');
      } else {
        next = Math.min(next, att.issuedAt + CONNECT_LIMITS.handshakeMs);
      }
    }
    this.ctx.storage.sql.exec('DELETE FROM used_nonce WHERE at < ?', now - NONCE_KEEP_MS);
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }

  /** The links held now (RPC, for the status page and tests). */
  links(): BridgeLinks {
    return this.#count();
  }

  /** The latest audit rows, newest first (RPC). */
  audit(limit = 50): BridgeAuditRow[] {
    return this.ctx.storage.sql
      .exec<{ at: number; event: string; conn_id: string | null; detail: string | null }>(
        'SELECT at, event, conn_id, detail FROM bridge_audit ORDER BY id DESC LIMIT ?',
        Math.min(Math.max(1, limit), 500),
      )
      .toArray()
      .map((r) => ({ at: r.at, event: r.event, connId: r.conn_id, detail: r.detail }));
  }

  async #onAuth(ws: WebSocket, att: Pending, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return this.#reject(ws, att.connId, 'bad_request', 'The first message must be text.');
    if (textBytes(message) > CONNECT_LIMITS.preAuth.firstMessageBytes)
      return this.#reject(ws, att.connId, 'bad_request', 'The auth message is too large.');
    let auth: unknown;
    try {
      auth = JSON.parse(message);
    } catch {
      return this.#reject(ws, att.connId, 'bad_request', 'The auth message is not JSON.');
    }
    if (!isObject(auth) || auth.t !== 'auth' || typeof auth.node !== 'string' || typeof auth.sig !== 'string' || !isObject(auth.hello)) {
      return this.#reject(ws, att.connId, 'bad_request', 'The auth message is not understood.');
    }
    if (Date.now() - att.issuedAt > CONNECT_LIMITS.handshakeMs)
      return this.#reject(ws, att.connId, 'bad_request', 'The challenge expired.');

    // A nonce is good for one answer, whatever that answer is.
    const sql = this.ctx.storage.sql;
    if (sql.exec('SELECT 1 FROM used_nonce WHERE nonce = ?', att.nonce).toArray().length > 0)
      return this.#reject(ws, att.connId, 'bad_request', 'The challenge was already answered.');
    sql.exec('INSERT INTO used_nonce (nonce, at) VALUES (?, ?)', att.nonce, Date.now());

    ws.serializeAttachment({ ...att, stage: 'verifying' } satisfies Pending);
    // Verified even when the node is wrong, so both refusals take the same time.
    const signed = await connectVerifyChallenge(att.publicKey, auth.sig, att.connId, att.nonce, auth.node);
    if (auth.node !== att.node) return this.#reject(ws, att.connId, 'unknown_node', 'This node is not the cluster’s.');
    if (!signed) return this.#reject(ws, att.connId, 'bad_signature', 'The signature does not match.');
    const protocol = auth.hello.protocol;
    if (typeof protocol !== 'number' || protocol < CONNECT_PROTOCOL_MIN || protocol > CONNECT_PROTOCOL) {
      return this.#reject(
        ws,
        att.connId,
        'upgrade_required',
        `This portal speaks protocol ${CONNECT_PROTOCOL_MIN} to ${CONNECT_PROTOCOL}.`,
      );
    }

    // One live link per cluster: the new one wins.
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const o = attachment(other);
      if (o?.stage !== 'live') continue;
      other.serializeAttachment(null);
      other.close(CONNECT_CLOSE.alreadyConnected, 'Replaced by a newer link.');
      this.#audit('bridge.replaced', o.connId, `by ${att.connId}`);
    }

    const now = Date.now();
    ws.serializeAttachment({
      stage: 'live',
      connId: att.connId,
      cluster: att.cluster,
      node: att.node,
      since: now,
      lastReceived: now,
    } satisfies Live);
    const welcome: ConnectWelcome = {
      t: 'welcome',
      v: 1,
      node: att.node,
      target: att.cluster,
      portalId: null,
      portalVersion: this.env.CP_VERSION,
      agentBuild: '',
      protocol: CONNECT_PROTOCOL,
      heartbeat: { pingEveryMs: CONNECT_LIMITS.pingEveryMs, deadAfterMs: CONNECT_LIMITS.deadAfterMs },
    };
    ws.send(JSON.stringify(welcome));
    this.#audit('bridge.connected', att.connId, null);
    await this.#scheduleAt(now + CONNECT_LIMITS.pingEveryMs);
  }

  #onFrame(ws: WebSocket, att: Live, message: string | ArrayBuffer): void {
    if (typeof message === 'string') {
      this.#audit('bridge.protocol', att.connId, 'text after the handshake');
      return ws.close(1002, 'Only mux frames after the handshake.');
    }
    const now = Date.now();
    if (now - att.lastReceived >= SEEN_EVERY_MS) ws.serializeAttachment({ ...att, lastReceived: now } satisfies Live);
    const h = readMuxHeader(message);
    if (!h) return; // a frame split over messages: the stream relay (next slice) reassembles; liveness is all phase 1 needs
    if (h.version !== CONNECT_MUX.version) {
      this.#audit('bridge.protocol', att.connId, `frame version ${h.version}`);
      return ws.close(1002, 'Unknown frame version.');
    }
    if (h.type === CONNECT_MUX.type.ping && h.streamId === 0 && h.flags & CONNECT_MUX.flag.syn) ws.send(muxPing(true, h.length));
    else if (h.type === CONNECT_MUX.type.goAway) ws.close(1000, 'Go away.');
  }

  #reject(ws: WebSocket, connId: string, code: ConnectRejectCode, message: string): void {
    const reject: ConnectReject = { t: 'reject', code, message };
    try {
      ws.send(JSON.stringify(reject));
      ws.serializeAttachment(null);
      ws.close(CONNECT_CLOSE_OF[code], message.slice(0, 100));
    } catch {
      // the socket is already gone
    }
    this.#audit('bridge.rejected', connId, code);
  }

  #count(): BridgeLinks {
    let live = 0;
    let pending = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachment(ws);
      if (att?.stage === 'live') live++;
      else if (att) pending++;
    }
    return { live, pending };
  }

  #audit(event: string, connId: string | null, detail: string | null): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO bridge_audit (at, event, conn_id, detail) VALUES (?, ?, ?, ?)',
      Date.now(),
      event,
      connId,
      detail,
    );
  }

  async #scheduleAt(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
}
