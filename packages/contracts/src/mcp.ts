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
  /** OAuth servers only (§13.3): where the sign-in stands in this workspace's Default Claude; null for the rest. */
  auth?: McpServerAuth | null;
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

/* ---------- OAuth status and guided sign-in (§13.3) ---------- */

/**
 * Where an OAuth server stands in a workspace, as Claude Code itself reports it (`claude mcp get`, or a chat session's
 * `system/init`): it holds the token, the portal never does. `unknown` is "not checked yet" or "can't tell".
 */
export type McpAuthState = 'connected' | 'needs_sign_in' | 'failed' | 'unknown';

export interface McpServerAuth {
  mode: McpAuthMode;
  state: McpAuthState;
  /** One short line: why it failed, or why the state is unknown. Never a URL that carries a code. */
  detail: string | null;
  checkedAt: string | null;
}

/** `GET …/workspaces/:target/:name/auth` (`?claude=<id>`: which of the workspace's Claudes; Default when absent): one row per OAuth server. */
export interface McpAuthEntry {
  plugin: string;
  key: string;
  auth: McpServerAuth;
}

/** Which server a sign-in or sign-out is for: its plugin (`cpm-<set>`) and key, as in `McpServerStatus`. */
export interface McpSignInRequest {
  plugin: string;
  key: string;
}

/** The answer to a sign-in start: open `url`, sign in, then send the address the browser ends on (`complete`). */
export interface McpSignInStart {
  signInId: string;
  /** The provider's authorization page, https (or loopback http for a test provider). */
  url: string;
  /** The address Claude Code listens on, `http://localhost:<port>/callback`: the page that follows sign-in fails to load there, and its address is what `complete` takes. */
  callback: string | null;
  /** Claude Code gives up after 5 minutes; so does the portal. */
  expiresAt: string;
}

/** `POST …/signin/:signInId/complete`: the whole address the browser ended on. It carries the authorization code: used once, never stored, never logged. */
export interface McpSignInComplete {
  redirectUrl: string;
}

/* ---------- Built-in catalogue (mcp-builtin-catalogue PRD) ---------- */

/**
 * How a person signs in to a built-in server (PRD D1). `oauth` is Claude Code's own flow in each workspace: the portal never
 * stores, refreshes or relays a token. A template offers it first where the provider supports it WITHOUT a client secret (dynamic
 * client registration, or a public PKCE client whose ID is not secret). `token` is the fallback: a header filled from a Secrets & env
 * entry, named here, never typed here.
 */
export type McpBuiltinAuth = 'oauth' | 'token';

export type McpBuiltinId = 'github' | 'gitlab' | 'gitea' | 'outline' | 'cloudflare';
export const MCP_BUILTIN_IDS: readonly McpBuiltinId[] = ['github', 'gitlab', 'gitea', 'outline', 'cloudflare'];

/** A non-secret value asked once per instance (a host, an OAuth client ID). Never a token. */
export interface McpBuiltinParam {
  /** `[A-Za-z][A-Za-z0-9]*`; used as `{key}` in a server's `url` and `oauth.authServerMetadataUrl`. */
  key: string;
  /** One or two words. */
  label: string;
  /** InfoTip text, never shown inline. */
  hint?: string;
  /** `url`: an http(s) address without credentials, query or fragment. `text`: letters, digits and `._~@:+=-` (a client ID). */
  kind: 'url' | 'text';
  required: boolean;
  placeholder?: string;
  default?: string;
  /** Asked, stored and used only in this mode (a client ID only for OAuth). Absent: both. */
  auth?: McpBuiltinAuth;
}

/** The OAuth fields of one server (PRD D1): they become the entry's `oauth` block in `.mcp.json` (FR1). */
export interface McpBuiltinOAuth {
  /** The provider registers clients dynamically (RFC 7591): no client ID is needed. False needs `clientIdParam`. */
  dcr: boolean;
  /** The param holding a pre-registered public client's ID. Required when `dcr` is false; optional otherwise. */
  clientIdParam?: string;
  scopes?: string[];
  /** A pre-registered redirect URI needs a fixed loopback port. */
  callbackPort?: number;
  /** https; may use `{param}`. For providers whose metadata is not at the usual place. */
  authServerMetadataUrl?: string;
}

/** The header a token goes in (PRD D4). The portal names a Secrets & env entry for it; it never takes the value. */
export interface McpBuiltinToken {
  header: string;
  /** Around `{value}`, which appears exactly once. Default `Bearer {value}`. */
  template?: string;
  /** The suggested Secrets & env entry name (`GITHUB_TOKEN`): `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Servers with the same slot share one entry. */
  slot: string;
  description?: string;
  docUrl?: string;
}

/**
 * One server of a template: it becomes one catalog entry and one server in the new set.
 * `oauth` and `token` say which modes the server offers; with neither, it needs no sign-in and is offered in both modes.
 */
export interface McpBuiltinServer {
  /** The suggested server key (FR5): `[a-z0-9-]`, at most 16 characters. The instance name is added to the entry's key, not to this. */
  key: string;
  name: string;
  description: string;
  /** `{param}` placeholders; the result passes the catalog's URL checks and the SSRF guard. */
  url: string;
  transport: McpTransport;
  oauth?: McpBuiltinOAuth;
  token?: McpBuiltinToken;
  /** Included unless the person unticks it. */
  default: boolean;
}

export interface McpBuiltinTemplate {
  id: McpBuiltinId;
  name: string;
  /** The web draws an inline SVG per id: no external images. */
  icon: McpBuiltinId;
  /** One short line. */
  summary: string;
  docUrl: string;
  /** In preference order: OAuth first where it works without a client secret. */
  auth: McpBuiltinAuth[];
  params: McpBuiltinParam[];
  servers: McpBuiltinServer[];
  /** Short lines for an InfoTip: prerequisites, how to register the OAuth app. */
  notes: string[];
  /** Bumps when the definition changes: instances then show "Update". */
  version: number;
  /** YYYY-MM-DD the facts were checked against the provider's docs. */
  checkedAt: string;
}

/** One instance made from a template: a set of this name and its catalog entries. Nothing in it is secret. */
export interface McpBuiltinAdded {
  id: string;
  /** The instance's label, part of its entry keys and set name. Empty for the first instance of a template. */
  name: string;
  poolId: string;
  poolName: string;
  /** Catalog entry IDs, one per server. */
  entries: string[];
  auth: McpBuiltinAuth;
  /** Non-secret values only. */
  params: Record<string, string>;
  /** The template's server keys in it. */
  servers: string[];
  /** Token mode: slot → the Secrets & env entry NAME it references. Names, never values. */
  secretNames: Record<string, string>;
  allowPrivateNetwork: boolean;
  templateVersion: number;
  /** The template is newer than this instance. */
  updateAvailable: boolean;
  addedAt: string;
}

export interface McpBuiltinItem {
  template: McpBuiltinTemplate;
  added: McpBuiltinAdded[];
}

/**
 * `POST /api/mcp/builtin/:id/preview` and `/add`. Add is idempotent: the same inputs find the instance they made and change nothing;
 * a newer template, an `instance`, or the name of an existing instance changes it in place (new approved versions, a new set revision).
 */
export interface McpBuiltinAddRequest {
  auth: McpBuiltinAuth;
  /** Values for the template's params; the ones the mode doesn't use are ignored. Defaults fill the gaps. */
  params: Record<string, string>;
  /** Template server keys. Default: the servers marked `default` that the mode supports. */
  servers?: string[];
  /** Label for a further instance: `[a-z0-9-]`, at most 12 characters. Default: none for the first, then 2, 3, … */
  name?: string;
  /** Token mode: slot → Secrets & env entry name, to use another name than the suggested one. */
  secretNames?: Record<string, string>;
  /** Change this instance instead of looking for one with the same inputs. */
  instance?: string;
  /** An explicit tick: the catalog's SSRF guard refuses private, loopback and link-local hosts otherwise. */
  allowPrivateNetwork?: boolean;
}

export interface McpBuiltinPreviewServer {
  /** The template server's key. */
  key: string;
  name: string;
  /** The exact URL a workspace will connect to (PRD FR3: this is what the person consents to). */
  url: string;
  transport: McpTransport;
  /** How a person signs in to it: `oauth` (Claude Code's own flow), `headers` (a token from Secrets & env), or `none`. */
  auth: McpAuthMode;
  /** Header names only, never values. */
  headers: string[];
  /** The OAuth fields that will be pinned in `.mcp.json`; null when none are (dynamic registration needs none, and `auth` still says `oauth`). */
  oauth: McpOAuthFields | null;
  flags: McpRiskFlag[];
}

export interface McpBuiltinPreview {
  servers: McpBuiltinPreviewServer[];
  /** Token mode: the Secrets & env entry each token slot references, and whether such a secret (with a value) exists yet. */
  secretNames: { slot: string; name: string; exists: boolean }[];
  /** The set Add makes (or changes). */
  setName: string;
  /** What Add would do now: make an instance, change one, or nothing. */
  action: 'create' | 'update' | 'unchanged';
  /** The instance it would change; null for `create`. */
  instance: string | null;
}

/** What `add` answers: the instance, and what the call did. */
export interface McpBuiltinAddResult extends McpBuiltinAdded {
  result: 'created' | 'updated' | 'unchanged';
}

export const MCP_BUILTIN_NAME_MAX = 12;

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
  /** GET: every template with its instances (`McpBuiltinItem[]`). */
  builtin: '/api/mcp/builtin',
  /** POST `McpBuiltinAddRequest` → `McpBuiltinPreview` (changes nothing). */
  builtinPreview: (templateId: string) => `/api/mcp/builtin/${templateId}/preview`,
  /** POST `McpBuiltinAddRequest` → `McpBuiltinAddResult`. */
  builtinAdd: (templateId: string) => `/api/mcp/builtin/${templateId}/add`,
  /** GET → `McpAuthEntry[]` as last seen; POST `{plugin?, key?}` asks Claude Code now and answers with the same list (a few seconds). `?claude=<id>` on both. */
  auth: (workspaceId: string) => `/api/mcp/workspaces/${workspaceId}/auth`,
  /** POST `McpSignInRequest` → `McpSignInStart` (`?claude=<id>`). */
  signIn: (workspaceId: string) => `/api/mcp/workspaces/${workspaceId}/signin`,
  /** DELETE cancels a sign-in that is still waiting. */
  signInOne: (workspaceId: string, signInId: string) => `/api/mcp/workspaces/${workspaceId}/signin/${signInId}`,
  /** POST `McpSignInComplete` → `McpServerAuth`. */
  signInComplete: (workspaceId: string, signInId: string) => `/api/mcp/workspaces/${workspaceId}/signin/${signInId}/complete`,
  /** POST `McpSignInRequest` → `McpServerAuth`: Claude Code's own `claude mcp logout` (`?claude=<id>`). */
  signOut: (workspaceId: string) => `/api/mcp/workspaces/${workspaceId}/signout`,
} as const;
