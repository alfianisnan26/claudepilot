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

/** An admin's token: `cpat_` plus 43 base64url characters (256 random bits), stored only as a SHA-256 hash. */
export const PORTAL_TOKEN_PREFIX = 'cpat_';
/**
 * An agent's token (interface I8): minted by the portal for one chat session, passed only in that session's
 * process environment, bound to its workspace and session, alive as long as the session. Never an admin tool.
 */
export const PORTAL_AGENT_TOKEN_PREFIX = 'cpst_';

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
}

export interface CreatePortalTokenRequest {
  label: string;
  scope: PortalScope;
  expiresInDays?: PortalTokenDays;
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
  /** DELETE: revoke one token. */
  token: (id: string) => `/api/portal-mcp/tokens/${encodeURIComponent(id)}`,
  /** POST: revoke every token (agents' included) and, as `mcp_lockdown` does not, leave MCP on. */
  revokeAll: '/api/portal-mcp/revoke-all',
  /** GET `?tool=&outcome=&tokenId=&before=&limit=`: audit rows, newest first. */
  audit: '/api/portal-mcp/audit',
  /** GET: `PortalAgentWorkspace[]`, every workspace with its switch. */
  agents: '/api/portal-mcp/agents',
  /** PUT `SetAgentAccessRequest` (`<target>/<name>`): turn agent access on or off for a workspace. */
  agent: (workspaceId: string) => `/api/portal-mcp/agents/${workspaceId}`,
} as const;
