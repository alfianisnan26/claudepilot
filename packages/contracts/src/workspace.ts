/** How a target runs workspaces. */
export type RuntimeKind = 'docker' | 'kubernetes' | 'local';

/** A place workspaces can run: a Docker daemon, a Kubernetes namespace, or the portal's own machine. */
export interface WorkspaceTarget {
  id: string;
  label: string;
  kind: RuntimeKind;
  /** Socket path or namespace, for showing where it is. */
  where: string;
  available: boolean;
  /** Why it isn't available. */
  problem?: string;
  /** `enrolled`: added through Connect (docs/prd/targets-connect.md §12.2); absent or `scanned`: found in the portal's environment. */
  source?: 'scanned' | 'enrolled';
  /** An enrolled target: `cluster` places new workspaces, `single` is one workspace. */
  role?: 'cluster' | 'single';
  /** An enrolled cluster's nodes (the New workspace dialog offers a Node select when there is more than one). */
  nodes?: { id: string; name: string; connected: boolean; drained: boolean }[];
}

/**
 * `unreachable`: on an enrolled target whose tunnel is down; the rest of the entry is the last known state (targets-connect PRD §12.5).
 * `unavailable`: its target's list failed or timed out (a slow or down Kubernetes API, T-515); the rest is the last good answer, `detail`
 * says why (short, redacted) and `lastSeenAt` when that answer was.
 */
export type WorkspaceStatus = 'creating' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error' | 'unreachable' | 'unavailable';

/** A status that shows a last known entry, not a live answer: what needs the target waits. */
export const isLastKnownStatus = (s: WorkspaceStatus): boolean => s === 'unreachable' || s === 'unavailable';

export interface Workspace {
  /**
   * `<target>/<name>`: names are unique within a target. Since T-42 this is the workspace's ALIAS: every route, tool, ticket, CI remote and
   * link that carries it keeps working for good, and the manager resolves it to `stableId`. New code should prefer `stableId`.
   */
  id: string;
  /**
   * The workspace's identity (T-42): `ws_` and 12 hex digits, given once when the portal first knows the workspace, never changed, never
   * reused and never derived from the name. Absent only from a runtime's own list before the manager adds it.
   */
  stableId?: string;
  /**
   * The name it was made with: the key in `id` and in the runtime's labels, which never changes (T-42). What people see is `label`; show it
   * with `workspaceDisplayName`.
   */
  name: string;
  /**
   * The name shown (T-42 slice 2): a display label people can change (1 to 40 characters, one line, plain text, unique per target). A rename
   * changes this only: never `stableId`, `id`, `name` or `runtimeName`. The manager sets it on every workspace it lists (`name` until renamed).
   */
  label?: string;
  /**
   * What the runtime calls it (T-42): the Docker container, the Kubernetes Deployment (its home volume is `<runtimeName>-home`), the single's
   * workspace on a Connect or This machine target. STORED on the record, never recomputed from the name; `ws-<12 hex>` for a new workspace.
   */
  runtimeName?: string;
  target: string;
  image: string;
  status: WorkspaceStatus;
  /** What's going on (image build progress, pod waiting reason, error). */
  detail?: string;
  /** ISO time. */
  createdAt: string;
  /** Limits; undefined means none. */
  cpus?: number;
  memoryMb?: number;
  /** The account pool it uses; null or absent means its own sign-in. */
  account?: import('./accounts.js').WorkspaceAccountState | null;
  /** What the portal last delivered into it; absent when nothing was ever delivered. */
  delivery?: import('./accounts.js').WorkspaceDeliveryState | null;
  /** Its Claude Code version: pinned (the image's) and running, with what looks wrong (docs/prd/claude-version-pinning.md). */
  claude?: import('./claudeversion.js').WorkspaceClaudeBrief | null;
  /** The node of an enrolled cluster it runs on (targets-connect PRD §12.4). */
  node?: string;
  /** ISO time the portal last reached it (its target's last good answer); set while it is `unreachable` or `unavailable`. */
  lastSeenAt?: string;
}

export interface WorkspaceUsage {
  id: string;
  /** Percent of one core (200 = two cores busy). */
  cpuPercent: number | null;
  memoryBytes: number | null;
  /** What the workspace can use when it has no limit of its own (the host's cores and memory), for scaling a bar. */
  cores?: number | null;
  memoryTotalBytes?: number | null;
}

export interface CreateWorkspaceRequest {
  name: string;
  target: string;
  cpus?: number;
  memoryMb?: number;
  /** Account pool to assign from the start (no confirmation needed: the workspace has no sign-in yet). */
  accountPoolId?: string | null;
  /** The create dialog's Add-ons: pools of each multi-assignment type to assign from the start. */
  pools?: Partial<Record<import('./pools.js').MultiPoolType, string[]>>;
  /** The exact Claude Code version to pin it to (x.y.z); the portal's default pin when absent. Docker targets only. */
  claudeVersion?: string;
  /** An enrolled cluster's node to place it on; the least loaded eligible node when absent (targets-connect PRD §12.8). */
  node?: string;
}

export const WORKSPACE_NAME_MAX = 40;

/** Why a workspace name can't be used, or null when it can. Names become container and DNS names. */
export function workspaceNameProblem(name: string): string | null {
  if (!name) return 'Give it a name.';
  if (name.length > WORKSPACE_NAME_MAX) return `Use at most ${WORKSPACE_NAME_MAX} characters.`;
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/.test(name))
    return 'Lowercase letters, digits and dashes; start with a letter, don’t end with a dash.';
  return null;
}

export const workspaceId = (target: string, name: string) => `${target}/${name}`;

/** What a workspace is called where people see it: its label, else the name it was made with (T-42). */
export const workspaceDisplayName = (w: Pick<Workspace, 'name' | 'label'>): string => w.label || w.name;

export const WORKSPACE_LABEL_MAX = 40;

/** Characters a label never holds: control characters, line and paragraph separators, and bidirectional overrides that make text read backwards. */
const LABEL_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/** A label as it is kept: Unicode-normalized (NFC), spaces at either end trimmed. */
export const normalizeWorkspaceLabel = (label: string): string => label.normalize('NFC').trim();

/**
 * Why a workspace label can't be used, or null when it can (T-42 slice 2). A label is plain text shown as text: 1 to 40 characters, one line,
 * no control or direction-override characters, and no `/` (it separates a target from a name in `<target>/<label>`, which resolves too).
 * Uniqueness on the target is the server's check.
 */
export function workspaceLabelProblem(label: string): string | null {
  const clean = normalizeWorkspaceLabel(label);
  if (!clean) return 'Give it a name.';
  if ([...clean].length > WORKSPACE_LABEL_MAX) return `Use at most ${WORKSPACE_LABEL_MAX} characters.`;
  if (LABEL_FORBIDDEN.test(clean)) return 'One line of plain text: no line breaks or control characters.';
  if (clean.includes('/')) return 'No slashes: a slash separates the target from the name.';
  return null;
}

/** `PATCH WORKSPACE_API.one(id)`: rename a workspace (T-42 slice 2). Only the label changes. */
export interface RenameWorkspaceRequest {
  label: string;
}

/** What a rename answers: both forms of the id, the name it was made with, the label before and now. */
export interface RenameWorkspaceResult {
  id: string;
  stableId: string;
  name: string;
  label: string;
  previous: string;
}

/**
 * CPU and memory of a Kubernetes workspace (T-98, docs/prd/targets-connect.md §25): the limits (`cpus`, `memoryMb`) and what the pod asks
 * the scheduler to reserve (`cpuRequest`, `memoryRequestMb`). CPU in cores (0.25 is 250m), memory in MiB.
 */
export interface WorkspaceResourceValues {
  cpus: number;
  memoryMb: number;
  cpuRequest: number;
  memoryRequestMb: number;
}

/** The bounds a value must keep (the same as a create's, and a request never above its limit). */
export const WORKSPACE_RESOURCE_BOUNDS = {
  cpus: { min: 0.1, max: 64 },
  memoryMb: { min: 256, max: 262_144 },
  cpuRequest: { min: 0.01 },
  memoryRequestMb: { min: 64 },
} as const;

/**
 * Why these values can't be used, per field, or null when they can. CPU in steps of 1m (0.001 core), memory in whole MiB; a request at most
 * its limit. Shared by the web (before it sends) and the server (which decides).
 */
export function workspaceResourcesProblem(v: Partial<Record<keyof WorkspaceResourceValues, unknown>>): Partial<Record<keyof WorkspaceResourceValues, string>> | null {
  const out: Partial<Record<keyof WorkspaceResourceValues, string>> = {};
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
  const milli = (x: number) => Math.abs(Math.round(x * 1000) - x * 1000) < 1e-6;
  const B = WORKSPACE_RESOURCE_BOUNDS;
  const cpus = num(v.cpus);
  const mem = num(v.memoryMb);
  const cpuReq = num(v.cpuRequest);
  const memReq = num(v.memoryRequestMb);
  if (!(cpus >= B.cpus.min && cpus <= B.cpus.max) || !milli(cpus)) out.cpus = `Between ${B.cpus.min} and ${B.cpus.max} cores.`;
  if (!(Number.isInteger(mem) && mem >= B.memoryMb.min && mem <= B.memoryMb.max)) out.memoryMb = `Whole MiB, between ${B.memoryMb.min} and ${B.memoryMb.max}.`;
  if (!(cpuReq >= B.cpuRequest.min) || !milli(cpuReq)) out.cpuRequest = `At least ${B.cpuRequest.min} cores, in steps of 0.001.`;
  else if (!out.cpus && cpuReq > cpus) out.cpuRequest = 'Not above the CPU limit.';
  if (!(Number.isInteger(memReq) && memReq >= B.memoryRequestMb.min)) out.memoryRequestMb = `Whole MiB, at least ${B.memoryRequestMb.min}.`;
  else if (!out.memoryMb && memReq > mem) out.memoryRequestMb = 'Not above the memory limit.';
  return Object.keys(out).length ? out : null;
}

/** When new values take effect: `now` patches the Deployment and the pod restarts (every session in it ends); `next_restart` at its next start. */
export type WorkspaceResourcesApply = 'now' | 'next_restart';

/** `PATCH WORKSPACE_API.resources(id)`: values left out keep what is stored, else what the Deployment has. */
export interface UpdateWorkspaceResourcesRequest extends Partial<WorkspaceResourceValues> {
  apply: WorkspaceResourcesApply;
}

/**
 * The fit check (apps/server/src/workspaces/fit.ts, the rule the retired `scripts/ws-resources.sh` used): the requests of every other pod on the node plus this pod's new requests must stay
 * within what the node can allocate. A running pod is checked on its node (it is recreated there, the old pod gone first); a stopped one on
 * the nodes it may run on. `unavailable`: the portal could not read the node or its pods (it then refuses: it never guesses).
 */
export interface WorkspaceResourcesFit {
  state: 'fits' | 'does_not_fit' | 'unavailable';
  node: string | null;
  otherCpuMilli: number | null;
  otherMemoryMb: number | null;
  wantCpuMilli: number;
  wantMemoryMb: number;
  allocatableCpuMilli: number | null;
  allocatableMemoryMb: number | null;
  /** One line with the numbers, for a refusal and the preview. */
  message: string;
}

/** `GET WORKSPACE_API.resources(id)` and what a PATCH answers. */
export interface WorkspaceResources {
  id: string;
  stableId: string;
  /** Stored on the workspace's record (T-98); null until someone sets them. */
  wanted: WorkspaceResourceValues | null;
  /** What the Deployment has now (a value it does not set is absent). */
  live: Partial<WorkspaceResourceValues>;
  /** Wanted values wait for the workspace's next start. */
  pending: boolean;
  pendingSince: string | null;
  appliedAt: string | null;
  running: boolean;
  /** Why a pending change was not applied at the last start (it did not fit, say). */
  problem: string | null;
  /** The fit check that a PATCH ran; absent on a GET. */
  fit?: WorkspaceResourcesFit;
  /** What this PATCH did: patched (the pod restarts when it ran), stored for the next start, or nothing (the values are what it has). */
  outcome?: 'applied' | 'pending' | 'unchanged';
}

/** A workspace's stable id (T-42): `ws_` and 12 lowercase hex digits. */
export const STABLE_WORKSPACE_ID = /^ws_[0-9a-f]{12}$/;
export const isStableWorkspaceId = (value: unknown): value is string => typeof value === 'string' && STABLE_WORKSPACE_ID.test(value);

/** Shell socket protocol: binary frames carry terminal bytes both ways; text frames are these. */
export type ShellClientMessage = { type: 'resize'; cols: number; rows: number };
export type ShellServerMessage = { type: 'ready' } | { type: 'exit'; code: number | null } | { type: 'error'; message: string };

export const WORKSPACE_API = {
  targets: '/api/workspaces/targets',
  list: '/api/workspaces',
  usage: '/api/workspaces/usage',
  /** GET: `{ [<target>/<name>]: label }` for every workspace that was renamed (T-42), from the portal's records only: no runtime is asked. */
  labels: '/api/workspaces/labels',
  /**
   * `/api/workspaces/<target>/<name>` (+ `/start`, `/stop`, `/shell`). GET on it, or on `/api/workspaces/<stableId>`, answers the one
   * workspace (T-42): both forms resolve through the manager to the same workspace. PATCH `RenameWorkspaceRequest` renames it (its label only).
   */
  one: (id: string) => `/api/workspaces/${id}`,
  /** Claude Code's own sign-in in the workspace: POST starts it, DELETE cancels it. */
  claudeLogin: (id: string) => `/api/workspaces/${id}/claude-login`,
  /** POST `{ code }`: the code the sign-in page showed. */
  claudeLoginCode: (id: string) => `/api/workspaces/${id}/claude-login/code`,
  claudeLogout: (id: string) => `/api/workspaces/${id}/claude-logout`,
  /** GET lists, POST opens one (`CreateTerminalRequest`); DELETE `…/terminals/<terminal>` closes it. */
  terminals: (id: string) => `/api/workspaces/${id}/terminals`,
  /**
   * GET: the workspace's Claudes with their sign-in state (`WorkspaceClaudeState`). PATCH
   * `…/claudes/<claude>` `{ name }` renames one, DELETE removes it. The sign-in routes above take
   * `?claude=<id>` for a Claude other than Default.
   */
  claudes: (id: string) => `/api/workspaces/${id}/claudes`,
  /** GET `WorkspaceResources`; PATCH `UpdateWorkspaceResourcesRequest` (T-98): CPU and memory of a Kubernetes workspace. Either form of the id. */
  resources: (id: string) => `/api/workspaces/${id}/resources`,
} as const;

/**
 * One of the workspace's Claudes as its page shows it: whether Claude Code there is signed in (status
 * and method only, from `claude auth status`; never the account, plan or credential) and how many
 * terminals run as it. `auth` is null when it couldn't be checked (the workspace is stopped).
 */
export interface WorkspaceClaudeState {
  claude: import('./chat.js').WorkspaceClaude;
  auth: ClaudeAuthStatus | null;
  terminals: number;
}

/** How many terminals a workspace keeps open at once (each Claude Code takes a few hundred MB). */
export const TERMINAL_MAX = 8;

/** `claude`: Claude Code, falling back to a shell when it exits; `shell`: a login shell. */
export type TerminalKind = 'claude' | 'shell';

/**
 * A terminal that outlives the browser: a tmux session in the workspace, run as its user with its
 * own Claude sign-in. Several can run side by side; the shell socket attaches with `?term=<id>`.
 */
export interface WorkspaceTerminal {
  /** `claude-1`, `shell-2`, …: the tmux session is `cp-<id>`. */
  id: string;
  kind: TerminalKind;
  /** The folder its current program runs in. */
  cwd: string;
  /** What runs in it now (`claude`, `bash`, `vim`, …). */
  command: string;
  createdAt: string;
  /** Browser tabs (or other clients) attached right now. */
  attached: number;
  /** The Claude it runs as (Workspace Claudes): its directory holds that Claude's own login and chats. */
  claudeId: string;
  claudeName: string;
}

export interface CreateTerminalRequest {
  kind: TerminalKind;
  /** Which Claude on the workspace (its `CLAUDE_CONFIG_DIR`); Default when absent. */
  claudeId?: string;
  /** Where it starts: `~`, `~/work/api` or an absolute path. The home folder when absent. */
  cwd?: string;
}

/** `POST …/claude-login` body: `sso` for organizations that sign in through their identity provider. */
export interface ClaudeLoginRequest {
  sso?: boolean;
  /** Prefill the email on Claude's sign-in page. */
  email?: string;
}

/** `GET …/claude-login`: Claude Code's own sign-in status for a workspace (never the credential). */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  /** Claude Code's `authMethod`: `claudeai`, `console`, `none`, … */
  method: string;
}

/** `POST …/claude-login`: Claude Code's sign-in link, on claude.com. */
export interface ClaudeLoginStart {
  url: string;
}
