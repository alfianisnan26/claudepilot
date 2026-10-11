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
}

export type WorkspaceStatus = 'creating' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

export interface Workspace {
  /** `<target>/<name>`: names are unique within a target. */
  id: string;
  name: string;
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

/** Shell socket protocol: binary frames carry terminal bytes both ways; text frames are these. */
export type ShellClientMessage = { type: 'resize'; cols: number; rows: number };
export type ShellServerMessage = { type: 'ready' } | { type: 'exit'; code: number | null } | { type: 'error'; message: string };

export const WORKSPACE_API = {
  targets: '/api/workspaces/targets',
  list: '/api/workspaces',
  usage: '/api/workspaces/usage',
  /** `/api/workspaces/<target>/<name>` (+ `/start`, `/stop`, `/shell`). */
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
