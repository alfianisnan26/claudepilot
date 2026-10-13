import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { AppError } from '@isnanme/core';
import { CLAUDE_LABELS, claudeImageRef, claudeVersionOfImageRef, isExactClaudeVersion, workspaceId, type Workspace, type WorkspaceStatus } from '@portal/contracts';
import Docker from 'dockerode';
import { extract } from 'tar-stream';
import { tarOf } from './tar.js';
import { PLAIN_NAME, plainName } from '../names.js';
import { homeVolumeOf, legacyRuntimeName } from './identity.js';
import { createdByAnotherPortal, HOME, LABEL, type CreateSpec, type DeliveryAccess, type ExecSession, type ImageAccess, type ImageInfo, type Runtime, type RuntimeNames, type ShellSession, type TarEntry, type ThrowawayAccess } from './runtime.js';

const LIMIT = { cpus: 'claudepilot.cpus', memoryMb: 'claudepilot.memory-mb' } as const;
/** Marks a throwaway container of the compatibility canary (never `claudepilot.managed`: it is not a workspace); its value is the portal's id. */
const CANARY_LABEL = 'claudepilot.canary';


/** Docker answers "already started/stopped" with 304 and "no such thing" with 404. */
const statusOf = (e: unknown) => (e as { statusCode?: number }).statusCode;
const ignore = (...codes: number[]) => (e: unknown) => {
  if (!codes.includes(statusOf(e) ?? 0)) throw e;
};

/**
 * An exec's exit code. The output stream can end a moment before Docker marks the exec finished, so
 * an immediate inspect may still say Running with no code: wait for it (2 s at most).
 */
async function exitCodeOf(exec: Docker.Exec): Promise<number | null> {
  for (let i = 0; i < 40; i++) {
    const info = await exec.inspect().catch(() => null);
    if (!info) return null;
    if (!info.Running) return info.ExitCode ?? null;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

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
  /** One image build or pull at a time per reference; concurrent creates (and a canary) share it. */
  readonly #imageReady = new Map<string, Promise<void>>();
  /** The repository the version tags live in (`claudepilot-workspace`), the configured image without its tag. */
  readonly #repo: string;
  readonly #canaryPrefix: string;

  constructor(
    opts: { id: string; label: string; socket: string },
    private readonly image: string,
    private readonly imageContext: string,
    /** This portal's id (the store's), labelled onto every container it creates. Null while unknown: nothing is labelled or skipped. */
    private readonly portal: () => string | null = () => null,
    /** A Docker client, for tests. */
    client?: Docker,
    extras: {
      /** The start of a canary container's name; scratch portals of the agents building this give their own so each cleans up only its own. */
      canaryPrefix?: string;
      /** A moving tag (`latest`) that follows the default pin's image after it is built: optional, off by default. */
      alias?: string;
      /**
       * A daemon reached through a Connect tunnel (targets-connect PRD §12.3): `reach` replaces the socket's existence check (it throws
       * when the node is offline), the image step only ever pulls by reference (nothing is built through a tunnel), and `where` is what
       * the target list shows (`lab-box (docker 28.1)`).
       */
      tunnel?: { reach: () => Promise<void>; where?: string };
    } = {},
  ) {
    this.target = { id: opts.id, label: opts.label, kind: 'docker' as const, where: extras.tunnel?.where ?? opts.socket };
    this.#tunnel = extras.tunnel;
    this.#socket = opts.socket;
    this.#docker = client ?? new Docker({ socketPath: opts.socket });
    this.#repo = repoOf(image);
    this.#canaryPrefix = extras.canaryPrefix ?? 'claudepilot-canary-';
    this.#alias = extras.alias;
    this.images = this.#imageAccess();
  }

  readonly #alias: string | undefined;
  readonly #tunnel: { reach: () => Promise<void>; where?: string } | undefined;
  #names: RuntimeNames | undefined;

  useNames(names: RuntimeNames) {
    this.#names = names;
  }

  /**
   * The container of workspace `name` (T-42): the runtime name it has on record, never recomputed from the name. Only a workspace the
   * portal has no record of yet is named the old way (`claudepilot-<name>`), which is what such a workspace is called. A name or a
   * stored runtime name that is not plain (`x/../../containers`, `x?force=true`) is refused before it can become part of a Docker Engine
   * URL (QA-029, QA-032).
   */
  #objectName(name: string): string {
    // The name itself first: with no registry the `?.` call would not evaluate its arguments, and the legacy name of "" is plain (QA-029).
    plainName(name);
    return plainName(this.#names?.runtimeNameOf(this.target.id, name) ?? legacyRuntimeName('docker', name));
  }

  async check() {
    if (this.#tunnel) await this.#tunnel.reach();
    else if (!existsSync(this.#socket)) throw new Error(`${this.#socket} not found`);
    await this.#docker.ping();
  }

  readonly delivery: DeliveryAccess = {
    state: async (name) => {
      try {
        const info = await this.#container(name).inspect();
        return { exists: true, running: !!info.State.Running, portal: info.Config?.Labels?.[LABEL.portal] ?? null };
      } catch (e) {
        if (statusOf(e) === 404) return { exists: false, running: false };
        throw e;
      }
    },

    run: (name, script, opts = {}) => this.#runIn(this.#container(name), script, opts),

    put: async (name, entries) => {
      await this.#container(name).putArchive(await tarOf(entries), { path: '/' });
    },

    read: (name, path) => this.#readFrom(this.#container(name), path),

    watchStarts: (onStart) => this.#watchEvents(['start'], onStart),
  };

  /** `sh -c script` in a container, as root or the workspace user, with stdin and a timeout; the DeliveryAccess.run of a workspace and of a throwaway. */
  async #runIn(container: Docker.Container, script: string, opts: { user?: 'root' | 'node'; stdin?: string; timeoutMs?: number } = {}) {
    const exec = await container.exec({
      Cmd: ['sh', '-c', script],
      User: opts.user === 'node' ? 'node' : '0',
      AttachStdin: opts.stdin !== undefined,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({ hijack: true, stdin: opts.stdin !== undefined });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const stdout = new PassThrough().on('data', (c: Buffer) => out.push(c));
    const stderr = new PassThrough().on('data', (c: Buffer) => err.push(c));
    this.#docker.modem.demuxStream(stream, stdout, stderr);
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stream.destroy();
        reject(new Error(`exec timed out after ${opts.timeoutMs ?? 30_000} ms`));
      }, opts.timeoutMs ?? 30_000);
      stream.on('end', () => (clearTimeout(timer), resolve()));
      stream.on('close', () => (clearTimeout(timer), resolve()));
      stream.on('error', (e: Error) => (clearTimeout(timer), reject(e)));
    });
    if (opts.stdin !== undefined) stream.end(opts.stdin);
    await done;
    const code = await exitCodeOf(exec);
    return { code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
  }

  /** One file from a container as text; null when it is not there. */
  async #readFrom(container: Docker.Container, path: string): Promise<string | null> {
    let stream: NodeJS.ReadableStream;
    try {
      stream = await container.getArchive({ path });
    } catch (e) {
      if (statusOf(e) === 404) return null;
      throw e;
    }
    return firstFileOf(stream);
  }

  async exec(name: string, command: string[]): Promise<ExecSession> {
    return this.#execIn(this.#container(name), command);
  }

  /** A command with stdin open and no terminal, as the workspace user; the exec of a workspace and of a throwaway. */
  async #execIn(container: Docker.Container, command: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): Promise<ExecSession> {
    const exec = await container.exec({
      Cmd: command,
      User: 'node',
      WorkingDir: opts.cwd ?? HOME,
      Env: [`HOME=${HOME}`, ...Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`)],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({ hijack: true, stdin: true });
    const out = new PassThrough();
    this.#docker.modem.demuxStream(stream, out, out);
    const exitFns: ((code: number | null) => void)[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      void exitCodeOf(exec).then((code) => exitFns.forEach((fn) => fn(code)));
    };
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
    return {
      write: (data) => void stream.write(data),
      close: () => stream.destroy(),
      onData: (fn) => void out.on('data', fn),
      onExit: (fn) => void exitFns.push(fn),
    };
  }

  /** Container changes that show in the list (started, stopped, died, created, removed). */
  watch(onChange: () => void): () => void {
    return this.#watchEvents(['create', 'start', 'stop', 'die', 'destroy', 'pause', 'unpause', 'restart', 'rename'], () => onChange());
  }

  /** Follows Docker's event stream for the portal's containers, reconnecting when it drops. */
  #watchEvents(events: string[], onEvent: (name: string) => void): () => void {
    let stopped = false;
    let current: NodeJS.ReadableStream | undefined;
    const connect = () => {
      if (stopped) return;
      this.#docker.getEvents({ filters: { type: ['container'], event: events, label: [`${LABEL.managed}=true`] } }, (err, stream) => {
        if (err || !stream) return void setTimeout(connect, 5000);
        current = stream;
        let buf = '';
        stream.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            try {
              const attributes = (JSON.parse(line) as { Actor?: { Attributes?: Record<string, string> } }).Actor?.Attributes;
              const name = attributes?.[LABEL.name];
              // Another portal's workspace (it carries that portal's id) is none of this portal's business.
              if (name && !createdByAnotherPortal(attributes, this.portal())) onEvent(name);
            } catch {
              // not an event line
            }
          }
        });
        const again = () => !stopped && setTimeout(connect, 5000);
        stream.on('end', again);
        stream.on('error', again);
      });
    };
    connect();
    return () => {
      stopped = true;
      (current as { destroy?: () => void } | undefined)?.destroy?.();
    };
  }

  async list(): Promise<Workspace[]> {
    const containers = await this.#docker.listContainers({
      all: true,
      filters: { label: [`${LABEL.managed}=true`] },
    });
    const mine = this.portal();
    return containers.filter((c) => !createdByAnotherPortal(c.Labels, mine)).map((c) => {
      const name = c.Labels[LABEL.name] ?? c.Names[0]?.replace(/^\/claudepilot-/, '') ?? c.Id;
      // What the container is called, as Docker says: the runtime name the manager records for a workspace it has no record of (T-42).
      const runtimeName = c.Names[0]?.replace(/^\//, '');
      const cpus = Number(c.Labels[LIMIT.cpus]) || undefined;
      const memoryMb = Number(c.Labels[LIMIT.memoryMb]) || undefined;
      return {
        id: workspaceId(this.target.id, name),
        name,
        ...(runtimeName ? { runtimeName } : {}),
        target: this.target.id,
        image: c.Image,
        status: STATUS[c.State] ?? 'error',
        detail: c.Status,
        createdAt: new Date(c.Created * 1000).toISOString(),
        cpus,
        memoryMb,
        // What its image was built with; `running` and the flags are the version module's (workspaceView fills them in).
        claude: { pinned: c.Labels[CLAUDE_LABELS.version] ?? null, running: null, flags: [] },
      };
    });
  }

  async create(spec: CreateSpec, progress: (detail: string) => void) {
    // The manager gives a new workspace its runtime name (`ws-<12 hex>`); a direct call without one uses what is on record.
    const runtimeName = spec.runtimeName ? plainName(spec.runtimeName) : this.#objectName(spec.name);
    const existing = await this.#docker.listContainers({
      all: true,
      filters: { name: [`^/${runtimeName}$`] },
    });
    if (existing.length) throw new AppError('CONFLICT', `A workspace named “${spec.name}” already exists here.`);

    const image = spec.claudeVersion ? this.#refFor(spec.claudeVersion) : this.image;
    await this.#ensureImage(image, progress);
    progress('Creating container');
    const container = await this.#docker.createContainer(await this.#spec(spec.name, runtimeName, { cpus: spec.cpus, memoryMb: spec.memoryMb, portal: this.portal() }, image));
    progress('Starting');
    await container.start();
  }

  /**
   * What a workspace's container is made of, in one place so `create` and `recreate` cannot drift: a recreate is the same container
   * (name, limits, home volume, labels) on another image. `labelRef` is the reference the image label records (the id of the old
   * image when a recreate puts the old container back). `runtimeName` names the container and its home volume (T-42).
   */
  async #spec(name: string, runtimeName: string, o: { cpus?: number; memoryMb?: number; portal: string | null }, image: string, labelRef = image): Promise<Docker.ContainerCreateOptions> {
    const version = (await this.#inspectImage(image).catch(() => null))?.version ?? null;
    return {
      name: runtimeName,
      Image: image,
      Hostname: name,
      User: 'node',
      WorkingDir: HOME,
      Labels: {
        [LABEL.managed]: 'true',
        [LABEL.name]: name,
        ...(o.portal ? { [LABEL.portal]: o.portal } : {}),
        ...(o.cpus ? { [LIMIT.cpus]: String(o.cpus) } : {}),
        ...(o.memoryMb ? { [LIMIT.memoryMb]: String(o.memoryMb) } : {}),
        [CLAUDE_LABELS.image]: labelRef,
        ...(version ? { [CLAUDE_LABELS.version]: version } : {}),
      },
      Env: ['TERM=xterm-256color'],
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        // A fresh named volume is seeded with the image's home (dotfiles, ~/work); an existing one keeps what it holds.
        Mounts: [{ Type: 'volume', Source: homeVolumeOf(runtimeName), Target: HOME }],
        NanoCpus: o.cpus ? Math.round(o.cpus * 1e9) : undefined,
        Memory: o.memoryMb ? o.memoryMb * 1024 * 1024 : undefined,
      },
    };
  }

  // async: a refused name rejects like any other failure instead of throwing before there is a promise.
  start = async (name: string) => this.#container(name).start().catch(ignore(304));
  stop = async (name: string) => this.#container(name).stop({ t: 5 }).catch(ignore(304));

  async remove(name: string) {
    const runtimeName = this.#objectName(name);
    await this.#docker.getContainer(runtimeName).remove({ force: true }).catch(ignore(404));
    await this.#docker.getVolume(homeVolumeOf(runtimeName)).remove().catch(ignore(404));
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
            cores: cpus,
            memoryTotalBytes: s.memory_stats.limit || null,
          };
        } catch {
          return { cpuPercent: null, memoryBytes: null };
        }
      }),
    );
  }

  async shell(name: string, size: { cols: number; rows: number }, command?: string[]): Promise<ShellSession> {
    return this.#shellIn(this.#container(name), size, command ?? ['bash', '-l']);
  }

  /** A terminal as the workspace user; the shell of a workspace and of a throwaway. */
  async #shellIn(container: Docker.Container, size: { cols: number; rows: number }, command: string[], env: Record<string, string> = {}): Promise<ShellSession> {
    const exec = await container.exec({
      Cmd: command,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      User: 'node',
      WorkingDir: HOME,
      Env: ['TERM=xterm-256color', 'COLORTERM=truecolor', ...Object.entries(env).map(([k, v]) => `${k}=${v}`)],
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
      const code = await exitCodeOf(exec);
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
    return this.#docker.getContainer(this.#objectName(name));
  }

  /* ---------- Images and recreation (docs/prd/claude-version-pinning.md) ---------- */

  /** One tag per exact Claude Code version, in the configured repository. */
  readonly images: ImageAccess;

  #imageAccess(): ImageAccess {
    return {
      refFor: (version) => this.#refFor(version),
      defaultRef: this.image,
      inspect: (ref) => this.#inspectImage(ref),
      ensure: async (version, progress) => {
        const ref = this.#refFor(version);
        await this.#ensureImage(ref, progress);
        return ref;
      },
      list: async () => {
        const found = await this.#docker.listImages({ filters: { reference: [`${this.#repo}:*`] } });
        const out: ImageInfo[] = [];
        for (const i of found)
          for (const ref of i.RepoTags ?? [])
            if (ref.startsWith(`${this.#repo}:`))
              out.push({ ref, id: i.Id, version: i.Labels?.[CLAUDE_LABELS.version] ?? null, builtAt: new Date(i.Created * 1000).toISOString(), sizeBytes: i.Size ?? null });
        return out;
      },
      remove: async (ref) => {
        try {
          await this.#docker.getImage(ref).remove({ force: false });
        } catch (e) {
          if (statusOf(e) === 404) return;
          if (statusOf(e) === 409) throw new AppError('CONFLICT', `${ref} is in use by a container.`);
          throw e;
        }
      },
    };
  }

  #refFor(version: string): string {
    if (!isExactClaudeVersion(version)) throw new AppError('VALIDATION_FAILED', 'Use an exact version such as 2.1.296.', { details: { version: 'An exact x.y.z.' } });
    return claudeImageRef(version, this.#repo);
  }

  async #inspectImage(ref: string): Promise<ImageInfo | null> {
    try {
      const i = await this.#docker.getImage(ref).inspect();
      return { ref, id: i.Id, version: i.Config?.Labels?.[CLAUDE_LABELS.version] ?? null, builtAt: i.Created ?? null, sizeBytes: i.Size ?? null };
    } catch (e) {
      if (statusOf(e) === 404) return null;
      throw e;
    }
  }

  async imageOf(name: string): Promise<{ ref: string | null; version: string | null; id: string | null } | null> {
    try {
      const info = await this.#container(name).inspect();
      const labels = info.Config?.Labels ?? {};
      return { ref: labels[CLAUDE_LABELS.image] ?? info.Config?.Image ?? null, version: labels[CLAUDE_LABELS.version] ?? null, id: info.Image ?? null };
    } catch (e) {
      if (statusOf(e) === 404) return null;
      throw e;
    }
  }

  async recreate(name: string, image: string, progress: (detail: string) => void, opts: { label?: string } = {}) {
    // The same container name and home volume as before: the runtime name on record (T-42).
    const runtimeName = this.#objectName(name);
    const container = this.#docker.getContainer(runtimeName);
    const info = await container.inspect();
    const labels = info.Config?.Labels ?? {};
    if (labels[LABEL.managed] !== 'true') throw new AppError('CONFLICT', 'That is not one of this portal’s workspaces.');
    if (createdByAnotherPortal(labels, this.portal())) throw new AppError('CONFLICT', 'Another portal created this workspace.');
    // Only a workspace whose home is its own named volume is recreated: a home that is anything else could be lost with the container.
    const home = (info.Mounts ?? []).find((m) => m.Destination === HOME);
    if (home?.Type !== 'volume' || home.Name !== homeVolumeOf(runtimeName)) throw new AppError('CONFLICT', 'This workspace’s home folder is not a volume of its own, so it cannot be recreated without risk.');
    if (!(await this.#inspectImage(image))) throw new AppError('CONFLICT', `The image ${image} is not on this target yet.`);
    const was = labels[CLAUDE_LABELS.image] ?? info.Config?.Image ?? null;
    const limits = { cpus: Number(labels[LIMIT.cpus]) || undefined, memoryMb: Number(labels[LIMIT.memoryMb]) || undefined, portal: labels[LABEL.portal] ?? null };
    const running = !!info.State?.Running;
    const make = async (ref: string, labelRef: string) => {
      const c = await this.#docker.createContainer(await this.#spec(name, runtimeName, limits, ref, labelRef));
      if (running) {
        await c.start();
        if (!(await c.inspect()).State?.Running) throw new Error('the container stopped right after it started');
      }
    };

    progress('Stopping');
    if (running) await container.stop({ t: 10 }).catch(ignore(304));
    progress('Replacing the container');
    await container.remove({ v: false }).catch(ignore(404));
    try {
      await make(image, opts.label ?? image);
    } catch (e) {
      const why = runtimeText(e);
      progress('Putting the previous container back');
      await this.#docker.getContainer(runtimeName).remove({ force: true, v: false }).catch(ignore(404));
      // From the image the old container ran, by id: its tag may have moved since.
      try {
        await make(info.Image, was ?? info.Image);
      } catch (back) {
        throw new AppError('SERVICE_UNAVAILABLE', `Could not start ${image} (${why}), and the previous container could not be put back (${runtimeText(back)}). The home volume is untouched: start the workspace again, or recreate it.`);
      }
      throw new AppError('SERVICE_UNAVAILABLE', `Could not start ${image}: ${why}. The workspace is back on ${was ?? 'its previous image'}.`);
    }
    return { from: was, to: image };
  }

  /* ---------- Throwaway containers for the canary ---------- */

  /** The container of a throwaway, only for a name this portal's canary prefix made: the exec and read helpers never reach a workspace through it. */
  #canary(name: string): Docker.Container {
    if (!name.startsWith(this.#canaryPrefix) || !PLAIN_NAME.test(name)) throw new AppError('NOT_FOUND', 'That is not a canary container.');
    return this.#docker.getContainer(name);
  }

  readonly throwaway: ThrowawayAccess = {
    start: async (spec) => {
      const name = `${this.#canaryPrefix}${randomBytes(4).toString('hex')}`;
      if (!PLAIN_NAME.test(name)) throw new AppError('VALIDATION_FAILED', 'The canary container prefix makes a name Docker would refuse.');
      const c = await this.#docker.createContainer({
        name,
        Image: spec.image,
        Hostname: 'canary',
        User: 'node',
        WorkingDir: HOME,
        Labels: { [CANARY_LABEL]: this.portal() ?? 'unknown', [CLAUDE_LABELS.image]: spec.image },
        Env: ['TERM=xterm-256color'],
        HostConfig: {
          NetworkMode: spec.network,
          RestartPolicy: { Name: 'no' },
          NanoCpus: spec.cpus ? Math.round(spec.cpus * 1e9) : undefined,
          Memory: spec.memoryMb ? spec.memoryMb * 1024 * 1024 : undefined,
        },
      });
      try {
        await c.start();
      } catch (e) {
        await c.remove({ force: true, v: true }).catch(() => undefined);
        throw e;
      }
      return { name };
    },
    run: async (name, script, opts = {}) => this.#runIn(this.#canary(name), script, opts),
    put: async (name, entries) => {
      await this.#canary(name).putArchive(await tarOf(entries), { path: '/' });
    },
    read: async (name, path) => this.#readFrom(this.#canary(name), path),
    exec: async (name, command, opts) => this.#execIn(this.#canary(name), command, opts),
    shell: async (name, size, command, opts) => this.#shellIn(this.#canary(name), size, command, opts?.env),
    isolate: async (name) => {
      const info = await this.#canary(name).inspect();
      for (const net of Object.keys(info.NetworkSettings?.Networks ?? {})) await this.#docker.getNetwork(net).disconnect({ Container: info.Id, Force: true }).catch(() => undefined);
    },
    remove: async (name) => {
      await this.#canary(name).remove({ force: true, v: true }).catch(ignore(404));
    },
    leftovers: async () => {
      const found = await this.#docker.listContainers({ all: true, filters: { label: [CANARY_LABEL] } });
      const mine = this.portal() ?? 'unknown';
      return found
        .filter((c) => c.Labels[CANARY_LABEL] === mine)
        .flatMap((c) => c.Names.map((n) => n.replace(/^\//, '')))
        .filter((n) => n.startsWith(this.#canaryPrefix))
        .map((name) => ({ name }));
    },
  };

  /* ---------- The image itself ---------- */

  #buildQueue: Promise<void> = Promise.resolve();

  #ensureImage(ref: string, progress: (detail: string) => void): Promise<void> {
    let ready = this.#imageReady.get(ref);
    if (!ready) {
      // One build at a time per daemon: a canary building version B waits for the default's build rather than racing it.
      ready = this.#buildQueue.then(() => this.#pullOrBuild(ref, progress)).finally(() => this.#imageReady.delete(ref));
      this.#buildQueue = ready.catch(() => undefined);
      this.#imageReady.set(ref, ready);
    }
    return ready;
  }

  async #pullOrBuild(ref: string, progress: (detail: string) => void) {
    const missing = await this.#docker
      .getImage(ref)
      .inspect()
      .then(() => false, (e) => (statusOf(e) === 404 ? true : Promise.reject(e)));
    if (missing) {
      // A bare tag (no registry or repo path) can only come from our own Dockerfile.
      const local = !ref.includes('/') && !this.#tunnel;
      // Through a tunnel the image is only ever pulled (the installer put it there; targets-connect PRD §12.10): a bare tag has nowhere to come from.
      if (this.#tunnel && !ref.includes('/'))
        throw new Error(`The image ${ref} is not on this host. Re-run the install command there with PILOT_BUILD_IMAGE=1, or docker pull it.`);
      const version = claudeVersionOfImageRef(ref);
      progress(local ? `Building the workspace image${version ? ` with Claude Code ${version}` : ''} (a few minutes)` : `Pulling ${ref}`);
      // The version tag names the version the image installs: it goes in as the build argument, so the tag cannot lie.
      const stream = local
        ? await this.#docker.buildImage({ context: this.imageContext, src: ['Dockerfile', 'cp-session'] }, { t: ref, ...(version ? { buildargs: { CLAUDE_CODE_VERSION: version } } : {}) })
        : await this.#docker.pull(ref);

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
            else if (e.status && !local) progress(`Pulling ${ref}: ${e.status.toLowerCase()}`);
          },
        ),
      );
      // The label is the build's own statement of what it installed: a tag that disagrees with it is refused.
      const built = await this.#inspectImage(ref);
      if (version && built?.version !== version) throw new Error(`Image ${ref} says it has Claude Code ${built?.version ?? 'unknown'}, not ${version}.`);
    }
    if (this.#alias && ref === this.image) await this.#docker.getImage(ref).tag({ repo: this.#repo, tag: this.#alias }).catch(() => undefined);
  }
}

/**
 * The first regular file in a tar stream, as text. The response is destroyed once the file is read: left undrained (the archive's
 * padding and end blocks unread) it would hold its connection, and through a tunnel its stream, open for good.
 */
export async function firstFileOf(stream: NodeJS.ReadableStream): Promise<string | null> {
  const ex = extract();
  stream.pipe(ex as unknown as NodeJS.WritableStream);
  try {
    for await (const entry of ex) {
      if (entry.header.type === 'file') {
        const chunks: Buffer[] = [];
        for await (const c of entry) chunks.push(c as Buffer);
        return Buffer.concat(chunks).toString('utf8');
      }
      entry.resume();
    }
    return null;
  } finally {
    stream.unpipe?.(ex as unknown as NodeJS.WritableStream);
    (stream as { destroy?: () => void }).destroy?.();
    ex.destroy();
  }
}

/** The repository of an image reference: everything before a trailing `:tag` (a registry's `host:5000/` port is not a tag). */
export function repoOf(ref: string): string {
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  return colon > slash ? ref.slice(0, colon) : ref;
}

/** The readable part of a Docker error. */
function runtimeText(e: unknown): string {
  const err = e as { json?: { message?: string }; message?: string };
  return err.json?.message ?? err.message ?? String(e);
}
