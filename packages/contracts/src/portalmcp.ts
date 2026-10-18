// Portal MCP server (portal-mcp PRD): the portal's own MCP endpoint, its access tokens and its audit
// trail. The endpoint itself is `/mcp` (MCP protocol, not a REST route); these are the signed-in
// admin's routes that manage it (Access → MCP).

/** Hierarchical scopes of an admin's own tokens (PRD §12.4): each includes the ones before it. */
export type PortalScope = 'read' | 'operate' | 'admin';
export const PORTAL_SCOPES: readonly PortalScope[] = ['read', 'operate', 'admin'];

/** Every caller's scope: an admin's token has one of the three; an agent's per-session token (I8) has `agent`. */
export type PortalCallerScope = PortalScope | 'agent';

/** How many days a token lives; the default is 90 (PRD §12.1). */
export const PORTAL_TOKEN_DAYS = [7, 30, 90, 365] as const;
export type PortalTokenDays = (typeof PORTAL_TOKEN_DAYS)[number];

/**
 * Every lifetime a token may have (T-258): the short ones for automation (a script that mints a token for one run takes `1h`) and the
 * day counts of `PORTAL_TOKEN_DAYS`. `expiresIn` takes one of these; `expiresInDays` stays for the day counts.
 */
export const PORTAL_TOKEN_LIFETIMES = ['15m', '1h', '1d', '7d', '30d', '90d', '365d'] as const;
export type PortalTokenLifetime = (typeof PORTAL_TOKEN_LIFETIMES)[number];
const MINUTE_MS = 60_000;
export const PORTAL_TOKEN_LIFETIME_MS: Record<PortalTokenLifetime, number> = {
  '15m': 15 * MINUTE_MS,
  '1h': 60 * MINUTE_MS,
  '1d': 1440 * MINUTE_MS,
  '7d': 7 * 1440 * MINUTE_MS,
  '30d': 30 * 1440 * MINUTE_MS,
  '90d': 90 * 1440 * MINUTE_MS,
  '365d': 365 * 1440 * MINUTE_MS,
};

/** The shared setting (Settings → MCP): how many live admin-scope tokens one label may have at once (T-258). */
export const PORTAL_TOKEN_CAP_SETTING = 'mcp.tokens.maxActivePerLabel';
export const PORTAL_TOKEN_CAP_DEFAULT = 3;
/** `409`: live tokens with this label exist; the details say how many and the newest one's id and expiry (never a secret). */
export const PORTAL_TOKEN_LABEL_IN_USE = 'TOKEN_LABEL_IN_USE';
/** `409`: the label already has as many live admin tokens as `mcp.tokens.maxActivePerLabel` allows. */
export const PORTAL_TOKEN_CAP = 'TOKEN_CAP';

/** The details of a `TOKEN_LABEL_IN_USE` or `TOKEN_CAP` refusal. */
export interface PortalTokenLabelConflict {
  label: string;
  /** Live tokens with this label (for `TOKEN_CAP`: live admin tokens). */
  live: number;
  newest: { id: string; expiresAt: string };
  /** `TOKEN_CAP` only: the setting's value. */
  max?: number;
}

/** An admin's token: `cpat_` plus 43 base64url characters (256 random bits), stored only as a SHA-256 hash. */
export const PORTAL_TOKEN_PREFIX = 'cpat_';
/**
 * An agent's token (interface I8): minted by the portal for one chat session, passed only in that session's
 * process environment, bound to its workspace and session, alive as long as the session. Never an admin tool.
 */
export const PORTAL_AGENT_TOKEN_PREFIX = 'cpst_';

/**
 * The General Manager's token (T-968 S1, general-manager PRD §4): minted for the person's one `kind = 'manager'` session, only in
 * that process's environment, hashed at rest, at most 7 days. It acts as the person (their `can()`, resolved at use time), never
 * authenticates a web route, and is revoked on disable, remove and any sign-out of the person, on any device.
 */
export const PORTAL_MANAGER_TOKEN_PREFIX = 'cpmt_';

export const PORTAL_TOKEN_LABEL_MAX = 60;

/** An admin's token as the UI lists it. The secret itself is shown once, at creation. */
export interface PortalToken {
  id: string;
  label: string;
  /** `cpat_…3f9a`: enough to recognise it. */
  preview: string;
  scope: PortalScope;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  /**
   * T-1105: where `ticket_create` puts a ticket when the call names no `workspace_id` (`<target>/<name>`), or null for the shared queue.
   * Only an operate or admin token has one, set by a person with manage on the token (`PATCH` `PORTAL_MCP_API.token(id)`), never by a tool.
   */
  defaultWorkspaceId: string | null;
}

/** `PATCH /api/portal-mcp/tokens/:id`: a person changes a live operate or admin token. The workspace must be one they and the token may operate. */
export interface UpdatePortalTokenRequest {
  /** `<target>/<name>`, or null to clear it. */
  defaultWorkspaceId: string | null;
}

export interface CreatePortalTokenRequest {
  label: string;
  scope: PortalScope;
  /** How long it lives (default 90 days). Give this or `expiresInDays`, not both. */
  expiresIn?: PortalTokenLifetime;
  expiresInDays?: PortalTokenDays;
  /**
   * A label names one client, so a label with live tokens is refused (`TOKEN_LABEL_IN_USE`) unless the request says what to do:
   * `replace` revokes the live tokens with this label and mints the new one; `addAnother` keeps them (admin scope: up to the cap).
   */
  replace?: boolean;
  addAnother?: boolean;
}

/** `POST /api/portal-mcp/tokens/revoke-label`: revoke a label's live tokens, all of them or all but the newest. */
export interface RevokePortalTokenLabelRequest {
  label: string;
  /** Keep the newest live one ("Revoke older"). */
  keepNewest?: boolean;
}

export interface RevokePortalTokenLabelResult {
  revoked: number;
}

/** What creating a token returns: the secret (once) and ready-to-paste connections. */
export interface CreatedPortalToken {
  token: PortalToken;
  /** The bearer token. Never returned again. */
  secret: string;
  connect: PortalConnect;
}

/** Ready-to-paste setups for a token (PRD §10.2). `url` is the `/mcp` endpoint as the caller reached the portal. */
export interface PortalConnect {
  url: string;
  claudeCode: string;
  /** The token stays in a file; Claude Code reads it through a headers helper. */
  claudeCodeHelper: string;
  curl: string;
}

export interface PortalMcpSettings {
  /** While off, `/mcp` answers 404 (PRD FR2). */
  enabled: boolean;
  /** Lists the session write tools (`session_start`, `session_send`, …) only while on (PRD FR15). */
  sessionControl: boolean;
  /** How long audit rows are kept. */
  auditDays: number;
}

export interface UpdatePortalMcpSettingsRequest {
  enabled?: boolean;
  sessionControl?: boolean;
  auditDays?: number;
}

/** One call in the audit trail (PRD §17): arguments redacted, never a secret. */
export interface PortalAuditRow {
  id: number;
  at: string;
  requestId: string;
  tokenId: string | null;
  tokenLabel: string | null;
  /** `session:<id>` for an agent, `portal-mcp:<token id>` otherwise. */
  actor: string | null;
  /** Unverified: what the client called itself. */
  client: string | null;
  ip: string | null;
  method: string;
  tool: string | null;
  args: string | null;
  outcome: PortalAuditOutcome;
  errorCode: string | null;
  durationMs: number | null;
  affected: string[];
}

export type PortalAuditOutcome = 'ok' | 'error' | 'denied' | 'rate_limited' | 'confirmation_required' | 'rejected';

/** A tool in the registry, as the UI lists what a token can do. */
export interface PortalToolInfo {
  name: string;
  title: string;
  description: string;
  /** What an admin's token needs (`agent`: the lowest tier, also reachable by agents). */
  scope: PortalCallerScope;
  /** Agents' per-session tokens can call it. */
  agent: boolean;
  readOnly: boolean;
  destructive: boolean;
  /** Listed only while this switch is on (`sessionControl`). */
  requires: 'session_control' | null;
  /** Whether it is listed to callers right now. */
  listed: boolean;
}

/** A workspace and whether its agents may use portal tools ("Agent access to portal tools", default off). */
export interface PortalAgentWorkspace {
  workspaceId: string;
  name: string;
  enabled: boolean;
  /** Per-session tokens alive right now. */
  liveTokens: number;
}

export interface SetAgentAccessRequest {
  enabled: boolean;
}

/** `GET /api/portal-mcp`: everything Access → MCP shows. */
export interface PortalMcpState {
  settings: PortalMcpSettings;
  /** The `/mcp` URL to paste, as this request reached the portal. */
  url: string;
  tokens: PortalToken[];
  /** The latest calls, newest first. */
  activity: PortalAuditRow[];
  /** Calls since midnight, for the header badge. */
  callsToday: number;
  tools: PortalToolInfo[];
  /** How workspaces reach the portal (`PORTAL_INTERNAL_URL`), when set. */
  internalUrl: string | null;
}

/** `POST /api/portal-mcp/revoke-all` and the `mcp_lockdown` tool: what was revoked. */
export interface PortalLockdownResult {
  revoked: number;
  enabled: boolean;
}

export const PORTAL_MCP_API = {
  /** GET: `PortalMcpState`. */
  state: '/api/portal-mcp',
  /** PUT `UpdatePortalMcpSettingsRequest`: switches. */
  settings: '/api/portal-mcp/settings',
  /** POST `CreatePortalTokenRequest`: `CreatedPortalToken`. */
  tokens: '/api/portal-mcp/tokens',
  /** DELETE: revoke one token. PATCH `UpdatePortalTokenRequest`: `PortalToken` (its default workspace). */
  token: (id: string) => `/api/portal-mcp/tokens/${encodeURIComponent(id)}`,
  /** POST `RevokePortalTokenLabelRequest`: `RevokePortalTokenLabelResult`. */
  revokeLabel: '/api/portal-mcp/tokens/revoke-label',
  /** POST: revoke every token (agents' included) and, as `mcp_lockdown` does not, leave MCP on. */
  revokeAll: '/api/portal-mcp/revoke-all',
  /** GET `?tool=&outcome=&tokenId=&before=&limit=`: audit rows, newest first. */
  audit: '/api/portal-mcp/audit',
  /** GET: `PortalAgentWorkspace[]`, every workspace with its switch. */
  agents: '/api/portal-mcp/agents',
  /** PUT `SetAgentAccessRequest` (`<target>/<name>`): turn agent access on or off for a workspace. */
  agent: (workspaceId: string) => `/api/portal-mcp/agents/${workspaceId}`,
} as const;
