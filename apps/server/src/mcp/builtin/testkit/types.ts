/**
 * Options of the stand-in provider (testkit/provider.ts). Everything has a default, a preset (presets.ts) fills them in for a
 * provider style, and a caller overrides any of them: `startProvider('gitea', { oauth: { accessTtlSec: 60 } })`.
 */

export type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

/** A client the authorization server already knows, like the public OAuth2 app a person creates by hand in Gitea. */
export interface PreRegisteredClient {
  id: string;
  /** Matched exactly, except an IP-literal loopback address (`http://127.0.0.1/callback`) when `looseLoopback` is on. */
  redirectUris: string[];
  /** Present: a confidential client that must send it at the token endpoint. Absent: a public client (PKCE only). */
  secret?: string;
  name?: string;
}

/** The 401 an unauthenticated request gets: which parameters `WWW-Authenticate` carries, and in which order. */
export interface ChallengeStyle {
  /** `realm="…"` (GitLab: `GitLab`, Cloudflare: `OAuth`). */
  realm?: string;
  /** The `scope="…"` parameter; absent: none. Defaults to the resource's scopes. */
  scope?: string | null;
  /** GitLab puts `scope` before `resource_metadata`; the others put it after. */
  scopeFirst?: boolean;
  /** GitHub sends `error="invalid_request"` when no token came. */
  missingError?: { error: string; description: string };
  /** A token that is present but wrong gets `error="invalid_token"` (RFC 6750, what makes clients refresh). Default true. */
  invalidTokenError?: boolean;
  /** The response body and its content type (Outline: JSON, Cloudflare: empty, Gitea's sidecar: a text line). */
  body?: string;
  contentType?: string;
}

export interface OAuthOptions {
  /** `''`, or a path the issuer carries (GitHub: `/login/oauth`): metadata then lives at `/.well-known/<kind>/<path>` (RFC 8414 §3.1). */
  issuerPath: string;
  /** Serve RFC 8414 metadata (`/.well-known/oauth-authorization-server`). Gitea does not. */
  rfc8414: boolean;
  /** Serve OpenID Connect discovery (`/.well-known/openid-configuration`), also with its OIDC-style scopes. Gitea does. */
  oidc: boolean;
  paths: { authorize: string; token: string; register: string; revoke: string };
  /** RFC 7591 dynamic client registration. Off: only pre-registered clients. */
  dcr: boolean;
  /** Registrations an hour per address, then 429 (GitLab: 10). null: no limit. */
  dcrLimitPerHour: number | null;
  /** `code_challenge_methods_supported`. A request with a method outside it is refused. */
  pkce: ('S256' | 'plain')[];
  /** Outline refuses an authorization request without `state`. */
  requireState: boolean;
  /** `token_endpoint_auth_methods_supported`; the first one a registration defaults to (RFC 7591 says client_secret_basic). */
  tokenAuthMethods: ClientAuthMethod[];
  /** The authorization server's `scopes_supported`. For Gitea these are the OIDC scopes, not the API scopes. */
  scopes: string[];
  /** What the protected resource asks for: its metadata's `scopes_supported` and the challenge's `scope`. */
  resourceScopes: string[];
  clients: PreRegisteredClient[];
  /** Where a redirect may go: loopback `http://localhost|127.0.0.1|[::1]:<port>/…` only, or also claude.ai and claude.com callbacks. */
  redirects: 'loopback' | 'loopback+claude';
  /** Gitea: a registered `http://127.0.0.1/callback` matches that address on any port (public clients), `localhost` only exactly. */
  looseLoopback: boolean;
  accessTtlSec: number;
  refreshTtlSec: number;
  /** A refresh token is used once: the response carries a new one and the old one stops working (Outline, GitLab). */
  rotateRefresh: boolean;
  /** Cloudflare and GitHub issue a refresh token only when `offline_access` was requested. */
  refreshNeedsOffline: boolean;
  /** Send and advertise `iss` on the authorization response (RFC 9207, GitHub does). */
  issParam: boolean;
  /** What the person does at the consent screen. Changeable while running. */
  authorize: 'approve' | 'deny';
}

export interface Quirks {
  /** gitea-mcp alone: a token that is present but wrong still gets a 200, and only tool calls fail. A missing token still gets the 401. */
  badTokenOk: boolean;
  /** Answer MCP requests as `text/event-stream` (Cloudflare does) instead of JSON. */
  sse: boolean;
  /** Hostile: the authorization response carries another issuer in `iss`. */
  issMismatch: boolean;
  /** Hostile: the metadata names an `issuer` other than the URL it was fetched for. */
  metadataIssuerMismatch: boolean;
}

export interface ProviderOptions {
  host: string;
  /** The name put in the URLs the metadata carries, when it differs from the address it listens on (`0.0.0.0` inside a container). Default: `host`. */
  publicHost?: string;
  /** The MCP server's port; 0: any free one. */
  port: number;
  /** Set: the authorization server listens on its own port and origin (Gitea and GitHub: another host than the MCP server). */
  authPort?: number;
  mcpPath: string;
  serverName: string;
  /** Bearer tokens the MCP endpoint takes without OAuth (a personal access token): token → who it acts as. */
  staticTokens: Record<string, string>;
  /** `Authorization: Bearer <t>` always; `token <t>` too where the server reads it (gitea-mcp does). */
  tokenSchemes: ('bearer' | 'token')[];
  challenge: ChallengeStyle;
  /** Also serve the bare `/.well-known/oauth-protected-resource` (Cloudflare's MCP server serves only the path form). */
  bareResourceMetadata: boolean;
  /** `false`: no authorization server at all, tokens only. */
  oauth: false | OAuthOptions;
  quirks: Quirks;
  /**
   * Serve https with this certificate (PEM text) instead of http: Claude Code accepts an `authServerMetadataUrl` only as https, so a
   * test of that setting needs it. `selfSignedCertificate()` makes one; the client then needs it as a trusted root (`NODE_EXTRA_CA_CERTS`).
   */
  tls?: { cert: string; key: string };
  /** Who the person is that approves a sign-in: the subject of the tokens it issues. */
  user: string;
  /** Expose `/__standin/*` (state, advance, deny, approve) so a stand-in running in another process can be steered with curl. */
  control: boolean;
  /** Time source in ms, for tests that don't want to wait. `provider.advance(ms)` moves the built-in one. */
  clock?: () => number;
}

/** A deep-partial of the options, as a caller gives them. */
export type ProviderOverrides = Partial<Omit<ProviderOptions, 'oauth' | 'quirks' | 'challenge'>> & {
  oauth?: false | Partial<OAuthOptions>;
  quirks?: Partial<Quirks>;
  challenge?: Partial<ChallengeStyle>;
};

/** One request the stand-in saw, as the kit records it (never the token itself). */
export interface LoggedRequest {
  at: number;
  /** `mcp` (the MCP endpoint), `resource-metadata`, `as-metadata`, `authorize`, `token`, `register`, `revoke`, `control`, `other`. */
  endpoint: string;
  method: string;
  path: string;
  status: number;
  /** The scheme of the Authorization header, if any (`Bearer`, `token`, `Basic`). */
  scheme: string | null;
  /** The JSON-RPC method of an MCP request. */
  rpc: string | null;
  /** The `WWW-Authenticate` value sent. */
  challenge: string | null;
  /** An OAuth error code the response carried (`invalid_grant`, `invalid_token`, …). */
  error: string | null;
  /**
   * What an authorize, token or register request carried: the query or form fields, or the registration's JSON fields. Values of
   * `code`, `code_verifier`, `refresh_token`, `client_secret` and `token` are replaced by `<set>`. Null for the other endpoints.
   */
  params: Record<string, string> | null;
}

export interface ClientRecord {
  id: string;
  name: string | null;
  redirectUris: string[];
  confidential: boolean;
  secret: string | null;
  how: 'pre-registered' | 'dcr';
}

export interface TokenRecord {
  access: string;
  refresh: string | null;
  clientId: string;
  subject: string;
  scope: string;
  expiresAt: number;
  refreshExpiresAt: number | null;
  revoked: boolean;
  /** The refresh token was used and replaced. */
  rotated: boolean;
  /** The `resource` (RFC 8707) the authorization request named, when it did. */
  resource: string | null;
}
