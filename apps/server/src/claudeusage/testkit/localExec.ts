// `exec` on this machine, with the shape the workspaces' runtimes have (`ExecSession`), so the real probe command can be
// run against the real Claude Code CLI without Docker. The child gets exactly the environment given, nothing inherited.

import { spawn } from 'node:child_process';
import type { ExecSession } from '../../workspaces/runtime.js';

export function localExec(env: Record<string, string>): (target: string, name: string, command: string[]) => Promise<ExecSession> {
  return async (_target, _name, command) => {
    const child = spawn(command[0]!, command.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
