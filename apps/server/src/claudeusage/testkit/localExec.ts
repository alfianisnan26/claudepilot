// `exec` on this machine, with the shape the workspaces' runtimes have (`ExecSession`), so the real probe command can be
// run against the real Claude Code CLI without Docker. The child gets exactly the environment given, nothing inherited, and runs in `cwd` when given
// (the working directory of a workspace's exec, where a project's own `.claude/settings.json` would sit).

import { spawn } from 'node:child_process';
import type { ExecSession } from '../../workspaces/runtime.js';

/**
 * `exited` (T-2421): each child's exit is added to it, so a test can wait until every process it started is gone before it removes the
 * folders they write in (the probe returns once stdin is closed; Claude Code and its SessionEnd hooks may still be writing).
 */
export function localExec(
  env: Record<string, string>,
  opts: { cwd?: string; exited?: Promise<void>[] } = {},
): (target: string, name: string, command: string[]) => Promise<ExecSession> {
  return async (_target, _name, command) => {
    const child = spawn(command[0]!, command.slice(1), { env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    opts.exited?.push(new Promise((resolve) => child.once('close', () => resolve())));
    const data: ((d: Buffer) => void)[] = [];
    const exit: ((code: number | null) => void)[] = [];
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (d: Buffer) => data.forEach((fn) => fn(d)));
    child.stdin.on('error', () => {});
    child.on('close', (code) => exit.forEach((fn) => fn(code)));
    return {
      write: (text) => void child.stdin.write(text),
      close: () => {
        child.stdin.end();
        // Like a dropped connection, the process may carry on; a test never leaves one behind.
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      },
      onData: (fn) => void data.push(fn),
      onExit: (fn) => void exit.push(fn),
    };
  };
}
