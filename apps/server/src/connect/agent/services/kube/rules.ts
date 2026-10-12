// The Kubernetes allowlist (docs/prd/targets-connect.md §11.5, appendix B): which paths and verbs the connector's proxy forwards, all under
// the connector's own namespace, with the object names the portal's workspaces use (`ws-*`). Everything else is a `Status` 403. RBAC is the
// second wall (the Role grants only these resources in that namespace); this file is the first, for a portal or a loopback process that asks
// for more than the Role would refuse.
import { refuseKube, type KubeRefusal } from './status.js';

export type KubeKind =
  | 'version'
  | 'podList'
  | 'pod'
  | 'exec'
  | 'pvcList'
  | 'pvc'
  | 'secretCreate'
  | 'secret'
  | 'deploymentList'
  | 'deployment'
  | 'scale'
  | 'metrics';

export interface KubeRoute {
  kind: KubeKind;
  name?: string;
  methods: string[];
}

const DNS = '[a-z0-9](?:[a-z0-9.-]{0,240}[a-z0-9])?';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The names a workspace's objects have (PRD appendix B). */
export const NAMES = {
  pod: new RegExp(`^ws-${DNS}$`),
  pvc: new RegExp(`^ws-${DNS}-home$`),
  secret: new RegExp(`^ws-${DNS}-claudepilot$`),
  deployment: new RegExp(`^ws-${DNS}$`),
};

/** Whether a namespace name can be used in a path match at all (DNS label). */
export const validNamespace = (ns: string): boolean => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(ns);

/** Classifies a method and an (already clean) path against the allowlist for namespace `ns`. */
export function classifyKube(method: string, path: string, ns: string): KubeRoute | KubeRefusal {
  const n = escape(ns);
  const table: [RegExp, (m: RegExpExecArray) => KubeRoute | KubeRefusal][] = [
    [/^\/version$/, () => ({ kind: 'version', methods: ['GET'] })],
    [new RegExp(`^/api/v1/namespaces/${n}/pods$`), () => ({ kind: 'podList', methods: ['GET'] })],
    [new RegExp(`^/api/v1/namespaces/${n}/pods/([^/]+)$`), (m) => named('pod', m[1]!, ['GET'], NAMES.pod)],
    [new RegExp(`^/api/v1/namespaces/${n}/pods/([^/]+)/exec$`), (m) => named('exec', m[1]!, ['GET', 'POST'], NAMES.pod)],
    [new RegExp(`^/api/v1/namespaces/${n}/persistentvolumeclaims$`), () => ({ kind: 'pvcList', methods: ['GET', 'POST'] })],
    [new RegExp(`^/api/v1/namespaces/${n}/persistentvolumeclaims/([^/]+)$`), (m) => named('pvc', m[1]!, ['GET', 'DELETE'], NAMES.pvc)],
    // Secrets: by name only; a list would show the agent's own two Secrets.
    [new RegExp(`^/api/v1/namespaces/${n}/secrets$`), () => ({ kind: 'secretCreate', methods: ['POST'] })],
    [new RegExp(`^/api/v1/namespaces/${n}/secrets/([^/]+)$`), (m) => named('secret', m[1]!, ['GET', 'PUT', 'PATCH', 'DELETE'], NAMES.secret)],
    [new RegExp(`^/apis/apps/v1/namespaces/${n}/deployments$`), () => ({ kind: 'deploymentList', methods: ['GET', 'POST'] })],
    [new RegExp(`^/apis/apps/v1/namespaces/${n}/deployments/([^/]+)$`), (m) => named('deployment', m[1]!, ['GET', 'PUT', 'PATCH', 'DELETE'], NAMES.deployment)],
    [new RegExp(`^/apis/apps/v1/namespaces/${n}/deployments/([^/]+)/scale$`), (m) => named('scale', m[1]!, ['GET', 'PUT', 'PATCH'], NAMES.deployment)],
    [new RegExp(`^/apis/metrics\\.k8s\\.io/v1beta1/namespaces/${n}/pods$`), () => ({ kind: 'metrics', methods: ['GET'] })],
  ];
  for (const [re, make] of table) {
    const m = re.exec(path);
    if (!m) continue;
    const route = make(m);
    if ('rule' in route) return route;
    return route.methods.includes(method) ? route : refuseKube('method', `${method} is not allowed on this path.`);
  }
  // A path under another namespace says so; a resource of this namespace that is not on the list is `resource`; anything else is simply not offered.
  const inNamespace = /^\/(?:api\/v1|apis\/[^/]+\/[^/]+)\/namespaces\/([^/]+)(?:\/|$)/.exec(path);
  if (inNamespace) return inNamespace[1] === ns ? refuseKube('resource', 'That resource is not available through the tunnel.') : refuseKube('namespace', 'Only the connector’s own namespace is available.');
  return refuseKube('path', 'This part of the Kubernetes API is not available through the tunnel.');
}

function named(kind: KubeKind, name: string, methods: string[], pattern: RegExp): KubeRoute | KubeRefusal {
  if (!pattern.test(name)) return refuseKube('name', 'That object name is not one of the portal’s workspaces.');
  return { kind, name, methods };
}

/* ---------------------------------------------------------------------------------------------------------------------------- *
 * Query parameters: each route forwards only the keys it knows, checked.
 * ---------------------------------------------------------------------------------------------------------------------------- */

const SELECTOR = /^[A-Za-z0-9_./=!, ()-]{0,1024}$/;
const BOOL = /^(?:true|false|1|0)$/;
const INT = /^\d{1,10}$/;
const TOKEN = /^[A-Za-z0-9_.:=\-@/+]{0,512}$/;

type Check = (v: string) => boolean;

const LIST_KEYS: Record<string, Check> = {
  fieldSelector: (v) => SELECTOR.test(v),
  limit: (v) => INT.test(v),
  continue: (v) => TOKEN.test(v) || v.length <= 2048,
  watch: (v) => BOOL.test(v),
  resourceVersion: (v) => /^\d{0,20}$/.test(v),
  resourceVersionMatch: (v) => /^[A-Za-z]{0,32}$/.test(v),
  timeoutSeconds: (v) => INT.test(v),
  allowWatchBookmarks: (v) => BOOL.test(v),
  sendInitialEvents: (v) => BOOL.test(v),
};
const GET_KEYS: Record<string, Check> = { resourceVersion: LIST_KEYS.resourceVersion! };
const WRITE_KEYS: Record<string, Check> = { fieldManager: (v) => TOKEN.test(v), fieldValidation: (v) => /^(?:Strict|Warn|Ignore)$/.test(v) };
const DELETE_KEYS: Record<string, Check> = { propagationPolicy: (v) => /^(?:Foreground|Background|Orphan)$/.test(v), gracePeriodSeconds: (v) => INT.test(v) };
const EXEC_KEYS: Record<string, Check> = {
  container: (v) => v === 'workspace',
  stdin: (v) => BOOL.test(v),
  stdout: (v) => BOOL.test(v),
  stderr: (v) => BOOL.test(v),
  tty: (v) => BOOL.test(v),
};

export const MANAGED_SELECTOR = 'claudepilot.managed=true';
const LISTED = new Set<KubeKind>(['podList', 'pvcList', 'deploymentList', 'metrics']);

/** The query to send: only checked keys, and on a list of pods, deployments or claims the managed selector added. Null with a refusal when a value is bad. */
export function rebuildQuery(route: KubeRoute, method: string, q: URLSearchParams): { query: string } | KubeRefusal {
  const out = new URLSearchParams();
  const take = (keys: Record<string, Check>) => {
    for (const [k, v] of q) {
      if (k === 'labelSelector' || k === 'command') continue;
      const check = keys[k];
      if (!check) continue; // an unknown key is not forwarded
      if (!check(v)) return refuseKube('path', `The parameter ${k} is not valid.`);
      out.append(k, v);
    }
    return null;
  };
  let problem: KubeRefusal | null;
  if (route.kind === 'exec') {
    problem = take(EXEC_KEYS);
    if (problem) return problem;
    const commands = q.getAll('command');
    if (commands.length === 0 || commands.length > 1000 || commands.some((c) => c.length > 65_536 || c.includes('\0'))) return refuseKube('path', 'An exec needs a command.');
    if (q.getAll('container').length !== 1 || q.get('container') !== 'workspace') return refuseKube('path', 'Only the workspace container may be entered.');
    for (const c of commands) out.append('command', c);
  } else if (method === 'GET' && LISTED.has(route.kind)) {
    problem = take(LIST_KEYS);
    if (problem) return problem;
    // A list or a watch only ever shows this portal's workspaces: the managed selector is added to whatever the client asked.
    const given = q.get('labelSelector');
    if (given !== null && !SELECTOR.test(given)) return refuseKube('selector', 'The label selector is not valid.');
    out.set('labelSelector', given && !given.split(',').map((s) => s.trim()).includes(MANAGED_SELECTOR) ? `${given},${MANAGED_SELECTOR}` : (given || MANAGED_SELECTOR));
  } else if (method === 'GET') {
    problem = take(GET_KEYS);
    if (problem) return problem;
  } else if (method === 'DELETE') {
    problem = take(DELETE_KEYS);
    if (problem) return problem;
  } else {
    problem = take(WRITE_KEYS);
    if (problem) return problem;
  }
  return { query: out.toString() };
}

/** `Connection: Upgrade` is for the exec of a workspace pod only, as a WebSocket. */
export const mayUpgrade = (route: KubeRoute): boolean => route.kind === 'exec';
