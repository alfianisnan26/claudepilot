import { existsSync } from 'node:fs';
import { AppError } from '@isnanme/core';
import { workspaceId, type Workspace, type WorkspaceStatus } from '@portal/contracts';
import Docker from 'dockerode';
import { HOME, LABEL, type CreateSpec, type Runtime, type ShellSession } from './runtime.js';

const LIMIT = { cpus: 'claudepilot.cpus', memoryMb: 'claudepilot.memory-mb' } as const;

const containerName = (name: string) => `claudepilot-${name}`;
const volumeName = (name: string) => `claudepilot-${name}-home`;

/** Docker answers "already started/stopped" with 304 and "no such thing" with 404. */
const statusOf = (e: unknown) => (e as { statusCode?: number }).statusCode;
const ignore = (...codes: number[]) => (e: unknown) => {
  if (!codes.includes(statusOf(e) ?? 0)) throw e;
};

const STATUS: Record<string, WorkspaceStatus> = {
  created: 'stopped',
  running: 'running',
  paused: 'stopped',
  restarting: 'starting',
  removing: 'stopping',
  exited: 'stopped',
  dead: 'error',
};

/** One Docker daemon, reached over its unix socket. */
export class DockerRuntime implements Runtime {
  readonly target;
  readonly #docker: Docker;
  readonly #socket: string;
  /** One image build or pull at a time per daemon; concurrent creates share it. */
  #imageReady: Promise<void> | undefined;

  constructor(
    opts: { id: string; label: string; socket: string },
    private readonly image: string,
    private readonly imageContext: string,
  ) {
    this.target = { id: opts.id, label: opts.label, kind: 'docker' as const, where: opts.socket };
    this.#socket = opts.socket;
    this.#docker = new Docker({ socketPath: opts.socket });
  }

  async check() {
    if (!existsSync(this.#socket)) throw new Error(`${this.#socket} not found`);
    await this.#docker.ping();
  }

  async list(): Promise<Workspace[]> {
    const containers = await this.#docker.listContainers({
      all: true,
      filters: { label: [`${LABEL.managed}=true`] },
    });
    return containers.map((c) => {
      const name = c.Labels[LABEL.name] ?? c.Names[0]?.replace(/^\/claudepilot-/, '') ?? c.Id;
      const cpus = Number(c.Labels[LIMIT.cpus]) || undefined;
      const memoryMb = Number(c.Labels[LIMIT.memoryMb]) || undefined;
      return {
        id: workspaceId(this.target.id, name),
        name,
        target: this.target.id,
        image: c.Image,
        status: STATUS[c.State] ?? 'error',
        detail: c.Status,
        createdAt: new Date(c.Created * 1000).toISOString(),
        cpus,
        memoryMb,
      };
    });
  }

  async create(spec: CreateSpec, progress: (detail: string) => void) {
    const existing = await this.#docker.listContainers({
      all: true,
      filters: { name: [`^/${containerName(spec.name)}$`] },
    });
    if (existing.length) throw new AppError('CONFLICT', `A workspace named “${spec.name}” already exists here.`);

    await this.#ensureImage(progress);
    progress('Creating container');
    const labels = {
      [LABEL.managed]: 'true',
      [LABEL.name]: spec.name,
      ...(spec.cpus ? { [LIMIT.cpus]: String(spec.cpus) } : {}),
      ...(spec.memoryMb ? { [LIMIT.memoryMb]: String(spec.memoryMb) } : {}),
    };
    const container = await this.#docker.createContainer({
      name: containerName(spec.name),
      Image: this.image,
      Hostname: spec.name,
      User: 'node',
      WorkingDir: HOME,
      Labels: labels,
      Env: ['TERM=xterm-256color'],
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        // A fresh named volume is seeded with the image's home (dotfiles, ~/work).
        Mounts: [{ Type: 'volume', Source: volumeName(spec.name), Target: HOME }],
        NanoCpus: spec.cpus ? Math.round(spec.cpus * 1e9) : undefined,
        Memory: spec.memoryMb ? spec.memoryMb * 1024 * 1024 : undefined,
      },
    });
    progress('Starting');
    await container.start();
  }

  start = (name: string) => this.#container(name).start().catch(ignore(304));
  stop = (name: string) => this.#container(name).stop({ t: 5 }).catch(ignore(304));

  async remove(name: string) {
    await this.#container(name).remove({ force: true }).catch(ignore(404));
    await this.#docker.getVolume(volumeName(name)).remove().catch(ignore(404));
  }

  usage(names: string[]) {
    return Promise.all(
      names.map(async (name) => {
        try {
          // stream:false waits for a second sample, so precpu_stats is filled for the CPU delta.
          const s = await this.#container(name).stats({ stream: false });
          const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
          const systemDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
          const cpus = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
          const memStats = s.memory_stats.stats as Record<string, number> | undefined;
          const cache = memStats?.inactive_file ?? memStats?.total_inactive_file ?? 0;
          const memoryBytes = s.memory_stats.usage ? s.memory_stats.usage - cache : null;
          return {
            cpuPercent: systemDelta > 0 && cpuDelta >= 0 ? (cpuDelta / systemDelta) * cpus * 100 : 0,
            memoryBytes,
          };
        } catch {
          return { cpuPercent: null, memoryBytes: null };
        }
      }),
    );
  }

  async shell(name: string, size: { cols: number; rows: number }): Promise<ShellSession> {
    const exec = await this.#container(name).exec({
      Cmd: ['bash', '-l'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      User: 'node',
      WorkingDir: HOME,
      Env: ['TERM=xterm-256color', 'COLORTERM=truecolor'],
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    // One resize call at a time, in order: concurrent ones can land out of order and leave the old size.
    let resizing = Promise.resolve();
    const resize = (cols: number, rows: number) =>
      void (resizing = resizing.then(() => exec.resize({ w: cols, h: rows })).catch(() => undefined));
    resize(size.cols, size.rows);

    const exitFns: ((code: number | null) => void)[] = [];
    let exited = false;
    const finish = async () => {
      if (exited) return;
      exited = true;
      const code = await exec.inspect().then((i) => i.ExitCode, () => null);
      exitFns.forEach((fn) => fn(code));
    };
    stream.on('end', () => void finish());
    stream.on('close', () => void finish());
    stream.on('error', () => void finish());

    return {
      write: (data) => void stream.write(data),
      resize,
      close: () => stream.destroy(),
      onData: (fn) => void stream.on('data', fn),
      onExit: (fn) => void exitFns.push(fn),
    };
  }

  #container(name: string) {
    return this.#docker.getContainer(containerName(name));
  }

  #ensureImage(progress: (detail: string) => void) {
    this.#imageReady ??= this.#pullOrBuild(progress).finally(() => (this.#imageReady = undefined));
    return this.#imageReady;
  }

  async #pullOrBuild(progress: (detail: string) => void) {
    const missing = await this.#docker
      .getImage(this.image)
      .inspect()
      .then(() => false, (e) => (statusOf(e) === 404 ? true : Promise.reject(e)));
    if (!missing) return;

    // A bare tag (no registry or repo path) can only come from our own Dockerfile.
    const local = !this.image.includes('/');
    progress(local ? 'Building the workspace image (first time, a few minutes)' : `Pulling ${this.image}`);
    const stream = local
      ? await this.#docker.buildImage({ context: this.imageContext, src: ['Dockerfile'] }, { t: this.image })
      : await this.#docker.pull(this.image);

    await new Promise<void>((resolve, reject) =>
      this.#docker.modem.followProgress(
        stream,
        (err, events: { error?: string }[]) => {
          const failed = err ?? events.find((e) => e.error)?.error;
          if (failed) reject(new Error(`Image ${local ? 'build' : 'pull'} failed: ${failed}`));
          else resolve();
        },
        (e: { stream?: string; status?: string; progress?: string }) => {
          const step = e.stream?.match(/^Step \d+\/\d+/)?.[0];
          if (step) progress(`Building the workspace image: ${step.toLowerCase()}`);
          else if (e.status && !local) progress(`Pulling ${this.image}: ${e.status.toLowerCase()}`);
        },
      ),
    );
  }
}
