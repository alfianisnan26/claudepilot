/**
 * MCP set pool (MCP set PRD): a catalog of reviewed MCP servers, sets that group them, and what each
 * workspace gets. Sets are multi-assignment pools of type `mcpset` (POOLS_API); the catalog and the
 * per-workspace status have their own routes (MCP_API). Nothing here ever holds a secret value: a set
 * names Secrets & env entries as `{{secret-file:NAME}}` (Secrets & env FR21).
 */

/** Catalog entry kinds (FR1). PyPI waits for `uv` in the image (M4); the model keeps room for it. */
export type McpEntryKind = 'npm' | 'pypi' | 'remote' | 'command';
export const MCP_ENTRY_KINDS: readonly McpEntryKind[] = ['npm', 'pypi', 'remote', 'command'];

/** Review states (FR3). Approved versions are immutable: a change makes a new draft (FR4). */
export type McpReviewState = 'draft' | 'approved' | 'deprecated' | 'revoked';

/** Remote transports: streamable HTTP, or the deprecated SSE. */
export type McpTransport = 'http' | 'sse';
export type McpAuthMode = 'none' | 'headers' | 'oauth';

/** Where a slot's value goes (FR2): a stdio server's environment, a remote server's header, or a variable holding a secret file's path. */
export type McpSlotTarget = 'env' | 'header' | 'path';

/** One value a server needs (FR2). Secret slots get a Secrets & env reference in each set, never a value. */
export interface McpSlot {
  /** The variable (env, path) or header name. */
  name: string;
  target: McpSlotTarget;
  secret: boolean;
  required: boolean;
  description?: string;
  docUrl?: string;
  /** Non-secret slots only. */
  default?: string;
  /** Header slots: the value around the placeholder, e.g. `Bearer {value}`. Default `{value}`. */
  template?: string;
}

/** A slot as a request may send it: `target` defaults to env, `secret` and `required` to false (a path slot is always secret). */
export type McpSlotInput = Omit<McpSlot, 'target' | 'secret' | 'required'> & Partial<Pick<McpSlot, 'target' | 'secret' | 'required'>>;

/** Non-secret OAuth fields written to `.mcp.json` (FR1). A client secret is never accepted. */
export interface McpOAuthFields {
  clientId?: string;
  callbackPort?: number;
  scopes?: string[];
  authServerMetadataUrl?: string;
}

/** What a version runs. Which fields apply depends on the entry's kind. */
export interface McpVersionSpec {
  /** npm and PyPI: the package name. */
  package?: string;
  /** npm and PyPI: which of the package's commands to run, when it has several. */
  bin?: string;
  /** npm, PyPI and command: fixed arguments. Never secrets: arguments show in `ps` and logs. */
  args?: string[];
  /** npm: run install scripts (off by default, Q10). */
  allowScripts?: boolean;
  /** command: an absolute path already in the workspace image. */
  path?: string;
  /** remote: the server's URL. */
  url?: string;
  transport?: McpTransport;
  auth?: McpAuthMode;
  oauth?: McpOAuthFields;
  /** remote: allow a private, loopback or link-local address (the SSRF guard refuses them otherwise). */
  allowPrivateNetwork?: boolean;
}

/** A risky pattern the review flags (FR3). */
export interface McpRiskFlag {
  code: string;
  label: string;
}

/** Who proposed a catalog version (I3: the global "add MCP" flow). The reason is untrusted text: show it plain. */
export interface McpProposal {
  /** `portal-mcp:<token id>`, `session:<id>` or `ticket:<id>`: the actor, never a secret. */
  by: string;
  at: string;
  reason: string | null;
}

export interface McpCatalogVersion {
  id: string;
  entryId: string;
  /** The package's exact version for npm and PyPI; `v1`, `v2`, … for remote and command entries. */
  version: string;
  spec: McpVersionSpec;
  slots: McpSlot[];
  reviewState: McpReviewState;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  revokedAt: string | null;
  /** Set when an agent or a token proposed it (I3): who, when and why. Still a draft until a person approves it. */
  proposal: McpProposal | null;
  /** The exact command (stdio) or URL (remote) a workspace runs, untruncated (FR3, US2). */
  command: string;
  /** What the launcher gets as its target: `npm:<pkg>@<version>`, `cmd:<path>`; null for remote servers. */
  target: string | null;
  flags: McpRiskFlag[];
  /** Workspaces that get it now (or still had it at their last delivery): what a revocation reaches. */
  workspaces: number;
  createdAt: string;
  updatedAt: string;
}

/** Where a catalog entry is used. */
export interface McpEntryUse {
  poolId: string;
  poolName: string;
  /** The entry's versions the set's newest and deliverable revisions use. */
  versions: string[];
}

export interface McpCatalogEntry {
  id: string;
  /** The suggested server key in sets: `[a-z0-9-]`, at most 16 characters (FR5). */
  key: string;
  displayName: string;
  description: string;
  kind: McpEntryKind;
  /** The MCP Registry name it was imported from (M3); null for manual entries. */
  registryName: string | null;
  /** Newest first. */
  versions: McpCatalogVersion[];
  sets: McpEntryUse[];
  /** Workspaces that get a set using this entry. */
  workspaces: number;
  createdAt: string;
  updatedAt: string;
}

/** `POST /api/mcp/catalog`: a manual entry with its first version, as a draft. */
export interface McpEntryRequest {
  key: string;
  displayName: string;
  description?: string;
  kind: McpEntryKind;
  /** npm: the exact package version. Remote and command versions are numbered for you. */
  version?: string;
  spec: McpVersionSpec;
  slots?: McpSlotInput[];
}

/**
 * What an agent or a token may ask for (I3): the same fields as a manual entry, plus why. It names the
 * secrets a server needs as slots, never a value. The answer is always a draft waiting for a person.
 */
export interface McpProposalRequest extends McpEntryRequest {
  /** Why the server is wanted, in a sentence or two. Shown to the reviewer as plain text. */
  reason?: string;
}

/** What `proposeEntry` returns. Nothing about it is deliverable until a person approves the version in the portal. */
export interface McpProposalResult {
  entryId: string;
  versionId: string;
  key: string;
  version: string;
  /** Always `waiting_review`: only the portal's review page can approve. */
  status: 'waiting_review';
  /** The proposal made a new catalog entry (false: it added a version to an existing one). */
  newEntry: boolean;
  /** The same actor had already proposed exactly this and it's still waiting: nothing was added. */
  duplicate: boolean;
  proposedBy: string;
  /** Where a person reviews it: a path in the portal's web app (prefix the portal's address). */
  reviewPath: string;
}

/** `PATCH /api/mcp/catalog/:id`: what can change without a review. */
export interface McpEntryUpdate {
  displayName?: string;
  description?: string;
}

/** `POST /api/mcp/catalog/:id/versions` makes a draft; `PUT …/versions/:vid` changes one that's still a draft. */
export interface McpVersionRequest {
  version?: string;
  spec: McpVersionSpec;
  slots?: McpSlotInput[];
}

/** `POST …/versions/:vid/approve`. */
export interface McpApproveRequest {
  /** The reviewer ticked "I reviewed the command and its source" (US2). */
  reviewed: boolean;
  note?: string;
}

/** `POST …/versions/:vid/revoke` (FR13b). */
export interface McpRevokeRequest {
  reason?: string;
}

/** What a revocation reached. */
export interface McpRevokeResult {
  version: McpCatalogVersion;
  /** Workspaces asked to drop it now, pinned ones included. */
  workspaces: string[];
}

/** One server in a set (FR9). `secrets` maps each secret slot to `{{secret-file:NAME}}`. */
export interface McpSetServer {
  /** `[a-z0-9-]`, at most 16 characters (FR5): tools are `mcp__plugin_cpm-<set>_<key>__<tool>`. */
  key: string;
  /** Catalog entry ID. */
  entry: string;
  /** The entry's version. */
  version: string;
  enabled: boolean;
  /** Non-secret slot values. */
  config: Record<string, string>;
  /** Secret slot → `{{secret-file:NAME}}`. */
  secrets: Record<string, string>;
}

/** A set's revision content. */
export interface McpSetContent {
  /** `[a-z0-9-]`, at most 12 characters (FR5): the plugin is `cpm-<slug>`. Fixed once delivered. */
  slug: string;
  servers: McpSetServer[];
}

/** `POST /api/mcp/sets/:poolId/try`: a revision with one entry at another version, held back for trial workspaces (FR4). */
export interface McpTryRequest {
  entry: string;
  version: string;
}

/** What the compiler did with one server in one workspace (§9 `mcp_delivery`). */
export type McpDeliveryState =
  | 'delivered'
  | 'pending_start'
  | 'missing_secret'
  | 'uv_missing'
  | 'blocked_by_policy'
  | 'unsupported'
  | 'claude_too_old'
  | 'held_tools_changed'
  | 'revoked'
  | 'disabled';

export type McpInstallState = 'installing' | 'installed' | 'failed';

/** FR16's outcome for one set's plugin in one workspace. */
export type McpVerifyResult = 'ok' | 'mismatch' | 'not_loaded' | 'not_registered' | 'not_verified' | 'failed';

export interface McpServerStatus {
  poolId: string;
  poolName: string;
  /** `cpm-<slug>`. */
  plugin: string;
  key: string;
  entryName: string;
  version: string;
  /** The launcher target or the URL; null when the catalog no longer has it. */
  target: string | null;
  state: McpDeliveryState;
  reason: string | null;
  /** npm servers: the pre-install (§12). */
  install: { state: McpInstallState; error: string | null; at: string | null } | null;
  /** Whether Claude Code listed it at the last verify; null before one ran. */
  listed: boolean | null;
  updatedAt: string;
}

export interface McpPluginVerify {
  plugin: string;
  result: McpVerifyResult;
  /** Server keys Claude Code listed. */
  servers: string[];
  detail: string | null;
  at: string;
}

/** `GET /api/mcp/workspaces/:target/:name`: the MCP part of a workspace's Configuration row. */
export interface McpWorkspaceStatus {
  workspaceId: string;
  servers: McpServerStatus[];
  verify: McpPluginVerify[];
  /** Secrets & env names the workspace's sets reference that none of its Secrets & env sets provide (US3). */
  missingNames: string[];
  /** FR11 warnings: an entry in two sets, many stdio servers per session. */
  warnings: string[];
}

/** FR19: what an MCP allowlist must admit for the servers a workspace gets (Settings & policies includes them). */
export type McpMatcher = { serverUrl: string } | { serverCommand: string[] };

export const MCP_SLUG_MAX = 12;
export const MCP_SERVER_KEY_MAX = 16;
/** `{{secret-file:NAME}}`, the one reference form for secrets (Secrets & env FR21). */
export const secretFileRef = (name: string) => `{{secret-file:${name}}}`;
export const SECRET_FILE_REF = /^\{\{secret-file:([A-Za-z0-9][A-Za-z0-9._-]{0,63})\}\}$/;

export const MCP_API = {
  catalog: '/api/mcp/catalog',
  entry: (id: string) => `/api/mcp/catalog/${id}`,
  versions: (id: string) => `/api/mcp/catalog/${id}/versions`,
  version: (id: string, versionId: string) => `/api/mcp/catalog/${id}/versions/${versionId}`,
  approve: (id: string, versionId: string) => `/api/mcp/catalog/${id}/versions/${versionId}/approve`,
  deprecate: (id: string, versionId: string) => `/api/mcp/catalog/${id}/versions/${versionId}/deprecate`,
  revoke: (id: string, versionId: string) => `/api/mcp/catalog/${id}/versions/${versionId}/revoke`,
  tryInSet: (poolId: string) => `/api/mcp/sets/${poolId}/try`,
  /** `/api/mcp/workspaces/<target>/<name>` */
  workspace: (workspaceId: string) => `/api/mcp/workspaces/${workspaceId}`,
  retryInstalls: (workspaceId: string) => `/api/mcp/workspaces/${workspaceId}/installs/retry`,
  verify: (workspaceId: string) => `/api/mcp/workspaces/${workspaceId}/verify`,
  matchers: (workspaceId: string) => `/api/mcp/workspaces/${workspaceId}/matchers`,
} as const;
