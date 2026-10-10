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

export const ACCOUNT_NAME_MAX = 60;

export const ACCOUNT_API = {
  overview: '/api/accounts',
  create: '/api/accounts',
  bulk: '/api/accounts/bulk',
  one: (id: string) => `/api/accounts/${id}`,
  check: (id: string) => `/api/accounts/${id}/check`,
  endpoints: '/api/endpoints',
  endpoint: (id: string) => `/api/endpoints/${id}`,
  endpointModels: (id: string) => `/api/endpoints/${id}/models`,
} as const;

/** The built-in endpoint; always present, not editable. */
export const ANTHROPIC_ENDPOINT_ID = 'anthropic';
