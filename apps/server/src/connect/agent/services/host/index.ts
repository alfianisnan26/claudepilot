// The `host` service (docs/prd/targets-connect.md §11.6): commands, terminals, file writes and reads as the workspace user, with the
// behaviour of `LocalRuntime` (path mapping for a Host, none for a Container). One stream is one operation (`ConnectHostOpen`).
import { userInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { HOME } from '../../../../workspaces/runtime.js';
import { loadPty as defaultLoadPty, type PtyModule } from '../../../../workspaces/hostexec.js';
import type { ConnectHostOpen, ConnectServiceStatus, ConnectStreamError } from '@portal/contracts';
import type { TunnelStream } from '../../../seams.js';
import type { Logger } from '../../log.js';
import type { AgentService } from '../types.js';
import { HostChannel } from './channel.js';
import { errorResult, execProblem, runExec, type ExecOp, type HostContext, type WorkspaceUser } from './exec.js';
import { hostPaths } from './paths.js';
import { runPut } from './put.js';
import { DEFAULT_MAX_READ, runRead, type ReadOp } from './read.js';
import { createUsageSampler } from './usage.js';

export interface HostServiceOptions {
  mode: 'host' | 'container';
  /** The home commands run in and `/home/node` maps to (a Host: the user's home or PILOT_HOME; a Container: the node user's). */
  home?: string;
  /** Where a Container finds the `node` user. */
  passwdFile?: string;
  /** What commands inherit; default the agent's own environment without its settings (PILOT_*). */
  baseEnv?: NodeJS.ProcessEnv;
  loadPty?: () => Promise<PtyModule>;
  cgroupRoot?: string;
  killGraceMs?: number;
  maxRead?: number;
  log: Logger;
}

/** The agent's environment as commands see it: its own settings (the token, the Access headers, the identity secret) stay behind. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('PILOT_')) out[k] = v;
  return out;
}

/** The `node` user from a passwd file (`name:x:uid:gid:gecos:home:shell`). */
export function passwdUser(file: string, name: string): { uid: number; gid: number; home: string } | null {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const f = line.split(':');
      if (f[0] === name && f.length >= 6) return { uid: Number(f[2]), gid: Number(f[3]), home: f[5] || HOME };
    }
  } catch {
    // no passwd file
  }
  return null;
}

export type HostService = AgentService & { accept(args?: ConnectHostOpen): Promise<{ code: ConnectStreamError; message: string } | null> };

export function createService(opts: HostServiceOptions): HostService {
  const asRoot = process.getuid?.() === 0;
  const home = opts.home ?? (opts.mode === 'container' ? HOME : userInfo().homedir);
  const passwd = opts.passwdFile ?? '/etc/passwd';
  const loadPty = opts.loadPty ?? defaultLoadPty;
  const usage = createUsageSampler({ mode: opts.mode, ...(opts.cgroupRoot ? { cgroupRoot: opts.cgroupRoot } : {}) });
  const channels = new Set<HostChannel>();
  let pty = false;
  let ptyError: string | undefined;
  const login = (() => {
    try {
      return userInfo().username;
    } catch {
      return 'unknown';
    }
  })();

  const ctx: HostContext = {
    mode: opts.mode,
    paths: hostPaths(opts.mode, home),
    baseEnv: opts.baseEnv ?? childEnv(),
    loadPty,
    log: opts.log,
    killGraceMs: opts.killGraceMs ?? 5000,
    maxRead: opts.maxRead ?? DEFAULT_MAX_READ,
    workspaceUser(user): WorkspaceUser | { error: string } {
      if (opts.mode === 'host') return { home, name: login };
      if (user === 'root') return { uid: 0, gid: 0, home: '/root', name: 'root' };
      const node = passwdUser(passwd, 'node');
      if (!node) return asRoot ? { error: 'There is no user “node” here.' } : { home, name: login };
      return { ...(asRoot ? { uid: node.uid, gid: node.gid } : {}), home: opts.home ?? node.home, name: asRoot ? 'node' : login };
    },
  };

  const refresh = async () => {
    try {
      await loadPty();
      pty = true;
      ptyError = undefined;
    } catch (e) {
      pty = false;
      ptyError = (e as Error).message;
    }
  };

  return {
    name: 'host',

    async accept(args) {
      if (!args || typeof args !== 'object') return { code: 'bad_open', message: 'A host stream names its operation.' };
      if (args.op === 'exec') {
        const problem = execProblem(args as ExecOp);
        if (problem) return { code: 'bad_open', message: problem };
        if ((args as ExecOp).tty) {
          if (!pty && !ptyError) await refresh();
          if (!pty) return { code: 'service_unavailable', message: ptyError ?? 'No terminal support.' };
        }
        return null;
      }
      if (args.op === 'put' || args.op === 'read') return null;
      return { code: 'bad_open', message: 'Unknown host operation.' };
    },

    handle(stream: TunnelStream, trace: string, args?: ConnectHostOpen) {
      const ch = new HostChannel(stream);
      channels.add(ch);
      ch.onClose(() => channels.delete(ch));
      const run = async () => {
        opts.log.debug('host.op', { op: args?.op ?? null, trace });
        switch (args?.op) {
          case 'exec':
            return runExec(args, ch, ctx);
          case 'put':
            return runPut(ch, ctx);
          case 'read':
            return runRead(args as ReadOp, ch, ctx);
          default:
            return ch.finish(errorResult('EINVAL', 'unknown host operation'));
        }
      };
      run().catch((e: unknown) => {
        // The error text can carry a path; the portal gets it, the log gets the kind.
        opts.log.warn('host.failed', { op: args?.op ?? null, trace, code: (e as NodeJS.ErrnoException).code ?? 'ERR' });
        ch.finish(errorResult('FAILED', (e as Error).message));
      });
    },

    status(): ConnectServiceStatus {
      return { name: 'host', ok: true, version: login, ...(ptyError ? { error: ptyError } : {}) };
    },

    refresh,

    report() {
      return { usage: usage.read() };
    },

    close() {
      for (const ch of [...channels]) ch.stream.destroy();
      channels.clear();
    },
  };
}
