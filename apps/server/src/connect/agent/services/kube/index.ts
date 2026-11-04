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
  /** The connector's namespace (PILOT_KUBE_NAMESPACE, or the service account's own): its identity Secret, and a stream opened without one. */
  namespace: string;
  /** Further namespaces it serves (PILOT_KUBE_NAMESPACES; T-3720), each with its own proxy and allowlist. */
  namespaces?: string[];
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

/**
 * The namespace a `kube` stream is for: the open request's `{ namespace }` when the agent serves it. An open with no args (a portal from
 * before T-3720) falls back to the agent's own namespace only when that is the one namespace it serves; an agent that serves several
 * refuses it, so it never guesses which one was meant (PILOT-1172, the decision is on the ticket). Null: the stream is refused.
 */
export function streamNamespace(args: unknown, home: string, served: ReadonlySet<string>): string | null {
  if (args === undefined) return served.size === 1 && served.has(home) ? home : null;
  const ns = args && typeof args === 'object' ? (args as { namespace?: unknown }).namespace : undefined;
  return typeof ns === 'string' && served.has(ns) ? ns : null;
}

/** The namespace an open asked for, when it is a valid name (it tags the refusal); '' otherwise. */
function askedNamespace(args: unknown): string {
  const ns = args && typeof args === 'object' ? (args as { namespace?: unknown }).namespace : undefined;
  return typeof ns === 'string' && validNamespace(ns) ? ns : '';
}

export function createService(opts: KubeServiceOptions): KubeService {
  const server = opts.server ?? inClusterServer(opts.env);
  const namespaces = [...new Set([opts.namespace, ...(opts.namespaces ?? [])])];
  for (const ns of namespaces) if (!validNamespace(ns)) throw new Error('The Kubernetes namespace is not valid.');
  const served: ReadonlySet<string> = new Set(namespaces);
  // One proxy per namespace: each one's allowlist and body checks are for its own namespace only, so a stream opened for A can't reach B.
  const proxies = new Map<string, KubeProxy>();
  /** Opens refused for their namespace since the last report, by the namespace asked for ('' when none or not a valid name). */
  const refusedOpens = new Map<string, number>();
  let changed: (() => void) | undefined;
  let status: ConnectServiceStatus = { name: 'kube', ok: false, error: server ? 'Not checked yet.' : 'Not running in a Kubernetes cluster (no KUBERNETES_SERVICE_HOST).' };
  let lastCode = '';
  let probedAt = 0;

  const ensure = (ns: string = opts.namespace): KubeProxy | null => {
    if (!server || !served.has(ns)) return null;
    let proxy = proxies.get(ns);
    if (!proxy) {
      proxy = new KubeProxy({
        server,
        tokenFile: opts.tokenFile ?? `${SA_DIR}/token`,
        caFile: opts.caFile === undefined ? `${SA_DIR}/ca.crt` : opts.caFile,
        namespace: ns,
        localToken: opts.localToken,
        log: opts.log,
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.readFile ? { readFile: opts.readFile } : {}),
        ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
        onChange: () => changed?.(),
        images: opts.images?.length ? new ImageAllow(opts.images) : null,
      });
      proxies.set(ns, proxy);
    }
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

    async accept(args?: unknown): Promise<StreamRefusal | null> {
      if (streamNamespace(args, opts.namespace, served) === null) {
        const asked = askedNamespace(args);
        opts.log.warn('policy.denied', { service: 'kube', rule: 'namespace', ...(asked ? { namespace: asked } : {}) });
        refusedOpens.set(asked, (refusedOpens.get(asked) ?? 0) + 1);
        return args === undefined
          ? { code: 'denied', message: 'This connector serves several namespaces: the open must name one.' }
          : { code: 'denied', message: 'That namespace is not served by this connector.' };
      }
      if (!status.ok || Date.now() - probedAt > 3000) await refresh();
      return status.ok ? null : { code: server ? 'upstream_unreachable' : 'service_unavailable', message: status.error ?? 'Kubernetes is not available.' };
    },

    handle(stream: TunnelStream, trace: string, args?: unknown) {
      const ns = streamNamespace(args, opts.namespace, served);
      const p = ns === null ? null : ensure(ns);
      if (!p) return void stream.destroy();
      p.serve(stream, trace);
    },

    status: () => status,
    refresh,
    onChange: (fn) => void (changed = fn),

    /** Refusals since the last report, by rule and namespace: a proxy's under the namespace of its streams, a refused open under the one it asked for. */
    report(): Pick<ConnectStatusMessage, 'denied'> {
      const counts = new Map<string, { rule: string; count: number; namespace?: string }>();
      const add = (rule: string, count: number, namespace: string) => {
        const key = `${rule}\u0000${namespace}`;
        const had = counts.get(key);
        if (had) had.count += count;
        else counts.set(key, { rule, count, ...(namespace ? { namespace } : {}) });
      };
      for (const [ns, p] of proxies) for (const d of p.takeDenied()) add(d.rule, d.count, ns);
      for (const [ns, count] of refusedOpens) add('namespace', count, ns);
      refusedOpens.clear();
      const denied = [...counts.values()];
      return denied.length ? { denied } : {};
    },

    close() {
      for (const p of proxies.values()) p.close();
    },
  };
}
