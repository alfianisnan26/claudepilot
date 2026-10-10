/** Where an account's key is used: the Anthropic API, or a custom Anthropic-compatible host. */
export type EndpointKind = 'anthropic' | 'custom';

/** Claude Code's model slots a custom host can map to its own model names. */
export interface ModelNames {
  opus?: string;
  sonnet?: string;
  haiku?: string;
  default?: string;
}

export interface Endpoint {
  id: string;
  kind: EndpointKind;
  name: string;
  /** Without a trailing `/`, `/v1` or `/v1/messages`; Claude Code appends `/v1/messages` itself. */
  baseUrl: string;
  modelNames: ModelNames;
  contextTokens: number | null;
  maxOutputTokens: number | null;
  /** The host rejects Claude Code's beta flags (CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS). */
  disableBetas: boolean;
  /** Checks may reach private addresses (LAN, localhost). Off by default. */
  allowPrivateNetwork: boolean;
  accounts: number;
  createdAt: string;
}

/**
 * Exactly one result per check (Account Pool PRD §11.2). `ok` and `rate_limited` mean the key works;
 * `unknown` means it has not been checked yet.
 */
export type CheckResult =
  | 'unknown'
  | 'ok'
  | 'rate_limited'
  | 'invalid'
  | 'no_permission'
  | 'billing'
  | 'spend_limit'
  | 'wrong_path'
  | 'unreachable'
  | 'error';

/**
 * What failover acts on (Account Pool PRD §11.3, §12.2), from probes, checks and admin actions.
 * `cooling` and `exhausted` end at `until`; the others last until a check or probe succeeds.
 */
export type AccountHealthState = 'ok' | 'cooling' | 'exhausted' | 'billing' | 'invalid' | 'attention';

export interface AccountHealth {
  state: AccountHealthState;
  until: string | null;
  /** The provider's message, with the key taken out. */
  detail: string | null;
  at: string | null;
}

export interface Account {
  id: string;
  endpointId: string;
  name: string;
  /** `sk-ant-…a1b2`: never the key itself. */
  masked: string;
  /** Short SHA-256 of the key, to recognize it without seeing it. */
  fingerprint: string;
  /** False after `portal forget-secrets`: the key must be entered again. */
  hasSecret: boolean;
  enabled: boolean;
  notes: string;
  organizationId: string | null;
  anthropicWorkspaceId: string | null;
  check: {
    result: CheckResult;
    /** HTTP status of the last check, when there was one. */
    status: number | null;
    detail: string | null;
    at: string | null;
  };
  health: AccountHealth;
  createdAt: string;
}

export interface AccountsOverview {
  endpoints: Endpoint[];
  accounts: Account[];
  /** Secrets can't be stored or used while the portal is Locked or Frozen. */
  locked: { reason: string } | null;
}

export interface CreateAccountRequest {
  name: string;
  endpointId: string;
  key: string;
  notes?: string;
  /** The admin confirms the key belongs to them or their organization (PRD §6). */
  confirmOwned: boolean;
}

/** Omitted fields stay as they are; a `key` replaces the stored one. */
export interface UpdateAccountRequest {
  name?: string;
  notes?: string;
  enabled?: boolean;
  key?: string;
}

export interface BulkAddAccountsRequest {
  endpointId: string;
  /** One `name|key` per line. */
  lines: string;
  confirmOwned: boolean;
}

export interface BulkAddAccountsResult {
  created: Account[];
  /** 1-based line numbers that were skipped, and why. */
  skipped: { line: number; reason: string }[];
}

export interface EndpointRequest {
  name: string;
  baseUrl: string;
  modelNames?: ModelNames;
  contextTokens?: number | null;
  maxOutputTokens?: number | null;
  disableBetas?: boolean;
  allowPrivateNetwork?: boolean;
}

/** Sticky fill-first: highest-priority healthy account. Sticky spread: the one with the fewest workspaces. */
export type PoolStrategy = 'fill-first' | 'spread';

export interface AccountPool {
  id: string;
  name: string;
  description: string;
  endpointId: string;
  /** In priority order. */
  members: { accountId: string; enabled: boolean }[];
  strategy: PoolStrategy;
  /** Hide /login in assigned workspaces (DISABLE_LOGIN_COMMAND). Off by default. */
  hideLogin: boolean;
  revision: number;
  /** Workspaces assigned to this pool. */
  workspaces: number;
  createdAt: string;
}

export interface AccountPoolRequest {
  name: string;
  description?: string;
  endpointId: string;
  /** Account IDs in priority order. */
  members: string[];
  strategy?: PoolStrategy;
  hideLogin?: boolean;
}

export interface AssignAccountPoolRequest {
  /** Null removes the pool: the workspace goes back to its own sign-in. */
  poolId: string | null;
  /** Required for workspaces that already exist: the pool's key overrides any sign-in there (PRD §13). */
  confirmOverride?: boolean;
}

/** Which pool and account a workspace uses (Account Pool PRD FR10). */
export interface WorkspaceAccountState {
  poolId: string;
  poolName: string;
  accountId: string | null;
  accountName: string | null;
  /** `active`: has a key. `waiting`: no usable account in the pool. `removing`: unassign in progress. */
  state: 'active' | 'waiting' | 'removing';
  /** While waiting: the earliest time an account in the pool is expected back, when known (FR18). */
  waitingUntil: string | null;
  /** Why the account last changed (assigned, failover cause, …). */
  reason: string | null;
  changedAt: string | null;
}

export type DeliveryStatus = 'synced' | 'pending' | 'drifted' | 'failed' | 'locked' | 'frozen' | 'unsupported' | 'none';

/** What the portal last delivered into a workspace (foundation PRD §5). */
export interface WorkspaceDeliveryState {
  status: DeliveryStatus;
  reason: string | null;
  appliedAt: string | null;
  claudeVersion: string | null;
}

/** Credentials and settings the user configured themselves, by name only (foundation §6.6). */
export interface PreflightResult {
  /** Null when the workspace isn't running, so it couldn't be checked. */
  findings: string[] | null;
}

export const ACCOUNT_NAME_MAX = 60;

export const ACCOUNT_API = {
  overview: '/api/accounts',
  create: '/api/accounts',
  bulk: '/api/accounts/bulk',
  one: (id: string) => `/api/accounts/${id}`,
  check: (id: string) => `/api/accounts/${id}/check`,
  /** Admin override (FR19): clear a cooldown or problem state. */
  clearHealth: (id: string) => `/api/accounts/${id}/clear`,
  endpoints: '/api/endpoints',
  endpoint: (id: string) => `/api/endpoints/${id}`,
  endpointModels: (id: string) => `/api/endpoints/${id}/models`,
  pools: '/api/account-pools',
  pool: (id: string) => `/api/account-pools/${id}`,
  /** `/api/workspaces/<target>/<name>/account` */
  workspaceAccount: (workspaceId: string) => `/api/workspaces/${workspaceId}/account`,
  workspacePreflight: (workspaceId: string) => `/api/workspaces/${workspaceId}/preflight`,
  workspaceAdopt: (workspaceId: string) => `/api/workspaces/${workspaceId}/adopt`,
} as const;

/** The built-in endpoint; always present, not editable. */
export const ANTHROPIC_ENDPOINT_ID = 'anthropic';
