// The service's only way into a workspace (PRD §11.1): run `cp-ci` there, make sure it is installed, learn that a workspace
// started. The real host sits on the workspace runtimes; tests put a temporary home folder behind the same interface.

import { randomUUID } from 'node:crypto';
import { AppError } from '@isnanme/core';
import type { Workspaces } from '../workspaces/manager.js';
import { CP_CI } from './runner.generated.js';

/** Where the portal installs the runner inside a workspace: the root-owned `bin/` the chat host uses. */
export const CP_CI_PATH = '/etc/claudepilot/bin/cp-ci';

/** What the runner answered, parsed. `ok` is false for its own refusals (the `error` code says why). */
export interface CiReply {
  ok: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

/** The runner could not be reached or answered nothing usable; the workspace is the likely cause. */
export class CiUnreachable extends Error {
  /** True when the runner may simply be missing or not runnable (no reply at all, exit 126 or 127): `cp` then installs it again once (T-99). */
  constructor(
    message: string,
    readonly runnerMissing = false,
  ) {
    super(message);
  }
}

export interface CiHost {
  state(workspaceId: string): Promise<'running' | 'stopped' | 'gone' | 'unsupported'>;
  /** Every workspace's state, for lists: a workspace not in the map is gone. Cheap enough to ask on every page load. */
  states(): Promise<Map<string, 'running' | 'stopped'>>;
  /** Runs `cp-ci <args>` in the workspace as its user. The reply is the last `@cpci ` line; a refusal is still a reply. */
  cp(workspaceId: string, args: string[], opts?: { stdin?: string; timeoutMs?: number }): Promise<CiReply>;
  /** Installs or updates the runner when the workspace has none or an old one. */
  install(workspaceId: string): Promise<void>;
}

const OUTPUT_MAX = 8 * 1024 * 1024;
/** How long a workspace's state and an install of the runner may take before the caller goes on (T-557: remote targets stall). */
const STATE_MS = 15_000;
const INSTALL_MS = 90_000;

/** The promise, or `fallback()` (made only then: a value, or a throw) once `ms` passed. The slow call itself is left to finish or fail. */
function within<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(fallback());
      } catch (e) {
        reject(e);
      }
    }, ms);
    timer.unref();
  });
  // The slow call may still fail later: that is not this caller's error any more.
  p.catch(() => undefined);
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
const split = (id: string): [string, string] => {
  const slash = id.indexOf('/');
  return [id.slice(0, slash), id.slice(slash + 1)];
};

export class WorkspacesCiHost implements CiHost {
  readonly #installing = new Map<string, Promise<void>>();
  /** When the runner was last confirmed current in a workspace; a restart of the container keeps its volume, so this is rechecked now and then. */
  readonly #checked = new Map<string, number>();

  constructor(
    private readonly workspaces: Workspaces,
    private readonly recheckMs = 10 * 60_000,
  ) {}

  async state(workspaceId: string) {
    const [target, name] = split(workspaceId);
    const access = this.workspaces.runtimeFor(target)?.delivery;
    if (!access) return this.workspaces.runtimeFor(target) ? ('unsupported' as const) : ('gone' as const);
    // Bounded (T-557): a remote target whose tunnel stalls answers "stopped" for now, never holds the caller.
    const s = await within(access.state(name), STATE_MS, () => ({ exists: true, running: false }));
    const state = !s.exists ? ('gone' as const) : s.running ? ('running' as const) : ('stopped' as const);
    // A workspace seen stopped or gone comes back from its image: the runner lives in the container, not on the volume (T-99).
    if (state !== 'running') this.#checked.delete(workspaceId);
    return state;
  }

  #listed: { at: number; map: Promise<Map<string, 'running' | 'stopped'>> } | null = null;

  states(): Promise<Map<string, 'running' | 'stopped'>> {
    // Listing asks every runtime; pages ask often, so one answer serves a few seconds.
    if (this.#listed && Date.now() - this.#listed.at < 4000) return this.#listed.map;
    const map = this.workspaces
      .list()
      .then((all) => {
        for (const w of all) if (w.status !== 'running') this.#checked.delete(w.id);
        return new Map(all.map((w) => [w.id, w.status === 'running' ? ('running' as const) : ('stopped' as const)]));
      })
      .catch(() => new Map<string, 'running' | 'stopped'>());
    this.#listed = { at: Date.now(), map };
    return map;
  }

  /**
   * `cp-ci <args>`; when the runner gives no reply at all, or the shell can't find or run it (126, 127), and the file in the workspace
   * is not the current runner (a pod restart keeps the home volume, not /etc/claudepilot/bin, while `install` remembered it for up to
   * `recheckMs`: T-99), the mark is forgotten, the runner installed again and the command tried once more. A current runner that only
   * took too long is NOT retried: the command may have run (a `start`, say).
   */
  async cp(workspaceId: string, args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<CiReply> {
    try {
      return await this.#cp(workspaceId, args, opts);
    } catch (e) {
      if (!(e instanceof CiUnreachable) || !e.runnerMissing) throw e;
      const [target, name] = split(workspaceId);
      const current = await this.workspaces.runtimeFor(target)?.delivery?.read(name, CP_CI_PATH).catch(() => null);
      if (current === CP_CI) throw e;
      this.#checked.delete(workspaceId);
      await this.install(workspaceId);
      return this.#cp(workspaceId, args, opts);
    }
  }

  async #cp(workspaceId: string, args: string[], opts: { stdin?: string; timeoutMs?: number }): Promise<CiReply> {
    const [target, name] = split(workspaceId);
    const exec = await this.workspaces.exec(target, name, [CP_CI_PATH, ...args]);
    const chunks: Buffer[] = [];
    let size = 0;
    const done = await new Promise<{ code: number | null }>((resolve) => {
      const timer = setTimeout(() => resolve({ code: null }), opts.timeoutMs ?? 30_000);
      exec.onData((b) => {
        size += b.length;
        if (size <= OUTPUT_MAX) chunks.push(b);
      });
      exec.onExit((code) => {
        clearTimeout(timer);
        resolve({ code });
      });
      if (opts.stdin !== undefined) exec.write(opts.stdin);
    });
    exec.close();
    const out = Buffer.concat(chunks).toString('utf8');
    const line = out.split('\n').filter((l) => l.startsWith('@cpci ')).pop();
    if (line) {
      try {
        return JSON.parse(line.slice(6)) as CiReply;
      } catch {
        // falls through to the unreachable error
      }
    }
    if (done.code === null) throw new CiUnreachable('The workspace did not answer in time.', true);
    // 126 and 127: the shell could not find or run the file.
    if (done.code === 126 || done.code === 127) throw new CiUnreachable('The CI runner is not installed in this workspace.', true);
    throw new CiUnreachable(`The CI runner gave no answer (exit ${done.code}): ${out.trim().slice(-200)}`);
  }

  install(workspaceId: string): Promise<void> {
    const at = this.#checked.get(workspaceId);
    if (at !== undefined && Date.now() - at < this.recheckMs) return Promise.resolve();
    const running = this.#installing.get(workspaceId);
    if (running) return running;
    const p = within(this.#install(workspaceId), INSTALL_MS, () => {
      throw new CiUnreachable('Installing the CI runner took too long.', false);
    })
      .then(() => void this.#checked.set(workspaceId, Date.now()))
      .finally(() => this.#installing.delete(workspaceId));
    this.#installing.set(workspaceId, p);
    return p;
  }

  async #install(workspaceId: string): Promise<void> {
    const [target, name] = split(workspaceId);
    const access = this.workspaces.runtimeFor(target)?.delivery;
    if (!access) throw new AppError('SERVICE_UNAVAILABLE', 'This kind of workspace can not run CI yet: its image has to ship the runner.');
    const current = await access.read(name, CP_CI_PATH).catch(() => null);
    if (current === CP_CI) return;
    // A name of its own, so even a second portal process can not take it; renamed as root so a reader never sees half a script.
    const tmp = `/etc/claudepilot/bin/.cp-ci.${randomUUID()}.cp-tmp`;
    await access.put(name, [
      { path: '/etc/claudepilot', type: 'directory', mode: 0o755, uid: 0, gid: 0 },
      { path: '/etc/claudepilot/bin', type: 'directory', mode: 0o755, uid: 0, gid: 0 },
      { path: tmp, type: 'file', content: CP_CI, mode: 0o755, uid: 0, gid: 0 },
    ]);
    const r = await access.run(name, `mv -f '${tmp}' '${CP_CI_PATH}'`, { user: 'root' });
    if (r.code !== 0) throw new Error(`Installing the CI runner failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
}
