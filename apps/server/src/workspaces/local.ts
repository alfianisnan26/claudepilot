import { spawn } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, homedir, cpus, totalmem, freemem } from 'node:os';
import { dirname } from 'node:path';
import { AppError } from '@isnanme/core';
import { workspaceId, type Workspace } from '@portal/contracts';
import type { JsonFile } from '../jsonFile.js';
import { HOME, type CreateSpec, type DeliveryAccess, type ExecSession, type Runtime, type ShellSession, type TarEntry } from './runtime.js';

/** What survives a restart: whether the machine is switched on, and since when it has been a workspace. */
export interface LocalState {
  running?: boolean;
  createdAt?: string;
}

const OFF = 'This machine is switched off. Start it first.';

/** The portal's own folder in a workspace (the chat host, root-owned there). The portal user can't write /etc here. */
const ETC = '/etc/claudepilot';
const hostDir = () => `${homedir()}/.claudepilot/host`;
const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
/**
 * A workspace path on this machine: the workspace user's home (`/home/node`) is the portal user's home,
 * and `/etc/claudepilot` is `~/.claudepilot/host`. Anything else is the same path.
 */
const hostPath = (path: string) =>
  under(path, HOME) ? homedir() + path.slice(HOME.length) : under(path, ETC) ? hostDir() + path.slice(ETC.length) : path;

type Pty = {
  onData(fn: (data: string) => void): unknown;
  onExit(fn: (e: { exitCode: number }) => void): unknown;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

/**
 * The machine the portal runs on, as one workspace. Starting it switches access on and stopping it
 * switches it off (shells and commands are refused while it is off). Nothing is created or removed:
 * the workspace is the host itself. Commands run as the portal's own user.
 */
export class LocalRuntime implements Runtime {
  readonly target = { id: 'local', label: 'This machine', kind: 'local' as const, where: hostname() };
  readonly #startListeners = new Set<(name: string) => void>();
  readonly #changeListeners = new Set<() => void>();
  readonly #since = new Date().toISOString();
  #cpu = sample();

  constructor(private readonly opts: { name: string; state: JsonFile<LocalState> }) {}

  get #running() {
    return this.opts.state.read().running === true;
  }

  #guard() {
    if (!this.#running) throw new AppError('CONFLICT', OFF);
  }

  async check() {
    await loadPty();
  }

  readonly delivery: DeliveryAccess = {
    state: async (name) => (name === this.opts.name ? { exists: true, running: this.#running } : { exists: false, running: false }),

    run: async (name, script, opts = {}) => {
      this.#same(name);
      this.#guard();
      return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        // Scripts name the portal's folder as a workspace has it (the chat host's install, say).
        const local = script.split(`${ETC}/`).join(`${hostDir()}/`);
        const child = spawn('sh', ['-c', local], { cwd: homedir(), env: userEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`command timed out after ${opts.timeoutMs ?? 30_000} ms`));
        }, opts.timeoutMs ?? 30_000);
        child.stdout.on('data', (c: Buffer) => out.push(c));
        child.stderr.on('data', (c: Buffer) => err.push(c));
        child.on('error', (e) => (clearTimeout(timer), reject(e)));
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
        });
        child.stdin.on('error', () => undefined); // the script may exit without reading its input (EPIPE)
        child.stdin.end(opts.stdin);
      });
    },

    put: async (name, entries) => {
      this.#same(name);
      this.#guard();
      for (const e of entries) writeEntry(e);
    },

    read: async (name, path) => {
      this.#same(name);
      try {
        return readFileSync(hostPath(path), 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },

    watchStarts: (onStart) => {
      this.#startListeners.add(onStart);
      return () => void this.#startListeners.delete(onStart);
    },
  };

  watch(onChange: () => void): () => void {
    this.#changeListeners.add(onChange);
    return () => void this.#changeListeners.delete(onChange);
  }

  async list(): Promise<Workspace[]> {
    const state = this.opts.state.read();
    return [
      {
        id: workspaceId(this.target.id, this.opts.name),
        name: this.opts.name,
        target: this.target.id,
        image: `${hostname()} (host)`,
        status: state.running ? 'running' : 'stopped',
        detail: state.running ? 'Switched on' : 'Switched off',
        createdAt: state.createdAt ?? this.#since,
      },
    ];
  }

  async create(_spec: CreateSpec) {
    // The Workspaces manager refuses a name that exists, so reaching here means a different name.
    throw new AppError('VALIDATION_FAILED', `This machine is already the workspace “${this.opts.name}”. Start it instead of creating one.`, {
      details: { name: `Only “${this.opts.name}” exists here.` },
    });
  }

  async start(name: string) {
    this.#same(name);
    const state = this.opts.state.read();
    if (state.running) return;
    this.opts.state.write({ ...state, running: true, createdAt: state.createdAt ?? this.#since });
    this.#startListeners.forEach((fn) => fn(name));
    this.#changeListeners.forEach((fn) => fn());
  }

  async stop(name: string) {
    this.#same(name);
    this.opts.state.write({ ...this.opts.state.read(), running: false });
    this.#changeListeners.forEach((fn) => fn());
  }

  async remove(): Promise<void> {
    throw new AppError('CONFLICT', 'This machine can’t be removed. Stop it, or set PORTAL_LOCAL_ENABLED=false and restart.');
  }

  /** Host-wide figures: the workspace is the machine. */
  async usage(names: string[]) {
    const now = sample();
    const idle = now.idle - this.#cpu.idle;
    const total = now.total - this.#cpu.total;
    this.#cpu = now;
    const cpuPercent = total > 0 ? (1 - idle / total) * cpus().length * 100 : 0;
    const memoryBytes = totalmem() - freemem();
    return names.map(() => ({ cpuPercent, memoryBytes, cores: cpus().length, memoryTotalBytes: totalmem() }));
  }

  async shell(name: string, size: { cols: number; rows: number }, command?: string[]): Promise<ShellSession> {
    this.#same(name);
    this.#guard();
    const pty = await loadPty();
    const [file, ...args] = command ?? [process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : 'sh', '-l'];
    const term = pty.spawn(file!, args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: homedir(),
      env: { ...userEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    }) as Pty;
    return {
      write: (data) => term.write(data),
      resize: (cols, rows) => term.resize(cols, rows),
      close: () => term.kill(),
      onData: (fn) => void term.onData((d) => fn(Buffer.from(d, 'utf8'))),
      onExit: (fn) => void term.onExit((e) => fn(e.exitCode)),
    };
  }

  async exec(name: string, command: string[]): Promise<ExecSession> {
    this.#same(name);
    this.#guard();
    // Arguments that are workspace paths (the chat host, a session's folder, a Claude's directory) are this machine's.
    const [bin, ...args] = command.map(hostPath);
    if (!bin) throw new AppError('VALIDATION_FAILED', 'No command.');
    const child = spawn(bin, args, { cwd: homedir(), env: userEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => undefined); // a write after the command exited (EPIPE) is the caller's lost race, not a crash
    const dataFns: ((data: Buffer) => void)[] = [];
    const exitFns: ((code: number | null) => void)[] = [];
    const emit = (c: Buffer) => dataFns.forEach((fn) => fn(c));
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      exitFns.forEach((fn) => fn(code));
    };
    child.on('error', (e) => {
      emit(Buffer.from(`${e.message}\n`));
      finish(127);
    });
    child.on('close', (code) => finish(code));
    return {
      write: (data) => void child.stdin.write(data),
      close: () => void child.stdin.destroy(),
      onData: (fn) => void dataFns.push(fn),
      onExit: (fn) => void exitFns.push(fn),
    };
  }

  #same(name: string) {
    if (name !== this.opts.name) throw new AppError('NOT_FOUND', 'That workspace doesn’t exist.');
  }
}

/**
 * The portal's environment with HOME pointing at the portal user's real home, and ~/.local/bin on
 * PATH: where Claude Code's installer (and pip, pipx) put commands for one user.
 */
function userEnv(): NodeJS.ProcessEnv {
  const local = `${homedir()}/.local/bin`;
  const path = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  // The chat host's file commands work under the home folder, which here is the portal user's.
  return { ...process.env, HOME: homedir(), CLAUDEPILOT_FILES_ROOT: homedir(), PATH: path.split(':').includes(local) ? path : `${local}:${path}` };
}

function sample() {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

/** Writes one delivered file or folder; the owner is only set when the portal runs as root. */
function writeEntry(e: TarEntry) {
  const path = hostPath(e.path);
  if (e.type === 'directory') mkdirSync(path, { recursive: true });
  else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, e.content ?? '');
  }
  chmodSync(path, e.mode);
  if (process.getuid?.() === 0) chownSync(path, e.uid, e.gid);
}

type PtyModule = { spawn(file: string, args: string[], opts: object): unknown };

/** The terminal library is optional; without it this target reports why it can't be used. */
async function loadPty(): Promise<PtyModule> {
  try {
    return (await import('@lydell/node-pty')) as unknown as PtyModule;
  } catch {
    throw new Error('Terminal support (@lydell/node-pty) isn’t installed');
  }
}
