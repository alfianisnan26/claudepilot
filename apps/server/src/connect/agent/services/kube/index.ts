// The `kube` service (docs/prd/targets-connect.md §11.5): the agent in a pod, reaching the API server with its service account. Every
// stream is the server side of an HTTP connection that goes through the proxy (`proxy.ts`). This file is the agent's side: where the API
// server, the token and the CA are (all injectable: a test points them at a fake), the service's health, and the counters of refusals.
import type { ConnectServiceStatus, ConnectStatusMessage } from '@portal/contracts';
import type { TunnelStream } from '../../../seams.js';
import type { Logger } from '../../log.js';
import type { AgentService, StreamRefusal } from '../types.js';
import { ImageAllow } from '../docker/rules.js';
import { KubeProxy } from './proxy.js';
import { validNamespace } from './rules.js';

export const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface KubeServiceOptions {
  /** The API server URL. Default `https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT`. */
  server?: string;
  tokenFile?: string;
  /** The CA of the API server's certificate; null: Node's roots (a test's plain-HTTP fake has none). */
  caFile?: string | null;
  /** The connector's namespace (PILOT_KUBE_NAMESPACE, or the service account's own). */
  namespace: string;
  /** The per-connection bearer from the portal's `config` message. */
  localToken(): string | null;
  log: Logger;
  env?: NodeJS.ProcessEnv;
  /** The images workspace containers may use (PILOT_IMAGES); empty: not enforced on this cluster. */
  images?: string[];
  now?: () => number;
  readFile?: (path: string) => string;
  idleMs?: number;
}

export type KubeService = AgentService & { readonly proxy: KubeProxy };

/** `https://host:port` of the API server from the pod's environment, or null outside a cluster. */
export function inClusterServer(env: NodeJS.ProcessEnv = process.env): string | null {
  const host = env.KUBERNETES_SERVICE_HOST;
  if (!host) return null;
  const port = env.KUBERNETES_SERVICE_PORT || '443';
  return `https://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}

export function createService(opts: KubeServiceOptions): KubeService {
  const server = opts.server ?? inClusterServer(opts.env);
  if (!validNamespace(opts.namespace)) throw new Error('The Kubernetes namespace is not valid.');
  let proxy: KubeProxy | null = null;
  let changed: (() => void) | undefined;
  let status: ConnectServiceStatus = { name: 'kube', ok: false, error: server ? 'Not checked yet.' : 'Not running in a Kubernetes cluster (no KUBERNETES_SERVICE_HOST).' };
  let lastCode = '';
  let probedAt = 0;

  const ensure = (): KubeProxy | null => {
    if (!server) return null;
    proxy ??= new KubeProxy({
      server,
      tokenFile: opts.tokenFile ?? `${SA_DIR}/token`,
      caFile: opts.caFile === undefined ? `${SA_DIR}/ca.crt` : opts.caFile,
      namespace: opts.namespace,
      localToken: opts.localToken,
      log: opts.log,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.readFile ? { readFile: opts.readFile } : {}),
      ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
      onChange: () => changed?.(),
      images: opts.images?.length ? new ImageAllow(opts.images) : null,
    });
    return proxy;
  };
  // Build the proxy now when there is a server: a missing CA or token file is a configuration problem to say at start, not at the first stream.
  try {
    ensure();
  } catch (e) {
    status = { name: 'kube', ok: false, error: `The service account files could not be read (${(e as NodeJS.ErrnoException).code ?? 'ERR'}).` };
  }

  const refresh = async () => {
    const p = ensure();
    if (!p) return;
    try {
      const res = await p.api('GET', '/version', { timeoutMs: 5000 });
      if (res.status !== 200) throw Object.assign(new Error('unexpected answer'), { code: `HTTP${res.status}` });
      const version = (JSON.parse(res.body.toString('utf8')) as { gitVersion?: string }).gitVersion;
      status = { name: 'kube', ok: true, ...(version ? { version } : {}) };
      lastCode = '';
      probedAt = Date.now();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? 'ERR';
      if (code !== lastCode) opts.log.warn('kube.unavailable', { code });
      lastCode = code;
      status = { name: 'kube', ok: false, error: code === 'HTTP401' || code === 'HTTP403' ? 'The service account was refused by the API server.' : `The API server did not answer (${code}).` };
    }
  };

  return {
    name: 'kube',
    get proxy() {
      const p = ensure();
      if (!p) throw new Error('not in a cluster');
      return p;
    },

    async accept(): Promise<StreamRefusal | null> {
      if (!status.ok || Date.now() - probedAt > 3000) await refresh();
      return status.ok ? null : { code: server ? 'upstream_unreachable' : 'service_unavailable', message: status.error ?? 'Kubernetes is not available.' };
    },

    handle(stream: TunnelStream, trace: string) {
      const p = ensure();
      if (!p) return void stream.destroy();
      p.serve(stream, trace);
    },

    status: () => status,
    refresh,
    onChange: (fn) => void (changed = fn),

    report(): Pick<ConnectStatusMessage, 'denied'> {
      const denied = proxy?.takeDenied() ?? [];
      return denied.length ? { denied } : {};
    },

    close() {
      proxy?.close();
    },
  };
}
