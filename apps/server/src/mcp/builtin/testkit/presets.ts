import type { ChallengeStyle, OAuthOptions, ProviderOptions, ProviderOverrides, Quirks } from './types.js';

/**
 * Presets for the stand-in provider: one per provider style the built-in catalogue covers (providers PRD §6). Each one copies
 * what the real provider was observed to do on 2026-10-12 (discovery documents, the 401 challenge, the paths), so a client that
 * works against a preset has met the same shapes it will meet in production. Their values are the stand-in's own: no real
 * client IDs, no real tokens.
 *
 *   gitea       Gitea behind an nginx sidecar (the owner's gitea-mcp): authorization server on its own origin, OIDC discovery
 *               only, no dynamic registration, one pre-registered public client, `localhost` redirects match exactly, the
 *               OIDC scopes differ from the API scopes the resource wants; `token <t>` works as well as `Bearer`; a wrong
 *               token gets 401 + `error="invalid_token"`.
 *   gitea-bare  gitea-mcp with no sidecar: a wrong token still gets 200 and only tool calls fail.
 *   gitlab      Same origin, RFC 8414 and OIDC metadata, dynamic registration (10 an hour), secret-based client auth only,
 *               `plain` and `S256`, scope `mcp`.
 *   cloudflare  Same origin, path-form resource metadata only, dynamic registration, `offline_access` needed for a refresh
 *               token, SSE answers.
 *   outline     Same origin, dynamic registration of public clients, `state` required, rotating refresh tokens, JSON 401.
 *   github      Token only: the authorization server has an issuer with a path, no registration, and its one client is
 *               confidential, so a client with no secret cannot finish.
 */

export type ProviderPreset = 'gitea' | 'gitea-bare' | 'gitlab' | 'cloudflare' | 'outline' | 'github';
export const PROVIDER_PRESETS: readonly ProviderPreset[] = ['gitea', 'gitea-bare', 'gitlab', 'cloudflare', 'outline', 'github'];

/** The redirect URI the built-in Gitea and GitLab templates pin (providers/common.ts), as a pre-registered client holds it. */
export const PINNED_REDIRECT = 'http://localhost:24819/callback';

const QUIRKS: Quirks = { badTokenOk: false, sse: false, issMismatch: false, metadataIssuerMismatch: false };

const OAUTH: OAuthOptions = {
  issuerPath: '',
  rfc8414: true,
  oidc: false,
  paths: { authorize: '/authorize', token: '/token', register: '/register', revoke: '/revoke' },
  dcr: true,
  dcrLimitPerHour: null,
  pkce: ['S256'],
  requireState: false,
  tokenAuthMethods: ['none'],
  scopes: ['read', 'write'],
  resourceScopes: ['read', 'write'],
  clients: [],
  redirects: 'loopback',
  looseLoopback: false,
  accessTtlSec: 3600,
  refreshTtlSec: 30 * 24 * 3600,
  rotateRefresh: true,
  refreshNeedsOffline: false,
  issParam: false,
  authorize: 'approve',
};

const BASE: ProviderOptions = {
  host: '127.0.0.1',
  port: 0,
  mcpPath: '/mcp',
  serverName: 'standin',
  staticTokens: { 'standin-pat': 'standin-pat-user' },
  tokenSchemes: ['bearer'],
  challenge: {},
  bareResourceMetadata: true,
  oauth: OAUTH,
  quirks: QUIRKS,
  user: 'standin-user',
  control: false,
};

const GITEA_SCOPES = ['write:repository', 'write:issue', 'write:user', 'write:organization', 'write:notification', 'write:package', 'write:misc'];

const gitea: ProviderOverrides = {
  serverName: 'standin-gitea',
  authPort: 0,
  tokenSchemes: ['bearer', 'token'],
  challenge: { scope: GITEA_SCOPES.join(' '), body: 'authorization required\n', contentType: 'application/octet-stream' },
  oauth: {
    rfc8414: false,
    oidc: true,
    paths: { authorize: '/login/oauth/authorize', token: '/login/oauth/access_token', register: '/login/oauth/register', revoke: '/login/oauth/revoke' },
    dcr: false,
    pkce: ['plain', 'S256'],
    tokenAuthMethods: [],
    scopes: ['openid', 'profile', 'email', 'groups'],
    resourceScopes: GITEA_SCOPES,
    clients: [{ id: 'standin-gitea-client', name: 'Claude MCP (stand-in)', redirectUris: [PINNED_REDIRECT, 'http://127.0.0.1/callback'] }],
    looseLoopback: true,
  },
};

const PRESETS: Record<ProviderPreset, ProviderOverrides> = {
  gitea,
  'gitea-bare': { ...gitea, serverName: 'standin-gitea-bare', quirks: { badTokenOk: true } },
  gitlab: {
    serverName: 'standin-gitlab',
    challenge: { realm: 'GitLab', scope: 'mcp', scopeFirst: true, body: '{"message":"401 Unauthorized"}', contentType: 'application/json' },
    oauth: {
      oidc: true,
      paths: { authorize: '/oauth/authorize', token: '/oauth/token', register: '/oauth/register', revoke: '/oauth/revoke' },
      dcrLimitPerHour: 10,
      pkce: ['plain', 'S256'],
      tokenAuthMethods: ['client_secret_basic', 'client_secret_post'],
      scopes: ['api', 'read_api', 'read_user', 'mcp', 'read_repository', 'write_repository', 'openid', 'profile', 'email'],
      resourceScopes: ['mcp'],
      accessTtlSec: 7200,
    },
  },
  cloudflare: {
    serverName: 'standin-cloudflare',
    bareResourceMetadata: false,
    challenge: { realm: 'OAuth', scope: 'user:read account:read', body: '', contentType: 'text/plain' },
    quirks: { sse: true },
    oauth: {
      tokenAuthMethods: ['none', 'client_secret_basic', 'client_secret_post'],
      scopes: ['offline_access', 'user:read', 'account:read', 'workers-scripts.read', 'workers-scripts.write'],
      resourceScopes: ['user:read', 'account:read'],
      refreshNeedsOffline: true,
    },
  },
  outline: {
    serverName: 'standin-outline',
    challenge: { scope: 'read write', body: '{"ok":false,"error":"authentication_required","status":401,"message":"Authentication required"}', contentType: 'application/json; charset=utf-8' },
    oauth: {
      paths: { authorize: '/oauth/authorize', token: '/oauth/token', register: '/oauth/register', revoke: '/oauth/revoke' },
      requireState: true,
      tokenAuthMethods: ['client_secret_post', 'none'],
    },
  },
  github: {
    serverName: 'standin-github',
    authPort: 0,
    challenge: {
      scope: null,
      missingError: { error: 'invalid_request', description: 'No access token was provided in this request' },
      body: 'bad request: missing required Authorization header\n',
      contentType: 'text/plain; charset=utf-8',
    },
    oauth: {
      issuerPath: '/login/oauth',
      oidc: true,
      paths: { authorize: '/authorize', token: '/access_token', register: '', revoke: '' },
      dcr: false,
      tokenAuthMethods: [],
      scopes: ['offline_access'],
      resourceScopes: ['repo', 'read:org', 'read:user', 'user:email', 'read:packages', 'read:project', 'gist', 'notifications'],
      clients: [{ id: 'standin-github-oauth-app', name: 'Stand-in OAuth App', redirectUris: [PINNED_REDIRECT], secret: 'standin-github-client-secret' }],
      looseLoopback: true,
      refreshNeedsOffline: true,
      accessTtlSec: 8 * 3600,
      issParam: true,
    },
  },
};

const merge = <T extends object>(base: T, over: Partial<T> | undefined): T => ({ ...base, ...(over ?? {}) });

/** The full options for a preset (or the plain defaults) with the caller's overrides on top. Nothing is shared with the presets. */
export function resolveOptions(preset: ProviderPreset | null, overrides: ProviderOverrides = {}): ProviderOptions {
  const layers: ProviderOverrides[] = [...(preset ? [PRESETS[preset]] : []), overrides];
  let out: ProviderOptions = structuredClone(BASE);
  for (const layer of layers) {
    const { clock, ...data } = layer;
    const { oauth, quirks, challenge, ...rest } = structuredClone(data);
    out = { ...out, ...(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<ProviderOptions>) };
    out.quirks = merge(out.quirks, quirks);
    out.challenge = merge<ChallengeStyle>(out.challenge, challenge);
    if (oauth === false) out.oauth = false;
    else if (oauth) out.oauth = merge(out.oauth || structuredClone(OAUTH), oauth);
    if (clock) out.clock = clock;
  }
  return out;
}
