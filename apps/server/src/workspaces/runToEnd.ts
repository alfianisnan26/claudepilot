import type { Workspaces } from './manager.js';

const OUTPUT_MAX = 64 * 1024;

/**
 * Runs a command in a workspace to completion, as its user: exit code and output (stdout and stderr
 * merged, the last 64 KB). The code is null when it ran past `ms`; the connection is dropped then,
 * but the process itself may keep running.
 */
export async function runToEnd(
  workspaces: Workspaces,
  target: string,
  name: string,
  command: string[],
  ms = 10_000,
): Promise<{ code: number | null; output: string }> {
  const exec = await workspaces.exec(target, name, command);
  let output = '';
  exec.onData((d) => (output = (output + d.toString('utf8')).slice(-OUTPUT_MAX)));
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    exec.onExit((c) => (clearTimeout(timer), resolve(c)));
  });
  exec.close();
  return { code, output };
}
