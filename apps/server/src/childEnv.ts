// The environment a process the portal starts inherits (T-2615). The portal's container sets a V8 heap cap in NODE_OPTIONS
// (`--max-old-space-size`, deploy/k3s/portal.yaml) sized for the portal alone. A Node child that inherits it may grow its own heap
// to the same size inside the same memory cgroup, and the cgroup's OOM kill comes before V8 limits anything. So children get the
// portal's environment without that one flag; every other NODE_OPTIONS flag stays. A spawn site that wants a heap cap for its child
// sets one on purpose, after this. Used where the portal's own process starts commands (This machine: workspaces/local.ts); a
// workspace's own processes (cp-ci, the browser gate) run in their own container, or under this environment when the workspace is this
// machine, so they need no copy of it.

/** The heap-size flags of V8 that size one process (both spellings Node accepts). */
const HEAP_FLAG = /^--max[-_]old[-_]space[-_]size(?:=.*)?$/;

/** NODE_OPTIONS without the heap-size flag; undefined when nothing else is left. */
export function withoutHeapFlag(options: string | undefined): string | undefined {
  if (options === undefined) return undefined;
  const rest = options.split(/\s+/).filter((f) => f && !HEAP_FLAG.test(f));
  return rest.length ? rest.join(' ') : undefined;
}

/** A copy of `env` (the portal's own by default) for a child process: the portal's heap cap stays behind. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const options = withoutHeapFlag(env.NODE_OPTIONS);
  if (options === undefined) delete out.NODE_OPTIONS;
  else out.NODE_OPTIONS = options;
  return out;
}
