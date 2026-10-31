import { PassThrough } from 'node:stream';
import { AppError } from '@isnanme/core';
import { workspaceId, type Workspace, type WorkspaceResourceValues, type WorkspaceStatus } from '@portal/contracts';
import {
  AppsV1Api,
  CoreV1Api,
  CustomObjectsApi,
  Exec,
  KubeConfig,
  type V1Affinity,
  type V1Deployment,
  type V1NodeAffinity,
  type V1Pod,
  type V1Status,
} from '@kubernetes/client-node';
import { plainName } from '../names.js';
import { requestsFor, type RequestOptions } from './requests.js';
import { bytes, checkFit, cores, needOf, unchecked, type FitPod } from './fit.js';
import { cpuQuantity, fitView, memoryQuantity, needOfValues, valuesOf } from './resources.js';
import { kubernetesDelivery } from './kubernetesDelivery.js';
import { homeVolumeOf, legacyRuntimeName } from './identity.js';
import { HOME, LABEL, type CreateSpec, type DeliveryAccess, type ExecSession, type ResourceAccess, type ResourceApplied, type Runtime, type RuntimeNames, type ShellSession } from './runtime.js';

const LIMIT = { cpus: 'claudepilot.cpus', memoryMb: 'claudepilot.memory-mb' } as const;
const CONTAINER = 'workspace';
const SEEDED = '.claudepilot-seeded';

const selector = `${LABEL.managed}=true`;

/**
 * The `seed-home` init container's script: a new PVC is empty, so the image's home is copied in once, like Docker does for a fresh volume.
 * `dirs` (relative to home) are created with mode 0700 at every start, outside the seeded check: the browser's profile and `~/Downloads`,
 * which the browser container mounts by `subPath` (the kubelet would make a missing one root-owned), browser PRD §20 A2.
 */
export function seedHomeScript(dirs: readonly string[] = []): string {
  const seed = `[ -e /seed/${SEEDED} ] || { cp -a --no-preserve=all ${HOME}/. /seed/ && touch /seed/${SEEDED}; }`;
  if (!dirs.length) return seed;
  const paths = dirs.map((d) => `"/seed/${d}"`).join(' ');
  return `${seed} && mkdir -p ${paths} && chmod 0700 ${paths}`;
}

/** What the browser pool needs to put its container in a workspace's pod (browser PRD §10.2). */
export interface KubeBrowserAccess {
  kubeConfig: KubeConfig;
  namespace: string;
  /** The Deployment of a workspace, from its stored runtime name (T-42). */
  objectName(name: string): string;
}

const codeOf = (e: unknown) => (e as { code?: number }).code;
const ignore = (...codes: number[]) => (e: unknown) => {
  if (!codes.includes(codeOf(e) ?? 0)) throw e;
};

/** Waiting reasons that won't fix themselves. */
const STUCK = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CrashLoopBackOff', 'CreateContainerConfigError']);

export interface KubernetesOptions {
  namespace: string;
  image: string;
  imagePullSecret?: string;
  storageClass?: string;
  storage: string;
  /** Nodes workspace pods may run on (`PORTAL_K8S_NODE_SELECTOR`); unset: the scheduler decides. */
  nodeSelector?: Record<string, string>;
  /** What a pod asks the scheduler to reserve, at most its limits (`PORTAL_K8S_CPU_REQUEST`, `PORTAL_K8S_MEMORY_REQUEST`); unset: the limits. */
  requests?: RequestOptions;
  /** A target of `PORTAL_K8S_TARGETS` (kubeTargets.ts): its id and label; absent: the one `kubernetes` target. */
  target?: { id: string; label: string };
  /**
   * Nodes this target prefers, in order (preferred node affinity), and the only nodes a create may name (then required). The home volume
   * follows the pod: a WaitForFirstConsumer class (k3s local-path) binds it on the node the pod is first scheduled to, and keeps it there.
   */
  preferredNodes?: readonly string[];
  /** CPU and memory a create that names none gets. */
  defaults?: { cpus?: number; memoryMb?: number };
  /** Whether a create first asks for the namespace (default yes). No for a PORTAL_K8S_TARGETS target: its namespace, quota and Role come from git. */
  manageNamespace?: boolean;
  /**
   * Whether the fit check (fit.ts) may read the cluster's nodes and pods. Default: yes for the portal's own cluster, no for an enrolled one
   * (its agent's Role is namespaced and its policy refuses cluster-wide reads): there a create is not checked and a resources change is
   * refused as unchecked.
   */
  fitCheck?: boolean;
  /** Tests only: the folders delivery may write and read (default: the engine's, `DELIVERY_ROOTS`), and how often starts are polled. */
  delivery?: { roots?: readonly string[]; pollMs?: number };
  /** Tests only: how often and how long an in-place resize waits for the kubelet's answer (default 500 ms, 10 s; T-3081). */
  resize?: { pollMs?: number; waitMs?: number };
}

type Resources = { limits?: Record<string, string>; requests?: Record<string, string> };

/** The `workspace` container's resources with the values set (anything else it had kept). */
const withValues = (r: Resources | undefined, values: WorkspaceResourceValues): Resources => ({
  ...r,
  limits: { ...r?.limits, cpu: cpuQuantity(values.cpus), memory: memoryQuantity(values.memoryMb) },
  requests: { ...r?.requests, cpu: cpuQuantity(values.cpuRequest), memory: memoryQuantity(values.memoryRequestMb) },
});

/** The API server's own message of a refusal (its Status body), cut; never a header or the request. */
function apiMessage(e: unknown): string {
  const body = (e as { body?: unknown }).body;
  try {
    const message = (typeof body === 'string' ? (JSON.parse(body) as { message?: unknown }) : (body as { message?: unknown } | undefined))?.message;
    if (typeof message === 'string' && message) return message.slice(0, 300);
  } catch {
    // not a Status
  }
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

const HOSTNAME = 'kubernetes.io/hostname';

/**
 * Where a workspace pod may go: the target's node selector (hard), its preferred nodes (soft, the first weighted most), and a node the create
 * named (hard, by `kubernetes.io/hostname`). The PVC needs nothing of its own: with WaitForFirstConsumer binding it is provisioned on the node
 * the pod lands on.
 */
export function placementOf(o: Pick<KubernetesOptions, 'nodeSelector' | 'preferredNodes'>, node?: string): { nodeSelector?: Record<string, string>; affinity?: V1Affinity } {
  const preferred = node ? [] : (o.preferredNodes ?? []);
  // A named node replaces a hostname in the selector (the target's usual node): the rest of the selector still holds.
  const selector = node && o.nodeSelector ? Object.fromEntries(Object.entries(o.nodeSelector).filter(([k]) => k !== HOSTNAME)) : o.nodeSelector;
  const nodeAffinity: V1NodeAffinity = {
    ...(node ? { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: HOSTNAME, operator: 'In', values: [node] }] }] } } : {}),
    ...(preferred.length
      ? { preferredDuringSchedulingIgnoredDuringExecution: preferred.map((n, i) => ({ weight: Math.max(1, 100 - i * 10), preference: { matchExpressions: [{ key: HOSTNAME, operator: 'In', values: [n] }] } })) }
      : {}),
  };
  return {
    ...(selector && Object.keys(selector).length ? { nodeSelector: selector } : {}),
    ...(Object.keys(nodeAffinity).length ? { affinity: { nodeAffinity } } : {}),
  };
}

const same = (a: Partial<WorkspaceResourceValues>, b: Partial<WorkspaceResourceValues>) => a.cpus === b.cpus && a.memoryMb === b.memoryMb && a.cpuRequest === b.cpuRequest && a.memoryRequestMb === b.memoryRequestMb;

/** One namespace in a cluster: a Deployment (scaled 1/0 to start/stop) and a PVC per workspace. */
export class KubernetesRuntime implements Runtime {
  readonly target;
  readonly #kc: KubeConfig = new KubeConfig();
  readonly #core: CoreV1Api;
  readonly #apps: AppsV1Api;
  readonly #metrics: CustomObjectsApi;

  readonly #manageNamespace: boolean;
  readonly #fitCheck: boolean;

  constructor(
    private readonly opts: KubernetesOptions,
    /**
     * An enrolled cluster (targets-connect PRD §12.6): a ready KubeConfig (the tunnel's loopback endpoint; `loadFromDefault()` is then
     * never called), `manageNamespace: false` (the manifest made the namespace and a namespaced Role can't create one), and its target.
     */
    connect?: { kubeConfig: KubeConfig; manageNamespace?: boolean; target: { id: string; label: string; where: string } },
  ) {
    if (connect) this.#kc = connect.kubeConfig;
    else this.#kc.loadFromDefault();
    this.#manageNamespace = connect ? (connect.manageNamespace ?? true) : (opts.manageNamespace ?? true);
    this.#enrolled = !!connect;
    this.#fitCheck = opts.fitCheck ?? !connect;
    this.#core = this.#kc.makeApiClient(CoreV1Api);
    this.#apps = this.#kc.makeApiClient(AppsV1Api);
    this.#metrics = this.#kc.makeApiClient(CustomObjectsApi);
    const context = connect ? null : this.#kc.getCurrentContext();
    this.target = {
      id: connect?.target.id ?? opts.target?.id ?? 'kubernetes',
      label: connect?.target.label ?? opts.target?.label ?? 'Kubernetes',
      kind: 'kubernetes' as const,
      where: connect?.target.where ?? (context ? `${context} / ${opts.namespace}` : opts.namespace),
      // The New workspace dialog offers a Node select from these (more than one); "Auto" leaves it to the preferences.
      ...(!connect && opts.preferredNodes?.length ? { nodes: opts.preferredNodes.map((n) => ({ id: n, name: n, connected: true, drained: false })) } : {}),
      // The New workspace dialog presets CPU and memory from these.
      ...(!connect && opts.defaults && (opts.defaults.cpus || opts.defaults.memoryMb) ? { defaults: { ...opts.defaults } } : {}),
    };
    this.delivery = kubernetesDelivery(
      {
        state: (name) => this.#deliveryState(name),
        readyPod: (name) => this.#readyPod(name),
        capture: (pod, argv, payload, o) => this.#capture(pod, argv, payload, o),
        startKeys: () => this.startKeys(),
      },
      opts.delivery,
    );
  }

  get #ns() {
    return this.opts.namespace;
  }

  #names: RuntimeNames | undefined;
  readonly #enrolled: boolean;

  /**
   * The browser pool's way into this namespace: none for an enrolled cluster (Connect), whose agent refuses a Deployment that runs anything
   * as root, which the browser container's init is (with every capability but SETUID and SETGID dropped).
   */
  browserAccess(): KubeBrowserAccess | null {
    if (this.#enrolled) return null;
    return { kubeConfig: this.#kc, namespace: this.#ns, objectName: (name) => this.#objectName(name) };
  }

  useNames(names: RuntimeNames) {
    this.#names = names;
  }

  /**
   * The Deployment of workspace `name` (T-42): the runtime name it has on record (its claim is `<runtimeName>-home`), never recomputed from
   * the name. Only a workspace the portal has no record of yet is named the old way (`ws-<name>`), which is what such a workspace is called.
   * A name that is not plain is refused here and in `#runningPod` (it goes into a label selector there): QA-029, QA-032.
   */
  #objectName(name: string): string {
    // The name asked for is checked FIRST, whether or not a runtime name is on record: '' or 'x/../y' must never reach the legacy derivation.
    const plain = plainName(name);
    return plainName(this.#names?.runtimeNameOf(this.target.id, plain) ?? legacyRuntimeName('kubernetes', plain));
  }

  /**
   * Pools, secrets, the chat host (foundation PRD §6.2) through `pods/exec` only, as root through the image's `sudo -n`
   * (kubernetesDelivery.ts). A running workspace only: a stopped one has no pod (`needsRunning`).
   */
  readonly delivery: DeliveryAccess;

  async #deliveryState(name: string): Promise<{ exists: boolean; running: boolean; portal: string | null }> {
    let d: V1Deployment;
    try {
      d = await this.#apps.readNamespacedDeployment({ name: this.#objectName(name), namespace: this.#ns });
    } catch (e) {
      if (codeOf(e) === 404) return { exists: false, running: false, portal: null };
      throw e;
    }
    return { exists: true, running: (await this.#readyPod(name)) !== null, portal: d.metadata?.labels?.[LABEL.portal] ?? null };
  }

  /**
   * A pod whose workspace container is Ready (delivery's "running"), not one on its way out. Not pod phase: it stays Pending while any
   * container's image pulls, a browser's included (browser PRD §20 A5).
   */
  #ready(p: V1Pod): boolean {
    return !p.metadata?.deletionTimestamp && !!p.status?.containerStatuses?.find((s) => s.name === CONTAINER)?.ready;
  }

  async #readyPod(name: string): Promise<string | null> {
    const pods = await this.#core.listNamespacedPod({ namespace: this.#ns, labelSelector: `${LABEL.managed}=true,${LABEL.name}=${plainName(name)}` });
    return pods.items.find((p) => this.#ready(p))?.metadata?.name ?? null;
  }

  /** Workspace name → its Ready pods' uid and container restart count: a new value is a start (scale 0 to 1, a new pod, a restart). */
  async startKeys(): Promise<Map<string, string>> {
    const pods = await this.#core.listNamespacedPod({ namespace: this.#ns, labelSelector: selector });
    const keys = new Map<string, string[]>();
    for (const p of pods.items) {
      const name = p.metadata?.labels?.[LABEL.name];
      if (!name || !this.#ready(p)) continue;
      const restarts = p.status?.containerStatuses?.find((s) => s.name === CONTAINER)?.restartCount ?? 0;
      keys.set(name, [...(keys.get(name) ?? []), `${p.metadata?.uid ?? p.metadata?.name}:${restarts}`]);
    }
    return new Map([...keys].map(([name, k]) => [name, k.sort().join(',')]));
  }

  /**
   * `argv` in the workspace container with `payload` on stdin, stdout and stderr apart. Stdin is written and never ended (over the v4
   * channel protocol an end closes the socket, status and all); the command reads only as many bytes as it was told. No status before the
   * socket closes is a dropped connection, and fails.
   */
  #capture(pod: string, argv: string[], payload: Buffer, o: { timeoutMs: number; maxOutputBytes: number }): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = payload.length ? new PassThrough() : null;
    stdin?.on('error', () => undefined);
    return new Promise((resolve, reject) => {
      let socket: { close(): void } | null = null;
      let status: V1Status | null = null;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stdin?.destroy();
        socket?.close();
        fn();
      };
      const collect = (into: Buffer[]) => (c: Buffer) => {
        size += c.length;
        if (size > o.maxOutputBytes) return settle(() => reject(new Error(`The command printed more than ${o.maxOutputBytes} bytes.`)));
        into.push(c);
      };
      stdout.on('data', collect(out));
      stderr.on('data', collect(err));
      const timer = setTimeout(() => settle(() => reject(new Error(`command timed out after ${o.timeoutMs} ms`))), o.timeoutMs);
      const closed = () =>
        // The last output frames are handled before the close; a turn of the loop lets the streams deliver them.
        setImmediate(() =>
          settle(() => {
            if (!status) return reject(new Error('The connection to the workspace dropped before the command finished.'));
            if (status.status === 'Success') return resolve({ code: 0, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
            const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
            if (!cause?.message || !Number.isInteger(Number(cause.message))) return reject(new Error(`The command could not run in the workspace: ${status.message ?? status.reason ?? 'no reason given'}`));
            resolve({ code: Number(cause.message), stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
          }),
        );
      new Exec(this.#kc)
        .exec(this.#ns, pod, CONTAINER, argv, stdout, stderr, stdin, false, (s: V1Status) => {
          status = s;
        })
        .then(
          (ws) => {
            socket = ws;
            if (settled) return ws.close();
            ws.on('close', closed);
            ws.on('error', closed);
            for (let at = 0; stdin && at < payload.length; at += 64 * 1024) stdin.write(payload.subarray(at, at + 64 * 1024));
          },
          (e: unknown) => settle(() => reject(e)),
        );
    });
  }

  async check() {
    // Works before the namespace exists (an empty list), and proves we can reach and read the cluster.
    await this.#core.listNamespacedPod({ namespace: this.#ns, limit: 1 });
  }

  async list(): Promise<Workspace[]> {
    const [deployments, pods] = await Promise.all([
      this.#apps.listNamespacedDeployment({ namespace: this.#ns, labelSelector: selector }),
      this.#core.listNamespacedPod({ namespace: this.#ns, labelSelector: selector }),
    ]);
    const podsByName = new Map<string, V1Pod[]>();
    for (const pod of pods.items) {
      const name = pod.metadata?.labels?.[LABEL.name];
      if (name) podsByName.set(name, [...(podsByName.get(name) ?? []), pod]);
    }
    return deployments.items.map((d) => {
      const labels = d.metadata?.labels ?? {};
      const name = labels[LABEL.name] ?? d.metadata!.name!;
      const { status, detail } = this.#status(d, podsByName.get(name) ?? []);
      return {
        id: workspaceId(this.target.id, name),
        name,
        // What the Deployment is called, as the cluster says: the runtime name the manager records for a workspace it has no record of (T-42).
        ...(d.metadata?.name ? { runtimeName: d.metadata.name } : {}),
        target: this.target.id,
        image: d.spec?.template.spec?.containers[0]?.image ?? this.opts.image,
        status,
        detail,
        createdAt: new Date(d.metadata?.creationTimestamp ?? Date.now()).toISOString(),
        cpus: Number(labels[LIMIT.cpus]) || undefined,
        memoryMb: Number(labels[LIMIT.memoryMb]) || undefined,
      };
    });
  }

  #status(d: V1Deployment, pods: V1Pod[]): { status: WorkspaceStatus; detail?: string } {
    if (d.metadata?.deletionTimestamp) return { status: 'stopping' };
    const live = pods.filter((p) => !p.metadata?.deletionTimestamp);
    if (d.spec?.replicas === 0) return pods.length ? { status: 'stopping' } : { status: 'stopped' };

    const pod = live[0];
    if (!pod) return { status: 'starting', detail: 'Scheduling' };
    // The workspace's own containers only (browser PRD §20 A5): a browser container whose image can't be pulled, or that crash-loops,
    // is the browser's state, never the workspace's.
    const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? []).filter((s) => s.name === CONTAINER)];
    const waiting = statuses.map((s) => s.state?.waiting).find(Boolean);
    if (waiting?.reason && STUCK.has(waiting.reason))
      return { status: 'error', detail: `${waiting.reason}: ${waiting.message ?? ''}`.trim() };
    const ready = pod.status?.containerStatuses?.find((s) => s.name === CONTAINER)?.ready;
    // The workspace container's own readiness, not pod phase (Pending while another container's image pulls).
    if (ready && pod.status?.phase !== 'Failed') return { status: 'running' };
    if (pod.status?.phase === 'Failed') return { status: 'error', detail: pod.status.message ?? pod.status.reason };
    const unschedulable = pod.status?.conditions?.find((c) => c.type === 'PodScheduled' && c.status === 'False');
    return { status: 'starting', detail: unschedulable?.message ?? waiting?.reason ?? pod.status?.phase };
  }

  async create(spec: CreateSpec, progress: (detail: string) => void) {
    const ns = this.#ns;
    // The manager gives a new workspace its runtime name (`ws-<12 hex>`); a direct call without one uses what is on record.
    const runtimeName = spec.runtimeName ? plainName(spec.runtimeName) : this.#objectName(spec.name);
    const claim = homeVolumeOf(runtimeName);
    const exists = await this.#apps
      .readNamespacedDeployment({ name: runtimeName, namespace: ns })
      .then(() => true, (e) => (codeOf(e) === 404 ? false : Promise.reject(e)));
    if (exists) throw new AppError('CONFLICT', `A workspace named “${spec.name}” already exists here.`);
    // A node is honoured only on a target that lists its nodes (PORTAL_K8S_TARGETS `preferredNodes`); elsewhere it is ignored, as before.
    const node = spec.node && this.opts.preferredNodes?.length ? spec.node : undefined;
    if (node && !this.opts.preferredNodes!.includes(node))
      throw new AppError('VALIDATION_FAILED', 'Pick a node of this target.', { details: { node: 'Not a node of this target.' } });
    const placement = placementOf(this.opts, node);
    const cpus = spec.cpus ?? this.opts.defaults?.cpus;
    const memoryMb = spec.memoryMb ?? this.opts.defaults?.memoryMb;

    if (this.#manageNamespace) {
      progress(`Preparing namespace ${ns}`);
      await this.#core
        .createNamespace({ body: { metadata: { name: ns, labels: { [LABEL.managed]: 'true' } } } })
        // 403: a portal with a namespaced Role only (a rig, a locked-down cluster) uses the namespace someone made for it.
        .catch(ignore(409, 403));
    }

    const labels = {
      [LABEL.managed]: 'true',
      [LABEL.name]: spec.name,
      ...(cpus ? { [LIMIT.cpus]: String(cpus) } : {}),
      ...(memoryMb ? { [LIMIT.memoryMb]: String(memoryMb) } : {}),
    };
    const match = { [LABEL.managed]: 'true', [LABEL.name]: spec.name };

    const limits: Record<string, string> = {};
    if (cpus) limits.cpu = String(cpus);
    if (memoryMb) limits.memory = `${memoryMb}Mi`;
    const home = { name: 'home', persistentVolumeClaim: { claimName: claim } };
    const requests = Object.keys(limits).length ? requestsFor(limits, this.opts.requests) : undefined;

    // The fit check (fit.ts, T-98): a pod that fits on no node it may go to would stay Pending, so the create is refused with the numbers.
    // A cluster the portal may not read (no ClusterRole claudepilot-portal-fit-check, an enrolled cluster's namespaced Role) is not
    // checked: the create goes on as before.
    const need = needOf([{ resources: { limits, requests } }]);
    if (this.#fitCheck && (need.cpuMilli > 0 || need.memoryBytes > 0)) {
      const fit = await checkFit(this.#core, { need, nodeSelector: placement.nodeSelector, ...(node ? { node } : {}) });
      if (fit.checked && !fit.fits) throw new AppError('CONFLICT', fit.reason);
      if (!fit.checked) console.log(`[kubernetes] ${spec.name}: ${fit.reason}`);
    }

    progress('Creating home volume');
    await this.#core
      .createNamespacedPersistentVolumeClaim({
        namespace: ns,
        body: {
          metadata: { name: claim, labels },
          spec: {
            accessModes: ['ReadWriteOnce'],
            storageClassName: this.opts.storageClass,
            resources: { requests: { storage: this.opts.storage } },
          },
        },
      })
      .catch(ignore(409));


    progress('Creating deployment');
    await this.#apps.createNamespacedDeployment({
      namespace: ns,
      body: {
        metadata: { name: runtimeName, labels },
        spec: {
          replicas: 1,
          strategy: { type: 'Recreate' },
          selector: { matchLabels: match },
          template: {
            metadata: { labels },
            spec: {
              hostname: spec.name,
              ...placement,
              terminationGracePeriodSeconds: 5,
              securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
              imagePullSecrets: this.opts.imagePullSecret ? [{ name: this.opts.imagePullSecret }] : undefined,
              volumes: [home],
              // A new PVC is empty: copy the image's home in once, like Docker does for a fresh volume.
              initContainers: [
                {
                  name: 'seed-home',
                  image: this.opts.image,
                  // --no-preserve=all: the new volume's top folder belongs to root on many storage classes (k3s local-path), and
                  // `cp -a` as uid 1000 fails to set that folder's times and mode ("Operation not permitted"); `tar` fails the
                  // same way. The files are created by uid 1000, the user the workspace runs as, so owners need no preserving.
                  // (Not root: the Connect agent's policy refuses a Deployment that runs anything as root.)
                  command: ['sh', '-c', seedHomeScript()],
                  volumeMounts: [{ name: 'home', mountPath: '/seed' }],
                },
              ],
              containers: [
                {
                  name: CONTAINER,
                  image: this.opts.image,
                  workingDir: HOME,
                  env: [{ name: 'TERM', value: 'xterm-256color' }],
                  resources: Object.keys(limits).length ? { limits, requests } : undefined,
                  volumeMounts: [{ name: 'home', mountPath: HOME }],
                },
              ],
            },
          },
        },
      },
    });
  }

  #scale(name: string, replicas: number) {
    const object = this.#objectName(name);
    return this.#apps
      .replaceNamespacedDeploymentScale({
        name: object,
        namespace: this.#ns,
        body: { metadata: { name: object, namespace: this.#ns }, spec: { replicas } },
      })
      .then(() => undefined);
  }

  /**
   * CPU and memory after a create (T-98). The values live in the `workspace` container of the Deployment's pod template; writing them is a
   * read, change and replace (the read's resourceVersion guards against a change in between). The limit labels the list reads are kept in
   * step. The fit check reads the nodes and every pod on them: the portal's ClusterRole `claudepilot-portal-fit-check` (deploy/k3s/rbac.yaml);
   * without it the check is `unavailable`, never a guess.
   *
   * A running workspace (T-3081) is resized in place first (`pods/resize`, Kubernetes 1.33 and later), so no session ends; then the
   * Deployment is written while paused and the ReplicaSet that owns the pod gets the same template, so unpausing finds its template already
   * there and rolls nothing, and a pod made later (a restart, an eviction) has the new values. When the resize is refused (an older cluster,
   * no `pods/resize` in the Role, a QoS class change, the kubelet answers Infeasible) the Deployment is written as before and the pod
   * restarts (Recreate); `refused` says why.
   */
  readonly resources: ResourceAccess = {
    read: async (name) => {
      const d = await this.#apps.readNamespacedDeployment({ name: this.#objectName(name), namespace: this.#ns });
      const c = d.spec?.template.spec?.containers.find((x) => x.name === CONTAINER);
      return { live: valuesOf(c?.resources as { limits?: Record<string, string>; requests?: Record<string, string> } | undefined), replicas: d.spec?.replicas ?? 1 };
    },
    fit: async (name, want) => {
      if (!this.#fitCheck) return fitView(unchecked(needOfValues(want), 'this cluster is enrolled through Connect; its agent may not read the cluster’s nodes and pods.'));
      let node: string | null = null;
      try {
        const own = await this.#core.listNamespacedPod({ namespace: this.#ns, labelSelector: `${LABEL.managed}=true,${LABEL.name}=${plainName(name)}` });
        node = own.items.find((p) => !p.metadata?.deletionTimestamp && p.spec?.nodeName)?.spec?.nodeName ?? null;
      } catch {
        // No pod list: decided on the nodes it may go to, as for a stopped workspace.
      }
      const isSelf = (p: FitPod) => p.namespace === this.#ns && p.labels?.[LABEL.managed] === 'true' && p.labels?.[LABEL.name] === name;
      return fitView(await checkFit(this.#core, { need: needOfValues(want), node, nodeSelector: this.opts.nodeSelector, isSelf }));
    },
    apply: async (name, values, opts = {}): Promise<ResourceApplied | false> => {
      const object = this.#objectName(name);
      const d = await this.#apps.readNamespacedDeployment({ name: object, namespace: this.#ns });
      const replicas = d.spec?.replicas ?? 1;
      if (opts.onlyWhenStopped && replicas !== 0) return false;
      if (!this.#setValues(d, values)) throw new AppError('CONFLICT', 'That Deployment is not a workspace the portal manages.');
      if (replicas === 0) {
        await this.#apps.replaceNamespacedDeployment({ name: object, namespace: this.#ns, body: d });
        return { how: 'written', refused: null };
      }
      const resized = await this.#resizeInPlace(name, values);
      if ('refused' in resized) {
        await this.#apps.replaceNamespacedDeployment({ name: object, namespace: this.#ns, body: d });
        return { how: 'restarted', refused: resized.refused };
      }
      try {
        await this.#writePaused(object, d, resized.replicaSet, values);
        return { how: 'resized', refused: null };
      } catch (e) {
        // The pod has the values, but the template could not be kept without a roll: written plainly (unpaused), the pod restarts once
        // more with them, so they are not lost at the next one.
        const why = apiMessage(e);
        const fresh = await this.#apps.readNamespacedDeployment({ name: object, namespace: this.#ns });
        this.#setValues(fresh, values);
        if (fresh.spec) fresh.spec.paused = false;
        await this.#apps.replaceNamespacedDeployment({ name: object, namespace: this.#ns, body: fresh });
        return { how: 'restarted', refused: `the pod was resized in place, but its ReplicaSet could not be written (${why})` };
      }
    },
  };

  /** Sets the values in a managed Deployment (its template, the limit labels, the change annotation); false when it is not one. */
  #setValues(d: V1Deployment, values: WorkspaceResourceValues): boolean {
    const c = d.spec?.template.spec?.containers.find((x) => x.name === CONTAINER);
    if (!c || d.metadata?.labels?.[LABEL.managed] !== 'true') return false;
    c.resources = withValues(c.resources as Resources | undefined, values);
    d.metadata = {
      ...d.metadata,
      labels: { ...d.metadata?.labels, [LIMIT.cpus]: String(values.cpus), [LIMIT.memoryMb]: String(values.memoryMb) },
      annotations: { ...d.metadata?.annotations, 'claudepilot.resources-changed': new Date().toISOString() },
    };
    return true;
  }

  /**
   * The in-place resize (T-3081): a JSON Patch of the `workspace` container's resources on the running pod's `resize` subresource, then up
   * to `waitMs` for the kubelet: its container status showing the values is done, a `PodResizePending` Infeasible is a refusal, Deferred
   * (or no answer yet) is left to the kubelet, which applies it when there is room. Answers the ReplicaSet that owns the pod, or why not.
   */
  async #resizeInPlace(name: string, values: WorkspaceResourceValues): Promise<{ pod: string; replicaSet: string } | { refused: string }> {
    const pods = await this.#core.listNamespacedPod({ namespace: this.#ns, labelSelector: `${LABEL.managed}=true,${LABEL.name}=${plainName(name)}` });
    const pod = pods.items.find((p) => !p.metadata?.deletionTimestamp && !!p.status?.containerStatuses?.find((s) => s.name === CONTAINER)?.state?.running);
    if (!pod?.metadata?.name) return { refused: 'its pod is not running yet' };
    const replicaSet = pod.metadata.ownerReferences?.find((o) => o.kind === 'ReplicaSet' && o.controller !== false)?.name;
    if (!replicaSet) return { refused: 'no ReplicaSet owns its pod' };
    const index = pod.spec?.containers.findIndex((c) => c.name === CONTAINER) ?? -1;
    if (index < 0) return { refused: 'its pod has no workspace container' };
    const want = withValues(pod.spec!.containers[index]!.resources as Resources | undefined, values);
    try {
      await this.#core.patchNamespacedPodResize({ name: pod.metadata.name, namespace: this.#ns, body: [{ op: 'add', path: `/spec/containers/${index}/resources`, value: want }] });
    } catch (e) {
      return { refused: `the cluster refused the in-place resize: ${apiMessage(e)}` };
    }
    const pollMs = this.opts.resize?.pollMs ?? 500;
    const until = Date.now() + (this.opts.resize?.waitMs ?? 10_000);
    for (;;) {
      const now = await this.#core.readNamespacedPod({ name: pod.metadata.name, namespace: this.#ns }).catch(() => null);
      const pending = now?.status?.conditions?.find((c) => c.type === 'PodResizePending');
      if (pending?.reason === 'Infeasible') return { refused: `the node cannot resize it in place: ${(pending.message ?? 'Infeasible').slice(0, 300)}` };
      const status = now?.status?.containerStatuses?.find((s) => s.name === CONTAINER)?.resources as Resources | undefined;
      if (status && same(valuesOf(status), values)) break;
      if (Date.now() >= until) {
        console.log(`[workspaces] ${name}: the in-place resize is accepted; the kubelet has not confirmed it yet${pending?.reason ? ` (${pending.reason})` : ''}`);
        break;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { pod: pod.metadata.name, replicaSet };
  }

  /**
   * Keeps the resized values without a roll: the Deployment is written paused (the controller makes no new ReplicaSet while paused), the
   * ReplicaSet that owns the pod gets the same container resources (its pods are not touched by that), and the Deployment is unpaused, which
   * then finds a ReplicaSet with its template (the controller compares templates ignoring `pod-template-hash`) and rolls nothing.
   */
  async #writePaused(object: string, d: V1Deployment, replicaSetName: string, values: WorkspaceResourceValues): Promise<void> {
    const wasPaused = d.spec?.paused ?? false;
    d.spec = { ...d.spec!, paused: true };
    const written = await this.#apps.replaceNamespacedDeployment({ name: object, namespace: this.#ns, body: d });
    const rs = await this.#apps.readNamespacedReplicaSet({ name: replicaSetName, namespace: this.#ns });
    if (!rs.metadata?.ownerReferences?.some((o) => o.kind === 'Deployment' && o.uid === written.metadata?.uid))
      throw new AppError('CONFLICT', `ReplicaSet ${replicaSetName} is not this workspace’s`);
    const c = rs.spec?.template?.spec?.containers.find((x) => x.name === CONTAINER);
    if (!c) throw new AppError('CONFLICT', `ReplicaSet ${replicaSetName} has no workspace container`);
    c.resources = withValues(c.resources as Resources | undefined, values);
    await this.#apps.replaceNamespacedReplicaSet({ name: replicaSetName, namespace: this.#ns, body: rs });
    const fresh = await this.#apps.readNamespacedDeployment({ name: object, namespace: this.#ns });
    fresh.spec = { ...fresh.spec!, paused: wasPaused };
    await this.#apps.replaceNamespacedDeployment({ name: object, namespace: this.#ns, body: fresh });
  }

  start = async (name: string) => this.#scale(name, 1);
  stop = async (name: string) => this.#scale(name, 0);

  async remove(name: string) {
    const object = this.#objectName(name);
    await this.#apps
      .deleteNamespacedDeployment({ name: object, namespace: this.#ns, propagationPolicy: 'Foreground' })
      .catch(ignore(404));
    await this.#core.deleteNamespacedPersistentVolumeClaim({ name: homeVolumeOf(object), namespace: this.#ns }).catch(ignore(404));
  }

  async usage(names: string[]) {
    const byName = new Map<string, { cpuPercent: number; memoryBytes: number }>();
    try {
      const res = (await this.#metrics.listNamespacedCustomObject({
        group: 'metrics.k8s.io',
        version: 'v1beta1',
        namespace: this.#ns,
        plural: 'pods',
        labelSelector: selector,
      })) as { items: { metadata: { labels?: Record<string, string> }; containers: { name?: string; usage: { cpu: string; memory: string } }[] }[] };
      for (const item of res.items) {
        const name = item.metadata.labels?.[LABEL.name];
        if (!name) continue;
        // The workspace container's own use (browser PRD §20 A5): the browser container reports its own (its supervisor reads its cgroup).
        const own = item.containers.filter((c) => c.name === undefined || c.name === CONTAINER);
        const cpu = own.reduce((sum, c) => sum + cores(c.usage.cpu), 0);
        const mem = own.reduce((sum, c) => sum + bytes(c.usage.memory), 0);
        byName.set(name, { cpuPercent: cpu * 100, memoryBytes: mem });
      }
    } catch {
      // No metrics-server, or no pods yet: unknown, not zero.
    }
    return names.map((n) => byName.get(n) ?? { cpuPercent: null, memoryBytes: null });
  }

  async #runningPod(name: string): Promise<string> {
    const pods = await this.#core.listNamespacedPod({
      namespace: this.#ns,
      labelSelector: `${LABEL.managed}=true,${LABEL.name}=${plainName(name)}`,
    });
    // The workspace container running is what counts (browser PRD §20 A5): the pod stays Pending while a browser image pulls.
    const pod = pods.items.find((p) => !p.metadata?.deletionTimestamp && !!p.status?.containerStatuses?.find((s) => s.name === CONTAINER)?.state?.running);
    if (!pod) throw new AppError('CONFLICT', 'The workspace isn’t running.');
    return pod.metadata!.name!;
  }

  async exec(name: string, command: string[]): Promise<ExecSession> {
    const pod = await this.#runningPod(name);
    const out = new PassThrough();
    const stdin = new PassThrough();
    stdin.on('error', () => undefined); // a write after the command exited is the caller's lost race, not a crash
    const exitFns: ((code: number | null) => void)[] = [];
    let exitCode: number | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      exitFns.forEach((fn) => fn(exitCode));
    };
    const ws = await new Exec(this.#kc).exec(this.#ns, pod, CONTAINER, command, out, out, stdin, false, (status: V1Status) => {
      if (status.status === 'Success') exitCode = 0;
      else {
        const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
        exitCode = cause?.message ? Number(cause.message) : null;
      }
    });
    ws.on('close', finish);
    ws.on('error', finish);
    return {
      write: (data) => void stdin.write(data),
      close: () => ws.close(),
      onData: (fn) => void out.on('data', fn),
      onExit: (fn) => void exitFns.push(fn),
    };
  }

  async shell(name: string, size: { cols: number; rows: number }, command?: string[]): Promise<ShellSession> {
    const podName = await this.#runningPod(name);

    // Exec reads the size off stdout (rows/columns + "resize" events), like a real TTY.
    const stdout = Object.assign(new PassThrough(), { columns: size.cols, rows: size.rows });
    const stdin = new PassThrough();
    stdin.on('error', () => undefined);
    const exitFns: ((code: number | null) => void)[] = [];
    let exitCode: number | null = null;
    let exited = false;
    const finish = () => {
      if (exited) return;
      exited = true;
      exitFns.forEach((fn) => fn(exitCode));
    };

    const ws = await new Exec(this.#kc).exec(
      this.#ns,
      podName,
      CONTAINER,
      command ?? ['bash', '-l'],
      stdout,
      null, // a TTY merges stderr into stdout
      stdin,
      true,
      (status: V1Status) => {
        if (status.status === 'Success') exitCode = 0;
        else {
          const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
          exitCode = cause?.message ? Number(cause.message) : null;
        }
      },
    );
    ws.on('close', finish);
    ws.on('error', finish);

    return {
      write: (data) => void stdin.write(data),
      resize: (cols, rows) => {
        stdout.columns = cols;
        stdout.rows = rows;
        stdout.emit('resize');
      },
      close: () => ws.close(),
      onData: (fn) => void stdout.on('data', fn),
      onExit: (fn) => void exitFns.push(fn),
    };
  }
}
