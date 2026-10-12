import type { Runtime } from '../workspaces/runtime.js';

/**
 * One file of a workspace, as the workspace user and through the runtime's exec (the file's own bytes, which the
 * delivery engine's text read can't give): only a plain file, never a link, of at most `maxBytes`. The path goes in
 * on stdin, never into the command line. Null when it isn't such a file, or can't be read.
 */
export async function readWorkspaceFile(runtimeFor: (target: string) => Runtime | undefined, workspaceId: string, path: string, maxBytes: number): Promise<Buffer | null> {
  const slash = workspaceId.indexOf('/');
  const delivery = runtimeFor(workspaceId.slice(0, slash))?.delivery;
  if (!delivery || slash < 1) return null;
  // The size is checked, and the read is capped again: a file that grows after the check can't fill the portal's memory.
  const script = `IFS= read -r f; [ -f "$f" ] && [ ! -L "$f" ] || exit 3; s=$(stat -c %s "$f") || exit 4; [ "$s" -le ${Math.floor(maxBytes)} ] || exit 5; head -c ${Math.floor(maxBytes) + 1} -- "$f" | base64 -w0`;
  const r = await delivery.run(workspaceId.slice(slash + 1), script, { user: 'node', stdin: `${path}\n`, timeoutMs: 20_000 });
  if (r.code !== 0 || !r.stdout) return null;
  const bytes = Buffer.from(r.stdout.trim(), 'base64');
  return bytes.length <= maxBytes ? bytes : null;
}
