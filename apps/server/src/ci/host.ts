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
export class CiUnreachable extends Error {}

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
    const s = await access.state(name);
    return !s.exists ? ('gone' as const) : s.running ? ('running' as const) : ('stopped' as const);
  }

  #listed: { at: number; map: Promise<Map<string, 'running' | 'stopped'>> } | null = null;

  states(): Promise<Map<string, 'running' | 'stopped'>> {
    // Listing asks every runtime; pages ask often, so one answer serves a few seconds.
    if (this.#listed && Date.now() - this.#listed.at < 4000) return this.#listed.map;
    const map = this.workspaces
      .list()
      .then((all) => new Map(all.map((w) => [w.id, w.status === 'running' ? ('running' as const) : ('stopped' as const)])))
      .catch(() => new Map<string, 'running' | 'stopped'>());
    this.#listed = { at: Date.now(), map };
    return map;
  }

  async cp(workspaceId: string, args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<CiReply> {
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
    if (done.code === null) throw new CiUnreachable('The workspace did not answer in time.');
    // 126 and 127: the shell could not find or run the file.
    if (done.code === 126 || done.code === 127) throw new CiUnreachable('The CI runner is not installed in this workspace.');
    throw new CiUnreachable(`The CI runner gave no answer (exit ${done.code}): ${out.trim().slice(-200)}`);
  }

  install(workspaceId: string): Promise<void> {
    const at = this.#checked.get(workspaceId);
    if (at !== undefined && Date.now() - at < this.recheckMs) return Promise.resolve();
    const running = this.#installing.get(workspaceId);
    if (running) return running;
    const p = this.#install(workspaceId)
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
