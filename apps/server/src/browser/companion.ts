import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { BrowserPoolContent } from '@portal/contracts';
import Docker from 'dockerode';
import { pack } from 'tar-stream';
import { chromeSeccompProfile } from './seccomp.js';
import { homeVolumeOf, legacyRuntimeName } from '../workspaces/identity.js';
import type { RuntimeNames } from '../workspaces/runtime.js';
import { companionOf, DOWNLOADS_DIR, HOME, LABELS, PROFILE_REL, sha256 } from './spec.js';
import { chromePolicy, containerConfig } from './policy.js';
import { HEADERS_DIR, HEADERS_FILE, headersFile, headersSpec, type ResolvedHeader } from './headers.js';

/**
 * Browser containers on one Docker daemon (browser & desktop PRD §10.1): one companion per workspace, in the
 * workspace's network namespace so CDP stays on its loopback, with the profile and `~/Downloads` mounted from
 * its home volume. The runtime is the record: what exists is read from Docker, and this class only makes it
 * match a plan. It never touches a container it didn't label, and a fault here never reaches the workspace.
 */

const MiB = 1024 * 1024;
const statusOf = (e: unknown) => (e as { statusCode?: number }).statusCode;
const ignore = (...codes: number[]) => (e: unknown) => {
  if (!codes.includes(statusOf(e) ?? 0)) throw e;
};

/** Everything that decides how a browser container is created. */
export interface CompanionPlan {
  workspace: string;
  poolId: string;
  content: BrowserPoolContent;
  /** Chrome's sandbox: `on`, or `off` (only where the pool allows it and the daemon can't run it). */
  sandbox: boolean;
  /** `host:port` pairs of the portal as the browser would reach it, so the policy can refuse them. */
  portalHosts: string[];
  /** The pool's request headers with their values (PRD §24), read at delivery; in memory only. */
  headers?: ResolvedHeader[];
}

export interface CompanionInfo {
  id: string;
  running: boolean;
  startedAt: string;
  /** The workspace container it shares a network namespace with. */
  netns: string | null;
  spec: string | null;
  pool: string | null;
  /** The portal that created it (a portal manages only its own). */
  portal: string | null;
  health: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A process in the browser container with its own stdin and stdout, for the live-view bridges. */
export interface ExecStream {
  write(data: Buffer | string): void;
  end(): void;
  close(): void;
  onData(fn: (data: Buffer) => void): void;
  onError(fn: (data: Buffer) => void): void;
  onExit(fn: (code: number | null) => void): void;
}

export class Companions {
  readonly #docker: Docker;
  #imageReady: Promise<void> | undefined;
  #sandbox: Promise<boolean> | undefined;

  constructor(
    readonly targetId: string,
    private readonly socket: string,
    private readonly image: string,
    private readonly imageContext: string,
    /** This portal's ID: labelled onto what it creates, and the only ID whose containers it manages. */
    private readonly portalId: () => string | null,
    /** The workspaces' stored runtime names (T-42): the container a browser joins, its home volume, and the browser's own name follow it. */
    private readonly names?: RuntimeNames,
  ) {
    this.#docker = new Docker({ socketPath: socket });
  }

  /**
   * The workspace's container as it has it on record (T-42), never recomputed from the name; the old form (`claudepilot-<name>`) only for a
   * workspace the portal has no record of yet, which is what such a workspace is called.
   */
  #runtimeName(workspace: string): string {
    return this.names?.runtimeNameOf(this.targetId, workspace) ?? legacyRuntimeName('docker', workspace);
  }

  get available() {
    return existsSync(this.socket);
  }

  /* ---------- What exists ---------- */

  async workspace(name: string): Promise<{ id: string; running: boolean; startedAt: string } | null> {
    try {
      const info = await this.#docker.getContainer(this.#runtimeName(name)).inspect();
      return { id: info.Id, running: !!info.State.Running, startedAt: info.State.StartedAt };
    } catch (e) {
      if (statusOf(e) === 404) return null;
      throw e;
    }
  }

  async inspect(workspace: string): Promise<CompanionInfo | null> {
    try {
      const info = await this.#docker.getContainer(companionOf(this.#runtimeName(workspace))).inspect();
      const labels = info.Config.Labels ?? {};
      if (labels[LABELS.browser] !== '1') return null; // not ours
      return {
        id: info.Id,
        running: !!info.State.Running,
        startedAt: info.State.StartedAt,
        netns: labels[LABELS.netns] ?? null,
        spec: labels[LABELS.spec] ?? null,
        pool: labels[LABELS.pool] ?? null,
        portal: labels[LABELS.portal] ?? null,
        health: info.State.Running ? 'running' : info.State.Status,
      };
    } catch (e) {
      if (statusOf(e) === 404) return null;
      throw e;
    }
  }

  /** The workspace names that have a browser container of this portal's here. */
  async list(): Promise<string[]> {
    const portal = this.portalId();
    if (!portal) return [];
    const containers = await this.#docker.listContainers({ all: true, filters: { label: [`${LABELS.browser}=1`, `${LABELS.portal}=${portal}`] } });
    return containers.map((c) => c.Labels[LABELS.workspace]).filter((n): n is string => !!n);
  }

  /** The Docker bridge's gateway: where a workspace reaches the portal (PRD §13 Network). */
  async gateway(): Promise<string | null> {
    try {
      const net = await this.#docker.getNetwork('bridge').inspect();
      return (net.IPAM?.Config ?? []).map((c: { Gateway?: string }) => c.Gateway).find((g: string | undefined) => !!g) ?? null;
    } catch {
      return null;
    }
  }

  /* ---------- The image and the sandbox probe ---------- */

  /** Builds the image on first use when the tag is a bare local one (like the workspace image). */
  ensureImage(progress: (detail: string) => void = () => undefined): Promise<void> {
    this.#imageReady ??= this.#pullOrBuild(progress).finally(() => (this.#imageReady = undefined));
    return this.#imageReady;
  }

  async #pullOrBuild(progress: (detail: string) => void) {
    const missing = await this.#docker
      .getImage(this.image)
      .inspect()
      .then(() => false, (e) => (statusOf(e) === 404 ? true : Promise.reject(e)));
    if (!missing) return;
    const local = !this.image.includes('/');
    progress(local ? 'Building the browser image (first time, several minutes)' : `Pulling ${this.image}`);
    const stream = local
      ? await this.#docker.buildImage({ context: this.imageContext, src: ['Dockerfile', 'cpb'] }, { t: this.image })
      : await this.#docker.pull(this.image);
    await new Promise<void>((resolve, reject) =>
      this.#docker.modem.followProgress(
        stream,
        (err, events: { error?: string }[]) => {
          const failed = err ?? events.find((e) => e.error)?.error;
          if (failed) reject(new Error(`Image ${local ? 'build' : 'pull'} failed: ${failed}`));
          else resolve();
        },
        (e: { stream?: string }) => {
          const step = e.stream?.match(/^Step \d+\/\d+/)?.[0];
          if (step) progress(`Building the browser image: ${step.toLowerCase()}`);
        },
      ),
    );
  }

  async imageId(): Promise<string | null> {
    try {
      return (await this.#docker.getImage(this.image).inspect()).Id;
    } catch (e) {
      if (statusOf(e) === 404) return null;
      throw e;
    }
  }

  /**
   * Whether Chromium's sandbox starts under the browser container's own security options on this daemon
   * (PRD §20 A4, a target probe): a throwaway container from the image, uid 1000, one dump of a blank page.
   * Asked once per portal run; a daemon or kernel without user namespaces answers no.
   */
  sandboxWorks(): Promise<boolean> {
    this.#sandbox ??= this.#probeSandbox().catch(() => false);
    return this.#sandbox;
  }

  async #probeSandbox(): Promise<boolean> {
    await this.ensureImage();
    const c = await this.#docker.createContainer({
      Image: this.image,
      name: `claudepilot-probe-${Date.now().toString(36)}.browser`,
      User: '1000',
      Entrypoint: ['chromium'],
      Cmd: ['--headless=new', '--disable-gpu', '--dump-dom', 'about:blank'],
      Labels: { [LABELS.browser]: 'probe' },
      HostConfig: { CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges', `seccomp=${chromeSeccompProfile()}`], AutoRemove: false, Memory: 1024 * MiB, ShmSize: 256 * MiB },
    });
    try {
      await c.start();
      const done = await Promise.race([c.wait(), new Promise<{ StatusCode: number }>((r) => setTimeout(() => r({ StatusCode: -1 }), 45_000))]);
      const logs = (await c.logs({ stdout: true, stderr: true })).toString('utf8');
      return done.StatusCode === 0 && /<html/i.test(logs) && !/No usable sandbox/i.test(logs);
    } finally {
      await c.remove({ force: true }).catch(() => undefined);
    }
  }

  /* ---------- Making it match a plan ---------- */

  /** The hash of everything the container is created from, so a changed pool or a new image recreates it. */
  async specHash(plan: CompanionPlan): Promise<string> {
    const config = containerConfig(plan.content, { sandbox: plan.sandbox });
    const policy = chromePolicy(plan.content, { portalHosts: plan.portalHosts });
    // Headers by name and value version (PRD §24): a changed or removed secret recreates the container, and no value is hashed.
    const headers = headersSpec(plan.headers ?? []);
    return sha256(JSON.stringify({ image: await this.imageId(), config, policy, resources: plan.content.resources, seccomp: sha256(chromeSeccompProfile()), ...(headers.length ? { headers } : {}) })).slice(0, 16);
  }

  /** `~/.claudepilot/browser/profile` and `~/Downloads` in the workspace's home volume, created before the container mounts them. */
  async prepareMounts(workspace: string): Promise<void> {
    const b = `${HOME}/.claudepilot/browser`;
    const r = await this.#exec(this.#runtimeName(workspace), ['sh', '-c', `mkdir -p -m 0700 "${b}" "${HOME}/${PROFILE_REL}" && chmod 0700 "${b}" "${HOME}/${PROFILE_REL}" && mkdir -p -m 0700 "${HOME}/Downloads"`], { user: 'node' });
    if (r.code !== 0) throw new Error(`Could not prepare the browser folders in the workspace: ${r.stderr.trim() || `exit ${r.code}`}`);
  }

  /** Creates the container (not started) with its files; the caller starts it. */
  async create(plan: CompanionPlan, netns: string, spec: string): Promise<void> {
    await this.ensureImage();
    const { content } = plan;
    const res = content.resources;
    const container = await this.#docker.createContainer({
      name: companionOf(this.#runtimeName(plan.workspace)),
      Image: this.image,
      Labels: {
        [LABELS.browser]: '1',
        [LABELS.workspace]: plan.workspace,
        [LABELS.netns]: netns,
        [LABELS.spec]: spec,
        [LABELS.pool]: plan.poolId,
        [LABELS.portal]: this.portalId() ?? '',
      },
      StopTimeout: 10,
      HostConfig: {
        // The workspace's loopback and nothing else: no published ports, hostname, DNS or extra hosts (PRD §10.1).
        NetworkMode: `container:${netns}`,
        Init: true,
        RestartPolicy: { Name: 'no' },
        // Only what the root init needs to start the supervisor and Chromium as other users (PRD §10.1, §13).
        CapDrop: ['ALL'],
        CapAdd: ['SETUID', 'SETGID'],
        SecurityOpt: ['no-new-privileges', `seccomp=${chromeSeccompProfile()}`],
        NanoCpus: Math.round(res.cpus * 1e9),
        Memory: res.memoryMb * MiB,
        MemorySwap: res.memoryMb * MiB,
        PidsLimit: res.pids,
        ShmSize: res.shmMb * MiB,
        Tmpfs: { '/run/cpb': 'rw,mode=0711,uid=1001,gid=1001,size=16m,nosuid,nodev' },
        Mounts: [
          { Type: 'volume', Source: homeVolumeOf(this.#runtimeName(plan.workspace)), Target: '/data/profile', VolumeOptions: { Subpath: PROFILE_REL } as never },
          { Type: 'volume', Source: homeVolumeOf(this.#runtimeName(plan.workspace)), Target: DOWNLOADS_DIR, VolumeOptions: { Subpath: 'Downloads' } as never },
        ],
      },
    });
    const files: { path: string; content: string; private?: boolean }[] = [
      { path: 'etc/cpb/config.json', content: `${JSON.stringify(containerConfig(content, { sandbox: plan.sandbox }), null, 2)}\n` },
      { path: 'etc/chromium/policies/managed/cpb.json', content: `${JSON.stringify(chromePolicy(content, { portalHosts: plan.portalHosts }), null, 2)}\n` },
    ];
    // The one file that holds values (PRD §24): root-only, in the container's own layer, never in the config, policy or a label.
    if (plan.headers?.length) files.push({ path: `${HEADERS_DIR.slice(1)}/${HEADERS_FILE}`, content: headersFile(plan.headers), private: true });
    await container.putArchive(await tarOf(files), { path: '/' });
  }

  async start(workspace: string) {
    await this.#docker.getContainer(companionOf(this.#runtimeName(workspace))).start().catch(ignore(304));
  }

  async stop(workspace: string) {
    await this.#docker.getContainer(companionOf(this.#runtimeName(workspace))).stop({ t: 10 }).catch(ignore(304, 404));
  }

  async restart(workspace: string) {
    await this.#docker.getContainer(companionOf(this.#runtimeName(workspace))).restart({ t: 10 });
  }

  /** Removes the container (it must be ours). */
  async remove(workspace: string) {
    if (!(await this.inspect(workspace))) return;
    await this.#docker.getContainer(companionOf(this.#runtimeName(workspace))).remove({ force: true, v: false }).catch(ignore(404));
  }

  /** Deletes the profile (live sign-ins) from the workspace's home volume, through the workspace itself. */
  async wipeProfile(workspace: string): Promise<boolean> {
    const state = await this.workspace(workspace);
    if (!state?.running) return false;
    // Contents, not the mount point; no following links.
    const r = await this.#exec(this.#runtimeName(workspace), ['sh', '-c', `find "${HOME}/${PROFILE_REL}" -mindepth 1 -delete 2>/dev/null; true`], { user: 'node' });
    return r.code === 0;
  }

  /* ---------- Running things in it ---------- */

  /** Runs `cmd` in the browser container as `user` (uid 1001 is the supervisor's: only it can reach the control socket). */
  async exec(workspace: string, cmd: string[], opts: { user?: string; stdin?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    return this.#exec(companionOf(this.#runtimeName(workspace)), cmd, { user: opts.user ?? '1001', stdin: opts.stdin, timeoutMs: opts.timeoutMs });
  }

  async #exec(container: string, cmd: string[], opts: { user: string; stdin?: string; timeoutMs?: number }): Promise<ExecResult> {
    const exec = await this.#docker.getContainer(container).exec({
      Cmd: cmd,
      User: opts.user,
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
    const ms = opts.timeoutMs ?? 20_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => (stream.destroy(), reject(new Error(`exec timed out after ${ms} ms`))), ms);
      const done = () => (clearTimeout(timer), resolve());
      stream.on('end', done);
      stream.on('close', done);
      stream.on('error', (e: Error) => (clearTimeout(timer), reject(e)));
      if (opts.stdin !== undefined) stream.end(opts.stdin);
    });
    let code = -1;
    for (let i = 0; i < 40; i++) {
      const info = await exec.inspect().catch(() => null);
      if (!info) break;
      if (!info.Running) {
        code = info.ExitCode ?? -1;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
  }

  /** A long-running process (the live-view bridges): bytes in and out, until either side closes. */
  async stream(workspace: string, cmd: string[], opts: { user?: string } = {}): Promise<ExecStream> {
    const exec = await this.#docker.getContainer(companionOf(this.#runtimeName(workspace))).exec({
      Cmd: cmd,
      User: opts.user ?? '1001',
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({ hijack: true, stdin: true });
    const out = new PassThrough();
    const err = new PassThrough();
    this.#docker.modem.demuxStream(stream, out, err);
    const exitFns: ((code: number | null) => void)[] = [];
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      void (async () => {
        let code: number | null = null;
        for (let i = 0; i < 40; i++) {
          const info = await exec.inspect().catch(() => null);
          if (!info) break;
          if (!info.Running) {
            code = info.ExitCode ?? null;
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        exitFns.forEach((fn) => fn(code));
      })();
    };
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
    return {
      write: (data) => void stream.write(data),
      end: () => void stream.end(),
      close: () => stream.destroy(),
      onData: (fn) => void out.on('data', fn),
      onError: (fn) => void err.on('data', fn),
      onExit: (fn) => void exitFns.push(fn),
    };
  }

  /** Docker events for workspace containers and browser containers, reconnecting when the stream drops. */
  watch(onEvent: (workspace: string, event: string, role: 'workspace' | 'browser') => void): () => void {
    let stopped = false;
    let current: NodeJS.ReadableStream | undefined;
    let since = Math.floor(Date.now() / 1000);
    const connect = () => {
      if (stopped) return;
      this.#docker.getEvents(
        { since, filters: { type: ['container'], event: ['start', 'die', 'destroy', 'restart'], label: ['claudepilot.managed=true', `${LABELS.browser}=1`] } },
        (err, stream) => {
          if (err || !stream) return void setTimeout(connect, 5000);
          current = stream;
          let buf = '';
          stream.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              try {
                const ev = JSON.parse(line) as { Action?: string; status?: string; time?: number; Actor?: { Attributes?: Record<string, string> } };
                if (ev.time) since = ev.time;
                const attrs = ev.Actor?.Attributes ?? {};
                const action = ev.Action ?? ev.status ?? '';
                if (attrs[LABELS.browser] === '1' && attrs[LABELS.workspace]) {
                  if (attrs[LABELS.portal] === this.portalId()) onEvent(attrs[LABELS.workspace]!, action, 'browser');
                }
                else if (attrs['claudepilot.managed'] === 'true' && attrs['claudepilot.workspace']) onEvent(attrs['claudepilot.workspace']!, action, 'workspace');
              } catch {
                // not an event line
              }
            }
          });
          const again = () => !stopped && setTimeout(connect, 5000);
          stream.on('end', again);
          stream.on('error', again);
        },
      );
    };
    connect();
    return () => {
      stopped = true;
      (current as { destroy?: () => void } | undefined)?.destroy?.();
    };
  }
}

/**
 * A tar archive of root-owned files (paths relative to `/`): config and policy are world-readable; a `private` file (the headers' values,
 * PRD §24) is 0400 in a 0700 folder, so only the root init reads it, never the agent's tools or Chromium's user.
 */
export async function tarOf(files: { path: string; content: string; private?: boolean }[]): Promise<Buffer> {
  const p = pack();
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (dirs.has(d)) continue;
      dirs.add(d);
      p.entry({ name: `${d}/`, type: 'directory', mode: f.private && i === parts.length - 1 ? 0o700 : 0o755, uid: 0, gid: 0, mtime: new Date() });
    }
    p.entry({ name: f.path, type: 'file', mode: 0o644, uid: 0, gid: 0, mtime: new Date() }, f.content);
  }
  p.finalize();
  const chunks: Buffer[] = [];
  for await (const c of p) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
