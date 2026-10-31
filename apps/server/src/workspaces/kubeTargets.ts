// `PORTAL_K8S_TARGETS` (owner, 2026-10-31: one workspace per org, one namespace per org): more local Kubernetes targets beside the single
// `kubernetes` one, which stays exactly as it was (`PORTAL_K8S_NAMESPACE`, id `kubernetes`). Each entry is its own KubernetesRuntime on the
// same kubeconfig (the portal's in-cluster service account) in its own namespace; its workspaces are `<id>/<name>`. Image, pull secret,
// storage and requests come from the `PORTAL_K8S_*` settings unless the entry names its own.
//
// A JSON array, for example:
//   [{"id":"isnan","namespace":"isnan-workspaces","label":"isnan","preferredNodes":["k3s-node2"],"cpus":4,"memoryMb":8192}]
// Keys: id, namespace (required); label, nodeSelector ({"k":"v"} or "k=v,k=v"; replaces PORTAL_K8S_NODE_SELECTOR for this target),
// preferredNodes (node names: a soft preference, and the nodes the New workspace dialog offers; a create naming one is pinned there, in place
// of a `kubernetes.io/hostname` in nodeSelector), cpus, memoryMb (the limits a create that names none gets, and the dialog's preset),
// cpuRequest, memoryRequest (what a pod reserves, at most its limits; replace PORTAL_K8S_CPU_REQUEST / PORTAL_K8S_MEMORY_REQUEST), storage,
// storageClass. Anything else is refused, like a malformed value: the portal stops at start with the reason
// (as PORTAL_K8S_NODE_SELECTOR does), so a typo never silently drops an org's workspaces.

import { connectTargetIdProblem } from '@portal/contracts';
import { PLAIN_NAME } from '../names.js';
import type { KubernetesOptions } from './kubernetes.js';
import { parseNodeSelector } from './nodeSelector.js';
import { cpuMilli, memoryBytes, type RequestOptions } from './requests.js';

export interface KubeTargetSpec {
  id: string;
  label: string;
  namespace: string;
  /** Hard placement (every node it may go to); absent: PORTAL_K8S_NODE_SELECTOR's. */
  nodeSelector?: Record<string, string>;
  /** Soft placement (preferred node affinity, in this order) and the nodes a create may name. */
  preferredNodes?: string[];
  /** What a create that names no CPU or memory gets. */
  defaults?: { cpus?: number; memoryMb?: number };
  /** What a pod reserves (each at most its limit); a field left out is PORTAL_K8S_*_REQUEST's. */
  requests?: RequestOptions;
  storage?: string;
  storageClass?: string;
}

const KEYS = new Set(['id', 'namespace', 'label', 'nodeSelector', 'preferredNodes', 'cpus', 'memoryMb', 'cpuRequest', 'memoryRequest', 'storage', 'storageClass']);
/** A namespace or a storage class: a DNS label, as the API server wants. */
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const QUANTITY = /^[0-9]+(\.[0-9]+)?(Ki|Mi|Gi|Ti|k|M|G|T)?$/;

const fail = (why: string): never => {
  throw new Error(`PORTAL_K8S_TARGETS is not usable: ${why}`);
};

/**
 * The extra targets, or [] when unset. `taken`: ids and namespaces already in use (the `kubernetes` target's namespace): an entry on the
 * same namespace would list the same Deployments twice under two ids.
 */
export function parseKubeTargets(text: string | undefined, taken: { namespaces?: readonly string[] } = {}): KubeTargetSpec[] {
  if (text === undefined || text.trim() === '') return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(`it is not JSON (${(e as Error).message.slice(0, 120)}).`);
  }
  if (!Array.isArray(raw)) return fail('it must be a JSON array of targets.');
  const ids = new Set<string>();
  const namespaces = new Set<string>(taken.namespaces ?? []);
  return raw.map((entry, i): KubeTargetSpec => {
    const at = `target ${i + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail(`${at} is not an object.`);
    const e = entry as Record<string, unknown>;
    const unknown = Object.keys(e).filter((k) => !KEYS.has(k));
    if (unknown.length) fail(`${at} has unknown key(s) ${unknown.map((k) => JSON.stringify(k.slice(0, 40))).join(', ')}.`);

    if (typeof e.id !== 'string') return fail(`${at} needs an "id".`);
    const idProblem = connectTargetIdProblem(e.id);
    if (idProblem) fail(`${at}: id ${JSON.stringify(e.id.slice(0, 40))}: ${idProblem}`);
    if (ids.has(e.id)) fail(`id "${e.id}" is used twice.`);
    ids.add(e.id);
    const named = `target "${e.id}"`;

    if (typeof e.namespace !== 'string' || !DNS_LABEL.test(e.namespace)) return fail(`${named} needs a "namespace" (a DNS label: lowercase letters, digits, dashes).`);
    if (namespaces.has(e.namespace)) fail(`namespace "${e.namespace}" is used by two targets.`);
    namespaces.add(e.namespace);

    let label = e.id;
    if (e.label !== undefined) {
      if (typeof e.label !== 'string' || !e.label.trim() || e.label.trim().length > 40) fail(`${named}: "label" is text of 1 to 40 characters.`);
      label = (e.label as string).trim();
    }

    const spec: KubeTargetSpec = { id: e.id, label, namespace: e.namespace };

    if (e.nodeSelector !== undefined) {
      let text: string;
      if (typeof e.nodeSelector === 'string') text = e.nodeSelector;
      else if (e.nodeSelector && typeof e.nodeSelector === 'object' && !Array.isArray(e.nodeSelector)) {
        const pairs = Object.entries(e.nodeSelector as Record<string, unknown>);
        if (pairs.some(([, v]) => typeof v !== 'string')) fail(`${named}: "nodeSelector" values are strings.`);
        text = pairs.map(([k, v]) => `${k}=${v as string}`).join(',');
      } else return fail(`${named}: "nodeSelector" is {"key":"value"} or "key=value[,key=value]".`);
      try {
        const parsed = parseNodeSelector(text);
        if (parsed) spec.nodeSelector = parsed;
      } catch (err) {
        fail(`${named}: "nodeSelector": ${(err as Error).message.replace(/^PORTAL_K8S_NODE_SELECTOR is not usable: /, '')}`);
      }
    }

    if (e.preferredNodes !== undefined) {
      const nodes = e.preferredNodes;
      if (!Array.isArray(nodes) || !nodes.length || nodes.some((n) => typeof n !== 'string' || !PLAIN_NAME.test(n)))
        return fail(`${named}: "preferredNodes" is a non-empty list of node names.`);
      if (new Set(nodes).size !== nodes.length) fail(`${named}: "preferredNodes" names a node twice.`);
      spec.preferredNodes = nodes as string[];
    }

    if (e.cpus !== undefined) {
      if (typeof e.cpus !== 'number' || !(e.cpus > 0 && e.cpus <= 64)) fail(`${named}: "cpus" is a number above 0, at most 64.`);
      spec.defaults = { ...spec.defaults, cpus: e.cpus as number };
    }
    if (e.memoryMb !== undefined) {
      if (typeof e.memoryMb !== 'number' || !Number.isInteger(e.memoryMb) || e.memoryMb < 256) fail(`${named}: "memoryMb" is a whole number, at least 256.`);
      spec.defaults = { ...spec.defaults, memoryMb: e.memoryMb as number };
    }
    if (e.cpuRequest !== undefined) {
      if (typeof e.cpuRequest !== 'string' || cpuMilli(e.cpuRequest) === null) fail(`${named}: "cpuRequest" is a CPU quantity such as 500m or 1.`);
      spec.requests = { ...spec.requests, cpu: e.cpuRequest as string };
    }
    if (e.memoryRequest !== undefined) {
      if (typeof e.memoryRequest !== 'string' || memoryBytes(e.memoryRequest) === null) fail(`${named}: "memoryRequest" is a memory quantity such as 2Gi.`);
      spec.requests = { ...spec.requests, memory: e.memoryRequest as string };
    }
    if (e.storage !== undefined) {
      if (typeof e.storage !== 'string' || !QUANTITY.test(e.storage)) fail(`${named}: "storage" is a size such as 10Gi.`);
      spec.storage = e.storage as string;
    }
    if (e.storageClass !== undefined) {
      if (typeof e.storageClass !== 'string' || !DNS_LABEL.test(e.storageClass)) fail(`${named}: "storageClass" is a storage class name.`);
      spec.storageClass = e.storageClass as string;
    }
    return spec;
  });
}

/**
 * The options of each extra target's runtime: the `kubernetes` target's settings (image, pull secret, storage, requests, node selector)
 * with the entry's own on top. Kept apart from the constructor so the mapping is tested without a cluster.
 */
export function kubeTargetOptions(base: Omit<KubernetesOptions, 'namespace'> & { targets: readonly KubeTargetSpec[] }): KubernetesOptions[] {
  return base.targets.map((t) => ({
    namespace: t.namespace,
    image: base.image,
    storage: t.storage ?? base.storage,
    ...(base.imagePullSecret ? { imagePullSecret: base.imagePullSecret } : {}),
    ...((t.storageClass ?? base.storageClass) ? { storageClass: t.storageClass ?? base.storageClass } : {}),
    ...((t.nodeSelector ?? base.nodeSelector) ? { nodeSelector: t.nodeSelector ?? base.nodeSelector } : {}),
    ...(base.requests || t.requests ? { requests: { ...base.requests, ...t.requests } } : {}),
    target: { id: t.id, label: t.label },
    manageNamespace: false,
    ...(t.preferredNodes ? { preferredNodes: t.preferredNodes } : {}),
    ...(t.defaults ? { defaults: t.defaults } : {}),
  }));
}

/** One runtime per extra target; one that cannot be made is left out (`failed`), never the others. */
export function kubeTargetRuntimes<R>(base: Parameters<typeof kubeTargetOptions>[0], make: (opts: KubernetesOptions) => R, failed: (id: string, e: Error) => void): R[] {
  const out: R[] = [];
  for (const opts of kubeTargetOptions(base)) {
    try {
      out.push(make(opts));
    } catch (e) {
      failed(opts.target!.id, e as Error);
    }
  }
  return out;
}
