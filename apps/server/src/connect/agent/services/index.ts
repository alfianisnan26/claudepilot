// Builds the services a mode offers (docs/prd/targets-connect.md §11.2): `docker` and `swarm` offer `docker`, `kubernetes` offers `kube`,
// `container` and `host` offer `host`. Tests can hand in ready-made ones (a fake upstream); everything else comes from the configuration.
import { userInfo } from 'node:os';
import type { AgentConfig } from '../config.js';
import type { Logger } from '../log.js';
import { createService as createDocker } from './docker/index.js';
import { createService as createHost, childEnv } from './host/index.js';
import { createService as createKube, SA_DIR, type KubeServiceOptions } from './kube/index.js';
import type { AgentService, ServiceName } from './types.js';

export interface ServiceDeps {
  config: AgentConfig;
  log: Logger;
  /** The portal's id as pinned (null before the first welcome). */
  portalId(): string | null;
  /** The bearer for the Kubernetes proxy, from `config`. */
  kubeLocalToken(): string | null;
  /** Services made by the caller (tests); the rest are built from the configuration. */
  provided?: Partial<Record<ServiceName, AgentService>>;
  /** Kubernetes: where the API server, token and CA are (default: the pod's own). Tests point this at a fake. */
  kube?: Partial<Pick<KubeServiceOptions, 'server' | 'tokenFile' | 'caFile' | 'readFile' | 'now'>>;
  host?: { loadPty?: () => Promise<never>; killGraceMs?: number; baseEnv?: NodeJS.ProcessEnv; passwdFile?: string; cgroupRoot?: string };
}

export function createServices(deps: ServiceDeps): Map<ServiceName, AgentService> {
  const { config, log } = deps;
  const out = new Map<ServiceName, AgentService>();
  for (const name of config.services) {
    const given = deps.provided?.[name];
    if (given) {
      out.set(name, given);
      continue;
    }
    if (name === 'docker') {
      out.set(
        name,
        createDocker({
          socket: config.dockerSocket,
          images: [...config.images, ...config.docker.allowImages],
          allowBinds: config.docker.allowBinds,
          portalId: deps.portalId,
          log,
        }),
      );
    } else if (name === 'kube') {
      if (!config.kubeNamespace) throw new Error('PILOT_KUBE_NAMESPACE is required in kubernetes mode.');
      out.set(
        name,
        createKube({
          namespace: config.kubeNamespace,
          localToken: deps.kubeLocalToken,
          log,
          tokenFile: `${SA_DIR}/token`,
          ...deps.kube,
        }),
      );
    } else {
      out.set(
        name,
        createHost({
          mode: config.mode === 'host' ? 'host' : 'container',
          ...(config.home ? { home: config.home } : {}),
          baseEnv: deps.host?.baseEnv ?? childEnv(),
          log,
          ...(deps.host?.killGraceMs !== undefined ? { killGraceMs: deps.host.killGraceMs } : {}),
          ...(deps.host?.passwdFile ? { passwdFile: deps.host.passwdFile } : {}),
          ...(deps.host?.cgroupRoot ? { cgroupRoot: deps.host.cgroupRoot } : {}),
          ...(deps.host?.loadPty ? { loadPty: deps.host.loadPty as never } : {}),
        }),
      );
    }
  }
  void userInfo;
  return out;
}
