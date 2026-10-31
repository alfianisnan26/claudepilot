// Test support for Connect (not imported by the portal): a real SQLite store in a temporary directory, the registry, the enrollment service and a
// clock the test moves. The hub and the routes tests build on `createConnect` instead (index.ts); this is the core without them.

import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { RateLimiter } from '../rateLimit.js';
import { CONNECT_LIMITS, type ConnectAgentHello, type ConnectKind, type WorkspaceTarget } from '@portal/contracts';
import { DEFAULT_BASE_IMAGE, DEFAULT_WORKSPACE_IMAGE, type ConnectConfig } from './config.js';
import { EnrollmentService } from './enrollment.js';
import { ConnectEvents } from './events.js';
import { Registry, type ActorCtx } from './registry.js';
import { ConnectSettingsStore } from './settings.js';
import { ConnectStore } from './store.js';
import { generateNodeKeyPair } from './tunnel/auth.js';

export const testConfig = (over: Partial<ConnectConfig> = {}): ConnectConfig => ({
  enabled: true,
  url: undefined,
  allowHttp: false,
  caFile: undefined,
  baseImage: DEFAULT_BASE_IMAGE,
  workspaceImage: DEFAULT_WORKSPACE_IMAGE,
  tokenTtlMin: 15,
  ...over,
});

export const OWNER: ActorCtx = { actor: 'user:u_owner', userId: 'u_owner', ip: '203.0.113.9' };

/**
 * `p`, or a failure after `ms` that names what did not happen. A Connect test never waits for ever for an event: one that does not come under load
 * hung the release gate for 26 minutes at 0% CPU (rekey.test.ts), and a hang says nothing, while a timeout says what was waited for.
 */
/**
 * How much longer than usual the tests wait: CP_TEST_TIME_SCALE (a number of at least 1; scripts/gate.sh sets it when the machine is busier than it has CPUs).
 * A timing test that passes alone in two seconds failed in the deploy gate when the pod's load average was 26 on 8 cores (hub.test.ts, "the control stream").
 */
export const TIME_SCALE = Math.min(10, Math.max(1, Number(process.env.CP_TEST_TIME_SCALE ?? 1) || 1));

export function withTimeout<T>(p: Promise<T>, what: string, baseMs = 10_000): Promise<T> {
  const ms = baseMs * TIME_SCALE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms waiting for ${what}.`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Polls `fn` every 20 ms until it is true; fails after `ms` naming `what`. */
export async function until(fn: () => boolean, what: string, baseMs = 8_000): Promise<void> {
  const ms = baseMs * TIME_SCALE;
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out after ${ms} ms waiting for ${what}.`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const helloFor = (mode: ConnectKind = 'docker', over: Partial<ConnectAgentHello> = {}): ConnectAgentHello => ({
  agentVersion: '0.1.0',
  agentBuild: 'aaaaaaaaaaaa',
  protocol: 1,
  os: 'linux',
  arch: 'x64',
  hostname: 'lab-box',
  mode,
  runtime: mode === 'kubernetes' ? 'pod' : mode === 'host' ? 'host' : 'container',
  services: [{ name: mode === 'host' || mode === 'container' ? 'host' : mode === 'kubernetes' ? 'kube' : 'docker', ok: true, version: '29.0.0' }],
  clock: new Date('2026-10-12T09:00:00.000Z').toISOString(),
  startedAt: new Date('2026-10-12T08:59:00.000Z').toISOString(),
  ...over,
});

export async function openCore(opts: { config?: Partial<ConnectConfig>; scanned?: WorkspaceTarget[]; store?: Store; dir?: string } = {}) {
  const dir = opts.dir ?? tempDirectory('cx1-core-');
  const store = opts.store ?? (await Store.open({ dataDir: dir, secretKey: parseSecretKey(generateSecretKey()) }));
  const clock = { now: new Date('2026-10-12T09:00:00.000Z') };
  const now = () => clock.now;
  const config = testConfig(opts.config);
  const cstore = new ConnectStore(store);
  const events = new ConnectEvents(cstore, now);
  const scanned = opts.scanned ?? [{ id: 'docker', label: 'Docker', kind: 'docker', where: '/var/run/docker.sock', available: true }];
  const bundle = () => ({ build: 'aaaaaaaaaaaa', version: '0.1.0' });
  let registry!: Registry;
  const settings = new ConnectSettingsStore(cstore, config, events, { knownTarget: (id) => !!registry.target(id) || scanned.some((t) => t.id === id), bundle }, now);
  registry = new Registry({ store: cstore, events, settings, config, scannedIds: () => scanned.map((t) => t.id), scanned: async () => scanned, bundle, now });
  const limiter = new RateLimiter(CONNECT_LIMITS.enrollFailures.attempts, CONNECT_LIMITS.enrollFailures.windowMs);
  const enrollments = new EnrollmentService({ store: cstore, registry, events, settings, config, limiter, portalId: () => store.portalId, portalVersion: '0.0.0', now });
  const keys = () => generateNodeKeyPair();
  return { dir, store, cstore, events, settings, registry, enrollments, limiter, clock, config, scanned, keys, ctx: OWNER };
}

export type Core = Awaited<ReturnType<typeof openCore>>;

/** A pending docker target with one usable token; returns what the wizard would hold. */
export function wizard(core: Core, over: { id?: string; kind?: ConnectKind; platform?: 'linux' | 'macos' | 'windows'; options?: Record<string, unknown>; maxUses?: number; ttlMinutes?: number } = {}) {
  const kind = over.kind ?? 'docker';
  const options = { hostAccess: kind === 'host' ? true : undefined, ...over.options };
  const target = core.registry.createTarget({ kind, platform: over.platform ?? 'linux', id: over.id ?? 'lab', portalUrl: 'https://pilot.example.com', options }, null, core.ctx);
  const made = core.enrollments.create(target, { platform: over.platform ?? 'linux', options, maxUses: over.maxUses, ttlMinutes: over.ttlMinutes }, core.ctx);
  return { target, ...made };
}

// ---- the hub over a real WebSocket on loopback ---------------------------------------------------------------------------------------

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { connectTunnelUrl, type ConnectEnrollResult } from '@portal/contracts';
import { Hub, type HubDeps } from './hub.js';
import { openService, readJsonLines, writeLine, dialTunnel, type Dialled, type MuxStream } from './tunnel/index.js';
import type { NodeKeyPair } from './tunnel/auth.js';

/** A portal's tunnel end on a loopback port: the hub on an HTTP server, as `index.ts` wires it. `x-test-ip` stands in for the client address. */
export async function openHub(core: Core, opts: { timing?: HubDeps['timing']; build?: string } = {}) {
  const server: Server = createServer();
  const notified = { n: 0 };
  const logs: string[] = [];
  const hub = new Hub({
    store: core.cstore,
    registry: core.registry,
    events: core.events,
    settings: core.settings,
    config: core.config,
    portalId: () => core.store.portalId,
    portalVersion: '0.0.0',
    bundle: () => ({ build: opts.build ?? 'aaaaaaaaaaaa' }),
    clientIp: (req) => String(req.headers['x-test-ip'] ?? req.socket.remoteAddress ?? 'unknown'),
    notify: () => void notified.n++,
    log: (l) => void logs.push(l),
    now: () => core.clock.now,
    timing: opts.timing,
  });
  core.registry.useLive(hub);
  core.enrollments.useLive((id) => hub.isConnected(id));
  hub.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const agents: Dialled[] = [];
  /** Enrolls a node on a fresh target and returns what an agent would hold. */
  const enrollNode = (over: Parameters<typeof wizard>[1] = {}, helloOver: Partial<ConnectAgentHello> = {}) => {
    const w = wizard(core, over);
    const keys = core.keys();
    const kind = over.kind ?? 'docker';
    const result: ConnectEnrollResult = core.enrollments.enroll(w.token, { publicKey: keys.publicKey, hello: helloFor(kind, helloOver) }, '203.0.113.50');
    return { ...w, keys, result, nodeId: result.node, kind };
  };
  const dial = async (nodeId: string, keys: NodeKeyPair, over: { hello?: Partial<ConnectAgentHello>; kind?: ConnectKind; ip?: string; onStream?: (s: MuxStream) => void; handshakeMs?: number } = {}) => {
    const d = await dialTunnel({
      url: connectTunnelUrl(origin),
      nodeId,
      privateKey: keys.privateKey,
      hello: () => helloFor(over.kind ?? 'docker', over.hello),
      ws: { headers: { 'x-test-ip': over.ip ?? '198.51.100.20' } },
      onStream: over.onStream,
      handshakeMs: over.handshakeMs,
    });
    agents.push(d);
    return d;
  };
  /** The agent's control stream: opens it, returns the first line (`config`) and a way to read and write more. */
  const control = async (d: Dialled) => {
    const stream = await openService(d.session, { service: 'control' });
    const lines = readJsonLines(stream, 1_000_000)[Symbol.asyncIterator]();
    const next = async (): Promise<Record<string, unknown>> => (await lines.next()).value as Record<string, unknown>;
    return { stream, next, send: (msg: unknown) => writeLine(stream, msg), config: await next() };
  };
  const waitFor = async (cond: () => boolean, baseMs = 2_000): Promise<boolean> => {
    const end = Date.now() + baseMs * TIME_SCALE;
    while (!cond()) {
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 5));
    }
    return true;
  };
  const raw = (headers: Record<string, string> = {}, protocols: string[] | undefined = ['pilot.tunnel.v1']) => new WebSocket(connectTunnelUrl(origin), protocols, { perMessageDeflate: false, headers });
  const close = async () => {
    for (const a of agents) a.session.destroy('test over');
    hub.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { hub, server, origin, port, notified, logs, enrollNode, dial, control, waitFor, raw, close, once };
}

export type TestHub = Awaited<ReturnType<typeof openHub>>;

// ---- the whole module behind HTTP, as app.ts mounts it ---------------------------------------------------------------------------------

import { AppError, isAppError } from '@isnanme/core';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Workspace } from '@portal/contracts';
import { createConnect, type ConnectModule } from './index.js';
import type { InstallPort } from './installPort.js';

/** A stand-in for the installers' package: fixed text, so the control plane is tested without T4's scripts. */
export const stubInstall = (): InstallPort => ({
  routes: () => new Hono(),
  commands: (input) => ({
    install: `curl -fsSL ${input.portalUrl}/connect/install.sh | PILOT_URL=${input.portalUrl} PILOT_TOKEN=${input.token} sh`,
    verified: `verify-first ${input.token}`,
    upgrade: 'upgrade',
    uninstall: 'uninstall',
    doctor: 'doctor',
    scriptUrl: `${input.portalUrl}/connect/install.sh`,
    scriptSha256: 'f'.repeat(64),
  }),
  preview: (input) => ({ steps: [`Install the agent for ${input.target.id}`], manifest: input.target.kind === 'kubernetes' ? 'apiVersion: v1\nkind: Namespace\n' : null }),
  workspaceContext: () => ({ pipe: () => undefined, on: () => undefined }) as never,
  declarePolicies: () => undefined,
});

export async function openModule(opts: { config?: Partial<ConnectConfig>; scanned?: WorkspaceTarget[]; workspaces?: Workspace[]; install?: InstallPort; signedIn?: boolean; timing?: HubDeps['timing']; store?: Store; dir?: string } = {}) {
  const dir = opts.dir ?? tempDirectory('cx1-mod-');
  const store = opts.store ?? (await Store.open({ dataDir: dir, secretKey: parseSecretKey(generateSecretKey()) }));
  const clock = { now: new Date('2026-10-12T09:00:00.000Z') };
  const scanned = opts.scanned ?? [{ id: 'docker', label: 'Docker', kind: 'docker' as const, where: '/var/run/docker.sock', available: true }];
  const workspaces: Workspace[] = opts.workspaces ?? [];
  const removed: string[] = [];
  const rechecked: string[] = [];
  const topics = { n: 0 };
  const config = testConfig(opts.config);
  const connect: ConnectModule = createConnect({
    store,
    config,
    scanned: async () => scanned,
    scannedIds: () => scanned.map((t) => t.id),
    workspacesOn: async (id) => workspaces.filter((w) => w.target === id),
    removeWorkspace: async (id) => {
      removed.push(id);
      const i = workspaces.findIndex((w) => w.id === id);
      if (i >= 0) workspaces.splice(i, 1);
    },
    recheck: async (id) => void rechecked.push(id),
    bundle: () => ({ build: 'aaaaaaaaaaaa', sha256: 'a'.repeat(64), version: '0.1.0', source: '// agent' }),
    install: opts.install ?? stubInstall(),
    notify: () => void topics.n++,
    log: () => undefined,
    now: () => clock.now,
    timing: opts.timing,
  });
  const app = new Hono<{ Variables: { token: string } }>();
  app.onError((e, c) => {
    const error = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    if (error.status >= 500) console.error(e);
    return c.json(error.toJSON(), error.status as ContentfulStatusCode);
  });
  // what app.ts does: the admin routes behind the session guard, the agent-facing ones with none
  const guard = new Hono<{ Variables: { token: string } }>();
  if (opts.signedIn !== false) guard.use(async (c, next) => ((c.set('token', 'session'), (c as unknown as { set(k: string, v: unknown): void }).set('actor', { kind: 'user', userId: 'u_owner', loginSessionId: 'legacy', via: 'ui' })), next()));
  guard.route('/', connect.routes() as never);
  app.route('/api/connect', guard);
  app.route('/', connect.publicRoutes() as never);

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, ip = '203.0.113.9') => {
    const init: RequestInit = { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) };
    const res = await app.request(path, init, { incoming: { socket: { remoteAddress: ip }, headers: {} } });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  const admin = (method: string, path: string, body?: unknown) => call(method, `/api/connect${path}`, body, { origin: 'https://pilot.example.com' });
  return { dir, store, connect, app, call, admin, clock, scanned, workspaces, removed, rechecked, topics, config, close: async () => connect.stop() };
}

export type TestModule = Awaited<ReturnType<typeof openModule>>;

/** The module on a real HTTP server, as the portal serves it (Hono through node-server, so handlers see the real socket), with the tunnel's upgrade handler. */
export async function serveModule(m: TestModule, port = 0) {
  const { getRequestListener } = await import('@hono/node-server');
  const server = createServer(getRequestListener(m.app.fetch));
  m.connect.attach(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const bound = (server.address() as AddressInfo).port;
  return {
    server,
    port: bound,
    origin: `http://127.0.0.1:${bound}`,
    close: async () => {
      m.connect.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
