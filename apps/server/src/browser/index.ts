import type { WorkspaceSteps } from '../delivery/steps.js';
import { config } from '../config.js';
import type { PoolService } from '../pools/service.js';
import type { Portal } from '../portal.js';
import type { Server } from 'node:http';
import type { Store } from '../store/store.js';
import type { Runtime } from '../workspaces/runtime.js';
import { Companions } from './companion.js';
import { BrowserKind } from './kind.js';
import { createBrowserRoutes } from './routes.js';
import { attachBrowserSockets } from './socket.js';
import { BrowserService } from './service.js';

/**
 * The browser pool in one place (browser & desktop PRD): the `browser` pool kind registered with the pool
 * service, the browser containers on each Docker target, and the routes. Made once in index.ts, before the
 * reconciler starts, so a manifest naming a browser pool never finds its kind missing.
 */
export class BrowserModule {
  readonly kind: BrowserKind;
  readonly service: BrowserService;
  readonly companions = new Map<string, Companions>();

  constructor(deps: { store: Store; pools: PoolService; steps: WorkspaceSteps; runtimes: Runtime[]; notify: () => void }) {
    for (const r of deps.runtimes) {
      if (r.target.kind === 'docker') this.companions.set(r.target.id, new Companions(r.target.id, r.target.where, config.browser.image, config.browser.imageContext, () => deps.store.portalId));
    }
    this.kind = new BrowserKind({ supports: (target) => this.companions.has(target) });
    deps.pools.register(this.kind);
    this.service = new BrowserService({
      store: deps.store,
      pools: deps.pools,
      kind: this.kind,
      steps: deps.steps,
      companions: this.companions,
      portalPort: config.port,
      notify: deps.notify,
    });
  }

  routes() {
    return createBrowserRoutes(this.service);
  }

  /**
   * A browser container joins its workspace's network namespace and mounts its home volume, so the workspace
   * can't be removed (the volume is in use) or stopped cleanly while it runs: the runtime's `remove` and `stop`
   * take the browser away first. Wraps the instance, so no workspace code changes.
   */
  guard(runtime: Runtime) {
    if (!this.companions.has(runtime.target.id)) return;
    const stop = runtime.stop.bind(runtime);
    const remove = runtime.remove.bind(runtime);
    const id = (name: string) => `${runtime.target.id}/${name}`;
    runtime.stop = async (name) => {
      await this.service.stopFor(id(name)).catch(() => undefined);
      return stop(name);
    };
    runtime.remove = async (name) => {
      await this.service.removeFor(id(name), 'workspace removed');
      return remove(name);
    };
  }

  /** The live-view sockets: call once the HTTP server exists, before it listens. */
  attach(server: Server, portal: Portal) {
    attachBrowserSockets(server, { portal, service: this.service });
  }

  start() {
    this.service.start();
  }

  stop() {
    this.service.stop();
  }
}
