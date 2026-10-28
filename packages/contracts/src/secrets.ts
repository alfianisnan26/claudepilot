/**
 * Secrets & env (secrets-env-pool PRD): what a secret set holds as the API shows it, and the rules the
 * server and the editor share: names and limits (FR3), reserved names (FR4), the Claude credential
 * check (FR5), the "looks like a credential" check (FR6) and the names remote MCP servers can't use
 * (FR24). The server is the authority; the editor runs the same checks to say so before saving.
 */

/** S1 has variables and secrets. Tool logins (GitHub, npm, …) join as further kinds in S2. */
export type SecretEntryKind = 'variable' | 'secret';

/** A secret value's metadata (write-only API, PRD §13): never the value, nor anything it can be read back from. */
export interface SecretValueInfo {
  /** 1, 2, 3…: replacing a value adds a version; versions never change. */
  version: number;
  /** `ghp_…a1b2`, `…a1b2` (20 characters or more), else `••••••`. */
  hint: string;
  /** 8 hex characters of an HMAC of the value under a key derived from the portal's secret key (A11). */
  fingerprint: string;
  /** Size in bytes (UTF-8). */
  length: number;
  /** What it looks like (`github`, `pem`, `jwt`, …) when that's recognizable. */
  type: SecretCredentialType | null;
  createdAt: string;
  /** False once `portal forget-secrets` cleared it: enter it again. */
  stored: boolean;
  /** When the provider (or the admin) says it stops working (FR8): warned about 14 and 3 days before. */
  expiresAt?: string | null;
  /** Revoked here (FR16): it is never delivered, restored or pinned to again; the entry needs a new value. */
  revokedAt?: string | null;
}

/** A secret's delivery options (FR2). */
export interface SecretOptions {
  /** A variable holding the secret file's path, for tools that take a path. */
  pathVariable?: string;
  /** Also a variable named like the entry, so any command can print it ("agent-readable"). */
  expose?: boolean;
  /** The exposed variable reaches terminals too (`env.sh`), not only Claude Code. */
  terminals?: boolean;
  /** `node:node 0400` instead of `root:node 0440`, for tools that insist on owning their key file (libpq). */
  ownerOnly?: boolean;
}

/** One entry as the API shows it (`PoolSummary.content.entries`). Valid input for saving, as it is. */
export interface SecretEntryView {
  /** Stable across renames; values follow it. */
  id: string;
  kind: SecretEntryKind;
  /** Variables: an environment variable name. Secrets: the file name under `files/`. */
  name: string;
  /** Variables: the plain value, visible to anyone who can open the portal. */
  value?: string;
  /** Variables: a value that looks like a credential stays a variable only once confirmed (FR6). */
  confirmed?: boolean;
  /** Secrets. */
  options?: SecretOptions;
  /** Secrets: the current value's metadata; null while the entry needs a value. */
  secret?: SecretValueInfo | null;
}

/** One entry as the editor sends it: its view, with a write-only `newValue` for a secret's new value. */
export interface SecretEntryInput extends Omit<Partial<SecretEntryView>, 'kind' | 'name'> {
  kind: SecretEntryKind;
  name: string;
  /** A new value for a secret, added as its next version. Left out, the current value stays. */
  newValue?: string;
  /** When the new value stops working, if known (FR8). Only read together with `newValue`. */
  newValueExpiresAt?: string | null;
}

/** A secret set's content (`PoolSummary.content` for type `secrets`). */
export interface SecretsContent {
  entries: SecretEntryView[];
}

/** What `PUT /api/pools/secrets/:id` takes as `content`. */
export interface SecretsContentInput {
  entries: SecretEntryInput[];
}

/* ---------- The workspace's Configuration row ---------- */

/** What one assigned set delivers into a workspace: names only, never values. */
export interface WorkspaceSecretSet {
  poolId: string;
  poolName: string;
  revision: number;
  variables: string[];
  /** Secrets, each as `/etc/claudepilot/secrets/files/<name>`. */
  files: string[];
  /** Secrets also exposed as variables. */
  exposed: string[];
  /** Path variables pointing at secret files. */
  pointers: string[];
  /** Secrets left out until someone enters their value. */
  needsValue: string[];
}

/** `GET /api/workspaces/:target/:name/secrets`. */
export interface WorkspaceSecrets {
  workspaceId: string;
  sets: WorkspaceSecretSet[];
  /**
   * Variables taken away while Claude Code sessions that started before still run: they keep a safe value
   * (`""`) until those sessions end (A6). A restart finishes it.
   */
  removing: string[];
  /** Some secret is exposed as a variable, so `Read(//proc/**\/environ)` is denied too (A1). */
  exposesVariables: boolean;
}

/** One home-folder credential the migration check found (FR15), by existence only. */
export interface SecretsMigrationFinding {
  /** Stable key, such as `file:.git-credentials`, `export:.bashrc:GH_TOKEN` or `helper:store`. */
  id: string;
  /** What was found, as shown. */
  label: string;
  /** What wins while a set is assigned, and how to clean it up (PRD §10.6). */
  cleanup: string;
}

/** `POST /api/workspaces/:target/:name/secrets/check`. */
export interface SecretsMigrationCheck {
  /** Null when the workspace isn't running, so it couldn't be checked. */
  findings: SecretsMigrationFinding[] | null;
  checkedAt: string;
}

/* ---------- Rotation, versions, revocation and deletion (S2: FR16 to FR20) ---------- */

/** `POST /api/secrets/:poolId/entries/:entryId/rotate`: the new value is write-only, like every secret. */
export interface SecretRotateRequest {
  value: string;
  note?: string;
  /** FR16, A14: also moves the workspaces pinned to an older revision to the new value, at once. */
  urgent?: boolean;
  /** When the new value stops working, if the provider says (FR8). */
  expiresAt?: string | null;
}

/** Where one workspace stands with a rotation (FR17). */
export type RotationState = 'confirmed' | 'pending' | 'pinned' | 'failed';

export interface RotationWorkspace {
  workspaceId: string;
  state: RotationState;
  /** Why it isn't confirmed: the pin, or the delivery status and its reason. */
  detail: string | null;
}

/** The tracker for one rotation (FR17): who has the new value, and when the old one is safe to revoke. */
export interface SecretRotationView {
  id: string;
  poolId: string;
  entryId: string;
  entryName: string;
  fromVersion: number | null;
  toVersion: number;
  urgent: boolean;
  startedAt: string;
  /** When every workspace that gets the set had the new value: the old one can be revoked at its provider. Null until then. */
  safeAt: string | null;
  note: string;
  /** The old version is revoked here already: it will not be delivered again. */
  fromRevoked: boolean;
  workspaces: RotationWorkspace[];
  counts: Record<RotationState, number>;
}

/** One version of a secret (FR16, FR18): what identifies it without showing it, and where it is. */
export interface SecretVersionView {
  id: string;
  version: number;
  hint: string;
  fingerprint: string;
  length: number;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  /** False once cleared (`portal forget-secrets`) or purged (nothing used it for 30 days). */
  stored: boolean;
  /** The version workspaces following the set get now. */
  current: boolean;
  /** Workspaces pinned to a revision that holds it. */
  pinned: string[];
  /** Workspaces that have it now, as the engine delivered it (exposure records, foundation §5). */
  workspaces: string[];
}

/** `POST /api/secrets/:poolId/values/:valueId/revoke`. */
export interface SecretRevokeRequest {
  reason?: string;
}

/** `DELETE /api/pools/secrets/:id?unassign=1` (FR19): the workspaces it was removed from, and what the removal warns about. */
export interface SecretDeleteResult {
  workspaces: string[];
  warnings: string[];
}

export const SECRETS_API = {
  workspace: (workspaceId: string) => `/api/workspaces/${workspaceId}/secrets`,
  check: (workspaceId: string) => `/api/workspaces/${workspaceId}/secrets/check`,
  rotate: (poolId: string, entryId: string) => `/api/secrets/${poolId}/entries/${entryId}/rotate`,
  rotations: (poolId: string) => `/api/secrets/${poolId}/rotations`,
  versions: (poolId: string, entryId: string) => `/api/secrets/${poolId}/entries/${entryId}/versions`,
  revoke: (poolId: string, valueId: string) => `/api/secrets/${poolId}/values/${valueId}/revoke`,
} as const;

/* ---------- Names, paths and limits (FR3) ---------- */

export const SECRETS_DIR = '/etc/claudepilot/secrets';
export const SECRETS_ENV_SH = `${SECRETS_DIR}/env.sh`;
/** Where a secret's value lands; `{{secret-file:NAME}}` resolves to it (FR21). */
export const secretFilePath = (name: string) => `${SECRETS_DIR}/files/${name}`;

/** Environment variable names. */
export const SECRET_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Entry and file names. */
export const SECRET_ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const SECRET_LIMITS = {
  /** A variable's value: one line. */
  variableBytes: 8 * 1024,
  /** A secret's value or file. */
  secretBytes: 256 * 1024,
  /** Everything the sets deliver into one workspace: its share of the 1 MiB Kubernetes Secret (A12). */
  workspaceBytes: 384 * 1024,
  entries: 200,
} as const;

/* ---------- Write-only over Portal MCP (T-2866, PILOT-996 S3) ---------- */

/**
 * An environment-style name (`AWS_ACCESS_KEY_ID`): upper case, digits and `_`, starting with a letter. A secret with such a name is
 * meant to be read as a variable, so `pool_secret_set` exposes it unless told otherwise, and `pool_get` warns when one is stored without
 * `expose` (T-2823: keys stored with options `{}` were delivered as files only and never reached the environment).
 */
export const SECRET_ENV_STYLE_NAME = /^[A-Z][A-Z0-9_]*$/;

/** `expose` when the caller does not say: true for an environment-style name that may be a variable (not reserved, FR4). */
export const secretExposeDefault = (name: string): boolean => SECRET_ENV_STYLE_NAME.test(name) && SECRET_VARIABLE_NAME.test(name) && secretVariableReserved(name) === null;

/** The secrets of a set's content (as `PoolSummary.content` shows it) with an environment-style name that are not exposed as a variable. */
export function unexposedEnvSecrets(content: unknown): string[] {
  const entries = (content as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e): e is SecretEntryView => !!e && typeof e === 'object' && (e as SecretEntryView).kind === 'secret')
    .filter((e) => secretExposeDefault(e.name) && e.options?.expose !== true)
    .map((e) => e.name);
}

/** Why a write over Portal MCP to a protected pool is refused; the approval card that lifts it is PILOT-1000 (S4). */
export const PROTECTED_POOL_REASON = "protected pool: needs a person's approval (PILOT-1000)";

/**
 * A pool an agent or a token may not write to over Portal MCP (T-2866): one whose name has the word `prd`, `prod` or `production`
 * (in any case; split on anything but letters and digits, on a lower-to-upper case change and between letters and digits: `konfersi-prd`,
 * `prod_keys`, `KonfersiPRD`, `prodKeys`, `PRDKeys`, `prod2`), or whose description carries `[protected]`. A word that only contains them
 * (`product`) is not one. Pools have no protected flag of their own yet; this marks them without a migration, and a person adds
 * `[protected]` to any other pool.
 */
export function isProtectedPool(p: { name: string; description?: string | null }): boolean {
  const words = p.name
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])|([0-9])([A-Za-z])/g, (_m, a, b, c, d) => (a ? `${a} ${b}` : `${c} ${d}`))
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  if (words.some((w) => w === 'prd' || w === 'prod' || w === 'production')) return true;
  return /\[protected\]/i.test(p.description ?? '');
}

/* ---------- Reserved names (FR4) ---------- */

const PROXY = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'FTP_PROXY']);
const RUNTIME = new Set(['PATH', 'HOME', 'SHELL', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'PROMPT_COMMAND']);
const TLS = new Set(['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS']);
/** The §10.2 pointers: tool logins set them to the portal's files. */
const POINTERS = new Set([
  'GH_CONFIG_DIR',
  'NPM_CONFIG_GLOBALCONFIG',
  'DOCKER_CONFIG',
  'REGISTRY_AUTH_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_EC2_METADATA_DISABLED',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  'CLOUDSDK_CORE_PROJECT',
  'KUBECONFIG',
]);

/**
 * Variables that would outrank a tool login's file, reserved while a set holds that login (FR4). Keyed
 * by login kind; tool logins arrive in S2, so nothing reserves these yet.
 */
export const SECRET_LOGIN_RESERVED: Record<string, readonly string[]> = {
  github: ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'],
  aws: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE'],
  gcp: ['CLOUDSDK_AUTH_ACCESS_TOKEN_FILE'],
};

/**
 * Why a variable name can't be used, or null (FR4). Covers the names this pool keeps away from on its own;
 * the server also refuses every name another owner declares in the env registry (A2).
 */
export function secretVariableReserved(name: string): string | null {
  const upper = name.toUpperCase();
  if (/^(ANTHROPIC|CLAUDE|CLAUDEPILOT|MCP|DISABLE)_/.test(upper) || upper === 'CLAUDEPILOT') return 'Claude Code and the portal read this name.';
  if (RUNTIME.has(name) || name.startsWith('LD_')) return 'It changes how every program in the workspace starts.';
  if (PROXY.has(upper)) return 'Proxy settings belong to Settings & policies.';
  if (TLS.has(name) || name.startsWith('SSL_CERT_') || name.endsWith('_CA_BUNDLE') || name.startsWith('GIT_SSL_')) return 'TLS settings belong to Settings & policies.';
  if (name.startsWith('GIT_CONFIG') || name.startsWith('GIT_SSH') || name.endsWith('_ASKPASS') || name === 'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES')
    return 'It can make tools run commands.';
  if (POINTERS.has(name)) return 'Tool logins set it.';
  return null;
}

/* ---------- Claude credentials (FR5) ---------- */

export const CLAUDE_CREDENTIAL_MESSAGE = 'This looks like a Claude sign-in or an Anthropic key. Anthropic API keys belong in Account Pool.';

/** `sk-ant-` (api, admin, oat, ort and every other kind) and the `.credentials.json` key. */
const CLAUDE_NEEDLE = /sk-ant-|claudeaioauth/i;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Runs that may be base64 or base64url (12 characters hold 9 bytes, more than `sk-ant-`). */
const B64_RUN = /[A-Za-z0-9+/_-]{12,}={0,2}/g;

/** Base64 or base64url to bytes, as a latin1 string; null when it isn't. Portable (no Buffer, no atob). */
function fromBase64(input: string): string | null {
  const s = input.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (s.length < 8 || s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) return null;
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    acc = ((acc << 6) | B64.indexOf(ch)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
}

/** `%73%6B` → bytes as latin1, leniently: a stray `%` stays. */
const fromPercent = (s: string) => s.replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** JSON (and JavaScript) string escapes: `-`, `\x2d`, `\/`, `\"`. */
const fromEscapes = (s: string) =>
  s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(.)/g, '$1');

function claudeIn(text: string, base64Left: number, depth: number): boolean {
  if (CLAUDE_NEEDLE.test(text)) return true;
  if (depth >= 6) return false;
  if (text.includes('%')) {
    const decoded = fromPercent(text);
    if (decoded !== text && claudeIn(decoded, base64Left, depth + 1)) return true;
  }
  if (text.includes('\\')) {
    const decoded = fromEscapes(text);
    if (decoded !== text && claudeIn(decoded, base64Left, depth + 1)) return true;
  }
  if (base64Left > 0) {
    for (const [run] of text.matchAll(B64_RUN)) {
      // A run may start before the encoded part: one of four offsets lines the decoder up with it.
      for (let offset = 0; offset < 4; offset++) {
        const decoded = fromBase64(run.slice(offset));
        if (decoded && claudeIn(decoded, base64Left - 1, depth + 1)) return true;
      }
    }
  }
  return false;
}

/**
 * Whether a value holds a Claude credential (FR5): `sk-ant-` or `claudeAiOauth`, raw or decoded (base64 and
 * base64url to two levels, URL-encoded, JSON-escaped, in any mix). Every `sk-ant-` value is refused, even an
 * app's key: it would reach every process in the workspace, Claude Code included (PRD §4).
 */
export function hasClaudeCredential(value: string): boolean {
  return claudeIn(value, 2, 0);
}

/* ---------- Credential-looking values (FR6) ---------- */

export type SecretCredentialType = 'github' | 'gitlab' | 'npm' | 'aws' | 'slack' | 'stripe' | 'google' | 'pem' | 'jwt' | 'random';

export const SECRET_CREDENTIAL_LABEL: Record<SecretCredentialType, string> = {
  github: 'GitHub token',
  gitlab: 'GitLab token',
  npm: 'npm token',
  aws: 'AWS access key',
  slack: 'Slack token',
  stripe: 'Stripe key',
  google: 'Google API key',
  pem: 'private key or certificate',
  jwt: 'signed token (JWT)',
  random: 'random-looking secret',
};

const SHAPES: [RegExp, SecretCredentialType][] = [
  [/(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/, 'github'],
  [/(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/, 'gitlab'],
  [/(?<![A-Za-z0-9])npm_[A-Za-z0-9]{20,}/, 'npm'],
  [/(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/, 'aws'],
  [/(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/, 'slack'],
  [/(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/, 'stripe'],
  [/(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/, 'google'],
  [/-----BEGIN [A-Z0-9 ]{1,40}-----/, 'pem'],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/, 'jwt'],
];

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

/**
 * What a value looks like, when it looks like a credential (FR6): a known prefix (`ghp_`, `npm_`, `AKIA`, …),
 * a PEM header, a JWT, or 20+ random-looking characters in a row (letters and digits, no separators, high
 * entropy, so paths, UUIDs and names don't count). Null for anything else.
 */
export function secretCredentialType(value: string): SecretCredentialType | null {
  for (const [re, type] of SHAPES) if (re.test(value)) return type;
  for (const [run] of value.matchAll(/[A-Za-z0-9+=]{20,}/g))
    if (/[0-9]/.test(run) && /[A-Za-z]/.test(run) && entropy(run) >= 3.5) return 'random';
  return null;
}

/* ---------- Names remote MCP servers read as empty (FR24) ---------- */

/**
 * Names Claude Code expands to nothing in a remote MCP server's `url` and `headers`, so a value can't be sent
 * to a remote host through them. Read from Claude Code 2.1.296 (PRD Q4): its credential list, its proxy and
 * package-index names, its own tokens, and the patterns below. A secret set may still deliver these; an MCP
 * set must use `{{secret-file:NAME}}` for them instead.
 */
const REMOTE_MCP_BLANK = new Set(
  [
    // Its own and other agents' credentials.
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'ANTHROPIC_AWS_API_KEY',
    'ANTHROPIC_IDENTITY_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_CLIENT_KEY',
    'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE', 'MCP_CLIENT_SECRET', 'MCP_XAA_IDP_CLIENT_SECRET', 'ENVIRONMENT_SERVICE_KEY',
    // Cloud credentials.
    'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE', 'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_GHA_CREDS_PATH', 'GOOGLE_OAUTH_ACCESS_TOKEN', 'CLOUDSDK_AUTH_ACCESS_TOKEN', 'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE', 'CLOUDSDK_AUTH_AUTHORIZATION_TOKEN_FILE',
    'AZURE_CLIENT_SECRET', 'AZURE_CLIENT_CERTIFICATE_PATH', 'AZURE_CLIENT_CERTIFICATE_PASSWORD', 'AZURE_PASSWORD', 'AZURE_FEDERATED_TOKEN_FILE',
    'AZURE_AUTH_LOCATION', 'IDENTITY_HEADER', 'MSI_SECRET',
    // Package registries and their index URLs, which can carry a password.
    'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'NUGET_AUTH_TOKEN', 'CARGO_REGISTRY_TOKEN', 'CODEARTIFACT_AUTH_TOKEN', 'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL',
    'UV_INDEX_URL', 'UV_EXTRA_INDEX_URL', 'UV_DEFAULT_INDEX', 'UV_INDEX', 'UV_PUBLISH_TOKEN', 'UV_PUBLISH_PASSWORD', 'UV_PUBLISH_USERNAME', 'GOPROXY',
    'GOAUTH', 'PYPI_TOKEN', 'PYPI_API_TOKEN', 'TWINE_PASSWORD', 'TWINE_USERNAME', 'FLIT_PASSWORD', 'FLIT_USERNAME', 'HATCH_INDEX_AUTH', 'HATCH_INDEX_USER',
    'GEM_HOST_API_KEY', 'MATURIN_PYPI_TOKEN', 'MATURIN_PASSWORD', 'MATURIN_USERNAME', 'CONAN_LOGIN_USERNAME', 'CONAN_PASSWORD', 'ANACONDA_API_TOKEN',
    'BINSTAR_API_TOKEN', 'COMPOSER_AUTH', 'VSS_NUGET_EXTERNAL_FEED_ENDPOINTS', 'ARTIFACTS_CREDENTIALPROVIDER_EXTERNAL_FEED_ENDPOINTS',
    'VSS_NUGET_ACCESSTOKEN', 'ARTIFACTS_CREDENTIALPROVIDER_ACCESSTOKEN',
    // Proxies, in both cases.
    'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY',
    // Vaults, CI and webhooks.
    'VAULT_TOKEN', 'VAULT_AUTH_TOKEN', 'VAULT_ROLE_ID', 'VAULT_SECRET_ID', 'CONSUL_HTTP_TOKEN', 'CONSUL_HTTP_AUTH', 'NOMAD_TOKEN', 'NOMAD_HTTP_AUTH',
    'CI_REGISTRY_USER', 'CI_DEPLOY_USER', 'JF_USER', 'FASTLANE_SESSION', 'MATCH_GIT_BASIC_AUTHORIZATION', 'SONAR_TOKEN', 'SONARQUBE_SCANNER_PARAMS',
    'SONAR_SCANNER_JSON_PARAMS', 'SLACK_WEBHOOK_URL', 'SLACK_WEBHOOK', 'DISCORD_WEBHOOK', 'DISCORD_WEBHOOK_URL', 'TEAMS_WEBHOOK_URL', 'MS_TEAMS_WEBHOOK_URI',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RUNTIME_URL', 'ALL_INPUTS', 'OVERRIDE_GITHUB_TOKEN',
    'DEFAULT_WORKFLOW_TOKEN', 'SSH_SIGNING_KEY',
  ],
);

/** Whether Claude Code reads `${name}` as empty in a remote MCP server's `url` or `headers` (FR24). */
export function blankInRemoteMcp(name: string): boolean {
  const upper = name.toUpperCase().replace(/^INPUT_/, '');
  return (
    REMOTE_MCP_BLANK.has(upper) ||
    /^(ANTHROPIC|CLAUDE_CODE|OTEL)_/.test(upper) ||
    /^GIT_CONFIG_(?:PARAMETERS|(?:KEY|VALUE)_\d+)$/.test(upper) ||
    /^CARGO_REGISTRIES_[A-Z0-9_]+_TOKEN$/.test(upper)
  );
}
