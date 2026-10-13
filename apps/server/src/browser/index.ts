import type { WorkspaceSteps } from '../delivery/steps.js';
import { config } from '../config.js';
import type { PoolService } from '../pools/service.js';
import type { Portal } from '../portal.js';
import type { Server } from 'node:http';
import type { Store } from '../store/store.js';
import type { Runtime, RuntimeNames } from '../workspaces/runtime.js';
import { Companions } from './companion.js';
import { KubernetesRuntime } from '../workspaces/kubernetes.js';
import { kubeCapRefusal, KubeBrowsers, parseEgressAllow } from './kube.js';
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
  /** Kubernetes targets: the browser is a second container in the workspace's pod (PRD §10.2); only with `PORTAL_K8S_BROWSER_IMAGE`. */
  readonly kube = new Map<string, KubeBrowsers>();

  /** `names`: the workspaces' stored runtime names (T-42), which the browser containers follow. */
  constructor(deps: { store: Store; pools: PoolService; steps: WorkspaceSteps; runtimes: Runtime[]; notify: () => void; names?: RuntimeNames }) {
    const egressAllow = parseEgressAllow(config.browser.kubeEgressAllow);
    if (egressAllow.bad.length) console.error(`[browser] PORTAL_K8S_BROWSER_EGRESS_ALLOW: not a CIDR or an address, left out: ${egressAllow.bad.join(', ').slice(0, 300)}`);
    for (const r of deps.runtimes) {
      if (r.target.kind === 'docker') this.companions.set(r.target.id, new Companions(r.target.id, r.target.where, config.browser.image, config.browser.imageContext, () => deps.store.portalId, deps.names));
      const access = r instanceof KubernetesRuntime && config.browser.kubeImage ? r.browserAccess() : null;
      if (access && config.browser.kubeImage) this.kube.set(r.target.id, new KubeBrowsers(r.target.id, access, config.browser.kubeImage, config.portalMcp.internalUrl, { mode: config.browser.kubeEgress, allow: egressAllow.allow }));
    }
    this.kind = new BrowserKind({
      supports: (target) => this.companions.has(target) || this.kube.has(target),
      refuseAssign: (workspaceId) => (this.kube.has(workspaceId.split('/')[0]!) ? kubeCapRefusal(deps.store, workspaceId) : null),
    });
    deps.pools.register(this.kind);
    this.service = new BrowserService({
      store: deps.store,
      pools: deps.pools,
      kind: this.kind,
      steps: deps.steps,
      companions: this.companions,
      kube: this.kube,
      internalUrl: config.portalMcp.internalUrl,
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
    if (this.kube.has(runtime.target.id)) {
      // Kubernetes: the pod template takes the browser (or loses it) while no pod runs, just before the start. A failure here is the
      // browser's, never the workspace's (FR13): it starts anyway.
      const start = runtime.start.bind(runtime);
      runtime.start = async (name) => {
        await this.service.beforeStart(`${runtime.target.id}/${name}`).catch((e: unknown) => console.error(`[browser] before starting ${name}: ${(e as Error).message}`));
        return start(name);
      };
      return;
    }
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

