// The tunnel hub (docs/prd/targets-connect.md §9, §10.4, §10.5): the portal's end of every agent's connection. It upgrades `GET /connect/v1/tunnel`,
// authenticates the agent by a signed challenge (no clock, no secret on the wire), keeps one live connection per node, opens the `control` stream's
// accept side, ingests status and logs, and hands the rest of the portal one `NodeLink` per node to open `docker`, `kube` and `host` streams with.
//
//   upgrade ── Origin? (403) ── subprotocol? (400) ── pre-auth bounds (429) ── 101 ── challenge ── auth ── welcome | reject ── mux frames
//
// Everything an agent says is untrusted (agentText.ts); nothing it says can make the portal open a connection anywhere; it can open exactly one
// stream, `control`, and the portal answers `bad_open` to any other (FR23).

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CONNECT_CLOSE,
  CONNECT_CLOSE_OF,
  CONNECT_LIMITS,
  CONNECT_PROTOCOL,
  CONNECT_PROTOCOL_MIN,
  CONNECT_PUBLIC,
  CONNECT_SUBPROTOCOL,
  type ConnectAgentHello,
  type ConnectChallenge,
  type ConnectConfigMessage,
  type ConnectHostOpen,
  type ConnectPortalMessage,
  type ConnectReject,
  type ConnectRejectCode,
  type ConnectStatusMessage,
  type ConnectWelcome,
} from '@portal/contracts';
import { RateLimiter } from '../rateLimit.js';
import { cleanHello, cleanLog, cleanStatus, text } from './agentText.js';
import type { ConnectConfig } from './config.js';
import { agentActor, type ConnectEvents } from './events.js';
import type { LiveSource, NodeLive, Registry } from './registry.js';
import { ConnectError, type NodeInfo, type NodeLink, type TunnelStream } from './seams.js';
import type { ConnectSettingsStore } from './settings.js';
import type { ConnectStore, NodeRow, NodeSummary } from './store.js';
import {
  MuxSession,
  type MuxCloseInfo,
  type MuxStream,
  acceptService,
  b64u,
  keyFingerprint,
  newConnId,
  newNonce,
  newTrace,
  openService,
  publicKeyProblem,
  readJsonLines,
  spendVerifyTime,
  TUNNEL_WS_OPTIONS,
  verifyChallenge,
  verifyRekey,
  WsMuxSocket,
  writeLine,
} from './tunnel/index.js';

export interface HubDeps {
  store: ConnectStore;
  registry: Registry;
  events: ConnectEvents;
  settings: ConnectSettingsStore;
  config: ConnectConfig;
  portalId(): string | null;
  portalVersion: string;
  bundle(): { build: string };
  /** The client's address: the socket's, or the last `X-Forwarded-For` entry when the portal trusts its proxy (the sign-in's rule). */
  clientIp(req: IncomingMessage): string | null;
  /** The `connect` live topic: something a page shows changed. */
  notify(): void;
  log?(line: string): void;
  now?: () => Date;
  /** Tests shorten these. */
  timing?: Partial<{ handshakeMs: number; openMs: number; revokeGraceMs: number; pingEveryMs: number; deadAfterMs: number }>;
}

const FIRST_MESSAGE_MAX = CONNECT_LIMITS.preAuth.firstMessageBytes;
const ROTATION_WINDOW_MS = 5 * 60_000;
const SUMMARY_EVERY_MS = 60_000;
const DENIED_AUDIT_EVERY_MS = 10 * 60_000;
const LOGS_PER_MINUTE = 20;
const STATUS_BURST = 5;
const STATUS_BURST_MS = 10_000;

const noop = () => undefined;

/**
 * Bounds the size of one message on a socket. The portal's server allows 1 MiB (the mux's `maxPayload`), but before a good `auth` a peer may send
 * 8 KiB at most (PRD FR14): `ws` reads a whole message before it hands it over, so the bound has to be in its receiver. That receiver is
 * internal to `ws`; if a later version moves it, this does nothing and the check on the first message (8 KiB) still refuses the oversize one.
 */
function limitMessages(ws: WebSocket, bytes: number): void {
  const receiver = (ws as unknown as { _receiver?: { _maxPayload?: number } })._receiver;
  if (receiver && typeof receiver._maxPayload === 'number') receiver._maxPayload = bytes;
}

function refuse(socket: Duplex, status: number, text: string, headers: Record<string, string> = {}): void {
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n${extra}Content-Length: 0\r\n\r\n`);
}

/** One live connection of a node. */
interface Conn {
  nodeId: string;
  targetId: string;
  session: MuxSession;
  ws: WebSocket;
  hello: ConnectAgentHello;
  status: ConnectStatusMessage | null;
  connectedAt: string;
  connectedAtMs: number;
  ip: string | null;
  kubeToken: string | null;
  control: MuxStream | null;
  controlPending: boolean;
  clockSkewS: number | null;
  /** Why this connection was ended on purpose (a revoke, a removed target, a shutdown). */
  ended: 'revoked' | 'target_removed' | 'shutdown' | 'replaced' | null;
  bye: string | null;
  statusTimes: number[];
  logTimes: number[];
  lastSummaryAt: number;
  signature: string;
  ignoredTypes: Set<string>;
}

/** The NodeLink of one node: exists for every enrolled node, connected or not. */
export class HubLink implements NodeLink {
  readonly #listeners = new Set<(connected: boolean) => void>();

  constructor(
    readonly nodeId: string,
    readonly targetId: string,
    private readonly hub: Hub,
  ) {}

  connected(): boolean {
    return this.hub.isConnected(this.nodeId);
  }

  async open(service: 'docker' | 'kube' | 'host', args?: ConnectHostOpen, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<TunnelStream> {
    const conn = this.hub.connection(this.nodeId);
    if (!conn || conn.session.closed) throw new ConnectError('agent_offline', 'The node is offline.');
    if (service === 'host' && !args) throw new ConnectError('bad_open', 'A host stream needs its operation.');
    return openService(conn.session, { service, ...(args ? { args } : {}), trace: newTrace() }, { timeoutMs: opts?.timeoutMs, signal: opts?.signal });
  }

  info(): NodeInfo | null {
    const c = this.hub.connection(this.nodeId);
    return c ? { hello: c.hello, status: c.status, connectedAt: c.connectedAt, rttMs: c.session.rttMs, ip: c.ip } : null;
  }

  onChange(fn: (connected: boolean) => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  kubeToken(): string | null {
    return this.hub.connection(this.nodeId)?.kubeToken ?? null;
  }

  /** The hub says the connection came or went. */
  fire(connected: boolean): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn(connected);
      } catch (e) {
        console.error(`[connect] a link listener failed: ${(e as Error).message}`);
      }
    }
  }
}

export class Hub implements LiveSource {
  readonly #conns = new Map<string, Conn>();
  readonly #links = new Map<string, HubLink>();
  readonly #pre = new Map<string, number>();
  #preTotal = 0;
  readonly #upgrades = new RateLimiter(CONNECT_LIMITS.preAuth.upgradesPerIpPerMinute, 60_000);
  readonly #connectedListeners = new Set<(targetId: string, nodeId: string) => void>();
  readonly #disconnectedListeners = new Set<(targetId: string, nodeId: string) => void>();
  readonly #rotating = new Map<string, number>();
  readonly #denialAudited = new Map<string, number>();
  readonly #everConnected = new Set<string>();
  readonly #wss: WebSocketServer;
  readonly #now: () => Date;
  readonly #log: (line: string) => void;
  #server: Server | null = null;
  #onUpgrade: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null;

  constructor(private readonly d: HubDeps) {
    this.#now = d.now ?? (() => new Date());
    this.#log = d.log ?? ((line) => console.log(line));
    this.#wss = new WebSocketServer({
      noServer: true,
      ...TUNNEL_WS_OPTIONS,
      handleProtocols: (protocols) => (protocols.has(CONNECT_SUBPROTOCOL) ? CONNECT_SUBPROTOCOL : false),
    });
  }

  // ---- what the rest of the portal asks ---------------------------------------------------------------------------------------------

  /** The link of a node (created on first ask, for any enrolled node). */
  link(node: Pick<NodeRow, 'id' | 'targetId'>): HubLink {
    let l = this.#links.get(node.id);
    if (!l) this.#links.set(node.id, (l = new HubLink(node.id, node.targetId, this)));
    return l;
  }

  connection(nodeId: string): Conn | null {
    const c = this.#conns.get(nodeId);
    return c && !c.session.closed ? c : null;
  }

  isConnected(nodeId: string): boolean {
    return !!this.connection(nodeId);
  }

  /** Whether the node has connected at least once since the portal started (`settled`). */
  hasConnectedSinceStart(nodeId: string): boolean {
    return this.#everConnected.has(nodeId);
  }

  state(nodeId: string): NodeLive | null {
    const c = this.connection(nodeId);
    return c ? { connected: true, connectedAt: c.connectedAt, hello: c.hello, status: c.status, rttMs: c.session.rttMs, ip: c.ip, clockSkewS: c.clockSkewS } : null;
  }

  /** Called for every node that connects (the module's `onReturned` and `settled`). */
  onConnected(fn: (targetId: string, nodeId: string) => void): () => void {
    this.#connectedListeners.add(fn);
    return () => void this.#connectedListeners.delete(fn);
  }

  /** Called for every node whose connection ends (the module's `onLost`); not when a newer connection of the same node took its place, nor when the hub itself is closing. */
  onDisconnected(fn: (targetId: string, nodeId: string) => void): () => void {
    this.#disconnectedListeners.add(fn);
    return () => void this.#disconnectedListeners.delete(fn);
  }

  get connections(): number {
    let n = 0;
    for (const c of this.#conns.values()) if (!c.session.closed) n++;
    return n;
  }

  /** Sockets that have not authenticated yet (for tests and diagnostics). */
  get preAuth(): number {
    return this.#preTotal;
  }

  // ---- the upgrade -------------------------------------------------------------------------------------------------------------------

  attach(server: Server): void {
    this.#server = server;
    this.#onUpgrade = (req, socket, head) => this.#upgrade(req, socket, head);
    server.on('upgrade', this.#onUpgrade);
  }

  #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== CONNECT_PUBLIC.tunnel) return; // not ours
    if (!this.d.config.enabled) return refuse(socket, 404, 'Not Found'); // the kill switch (FR61)
    if (req.method !== 'GET') return refuse(socket, 405, 'Method Not Allowed');
    // Agents are not browsers: a page must never be able to act as one.
    if (req.headers.origin !== undefined) return refuse(socket, 403, 'Forbidden');
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
    if (!offered.includes(CONNECT_SUBPROTOCOL)) return refuse(socket, 400, 'Bad Request');
    const ip = this.d.clientIp(req) ?? 'unknown';
    if (this.#preTotal >= CONNECT_LIMITS.preAuth.total || (this.#pre.get(ip) ?? 0) >= CONNECT_LIMITS.preAuth.perIp) return refuse(socket, 429, 'Too Many Requests', { 'Retry-After': '5' });
    const limited = this.#upgrades.blocked(ip);
    this.#upgrades.fail(ip); // every upgrade counts
    socket.on('error', noop);
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, ip, limited));
  }

  #accept(ws: WebSocket, ip: string, limited: boolean): void {
    ws.on('error', noop);
    limitMessages(ws, FIRST_MESSAGE_MAX);
    this.#pre.set(ip, (this.#pre.get(ip) ?? 0) + 1);
    this.#preTotal++;
    let counted = true;
    const release = () => {
      if (!counted) return;
      counted = false;
      this.#preTotal--;
      const n = (this.#pre.get(ip) ?? 1) - 1;
      if (n <= 0) this.#pre.delete(ip);
      else this.#pre.set(ip, n);
    };
    ws.once('close', release);
    const reject = (code: ConnectRejectCode, message: string, retryAfterS?: number, audit?: { node?: NodeRow; type?: 'node.auth_failed' }) => {
      this.#reject(ws, code, message, retryAfterS);
      if (audit) {
        this.d.events.record({ type: 'node.auth_failed', targetId: audit.node?.targetId ?? null, nodeId: audit.node?.id ?? null, actor: 'anonymous', ip, detail: { reason: code } });
      }
    };
    if (limited) return reject('rate_limited', 'Too many connections from this address. Wait a minute.', 60);

    const challenge: ConnectChallenge = { t: 'challenge', v: 1, connId: newConnId(), nonce: newNonce(), serverTime: this.#now().toISOString(), protocol: { min: CONNECT_PROTOCOL_MIN, max: CONNECT_PROTOCOL } };
    const timer = setTimeout(() => reject('bad_request', 'No auth arrived in time.'), this.d.timing?.handshakeMs ?? CONNECT_LIMITS.handshakeMs);
    timer.unref();
    ws.once('close', () => clearTimeout(timer));
    ws.once('message', (data, isBinary) => {
      clearTimeout(timer);
      const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (isBinary) return reject('bad_request', 'Frames before the handshake finished.');
      if (buf.length > FIRST_MESSAGE_MAX) return reject('bad_request', 'The first message is too long.');
      let msg: unknown;
      try {
        msg = JSON.parse(buf.toString('utf8'));
      } catch {
        return reject('bad_request', 'The first message is not JSON.');
      }
      try {
        this.#authenticate(ws, ip, challenge, msg, release, reject);
      } catch (e) {
        this.#log(`[connect] handshake failed: ${(e as Error).message}`);
        reject('bad_request', 'The handshake could not be completed.');
      }
    });
    ws.send(JSON.stringify(challenge));
  }

  #reject(ws: WebSocket, code: ConnectRejectCode, message: string, retryAfterS?: number): void {
    const body: ConnectReject = { t: 'reject', code, message, ...(retryAfterS !== undefined ? { retryAfterS } : {}) };
    try {
      ws.send(JSON.stringify(body), () => ws.close(CONNECT_CLOSE_OF[code], code));
    } catch {
      ws.terminate();
    }
    setTimeout(() => ws.terminate(), 2_000).unref();
  }

  /**
   * The order is the PRD's and each step costs about the same whichever fails (a failure before the signature check spends a verification
   * on a dummy key): the first message is `auth` (and fits 8 KiB); the node exists and is not revoked; its target exists; the agent's
   * protocol is accepted; the signature verifies against the current key, or the previous one inside the rotation grace; no healthy
   * connection exists; the store allows the `last_seen` write or is read only (the connection is then allowed without it).
   */
  #authenticate(
    ws: WebSocket,
    ip: string,
    challenge: ConnectChallenge,
    msg: unknown,
    release: () => void,
    reject: (code: ConnectRejectCode, message: string, retryAfterS?: number, audit?: { node?: NodeRow }) => void,
  ): void {
    const a = msg && typeof msg === 'object' ? (msg as Record<string, unknown>) : null;
    if (!a || a.t !== 'auth' || typeof a.node !== 'string') return reject('bad_request', 'The first message must be auth.');
    if (!this.d.store.db) return reject('store_locked', 'The portal’s store is not available. Try again shortly.', 30);
    const node = /^nd_[0-9a-f]{12}$/.test(a.node) ? this.d.registry.node(a.node) : null;
    const now = this.#now();
    const hello = cleanHello(a.hello, now);
    const sig = typeof a.sig === 'string' ? a.sig : '';

    let failure: { code: ConnectRejectCode; message: string } | null = null;
    if (!node) {
      failure = this.d.settings.removedNode(a.node) ? { code: 'target_removed', message: 'The target of this node was removed. Remove the agent, or enroll it again on another target.' } : { code: 'unknown_node', message: 'The portal does not know this node. It was removed, or the portal was restored from an older backup: enroll again.' };
    } else if (node.revokedAt) failure = { code: 'revoked', message: 'This node was revoked. Enroll again to use this machine.' };
    else if (!this.d.registry.target(node.targetId)) failure = { code: 'target_removed', message: 'The target of this node was removed.' };
    else if (!hello) failure = { code: 'bad_request', message: 'The hello is not understood.' };
    else if (hello.protocol < CONNECT_PROTOCOL_MIN) failure = { code: 'upgrade_required', message: `This agent speaks protocol ${hello.protocol}; the portal needs ${CONNECT_PROTOCOL_MIN} or newer. Upgrade the agent.` };
    else if (hello.protocol > CONNECT_PROTOCOL) failure = { code: 'bad_request', message: `This agent speaks protocol ${hello.protocol}; this portal speaks up to ${CONNECT_PROTOCOL}. Update the portal.` };

    let usedKey: 'current' | 'previous' | null = null;
    if (failure) spendVerifyTime();
    else if (node) {
      if (verifyChallenge(node.publicKey, sig, challenge.connId, challenge.nonce, node.id)) usedKey = 'current';
      else if (node.prevPublicKey && node.rotatedAt && now.getTime() - Date.parse(node.rotatedAt) < CONNECT_LIMITS.rekeyGraceMs && verifyChallenge(node.prevPublicKey, sig, challenge.connId, challenge.nonce, node.id)) usedKey = 'previous';
      else failure = { code: 'bad_signature', message: 'The signature does not match the node’s key.' };
    }
    if (failure || !node || !hello || !usedKey) {
      const f = failure ?? { code: 'bad_request' as const, message: 'The handshake could not be completed.' };
      return reject(f.code, f.message, f.code === 'rate_limited' ? 60 : undefined, { node: node ?? undefined });
    }

    const existing = this.#conns.get(node.id);
    if (existing && !existing.session.closed) {
      const silentMs = Date.now() - existing.session.lastReceivedAt;
      if (silentMs < (this.d.timing?.deadAfterMs ?? CONNECT_LIMITS.deadAfterMs)) {
        this.d.events.record({ type: 'node.duplicate_refused', targetId: node.targetId, nodeId: node.id, actor: agentActor(node.id), ip, detail: { existingIp: existing.ip, existingSinceS: Math.round((now.getTime() - existing.connectedAtMs) / 1000) } });
        return reject('already_connected', 'This node is already connected. If two agents share one identity, revoke the node and enroll again.');
      }
      existing.ended = 'replaced'; // silent for 45 seconds: it is dead, this one takes over
      existing.session.close(CONNECT_CLOSE.alreadyConnected, 'replaced');
    }

    // ---- accepted ------------------------------------------------------------------------------------------------------------------
    release();
    limitMessages(ws, CONNECT_LIMITS.wsMaxPayload);
    const targetKind = this.d.registry.requireTarget(node.targetId).kind;
    const conn: Conn = {
      nodeId: node.id,
      targetId: node.targetId,
      session: undefined as unknown as MuxSession,
      ws,
      hello,
      status: null,
      connectedAt: now.toISOString(),
      connectedAtMs: Date.now(),
      ip,
      kubeToken: targetKind === 'kubernetes' ? b64u(randomBytes(32)) : null,
      control: null,
      controlPending: false,
      clockSkewS: Number.isFinite(Date.parse(hello.clock)) ? Math.round((Date.parse(hello.clock) - now.getTime()) / 1000) : null,
      ended: null,
      bye: null,
      statusTimes: [],
      logTimes: [],
      lastSummaryAt: now.getTime(),
      signature: '',
      ignoredTypes: new Set(),
    };
    // The session takes over the socket in this very turn: frames may follow the welcome in the same read.
    conn.session = new MuxSession({
      role: 'server',
      socket: new WsMuxSocket(ws),
      onStream: (s) => this.#onStream(conn, s),
      limits: { ...(this.d.timing?.pingEveryMs ? { pingEveryMs: this.d.timing.pingEveryMs } : {}), ...(this.d.timing?.deadAfterMs ? { deadAfterMs: this.d.timing.deadAfterMs } : {}) },
      closeError: (reason) => new ConnectError('agent_offline', `The tunnel to the node dropped (${reason}).`),
      log: (line) => this.#log(`[connect] ${node.id} ${line}`),
    });
    this.#conns.set(node.id, conn);
    const welcome: ConnectWelcome = {
      t: 'welcome',
      v: 1,
      node: node.id,
      target: node.targetId,
      portalId: this.d.portalId(),
      portalVersion: this.d.portalVersion,
      agentBuild: this.d.bundle().build,
      protocol: hello.protocol,
      heartbeat: { pingEveryMs: this.d.timing?.pingEveryMs ?? CONNECT_LIMITS.pingEveryMs, deadAfterMs: this.d.timing?.deadAfterMs ?? CONNECT_LIMITS.deadAfterMs },
    };
    ws.send(JSON.stringify(welcome));
    conn.session.onClose((info) => this.#closed(conn, info));

    this.#everConnected.add(node.id);
    const summary = this.#summary(node, conn);
    if (this.d.store.canWrite) {
      this.d.store.updateNode(node.id, {
        agentVersion: hello.agentVersion,
        agentBuild: hello.agentBuild,
        protocol: hello.protocol,
        os: hello.os,
        arch: hello.arch,
        lastSeenAt: now.toISOString(),
        lastIp: ip,
        info: summary,
        ...(usedKey === 'current' && node.prevPublicKey ? { prevPublicKey: null, rotatedAt: node.rotatedAt } : {}),
      });
    }
    this.d.events.record({ type: 'node.connected', targetId: node.targetId, nodeId: node.id, actor: agentActor(node.id), ip, detail: { version: hello.agentVersion, build: hello.agentBuild, os: hello.os, arch: hello.arch, skewS: conn.clockSkewS, key: usedKey } });
    if (hello.agentBuild && hello.agentBuild !== this.d.bundle().build) this.d.events.record({ type: 'node.outdated', targetId: node.targetId, nodeId: node.id, actor: 'system', detail: { agentBuild: hello.agentBuild, portalBuild: this.d.bundle().build } });
    this.#log(`[connect] node ${node.id} connected (${hello.mode}, build ${hello.agentBuild.slice(0, 8)})`);
    const link = this.link(node);
    link.fire(true);
    for (const fn of [...this.#connectedListeners]) {
      try {
        fn(node.targetId, node.id);
      } catch (e) {
        console.error(`[connect] a connect listener failed: ${(e as Error).message}`);
      }
    }
    this.d.notify();
  }

  #summary(node: NodeRow, conn: Conn): NodeSummary {
    const status = conn.status;
    const summary: NodeSummary = {
      hostname: conn.hello.hostname,
      mode: conn.hello.mode,
      runtime: conn.hello.runtime,
      services: status?.services ?? conn.hello.services,
      clockSkewS: conn.clockSkewS,
    };
    const swarm = status?.swarm ?? conn.hello.swarm;
    if (swarm) summary.swarm = swarm;
    if (status?.docker) {
      summary.engine = status.docker.engine;
      summary.containers = status.docker.containers;
    }
    void node;
    return summary;
  }

  // ---- the control stream ------------------------------------------------------------------------------------------------------------

  #onStream(conn: Conn, stream: MuxStream): void {
    void acceptService(
      stream,
      (req) => {
        if (req.service !== 'control') return { ok: false, code: 'bad_open', message: 'The portal opens every stream but control; an agent opens only control.' };
        if (conn.control || conn.controlPending) return { ok: false, code: 'bad_open', message: 'The control stream is already open.' };
        conn.controlPending = true;
        return { ok: true };
      },
      { timeoutMs: this.d.timing?.openMs },
    ).then((req) => {
      if (!req) return;
      conn.control = stream;
      void this.#runControl(conn, stream);
    });
  }

  async #send(conn: Conn, msg: ConnectPortalMessage): Promise<void> {
    const stream = conn.control;
    if (!stream || stream.destroyed) return;
    try {
      await writeLine(stream, msg, CONNECT_LIMITS.maxControlLine);
    } catch {
      // the connection is going away: its close handler does the rest
    }
  }

  async #runControl(conn: Conn, stream: MuxStream): Promise<void> {
    const config: ConnectConfigMessage = {
      t: 'config',
      portalId: this.d.portalId(),
      statusEveryS: CONNECT_LIMITS.statusEveryS,
      limits: { ...CONNECT_LIMITS.serviceStreams },
      ...(conn.kubeToken ? { kubeLocalToken: conn.kubeToken } : {}),
      agentBuild: this.d.bundle().build,
    };
    await this.#send(conn, config);
    try {
      for await (const raw of readJsonLines(stream, CONNECT_LIMITS.maxControlLine)) {
        if (conn.session.closed) return;
        this.#onControl(conn, raw);
      }
      // the agent ended its control stream: it lives with the connection, so the connection ends
      if (!conn.session.closed) conn.session.close(1000, 'control closed');
    } catch (e) {
      if (conn.session.closed) return;
      // a line over 256 KiB or one that is not JSON closes the stream and the connection (PRD §9.5)
      this.#log(`[connect] node ${conn.nodeId} sent an unusable control line (${(e as Error).name})`);
      conn.session.close(1002, 'bad control line');
    }
  }

  #onControl(conn: Conn, raw: unknown): void {
    const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const now = Date.now();
    switch (m?.t) {
      case 'status': {
        conn.statusTimes = conn.statusTimes.filter((t) => now - t < STATUS_BURST_MS);
        if (conn.statusTimes.length >= STATUS_BURST) return; // more than the agent should send: ignored
        conn.statusTimes.push(now);
        const status = cleanStatus(m, this.#now());
        if (status) this.#status(conn, status);
        return;
      }
      case 'log': {
        conn.logTimes = conn.logTimes.filter((t) => now - t < 60_000);
        if (conn.logTimes.length >= LOGS_PER_MINUTE) return;
        conn.logTimes.push(now);
        const log = cleanLog(m, this.#now());
        if (log) this.d.events.record({ type: 'agent.log', targetId: conn.targetId, nodeId: conn.nodeId, actor: agentActor(conn.nodeId), ip: conn.ip, detail: { level: log.level, message: log.message } });
        return;
      }
      case 'rekey':
        void this.#rekey(conn, m);
        return;
      case 'bye': {
        const reason = m.reason === 'shutdown' || m.reason === 'upgrade' || m.reason === 'uninstall' || m.reason === 'error' ? m.reason : 'shutdown';
        conn.bye = reason;
        const node = this.d.registry.node(conn.nodeId);
        if (node && this.d.store.canWrite) this.d.store.updateNode(conn.nodeId, { info: { ...node.info, bye: reason } });
        return;
      }
      default: {
        const type = typeof m?.t === 'string' ? text(m.t, 30) : '?';
        if (conn.ignoredTypes.size < 20 && !conn.ignoredTypes.has(type)) {
          conn.ignoredTypes.add(type);
          this.#log(`[connect] node ${conn.nodeId} sent a control message this portal does not know (${type}); ignored`);
        }
      }
    }
  }

  #status(conn: Conn, status: ConnectStatusMessage): void {
    conn.status = status;
    const sig = JSON.stringify([status.services.map((s) => [s.name, s.ok, s.error ?? '']), status.docker?.containers, status.docker?.running, status.swarm?.role, status.denied?.length ?? 0]);
    const changed = sig !== conn.signature;
    conn.signature = sig;
    const now = Date.now();
    for (const d of status.denied ?? []) this.#denied(conn, d.rule, d.count, now);
    if (now - conn.lastSummaryAt >= SUMMARY_EVERY_MS) {
      conn.lastSummaryAt = now;
      const node = this.d.registry.node(conn.nodeId);
      if (node) this.d.store.touchNode(conn.nodeId, this.#now().toISOString(), conn.ip, this.#summary(node, conn));
    }
    if (changed) this.d.notify();
  }

  /** Denials are counted in `status`; the audit hears of each rule at most once in ten minutes per node. */
  #denied(conn: Conn, rule: string, count: number, now: number): void {
    const key = `${conn.nodeId}:${rule}`;
    if (now - (this.#denialAudited.get(key) ?? 0) < DENIED_AUDIT_EVERY_MS) return;
    this.#denialAudited.set(key, now);
    if (this.#denialAudited.size > 2_000) this.#denialAudited.clear();
    this.d.events.record({ type: 'policy.denied', targetId: conn.targetId, nodeId: conn.nodeId, actor: agentActor(conn.nodeId), ip: conn.ip, detail: { rule, count } });
  }

  /** The agent's half of a rotation (PRD §10.4): the new public key, signed with the OLD key; only while an admin has asked for one. */
  async #rekey(conn: Conn, m: Record<string, unknown>): Promise<void> {
    const node = this.d.registry.node(conn.nodeId);
    const fail = async (reason: string) => {
      this.d.events.record({ type: 'node.rotation_failed', targetId: conn.targetId, nodeId: conn.nodeId, actor: agentActor(conn.nodeId), ip: conn.ip, detail: { reason } });
      await this.#send(conn, { t: 'rekey-answer', ok: false, reason });
    };
    const publicKey = typeof m.publicKey === 'string' ? m.publicKey : '';
    const sig = typeof m.sig === 'string' ? m.sig : '';
    const asked = this.#rotating.get(conn.nodeId);
    if (!node || node.revokedAt) return fail('The node is not enrolled.');
    if (asked === undefined || asked < Date.now()) return fail('No rotation was asked for.');
    if (!this.d.store.canWrite) return fail('The portal’s store is read only right now.');
    if (publicKeyProblem(publicKey)) return fail('The new key is not valid.');
    if (publicKey === node.publicKey || publicKey === node.prevPublicKey) return fail('The new key must be a new one.');
    if (!verifyRekey(node.publicKey, sig, node.id, publicKey)) return fail('The signature does not match the current key.');
    this.#rotating.delete(conn.nodeId);
    const at = this.#now().toISOString();
    try {
      this.d.store.tx(() => {
        this.d.store.updateNode(node.id, { prevPublicKey: node.publicKey, publicKey, keyFingerprint: keyFingerprint(publicKey), rotatedAt: at });
        this.d.events.record({ type: 'node.rotated', targetId: node.targetId, nodeId: node.id, actor: agentActor(node.id), ip: conn.ip, detail: { fingerprint: keyFingerprint(publicKey), previous: node.keyFingerprint } });
      });
    } catch (e) {
      this.#log(`[connect] node ${node.id}: the new key could not be stored (${(e as Error).message})`);
      return fail('The new key could not be stored. Nothing changed.');
    }
    await this.#send(conn, { t: 'rekey-answer', ok: true, publicKey });
    this.d.registry.notifyChange({ what: 'node-updated', targetId: node.targetId, nodeId: node.id });
    this.d.notify();
  }

  /** An admin asked for a rotation (`POST /api/connect/nodes/:id/rotate`): tell the connected agent to start one. 409 when it is offline. */
  async rotate(nodeId: string): Promise<void> {
    const conn = this.connection(nodeId);
    if (!conn) throw new ConnectError('agent_offline', 'The node is offline.');
    this.#rotating.set(nodeId, Date.now() + ROTATION_WINDOW_MS);
    await this.#send(conn, { t: 'notice', level: 'info', message: 'Rotate the node key now.', action: 'rotate' });
  }

  // ---- the end of a connection -----------------------------------------------------------------------------------------------------

  /** Ends a node's connection on purpose, with a word the agent will read: it is closed within a second or two whatever the peer does. */
  async disconnect(nodeId: string, why: 'revoked' | 'target_removed' | 'shutdown', message?: string): Promise<void> {
    const conn = this.connection(nodeId);
    if (!conn) return;
    conn.ended = why;
    // whatever the agent does with the message, the socket is gone soon
    setTimeout(() => conn.session.destroy('revoke grace'), this.d.timing?.revokeGraceMs ?? 1_500).unref();
    if (why !== 'shutdown') {
      const told = this.#send(conn, { t: 'revoked', reason: message ?? (why === 'revoked' ? 'This node was revoked.' : 'The target was removed.') });
      await Promise.race([told, new Promise((r) => setTimeout(r, 500).unref())]);
    }
    const code = why === 'revoked' ? CONNECT_CLOSE.unauthorized : why === 'target_removed' ? CONNECT_CLOSE.forbidden : 1001;
    conn.session.close(code, why);
  }

  #closed(conn: Conn, info: MuxCloseInfo): void {
    if (this.#conns.get(conn.nodeId) === conn) this.#conns.delete(conn.nodeId);
    const replaced = conn.ended === 'replaced';
    if (!replaced) this.link({ id: conn.nodeId, targetId: conn.targetId }).fire(false);
    if (!replaced && conn.ended !== 'shutdown') {
      for (const fn of [...this.#disconnectedListeners]) {
        try {
          fn(conn.targetId, conn.nodeId);
        } catch (e) {
          console.error(`[connect] a disconnect listener failed: ${(e as Error).message}`);
        }
      }
    }
    this.#rotating.delete(conn.nodeId);
    if (this.d.store.canWrite) this.d.store.touchNode(conn.nodeId, this.#now().toISOString(), null);
    this.d.events.record({
      type: 'node.disconnected',
      targetId: conn.targetId,
      nodeId: conn.nodeId,
      actor: conn.ended ? 'system' : agentActor(conn.nodeId),
      ip: conn.ip,
      detail: { code: info.code, reason: info.reason, by: conn.ended ?? (info.remote ? 'peer' : 'portal'), seconds: Math.round((Date.now() - conn.connectedAtMs) / 1000), ...(conn.bye ? { bye: conn.bye } : {}) },
    });
    this.#log(`[connect] node ${conn.nodeId} disconnected (${conn.ended ?? info.reason})`);
    this.d.registry.flushSnapshot(conn.targetId); // what the target held when it went quiet is what Unreachable will show
    this.d.notify();
  }

  /** Closes everything and stops listening (the portal is shutting down, or a test is over). */
  close(): void {
    if (this.#server && this.#onUpgrade) this.#server.off('upgrade', this.#onUpgrade);
    for (const c of [...this.#conns.values()]) {
      c.ended = 'shutdown';
      c.session.destroy('shutdown');
    }
    this.#conns.clear();
    this.#wss.close();
  }
}
