// `host` op `exec` (docs/prd/targets-connect.md §11.6): run `argv` as the workspace user, with pipes or a terminal.
//
// stdin comes in as DATA records and ends with EOF; stdout and stderr go out as DATA and STDERR records (DATA only, with `merge` or a
// terminal), written only while the stream accepts data: the child's output is paused otherwise, so the tunnel's window is the
// backpressure. Exactly one RESULT ends it. A stream that is reset before the process is done kills it: SIGHUP to a terminal's process
// group, SIGTERM and after a grace SIGKILL otherwise. What a command was (argv, env, cwd) is never logged.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import type { ConnectHostOpen, ConnectHostResult } from '@portal/contracts';
import { userEnv, type Pty, type PtyModule } from '../../../../workspaces/hostexec.js';
import type { Logger } from '../../log.js';
import { HostChannel, REC, type RecordKind } from './channel.js';
import type { HostPaths } from './paths.js';

export type ExecOp = Extract<ConnectHostOpen, { op: 'exec' }>;

export interface WorkspaceUser {
  uid?: number;
  gid?: number;
  home: string;
  name: string;
}

export interface HostContext {
  mode: 'host' | 'container';
  paths: HostPaths;
  /** The environment commands start from: the agent's own with the agent's settings (PILOT_*) taken out. */
  baseEnv: NodeJS.ProcessEnv;
  /** Who a command runs as; `{ error }` when that user doesn't exist here. */
  workspaceUser(user: 'node' | 'root' | undefined): WorkspaceUser | { error: string };
  loadPty(): Promise<PtyModule>;
  log: Logger;
  /** SIGTERM to SIGKILL, ms. */
  killGraceMs: number;
  /** Most bytes a `read` returns. */
  maxRead: number;
}

type ErrorCode = NonNullable<ConnectHostResult['error']>['code'];

export const errorResult = (code: ErrorCode, message: string): ConnectHostResult => ({ code: null, error: { code, message: message.slice(0, 300) } });

/** A Node or OS error as the RESULT's typed error. */
export function resultOfError(e: unknown): ConnectHostResult {
  const err = e as NodeJS.ErrnoException;
  const code: ErrorCode = ['ENOENT', 'EACCES', 'E2BIG', 'EIO', 'EINVAL', 'ETIMEDOUT'].includes(err.code ?? '') ? (err.code as ErrorCode) : err.code === 'EPERM' ? 'EACCES' : 'FAILED';
  return errorResult(code, err.message || 'failed');
}

const SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGHUP']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ARGV_BYTES = 1_048_576;

/** Why an exec request is unusable, or null. */
export function execProblem(op: ExecOp): string | null {
  if (!Array.isArray(op.argv) || op.argv.length === 0 || op.argv.some((a) => typeof a !== 'string')) return 'argv must be a list of strings';
  if (op.argv[0] === '') return 'argv[0] is empty';
  if (op.argv.reduce((n, a) => n + a.length + 1, 0) > MAX_ARGV_BYTES) return 'argv is too large';
  if (op.argv.some((a) => a.includes('\0'))) return 'argv has a NUL';
  if (op.cwd !== undefined && (typeof op.cwd !== 'string' || !op.cwd.startsWith('/') || op.cwd.includes('\0'))) return 'cwd must be an absolute path';
  if (op.env !== undefined) {
    if (typeof op.env !== 'object' || op.env === null || Array.isArray(op.env)) return 'env must be an object';
    for (const [k, v] of Object.entries(op.env)) if (!ENV_NAME.test(k) || typeof v !== 'string' || v.includes('\0')) return 'env has a bad entry';
  }
  if (op.tty !== undefined) {
    const { cols, rows } = op.tty;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 2000 || rows > 2000) return 'tty size is out of range';
  }
  if (op.user !== undefined && op.user !== 'node' && op.user !== 'root') return 'user must be node or root';
  return null;
}

const signalName = (n: number | undefined): string | undefined => {
  if (!n) return undefined;
  return Object.entries(osConstants.signals).find(([, v]) => v === n)?.[0];
};

/** Kills a process group (the child leads its own); falls back to the process when there is no group. */
function killGroup(pid: number | undefined, signal: NodeJS.Signals, fallback?: () => void) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      if (fallback) fallback();
      else process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/** Runs one exec op on `ch`. Never throws; the outcome is the RESULT record. */
export async function runExec(op: ExecOp, ch: HostChannel, ctx: HostContext): Promise<void> {
  const problem = execProblem(op);
  if (problem) return ch.finish(errorResult('EINVAL', problem));
  const who = ctx.workspaceUser(op.user);
  if ('error' in who) return ch.finish(errorResult('FAILED', who.error));

  const argv = ctx.paths.mapArgv(op.argv);
  const cwd = op.cwd ? ctx.paths.map(op.cwd) : who.home;
  const env: NodeJS.ProcessEnv = { ...userEnv(who.home, ctx.baseEnv), USER: who.name, LOGNAME: who.name, ...(op.env ?? {}) };
  // A folder that isn't there makes spawn say "ENOENT" about the program: say it about the folder.
  if (!existsSync(cwd)) return ch.finish(errorResult('ENOENT', 'The working directory does not exist.'));
  const [file, ...args] = argv as [string, ...string[]];
  const ids = { ...(who.uid !== undefined ? { uid: who.uid } : {}), ...(who.gid !== undefined ? { gid: who.gid } : {}) };

  if (op.tty) return runTerminal(op, ch, ctx, { file, args, cwd, env, ids });
  return runPipes(op, ch, ctx, { file, args, cwd, env, ids });
}

interface Launch {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  ids: { uid?: number; gid?: number };
}

function runPipes(op: ExecOp, ch: HostChannel, ctx: HostContext, l: Launch): Promise<void> {
  return new Promise<void>((done) => {
    let child: ChildProcess;
    try {
      child = spawn(l.file, l.args, { cwd: l.cwd, env: l.env, ...l.ids, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      ch.finish(resultOfError(e));
      return done();
    }
    let finished = false;
    let killTimer: NodeJS.Timeout | undefined;
    let exitTimer: NodeJS.Timeout | undefined;
    let exit: { code: number | null; signal: string | undefined } | null = null;
    let spawnError: unknown = null;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      clearTimeout(exitTimer);
      if (spawnError) ch.finish(resultOfError(spawnError));
      else ch.finish({ code: exit?.signal ? null : (exit?.code ?? null), ...(exit?.signal ? { signal: exit.signal } : {}) });
      done();
    };

    const stdin = child.stdin!;
    stdin.on('error', () => undefined); // the command may exit without reading its input (EPIPE)

    // Output to records, only while the stream accepts data.
    let paused = false;
    const pump = (kind: RecordKind) => (chunk: Buffer) => {
      if (ch.sendBytes(kind, chunk) || paused) return;
      paused = true;
      child.stdout?.pause();
      child.stderr?.pause();
      void ch.drained().then(() => {
        paused = false;
        child.stdout?.resume();
        child.stderr?.resume();
      });
    };
    child.stdout!.on('data', pump(REC.data));
    child.stderr!.on('data', pump(op.merge ? REC.data : REC.stderr));

    ch.onRecord(({ kind, payload }) => {
      if (kind === REC.data) {
        if (!stdin.writable) return;
        if (!stdin.write(payload)) {
          ch.pause();
          stdin.once('drain', () => ch.resume());
        }
      } else if (kind === REC.eof) stdin.end();
      else if (kind === REC.signal) {
        const sig = parseJson(payload)?.signal;
        if (typeof sig === 'string' && SIGNALS.has(sig)) killGroup(child.pid, sig as NodeJS.Signals, () => child.kill(sig as NodeJS.Signals));
      }
    });
    // The portal closed its side without EOF: the command gets its end of input and keeps running.
    ch.onEnd(() => stdin.end());

    const kill = () => {
      if (finished || exit) return;
      killGroup(child.pid, 'SIGTERM', () => child.kill('SIGTERM'));
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL', () => child.kill('SIGKILL')), ctx.killGraceMs);
      killTimer.unref();
    };
    // A reset stream ends the command: nobody is left to read what it prints.
    ch.onClose(() => {
      if (!ch.finished) kill();
      child.stdout?.destroy();
      child.stderr?.destroy();
      stdin.destroy();
      setTimeout(finish, 0);
    });

    child.on('error', (e) => {
      spawnError = e;
      finish();
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal: signal ?? undefined };
      // A background process may still hold the pipes: give the output a moment, then stop waiting for it.
      exitTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, 1500);
      exitTimer.unref();
    });
    child.on('close', () => finish());
    ctx.log.debug('host.exec', { pipes: true });
  });
}

async function runTerminal(op: ExecOp, ch: HostChannel, ctx: HostContext, l: Launch): Promise<void> {
  let pty: PtyModule;
  try {
    pty = await ctx.loadPty();
  } catch (e) {
    return ch.finish(errorResult('FAILED', (e as Error).message));
  }
  const size = op.tty!;
  let term: Pty;
  try {
    term = pty.spawn(l.file, l.args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: l.cwd,
      env: { ...l.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      encoding: null,
      ...l.ids,
    }) as Pty;
  } catch (e) {
    return ch.finish(resultOfError(e));
  }

  return new Promise<void>((done) => {
    let finished = false;
    let quiet: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let exited: { code: number | null; signal?: string } | null = null;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(quiet);
      clearTimeout(killTimer);
      ch.finish(exited ?? { code: null });
      done();
    };

    // The terminal can report its exit before the last output arrives: finish once it has been quiet for a moment.
    const armQuiet = () => {
      clearTimeout(quiet);
      quiet = setTimeout(finish, 40);
      quiet.unref();
    };

    let paused = false;
    term.onData((d) => {
      if (exited) armQuiet();
      const bytes = typeof d === 'string' ? Buffer.from(d, 'utf8') : (d as Buffer);
      if (ch.sendBytes(REC.data, bytes) || paused) return;
      paused = true;
      term.pause?.();
      void ch.drained().then(() => {
        paused = false;
        term.resume?.();
      });
    });
    term.onExit((e) => {
      const signal = signalName(e.signal);
      exited = { code: signal ? null : e.exitCode, ...(signal ? { signal } : {}) };
      armQuiet();
      setTimeout(finish, 400).unref();
    });

    ch.onRecord(({ kind, payload }) => {
      if (kind === REC.data) term.write(payload);
      else if (kind === REC.resize) {
        const size2 = parseJson(payload);
        const cols = Number(size2?.cols);
        const rows = Number(size2?.rows);
        if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 && cols <= 2000 && rows <= 2000) {
          try {
            term.resize(cols, rows);
          } catch {
            // the terminal has just ended
          }
        }
      } else if (kind === REC.signal) {
        const sig = parseJson(payload)?.signal;
        if (typeof sig === 'string' && SIGNALS.has(sig)) killGroup(term.pid, sig as NodeJS.Signals, () => term.kill(sig));
      }
      // EOF has no meaning for a terminal: the person closes it with a reset or the shell's own exit.
    });

    ch.onClose(() => {
      if (!ch.finished && !exited) {
        killGroup(term.pid, 'SIGHUP', () => term.kill('SIGHUP'));
        killTimer = setTimeout(() => killGroup(term.pid, 'SIGKILL', () => term.kill('SIGKILL')), ctx.killGraceMs);
        killTimer.unref();
      }
      setTimeout(finish, 0);
    });
    ctx.log.debug('host.exec', { pipes: false });
  });
}

const parseJson = (payload: Buffer): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(payload.toString('utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
