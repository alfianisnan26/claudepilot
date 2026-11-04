// BridgeDO (PILOT-1144, D4): one per cluster (`locate(env.BRIDGE, cluster)`), holding the cluster's one live dial-out link from cp-bridge.
// It speaks the Connect handshake of apps/server/src/connect/hub.ts: challenge -> auth -> welcome | reject, the Ed25519 signature checked
// with WebCrypto (`connectVerifyChallenge`, packages/contracts/src/connectSign.ts). After the welcome only binary mux frames flow, into the
// portal's own MuxSession (@portal/connect-tunnel, role server; PILOT-1170), which answers pings and carries the streams the object opens
// (`kube`: HTTP/1.1 written on the stream, src/bridge/http1.ts).
//
// Differences from hub.ts, on purpose: a new link REPLACES the live one (hub.ts refuses a healthy duplicate): the old one is closed 4409 and
// the replacement is written to the audit table. Sockets use the Hibernation API, so an idle link costs no duration; the state a socket
// needs lives in its attachment, and an alarm does the pings and the timeouts:
//  - the session's socket is fed by webSocketMessage / webSocketClose (src/bridge/link.ts), and its 15 s tick is run by the alarm, not a
//    setInterval (a running interval keeps the object from hibernating);
//  - the stream ids used and the streams open are kept in the attachment: an object woken from hibernation rebuilds the session from the
//    ids when no stream was open, and closes the link 1011 when streams were (they are lost; the agent reconnects);
//  - silence is judged by the attachment's lastReceived (it survives hibernation), not by the session's own clock.
// The agent's `control` stream and the `config` message (with the per-link kube bearer) are the next slice; a stream the agent opens is reset.

import { ConnectError } from '@portal/connect-tunnel/errors';
import { MuxSession, type MuxIds } from '@portal/connect-tunnel/mux';
import { openService } from '@portal/connect-tunnel/open';
import {
  CONNECT_CLOSE,
  CONNECT_CLOSE_OF,
  CONNECT_LIMITS,
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
import { ByteReader, readResponse, writeRequest } from '../bridge/http1.js';
import { BRIDGE_LINK, bridgeMuxLimits, hibernatedSocket, type HibernatedSocket } from '../bridge/link.js';
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
/** The close of a link whose streams were lost to hibernation: the agent reconnects. */
const STREAMS_LOST = 1011;
/** How long a kube request may take, from the open to the last body byte. */
const KUBE_REQUEST_MS = 30_000;
/** A path the bridge passes on: origin-form, printable, no spaces (the agent's proxy checks the rest against its allowlist). */
const PATH_RE = /^\/[\x21-\x7e]{0,2047}$/;
const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const BEARER_RE = /^[\x21-\x7e]{1,512}$/;

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
  /** The session's stream ids, for a session rebuilt after hibernation. Absent: none used yet. */
  ids?: MuxIds;
  /** Streams open when the attachment was last written: more than 0 on a woken object means they were lost. */
  streams?: number;
}

type Attachment = Pending | Live;

/** The mux session of a live link, in memory only: gone when the object hibernates, rebuilt from the attachment. */
interface LinkState {
  socket: HibernatedSocket;
  session: MuxSession;
  /** The session's liveness tick (a ping), run by the alarm. */
  tick(): void;
}

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

/** One GET through the agent's `kube` service (RPC). The bearer is the agent's per-link kube bearer: never logged, stored or audited. */
export interface BridgeKubeRequest {
  path: string;
  namespace?: string;
  bearer: string;
}

export type BridgeKubeResponse =
  | { ok: true; status: number; contentType: string | null; body: string }
  | { ok: false; code: string; message: string };

const attachment = (ws: WebSocket): Attachment | null => (ws.deserializeAttachment() as Attachment | null) ?? null;
const textBytes = (s: string): number => new TextEncoder().encode(s).length;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const noop = (): void => undefined;

export class BridgeDO extends SchemaDO {
  /** By connId. Empty after a wake from hibernation: `#linkOf` rebuilds. TS-private, not #: a test clears it to stand in for hibernation. */
  private readonly sessions = new Map<string, LinkState>();

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

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const att = attachment(ws);
    if (att?.stage !== 'live') return;
    this.#audit('bridge.closed', att.connId, `code ${code}`);
    this.#forget(ws);
    this.sessions.get(att.connId)?.socket.ended(code, reason);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const att = attachment(ws);
    if (att?.stage !== 'live') return;
    this.#audit('bridge.error', att.connId, null);
    this.#forget(ws);
    this.sessions.get(att.connId)?.socket.ended(1006, 'socket error');
  }

  /** A closed link is no longer live (getWebSockets may still list it for a moment). */
  #forget(ws: WebSocket): void {
    try {
      ws.serializeAttachment(null);
    } catch {
      // the socket is already gone
    }
  }

  /** Pings live links (the session's tick), ends silent ones, and ends handshakes that ran out of time. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    let next = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachment(ws);
      if (!att) continue;
      if (att.stage === 'live') {
        if (now - att.lastReceived > CONNECT_LIMITS.deadAfterMs) {
          this.#audit('bridge.dead', att.connId, `silent ${now - att.lastReceived} ms`);
          this.#end(ws, att.connId, CONNECT_CLOSE.timeout, 'No answer to pings.');
          continue;
        }
        const link = this.#linkOf(ws, att);
        if (!link) continue;
        link.tick();
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

  /**
   * One GET through the live link to the agent's `kube` service (RPC; no route reaches it yet). The agent's proxy checks the bearer, the
   * namespace and its allowlist; this checks only the shape. The answer body is read into memory, at most BRIDGE_LINK.maxBodyBytes.
   */
  async kube(req: BridgeKubeRequest): Promise<BridgeKubeResponse> {
    if (!isObject(req) || typeof req.path !== 'string' || !PATH_RE.test(req.path))
      return { ok: false, code: 'bad_request', message: 'The path is not valid.' };
    if (req.namespace !== undefined && (typeof req.namespace !== 'string' || !NAMESPACE_RE.test(req.namespace)))
      return { ok: false, code: 'bad_request', message: 'The namespace is not valid.' };
    if (typeof req.bearer !== 'string' || !BEARER_RE.test(req.bearer)) return { ok: false, code: 'bad_request', message: 'The bearer is not valid.' };

    const live = this.#liveSocket();
    const link = live && this.#linkOf(live.ws, live.att);
    if (!live || !link) return { ok: false, code: 'agent_offline', message: 'No live link for this cluster.' };

    let stream: Awaited<ReturnType<typeof openService>>;
    try {
      stream = await openService(link.session, { service: 'kube', ...(req.namespace ? { args: { namespace: req.namespace } } : {}) });
    } catch (e) {
      return e instanceof ConnectError
        ? { ok: false, code: e.code, message: e.message }
        : { ok: false, code: 'internal', message: 'The stream could not be opened.' };
    }
    this.#save(live.ws, link.session);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reader = new ByteReader(stream, BRIDGE_LINK.maxBodyBytes + 64 * 1024);
      writeRequest(stream, { method: 'GET', path: req.path, headers: { Authorization: `Bearer ${req.bearer}`, Accept: 'application/json' } });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ConnectError('timeout', 'The agent did not answer in time.')), KUBE_REQUEST_MS);
      });
      const res = await Promise.race([readResponse(reader, BRIDGE_LINK.maxBodyBytes), timeout]);
      return { ok: true, status: res.status, contentType: res.headers.get('content-type') ?? null, body: res.body.toString('utf8') };
    } catch (e) {
      if (e instanceof ConnectError) return { ok: false, code: e.code, message: e.message };
      return { ok: false, code: link.session.closed ? 'agent_offline' : 'internal', message: (e as Error).message.slice(0, 200) };
    } finally {
      clearTimeout(timer);
      stream.destroy();
      if (!link.session.closed) this.#save(live.ws, link.session);
    }
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
      this.#end(other, o.connId, CONNECT_CLOSE.alreadyConnected, 'Replaced by a newer link.');
      this.#audit('bridge.replaced', o.connId, `by ${att.connId}`);
    }

    const now = Date.now();
    const live: Live = { stage: 'live', connId: att.connId, cluster: att.cluster, node: att.node, since: now, lastReceived: now };
    ws.serializeAttachment(live);
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
    this.#linkOf(ws, live);
    await this.#scheduleAt(now + CONNECT_LIMITS.pingEveryMs);
  }

  #onFrame(ws: WebSocket, att: Live, message: string | ArrayBuffer): void {
    if (typeof message === 'string') {
      this.#audit('bridge.protocol', att.connId, 'text after the handshake');
      return this.#end(ws, att.connId, 1002, 'Only mux frames after the handshake.');
    }
    const link = this.#linkOf(ws, att);
    if (!link) return;
    const now = Date.now();
    if (now - att.lastReceived >= SEEN_EVERY_MS) ws.serializeAttachment({ ...att, lastReceived: now } satisfies Live);
    link.socket.push(message);
    const { session } = link;
    if (session.closed) return;
    if (session.remoteGoAway !== null && session.openStreams === 0) return session.close(1000, 'Go away.');
    this.#save(ws, session);
  }

  /**
   * The session of a live link: the one in memory, or one rebuilt over the link after a wake from hibernation. Null when the link had
   * streams open when it hibernated: they are lost, so the link is closed 1011 and the agent reconnects.
   */
  #linkOf(ws: WebSocket, att: Live): LinkState | null {
    const have = this.sessions.get(att.connId);
    if (have && !have.session.closed) return have;
    if (have) return null;
    if ((att.streams ?? 0) > 0) {
      this.#audit('bridge.lost', att.connId, `${att.streams} streams lost`);
      this.#end(ws, att.connId, STREAMS_LOST, 'Streams were lost; reconnect.');
      return null;
    }
    const socket = hibernatedSocket(ws);
    const state: LinkState = { socket, session: null as unknown as MuxSession, tick: noop };
    // The DO's own check (the attachment's lastReceived) ends a silent link: the session's clock does not survive hibernation.
    const limits = { ...bridgeMuxLimits(), deadAfterMs: Number.MAX_SAFE_INTEGER };
    state.session = new MuxSession({
      role: 'server',
      socket,
      limits,
      ...(att.ids ? { resume: att.ids } : {}),
      timer: (tick) => {
        state.tick = tick;
        return () => void (state.tick = noop);
      },
      closeError: (reason) => new ConnectError('agent_offline', `The bridge link ended: ${reason}`),
      // Mux log lines name events and ids, never payload bytes, keys or tokens.
      log: (line) => this.#audit('bridge.mux', att.connId, line.slice(0, 200)),
    });
    state.session.onClose((info) => {
      this.sessions.delete(att.connId);
      if (info.protocolError) this.#audit('bridge.protocol', att.connId, info.reason.slice(0, 200));
      if (!info.remote) this.#forget(ws);
    });
    this.sessions.set(att.connId, state);
    return state;
  }

  /** Writes the session's ids and open streams into the attachment when they changed (a woken object needs them). */
  #save(ws: WebSocket, session: MuxSession): void {
    const att = attachment(ws);
    if (att?.stage !== 'live') return;
    const ids = session.ids;
    const streams = session.openStreams;
    if (att.ids?.nextId === ids.nextId && att.ids.lastRemoteId === ids.lastRemoteId && (att.streams ?? 0) === streams) return;
    ws.serializeAttachment({ ...att, ids, streams } satisfies Live);
  }

  #liveSocket(): { ws: WebSocket; att: Live } | null {
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachment(ws);
      if (att?.stage === 'live') return { ws, att };
    }
    return null;
  }

  /** Ends a live link from this side: its session (streams fail), its state, the socket. */
  #end(ws: WebSocket, connId: string, code: number, reason: string): void {
    const link = this.sessions.get(connId);
    this.sessions.delete(connId);
    try {
      ws.serializeAttachment(null);
      ws.close(code, reason);
    } catch {
      // the socket is already gone
    }
    link?.socket.ended(code, reason);
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
