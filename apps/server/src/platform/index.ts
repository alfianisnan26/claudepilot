// The platform track's skeleton (docs/prd/platform-roadmap.md phase 1; work breakdown section 1): ONE bus, ONE audit, ONE owner adapter,
// the `/hooks` app (public receivers: outside `/api` and the session guard), and the modules: notifications here, triggers and auto
// transfer register themselves below with ONE line each. index.ts and app.ts see only `createPlatform` and `Platform`.
//
// Extension points for other tracks: `platform.bus.emit` (a new kind is one entry in contracts notify.ts plus a template in
// notify/templates.ts); `platform.audit.record` for a row in the shared audit; `platform.owner` for who owns what; `platform.publish`
// for the live topics `notify`, `triggers` and `autotransfer`.

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { IncomingMessage } from 'node:http';
import { actorUserId, type LivePresence } from '@portal/contracts';
import { actorOfSocket } from '../authz/seam.js';
import { createBus, createNotify, type NotifyBus, type NotifyDeps } from '../notify/index.js';
import { declareNotifyPolicies } from '../notify/authz.js';
import type { Store } from '../store/store.js';
import { PlatformAudit } from './audit.js';
import { seamOwner, type PlatformOwner } from './owner.js';
import { createPlatformRoutes } from './routes.js';
import { createTriggersModule } from '../triggers/index.js';
import { createAutoTransferModule } from '../autotransfer/index.js';
import { createKeepGoingModule } from '../keepgoing/index.js';

export type { PlatformOwner, PlatformActor } from './owner.js';
export type { PlatformAudit } from './audit.js';
export type { NotifyBus } from '../notify/index.js';

export type PlatformTopic = 'notify' | 'triggers' | 'autotransfer' | 'keepgoing';

/** A module of the platform: its routes go behind the session guard under `/api`, its receivers under `platform.hooks`. */
export interface PlatformModule {
  name: string;
  /** Mounted at `path` (e.g. `/api/triggers`) behind the session guard and the Origin check. */
  routes?: { path: string; app: Hono }[];
  start?(): void;
  stop?(): void;
}

export interface PlatformDeps extends Omit<NotifyDeps, 'bus' | 'owner' | 'audit' | 'publish' | 'reauthFresh'> {
  /** The live hub's publish, for the three topics. */
  publish?: (topic: PlatformTopic) => void;
  owner?: PlatformOwner;
  /** Whether a socket's request is signed in (the live socket's own check), for presence. */
  socketAuthorized?: (req: IncomingMessage) => boolean;
}

export interface Platform {
  bus: NotifyBus;
  audit: PlatformAudit;
  owner: PlatformOwner;
  /** Mounted at `/hooks`, outside `/api` and the session guard: a receiver is its own door (a signed secret). 1 MB bodies at most. */
  hooks: Hono;
  notify: ReturnType<typeof createNotify>;
  /** What the platform was built with: modules registered later read their seams here. */
  deps: PlatformDeps;
  register(m: PlatformModule): void;
  /** Every module's authenticated routes, for app.ts to mount behind its session guard. */
  routes(): { path: string; app: Hono }[];
  publish(topic: PlatformTopic): void;
  /** The live socket's `presence` message, and `null` when the socket closed. */
  presence(connection: object, p: LivePresence | null, req: IncomingMessage): void;
  /** app.ts hands over the server-code re-check (rotating a signing secret needs it). */
  useReauth(fresh: (signIn: string | undefined) => boolean): void;
  /** Whether this sign-in checked the server code recently (modules' rotations: triggers' secret and receiver address). */
  reauthFresh(signIn: string | undefined): boolean;
  start(): void;
  stop(): void;
}

export function createPlatform(deps: PlatformDeps): Platform {
  const bus = createBus(deps.now);
  const owner = deps.owner ?? seamOwner;
  const audit = new PlatformAudit(deps.store, deps.now);
  const publish = (t: PlatformTopic) => deps.publish?.(t);
  let reauth: (signIn: string | undefined) => boolean = () => false;
  const notify = createNotify({ ...deps, bus, owner, audit, publish: () => publish('notify'), reauthFresh: (t) => reauth(t) });
  const hooks = new Hono();
  hooks.use(
    '*',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'That request is too large.' } }, 413),
    }),
  );
  const modules: PlatformModule[] = [];
  let started = false;

  const platform: Platform = {
    bus,
    audit,
    owner,
    hooks,
    notify,
    deps,
    register(m) {
      if (modules.some((x) => x.name === m.name)) throw new Error(`platform module "${m.name}" is already registered`);
      modules.push(m);
      if (started) m.start?.();
    },
    routes: () => modules.flatMap((m) => m.routes ?? []),
    publish,
    presence(connection, p, req) {
      if (!p) return notify.pipeline.setPresence(connection, null);
      const userId = actorUserId(actorOfSocket(req, deps.socketAuthorized ?? (() => false)));
      if (!userId) return;
      notify.pipeline.setPresence(connection, { userId, device: p.device, visible: p.visible, active: p.active, session: p.session });
    },
    useReauth(fresh) {
      reauth = fresh;
    },
    reauthFresh: (t) => reauth(t),
    start() {
      if (started) return;
      started = true;
      for (const m of modules) {
        try {
          m.start?.();
        } catch (e) {
          console.error(`[platform] ${m.name} could not start: ${(e as Error).message}`);
        }
      }
    },
    stop() {
      for (const m of [...modules].reverse()) {
        try {
          m.stop?.();
        } catch {
          // stopping: nothing to do
        }
      }
      started = false;
    },
  };

  declareNotifyPolicies();
  platform.register({
    name: 'notify',
    routes: [
      { path: '/api/notify', app: notify.routes },
      { path: '/api/platform', app: createPlatformRoutes({ audit, owner }) },
    ],
    start: () => {
      notify.start();
      audit.sweep();
    },
    stop: () => notify.stop(),
  });
  // The registry: N3 (triggers) and N4 (auto transfer) add ONE line each below, e.g.
  //   platform.register(createTriggersModule(platform));
  //   platform.register(createAutoTransferModule(platform));
  platform.register(createTriggersModule(platform));
  platform.register(createAutoTransferModule(platform));
  // T-259: Keep going, the watchdog inside the portal.
  platform.register(createKeepGoingModule(platform));

  return platform;
}
