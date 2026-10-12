// What the Kubernetes proxy lets a workspace's objects contain (docs/prd/targets-connect.md §11.5, H7). RBAC grants the connector `create` and
// `update` on deployments, claims and secrets in its namespace, and says nothing about WHAT they contain: a Deployment can ask for a privileged
// pod, a host path or the host's network, a claim can bind itself to somebody's volume. The proxy refuses those, in the body of a create, a
// replace and a patch alike. It is a deny-list on purpose: a field the portal may one day add (a node selector, a toleration) must not be
// refused for being new, while the fields that break out of the workspace's own sandbox never get through. What `KubernetesRuntime` creates
// today (a pod-level security context with uid 1000, a home volume, an init container, resource limits, an image pull secret) is all allowed.
import { ImageAllow } from '../docker/rules.js';
import { refuseKube, type KubeRefusal } from './status.js';
import type { KubeRoute } from './rules.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const truthy = (v: unknown) => v === true || (typeof v === 'string' && v.toLowerCase() === 'true');
const nonEmpty = (v: unknown) => (Array.isArray(v) ? v.length > 0 : isObj(v) ? Object.keys(v).length > 0 : v !== undefined && v !== null && v !== '');

/** The only kinds of volume a workspace pod may have: its claim, scratch space, and the usual ways to read config and secrets. */
const SAFE_VOLUME_KEYS = new Set(['name', 'persistentVolumeClaim', 'emptyDir', 'configMap', 'secret', 'projected', 'downwardAPI']);
const MAX_NODES = 50_000;
const MAX_DEPTH = 24;

const spec = (message: string) => refuseKube('spec', message);

/** Walks a pod template (or a patch of one) for the settings that leave the sandbox. */
function scan(node: unknown, key: string, depth: number, budget: { n: number }, images: ImageAllow | null): KubeRefusal | null {
  if (depth > MAX_DEPTH || ++budget.n > MAX_NODES) return spec('The object is too deeply nested.');
  if (Array.isArray(node)) {
    for (const item of node) {
      if (key === 'volumes' && isObj(item)) {
        for (const k of Object.keys(item)) if (!SAFE_VOLUME_KEYS.has(k) && !k.startsWith('$')) return spec(`A volume of kind ${JSON.stringify(k.slice(0, 30))} is not allowed.`);
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
        return spec('Host paths are not allowed.');
      case 'hostNetwork':
      case 'hostPID':
      case 'hostIPC':
      case 'shareProcessNamespace':
      case 'privileged':
        if (truthy(v)) return spec(`${k} is not allowed.`);
        break;
      case 'allowPrivilegeEscalation':
        if (truthy(v)) return spec('Privilege escalation is not allowed.');
        break;
      case 'hostPort':
        if (nonEmpty(v) && v !== 0) return spec('Host ports are not allowed.');
        break;
      case 'procMount':
        if (v === 'Unmasked') return spec('An unmasked /proc is not allowed.');
        break;
      case 'mountPropagation':
        if (v === 'Bidirectional' || v === 'HostToContainer') return spec('Mount propagation is not allowed.');
        break;
      case 'volumeDevices':
        if (nonEmpty(v)) return spec('Raw block devices are not allowed.');
        break;
      case 'sysctls':
        if (nonEmpty(v)) return spec('Sysctls are not allowed.');
        break;
      case 'runAsUser':
        if (v === 0) return spec('Running as root is not allowed.');
        break;
      case 'serviceAccountName':
      case 'serviceAccount':
        if (nonEmpty(v) && v !== 'default') return spec('A workspace runs as the namespace’s default service account, nothing else.');
        break;
      case 'add':
        if (key === 'capabilities' && nonEmpty(v)) return spec('Added capabilities are not allowed.');
        break;
      case 'type':
        if (key === 'seccompProfile' && v === 'Unconfined') return spec('An unconfined seccomp profile is not allowed.');
        break;
      case 'image':
        if (images && typeof v === 'string' && !images.has(v)) return spec('That image is not allowed on this cluster.');
        break;
      default:
        break;
    }
    const r = scan(v, k, depth + 1, budget, images);
    if (r) return r;
  }
  return null;
}

/**
 * Checks the body of a write against what a workspace's object may contain. `doc` is the parsed JSON (for a patch, the patch document). Returns
 * a refusal, or null. Names and namespaces are checked by the proxy before this.
 */
export function checkKubeBody(route: KubeRoute, method: string, doc: unknown, images: ImageAllow | null): KubeRefusal | null {
  if ((route.kind === 'deploymentList' || route.kind === 'deployment') && typeof doc === 'object' && doc !== null) return scan(doc, 'deployment', 0, { n: 0 }, images);
  if (!isObj(doc)) return null;
  switch (route.kind) {
    case 'pvcList':
    case 'pvc': {
      const s = isObj(doc.spec) ? doc.spec : {};
      if (nonEmpty(s.volumeName)) return spec('A claim may not bind itself to a named volume.');
      if (nonEmpty(s.dataSource) || nonEmpty(s.dataSourceRef)) return spec('A claim may not be filled from another volume or snapshot.');
      if (nonEmpty(s.volumeMode) && s.volumeMode !== 'Filesystem') return spec('Only filesystem volumes are allowed.');
      return null;
    }
    case 'secretCreate':
    case 'secret':
      if (doc.type !== undefined && doc.type !== 'Opaque') return spec('A secret is Opaque (a token secret would mint a credential).');
      return null;
    default:
      void method;
      return null;
  }
}
