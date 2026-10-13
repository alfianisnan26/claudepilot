import { PassThrough } from 'node:stream';
import { AppError } from '@isnanme/core';
import { workspaceId, type Workspace, type WorkspaceStatus } from '@portal/contracts';
import {
  AppsV1Api,
  CoreV1Api,
  CustomObjectsApi,
  Exec,
  KubeConfig,
  type V1Deployment,
  type V1Pod,
  type V1Status,
} from '@kubernetes/client-node';
import { plainName } from '../names.js';
import { requestsFor, type RequestOptions } from './requests.js';
import { kubernetesDelivery } from './kubernetesDelivery.js';
import { homeVolumeOf, legacyRuntimeName } from './identity.js';
import { HOME, LABEL, type CreateSpec, type DeliveryAccess, type ExecSession, type Runtime, type RuntimeNames, type ShellSession } from './runtime.js';

const LIMIT = { cpus: 'claudepilot.cpus', memoryMb: 'claudepilot.memory-mb' } as const;
const CONTAINER = 'workspace';
const SEEDED = '.claudepilot-seeded';

const selector = `${LABEL.managed}=true`;

const codeOf = (e: unknown) => (e as { code?: number }).code;
const ignore = (...codes: number[]) => (e: unknown) => {
  if (!codes.includes(codeOf(e) ?? 0)) throw e;
};

/** Waiting reasons that won't fix themselves. */
const STUCK = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CrashLoopBackOff', 'CreateContainerConfigError']);

/** Kubernetes quantities: CPU in cores ("250m", "1", "123456n"), memory in bytes ("512Mi"). */
function cores(q: string): number {
  const units: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3 };
  const unit = units[q.slice(-1)];
  return unit ? Number(q.slice(0, -1)) * unit : Number(q);
}
function bytes(q: string): number {
  const m = q.match(/^(\d+(?:\.\d+)?)([KMGTE]i?|k)?$/);
  if (!m) return Number(q) || 0;
  const pow: Record<string, number> = { K: 1, k: 1, M: 2, G: 3, T: 4, E: 6 };
  const base = m[2]?.endsWith('i') ? 1024 : 1000;
  return Number(m[1]) * base ** (m[2] ? pow[m[2][0]!]! : 0);
}

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
  /** Tests only: the folders delivery may write and read (default: the engine's, `DELIVERY_ROOTS`), and how often starts are polled. */
  delivery?: { roots?: readonly string[]; pollMs?: number };
}

/** One namespace in a cluster: a Deployment (scaled 1/0 to start/stop) and a PVC per workspace. */
export class KubernetesRuntime implements Runtime {
  readonly target;
  readonly #kc: KubeConfig = new KubeConfig();
  readonly #core: CoreV1Api;
  readonly #apps: AppsV1Api;
  readonly #metrics: CustomObjectsApi;

  readonly #manageNamespace: boolean;

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
    this.#manageNamespace = connect?.manageNamespace ?? true;
    this.#core = this.#kc.makeApiClient(CoreV1Api);
    this.#apps = this.#kc.makeApiClient(AppsV1Api);
    this.#metrics = this.#kc.makeApiClient(CustomObjectsApi);
    const context = connect ? null : this.#kc.getCurrentContext();
    this.target = {
      id: connect?.target.id ?? 'kubernetes',
      label: connect?.target.label ?? 'Kubernetes',
      kind: 'kubernetes' as const,
      where: connect?.target.where ?? (context ? `${context} / ${opts.namespace}` : opts.namespace),
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

  useNames(names: RuntimeNames) {
    this.#names = names;
  }

  /**
   * The Deployment of workspace `name` (T-42): the runtime name it has on record (its claim is `<runtimeName>-home`), never recomputed from
   * the name. Only a workspace the portal has no record of yet is named the old way (`ws-<name>`), which is what such a workspace is called.
   * A name that is not plain is refused here and in `#runningPod` (it goes into a label selector there): QA-029, QA-032.
   */
  #objectName(name: string): string {
    // The name itself first: with no registry the `?.` call would not evaluate its arguments, and the legacy name of "" is plain (QA-029).
    plainName(name);
    return plainName(this.#names?.runtimeNameOf(this.target.id, name) ?? legacyRuntimeName('kubernetes', name));
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

  /** A pod that is up and whose workspace container is Ready (delivery's "running"), not one on its way out. */
  #ready(p: V1Pod): boolean {
    return p.status?.phase === 'Running' && !p.metadata?.deletionTimestamp && !!p.status.containerStatuses?.find((s) => s.name === CONTAINER)?.ready;
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
    const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    const waiting = statuses.map((s) => s.state?.waiting).find(Boolean);
    if (waiting?.reason && STUCK.has(waiting.reason))
      return { status: 'error', detail: `${waiting.reason}: ${waiting.message ?? ''}`.trim() };
    const ready = pod.status?.containerStatuses?.find((s) => s.name === CONTAINER)?.ready;
    if (pod.status?.phase === 'Running' && ready) return { status: 'running' };
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

    if (this.#manageNamespace) {
      progress(`Preparing namespace ${ns}`);
      await this.#core
        .createNamespace({ body: { metadata: { name: ns, labels: { [LABEL.managed]: 'true' } } } })
        .catch(ignore(409));
    }

    const labels = {
      [LABEL.managed]: 'true',
      [LABEL.name]: spec.name,
      ...(spec.cpus ? { [LIMIT.cpus]: String(spec.cpus) } : {}),
      ...(spec.memoryMb ? { [LIMIT.memoryMb]: String(spec.memoryMb) } : {}),
    };
    const match = { [LABEL.managed]: 'true', [LABEL.name]: spec.name };

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

    const limits: Record<string, string> = {};
    if (spec.cpus) limits.cpu = String(spec.cpus);
    if (spec.memoryMb) limits.memory = `${spec.memoryMb}Mi`;
    const home = { name: 'home', persistentVolumeClaim: { claimName: claim } };

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
              nodeSelector: this.opts.nodeSelector,
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
                  command: ['sh', '-c', `[ -e /seed/${SEEDED} ] || { cp -a --no-preserve=all ${HOME}/. /seed/ && touch /seed/${SEEDED}; }`],
                  volumeMounts: [{ name: 'home', mountPath: '/seed' }],
                },
              ],
              containers: [
                {
                  name: CONTAINER,
                  image: this.opts.image,
                  workingDir: HOME,
                  env: [{ name: 'TERM', value: 'xterm-256color' }],
                  resources: Object.keys(limits).length ? { limits, requests: requestsFor(limits, this.opts.requests) } : undefined,
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
      })) as { items: { metadata: { labels?: Record<string, string> }; containers: { usage: { cpu: string; memory: string } }[] }[] };
      for (const item of res.items) {
        const name = item.metadata.labels?.[LABEL.name];
        if (!name) continue;
        const cpu = item.containers.reduce((sum, c) => sum + cores(c.usage.cpu), 0);
        const mem = item.containers.reduce((sum, c) => sum + bytes(c.usage.memory), 0);
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
    const pod = pods.items.find((p) => p.status?.phase === 'Running' && !p.metadata?.deletionTimestamp);
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
