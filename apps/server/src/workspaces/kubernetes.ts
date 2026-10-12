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
import { HOME, LABEL, type CreateSpec, type ExecSession, type Runtime, type ShellSession } from './runtime.js';

const LIMIT = { cpus: 'claudepilot.cpus', memoryMb: 'claudepilot.memory-mb' } as const;
const CONTAINER = 'workspace';
const SEEDED = '.claudepilot-seeded';

// A name that is not plain is refused here and in `#runningPod` (it goes into a label selector there): QA-029, QA-032.
const objectName = (name: string) => `ws-${plainName(name)}`;
const claimName = (name: string) => `ws-${plainName(name)}-home`;
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
}

/** One namespace in a cluster: a Deployment (scaled 1/0 to start/stop) and a PVC per workspace. */
export class KubernetesRuntime implements Runtime {
  readonly target;
  readonly #kc = new KubeConfig();
  readonly #core: CoreV1Api;
  readonly #apps: AppsV1Api;
  readonly #metrics: CustomObjectsApi;

  constructor(private readonly opts: KubernetesOptions) {
    this.#kc.loadFromDefault();
    this.#core = this.#kc.makeApiClient(CoreV1Api);
    this.#apps = this.#kc.makeApiClient(AppsV1Api);
    this.#metrics = this.#kc.makeApiClient(CustomObjectsApi);
    const context = this.#kc.getCurrentContext();
    this.target = {
      id: 'kubernetes',
      label: 'Kubernetes',
      kind: 'kubernetes' as const,
      where: context ? `${context} / ${opts.namespace}` : opts.namespace,
    };
  }

  get #ns() {
    return this.opts.namespace;
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
    const exists = await this.#apps
      .readNamespacedDeployment({ name: objectName(spec.name), namespace: ns })
      .then(() => true, (e) => (codeOf(e) === 404 ? false : Promise.reject(e)));
    if (exists) throw new AppError('CONFLICT', `A workspace named “${spec.name}” already exists here.`);

    progress(`Preparing namespace ${ns}`);
    await this.#core
      .createNamespace({ body: { metadata: { name: ns, labels: { [LABEL.managed]: 'true' } } } })
      .catch(ignore(409));

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
          metadata: { name: claimName(spec.name), labels },
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
    const home = { name: 'home', persistentVolumeClaim: { claimName: claimName(spec.name) } };

    progress('Creating deployment');
    await this.#apps.createNamespacedDeployment({
      namespace: ns,
      body: {
        metadata: { name: objectName(spec.name), labels },
        spec: {
          replicas: 1,
          strategy: { type: 'Recreate' },
          selector: { matchLabels: match },
          template: {
            metadata: { labels },
            spec: {
              hostname: spec.name,
              terminationGracePeriodSeconds: 5,
              securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
              imagePullSecrets: this.opts.imagePullSecret ? [{ name: this.opts.imagePullSecret }] : undefined,
              volumes: [home],
              // A new PVC is empty: copy the image's home in once, like Docker does for a fresh volume.
              initContainers: [
                {
                  name: 'seed-home',
                  image: this.opts.image,
                  command: ['sh', '-c', `[ -e /seed/${SEEDED} ] || { cp -a ${HOME}/. /seed/ && touch /seed/${SEEDED}; }`],
                  volumeMounts: [{ name: 'home', mountPath: '/seed' }],
                },
              ],
              containers: [
                {
                  name: CONTAINER,
                  image: this.opts.image,
                  workingDir: HOME,
                  env: [{ name: 'TERM', value: 'xterm-256color' }],
                  resources: Object.keys(limits).length ? { limits } : undefined,
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
    return this.#apps
      .replaceNamespacedDeploymentScale({
        name: objectName(name),
        namespace: this.#ns,
        body: { metadata: { name: objectName(name), namespace: this.#ns }, spec: { replicas } },
      })
      .then(() => undefined);
  }

  start = async (name: string) => this.#scale(name, 1);
  stop = async (name: string) => this.#scale(name, 0);

  async remove(name: string) {
    await this.#apps
      .deleteNamespacedDeployment({ name: objectName(name), namespace: this.#ns, propagationPolicy: 'Foreground' })
      .catch(ignore(404));
    await this.#core.deleteNamespacedPersistentVolumeClaim({ name: claimName(name), namespace: this.#ns }).catch(ignore(404));
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
