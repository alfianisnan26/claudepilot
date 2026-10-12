/**
 * A stand-in for an MCP provider, for tests (providers PRD §6): one small HTTP server, no dependencies beyond Node, that speaks
 * what a real remote MCP server and its authorization server speak, without any real account. B1's catalogue tests, B3's OAuth
 * sign-in experiments against a real Claude Code in a workspace container, and Q2's security review use it.
 *
 *   MCP endpoint     `POST <mcpPath>`: streamable HTTP (JSON or SSE answers), `initialize`, `tools/list`, `tools/call`
 *                    (`whoami`, `echo`), `ping`, notifications. GET and DELETE answer 405 like a stateless server.
 *   Bearer           `Authorization: Bearer <t>` (and `token <t>` where the server reads it): a configured static token (a
 *                    personal access token) or an access token this server issued. No header: 401 + `WWW-Authenticate: Bearer
 *                    resource_metadata=…`; a wrong or expired one: 401 + `error="invalid_token"`, or 200 under the `badTokenOk`
 *                    quirk (gitea-mcp alone). RFC 6750.
 *   Metadata         RFC 9728 protected resource metadata (path form and bare), RFC 8414 and OpenID Connect discovery for the
 *                    authorization server, which may sit on its own origin and carry a path in its issuer.
 *   Authorization    `GET authorize` (PKCE `S256` and `plain`, `state`, RFC 9207 `iss`), `POST token` (authorization code and
 *                    refresh, public and confidential clients, refresh rotation, code single use), `POST register` (RFC 7591,
 *                    rate limited), `POST revoke` (RFC 7009). Redirects go to loopback addresses only (or claude.ai/claude.com):
 *                    the owner's own MCP servers refuse a portal-hosted https callback, and so does this.
 *   Control          in process: `advance(ms)`, `setAuthorize('deny')`, `setQuirk(…)`, `revokeAll()`, `requests`, `tokens()`,
 *                    `clients()`. In another process (`control: true`): `GET /__standin/state`, `POST /__standin/advance`, …
 *
 * Start one with a preset (presets.ts): `const p = await startProvider('gitea'); p.url; …; await p.close();`. Run it in a
 * workspace container with the standalone bundle (build.ts, cli.ts). Everything it issues is fake and held in memory.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { resolveOptions, type ProviderPreset } from './presets.js';
import type { ClientRecord, LoggedRequest, OAuthOptions, ProviderOptions, ProviderOverrides, Quirks, TokenRecord } from './types.js';

export type { ProviderPreset } from './presets.js';
export type { ClientRecord, LoggedRequest, ProviderOptions, ProviderOverrides, TokenRecord } from './types.js';

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CODE_TTL_MS = 60_000;
const BODY_LIMIT = 1_000_000;
const LOG_LIMIT = 500;

const TOOLS = [
  { name: 'whoami', description: 'Who the stand-in thinks you are, and how you signed in.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'echo', description: 'Echoes the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
];

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const sha256b64 = (text: string) => createHash('sha256').update(text).digest('base64url');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const quote = (key: string, value: string) => `${key}="${value.replace(/["\\\r\n]/g, '')}"`;

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  redirectGiven: boolean;
  challenge: string;
  method: 'S256' | 'plain';
  scope: string;
  subject: string;
  expiresAt: number;
  used: boolean;
  resource: string | null;
  /** The access token issued for it, so a replay revokes it (RFC 6749 §4.1.2). */
  issued: TokenRecord | null;
}

type Who = { via: 'static' | 'oauth' | 'bad' | 'none'; subject: string | null; client: string | null; scope: string };
type Authn = { ok: true; who: Who } | { ok: false; reason: 'missing' | 'invalid' };

interface Ctx {
  endpoint: string;
  scheme: string | null;
  rpc: string | null;
  challenge: string | null;
  error: string | null;
  params: Record<string, string> | null;
}

/** Parameters whose values the request log never keeps. */
const SECRET_PARAMS = new Set(['code', 'code_verifier', 'refresh_token', 'client_secret', 'token']);
const loggable = (entries: Iterable<[string, string]>): Record<string, string> =>
  Object.fromEntries([...entries].map(([k, v]) => [k, SECRET_PARAMS.has(k) ? '<set>' : v.slice(0, 500)]));

export interface StandInProvider {
  /** The MCP endpoint's URL. */
  readonly url: string;
  /** The MCP server's origin. */
  readonly origin: string;
  /** The authorization server's origin (the MCP server's own unless it has a port of its own); null with no OAuth. */
  readonly authOrigin: string | null;
  /** The issuer (origin plus its path); null with no OAuth. */
  readonly issuer: string | null;
  /** The protected resource metadata URL the 401 challenge names. */
  readonly resourceMetadataUrl: string;
  /** The options in force (the stand-in reads them live, so a test may change `oauth.accessTtlSec` and the like). */
  readonly options: ProviderOptions;
  /** Every request seen, newest last, at most 500. No token is recorded. */
  readonly requests: LoggedRequest[];
  clients(): ClientRecord[];
  tokens(): TokenRecord[];
  /** Move the stand-in's clock forward: access tokens, refresh tokens, codes and the registration window age. */
  advance(ms: number): void;
  now(): number;
  /** What the person does at the consent screen from now on. */
  setAuthorize(mode: 'approve' | 'deny'): void;
  setQuirk<K extends keyof Quirks>(name: K, value: Quirks[K]): void;
  /** Add a pre-registered client (a public one unless it has a `secret`). */
  addClient(client: { id: string; redirectUris: string[]; secret?: string; name?: string }): void;
  /** Revoke every token issued. */
  revokeAll(): void;
  close(): Promise<void>;
}

/** Starts a stand-in. `preset` null: the plain defaults (a DCR provider with RFC 8414 metadata on one origin). */
export async function startProvider(preset: ProviderPreset | null, overrides: ProviderOverrides = {}): Promise<StandInProvider> {
  const provider = new Provider(resolveOptions(preset, overrides));
  await provider.listen();
  return provider;
}

class Provider implements StandInProvider {
  readonly options: ProviderOptions;
  readonly requests: LoggedRequest[] = [];
  #skew = 0;
  #rs: Server | null = null;
  #as: Server | null = null;
  #origin = '';
  #authOrigin: string | null = null;
  readonly #clients = new Map<string, ClientRecord>();
  readonly #codes = new Map<string, CodeRecord>();
  readonly #byAccess = new Map<string, TokenRecord>();
  readonly #byRefresh = new Map<string, TokenRecord>();
  readonly #registrations = new Map<string, number[]>();

  constructor(options: ProviderOptions) {
    this.options = options;
    for (const c of options.oauth ? options.oauth.clients : []) this.addClient(c);
  }

  /* ---------- Lifecycle ---------- */

  async listen(): Promise<void> {
    const o = this.options;
    const separate = !!o.oauth && o.authPort !== undefined;
    const scheme = o.tls ? 'https' : 'http';
    const make = (role: 'rs' | 'as' | 'both') => {
      const handler = (req: IncomingMessage, res: ServerResponse) => void this.#handle(role, req, res);
      return o.tls ? createSecureServer({ cert: o.tls.cert, key: o.tls.key }, handler) : createServer(handler);
    };
    const rs = make(separate ? 'rs' : 'both');
    await new Promise<void>((resolve, reject) => (rs.once('error', reject), rs.listen(o.port, o.host, resolve)));
    this.#rs = rs;
    this.#origin = `${scheme}://${o.publicHost ?? o.host}:${(rs.address() as AddressInfo).port}`;
    if (separate) {
      const as = make('as');
      await new Promise<void>((resolve, reject) => (as.once('error', reject), as.listen(o.authPort, o.host, resolve)));
      this.#as = as;
      this.#authOrigin = `${scheme}://${o.publicHost ?? o.host}:${(as.address() as AddressInfo).port}`;
    } else if (o.oauth) this.#authOrigin = this.#origin;
  }

  async close(): Promise<void> {
    for (const s of [this.#rs, this.#as]) {
      if (!s) continue;
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    this.#rs = this.#as = null;
  }

  get url() {
    return `${this.#origin}${this.options.mcpPath}`;
  }
  get origin() {
    return this.#origin;
  }
  get authOrigin() {
    return this.#authOrigin;
  }
  get issuer() {
    return this.options.oauth ? `${this.#authOrigin}${this.options.oauth.issuerPath}` : null;
  }
  get resourceMetadataUrl() {
    return `${this.#origin}/.well-known/oauth-protected-resource${this.options.mcpPath}`;
  }

  now() {
    return (this.options.clock ? this.options.clock() : Date.now()) + this.#skew;
  }
  advance(ms: number) {
    this.#skew += ms;
  }
  setAuthorize(mode: 'approve' | 'deny') {
    if (this.options.oauth) this.options.oauth.authorize = mode;
  }
  setQuirk<K extends keyof Quirks>(name: K, value: Quirks[K]) {
    this.options.quirks[name] = value;
  }
  addClient(c: { id: string; redirectUris: string[]; secret?: string; name?: string }) {
    this.#clients.set(c.id, { id: c.id, name: c.name ?? null, redirectUris: [...c.redirectUris], confidential: !!c.secret, secret: c.secret ?? null, how: 'pre-registered' });
  }
  clients() {
    return [...this.#clients.values()].map((c) => ({ ...c }));
  }
  tokens() {
    return [...new Set([...this.#byAccess.values()])].map((t) => ({ ...t }));
  }
  revokeAll() {
    for (const t of this.#byAccess.values()) t.revoked = true;
  }

  /* ---------- Routing ---------- */

  async #handle(role: 'rs' | 'as' | 'both', req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx: Ctx = { endpoint: 'other', scheme: /^(\S+)\s/.exec(req.headers.authorization ?? '')?.[1] ?? null, rpc: null, challenge: null, error: null, params: null };
    const path = new URL(req.url ?? '/', 'http://standin').pathname;
    res.on('finish', () => {
      this.requests.push({ at: this.now(), endpoint: ctx.endpoint, method: req.method ?? '', path, status: res.statusCode, scheme: ctx.scheme, rpc: ctx.rpc, challenge: ctx.challenge, error: ctx.error, params: ctx.params });
      if (this.requests.length > LOG_LIMIT) this.requests.splice(0, this.requests.length - LOG_LIMIT);
    });
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'Content-Type, Accept, Authorization, MCP-Protocol-Version');
    try {
      if (req.method === 'OPTIONS') return void (res.writeHead(204), res.end());
      const o = this.options;
      if (role !== 'as') {
        if (o.control && path.startsWith('/__standin/')) return await this.#control(req, res, ctx, path);
        if (path.replace(/\/+$/, '') === o.mcpPath) return await this.#mcp(req, res, ctx);
        if (o.oauth && (path === `/.well-known/oauth-protected-resource${o.mcpPath}` || (o.bareResourceMetadata && path === '/.well-known/oauth-protected-resource')))
          return this.#json(res, ctx, 200, { resource: this.url, authorization_servers: [this.issuer], scopes_supported: o.oauth.resourceScopes, bearer_methods_supported: ['header'] }, 'resource-metadata');
      }
      const oauth = o.oauth;
      if (role !== 'rs' && oauth) {
        const issuerPath = oauth.issuerPath;
        if (req.method === 'GET') {
          if (oauth.rfc8414 && path === `/.well-known/oauth-authorization-server${issuerPath}`) return this.#json(res, ctx, 200, this.#metadata('oauth', oauth), 'as-metadata');
          if (oauth.oidc && (path === `/.well-known/openid-configuration${issuerPath}` || path === `${issuerPath}/.well-known/openid-configuration`))
            return this.#json(res, ctx, 200, this.#metadata('oidc', oauth), 'as-metadata');
          if (oauth.oidc && path === `${issuerPath}/jwks`) return this.#json(res, ctx, 200, { keys: [] }, 'as-metadata');
          if (oauth.oidc && path === `${issuerPath}/userinfo`) return this.#userinfo(req, res, ctx);
          if (path === issuerPath + oauth.paths.authorize) return this.#authorize(new URL(req.url ?? '/', 'http://standin'), res, ctx, oauth);
        }
        if (req.method === 'POST') {
          if (path === issuerPath + oauth.paths.token) return await this.#token(req, res, ctx, oauth);
          if (oauth.dcr && oauth.paths.register && path === issuerPath + oauth.paths.register) return await this.#register(req, res, ctx, oauth);
          if (oauth.paths.revoke && path === issuerPath + oauth.paths.revoke) return await this.#revoke(req, res, ctx, oauth);
        }
      }
      this.#json(res, ctx, 404, { error: 'not_found' });
    } catch (e) {
      if (!res.headersSent) this.#json(res, ctx, e instanceof BodyTooLarge ? 413 : 500, { error: e instanceof BodyTooLarge ? 'too_large' : 'server_error' });
      else res.end();
    }
  }

  #json(res: ServerResponse, ctx: Ctx, status: number, body: unknown, endpoint?: string, headers: Record<string, string> = {}): void {
    if (endpoint) ctx.endpoint = endpoint;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  }

  #oauthError(res: ServerResponse, ctx: Ctx, status: number, error: string, description?: string): void {
    ctx.error = error;
    this.#json(res, ctx, status, { error, ...(description ? { error_description: description } : {}) });
  }

  /* ---------- MCP endpoint ---------- */

  #challenge(kind: 'missing' | 'invalid'): string {
    const o = this.options;
    const c = o.challenge;
    const parts: string[] = [];
    if (c.realm) parts.push(quote('realm', c.realm));
    if (kind === 'missing' && c.missingError) parts.push(quote('error', c.missingError.error), quote('error_description', c.missingError.description));
    if (kind === 'invalid' && (c.invalidTokenError ?? true)) parts.push(quote('error', 'invalid_token'));
    const scope = c.scope === undefined ? (o.oauth ? o.oauth.resourceScopes.join(' ') : null) : c.scope;
    if (scope && c.scopeFirst) parts.push(quote('scope', scope));
    if (o.oauth) parts.push(quote('resource_metadata', this.resourceMetadataUrl));
    if (scope && !c.scopeFirst) parts.push(quote('scope', scope));
    return parts.length ? `Bearer ${parts.join(', ')}` : 'Bearer';
  }

  #authenticate(req: IncomingMessage): Authn {
    const header = req.headers.authorization;
    if (!header) return { ok: false, reason: 'missing' };
    const m = /^(Bearer|token)\s+(\S+)$/i.exec(header.trim());
    const scheme = m?.[1]?.toLowerCase();
    if (!m || !scheme || !this.options.tokenSchemes.includes(scheme as 'bearer' | 'token')) return { ok: false, reason: 'invalid' };
    const secret = m[2]!;
    for (const [token, subject] of Object.entries(this.options.staticTokens)) if (same(token, secret)) return { ok: true, who: { via: 'static', subject, client: null, scope: '' } };
    const t = this.#byAccess.get(secret);
    if (t && !t.revoked && this.now() < t.expiresAt) return { ok: true, who: { via: 'oauth', subject: t.subject, client: t.clientId, scope: t.scope } };
    return { ok: false, reason: 'invalid' };
  }

  async #mcp(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
    ctx.endpoint = 'mcp';
    const o = this.options;
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: 'method_not_allowed' }));
    }
    let who: Who;
    const authn = this.#authenticate(req);
    if (authn.ok) who = authn.who;
    else if (authn.reason === 'invalid' && o.quirks.badTokenOk) who = { via: 'bad', subject: null, client: null, scope: '' };
    else {
      const challenge = this.#challenge(authn.reason);
      ctx.challenge = challenge;
      ctx.error = authn.reason === 'invalid' ? 'invalid_token' : 'missing_token';
      res.writeHead(401, { 'www-authenticate': challenge, 'content-type': o.challenge.contentType ?? 'application/json' });
      return void res.end(o.challenge.body ?? JSON.stringify({ error: 'unauthorized' }));
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      if (e instanceof BodyTooLarge) throw e;
      return this.#json(res, ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const batch = Array.isArray(body);
    const answers = (batch ? (body as unknown[]) : [body]).map((m) => this.#rpc(m, who, ctx)).filter((a) => a !== null);
    if (!answers.length) return void (res.writeHead(202), res.end());
    const payload = JSON.stringify(batch ? answers : answers[0]);
    if (o.quirks.sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      return void res.end(`event: message\ndata: ${payload}\n\n`);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  }

  #rpc(message: unknown, who: Who, ctx: Ctx): Record<string, unknown> | null {
    const m = (message && typeof message === 'object' ? message : {}) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
    const reply = (result: unknown) => (m.id === undefined ? null : { jsonrpc: '2.0', id: m.id, result });
    const fail = (code: number, text: string) => (m.id === undefined ? null : { jsonrpc: '2.0', id: m.id, error: { code, message: text } });
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    ctx.rpc ??= m.method;
    switch (m.method) {
      case 'initialize': {
        const asked = typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '';
        return reply({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.options.serverName, version: '1.0.0' },
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        const args = (m.params?.arguments ?? {}) as { text?: unknown };
        if (who.via === 'bad') return reply({ isError: true, content: [{ type: 'text', text: '401 Unauthorized: the token was refused' }] });
        if (name === 'whoami') return reply({ content: [{ type: 'text', text: JSON.stringify({ subject: who.subject, via: who.via, client: who.client, scope: who.scope }) }] });
        if (name === 'echo') return reply({ content: [{ type: 'text', text: String(args.text ?? '') }] });
        return fail(-32602, `Unknown tool: ${String(name)}`);
      }
      default:
        return m.method.startsWith('notifications/') ? null : fail(-32601, `Method not found: ${m.method}`);
    }
  }

  /* ---------- Authorization server ---------- */

  #metadata(kind: 'oauth' | 'oidc', o: OAuthOptions): Record<string, unknown> {
    const base = `${this.#authOrigin}${o.issuerPath}`;
    const iss = this.issuer!;
    return {
      issuer: this.options.quirks.metadataIssuerMismatch ? 'https://issuer.invalid' : iss,
      authorization_endpoint: base + o.paths.authorize,
      token_endpoint: base + o.paths.token,
      ...(o.dcr && o.paths.register ? { registration_endpoint: base + o.paths.register } : {}),
      ...(o.paths.revoke ? { revocation_endpoint: base + o.paths.revoke } : {}),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      ...(o.tokenAuthMethods.length ? { token_endpoint_auth_methods_supported: o.tokenAuthMethods } : {}),
      code_challenge_methods_supported: o.pkce,
      scopes_supported: o.scopes,
      ...(o.issParam ? { authorization_response_iss_parameter_supported: true } : {}),
      // Claude Code validates this document with the MCP SDK's schema, which requires `jwks_uri` (B3, observed on 2.1.296).
      ...(kind === 'oidc' ? { jwks_uri: `${iss}/jwks`, userinfo_endpoint: `${iss}/userinfo`, subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] } : {}),
    };
  }

  /** Whether a redirect may receive a code: the policy first, then what the client registered. */
  #redirectAllowed(client: ClientRecord, uri: string, o: OAuthOptions): boolean {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return false;
    }
    const loopback = u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    const claude = o.redirects === 'loopback+claude' && u.protocol === 'https:' && ['claude.ai', 'claude.com'].includes(u.hostname);
    if ((!loopback && !claude) || u.hash || u.username || u.password) return false;
    if (client.redirectUris.some((r) => safeHref(r) === u.href)) return true;
    if (!o.looseLoopback || client.confidential || !loopback) return false;
    // Gitea: a registered IP-literal loopback address matches that address on any port (RFC 8252 §7.3); `localhost` never does.
    return client.redirectUris.some((r) => {
      const reg = safeUrl(r);
      return !!reg && reg.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(reg.hostname) && !reg.port && reg.hostname === u.hostname && reg.pathname === u.pathname;
    });
  }

  #authorize(url: URL, res: ServerResponse, ctx: Ctx, o: OAuthOptions): void {
    ctx.endpoint = 'authorize';
    const q = url.searchParams;
    ctx.params = loggable(q.entries());
    const client = this.#clients.get(q.get('client_id') ?? '');
    const redirect = q.get('redirect_uri');
    const target = redirect ?? (client?.redirectUris.length === 1 ? client.redirectUris[0]! : null);
    if (!client) return this.#page(res, ctx, 'invalid_client', 'Unknown client.');
    if (!target || !this.#redirectAllowed(client, target, o)) return this.#page(res, ctx, 'invalid_redirect_uri', 'That redirect address is not allowed.');
    const state = q.get('state');
    const back = (params: Record<string, string>) => {
      const to = new URL(target);
      for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
      if (state) to.searchParams.set('state', state);
      res.writeHead(302, { location: to.href, 'cache-control': 'no-store' });
      res.end();
    };
    const fail = (error: string, description: string) => ((ctx.error = error), back({ error, error_description: description }));
    if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only code.');
    const challenge = q.get('code_challenge');
    const method = (q.get('code_challenge_method') ?? 'plain') as 'S256' | 'plain';
    if (!challenge) return fail('invalid_request', 'code_challenge is required.');
    if (!o.pkce.includes(method)) return fail('invalid_request', `code_challenge_method ${method} is not supported.`);
    if (o.requireState && !state) return fail('invalid_request', 'state is required.');
    if (o.authorize === 'deny') return fail('access_denied', 'The person said no.');
    const code = `bpc_${hex(12)}`;
    this.#codes.set(code, {
      clientId: client.id,
      redirectUri: target,
      redirectGiven: redirect !== null,
      challenge,
      method,
      scope: q.get('scope') ?? '',
      subject: this.options.user,
      expiresAt: this.now() + CODE_TTL_MS,
      used: false,
      resource: q.get('resource'),
      issued: null,
    });
    back({ code, ...(o.issParam ? { iss: this.options.quirks.issMismatch ? 'https://issuer.invalid' : this.issuer! } : {}) });
  }

  /** The authorization server's own error page: it never redirects when the client or the redirect address can't be trusted. */
  #page(res: ServerResponse, ctx: Ctx, error: string, text: string): void {
    ctx.error = error;
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${error}: ${text}\n`);
  }

  async #token(req: IncomingMessage, res: ServerResponse, ctx: Ctx, o: OAuthOptions): Promise<void> {
    ctx.endpoint = 'token';
    const form = await readForm(req);
    ctx.params = loggable(form.entries());
    const basic = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    let id = form.get('client_id');
    let secret = form.get('client_secret');
    if (basic) {
      const [i, ...rest] = Buffer.from(basic[1]!, 'base64').toString().split(':');
      id = decodeURIComponent(i ?? '');
      secret = decodeURIComponent(rest.join(':'));
    }
    const client = this.#clients.get(id ?? '');
    if (!client) return this.#oauthError(res, ctx, 401, 'invalid_client', 'Unknown client.');
    if (client.secret && !(secret && same(client.secret, secret))) return this.#oauthError(res, ctx, 401, 'invalid_client', 'The client secret is missing or wrong.');
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') return this.#codeGrant(res, ctx, o, client, form);
    if (grant === 'refresh_token') return this.#refreshGrant(res, ctx, o, client, form);
    this.#oauthError(res, ctx, 400, 'unsupported_grant_type');
  }

  #codeGrant(res: ServerResponse, ctx: Ctx, o: OAuthOptions, client: ClientRecord, form: URLSearchParams): void {
    const code = this.#codes.get(form.get('code') ?? '');
    if (!code) return this.#oauthError(res, ctx, 400, 'invalid_grant', 'Unknown code.');
    if (code.used) {
      if (code.issued) code.issued.revoked = true;
      return this.#oauthError(res, ctx, 400, 'invalid_grant', 'The code was already used.');
    }
    code.used = true;
    if (this.now() > code.expiresAt) return this.#oauthError(res, ctx, 400, 'invalid_grant', 'The code expired.');
    if (code.clientId !== client.id) return this.#oauthError(res, ctx, 400, 'invalid_grant', 'The code was issued to another client.');
    if (code.redirectGiven && form.get('redirect_uri') !== code.redirectUri) return this.#oauthError(res, ctx, 400, 'invalid_grant', 'redirect_uri differs from the authorization request.');
    const verifier = form.get('code_verifier');
    if (!verifier) return this.#oauthError(res, ctx, 400, 'invalid_grant', 'code_verifier is required.');
    if ((code.method === 'S256' ? sha256b64(verifier) : verifier) !== code.challenge) return this.#oauthError(res, ctx, 400, 'invalid_grant', 'PKCE verification failed.');
    const token = this.#issue(o, client, code.subject, code.scope, code.resource);
    code.issued = token;
    this.#tokenResponse(res, ctx, o, token);
  }

  #refreshGrant(res: ServerResponse, ctx: Ctx, o: OAuthOptions, client: ClientRecord, form: URLSearchParams): void {
    const old = this.#byRefresh.get(form.get('refresh_token') ?? '');
    if (!old || old.clientId !== client.id || old.revoked || old.rotated || old.refreshExpiresAt === null || this.now() > old.refreshExpiresAt)
      return this.#oauthError(res, ctx, 400, 'invalid_grant', 'The refresh token is unknown, used, expired or revoked.');
    if (o.rotateRefresh) old.rotated = true;
    const token = this.#issue(o, client, old.subject, old.scope, form.get('resource') ?? old.resource, o.rotateRefresh ? undefined : old.refresh);
    this.#tokenResponse(res, ctx, o, token);
  }

  #issue(o: OAuthOptions, client: ClientRecord, subject: string, scope: string, resource: string | null, keepRefresh?: string | null): TokenRecord {
    const wantsOffline = scope.split(/\s+/).includes('offline_access');
    const refresh = keepRefresh ?? (!o.refreshNeedsOffline || wantsOffline ? `bprt_${hex(16)}` : null);
    const token: TokenRecord = {
      access: `bpat_${hex(16)}`,
      refresh,
      clientId: client.id,
      subject,
      scope,
      expiresAt: this.now() + o.accessTtlSec * 1000,
      refreshExpiresAt: refresh ? this.now() + o.refreshTtlSec * 1000 : null,
      revoked: false,
      rotated: false,
      resource,
    };
    this.#byAccess.set(token.access, token);
    if (refresh) this.#byRefresh.set(refresh, token);
    return token;
  }

  #tokenResponse(res: ServerResponse, ctx: Ctx, o: OAuthOptions, t: TokenRecord): void {
    this.#json(res, ctx, 200, { access_token: t.access, token_type: 'Bearer', expires_in: o.accessTtlSec, ...(t.scope ? { scope: t.scope } : {}), ...(t.refresh ? { refresh_token: t.refresh } : {}) }, undefined, { pragma: 'no-cache' });
  }

  async #register(req: IncomingMessage, res: ServerResponse, ctx: Ctx, o: OAuthOptions): Promise<void> {
    ctx.endpoint = 'register';
    const key = req.socket.remoteAddress ?? 'unknown';
    const window = (this.#registrations.get(key) ?? []).filter((at) => this.now() - at < 3_600_000);
    if (o.dcrLimitPerHour !== null && window.length >= o.dcrLimitPerHour) return this.#oauthError(res, ctx, 429, 'too_many_requests', 'Too many registrations from this address.');
    window.push(this.now());
    this.#registrations.set(key, window);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof BodyTooLarge) throw e;
      return this.#oauthError(res, ctx, 400, 'invalid_client_metadata', 'The body is not JSON.');
    }
    ctx.params = loggable(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.some((u) => typeof u !== 'string')) return this.#oauthError(res, ctx, 400, 'invalid_redirect_uri', 'redirect_uris is a list of addresses.');
    const probe: ClientRecord = { id: '', name: null, redirectUris: uris as string[], confidential: false, secret: null, how: 'dcr' };
    if (!(uris as string[]).every((u) => this.#redirectAllowed(probe, u, o))) return this.#oauthError(res, ctx, 400, 'invalid_redirect_uri', 'Only loopback addresses (http://localhost, 127.0.0.1 or [::1]) are accepted.');
    const method = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : (o.tokenAuthMethods[0] ?? 'client_secret_basic');
    // A public client (`none`) is always accepted: GitLab advertises only secret-based methods yet registers the clients Claude Code asks for.
    if (method !== 'none' && o.tokenAuthMethods.length && !(o.tokenAuthMethods as string[]).includes(method)) return this.#oauthError(res, ctx, 400, 'invalid_client_metadata', `token_endpoint_auth_method ${method} is not supported.`);
    const confidential = method !== 'none';
    const client: ClientRecord = {
      id: `bpcl_${hex(8)}`,
      name: typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : null,
      redirectUris: uris as string[],
      confidential,
      secret: confidential ? `bpcs_${hex(16)}` : null,
      how: 'dcr',
    };
    this.#clients.set(client.id, client);
    this.#json(res, ctx, 201, {
      client_id: client.id,
      client_id_issued_at: Math.floor(this.now() / 1000),
      ...(client.name ? { client_name: client.name } : {}),
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
      ...(client.secret ? { client_secret: client.secret, client_secret_expires_at: 0 } : {}),
    });
  }

  async #revoke(req: IncomingMessage, res: ServerResponse, ctx: Ctx, _o: OAuthOptions): Promise<void> {
    ctx.endpoint = 'revoke';
    const form = await readForm(req);
    ctx.params = loggable(form.entries());
    const t = form.get('token') ?? '';
    const found = this.#byAccess.get(t) ?? this.#byRefresh.get(t);
    if (found) found.revoked = true;
    this.#json(res, ctx, 200, {});
  }

  #userinfo(req: IncomingMessage, res: ServerResponse, ctx: Ctx): void {
    const authn = this.#authenticate(req);
    if (!authn.ok || !authn.who.subject) return this.#oauthError(res, ctx, 401, 'invalid_token');
    this.#json(res, ctx, 200, { sub: authn.who.subject });
  }

  /* ---------- Control (another process) ---------- */

  async #control(req: IncomingMessage, res: ServerResponse, ctx: Ctx, path: string): Promise<void> {
    ctx.endpoint = 'control';
    if (req.method === 'GET' && path === '/__standin/state')
      return this.#json(res, ctx, 200, { url: this.url, issuer: this.issuer, now: this.now(), authorize: this.options.oauth ? this.options.oauth.authorize : null, quirks: this.options.quirks, clients: this.clients(), tokens: this.tokens(), requests: this.requests.slice(-50) });
    if (req.method !== 'POST') return this.#json(res, ctx, 405, { error: 'method_not_allowed' });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    } catch {
      // an empty or odd body: no parameters
    }
    if (path === '/__standin/advance') this.advance(Number(json.ms) || 0);
    else if (path === '/__standin/authorize') this.setAuthorize(json.mode === 'deny' ? 'deny' : 'approve');
    else if (path === '/__standin/quirk' && typeof json.name === 'string' && json.name in this.options.quirks) this.setQuirk(json.name as keyof Quirks, json.value === true);
    else if (path === '/__standin/revoke-all') this.revokeAll();
    else return this.#json(res, ctx, 404, { error: 'not_found' });
    this.#json(res, ctx, 200, { ok: true, now: this.now() });
  }
}

/* ---------- Small helpers ---------- */

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new BodyTooLarge());
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** A request body as parameters: a form (the OAuth way) or, for clients that send JSON, an object of strings. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const text = await readBody(req);
  if ((req.headers['content-type'] ?? '').includes('json')) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(o).filter(([, v]) => typeof v === 'string') as [string, string][]);
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text);
}

const safeUrl = (text: string): URL | null => {
  try {
    return new URL(text);
  } catch {
    return null;
  }
};
const safeHref = (text: string): string | null => safeUrl(text)?.href ?? null;
