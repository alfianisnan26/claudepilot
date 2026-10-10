/** How a target runs workspaces. */
export type RuntimeKind = 'docker' | 'kubernetes';

/** A place workspaces can run: a Docker daemon or a Kubernetes namespace. */
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
} as const;

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
