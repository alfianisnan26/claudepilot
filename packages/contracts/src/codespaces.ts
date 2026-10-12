/**
 * GitHub Codespaces as a workspace target, the POC (docs/prd/codespaces-poc.md). This file is the contract between the server's
 * provider (apps/server/src/codespaces, K1), the devcontainer side (K2) and the UI (K3).
 *
 * Two halves:
 * - GITHUB CONNECTIONS: a person connects their GitHub account to the portal, either by pasting a token (manual) or through GitHub's
 *   OAuth DEVICE FLOW with only a client ID (no client secret anywhere in the portal). Either way the token is a normal sealed secret
 *   in a Secrets & env set; a connection only points at it. The token is used only by people who may operate that set (the person
 *   who connected it, or someone it was explicitly shared with through the authorization seam).
 * - CODESPACES: the lifecycle through GitHub's REST API (list, create, get, start, stop, delete) for one connection, and the
 *   portal's own record of which codespaces it created or adopted ("attached"), so Detach (forget) and Delete (delete at GitHub)
 *   are different acts.
 * Values never cross this contract: no token, no device code, no client secret.
 */

/* ---------- Connections ---------- */

export type GitHubConnectMethod = 'token' | 'device';

/**
 * What the last real check against GitHub found (never a stored flag):
 * - connected: `GET /user` and `GET /user/codespaces` both answered 200;
 * - limited: the token signs in but cannot list codespaces (missing `codespace` scope or Codespaces permission, or an org policy);
 * - invalid: GitHub answered 401 (revoked, expired, wrong);
 * - unknown: not checked yet, or GitHub could not be reached (rate limit, network): the last good state is NOT assumed.
 */
export type GitHubConnectionState = 'connected' | 'limited' | 'invalid' | 'unknown';

export interface GitHubConnectionCheck {
  state: GitHubConnectionState;
  /** One short line: what failed and what to do. Never a token, never a GitHub response body. */
  detail: string | null;
  checkedAt: string | null;
}

export interface GitHubConnection {
  id: string;
  /** The person who connected it (a user id). Others see it only through a share of its secret set. */
  ownerId: string;
  method: GitHubConnectMethod;
  /** github.com, or a GHE.com data-residency host. */
  host: string;
  /** The GitHub login the token belongs to, from `GET /user` at the last check. */
  login: string | null;
  /** Classic scopes from `X-OAuth-Scopes` (OAuth and classic tokens); null for fine-grained tokens, which carry no scope header. */
  scopes: string[] | null;
  /** What the device flow asked for (device method only). */
  requestedScopes: string[] | null;
  /** The token's kind by its prefix: `github_pat`, `gho`, `ghu`, `ghp` (classic), or null when unrecognized. */
  tokenType: 'github_pat' | 'gho' | 'ghu' | 'ghp' | null;
  /** Where the token lives: a secret entry in a Secrets & env set. */
  /** `madeHere`: the portal created the set for this connection (Disconnect may delete it); false for a secret the person pointed at. */
  secret: { poolId: string; poolName: string; entryId: string; entryName: string; hint: string | null; madeHere: boolean };
  check: GitHubConnectionCheck;
  connectedAt: string;
}

/** `POST CODESPACES_API.connections`: paste a token (stored into a new set), or point at a secret that already holds one. */
export type GitHubConnectRequest =
  | { method: 'token'; token: string; host?: string }
  | { method: 'secret'; poolId: string; entryName: string; host?: string };

/**
 * `DELETE CODESPACES_API.connection`: forget the connection. `deleteSecret: true` also deletes the secret set the portal made for it (refused
 * while a workspace has that set). The token stays valid AT GITHUB: the portal cannot revoke a device-flow token without a client secret,
 * so the panel links to the person's GitHub settings (PRD §11).
 */
export interface GitHubDisconnectRequest {
  deleteSecret?: boolean;
}

/* ---------- Device flow ---------- */

export type DeviceFlowState = 'pending' | 'connected' | 'denied' | 'expired' | 'cancelled' | 'failed';

/** One device flow, as the portal shows it. The device code itself never leaves the server. */
export interface DeviceFlowView {
  id: string;
  state: DeviceFlowState;
  /** `ABCD-1234`: what the person types at the verification page. Shown only while pending. */
  userCode: string | null;
  /** `https://github.com/login/device`. */
  verificationUri: string;
  expiresAt: string;
  /** Seconds between polls the server currently uses (grows on `slow_down`). */
  interval: number;
  requestedScopes: string[];
  /** Set once connected. */
  connectionId: string | null;
  /** One short line for denied, expired and failed. */
  detail: string | null;
}

/** `GET CODESPACES_API.status`: what the panel needs first. */
export interface CodespacesStatus {
  device: {
    /** False when PORTAL_GITHUB_CLIENT_ID is unset: the panel then offers the token path only and says why. */
    available: boolean;
    reason: string | null;
    scopes: string[];
    host: string;
  };
  connections: GitHubConnection[];
  /** A flow of the asker's that is still pending, so a closed dialog can be reopened. */
  pendingFlow: DeviceFlowView | null;
}

/* ---------- Codespaces ---------- */

/** GitHub's codespace states (REST API `codespace.state`, OpenAPI 1.1.4, read 2026-10-12). */
export const GITHUB_CODESPACE_STATES = [
  'Unknown', 'Created', 'Queued', 'Provisioning', 'Available', 'Awaiting', 'Unavailable', 'Deleted', 'Moved',
  'Shutdown', 'Archived', 'Starting', 'ShuttingDown', 'Failed', 'Exporting', 'Updating', 'Rebuilding',
] as const;
export type GitHubCodespaceState = (typeof GITHUB_CODESPACE_STATES)[number];

/** The portal's lifecycle words for a codespace (PRD §7). `busy` = an operation is under way that is neither starting nor stopping. */
export type CodespacePhase = 'creating' | 'starting' | 'running' | 'stopping' | 'stopped' | 'busy' | 'error' | 'removed' | 'unknown';

export interface CodespaceMachine {
  name: string;
  displayName: string;
  cpus: number;
  memoryBytes: number;
  storageBytes: number;
  /** `ready`, `in_progress`, `none`, or null when GitHub does not say. */
  prebuild: string | null;
}

export interface CodespaceView {
  /** GitHub's unique codespace name (its id in every path). */
  name: string;
  displayName: string | null;
  repo: string;
  ref: string | null;
  state: GitHubCodespaceState;
  phase: CodespacePhase;
  machine: CodespaceMachine | null;
  devcontainerPath: string | null;
  location: string | null;
  idleTimeoutMinutes: number | null;
  /** Org policy overrode the idle timeout (GitHub's notice text, clipped). */
  idleTimeoutNotice: string | null;
  retentionPeriodMinutes: number | null;
  /** When GitHub will delete it on its own (stopped and unused); null when not scheduled. */
  retentionExpiresAt: string | null;
  /** Why GitHub stopped it, when it says (for example a spending limit reached). */
  stopNotice: string | null;
  /** True while GitHub runs an operation: the only thing allowed then is Delete. */
  pendingOperation: boolean;
  git: { ref: string | null; ahead: number; behind: number; uncommitted: boolean; unpushed: boolean } | null;
  webUrl: string | null;
  billableOwner: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  /** The portal created or adopted it; Detach clears this, the codespace stays. */
  attached: boolean;
  /** The connection it is reached through. */
  connectionId: string;
}

export interface CodespaceRepo {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
}

/** `GET CODESPACES_API.options`: what the create form offers for one repository and ref. */
export interface CodespaceCreateOptions {
  repo: CodespaceRepo;
  devcontainers: { path: string; name: string | null }[];
  machines: CodespaceMachine[];
  defaults: { location: string | null; devcontainerPath: string | null; billableOwner: string | null } | null;
  limits: typeof CODESPACE_LIMITS;
}

/** `POST CODESPACES_API.codespaces`. */
export interface CodespaceCreateRequest {
  /** `owner/name`. */
  repo: string;
  ref?: string;
  machine?: string;
  devcontainerPath?: string;
  idleTimeoutMinutes?: number;
  retentionPeriodMinutes?: number;
  displayName?: string;
  geo?: 'EuropeWest' | 'SoutheastAsia' | 'UsEast' | 'UsWest';
}

/** `DELETE CODESPACES_API.codespace`: the person types the codespace's name to confirm (it deletes uncommitted work at GitHub). */
export interface CodespaceDeleteRequest {
  confirm: string;
}

/** Cost and quota: GitHub's codespace API exposes none of it (PRD §6 F17); the panel says so instead of guessing. */
export interface CodespaceBilling {
  available: false;
  reason: string;
}

/** Limits from GitHub's docs (PRD §6): the server refuses values outside them before calling GitHub. */
export const CODESPACE_LIMITS = {
  idleTimeoutMinutes: { min: 5, max: 240, default: 30 },
  retentionPeriodMinutes: { min: 0, max: 43_200, default: 43_200 },
  displayNameMax: 48,
} as const;

/** The routes (all under the session guard; mutating ones need the Origin check like every route). */
export const CODESPACES_API = {
  status: '/api/codespaces',
  connections: '/api/codespaces/connections',
  connection: '/api/codespaces/connections/:id',
  check: '/api/codespaces/connections/:id/check',
  device: '/api/codespaces/device',
  deviceFlow: '/api/codespaces/device/:flowId',
  repos: '/api/codespaces/connections/:id/repos',
  options: '/api/codespaces/connections/:id/repos/:owner/:repo/options',
  codespaces: '/api/codespaces/connections/:id/codespaces',
  codespace: '/api/codespaces/connections/:id/codespaces/:name',
  start: '/api/codespaces/connections/:id/codespaces/:name/start',
  stop: '/api/codespaces/connections/:id/codespaces/:name/stop',
  attach: '/api/codespaces/connections/:id/codespaces/:name/attach',
  detach: '/api/codespaces/connections/:id/codespaces/:name/detach',
  billing: '/api/codespaces/connections/:id/billing',
} as const;
