// Delivery into Kubernetes workspaces (foundation PRD §6.2; docs/prd/foundation-pools.md "Kubernetes delivery"): what `DeliveryAccess` needs,
// built on `pods/exec` alone (the RBAC the portal and the Connect agent have; no new verbs, no root in the pod spec).
//
// - Everything that is content (a script, its stdin, a tar archive, a file list, a path) travels on the exec's STDIN, counted: the command
//   line only ever carries the fixed wrapper text below and byte counts, so nothing large and nothing secret is in a URL or an argv.
// - Stdin is never ended. Over the `v4.channel.k8s.io` protocol (older API servers, the in-repo fakes) ending stdin closes the whole
//   WebSocket, output and exit status included; so the payload's length goes first and `head -c N` in the pod bounds every read.
// - Root: the pod runs as uid 1000 (`node`); the delivery engine needs root for /etc/claude-code (root-owned in the image) and for owners and
//   modes. A root `run`, every `put` and every `read` go through `sudo -n` (the workspace image gives `node` passwordless sudo). No sudo, or
//   a refusal, fails with exit 125 and a sentence on stderr: nothing is ever written somewhere else instead.
// - A stopped workspace has no pod, and a new pod starts from the image everywhere but the home volume: `needsRunning` says so, `put` and
//   `run` refuse, `read` answers null, and the reconciler waits for the start (`watchStarts`, a poll of the pod list) to deliver again.
import { AppError } from '@isnanme/core';
import { tarOf } from './tar.js';
import { HOME, type DeliveryAccess, type TarEntry } from './runtime.js';
import { loop } from '../platform/loops.js';

/** The only places delivery writes and reads (what the engine uses: the portal's folder, Claude Code's managed folder, the home, the shell hook). */
/**
 * Where delivery may write. /etc/profile.d/claudepilot.sh is ONE file, written like every file: to a hidden temporary name beside it, then renamed over it
 * (delivery/writer.ts: tmpName), so that temporary name is allowed too; nothing else in /etc/profile.d is.
 */
export const DELIVERY_ROOTS = ['/etc/claudepilot', '/etc/claude-code', HOME, '/etc/profile.d/claudepilot.sh', '/etc/profile.d/.claudepilot.sh.cp-tmp'] as const;

const KiB = 1024;
const MiB = 1024 * KiB;
export const DELIVERY_LIMITS = {
  /** A `run` script (the engine's own: moves, hashes, checks). */
  scriptBytes: 4 * MiB,
  /** A `run`'s stdin. */
  stdinBytes: 16 * MiB,
  /** One `put`: the archive, and the content summed before it is built. */
  archiveBytes: 128 * MiB,
  entries: 20_000,
  pathBytes: 4096,
  nameBytes: 255,
  /** What a command may print (stdout and stderr together) before it is cut off and the call fails. */
  outputBytes: 32 * MiB,
} as const;

/** The exit code the wrapper uses for its own refusals (no sudo, sudo refused, a payload that arrived short). */
export const WRAPPER_CODE = 125;
/** The exit code of the read script for "no such regular file". */
const NOT_A_FILE = 3;

/**
 * Runs as the pod's user. `$1` root|node, `$2` the payload's length, `$3` the inner script, `$4` `$5` its counts. The payload is cut to its
 * length and piped to the inner script, through `sudo -n` when root is asked for and the pod isn't root.
 */
export const OUTER = `u=$(id -u)
if [ "$1" = root ] && [ "$u" != 0 ]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "claudepilot: delivery needs root in this workspace, and its image has no sudo (the workspace image gives its user passwordless sudo)" >&2
    exit ${WRAPPER_CODE}
  fi
  if ! sudo -n true 2>/dev/null; then
    echo "claudepilot: delivery needs root in this workspace, and sudo -n was refused for uid $u (it needs passwordless sudo, and a pod that allows privilege escalation)" >&2
    exit ${WRAPPER_CODE}
  fi
  head -c "$2" | sudo -n sh -c "$3" cp-deliver "$4" "$5"
elif [ "$1" = node ] && [ "$u" = 0 ]; then
  echo "claudepilot: this pod runs as root; delivery runs the workspace user's commands only in a pod that runs as that user" >&2
  exit ${WRAPPER_CODE}
else
  head -c "$2" | sh -c "$3" cp-deliver "$4" "$5"
fi`;

/** Reads exactly `$1` bytes into a variable (trailing newlines kept), or fails. */
const take = (v: string, what: string) => `${v}=$(head -c "$1"; printf x)
${v}=\${${v}%x}
if [ "$(printf %s "$${v}" | wc -c)" -ne "$1" ]; then echo "claudepilot: the ${what} arrived incomplete" >&2; exit ${WRAPPER_CODE}; fi`;

/** `run`: the script (`$1` bytes), then its stdin (`$2` bytes), which is all the script can read. */
export const RUN_INNER = `${take('s', 'script')}
head -c "$2" | { set --; eval "$s"
}`;

/**
 * `put`, as root: the list of every path the archive touches and their folders inside their root (`$1` bytes), then the archive (`$2`
 * bytes). A symbolic link anywhere on that list stops it before tar writes anything; tar keeps owners and modes, makes missing parents,
 * and refuses names with `..` on its own as well.
 */
export const PUT_INNER = `umask 022
${take('l', 'file list')}
link=$(printf '%s\\n' "$l" | while IFS= read -r p; do if [ -n "$p" ] && [ -L "$p" ]; then printf '%s' "$p"; break; fi; done)
if [ -n "$link" ]; then echo "claudepilot: refusing to write through the symbolic link $link" >&2; exit 1; fi
head -c "$2" | tar -x -f - -C / --numeric-owner -p`;

/** `read`, as root: one regular file (never through a link at its own name), or exit 3. */
export const READ_INNER = `${take('p', 'path')}
if [ -L "$p" ] || [ ! -f "$p" ]; then exit ${NOT_A_FILE}; fi
exec cat -- "$p"`;

/** What the runtime gives this module: the pod to exec in, a counted exec, and the ready pods for the start watch. */
export interface PodAccess {
  state(name: string): Promise<{ exists: boolean; running: boolean; portal?: string | null }>;
  /** The Ready pod of a workspace, or null when it has none. */
  readyPod(name: string): Promise<string | null>;
  /** `argv` in the pod's workspace container with `payload` on stdin (never ended); stdout and stderr apart; rejects on a dropped connection. */
  capture(pod: string, argv: string[], payload: Buffer, opts: { timeoutMs: number; maxOutputBytes: number }): Promise<{ code: number; stdout: Buffer; stderr: Buffer }>;
  /** Workspace name → a key that changes with every start of its container (pod uid and restart count), Ready pods only. */
  startKeys(): Promise<Map<string, string>>;
}

const notRunning = () => new AppError('CONFLICT', 'The workspace isn’t running: delivery to a Kubernetes workspace needs it running.');

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** A path delivery may use: absolute, already normal (no `.`, `..`, `//`, trailing `/`), no control characters, inside one of `roots`. */
export function checkPath(path: unknown, roots: readonly string[]): string {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(`Refusing ${JSON.stringify(String(path).slice(0, 200))}: not an absolute path.`);
  const shown = JSON.stringify(path.slice(0, 200));
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) throw new Error(`Refusing ${shown}: control characters in a path.`);
  if (Buffer.byteLength(path) > DELIVERY_LIMITS.pathBytes) throw new Error(`Refusing ${shown}: the path is too long.`);
  const parts = path.slice(1).split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error(`Refusing ${shown}: not a plain path (empty, "." or ".." parts).`);
  if (parts.some((p) => Buffer.byteLength(p) > DELIVERY_LIMITS.nameBytes)) throw new Error(`Refusing ${shown}: a name in it is too long.`);
  if (!roots.some((r) => under(path, r))) throw new Error(`Refusing ${shown}: outside the folders delivery writes (${roots.join(', ')}).`);
  return path;
}

/** Checks a `put`'s entries; returns the paths whose links are refused in the pod: every entry and each of its folders inside its root. */
export function checkEntries(entries: TarEntry[], roots: readonly string[]): string[] {
  if (entries.length > DELIVERY_LIMITS.entries) throw new Error(`Refusing ${entries.length} entries at once (at most ${DELIVERY_LIMITS.entries}).`);
  const watch = new Set<string>();
  let bytes = 0;
  for (const e of entries) {
    const path = checkPath(e.path, roots);
    if (e.type !== 'file' && e.type !== 'directory') throw new Error(`Refusing ${path}: only files and folders are delivered.`);
    if (!Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o7777) throw new Error(`Refusing ${path}: mode ${String(e.mode)} is not valid.`);
    if (e.mode & 0o6000) throw new Error(`Refusing ${path}: set-user-ID and set-group-ID modes are never delivered.`);
    for (const id of [e.uid, e.gid]) if (!Number.isInteger(id) || id < 0 || id > 0o7777777) throw new Error(`Refusing ${path}: owner ${String(id)} is not valid.`);
    if (e.type === 'file') bytes += e.bytes ? e.bytes.length : Buffer.byteLength(e.content ?? '');
    if (bytes > DELIVERY_LIMITS.archiveBytes) throw new Error(`Refusing the delivery: more than ${DELIVERY_LIMITS.archiveBytes / MiB} MiB at once.`);
    const root = roots.filter((r) => under(path, r)).sort((a, b) => b.length - a.length)[0]!;
    for (let p = path; p.length >= root.length; p = p.slice(0, p.lastIndexOf('/'))) {
      watch.add(p);
      if (p === root) break;
    }
  }
  return [...watch];
}

/** Calls `onStart(name)` whenever a workspace's container starts (a key that changed); the first answer is the baseline. Survives errors. */
export function pollStarts(fetch: () => Promise<Map<string, string>>, onStart: (name: string) => void, everyMs: number): () => void {
  let last: Map<string, string> | null = null;
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const now = await fetch();
      if (stopped) return;
      if (last) {
        for (const [name, key] of now) {
          if (last.get(name) === key) continue;
          try {
            onStart(name);
          } catch {
            // the listener's problem, not the watch's
          }
        }
      }
      last = now;
    } catch {
      // The API (or the tunnel) is away: the baseline stays, and a start meanwhile shows as a changed key once it answers again.
    } finally {
      busy = false;
    }
  };
  void tick();
  const run = loop('delivery.kubernetes', everyMs, 'Pools: deliver sets into Kubernetes workspaces').wrap(() => tick());
  const timer = setInterval(() => void run(), everyMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

const counted = (user: 'root' | 'node', inner: string, head: Buffer, rest: Buffer) => ({
  argv: ['sh', '-c', OUTER, 'cp-deliver', user, String(head.length + rest.length), inner, String(head.length), String(rest.length)],
  payload: Buffer.concat([head, rest]),
});

/** `DeliveryAccess` for a Kubernetes namespace (or a cluster through a Connect tunnel: the same pods, the same exec). */
export function kubernetesDelivery(pods: PodAccess, opts: { roots?: readonly string[]; pollMs?: number } = {}): DeliveryAccess {
  const roots = opts.roots ?? DELIVERY_ROOTS;
  const output = DELIVERY_LIMITS.outputBytes;
  return {
    needsRunning: true,

    state: (name) => pods.state(name),

    run: async (name, script, o = {}) => {
      const s = Buffer.from(script, 'utf8');
      const stdin = Buffer.from(o.stdin ?? '', 'utf8');
      if (s.length > DELIVERY_LIMITS.scriptBytes) throw new Error(`Refusing a script of ${s.length} bytes (at most ${DELIVERY_LIMITS.scriptBytes}).`);
      if (stdin.length > DELIVERY_LIMITS.stdinBytes) throw new Error(`Refusing ${stdin.length} bytes of input (at most ${DELIVERY_LIMITS.stdinBytes}).`);
      const pod = await pods.readyPod(name);
      if (!pod) throw notRunning();
      const { argv, payload } = counted(o.user === 'node' ? 'node' : 'root', RUN_INNER, s, stdin);
      const r = await pods.capture(pod, argv, payload, { timeoutMs: o.timeoutMs ?? 30_000, maxOutputBytes: output });
      return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8') };
    },

    put: async (name, entries) => {
      if (entries.length === 0) return;
      const watch = checkEntries(entries, roots);
      const pod = await pods.readyPod(name);
      if (!pod) throw notRunning();
      const archive = await tarOf(entries);
      if (archive.length > DELIVERY_LIMITS.archiveBytes) throw new Error(`Refusing the delivery: more than ${DELIVERY_LIMITS.archiveBytes / MiB} MiB at once.`);
      const { argv, payload } = counted('root', PUT_INNER, Buffer.from(`${watch.join('\n')}\n`, 'utf8'), archive);
      // A slow link moves a large archive at a few MiB a second: a minute plus a second per MiB.
      const r = await pods.capture(pod, argv, payload, { timeoutMs: 60_000 + Math.ceil(archive.length / MiB) * 1000, maxOutputBytes: output });
      if (r.code !== 0) throw new Error(`Writing into the workspace failed: ${r.stderr.toString('utf8').trim() || `exit ${r.code}`}`);
    },

    read: async (name, path) => {
      checkPath(path, roots);
      const pod = await pods.readyPod(name);
      // Stopped: there is no container, and the next one starts from the image outside the home volume (needsRunning).
      if (!pod) return null;
      const { argv, payload } = counted('root', READ_INNER, Buffer.from(path, 'utf8'), Buffer.alloc(0));
      const r = await pods.capture(pod, argv, payload, { timeoutMs: 30_000, maxOutputBytes: output });
      if (r.code === NOT_A_FILE) return null;
      if (r.code !== 0) throw new Error(`Reading ${path} failed: ${r.stderr.toString('utf8').trim() || `exit ${r.code}`}`);
      return r.stdout.toString('utf8');
    },

    watchStarts: (onStart) => pollStarts(() => pods.startKeys(), onStart, opts.pollMs ?? START_POLL_MS),
  };
}

/** How often the pod list is read for starts: a start is delivered to within this (the reconciler's own timer is 15 s). */
export const START_POLL_MS = 5000;
