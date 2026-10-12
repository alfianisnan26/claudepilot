// A recording fake Docker daemon on a unix socket (docs/prd/targets-connect.md §19.3 T-POL; T3 and T6 use it too). It speaks the part of
// the Engine API that `DockerRuntime` and the policy proxy use, keeps containers, volumes, images and execs in memory, and records every
// request it receives (`requests`), so a test can assert what the daemon saw and, above all, what it never saw.
//
// Not a faithful daemon: exec output is scripted (`onExec`), a terminal echoes its input, an archive is a map of files. It is faithful
// where the policy depends on it: names, labels, ids (64 hex), 404s, 304s and 409s, `filters`, the 101 upgrade of an exec start with
// docker's multiplexed stream, and `events` that honour their label filters.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { extract, pack } from 'tar-stream';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  /** The body, unless it was large: an upload over 8 MiB is counted and thrown away (`bodyBytes`), so a test can push 100 MB through. */
  body: Buffer;
  bodyBytes: number;
}

export interface FakeContainer {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  env: string[];
  user: string;
  state: 'created' | 'running' | 'exited' | 'paused';
  createdAt: number;
  hostConfig: Record<string, unknown>;
  config: Record<string, unknown>;
  files: Map<string, { content: Buffer; mode: number; uid: number; gid: number; /** A file of this many bytes that exists only as a stream (a download test). */ virtual?: number }>;
}

export interface FakeExec {
  id: string;
  container: string;
  cmd: string[];
  user: string;
  env: string[];
  tty: boolean;
  attachStdin: boolean;
  running: boolean;
  exitCode: number | null;
  resizes: { w: number; h: number }[];
}

export interface ExecResult {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  exitCode?: number;
}

export type ExecScript = (cmd: string[], info: { container: FakeContainer; exec: FakeExec; stdin: Buffer }) => ExecResult | Promise<ExecResult>;

/** An interactive exec: stdin arrives as the client writes it, output goes out as the script writes it. */
export interface ExecIo {
  container: FakeContainer;
  exec: FakeExec;
  onStdin(fn: (data: Buffer) => void): void;
  onStdinEnd(fn: () => void): void;
  write(stream: 1 | 2, data: string | Buffer): void;
  exit(code: number): void;
}

const hex64 = () => randomBytes(32).toString('hex');

/** Docker's multiplexed stream frame: stream (1 stdout, 2 stderr), three zero bytes, the length (BE), the bytes. */
export function muxFrame(stream: 1 | 2, payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

interface EventListener {
  filters: { type: string[]; label: string[]; event: string[] };
  write(line: string): void;
  close(): void;
}

export class FakeDocker {
  readonly socketPath: string;
  readonly requests: RecordedRequest[] = [];
  readonly containers = new Map<string, FakeContainer>();
  readonly volumes = new Set<string>();
  readonly images: Set<string>;
  readonly execs = new Map<string, FakeExec>();
  /** Scripts what a command prints once its stdin has ended. Default: nothing, exit 0. */
  onExec: ExecScript = () => ({ exitCode: 0 });
  /** When set, a hijacked exec without a terminal is interactive and this drives it instead of `onExec`. */
  onExecStream: ((cmd: string[], io: ExecIo) => void) | null = null;
  /** What `GET /info` says; tests may change it. */
  info: Record<string, unknown> = {
    ID: 'FAKE:DOCKER:ENGINE', Containers: 0, ContainersRunning: 0, NCPU: 4, MemTotal: 8 * 1024 ** 3, ServerVersion: '27.3.1', OperatingSystem: 'Fake Linux',
    OSType: 'linux', Architecture: 'x86_64', Name: 'fake-docker', Swarm: { LocalNodeState: 'inactive', NodeID: '' },
  };
  #server: http.Server;
  #dir: string | null;
  readonly #sockets = new Set<Duplex>();
  readonly #listeners = new Set<EventListener>();

  private constructor(socketPath: string, dir: string | null, images: string[]) {
    this.socketPath = socketPath;
    this.#dir = dir;
    this.images = new Set(images);
    this.#server = http.createServer((req, res) => void this.#handle(req, res));
    this.#server.on('upgrade', (req, socket, head) => void this.#upgrade(req, socket as Duplex, head));
    this.#server.on('connection', (s) => {
      this.#sockets.add(s);
      s.on('close', () => this.#sockets.delete(s));
    });
  }

  static async start(opts: { socketPath?: string; images?: string[] } = {}): Promise<FakeDocker> {
    const dir = opts.socketPath ? null : mkdtempSync(join(tmpdir(), 'cx2-fakedocker-'));
    const socketPath = opts.socketPath ?? join(dir!, 'docker.sock');
    if (dir) mkdirSync(dir, { recursive: true });
    const fake = new FakeDocker(socketPath, dir, opts.images ?? ['claudepilot-workspace:latest']);
    await new Promise<void>((resolve, reject) => {
      fake.#server.once('error', reject);
      fake.#server.listen(socketPath, resolve);
    });
    return fake;
  }

  async stop(): Promise<void> {
    for (const l of this.#listeners) l.close();
    this.#listeners.clear();
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    if (this.#dir) rmSync(this.#dir, { recursive: true, force: true });
  }

  /** Requests whose method and path (without the version prefix) match. */
  seen(method: string, path: RegExp | string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && (typeof path === 'string' ? r.url.split('?')[0]!.replace(/^\/v\d+\.\d+/, '') === path : path.test(r.url.replace(/^\/v\d+\.\d+/, ''))));
  }

  addContainer(c: { name: string; image?: string; labels?: Record<string, string>; running?: boolean }): FakeContainer {
    const container: FakeContainer = {
      id: hex64(), name: c.name, image: c.image ?? 'claudepilot-workspace:latest', labels: c.labels ?? {}, env: [], user: '', state: c.running === false ? 'created' : 'running',
      createdAt: Date.now(), hostConfig: {}, config: {}, files: new Map(),
    };
    this.containers.set(container.id, container);
    return container;
  }

  /** Emits a container event to listeners whose filters match. */
  emit(action: string, c: FakeContainer): void {
    const line = `${JSON.stringify({ Type: 'container', Action: action, Actor: { ID: c.id, Attributes: { name: c.name, image: c.image, ...c.labels } }, time: Math.floor(Date.now() / 1000), scope: 'local' })}\n`;
    for (const l of this.#listeners) {
      if (l.filters.type.length && !l.filters.type.includes('container')) continue;
      if (l.filters.event.length && !l.filters.event.includes(action)) continue;
      if (!matchesLabels(c.labels, l.filters.label)) continue;
      l.write(line);
    }
  }

  /* ------------------------------------------------------------------------------------------------------------------------ */

  #find(ref: string): FakeContainer | undefined {
    for (const c of this.containers.values()) if (c.id === ref || c.name === ref || (ref.length >= 4 && c.id.startsWith(ref))) return c;
    return undefined;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const big = Number(req.headers['content-length'] ?? 0) > 8 * 1024 * 1024;
    const body = big ? Buffer.alloc(0) : await readAll(req);
    let bodyBytes = body.length;
    if (big) for await (const c of req) bodyBytes += (c as Buffer).length;
    this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, bodyBytes });
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname.replace(/^\/v\d+\.\d+/, '');
    const q = url.searchParams;
    const method = req.method ?? 'GET';
    const json = (status: number, value: unknown) => {
      const text = JSON.stringify(value);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Api-Version': '1.46', 'Docker-Experimental': 'false', Ostype: 'linux' });
      res.end(text);
    };
    const message = (status: number, text: string) => json(status, { message: text });
    const empty = (status: number) => {
      res.writeHead(status, { 'Content-Length': 0 });
      res.end();
    };
    let m: RegExpExecArray | null;

    if (path === '/_ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 2, 'Api-Version': '1.46', Ostype: 'linux' });
      return void res.end(method === 'HEAD' ? undefined : 'OK');
    }
    if (path === '/version' && method === 'GET') return json(200, { Version: this.info.ServerVersion, ApiVersion: '1.46', MinAPIVersion: '1.24', Os: 'linux', Arch: 'amd64' });
    if (path === '/info' && method === 'GET') {
      const all = [...this.containers.values()];
      return json(200, { ...this.info, Containers: all.length, ContainersRunning: all.filter((c) => c.state === 'running').length });
    }

    if (path === '/events' && method === 'GET') {
      let filters: Record<string, string[] | Record<string, boolean>> = {};
      try {
        filters = JSON.parse(q.get('filters') ?? '{}') as typeof filters;
      } catch {
        // none
      }
      const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : v && typeof v === 'object' ? Object.keys(v) : []);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
      res.flushHeaders();
      const listener: EventListener = {
        filters: { type: list(filters.type), label: list(filters.label), event: list(filters.event) },
        write: (line) => void res.write(line),
        close: () => res.end(),
      };
      this.#listeners.add(listener);
      res.on('close', () => this.#listeners.delete(listener));
      return;
    }

    if (path === '/containers/json' && method === 'GET') {
      let filters: Record<string, string[]> = {};
      try {
        filters = JSON.parse(q.get('filters') ?? '{}') as typeof filters;
      } catch {
        // none
      }
      const all = q.get('all') === 'true' || q.get('all') === '1';
      const list = [...this.containers.values()]
        .filter((c) => all || c.state === 'running')
        .filter((c) => matchesLabels(c.labels, filters.label ?? []))
        .filter((c) => !filters.name?.length || filters.name.some((n) => new RegExp(n).test(`/${c.name}`)))
        .filter((c) => !filters.status?.length || filters.status.includes(c.state))
        .map((c) => ({
          Id: c.id, Names: [`/${c.name}`], Image: c.image, ImageID: `sha256:${hex64()}`, Command: '', Created: Math.floor(c.createdAt / 1000), State: c.state,
          Status: c.state === 'running' ? 'Up 1 second' : 'Exited (0) 1 second ago', Labels: c.labels, Ports: [], Mounts: [],
        }));
      return json(200, list);
    }

    if (path === '/containers/create' && method === 'POST') {
      const name = q.get('name') ?? `fake_${randomBytes(3).toString('hex')}`;
      let cfg: Record<string, unknown>;
      try {
        cfg = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      } catch {
        return message(400, 'invalid JSON');
      }
      const image = String(cfg.Image ?? '');
      if (!this.images.has(image) && !this.images.has(`${image}:latest`)) return message(404, `No such image: ${image}`);
      if ([...this.containers.values()].some((c) => c.name === name)) return message(409, `Conflict. The container name "/${name}" is already in use by container "${hex64()}". You have to remove (or rename) that container to be able to reuse that name.`);
      const c = this.addContainer({ name, image, labels: (cfg.Labels as Record<string, string>) ?? {}, running: false });
      c.env = (cfg.Env as string[]) ?? [];
      c.user = String(cfg.User ?? '');
      c.hostConfig = (cfg.HostConfig as Record<string, unknown>) ?? {};
      c.config = cfg;
      this.emit('create', c);
      return json(201, { Id: c.id, Warnings: [] });
    }

    if ((m = /^\/containers\/([^/]+)\/json$/.exec(path)) && method === 'GET') {
      const c = this.#find(m[1]!);
      if (!c) return message(404, `No such container: ${m[1]}`);
      return json(200, {
        Id: c.id, Name: `/${c.name}`, Created: new Date(c.createdAt).toISOString(), Image: `sha256:${hex64()}`,
        State: { Status: c.state, Running: c.state === 'running', Paused: c.state === 'paused', ExitCode: 0 },
        Config: { Image: c.image, Labels: c.labels, Env: c.env, User: c.user }, HostConfig: c.hostConfig,
      });
    }

    if ((m = /^\/containers\/([^/]+)\/(start|stop|restart|pause|unpause|kill|wait)$/.exec(path)) && method === 'POST') {
      const c = this.#find(m[1]!);
      if (!c) return message(404, `No such container: ${m[1]}`);
      switch (m[2]) {
        case 'start':
          if (c.state === 'running') return empty(304);
          c.state = 'running';
          this.emit('start', c);
          return empty(204);
        case 'stop':
          if (c.state !== 'running') return empty(304);
          c.state = 'exited';
          this.emit('die', c);
          this.emit('stop', c);
          return empty(204);
        case 'restart':
          c.state = 'running';
          this.emit('restart', c);
          return empty(204);
        case 'pause':
          c.state = 'paused';
          this.emit('pause', c);
          return empty(204);
        case 'unpause':
          c.state = 'running';
          this.emit('unpause', c);
          return empty(204);
        case 'kill':
          c.state = 'exited';
          this.emit('die', c);
          return empty(204);
        default:
          return json(200, { StatusCode: 0 });
      }
    }

    if ((m = /^\/containers\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      const c = this.#find(m[1]!);
      if (!c) return message(404, `No such container: ${m[1]}`);
      const force = q.get('force') === 'true' || q.get('force') === '1';
      if (c.state === 'running' && !force) return message(409, `You cannot remove a running container ${c.id}. Stop the container before attempting removal or force remove`);
      this.containers.delete(c.id);
      this.emit('destroy', c);
      return empty(204);
    }

    if ((m = /^\/containers\/([^/]+)\/exec$/.exec(path)) && method === 'POST') {
      const c = this.#find(m[1]!);
      if (!c) return message(404, `No such container: ${m[1]}`);
      if (c.state !== 'running') return message(409, `Container ${c.id} is not running`);
      const cfg = JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>;
      const exec: FakeExec = {
        id: hex64(), container: c.id, cmd: (cfg.Cmd as string[]) ?? [], user: String(cfg.User ?? ''), env: (cfg.Env as string[]) ?? [], tty: cfg.Tty === true,
        attachStdin: cfg.AttachStdin === true, running: false, exitCode: null, resizes: [],
      };
      this.execs.set(exec.id, exec);
      return json(201, { Id: exec.id });
    }

    if ((m = /^\/exec\/([0-9a-f]{64})\/json$/.exec(path)) && method === 'GET') {
      const e = this.execs.get(m[1]!);
      if (!e) return message(404, `No such exec instance: ${m[1]}`);
      return json(200, { ID: e.id, Running: e.running, ExitCode: e.exitCode, ContainerID: e.container, OpenStdin: e.attachStdin, ProcessConfig: { tty: e.tty, entrypoint: e.cmd[0], arguments: e.cmd.slice(1), user: e.user } });
    }
    if ((m = /^\/exec\/([0-9a-f]{64})\/resize$/.exec(path)) && method === 'POST') {
      const e = this.execs.get(m[1]!);
      if (!e) return message(404, `No such exec instance: ${m[1]}`);
      e.resizes.push({ w: Number(q.get('w')), h: Number(q.get('h')) });
      return empty(200);
    }
    if ((m = /^\/exec\/([0-9a-f]{64})\/start$/.exec(path)) && method === 'POST') {
      // Not an upgrade (no `Connection: Upgrade`): the output comes back as the response body.
      const e = this.execs.get(m[1]!);
      if (!e) return message(404, `No such exec instance: ${m[1]}`);
      const out = await this.#runExec(e, Buffer.alloc(0));
      res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
      return void res.end(out);
    }

    if ((m = /^\/containers\/([^/]+)\/stats$/.exec(path)) && method === 'GET') {
      const c = this.#find(m[1]!);
      if (!c) return message(404, `No such container: ${m[1]}`);
      return json(200, {
        read: new Date().toISOString(),
        cpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 40_000_000, online_cpus: 2 },
        precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 30_000_000 },
        memory_stats: { usage: 300 * 1024 * 1024, limit: 1024 * 1024 * 1024, stats: { inactive_file: 100 * 1024 * 1024 } },
      });
    }
    if ((m = /^\/containers\/([^/]+)\/logs$/.exec(path)) && method === 'GET') {
      if (!this.#find(m[1]!)) return message(404, `No such container: ${m[1]}`);
      res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
      return void res.end(muxFrame(1, 'log line\n'));
    }

    if ((m = /^\/containers\/([^/]+)\/archive$/.exec(path))) {
      const c = this.#find(m[1]!);
      if (!c) return message(404, `No such container: ${m[1]}`);
      const target = q.get('path') ?? '/';
      if (method === 'PUT') {
        await new Promise<void>((resolve) => {
          const ex = extract();
          ex.on('entry', (h, stream, next) => {
            const parts: Buffer[] = [];
            stream.on('data', (d: unknown) => parts.push(d as Buffer));
            stream.on('end', () => {
              if (h.type === 'file') c.files.set(`/${join(target, h.name).replace(/^\/+/, '')}`, { content: Buffer.concat(parts), mode: h.mode, uid: h.uid, gid: h.gid });
              next();
            });
            stream.resume();
          });
          ex.on('finish', () => resolve());
          ex.on('error', () => resolve());
          ex.end(body);
        });
        return empty(200);
      }
      const file = c.files.get(target);
      if (!file) return message(404, `Could not find the file ${target} in container ${c.id}`);
      if (file.virtual && method === 'GET') {
        // A download that is only a stream: the tar of one file of `virtual` bytes, produced as fast as the reader takes it.
        const stream = pack();
        const entry = stream.entry({ name: basename(target), mode: file.mode, type: 'file', size: file.virtual });
        res.writeHead(200, { 'Content-Type': 'application/x-tar' });
        stream.pipe(res);
        void (async () => {
          const chunk = Buffer.alloc(64 * 1024, 3);
          for (let sent = 0; sent < file.virtual!; sent += chunk.length) {
            const part = chunk.subarray(0, Math.min(chunk.length, file.virtual! - sent));
            if (!entry.write(part)) await new Promise<void>((r) => entry.once('drain', () => r()));
          }
          entry.end(undefined);
          stream.finalize();
        })();
        return;
      }
      const p = pack();
      p.entry({ name: basename(target), mode: file.mode, uid: file.uid, gid: file.gid, type: 'file' }, file.content);
      p.finalize();
      const chunks: Buffer[] = [];
      for await (const chunk of p) chunks.push(chunk as Buffer);
      const tar = Buffer.concat(chunks);
      res.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Length': tar.length, 'X-Docker-Container-Path-Stat': Buffer.from(JSON.stringify({ name: basename(target), size: file.content.length, mode: file.mode })).toString('base64') });
      return void res.end(method === 'HEAD' ? undefined : tar);
    }

    if (path === '/volumes/create' && method === 'POST') {
      const v = JSON.parse(body.toString('utf8') || '{}') as { Name?: string };
      if (!v.Name) return message(400, 'name required');
      this.volumes.add(v.Name);
      return json(201, { Name: v.Name, Driver: 'local', Mountpoint: `/var/lib/docker/volumes/${v.Name}/_data`, Labels: {}, Scope: 'local' });
    }
    if ((m = /^\/volumes\/([^/]+)$/.exec(path))) {
      const name = m[1]!;
      if (method === 'GET') return this.volumes.has(name) ? json(200, { Name: name, Driver: 'local', Scope: 'local' }) : message(404, `get ${name}: no such volume`);
      if (method === 'DELETE') {
        if (!this.volumes.delete(name)) return message(404, `get ${name}: no such volume`);
        return empty(204);
      }
    }

    if ((m = /^\/images\/(.+)\/json$/.exec(path)) && method === 'GET') {
      const ref = m[1]!;
      return this.images.has(ref) || this.images.has(`${ref}:latest`) ? json(200, { Id: `sha256:${createHash('sha256').update(ref).digest('hex')}`, RepoTags: [ref] }) : message(404, `No such image: ${ref}`);
    }
    if (path === '/images/create' && method === 'POST') {
      const from = q.get('fromImage') ?? '';
      const tag = q.get('tag');
      this.images.add(tag ? `${from}:${tag}` : from);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(`${JSON.stringify({ status: `Pulling from ${from}`, id: tag ?? 'latest' })}\n${JSON.stringify({ status: 'Download complete' })}\n`);
    }

    return message(404, 'page not found');
  }

  async #runExec(e: FakeExec, stdin: Buffer): Promise<Buffer> {
    const container = this.containers.get(e.container)!;
    e.running = true;
    const result = await this.onExec(e.cmd, { container, exec: e, stdin });
    e.running = false;
    e.exitCode = result.exitCode ?? 0;
    const frames: Buffer[] = [];
    const stdout = result.stdout === undefined ? Buffer.alloc(0) : Buffer.from(result.stdout);
    const stderr = result.stderr === undefined ? Buffer.alloc(0) : Buffer.from(result.stderr);
    if (e.tty) return Buffer.concat([stdout, stderr]);
    if (stdout.length) frames.push(muxFrame(1, stdout));
    if (stderr.length) frames.push(muxFrame(2, stderr));
    return Buffer.concat(frames);
  }

  /** `POST /exec/{id}/start` with `Connection: Upgrade`: 101, then the exec's stream until the client half-closes (or, for a terminal, says exit). */
  async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const path = url.pathname.replace(/^\/v\d+\.\d+/, '');
    const length = Number(req.headers['content-length'] ?? '0');
    let held = head;
    while (held.length < length) held = Buffer.concat([held, await nextChunk(socket)]);
    const body = held.subarray(0, length);
    let early = held.subarray(length);
    this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, bodyBytes: body.length });
    const m = /^\/exec\/([0-9a-f]{64})\/start$/.exec(path);
    const exec = m ? this.execs.get(m[1]!) : undefined;
    if (!exec) {
      const text = JSON.stringify({ message: m ? `No such exec instance: ${m[1]}` : 'page not found' });
      return void socket.end(`HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
    }
    socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    if (exec.tty) {
      // A terminal echoes what it is sent, runs nothing, and ends on `exit`.
      exec.running = true;
      const onData = (d: Buffer) => {
        socket.write(d);
        if (d.toString().includes('exit')) {
          exec.running = false;
          exec.exitCode = 0;
          socket.end();
        }
      };
      if (early.length) onData(early);
      socket.on('data', onData);
      socket.on('end', () => {
        exec.running = false;
        exec.exitCode ??= 0;
        socket.end();
      });
      return;
    }
    if (this.onExecStream) {
      const container = this.containers.get(exec.container)!;
      const stdinFns: ((d: Buffer) => void)[] = [];
      const endFns: (() => void)[] = [];
      exec.running = true;
      socket.on('data', (d: Buffer) => stdinFns.forEach((f) => f(d)));
      socket.on('end', () => endFns.forEach((f) => f()));
      this.onExecStream(exec.cmd, {
        container,
        exec,
        onStdin: (fn) => {
          stdinFns.push(fn);
          if (early.length) fn(early);
        },
        onStdinEnd: (fn) => void endFns.push(fn),
        write: (stream, data) => void socket.write(muxFrame(stream, data)),
        exit: (code) => {
          exec.running = false;
          exec.exitCode = code;
          socket.end();
        },
      });
      return;
    }
    const chunks: Buffer[] = early.length ? [early] : [];
    early = Buffer.alloc(0);
    if (exec.attachStdin) {
      socket.on('data', (d: Buffer) => chunks.push(d));
      await new Promise<void>((resolve) => {
        socket.once('end', () => resolve());
        socket.once('close', () => resolve());
      });
    }
    const out = await this.#runExec(exec, Buffer.concat(chunks));
    socket.end(out);
  }
}

const matchesLabels = (labels: Record<string, string>, wanted: string[]): boolean =>
  wanted.every((w) => {
    const eq = w.indexOf('=');
    if (w.includes('!=')) {
      const [k, v] = w.split('!=');
      return labels[k!] !== v;
    }
    return eq < 0 ? w in labels : labels[w.slice(0, eq)] === w.slice(eq + 1);
  });

function readAll(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', () => resolve(Buffer.concat(parts)));
  });
}

function nextChunk(socket: Duplex): Promise<Buffer> {
  return new Promise((resolve) => {
    socket.once('data', (d: Buffer) => resolve(d));
    socket.resume();
  });
}
