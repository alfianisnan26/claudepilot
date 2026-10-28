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
  /**
   * T-1974: the first-party client this token was issued to by a device flow (`vscode`), or null (absent from an older server) for a token
   * made in Access -> MCP. A client token opens only its own API (`/api/vscode`); `/mcp` refuses it like an unknown token.
   */
  client?: 'vscode' | null;
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

/* ---------- Write-only arguments (T-2866) ---------- */

/** What a write-only argument is shown as wherever a call is kept: the audit row, the chat transcript, an approval card. */
export const WRITE_ONLY_MASK = '[write-only]';

/**
 * The arguments of a Portal MCP tool that carry a value the portal stores and never gives back (a secret's value): masked in the audit row,
 * in the chat transcript's tool row and on an approval card, and left out of the "looks like a secret" refusal (that is what they are for).
 */
export const PORTAL_WRITE_ONLY_ARGS: Readonly<Record<string, readonly string[]>> = {
  pool_secret_set: ['value'],
};

/** The write-only arguments of a tool, by its portal name (`pool_secret_set`) or as Claude Code names it (`mcp__pilot__pool_secret_set`). */
export function writeOnlyArgsOf(toolName: string | null | undefined): readonly string[] {
  if (!toolName) return [];
  const bare = toolName.startsWith('mcp__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
  return Object.hasOwn(PORTAL_WRITE_ONLY_ARGS, bare) ? PORTAL_WRITE_ONLY_ARGS[bare]! : [];
}

/** A tool's bare portal name: `mcp__pilot__pool_create` → `pool_create`. */
const bareToolName = (toolName: string): string => (toolName.startsWith('mcp__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName);

/**
 * A copy of a call's arguments with only its declared write-only ones ({@link PORTAL_WRITE_ONLY_ARGS}) masked. This is what the
 * "looks like a secret" refusal reads: a declared write-only argument is where a secret is meant to go, anything else is still checked.
 */
export function maskDeclaredWriteOnlyArgs<T>(toolName: string | null | undefined, args: T): T {
  const fields = writeOnlyArgsOf(toolName);
  if (!fields.length || !args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const f of fields) if (f in out) out[f] = WRITE_ONLY_MASK;
  return out as T;
}

/** The pool tools whose `content` can carry a value a caller should never have sent (T-2866): it is masked wherever the call is kept. */
const POOL_CONTENT_TOOLS = new Set(['pool_create', 'pool_update']);

/** Keys inside a pool's `content` that can carry a value (a secret's, a variable's, an MCP set's secret slot): masked at any depth. */
const VALUE_KEYS = new Set(['value', 'values', 'newvalue', 'new_value', 'secret', 'secrets', 'key_value', 'keys', 'password', 'token', 'credential', 'credentials']);

const maskValueKeys = (v: unknown, depth: number): unknown => {
  if (depth > 12) return WRITE_ONLY_MASK;
  if (Array.isArray(v)) return v.map((x) => maskValueKeys(x, depth + 1));
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = VALUE_KEYS.has(k.toLowerCase()) ? WRITE_ONLY_MASK : maskValueKeys(x, depth + 1);
  return out;
};

/**
 * A secrets pool's `content` as it may be kept: names only. `names` stays when it is a list of strings, each entry keeps its `kind` and
 * `name` (strings) and boolean options; every other field, at any level, is masked. A secrets pool over MCP is created with names only,
 * so nothing a person needs is lost, and a value sent by mistake is never kept.
 */
const namesOnly = (content: unknown): unknown => {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return WRITE_ONLY_MASK;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(content as Record<string, unknown>)) {
    if (k === 'names' && Array.isArray(v) && v.every((n) => typeof n === 'string')) out[k] = v;
    else if (k === 'entries' && Array.isArray(v))
      out[k] = v.map((e) => {
        if (!e || typeof e !== 'object' || Array.isArray(e)) return WRITE_ONLY_MASK;
        const kept: Record<string, unknown> = {};
        for (const [ek, ev] of Object.entries(e as Record<string, unknown>)) {
          if ((ek === 'kind' || ek === 'name') && typeof ev === 'string') kept[ek] = ev;
          else if (ek === 'options' && ev && typeof ev === 'object' && !Array.isArray(ev) && Object.values(ev).every((o) => typeof o === 'boolean')) kept[ek] = ev;
          else kept[ek] = WRITE_ONLY_MASK;
        }
        return kept;
      });
    else out[k] = WRITE_ONLY_MASK;
  }
  return out;
};

/**
 * A copy of a call's arguments as it may be kept anywhere (the audit row, the chat transcript's tool row, an approval card): its declared
 * write-only arguments masked, and for `pool_create` and `pool_update` every value-bearing field of `content` masked too (T-2866). For a
 * secrets pool (`type` "secrets", in any case) the content keeps names only. Anything that is not an object comes back as it is.
 */
export function maskWriteOnlyArgs<T>(toolName: string | null | undefined, args: T): T {
  const declared = maskDeclaredWriteOnlyArgs(toolName, args);
  if (!toolName || !POOL_CONTENT_TOOLS.has(bareToolName(toolName))) return declared;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return declared;
  const out: Record<string, unknown> = { ...(declared as Record<string, unknown>) };
  if (!('content' in out)) return out as T;
  const secrets = typeof out.type === 'string' && out.type.trim().toLowerCase() === 'secrets';
  out.content = secrets ? namesOnly(out.content) : maskValueKeys(out.content, 0);
  return out as T;
}
