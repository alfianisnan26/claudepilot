// The REST calls the Cloudflare portal makes to a workspace namespace through the bridge (PILOT-1171, G6c), in place of the
// @kubernetes/client-node calls of apps/server/src/workspaces/kubernetes.ts: list (pods, Deployments, claims, with the managed selector),
// create (a claim, a Deployment), scale (0 or 1), delete, and the metrics API. This file builds each request and reads each answer; it does
// no I/O. BridgeDO (src/do/bridge.ts) writes the request on a `kube` stream (src/bridge/http1.ts) and exposes each call by RPC.
//
// The Worker checks what it sends, and does not rely on the agent's KubeProxy alone (the proxy's allowlist, apps/server/src/connect/agent/
// services/kube/rules.ts, is the second wall, RBAC the third): a path is plain segments only (no `..`, no percent-encoding, no query), every
// object name is a workspace's (`ws-*`), every list carries the managed selector, and a created object is in the stream's namespace and
// labelled managed. A kube `Status` answer becomes a typed failure with its HTTP status, reason and message.

import { CONNECT_LIMITS } from '@portal/contracts';

/** The labels the portal puts on what it manages (apps/server/src/workspaces/runtime.ts `LABEL`). */
export const KUBE_LABEL = { managed: 'claudepilot.managed', workspace: 'claudepilot.workspace' } as const;
export const KUBE_MANAGED_SELECTOR = `${KUBE_LABEL.managed}=true`;

/** One path segment: what Kubernetes resource paths are made of. No `%` (so no encoded dot or slash), no `?`, no `#`, no `\`. */
const SEGMENT = /^[A-Za-z0-9._-]{1,253}$/;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
/** A workspace object (`ws-<12 hex>` today), a DNS label so its pods and its claim name stay valid. */
const WORKSPACE_OBJECT = /^ws-[a-z0-9]([-a-z0-9]{0,58}[a-z0-9])?$/;
const CLAIM_SUFFIX = '-home';
/** Replicas a workspace may have: one pod on a ReadWriteOnce home (Recreate), or none. */
const REPLICAS = new Set([0, 1]);

/**
 * Why a path may not go on a `kube` stream, or null. Origin-form, at most 2,048 characters, segments of letters, digits, `.`, `_` and `-`
 * only, and no `.` or `..` segment. That refuses a query string, percent-encoding (`%2e%2e`, `%2f`), `//`, a trailing slash and a backslash.
 */
export function kubePathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length < 2 || path.length > 2048) return 'The path is not valid.';
  if (/[?#]/.test(path)) return 'A query string is not allowed in the path.';
  if (path.includes('%')) return 'Percent-encoding is not allowed in the path.';
  for (const segment of path.slice(1).split('/')) {
    if (segment === '.' || segment === '..') return 'A dot segment is not allowed in the path.';
    if (!SEGMENT.test(segment)) return 'The path is not valid.';
  }
  return null;
}

export const kubeNamespaceOk = (ns: unknown): ns is string => typeof ns === 'string' && DNS_LABEL.test(ns);
export const kubeWorkspaceObjectOk = (name: unknown): name is string => typeof name === 'string' && WORKSPACE_OBJECT.test(name);
/** A claim is its workspace object's name plus `-home` (apps/server/src/workspaces/identity.ts `homeVolumeOf`). */
export const kubeClaimOk = (name: unknown): name is string =>
  typeof name === 'string' && name.endsWith(CLAIM_SUFFIX) && kubeWorkspaceObjectOk(name.slice(0, -CLAIM_SUFFIX.length));

export type KubeListKind = 'pods' | 'deployments' | 'claims';
export type KubeObjectKind = 'deployment' | 'claim';

export type KubeOp =
  /** A list with the managed selector; `workspace` narrows it to one workspace's (the `claudepilot.workspace` label). */
  | { op: 'list'; kind: KubeListKind; workspace?: string }
  /** Pod metrics (metrics.k8s.io) with the managed selector. */
  | { op: 'metrics'; workspace?: string }
  | { op: 'create'; kind: KubeObjectKind; object: Record<string, unknown> }
  | { op: 'scale'; name: string; replicas: number }
  /** Deletes a Deployment (foreground: its pods go first) or a claim. A missing object is `deleted: false`, not an error. */
  | { op: 'delete'; kind: KubeObjectKind; name: string };

/** One request, as written on the stream: `path` passed kubePathProblem, `query` was built here. */
export interface KubeCall {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query: string;
  body?: string;
}

export type KubeFailure = {
  ok: false;
  /** `bad_request` (refused here), `kube_status` (the API server or the agent's proxy answered non-2xx), `bad_response`, or a Connect code. */
  code: string;
  message: string;
  /** The HTTP status, for `kube_status`. */
  status?: number;
  /** The Status `reason` (`NotFound`, `AlreadyExists`, `Forbidden`...), when the answer had one. */
  reason?: string | null;
};

/** The answer to a list or to metrics: the raw items (the portal reads the fields it needs). */
export type KubeItems = { ok: true; items: unknown[] } | KubeFailure;
/** The answer to a create: the object as the API server stored it. */
export type KubeCreated = { ok: true; object: Record<string, unknown> } | KubeFailure;
/** The answer to a scale: the replicas the Scale now says. */
export type KubeScaled = { ok: true; replicas: number } | KubeFailure;
export type KubeDeleted = { ok: true; deleted: boolean } | KubeFailure;
export type KubeOpResult = KubeItems | KubeCreated | KubeScaled | KubeDeleted;

export const kubeBadRequest = (message: string): KubeFailure => ({ ok: false, code: 'bad_request', message });

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const collection = (ns: string, kind: KubeListKind | 'metrics'): string =>
  ({
    pods: `/api/v1/namespaces/${ns}/pods`,
    deployments: `/apis/apps/v1/namespaces/${ns}/deployments`,
    claims: `/api/v1/namespaces/${ns}/persistentvolumeclaims`,
    metrics: `/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods`,
  })[kind];

interface ObjectSpec {
  list: KubeListKind;
  apiVersion: string;
  kind: string;
  nameOk: (n: unknown) => boolean;
}

const OBJECT: Record<KubeObjectKind, ObjectSpec> = {
  deployment: { list: 'deployments', apiVersion: 'apps/v1', kind: 'Deployment', nameOk: kubeWorkspaceObjectOk },
  claim: { list: 'claims', apiVersion: 'v1', kind: 'PersistentVolumeClaim', nameOk: kubeClaimOk },
};
/** The spec of a kind a caller named, or undefined (an own-property lookup: `__proto__` or `toString` is no kind). */
const objectSpec = (kind: unknown): ObjectSpec | undefined =>
  typeof kind === 'string' && Object.prototype.hasOwnProperty.call(OBJECT, kind) ? OBJECT[kind as KubeObjectKind] : undefined;

function selectorFor(workspace: unknown): string | KubeFailure {
  if (workspace === undefined) return KUBE_MANAGED_SELECTOR;
  if (typeof workspace !== 'string' || !DNS_LABEL.test(workspace)) return kubeBadRequest('The workspace label is not valid.');
  return `${KUBE_MANAGED_SELECTOR},${KUBE_LABEL.workspace}=${workspace}`;
}

/** The request for one call in namespace `ns`, or why it is refused. Everything the caller gives is checked; nothing is passed raw. */
export function kubeCallOf(ns: string, op: KubeOp): KubeCall | KubeFailure {
  if (!kubeNamespaceOk(ns)) return kubeBadRequest('The namespace is not valid.');
  if (!isObject(op)) return kubeBadRequest('The call is not valid.');
  let call: KubeCall;
  switch (op.op) {
    case 'list':
    case 'metrics': {
      const kind = op.op === 'metrics' ? 'metrics' : op.kind;
      if (!['metrics', 'pods', 'deployments', 'claims'].includes(kind)) return kubeBadRequest('The list kind is not valid.');
      const selector = selectorFor(op.workspace);
      if (typeof selector !== 'string') return selector;
      call = { method: 'GET', path: collection(ns, kind), query: new URLSearchParams({ labelSelector: selector }).toString() };
      break;
    }
    case 'create': {
      const spec = objectSpec(op.kind);
      if (!spec) return kubeBadRequest('The object kind is not valid.');
      const o = op.object;
      if (!isObject(o) || !isObject(o.metadata)) return kubeBadRequest('The object is not valid.');
      const meta = o.metadata;
      if (!spec.nameOk(meta.name)) return kubeBadRequest('The object’s name is not one of the portal’s workspaces.');
      if (meta.namespace !== undefined && meta.namespace !== ns) return kubeBadRequest('The object names another namespace.');
      if (!isObject(meta.labels) || meta.labels[KUBE_LABEL.managed] !== 'true')
        return kubeBadRequest('The object is not labelled as the portal’s.');
      if ((o.apiVersion !== undefined && o.apiVersion !== spec.apiVersion) || (o.kind !== undefined && o.kind !== spec.kind))
        return kubeBadRequest(`The object is not a ${spec.kind}.`);
      const body = JSON.stringify({ ...o, apiVersion: spec.apiVersion, kind: spec.kind, metadata: { ...meta, namespace: ns } });
      if (new TextEncoder().encode(body).length > CONNECT_LIMITS.maxJsonBody) return kubeBadRequest('The object is too large.');
      call = { method: 'POST', path: collection(ns, spec.list), query: '', body };
      break;
    }
    case 'scale': {
      if (!kubeWorkspaceObjectOk(op.name)) return kubeBadRequest('The name is not one of the portal’s workspaces.');
      if (typeof op.replicas !== 'number' || !REPLICAS.has(op.replicas)) return kubeBadRequest('A workspace has 0 or 1 replicas.');
      const body = JSON.stringify({
        apiVersion: 'autoscaling/v1',
        kind: 'Scale',
        metadata: { name: op.name, namespace: ns },
        spec: { replicas: op.replicas },
      });
      call = { method: 'PUT', path: `${collection(ns, 'deployments')}/${op.name}/scale`, query: '', body };
      break;
    }
    case 'delete': {
      const spec = objectSpec(op.kind);
      if (!spec) return kubeBadRequest('The object kind is not valid.');
      if (!spec.nameOk(op.name)) return kubeBadRequest('The name is not one of the portal’s workspaces.');
      const query = op.kind === 'deployment' ? new URLSearchParams({ propagationPolicy: 'Foreground' }).toString() : '';
      call = { method: 'DELETE', path: `${collection(ns, spec.list)}/${op.name}`, query };
      break;
    }
    default:
      return kubeBadRequest('The call is not valid.');
  }
  // Built from checked parts, so this holds; checked anyway, so a change above cannot send a path the Worker would refuse from a caller.
  const problem = kubePathProblem(call.path);
  return problem ? kubeBadRequest(problem) : call;
}

/** A non-2xx answer as a failure: the Status's reason and message when the body is one (the API server's, or the agent proxy's 401/403). */
export function kubeStatusFailure(status: number, body: string): KubeFailure {
  let reason: string | null = null;
  let message = `The Kubernetes API answered ${status}.`;
  try {
    const s = JSON.parse(body) as unknown;
    if (isObject(s) && s.kind === 'Status') {
      if (typeof s.reason === 'string' && s.reason) reason = s.reason.slice(0, 64);
      if (typeof s.message === 'string' && s.message) message = s.message.slice(0, 300);
    }
  } catch {
    // not JSON: the plain message
  }
  return { ok: false, code: 'kube_status', status, reason, message };
}

const badResponse = (message: string): KubeFailure => ({ ok: false, code: 'bad_response', message });

/** Reads the answer to `op`: KubeItems for a list or metrics, KubeCreated, KubeScaled or KubeDeleted for the others. */
export function kubeResultOf(op: KubeOp, status: number, body: string): KubeOpResult {
  if (op.op === 'delete' && status === 404) return { ok: true, deleted: false };
  if (status < 200 || status > 299) return kubeStatusFailure(status, body);
  if (op.op === 'delete') return { ok: true, deleted: true };
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return badResponse('The answer is not JSON.');
  }
  if (!isObject(doc)) return badResponse('The answer is not an object.');
  switch (op.op) {
    case 'list':
    case 'metrics':
      return Array.isArray(doc.items) ? { ok: true, items: doc.items as unknown[] } : badResponse('The answer has no items.');
    case 'create':
      return { ok: true, object: doc };
    case 'scale': {
      const replicas = isObject(doc.spec) ? doc.spec.replicas : undefined;
      return typeof replicas === 'number' ? { ok: true, replicas } : badResponse('The answer has no replicas.');
    }
    default:
      return badResponse('The call is not valid.');
  }
}
