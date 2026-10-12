// Connect (docs/prd/targets-connect.md): enrolling clusters and single hosts from the web, with an agent that dials out to the portal. This is the
// control plane's module: the registry and its migrations, enrollment, the tunnel hub, the admin REST (`/api/connect`) and the agent-facing routes
// (`/connect/`). `createConnect(deps)` builds it; index.ts (the portal's) wires it in a few lines:
//
//   const connect = createConnect({ store, config: config.connect, scanned, ..., bundle });
//   wireConnect({ connect, workspaces, chat, reconciler });   // T3: the runtime factory and the manager's hooks
//   connect.attach(server, portal);                            // before attachShell
//   createApp(..., { connect });                               // mounts routes() under /api/connect and publicRoutes() at the root
//
// Kill switch (FR61): PORTAL_CONNECT_ENABLED=false makes every /connect/ path 404, refuses tunnels and registers no enrolled runtime; the registry
// stays readable.

import { readFileSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { CONNECT_LIMITS, type Workspace, type WorkspaceTarget } from '@portal/contracts';
import type { Hono } from 'hono';
import { RateLimiter } from '../rateLimit.js';
import type { Store } from '../store/store.js';
import { ConnectAdmin } from './admin.js';
import { registerConnectResolvers, declareConnectPolicies } from './authz.js';
import type { ConnectConfig } from './config.js';
import { EnrollmentService } from './enrollment.js';
import { ConnectEvents } from './events.js';
import { Hub, type HubDeps } from './hub.js';
import { realInstall, type InstallPort } from './installPort.js';
import { createPublicRoutes } from './publicRoutes.js';
import { Registry } from './registry.js';
import { createConnectRoutes } from './routes.js';
import { Runtimes } from './runtimes.js';
import type { ConnectModuleApi, InstallDeps } from './seams.js';
import { ConnectSettingsStore } from './settings.js';
import { ConnectStore } from './store.js';

export type { ConnectConfig } from './config.js';
export type { ConnectModuleApi, NodeLink, RuntimeDeps, RuntimeFactory } from './seams.js';

export interface ConnectDeps {
  store: Store;
  config: ConnectConfig;
  /** The manager's targets that the portal found by itself (`workspaces.targets()` minus the enrolled ones; the registry filters them). */
  scanned(): Promise<WorkspaceTarget[]>;
  /** The ids of those targets, synchronously (name checks and the authorization resolver). */
  scannedIds(): string[];
  /** One target's workspaces as the manager lists them (last-known ones included). */
  workspacesOn(targetId: string): Promise<Workspace[]>;
  /** The manager's remove (with its hooks). */
  removeWorkspace(workspaceId: string): Promise<void>;
  /** A fresh check of a target by the manager. */
  recheck?(targetId: string): Promise<void>;
  /** The agent bundle this portal serves (T2's generated constants). */
  bundle(): { build: string; sha256: string; version: string; source: string };
  /** The installers' package (T4); the real one unless a test brings a stand-in. */
  install?: InstallPort;
  /** The `connect` live topic: pages reload the registry. */
  notify?(): void;
  portalVersion?: string;
  /** Behind a reverse proxy the client address is the last `X-Forwarded-For` entry (the sign-in's rule). */
  trustProxy?: boolean;
  log?(line: string): void;
  now?(): Date;
  /** The portal's CA certificate (PEM) for the "Private CA" commands; read from `config.caFile` by default. */
  caPem?(): string | null;
  timing?: HubDeps['timing'];
}

export interface ConnectModule extends ConnectModuleApi {
  readonly enabled: boolean;
  /** The admin REST, for `/api/connect`, behind the session guard (mounted by app.ts). */
  routes(): Hono<never>;
  /** The agent-facing routes with full `/connect/...` paths, no guard: mounted at the root. */
  publicRoutes(): Hono<never>;
  /** The tunnel's upgrade handler: call before the other socket modules (it answers only `/connect/v1/tunnel`). */
  attach(server: Server, portal?: unknown): void;
  /** Starts the housekeeping timers; `stop` ends them and closes every tunnel. */
  start(): void;
  stop(): void;
  readonly registry: Registry;
  readonly enrollments: EnrollmentService;
  readonly hub: Hub;
  readonly events: ConnectEvents;
  readonly settings: ConnectSettingsStore;
  readonly admin: ConnectAdmin;
  readonly runtimes: Runtimes;
}

const PURGE_EVERY_MS = 10 * 60_000;

export function createConnect(deps: ConnectDeps): ConnectModule {
  const log = deps.log ?? ((line: string) => console.log(line));
  const portalVersion = deps.portalVersion ?? '0.0.0';
  const notify = deps.notify ?? (() => undefined);
  const install = deps.install ?? realInstall;
  const store = new ConnectStore(deps.store);
  const events = new ConnectEvents(store, deps.now);
  const bundle = () => deps.bundle();
  let registry!: Registry;
  const settings = new ConnectSettingsStore(
    store,
    deps.config,
    events,
    { knownTarget: (id) => !!registry.target(id) || deps.scannedIds().includes(id), bundle: () => ({ build: bundle().build, version: bundle().version }) },
    deps.now,
  );
  registry = new Registry({ store, events, settings, config: deps.config, scannedIds: deps.scannedIds, scanned: deps.scanned, bundle: () => ({ build: bundle().build, version: bundle().version }), now: deps.now });
  const limiter = new RateLimiter(CONNECT_LIMITS.enrollFailures.attempts, CONNECT_LIMITS.enrollFailures.windowMs);
  const enrollments = new EnrollmentService({ store, registry, events, settings, config: deps.config, limiter, portalId: () => deps.store.portalId, portalVersion, now: deps.now });
  const clientIp = (req: IncomingMessage | undefined): string | null => {
    if (!req) return null;
    const forwarded = deps.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1)?.trim() : '';
    return forwarded || req.socket?.remoteAddress || null;
  };
  const hub = new Hub({ store, registry, events, settings, config: deps.config, portalId: () => deps.store.portalId, portalVersion, bundle, clientIp, notify, log, now: deps.now, timing: deps.timing });
  registry.useLive(hub);
  enrollments.useLive((id) => hub.isConnected(id));
  const runtimes = new Runtimes({ registry, hub, store, config: deps.config, settings, portalId: () => deps.store.portalId, log });

  let pem: string | null | undefined;
  const caPem =
    deps.caPem ??
    (() => {
      if (pem !== undefined) return pem;
      try {
        pem = deps.config.caFile ? readFileSync(deps.config.caFile, 'utf8') : null;
      } catch (e) {
        log(`[connect] PORTAL_CONNECT_CA_FILE can't be read: ${(e as Error).message}`);
        pem = null;
      }
      return pem;
    });

  const admin = new ConnectAdmin({ store, registry, enrollments, hub, events, settings, config: deps.config, install, bundle, scannedIds: deps.scannedIds, workspacesOn: deps.workspacesOn, removeWorkspace: deps.removeWorkspace, recheck: deps.recheck, caPem, now: deps.now, notify });

  registerConnectResolvers({ registry, scannedIds: deps.scannedIds });
  declareConnectPolicies();
  install.declarePolicies();

  // The registry or a node changed: pages reload. (A node connecting is the hub's own notification.)
  registry.onChange(() => notify());

  const installDeps = (): InstallDeps => ({
    enrollments,
    bundle: bundle(),
    config: { baseImage: deps.config.baseImage, workspaceImage: deps.config.workspaceImage, caPem: deps.config.caFile ? caPem() : null, allowHttp: deps.config.allowHttp },
    workspaceContext: () => install.workspaceContext(),
    log,
  });

  let timer: NodeJS.Timeout | null = null;
  return {
    get enabled() {
      return deps.config.enabled;
    },
    routes: () => createConnectRoutes(admin, { clientIp }) as unknown as Hono<never>,
    publicRoutes: () => createPublicRoutes({ config: deps.config, enrollments, install, installDeps: installDeps(), limiter, portalVersion, clientIp }) as unknown as Hono<never>,
    attach: (server) => hub.attach(server),
    start() {
      if (timer) return;
      registry.purgePending();
      timer = setInterval(() => registry.purgePending(), PURGE_EVERY_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      hub.close();
      registry.flushAllSnapshots();
    },
    useRuntimeFactory: (f) => runtimes.useFactory(f),
    bind: (w) => runtimes.bind(w),
    settled: (ms) => runtimes.settled(ms),
    canCreate: (targetId, node) => runtimes.canCreate(targetId, node),
    onReturned: (fn) => runtimes.onReturned(fn),
    onLost: (fn) => runtimes.onLost(fn),
    nodeViews: (targetId) => {
      const t = registry.target(targetId);
      return t ? registry.view(t).nodes : [];
    },
    registry,
    enrollments,
    hub,
    events,
    settings,
    admin,
    runtimes,
  };
}
