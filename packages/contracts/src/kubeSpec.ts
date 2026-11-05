// What a workspace's Kubernetes objects may contain: ONE rule table, used by the agent's KubeProxy
// (apps/server/src/connect/agent/services/kube/schema.ts) and by the Cloudflare Worker before a stream opens
// (apps/core-worker/src/bridge/kubeApi.ts, PILOT-1187). RBAC grants `create` and `update` on deployments, claims and secrets, and says
// nothing about WHAT they contain: a Deployment can ask for a privileged pod, a host path or the host's network, a claim can bind itself to
// somebody's volume. This refuses those, in the body of a create, a replace and a patch alike. It is a deny-list on purpose: a field the
// portal may one day add (a node selector, a toleration) must not be refused for being new, while the fields that break out of the
// workspace's own sandbox never get through. What the portal creates today (a pod-level security context with uid 1000, a home volume, an
// init container, resource limits, an image pull secret) is all allowed. Pure: no I/O, no Node or Workers API.

/** What is being written: a Deployment or ReplicaSet (or a patch of one), a claim, a secret, or an in-place resize (a JSON patch). */
export type KubeSpecTarget = 'workload' | 'claim' | 'secret' | 'resize';

/** The images a cluster allows (the agent's PILOT_IMAGES); null: not checked here. */
export interface KubeImageCheck {
  has(ref: string): boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const truthy = (v: unknown) => v === true || (typeof v === 'string' && v.toLowerCase() === 'true');
const nonEmpty = (v: unknown) =>
  Array.isArray(v) ? v.length > 0 : isObj(v) ? Object.keys(v).length > 0 : v !== undefined && v !== null && v !== '';

/** The only kinds of volume a workspace pod may have: its claim, scratch space, and the usual ways to read config and secrets. */
const SAFE_VOLUME_KEYS = new Set(['name', 'persistentVolumeClaim', 'emptyDir', 'configMap', 'secret', 'projected', 'downwardAPI']);
const MAX_NODES = 50_000;
const MAX_DEPTH = 24;

/** Walks a pod template (or a patch of one) for the settings that leave the sandbox; the refusal's message, or null. */
function scan(node: unknown, key: string, depth: number, budget: { n: number }, images: KubeImageCheck | null): string | null {
  if (depth > MAX_DEPTH || ++budget.n > MAX_NODES) return 'The object is too deeply nested.';
  if (Array.isArray(node)) {
    for (const item of node) {
      if (key === 'volumes' && isObj(item)) {
        for (const k of Object.keys(item))
          if (!SAFE_VOLUME_KEYS.has(k) && !k.startsWith('$')) return `A volume of kind ${JSON.stringify(k.slice(0, 30))} is not allowed.`;
      }
      const r = scan(item, key, depth + 1, budget, images);
      if (r) return r;
    }
    return null;
  }
  if (!isObj(node)) return null;
  for (const [k, v] of Object.entries(node)) {
    switch (k) {
      case 'hostPath':
        return 'Host paths are not allowed.';
      case 'hostNetwork':
      case 'hostPID':
      case 'hostIPC':
      case 'shareProcessNamespace':
      case 'privileged':
        if (truthy(v)) return `${k} is not allowed.`;
        break;
      case 'allowPrivilegeEscalation':
        if (truthy(v)) return 'Privilege escalation is not allowed.';
        break;
      case 'hostPort':
        if (nonEmpty(v) && v !== 0) return 'Host ports are not allowed.';
        break;
      case 'procMount':
        if (v === 'Unmasked') return 'An unmasked /proc is not allowed.';
        break;
      case 'mountPropagation':
        if (v === 'Bidirectional' || v === 'HostToContainer') return 'Mount propagation is not allowed.';
        break;
      case 'volumeDevices':
        if (nonEmpty(v)) return 'Raw block devices are not allowed.';
        break;
      case 'sysctls':
        if (nonEmpty(v)) return 'Sysctls are not allowed.';
        break;
      case 'runAsUser':
        if (v === 0) return 'Running as root is not allowed.';
        break;
      case 'serviceAccountName':
      case 'serviceAccount':
        if (nonEmpty(v) && v !== 'default') return 'A workspace runs as the namespace’s default service account, nothing else.';
        break;
      case 'add':
        if (key === 'capabilities' && nonEmpty(v)) return 'Added capabilities are not allowed.';
        break;
      case 'type':
        if (key === 'seccompProfile' && v === 'Unconfined') return 'An unconfined seccomp profile is not allowed.';
        break;
      case 'image':
        if (images && typeof v === 'string' && !images.has(v)) return 'That image is not allowed on this cluster.';
        break;
      default:
        break;
    }
    const r = scan(v, k, depth + 1, budget, images);
    if (r) return r;
  }
  return null;
}

/** A resize path: one container's resources, or a part of them (`/spec/containers/0/resources/limits/cpu`). */
const RESIZE_PATH = /^\/spec\/containers\/\d{1,3}\/resources(?:\/(?:limits|requests)(?:\/[A-Za-z0-9._~-]{1,253})?)?$/;

/**
 * The in-place resize (PILOT-1163): a JSON Patch (an array) whose every operation adds, replaces or tests a container's `resources`, and
 * nothing else; a value is scanned too (it can only be resources, but a deny-listed key in it is still refused).
 */
function resizeProblem(doc: unknown, images: KubeImageCheck | null): string | null {
  if (!Array.isArray(doc) || doc.length === 0 || doc.length > 64) return 'A resize is a JSON patch of container resources.';
  for (const op of doc) {
    if (!isObj(op) || !['add', 'replace', 'test'].includes(op.op as string) || typeof op.path !== 'string' || !RESIZE_PATH.test(op.path))
      return 'A resize may change container resources only.';
    if (Object.keys(op).some((k) => k !== 'op' && k !== 'path' && k !== 'value')) return 'A resize may change container resources only.';
    const r = scan(op.value, 'resources', 0, { n: 0 }, images);
    if (r) return r;
  }
  return null;
}

/**
 * Why `doc` (the parsed JSON body; for a patch, the patch document) may not be written as `target`, or null when it may. Names and
 * namespaces are checked by the caller before this.
 */
export function kubeSpecProblem(target: KubeSpecTarget, doc: unknown, images: KubeImageCheck | null): string | null {
  switch (target) {
    case 'workload':
      return typeof doc === 'object' && doc !== null ? scan(doc, 'deployment', 0, { n: 0 }, images) : null;
    case 'resize':
      return resizeProblem(doc, images);
    case 'claim': {
      if (!isObj(doc)) return null;
      const s = isObj(doc.spec) ? doc.spec : {};
      if (nonEmpty(s.volumeName)) return 'A claim may not bind itself to a named volume.';
      if (nonEmpty(s.dataSource) || nonEmpty(s.dataSourceRef)) return 'A claim may not be filled from another volume or snapshot.';
      if (nonEmpty(s.volumeMode) && s.volumeMode !== 'Filesystem') return 'Only filesystem volumes are allowed.';
      return null;
    }
    case 'secret':
      if (!isObj(doc)) return null;
      if (doc.type !== undefined && doc.type !== 'Opaque') return 'A secret is Opaque (a token secret would mint a credential).';
      return null;
  }
}
