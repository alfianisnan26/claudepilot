// What running things "on the machine itself" needs, shared by This machine (`LocalRuntime`) and the Connect agent's `host` service
// (docs/prd/targets-connect.md §12.7): the workspace-to-host path mapping, the user's environment, a CPU sample, writing one
// delivered entry, and the optional terminal library. Moved out of local.ts unchanged; the only difference is that the home folder
// can be passed (the agent maps to the home it was told, a test to a temporary one) and defaults to the real one, so local.ts behaves
// exactly as before. Node built-ins only: the agent bundle includes this file.
import { chmodSync, chownSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { dirname } from 'node:path';
import { HOME, type TarEntry } from './runtime.js';

/** The portal's own folder in a workspace (the chat host, root-owned there). The portal user can't write /etc here. */
export const ETC = '/etc/claudepilot';

/** Where the portal's folder lives on a machine that is a workspace itself. */
export const hostDir = (home: string = homedir()) => `${home}/.claudepilot/host`;

const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/**
 * A workspace path on this machine: the workspace user's home (`/home/node`) is the portal user's home,
 * and `/etc/claudepilot` is `~/.claudepilot/host`. Anything else is the same path.
 */
export const hostPath = (path: string, home: string = homedir()) =>
  under(path, HOME) ? home + path.slice(HOME.length) : under(path, ETC) ? hostDir(home) + path.slice(ETC.length) : path;

/**
 * The environment commands run in: `base` (the portal's own by default) with HOME pointing at the user's real home, and ~/.local/bin on
 * PATH: where Claude Code's installer (and pip, pipx) put commands for one user.
 */
export function userEnv(home: string = homedir(), base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const local = `${home}/.local/bin`;
  const path = base.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  // The chat host's file commands work under the home folder, which here is the portal user's.
  return { ...base, HOME: home, CLAUDEPILOT_FILES_ROOT: home, PATH: path.split(':').includes(local) ? path : `${local}:${path}` };
}

/** Cumulative CPU time of the machine, for a usage figure from two samples. */
export function sample() {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

/** Writes one delivered file or folder; the owner is only set when the process runs as root. */
export function writeEntry(e: TarEntry, home: string = homedir()) {
  const path = hostPath(e.path, home);
  if (e.type === 'directory') mkdirSync(path, { recursive: true });
  else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, e.content ?? '');
  }
  chmodSync(path, e.mode);
  if (process.getuid?.() === 0) chownSync(path, e.uid, e.gid);
}

export type Pty = {
  onData(fn: (data: string) => void): unknown;
  onExit(fn: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause?(): void;
  resume?(): void;
  readonly pid?: number;
};

export type PtyModule = { spawn(file: string, args: string[], opts: object): unknown };

/** The terminal library is optional; without it this target reports why it can't be used. */
export async function loadPty(): Promise<PtyModule> {
  try {
    return (await import('@lydell/node-pty')) as unknown as PtyModule;
  } catch {
    throw new Error('Terminal support (@lydell/node-pty) isn’t installed');
  }
}
