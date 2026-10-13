import { PassThrough } from 'node:stream';
import type { BrowserPoolContent } from '@portal/contracts';
import {
  AppsV1Api,
  CoreV1Api,
  Exec,
  NetworkingV1Api,
  type V1ConfigMap,
  type V1Container,
  type V1Deployment,
  type V1NetworkPolicy,
  type V1Node,
  type V1Pod,
  type V1PodTemplateSpec,
  type V1Status,
  type V1Volume,
} from '@kubernetes/client-node';
import { cpuMilli, memoryBytes, requestsFor } from '../workspaces/requests.js';
import { seedHomeScript, type KubeBrowserAccess } from '../workspaces/kubernetes.js';
import type { Store } from '../store/store.js';
import { LABEL } from '../workspaces/runtime.js';
import type { ExecResult, ExecStream } from './companion.js';
import { chromePolicy, containerConfig } from './policy.js';
import { DOWNLOADS_DIR, HOME, PROFILE_REL, sha256 } from './spec.js';

/**
 * The browser on Kubernetes (browser & desktop PRD §10.2, §14.1, milestone B3): a second container named `browser` in the workspace's pod,
 * after `workspace`, so CDP, the supervisor and the VNC socket stay on the pod's own loopback. The Deployment's template is the record:
 * adding, changing or removing the container restarts the pod (strategy Recreate), so the portal does that only while the workspace is
 * stopped (and at its next start), after a fit check against the nodes' free requests. Its config and Chrome policy are a ConfigMap
 * (`<runtime name>-browser`, no secrets, owned by the Deployment), and a NetworkPolicy keeps the pod's egress off private ranges.
 */

export const BROWSER_CONTAINER = 'browser';
const WORKSPACE_CONTAINER = 'workspace';
/** On the pod template: the hash of everything the browser container is made from, so a change shows without comparing fields. */
export const SPEC_ANNOTATION = 'claudepilot.io/browser-spec';

/**
 * What a browser container asks the scheduler to reserve (decided 2026-10-13 with the cluster's numbers, PRD §14.1 Kubernetes fit, and the
 * coordinator's capacity order): requests are held while Chrome sleeps, workspace pods are pinned to k3s-node2, and it has well under a
 * CPU of requests free. CPU is compressible: a sleeping supervisor uses next to nothing and a busy Chrome is only slowed when the node is
 * contended, so 100m. Memory: measured on the rig 121 MB asleep and 601 MiB with three light tabs, so 512Mi sits at light use; above it
 * the pod becomes an eviction candidate only under node memory pressure (k3s-node2 had 4.8 to 10 GiB free by requests). Limits are the
 * pool's (2 CPU, 3 GiB by default).
 */
export const K8S_BROWSER_REQUESTS = { cpu: '100m', memory: '512Mi' } as const;
/** Assigned browsers per Kubernetes target (PRD §14.1 Caps, A8): assigned ones hold requests. */
export const K8S_BROWSER_CAP = 2;
/** A pod that can't be scheduled this long after the browser was added gets its browser taken away again (PRD FR11). */
export const PENDING_ROLLBACK_MS = 5 * 60_000;

/**
 * At most 2 assigned browsers per Kubernetes target (PRD §14.1 Caps): an assigned one holds its requests on a node even while Chrome
 * sleeps. Null when there is room; the workspace's own assignment (a change of pool) doesn't count against it.
 */
export function kubeCapRefusal(store: Store, workspaceId: string): string | null {
  const target = workspaceId.split('/')[0]!;
  const rows = (store.db?.prepare("SELECT DISTINCT workspace_id FROM assignments WHERE pool_type = 'browser'").all() ?? []) as { workspace_id: string }[];
  const others = rows.filter((r) => r.workspace_id !== workspaceId && r.workspace_id.split('/')[0] === target).length;
  return others >= K8S_BROWSER_CAP ? `${others} of ${K8S_BROWSER_CAP} browsers are assigned on this Kubernetes target. Unassign one first.` : null;
}

/** The supervisor, `cpb-ctl` and the live-view helpers run as uid 1001; a Kubernetes exec has no user, so it drops to it first. */
export const asUser = (user: string, cmd: string[]): string[] => {
  if (user === '0' || user === 'root') return cmd;
  const uid = /^\d+$/.test(user) ? user : '1001';
  return ['setpriv', `--reuid=${uid}`, `--regid=${uid}`, '--clear-groups', '--', ...cmd];
};
export const AS_CPB = asUser('1001', []);

export interface KubePlan {
  workspace: string;
  poolId: string;
  content: BrowserPoolContent;
  /** Hosts the browser's policy refuses: the portal as a workspace reaches it. */
  portalHosts: string[];
  image: string;
}

export const configMapName = (runtimeName: string) => `${runtimeName}-browser`;
export const egressPolicyName = (runtimeName: string) => `${runtimeName}-egress`;

/** The ConfigMap's two files: the container's config (`/etc/cpb/config.json`) and Chromium's managed policy. Never secrets. */
export function configMapData(plan: KubePlan): Record<string, string> {
  return {
    'config.json': `${JSON.stringify(containerConfig(plan.content, { sandbox: 'auto' }), null, 2)}\n`,
    'policy.json': `${JSON.stringify(chromePolicy(plan.content, { portalHosts: plan.portalHosts }), null, 2)}\n`,
  };
}

/** The browser container (PRD §10.2): root init with only SETUID and SETGID, read-only root, its own limits, liveness by its supervisor. */
export function browserContainer(plan: KubePlan): V1Container {
  const res = plan.content.resources;
  const limits = { cpu: String(res.cpus), memory: `${res.memoryMb}Mi` };
  return {
    name: BROWSER_CONTAINER,
    image: plan.image,
    imagePullPolicy: 'IfNotPresent',
    // tini is PID 1 (Docker's `Init: true`), so what Chrome leaves behind is reaped.
    command: ['/usr/bin/tini', '--', 'node', '/opt/cpb/init.mjs'],
    env: [
      { name: 'CPB_K8S', value: '1' },
      { name: 'LANG', value: 'C.UTF-8' },
      { name: 'NODE_OPTIONS', value: '--disable-warning=ExperimentalWarning' },
    ],
    resources: { limits, requests: requestsFor(limits, K8S_BROWSER_REQUESTS) },
    securityContext: {
      runAsUser: 0,
      runAsGroup: 0,
      runAsNonRoot: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'], add: ['SETUID', 'SETGID'] },
      // Set explicitly: the kubelet's default is Unconfined (PRD §13 Chrome sandbox).
      seccompProfile: { type: 'RuntimeDefault' },
    },
    // Restarts only this container; no readiness probe, so the pod's readiness follows `workspace`. Kubelet TCP and HTTP probes
    // target the pod IP and never see loopback listeners: an exec.
    livenessProbe: { exec: { command: [...AS_CPB, 'cpb-ctl', 'status'] }, initialDelaySeconds: 30, periodSeconds: 30, timeoutSeconds: 10, failureThreshold: 3 },
    volumeMounts: [
      { name: 'home', mountPath: '/data/profile', subPath: PROFILE_REL },
      // Chrome's own home (~/.pki, ~/.cache), with ~/Downloads from the workspace's home nested in it.
      { name: 'cpb-home', mountPath: HOME },
      { name: 'home', mountPath: DOWNLOADS_DIR, subPath: 'Downloads' },
      { name: 'cpb-tmp', mountPath: '/tmp' },
      { name: 'cpb-run', mountPath: '/run' },
      { name: 'cpb-shm', mountPath: '/dev/shm' },
      { name: 'cpb-config', mountPath: '/etc/cpb', readOnly: true },
      { name: 'cpb-policy', mountPath: '/etc/chromium/policies/managed', readOnly: true },
    ],
  };
}

export function browserVolumes(runtimeName: string, content: BrowserPoolContent): V1Volume[] {
  const cm = configMapName(runtimeName);
  return [
    { name: 'cpb-home', emptyDir: { sizeLimit: '512Mi' } },
    { name: 'cpb-tmp', emptyDir: { sizeLimit: '1Gi' } },
    { name: 'cpb-run', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } },
    // Counted against the browser container's memory (PRD §10.2).
    { name: 'cpb-shm', emptyDir: { medium: 'Memory', sizeLimit: `${content.resources.shmMb}Mi` } },
    { name: 'cpb-config', configMap: { name: cm, items: [{ key: 'config.json', path: 'config.json' }], defaultMode: 0o644 } },
    { name: 'cpb-policy', configMap: { name: cm, items: [{ key: 'policy.json', path: 'cpb.json' }], defaultMode: 0o644 } },
  ];
}

/** The hash a template carries for its browser: the container, its volumes and its config, so any of them changing means a new pod. */
export function specOf(plan: KubePlan, runtimeName: string): string {
  return sha256(JSON.stringify({ c: browserContainer(plan), v: browserVolumes(runtimeName, plan.content), d: configMapData(plan) })).slice(0, 16);
}

const OWN_VOLUME = /^cpb-/;

export const hasBrowser = (t: V1PodTemplateSpec | undefined) => !!t?.spec?.containers.some((c) => c.name === BROWSER_CONTAINER);
export const specIn = (t: V1PodTemplateSpec | undefined) => t?.metadata?.annotations?.[SPEC_ANNOTATION] ?? null;

/**
 * The template with the browser added (or replaced), or taken away when `plan` is null. Pure: everything else in the template stays as
 * it was. With a browser, `seed-home` also creates the two subpaths it mounts, and the pod mounts no service account token.
 */
export function withBrowser(template: V1PodTemplateSpec, runtimeName: string, plan: KubePlan | null): V1PodTemplateSpec {
  const t = structuredClone(template);
  const spec = t.spec!;
  spec.containers = spec.containers.filter((c) => c.name !== BROWSER_CONTAINER);
  spec.volumes = (spec.volumes ?? []).filter((v) => !OWN_VOLUME.test(v.name));
  const annotations = { ...(t.metadata?.annotations ?? {}) };
  delete annotations[SPEC_ANNOTATION];
  const seed = spec.initContainers?.find((c) => c.name === 'seed-home');
  if (plan) {
    spec.containers.push(browserContainer(plan));
    spec.volumes.push(...browserVolumes(runtimeName, plan.content));
    spec.automountServiceAccountToken = false;
    annotations[SPEC_ANNOTATION] = specOf(plan, runtimeName);
    if (seed) seed.command = ['sh', '-c', seedHomeScript(['.claudepilot', '.claudepilot/browser', PROFILE_REL, 'Downloads'])];
  } else if (seed) seed.command = ['sh', '-c', seedHomeScript()];
  t.metadata = { ...(t.metadata ?? {}), annotations };
  return t;
}

/* ---------- Fit (PRD §14.1 Kubernetes fit) ---------- */

export interface Resources {
  /** Millicores. */
  cpu: number;
  /** Bytes. */
  memory: number;
}

/** What a container asks the scheduler for: its requests, or its limits when it has no requests (Kubernetes' own rule). */
export function requestOf(c: V1Container): Resources {
  const req = c.resources?.requests ?? {};
  const lim = c.resources?.limits ?? {};
  const cpu = req.cpu ?? lim.cpu;
  const mem = req.memory ?? lim.memory;
  return { cpu: cpu ? (cpuMilli(String(cpu)) ?? 0) : 0, memory: mem ? (memoryBytes(String(mem)) ?? 0) : 0 };
}

/** A pod's effective request: the sum of its containers, or its largest init container when that is more. */
export function podRequest(spec: { containers: V1Container[]; initContainers?: V1Container[] }): Resources {
  const sum = spec.containers.map(requestOf).reduce((a, b) => ({ cpu: a.cpu + b.cpu, memory: a.memory + b.memory }), { cpu: 0, memory: 0 });
  for (const i of (spec.initContainers ?? []).map(requestOf)) {
    sum.cpu = Math.max(sum.cpu, i.cpu);
    sum.memory = Math.max(sum.memory, i.memory);
  }
  return sum;
}

export interface NodeRoom {
  node: string;
  allocatable: Resources;
  requested: Resources;
  free: Resources;
}

export interface Fit {
  fits: boolean;
  need: Resources;
  nodes: NodeRoom[];
  /** For people: which node has room, or why none has. */
  reason: string;
}

const cpuText = (m: number) => `${(m / 1000).toFixed(2).replace(/\.?0+$/, '')} CPU`;
const memText = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GiB`;

/**
 * Whether a pod asking `need` fits a node it may run on: allocatable minus the requests of every pod there that hasn't ended, not
 * counting the workspace's own pod (it is replaced, strategy Recreate). Pure, so the rule is tested with the cluster's own numbers.
 */
export function fitOf(input: { need: Resources; nodes: V1Node[]; pods: V1Pod[]; nodeSelector?: Record<string, string>; ownPod?: (p: V1Pod) => boolean }): Fit {
  const candidates = input.nodes.filter((n) => {
    if (n.spec?.unschedulable) return false;
    const labels = n.metadata?.labels ?? {};
    return Object.entries(input.nodeSelector ?? {}).every(([k, v]) => labels[k] === v);
  });
  const rooms: NodeRoom[] = candidates.map((n) => {
    const name = n.metadata?.name ?? '';
    const alloc = n.status?.allocatable ?? {};
    const allocatable = { cpu: cpuMilli(String(alloc.cpu ?? '0')) ?? 0, memory: memoryBytes(String(alloc.memory ?? '0')) ?? 0 };
    const requested = input.pods
      .filter((p) => p.spec?.nodeName === name && p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed' && !input.ownPod?.(p))
      .map((p) => podRequest(p.spec!))
      .reduce((a, b) => ({ cpu: a.cpu + b.cpu, memory: a.memory + b.memory }), { cpu: 0, memory: 0 });
    return { node: name, allocatable, requested, free: { cpu: allocatable.cpu - requested.cpu, memory: allocatable.memory - requested.memory } };
  });
  const ok = rooms.find((r) => r.free.cpu >= input.need.cpu && r.free.memory >= input.need.memory);
  const asks = `the workspace with its browser asks ${cpuText(input.need.cpu)} and ${memText(input.need.memory)}`;
  if (ok) return { fits: true, need: input.need, nodes: rooms, reason: `Fits on ${ok.node}: ${cpuText(ok.free.cpu)} and ${memText(ok.free.memory)} free by requests; ${asks}.` };
  if (!rooms.length) return { fits: false, need: input.need, nodes: rooms, reason: 'No node the workspace may run on is schedulable.' };
  const free = rooms.map((r) => `${r.node} has ${cpuText(Math.max(0, r.free.cpu))} and ${memText(Math.max(0, r.free.memory))} free by requests`).join('; ');
  return { fits: false, need: input.need, nodes: rooms, reason: `Doesn't fit: ${free}; ${asks}. The workspace would stay Pending, so it starts without its browser.` };
}

/* ---------- Egress (PRD §13 Network) ---------- */

/** Private, link-local, carrier-grade NAT and loopback ranges: the cluster, the nodes and the LAN, which a page in the browser must not reach. */
export const PRIVATE_V4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '127.0.0.0/8'];
export const PRIVATE_V6 = ['fc00::/7', 'fe80::/10', '::1/128'];

/** Where a workspace may still go inside the cluster: the portal (from its internal URL), as a Service in a namespace or an address. */
export function portalException(internalUrl: string | undefined): { namespace?: string; cidr?: string; port?: number } | null {
  if (!internalUrl) return null;
  let u: URL;
  try {
    u = new URL(internalUrl);
  } catch {
    return null;
  }
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const host = u.hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { cidr: `${host}/32`, port };
  const svc = /^[a-z0-9-]+\.([a-z0-9-]+)\.svc(\.|$)/.exec(host);
  return svc ? { namespace: svc[1], port } : null;
}

/** An admin-listed exception (`PORTAL_K8S_BROWSER_EGRESS_ALLOW`): an IPv4 or IPv6 CIDR, or an address, with an optional TCP port. */
export interface EgressException {
  cidr: string;
  port?: number;
}

/**
 * `10.43.0.1/32:443,192.168.1.10` → exceptions; anything that isn't a CIDR or an address is dropped (and said so by the caller), never
 * widened. IPv6 takes a port only in brackets: `[fd00::1]/128:443`.
 */
export function parseEgressAllow(text: string | undefined): { allow: EgressException[]; bad: string[] } {
  const allow: EgressException[] = [];
  const bad: string[] = [];
  for (const raw of (text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(?:\[([0-9a-f:]+)\](\/\d{1,3})?|([0-9.]+)(\/\d{1,2})?|([0-9a-f:]+)(\/\d{1,3})?)(?::(\d{1,5}))?$/i.exec(raw);
    const v4 = m?.[3];
    const addr = m?.[1] ?? v4 ?? m?.[5];
    const prefix = m?.[2] ?? m?.[4] ?? m?.[6];
    const port = m?.[7] && !m[5] ? Number(m[7]) : undefined;
    const okV4 = v4 ? v4.split('.').length === 4 && v4.split('.').every((o) => Number(o) <= 255) && (!prefix || Number(prefix.slice(1)) <= 32) : true;
    const okV6 = v4 ? true : !!addr?.includes(':') && (!prefix || Number(prefix.slice(1)) <= 128);
    if (!m || !addr || !okV4 || !okV6 || (port !== undefined && (port < 1 || port > 65535))) {
      bad.push(raw);
      continue;
    }
    allow.push({ cidr: `${addr}${prefix ?? (v4 ? '/32' : '/128')}`, ...(port ? { port } : {}) });
  }
  return { allow, bad };
}

/**
 * The per-pod egress policy: the internet, but no private, link-local or cluster range, except DNS, the portal and the admin's exceptions.
 * It covers Claude Code and the shell too (one network namespace), so a workspace that reaches the API server, a registry or the LAN needs
 * those listed. Enforced only where the cluster enforces NetworkPolicy (PRD Q12).
 */
export function egressPolicy(
  runtimeName: string,
  match: Record<string, string>,
  opts: { portal: ReturnType<typeof portalException>; owner?: V1Deployment; allow?: EgressException[] },
): V1NetworkPolicy {
  const portal = opts.portal;
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: egressPolicyName(runtimeName), labels: { [LABEL.managed]: 'true', 'claudepilot.io/browser': '1' }, ownerReferences: ownerOf(opts.owner) },
    spec: {
      podSelector: { matchLabels: match },
      policyTypes: ['Egress'],
      egress: [
        { to: [{ ipBlock: { cidr: '0.0.0.0/0', except: PRIVATE_V4 } }, { ipBlock: { cidr: '::/0', except: PRIVATE_V6 } }] },
        {
          to: [{ namespaceSelector: {}, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
        ...(portal?.namespace
          ? [{ to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': portal.namespace } } }], ports: [{ protocol: 'TCP', port: portal.port }] }]
          : portal?.cidr
            ? [{ to: [{ ipBlock: { cidr: portal.cidr } }], ports: [{ protocol: 'TCP', port: portal.port }] }]
            : []),
        ...(opts.allow ?? []).map((x) => ({ to: [{ ipBlock: { cidr: x.cidr } }], ...(x.port ? { ports: [{ protocol: 'TCP', port: x.port }] } : {}) })),
      ],
    },
  };
}

function ownerOf(d: V1Deployment | undefined) {
  return d?.metadata?.uid && d.metadata.name ? [{ apiVersion: 'apps/v1', kind: 'Deployment', name: d.metadata.name, uid: d.metadata.uid, controller: false, blockOwnerDeletion: false }] : undefined;
}

/* ---------- The cluster ---------- */

const codeOf = (e: unknown) => (e as { code?: number }).code;

/** A workspace's Deployment and pod as the browser sees them. */
export interface KubeWorkspace {
  deployment: V1Deployment;
  replicas: number;
  pod: V1Pod | null;
}

/** One Kubernetes target's browsers: the Deployment template, the ConfigMap, the egress policy, and exec into the `browser` container. */
export class KubeBrowsers {
  readonly kind = 'kubernetes' as const;
  readonly #core: CoreV1Api;
  readonly #apps: AppsV1Api;
  readonly #net: NetworkingV1Api;

  constructor(
    readonly targetId: string,
    private readonly access: KubeBrowserAccess,
    readonly image: string,
    /** The portal's internal URL: the one in-cluster exception of the egress policy. */
    private readonly internalUrl?: string,
    /** `isolate`: the per-pod egress policy with these exceptions; `off`: the admin's opt-out (PRD Q12), audited by the service. */
    readonly egress: { mode: 'isolate' | 'off'; allow: EgressException[] } = { mode: 'isolate', allow: [] },
  ) {
    this.#core = access.kubeConfig.makeApiClient(CoreV1Api);
    this.#apps = access.kubeConfig.makeApiClient(AppsV1Api);
    this.#net = access.kubeConfig.makeApiClient(NetworkingV1Api);
  }

  get available() {
    return true;
  }

  get #ns() {
    return this.access.namespace;
  }

  runtimeName(workspace: string) {
    return this.access.objectName(workspace);
  }

  async workspace(name: string): Promise<KubeWorkspace | null> {
    let d: V1Deployment;
    try {
      d = await this.#apps.readNamespacedDeployment({ name: this.runtimeName(name), namespace: this.#ns });
    } catch (e) {
      if (codeOf(e) === 404) return null;
      throw e;
    }
    const pods = await this.#core.listNamespacedPod({ namespace: this.#ns, labelSelector: `${LABEL.managed}=true,${LABEL.name}=${name}` });
    const pod = pods.items.find((p) => !p.metadata?.deletionTimestamp) ?? null;
    return { deployment: d, replicas: d.spec?.replicas ?? 0, pod };
  }

  /** Workspaces in the namespace whose template has a browser. */
  async list(): Promise<string[]> {
    const ds = await this.#apps.listNamespacedDeployment({ namespace: this.#ns, labelSelector: `${LABEL.managed}=true` });
    return ds.items.filter((d) => hasBrowser(d.spec?.template)).map((d) => d.metadata?.labels?.[LABEL.name] ?? '').filter(Boolean);
  }

  /** Writes the template (the pod restarts when it runs; the portal calls this only while it is stopped). */
  async setTemplate(ws: KubeWorkspace, plan: KubePlan | null): Promise<void> {
    const d = structuredClone(ws.deployment);
    const runtimeName = d.metadata!.name!;
    d.spec!.template = withBrowser(d.spec!.template, runtimeName, plan);
    await this.#apps.replaceNamespacedDeployment({ name: runtimeName, namespace: this.#ns, body: d });
  }

  /** Creates or updates the ConfigMap the browser container mounts, owned by the Deployment so it goes with it. */
  async ensureConfigMap(ws: KubeWorkspace, plan: KubePlan): Promise<void> {
    const runtimeName = ws.deployment.metadata!.name!;
    const name = configMapName(runtimeName);
    const body: V1ConfigMap = {
      metadata: { name, labels: { [LABEL.managed]: 'true', 'claudepilot.io/browser': '1' }, ownerReferences: ownerOf(ws.deployment) },
      data: configMapData(plan),
    };
    try {
      const cur = await this.#core.readNamespacedConfigMap({ name, namespace: this.#ns });
      if (JSON.stringify(cur.data ?? {}) === JSON.stringify(body.data)) return;
      await this.#core.replaceNamespacedConfigMap({ name, namespace: this.#ns, body: { ...body, metadata: { ...body.metadata, resourceVersion: cur.metadata?.resourceVersion } } });
    } catch (e) {
      if (codeOf(e) !== 404) throw e;
      await this.#core.createNamespacedConfigMap({ namespace: this.#ns, body });
    }
  }

  /** The per-pod egress policy, created or updated; with the opt-out, removed. */
  async ensureEgress(ws: KubeWorkspace, name: string): Promise<void> {
    const runtimeName = ws.deployment.metadata!.name!;
    if (this.egress.mode === 'off') {
      await this.#net.deleteNamespacedNetworkPolicy({ name: egressPolicyName(runtimeName), namespace: this.#ns }).catch((e) => (codeOf(e) === 404 ? undefined : Promise.reject(e)));
      return;
    }
    const body = egressPolicy(runtimeName, { [LABEL.managed]: 'true', [LABEL.name]: name }, { portal: portalException(this.internalUrl), owner: ws.deployment, allow: this.egress.allow });
    const policy = body.metadata!.name!;
    try {
      const cur = await this.#net.readNamespacedNetworkPolicy({ name: policy, namespace: this.#ns });
      if (JSON.stringify(cur.spec) === JSON.stringify(body.spec)) return;
      await this.#net.replaceNamespacedNetworkPolicy({ name: policy, namespace: this.#ns, body: { ...body, metadata: { ...body.metadata, resourceVersion: cur.metadata?.resourceVersion } } });
    } catch (e) {
      if (codeOf(e) !== 404) throw e;
      await this.#net.createNamespacedNetworkPolicy({ namespace: this.#ns, body });
    }
  }

  /** The ConfigMap and the egress policy go with the browser (the Deployment's removal takes them too, as their owner). */
  async removeExtras(ws: KubeWorkspace): Promise<void> {
    const runtimeName = ws.deployment.metadata!.name!;
    await this.#core.deleteNamespacedConfigMap({ name: configMapName(runtimeName), namespace: this.#ns }).catch((e) => (codeOf(e) === 404 ? undefined : Promise.reject(e)));
    await this.#net.deleteNamespacedNetworkPolicy({ name: egressPolicyName(runtimeName), namespace: this.#ns }).catch((e) => (codeOf(e) === 404 ? undefined : Promise.reject(e)));
  }

  /**
   * Whether the workspace's pod, with this browser, fits a node it may run on. Null when the portal may not read the nodes and the
   * pods on them (a namespaced Role only): then the 5-minute Pending rollback is the only guard.
   */
  async fit(ws: KubeWorkspace, plan: KubePlan, name: string): Promise<Fit | null> {
    const template = withBrowser(ws.deployment.spec!.template, ws.deployment.metadata!.name!, plan);
    const need = podRequest(template.spec!);
    try {
      const [nodes, pods] = await Promise.all([this.#core.listNode(), this.#core.listPodForAllNamespaces({ fieldSelector: 'status.phase!=Succeeded,status.phase!=Failed' })]);
      const own = (p: V1Pod) => p.metadata?.namespace === this.#ns && p.metadata?.labels?.[LABEL.name] === name && p.metadata?.labels?.[LABEL.managed] === 'true';
      return fitOf({ need, nodes: nodes.items, pods: pods.items, nodeSelector: template.spec?.nodeSelector, ownPod: own });
    } catch (e) {
      if (codeOf(e) === 403) return null;
      throw e;
    }
  }

  /* ---------- Exec ---------- */

  async #pod(name: string): Promise<string> {
    const ws = await this.workspace(name);
    const pod = ws?.pod;
    // The browser container's own state, never pod phase (PRD §20 A5).
    const running = pod?.status?.containerStatuses?.find((s) => s.name === BROWSER_CONTAINER)?.state?.running;
    if (!pod || !running) throw new Error('The browser container isn’t running.');
    return pod.metadata!.name!;
  }

  /** Runs `cmd` in a container of the workspace's pod: the browser's as uid 1001 by default (`setpriv` first), or the workspace's. */
  async exec(workspace: string, cmd: string[], opts: { user?: string; stdin?: string; timeoutMs?: number; container?: 'browser' | 'workspace' } = {}): Promise<ExecResult> {
    const container = opts.container ?? BROWSER_CONTAINER;
    const pod = container === BROWSER_CONTAINER ? await this.#pod(workspace) : ((await this.workspace(workspace))?.pod?.metadata?.name ?? null);
    if (!pod) throw new Error('The workspace isn’t running.');
    const argv = container === BROWSER_CONTAINER ? asUser(opts.user ?? '1001', cmd) : cmd;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const stdout = new PassThrough().on('data', (c: Buffer) => out.push(c));
    const stderr = new PassThrough().on('data', (c: Buffer) => err.push(c));
    const stdin = opts.stdin !== undefined ? new PassThrough() : null;
    stdin?.on('error', () => undefined);
    const ms = opts.timeoutMs ?? 20_000;
    return new Promise((resolve, reject) => {
      let status: V1Status | null = null;
      let socket: { close(): void } | null = null;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket?.close();
        fn();
      };
      const timer = setTimeout(() => settle(() => reject(new Error(`exec timed out after ${ms} ms`))), ms);
      const closed = () =>
        setImmediate(() =>
          settle(() => {
            const text = (b: Buffer[]) => Buffer.concat(b).toString('utf8');
            if (!status) return reject(new Error('The connection to the browser dropped before the command finished.'));
            if (status.status === 'Success') return resolve({ code: 0, stdout: text(out), stderr: text(err) });
            const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
            resolve({ code: cause?.message ? Number(cause.message) : -1, stdout: text(out), stderr: text(err) || (status.message ?? '') });
          }),
        );
      new Exec(this.access.kubeConfig)
        .exec(this.#ns, pod, container, argv, stdout, stderr, stdin, false, (s: V1Status) => {
          status = s;
        })
        .then(
          (ws) => {
            socket = ws;
            if (settled) return ws.close();
            ws.on('close', closed);
            ws.on('error', closed);
            if (stdin && opts.stdin) stdin.write(opts.stdin);
          },
          (e: unknown) => settle(() => reject(e instanceof Error ? e : new Error(String(e)))),
        );
    });
  }

  /** A long-running process in the browser container (the live-view bridges), as uid 1001: bytes in and out until either side closes. */
  async stream(workspace: string, cmd: string[], opts: { user?: string } = {}): Promise<ExecStream> {
    const pod = await this.#pod(workspace);
    const out = new PassThrough();
    const err = new PassThrough();
    const stdin = new PassThrough();
    stdin.on('error', () => undefined);
    const exitFns: ((code: number | null) => void)[] = [];
    let code: number | null = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      exitFns.forEach((fn) => fn(code));
    };
    const ws = await new Exec(this.access.kubeConfig).exec(this.#ns, pod, BROWSER_CONTAINER, asUser(opts.user ?? '1001', cmd), out, err, stdin, false, (s: V1Status) => {
      if (s.status === 'Success') code = 0;
      else {
        const cause = s.details?.causes?.find((c) => c.reason === 'ExitCode');
        code = cause?.message ? Number(cause.message) : null;
      }
    });
    ws.on('close', finish);
    ws.on('error', finish);
    return {
      write: (data) => void stdin.write(data),
      // Over the v4 channel protocol an end of stdin closes the socket: the helpers stop on their own when the portal closes.
      end: () => ws.close(),
      close: () => ws.close(),
      onData: (fn) => void out.on('data', fn),
      onError: (fn) => void err.on('data', fn),
      onExit: (fn) => void exitFns.push(fn),
    };
  }

  /** Deletes the profile (live sign-ins) through the workspace container: contents only, no following links. */
  async wipeProfile(workspace: string): Promise<boolean> {
    const r = await this.exec(workspace, ['sh', '-c', `find "${HOME}/${PROFILE_REL}" -mindepth 1 -delete 2>/dev/null; true`], { container: 'workspace' }).catch(() => null);
    return r?.code === 0;
  }
}

/** Whether the workspace's own container runs in this pod (sessions may be in it), whatever the pod's phase. */
export function workspaceRunning(pod: V1Pod | null): boolean {
  return !!pod?.status?.containerStatuses?.find((c) => c.name === WORKSPACE_CONTAINER)?.state?.running;
}

/** The browser container's state in a pod, as the browser's row says it (PRD §20 A5: never the workspace's). */
export function browserContainerState(pod: V1Pod | null): { state: 'starting' | 'running' | 'error'; restarts: number; detail: string | null; pendingSince: number | null } {
  const s = pod?.status?.containerStatuses?.find((c) => c.name === BROWSER_CONTAINER);
  const unscheduled = pod?.status?.conditions?.find((c) => c.type === 'PodScheduled' && c.status === 'False');
  const pendingSince = unscheduled ? Date.parse(String(unscheduled.lastTransitionTime ?? pod?.metadata?.creationTimestamp ?? '')) || Date.now() : null;
  if (!s) return { state: 'starting', restarts: 0, detail: unscheduled?.message ?? null, pendingSince };
  const restarts = s.restartCount ?? 0;
  if (s.state?.running) return { state: 'running', restarts, detail: null, pendingSince: null };
  const waiting = s.state?.waiting;
  if (waiting?.reason && ['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CrashLoopBackOff', 'CreateContainerConfigError', 'CreateContainerError'].includes(waiting.reason))
    return { state: 'error', restarts, detail: `${waiting.reason}: ${(waiting.message ?? '').slice(0, 300)}`.trim(), pendingSince: null };
  return { state: 'starting', restarts, detail: waiting?.reason ?? null, pendingSince };
}
