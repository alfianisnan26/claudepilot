import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  auth,
  Client,
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  StreamableHTTPClientTransport,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
} from '@modelcontextprotocol/client';
import { buildStandalone } from './build.js';
import { PINNED_REDIRECT, PROVIDER_PRESETS, selfSignedCertificate, startProvider, type ProviderPreset, type StandInProvider } from './index.js';

/**
 * The stand-in is only worth having if a real client takes it for the real thing, so these tests drive it with the MCP SDK's own
 * client and OAuth code (the library Claude Code is built on) as well as with plain HTTP where the exact bytes matter.
 */

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kit-test', version: '0' } } };

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
}

/** A client-side OAuth store in memory: what Claude Code keeps for a server. */
class Memory implements OAuthClientProvider {
  tokensSaved: OAuthTokens | undefined;
  info: OAuthClientInformationMixed | undefined;
  verifier = '';
  authUrl: URL | null = null;
  discovery: OAuthDiscoveryState | undefined;
  constructor(
    readonly redirect: string,
    pre?: OAuthClientInformationMixed,
    private readonly method: 'none' | 'client_secret_basic' | 'client_secret_post' = 'none',
    private readonly scope?: string,
  ) {
    this.info = pre;
  }
  get redirectUrl() {
    return this.redirect;
  }
  /** Claude Code sends `state` (Outline refuses a request without it). */
  state() {
    return randomBytes(16).toString('hex');
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Claude Code (kit test)',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.method,
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.tokensSaved;
  }
  saveTokens(t: OAuthTokens) {
    this.tokensSaved = t;
  }
  redirectToAuthorization(u: URL) {
    this.authUrl = u;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** Sign in the way a person does: discovery and registration, the authorization URL, the redirect, the code exchange. */
async function signIn(p: StandInProvider, store: Memory, scope?: string): Promise<URL> {
  assert.equal(await auth(store, { serverUrl: p.url, ...(scope ? { scope } : {}) }), 'REDIRECT');
  const res = await fetch(store.authUrl!, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const back = new URL(res.headers.get('location')!);
  assert.equal(await auth(store, { serverUrl: p.url, authorizationCode: back.searchParams.get('code')!, ...(back.searchParams.get('iss') ? { iss: back.searchParams.get('iss')! } : {}) }), 'AUTHORIZED');
  return back;
}

async function connect(url: string, authProvider: OAuthClientProvider | { token(): Promise<string | undefined> }) {
  const client = new Client({ name: 'kit-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider }));
  return client;
}

/** What a client keeps for a client ID registered by hand: stamped with the issuer it belongs to (SEP-2352). */
const known = (p: StandInProvider, id: string, secret?: string): OAuthClientInformationMixed => ({ client_id: id, ...(secret ? { client_secret: secret } : {}), issuer: p.issuer! }) as OAuthClientInformationMixed;

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

/* ---------- The MCP endpoint ---------- */

test('every preset answers initialize, tools/list and tools/call to the SDK client with a static bearer token', async () => {
  for (const preset of PROVIDER_PRESETS) {
    const p = await startProvider(preset);
    try {
      const client = await connect(p.url, { token: async () => 'standin-pat' });
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((t) => t.name), ['whoami', 'echo'], preset);
      assert.deepEqual(JSON.parse(text(await client.callTool({ name: 'whoami', arguments: {} }))), { subject: 'standin-pat-user', via: 'static', client: null, scope: '' }, preset);
      assert.equal(text(await client.callTool({ name: 'echo', arguments: { text: 'hi' } })), 'hi', preset);
      await client.close();
    } finally {
      await p.close();
    }
  }
});

test('the wire: JSON or SSE answers, 202 for notifications, 405 for GET, -32601 for server/discover, batches', async () => {
  const p = await startProvider('outline');
  const sse = await startProvider('cloudflare');
  try {
    const bearer = { authorization: 'Bearer standin-pat' };
    const json = await post(p.url, INIT, bearer);
    assert.equal(json.status, 200);
    assert.match(json.headers.get('content-type')!, /^application\/json/);
    const init = (await json.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'standin-outline');
    // A version the stand-in does not know is answered with its newest.
    const odd = (await (await post(p.url, { ...INIT, params: { ...INIT.params, protocolVersion: '1999-01-01' } }, bearer)).json()) as { result: { protocolVersion: string } };
    assert.equal(odd.result.protocolVersion, '2025-11-25');

    const note = await post(p.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, bearer);
    assert.equal(note.status, 202);
    assert.equal(await note.text(), '');
    const discover = (await (await post(p.url, { jsonrpc: '2.0', id: 7, method: 'server/discover' }, bearer)).json()) as { error: { code: number } };
    assert.equal(discover.error.code, -32601);
    const batch = (await (await post(p.url, [INIT, { jsonrpc: '2.0', id: 2, method: 'ping' }], bearer)).json()) as { id: number }[];
    assert.deepEqual(batch.map((r) => r.id), [1, 2]);
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(p.url, { method, headers: bearer });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.get('allow'), 'POST');
    }
    assert.equal((await post(p.url + 'x', INIT, bearer)).status, 404);
    assert.equal((await fetch(p.url, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{nope' })).status, 400);

    const events = await post(sse.url, INIT, bearer);
    assert.match(events.headers.get('content-type')!, /^text\/event-stream/);
    assert.match(await events.text(), /^event: message\ndata: \{"jsonrpc":"2\.0","id":1,"result":/);
  } finally {
    await Promise.all([p.close(), sse.close()]);
  }
});

test('the 401 challenge matches what each provider was observed to send (RFC 6750, RFC 9728)', async () => {
  const shapes: Record<string, RegExp> = {
    // Cloudflare (observed): realm first, then resource_metadata, then scope.
    cloudflare: /^Bearer realm="OAuth", resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp", scope="user:read account:read"$/,
    // GitLab (observed): realm, scope, then resource_metadata.
    gitlab: /^Bearer realm="GitLab", scope="mcp", resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"$/,
    // The owner's Gitea sidecar (observed): resource_metadata then the seven API scopes.
    gitea: /^Bearer resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp", scope="write:repository write:issue write:user write:organization write:notification write:package write:misc"$/,
    outline: /^Bearer resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp", scope="read write"$/,
    // GitHub (observed): error="invalid_request" when no token came, no scope.
    github: /^Bearer error="invalid_request", error_description="No access token was provided in this request", resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"$/,
  };
  for (const [preset, shape] of Object.entries(shapes)) {
    const p = await startProvider(preset as ProviderPreset);
    try {
      const res = await post(p.url, INIT);
      assert.equal(res.status, 401, preset);
      const header = res.headers.get('www-authenticate')!;
      assert.match(header, shape, preset);
      const parsed = extractWWWAuthenticateParams(res);
      assert.equal(parsed.resourceMetadataUrl?.href, p.resourceMetadataUrl, preset);
      // A token that is present but wrong adds error="invalid_token", which is what makes clients refresh.
      const bad = await post(p.url, INIT, { authorization: 'Bearer nope' });
      assert.equal(bad.status, 401);
      assert.match(bad.headers.get('www-authenticate')!, /error="invalid_token"/);
      assert.equal(p.requests.at(-1)!.status, 401);
    } finally {
      await p.close();
    }
  }
  const outline = await startProvider('outline');
  try {
    const res = await post(outline.url, INIT);
    assert.deepEqual(await res.json(), { ok: false, error: 'authentication_required', status: 401, message: 'Authentication required' });
  } finally {
    await outline.close();
  }
});

test('gitea: `token <t>` works as well as Bearer; the sidecar answers a wrong token with 401, gitea-mcp alone with 200 and a tool error', async () => {
  const sidecar = await startProvider('gitea');
  const bare = await startProvider('gitea-bare');
  try {
    assert.equal((await post(sidecar.url, INIT, { authorization: 'token standin-pat' })).status, 200);
    assert.equal((await post(sidecar.url, INIT, { authorization: 'Basic standin-pat' })).status, 401);
    assert.equal((await post(sidecar.url, INIT, { authorization: 'Bearer wrong' })).status, 401);

    // gitea-mcp alone: no header is still a 401 with the challenge, a wrong token gets in, and only a tool call says no.
    assert.equal((await post(bare.url, INIT)).status, 401);
    const wrong = { authorization: 'Bearer wrong' };
    assert.equal((await post(bare.url, INIT, wrong)).status, 200);
    assert.equal((await post(bare.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, wrong)).status, 200);
    const call = (await (await post(bare.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, wrong)).json()) as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0]!.text, /401/);
    // The same switch at run time.
    sidecar.setQuirk('badTokenOk', true);
    assert.equal((await post(sidecar.url, INIT, wrong)).status, 200);
  } finally {
    await Promise.all([sidecar.close(), bare.close()]);
  }
});

/* ---------- Discovery ---------- */

test('discovery: RFC 9728 names the authorization server, and RFC 8414 or OIDC metadata describes it, per preset', async () => {
  const dcr: ProviderPreset[] = ['gitlab', 'cloudflare', 'outline'];
  for (const preset of PROVIDER_PRESETS) {
    const p = await startProvider(preset);
    try {
      const info = await discoverOAuthServerInfo(p.url);
      assert.equal(info.resourceMetadata?.resource, p.url, preset);
      assert.deepEqual(info.resourceMetadata?.authorization_servers, [p.issuer], preset);
      const meta = info.authorizationServerMetadata as Record<string, unknown>;
      assert.equal(meta.issuer, p.issuer, preset);
      assert.match(String(meta.authorization_endpoint), new RegExp(`^${p.authOrigin}`), preset);
      assert.equal(meta.registration_endpoint !== undefined, dcr.includes(preset), `${preset} registration_endpoint`);
      assert.deepEqual(info.resourceMetadata?.scopes_supported, p.options.oauth && p.options.oauth.resourceScopes, preset);
    } finally {
      await p.close();
    }
  }
});

test('gitea serves OIDC discovery only (no RFC 8414), with the fields Claude Code’s SDK schema requires, and its scopes differ from the resource’s', async () => {
  const p = await startProvider('gitea');
  try {
    assert.notEqual(p.authOrigin, p.origin, 'the authorization server has its own origin');
    assert.equal((await fetch(`${p.authOrigin}/.well-known/oauth-authorization-server`)).status, 404);
    const oidc = (await (await fetch(`${p.authOrigin}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    // jwks_uri is required: Claude Code 2.1.296 fails with "path jwks_uri expected string" without it (B3, observed).
    for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri', 'userinfo_endpoint', 'subject_types_supported', 'id_token_signing_alg_values_supported', 'response_types_supported'])
      assert.ok(oidc[field] !== undefined, field);
    assert.equal(oidc.registration_endpoint, undefined);
    assert.deepEqual(oidc.code_challenge_methods_supported, ['plain', 'S256']);
    assert.deepEqual(oidc.scopes_supported, ['openid', 'profile', 'email', 'groups']);
    assert.equal((await fetch(oidc.jwks_uri as string)).status, 200);
    const prm = (await (await fetch(`${p.origin}/.well-known/oauth-protected-resource/mcp`)).json()) as { scopes_supported: string[]; authorization_servers: string[] };
    assert.equal(prm.scopes_supported.length, 7);
    assert.deepEqual(prm.authorization_servers, [p.authOrigin]);
    // The bare path form is served too (Gitea's MCP serves both), Cloudflare's only the path form.
    assert.equal((await fetch(`${p.origin}/.well-known/oauth-protected-resource`)).status, 200);
    const cf = await startProvider('cloudflare');
    try {
      assert.equal((await fetch(`${cf.origin}/.well-known/oauth-protected-resource`)).status, 404);
      assert.equal((await fetch(`${cf.origin}/.well-known/oauth-protected-resource/mcp`)).status, 200);
    } finally {
      await cf.close();
    }
  } finally {
    await p.close();
  }
});

test('github: the issuer carries a path, so its metadata lives at the RFC 8414 path-inserted URL; there is no registration endpoint', async () => {
  const p = await startProvider('github');
  try {
    assert.match(p.issuer!, /\/login\/oauth$/);
    assert.equal((await fetch(`${p.authOrigin}/.well-known/oauth-authorization-server`)).status, 404);
    const meta = (await (await fetch(`${p.authOrigin}/.well-known/oauth-authorization-server/login/oauth`)).json()) as Record<string, unknown>;
    assert.equal(meta.issuer, p.issuer);
    assert.equal(meta.registration_endpoint, undefined);
    assert.equal(meta.authorization_response_iss_parameter_supported, true);
    assert.equal(meta.token_endpoint, `${p.issuer}/access_token`);
  } finally {
    await p.close();
  }
});

/* ---------- OAuth flows with the SDK client ---------- */

test('OAuth with dynamic registration (outline): discovery, register, authorize, code exchange, then a signed-in MCP session', async () => {
  const p = await startProvider('outline');
  try {
    const store = new Memory('http://localhost:24819/callback');
    const back = await signIn(p, store);
    assert.equal(back.origin + back.pathname, 'http://localhost:24819/callback');
    assert.ok(back.searchParams.get('state'));
    const registered = p.clients().find((c) => c.how === 'dcr')!;
    assert.equal(registered.confidential, false);
    assert.equal(registered.name, 'Claude Code (kit test)');
    assert.deepEqual(registered.redirectUris, ['http://localhost:24819/callback']);

    const authorize = p.requests.find((r) => r.endpoint === 'authorize')!;
    assert.equal(authorize.params!.code_challenge_method, 'S256');
    assert.equal(authorize.params!.resource, p.url);
    assert.equal(authorize.params!.redirect_uri, 'http://localhost:24819/callback');

    const client = await connect(p.url, store);
    assert.deepEqual(JSON.parse(text(await client.callTool({ name: 'whoami', arguments: {} }))), {
      subject: 'standin-user',
      via: 'oauth',
      client: registered.id,
      scope: authorize.params!.scope ?? '',
    });
    await client.close();
  } finally {
    await p.close();
  }
});

test('OAuth with a confidential dynamic client (gitlab-like): client_secret_basic at the token endpoint', async () => {
  const p = await startProvider('gitlab');
  try {
    const store = new Memory('http://localhost:24819/callback', undefined, 'client_secret_basic');
    await signIn(p, store);
    const client = p.clients().find((c) => c.how === 'dcr')!;
    assert.equal(client.confidential, true);
    assert.ok(client.secret);
    const token = p.requests.find((r) => r.endpoint === 'token')!;
    assert.equal(token.scheme, 'Basic');
    assert.equal(token.params!.client_secret, undefined, 'the secret went in the Authorization header, not the body');
    await (await connect(p.url, store)).close();
    // A client that sends the wrong secret is refused.
    const bad = await fetch(`${p.issuer}/oauth/token`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${client.id}:wrong`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=x' });
    assert.equal(bad.status, 401);
    assert.equal(((await bad.json()) as { error: string }).error, 'invalid_client');
  } finally {
    await p.close();
  }
});

test('OAuth with a pre-registered public client (gitea-like): no registration call, the pinned redirect, the OIDC document, the scopes the client pinned', async () => {
  const p = await startProvider('gitea');
  try {
    const scope = 'write:repository write:issue';
    const store = new Memory(PINNED_REDIRECT, known(p, 'standin-gitea-client'));
    const back = await signIn(p, store, scope);
    assert.equal(back.origin + back.pathname, PINNED_REDIRECT);
    assert.equal(back.searchParams.get('iss'), null, 'gitea sends no iss');
    assert.equal(p.requests.filter((r) => r.endpoint === 'register').length, 0);
    const authorize = p.requests.find((r) => r.endpoint === 'authorize')!;
    assert.equal(authorize.params!.client_id, 'standin-gitea-client');
    assert.equal(authorize.params!.scope, scope);
    const token = p.requests.find((r) => r.endpoint === 'token')!;
    assert.equal(token.params!.client_secret, undefined, 'a public client sends no secret');
    assert.equal(token.params!.code, '<set>');
    assert.equal(token.params!.code_verifier, '<set>');
    const client = await connect(p.url, store);
    const who = JSON.parse(text(await client.callTool({ name: 'whoami', arguments: {} }))) as { via: string; client: string; scope: string };
    assert.deepEqual([who.via, who.client, who.scope], ['oauth', 'standin-gitea-client', scope]);
    await client.close();

    // Without a pinned scope the SDK asks for what the 401 challenge names, the seven API scopes: not the OIDC scopes of Gitea's own
    // document, which differ. That is why the Gitea template pins its scopes (Claude Code: pinned scopes win).
    const unpinned = new Memory(PINNED_REDIRECT, known(p, 'standin-gitea-client'));
    await signIn(p, unpinned);
    assert.equal(p.requests.filter((r) => r.endpoint === 'authorize').at(-1)!.params!.scope, 'write:repository write:issue write:user write:organization write:notification write:package write:misc');
  } finally {
    await p.close();
  }
});

test('github: the one client is confidential, so a client with no secret cannot finish (token only, PRD D1)', async () => {
  const p = await startProvider('github');
  try {
    const store = new Memory(PINNED_REDIRECT, known(p, 'standin-github-oauth-app'));
    assert.equal(await auth(store, { serverUrl: p.url }), 'REDIRECT');
    const res = await fetch(store.authUrl!, { redirect: 'manual' });
    const back = new URL(res.headers.get('location')!);
    assert.equal(back.searchParams.get('iss'), p.issuer, 'GitHub advertises and sends iss (RFC 9207)');
    await assert.rejects(auth(store, { serverUrl: p.url, authorizationCode: back.searchParams.get('code')!, iss: back.searchParams.get('iss')! }), /client/i);
    assert.equal(p.requests.find((r) => r.endpoint === 'token')!.status, 401);
    // With the secret it works, which is why the portal cannot offer it: each workspace would hold the secret.
    const withSecret = new Memory(PINNED_REDIRECT, known(p, 'standin-github-oauth-app', 'standin-github-client-secret'), 'client_secret_post');
    await signIn(p, withSecret);
    await (await connect(p.url, withSecret)).close();
  } finally {
    await p.close();
  }
});

test('expiry and refresh: an expired access token gets a 401, the SDK refreshes, the refresh token rotates and the old one is dead', async () => {
  const p = await startProvider('outline');
  try {
    const store = new Memory('http://localhost:24819/callback');
    await signIn(p, store);
    const client = await connect(p.url, store);
    assert.equal(text(await client.callTool({ name: 'echo', arguments: { text: 'before' } })), 'before');
    const first = store.tokensSaved!;
    assert.ok(first.refresh_token);

    p.advance(3601 * 1000);
    assert.equal(text(await client.callTool({ name: 'echo', arguments: { text: 'after' } })), 'after');
    const second = store.tokensSaved!;
    assert.notEqual(second.access_token, first.access_token);
    assert.notEqual(second.refresh_token, first.refresh_token, 'refresh tokens rotate');
    const refresh = p.requests.filter((r) => r.endpoint === 'token').at(-1)!;
    assert.equal(refresh.params!.grant_type, 'refresh_token');
    assert.equal(refresh.params!.resource, p.url);
    assert.ok(p.requests.some((r) => r.endpoint === 'mcp' && r.status === 401 && r.error === 'invalid_token'));

    // The first refresh token was used: presenting it again is invalid_grant.
    const reg = p.clients().find((c) => c.how === 'dcr')!;
    const replay = await fetch(`${p.issuer}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: first.refresh_token!, client_id: reg.id }) });
    assert.equal(replay.status, 400);
    assert.equal(((await replay.json()) as { error: string }).error, 'invalid_grant');

    // Once the refresh token itself ages out, a fresh sign-in is the only way back.
    p.advance(31 * 24 * 3600 * 1000);
    await assert.rejects(client.callTool({ name: 'echo', arguments: { text: 'late' } }));
    await client.close();
  } finally {
    await p.close();
  }
});

test('revocation: revokeAll and the revocation endpoint make a token worthless', async () => {
  const p = await startProvider('outline');
  try {
    const store = new Memory('http://localhost:24819/callback');
    await signIn(p, store);
    const access = store.tokensSaved!.access_token;
    assert.equal((await post(p.url, INIT, { authorization: `Bearer ${access}` })).status, 200);
    const reg = p.clients().find((c) => c.how === 'dcr')!;
    const revoke = await fetch(`${p.issuer}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: access, client_id: reg.id }) });
    assert.equal(revoke.status, 200);
    assert.equal((await post(p.url, INIT, { authorization: `Bearer ${access}` })).status, 401);
    const again = new Memory('http://localhost:24819/callback', store.info);
    await signIn(p, again);
    p.revokeAll();
    assert.equal((await post(p.url, INIT, { authorization: `Bearer ${again.tokensSaved!.access_token}` })).status, 401);
  } finally {
    await p.close();
  }
});

test('refresh tokens follow offline_access where the provider needs it (cloudflare, github); a lifetime of its own per option', async () => {
  const p = await startProvider('cloudflare');
  try {
    // The SDK adds offline_access itself when the authorization server advertises it, so a signed-in client gets a refresh token.
    const sdk = new Memory('http://localhost:24819/callback');
    await signIn(p, sdk);
    assert.match(p.requests.find((r) => r.endpoint === 'authorize')!.params!.scope!, /offline_access/);
    assert.ok(sdk.tokensSaved!.refresh_token);
    assert.equal(sdk.tokensSaved!.expires_in, 3600);

    // A client that does not ask for offline_access gets an access token and nothing to refresh it with.
    const reg = ((await (await fetch(`${p.issuer}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost:24819/callback'], token_endpoint_auth_method: 'none' }) })).json()) as { client_id: string }).client_id;
    const verifier = 'v'.repeat(50);
    const challenge = (await import('node:crypto')).createHash('sha256').update(verifier).digest('base64url');
    const authorize = await fetch(`${p.issuer}/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg, redirect_uri: 'http://localhost:24819/callback', code_challenge: challenge, code_challenge_method: 'S256', scope: 'user:read' })}`, { redirect: 'manual' });
    const code = new URL(authorize.headers.get('location')!).searchParams.get('code')!;
    const token = (await (await fetch(`${p.issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: reg, code, code_verifier: verifier, redirect_uri: 'http://localhost:24819/callback' }) })).json()) as Record<string, unknown>;
    assert.ok(token.access_token);
    assert.equal(token.refresh_token, undefined);
  } finally {
    await p.close();
  }
  const short = await startProvider('outline', { oauth: { accessTtlSec: 60, refreshTtlSec: 120 } });
  try {
    const store = new Memory('http://localhost:24819/callback');
    await signIn(short, store);
    assert.equal(store.tokensSaved!.expires_in, 60);
    short.advance(121 * 1000);
    const reg = short.clients().find((c) => c.how === 'dcr')!;
    const late = await fetch(`${short.issuer}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: store.tokensSaved!.refresh_token!, client_id: reg.id }) });
    assert.equal(late.status, 400, 'the refresh token aged out');
  } finally {
    await short.close();
  }
});

/* ---------- Refusals ---------- */

test('redirects: loopback only; an https portal address is refused at registration and at authorization, claude.ai only when allowed', async () => {
  const p = await startProvider('outline');
  try {
    const register = (uris: string[]) => fetch(`${p.issuer}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: uris, token_endpoint_auth_method: 'none' }) });
    for (const bad of ['https://portal.example.com/callback', 'http://example.com/callback', 'http://localhost:1/cb#frag', 'javascript:alert(1)', 'https://claude.ai.evil.example/api/mcp/auth_callback']) {
      const res = await register([bad]);
      assert.equal(res.status, 400, bad);
      assert.equal(((await res.json()) as { error: string }).error, 'invalid_redirect_uri', bad);
    }
    assert.equal((await register(['https://claude.ai/api/mcp/auth_callback'])).status, 400, 'claude.ai only under loopback+claude');
    for (const ok of ['http://localhost:24819/callback', 'http://127.0.0.1:5000/cb', 'http://[::1]:7000/cb']) assert.equal((await register([ok])).status, 201, ok);
    assert.equal((await register([])).status, 400);
    assert.equal((await fetch(`${p.issuer}/oauth/register`, { method: 'POST', body: 'not json' })).status, 400);

    // At authorization a redirect address the client did not register is never redirected to: a plain 400.
    const client = ((await (await register(['http://localhost:24819/callback'])).json()) as { client_id: string }).client_id;
    const challenge = 'x'.repeat(43);
    const authorize = (redirect: string) => fetch(`${p.issuer}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 's' })}`, { redirect: 'manual' });
    for (const other of ['http://localhost:24820/callback', 'http://localhost:24819/other', 'https://portal.example.com/cb']) {
      const res = await authorize(other);
      assert.equal(res.status, 400, other);
      assert.equal(res.headers.get('location'), null, other);
    }
    assert.equal((await authorize('http://localhost:24819/callback')).status, 302);
    assert.equal((await fetch(`${p.issuer}/oauth/authorize?client_id=nobody&redirect_uri=http://localhost/cb`, { redirect: 'manual' })).status, 400);
  } finally {
    await p.close();
  }
  const claude = await startProvider('outline', { oauth: { redirects: 'loopback+claude' } });
  try {
    const res = await fetch(`${claude.issuer}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }) });
    assert.equal(res.status, 201);
  } finally {
    await claude.close();
  }
});

test('gitea: a registered redirect matches exactly, except an IP-literal loopback address, which matches on any port; localhost never does', async () => {
  const p = await startProvider('gitea');
  try {
    const challenge = 'x'.repeat(43);
    const authorize = (redirect: string) => fetch(`${p.authOrigin}/login/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'standin-gitea-client', redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256' })}`, { redirect: 'manual' });
    assert.equal((await authorize('http://localhost:24819/callback')).status, 302);
    assert.equal((await authorize('http://localhost:24818/callback')).status, 400, 'localhost needs the registered port');
    assert.equal((await authorize('http://127.0.0.1:31337/callback')).status, 302, 'the registered 127.0.0.1 address takes any port');
    assert.equal((await authorize('http://127.0.0.1:31337/other')).status, 400, 'but not another path');
    assert.equal((await authorize('http://[::1]:31337/callback')).status, 400, '::1 was not registered');
  } finally {
    await p.close();
  }
});

test('PKCE, state, scope handling and single-use codes', async () => {
  const p = await startProvider('outline');
  try {
    const reg = ((await (await fetch(`${p.issuer}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost:24819/callback'], token_endpoint_auth_method: 'none' }) })).json()) as { client_id: string }).client_id;
    const verifier = 'v'.repeat(50);
    const challenge = (await import('node:crypto')).createHash('sha256').update(verifier).digest('base64url');
    const authorize = async (extra: Record<string, string>) => {
      const q = new URLSearchParams({ response_type: 'code', client_id: reg, redirect_uri: 'http://localhost:24819/callback', ...extra });
      const res = await fetch(`${p.issuer}/oauth/authorize?${q}`, { redirect: 'manual' });
      return new URL(res.headers.get('location')!);
    };
    const exchange = (params: Record<string, string>) =>
      fetch(`${p.issuer}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: reg, redirect_uri: 'http://localhost:24819/callback', ...params }) });

    // Missing challenge, unsupported method (outline is S256 only), missing state: error responses go back to the redirect address.
    assert.equal((await authorize({ state: 's' })).searchParams.get('error'), 'invalid_request');
    const plain = await authorize({ state: 's', code_challenge: verifier, code_challenge_method: 'plain' });
    assert.match(plain.searchParams.get('error_description')!, /plain/);
    assert.equal((await authorize({ code_challenge: challenge, code_challenge_method: 'S256' })).searchParams.get('error_description'), 'state is required.');

    // A wrong verifier burns the code; the right one works once, and a replay revokes what it issued.
    const wrong = await authorize({ state: 's1', code_challenge: challenge, code_challenge_method: 'S256' });
    assert.equal(wrong.searchParams.get('state'), 's1');
    const bad = await exchange({ grant_type: 'authorization_code', code: wrong.searchParams.get('code')!, code_verifier: 'w'.repeat(50) });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error_description: string }).error_description, /PKCE/);
    assert.equal((await exchange({ grant_type: 'authorization_code', code: wrong.searchParams.get('code')!, code_verifier: verifier })).status, 400, 'a code that failed is used up');

    const good = await authorize({ state: 's2', code_challenge: challenge, code_challenge_method: 'S256', scope: 'read' });
    const code = good.searchParams.get('code')!;
    assert.equal((await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'http://localhost:24819/other' })).status, 400, 'redirect_uri must match the request');
    const fresh = await authorize({ state: 's3', code_challenge: challenge, code_challenge_method: 'S256', scope: 'read' });
    const ok = await exchange({ grant_type: 'authorization_code', code: fresh.searchParams.get('code')!, code_verifier: verifier });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const tokens = (await ok.json()) as { access_token: string; token_type: string; scope: string };
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.scope, 'read');
    assert.equal((await post(p.url, INIT, { authorization: `Bearer ${tokens.access_token}` })).status, 200);
    const replay = await exchange({ grant_type: 'authorization_code', code: fresh.searchParams.get('code')!, code_verifier: verifier });
    assert.equal(replay.status, 400);
    assert.equal((await post(p.url, INIT, { authorization: `Bearer ${tokens.access_token}` })).status, 401, 'replaying a code revokes the token it made');

    // An old code ages out.
    const old = await authorize({ state: 's4', code_challenge: challenge, code_challenge_method: 'S256' });
    p.advance(61_000);
    assert.match(((await (await exchange({ grant_type: 'authorization_code', code: old.searchParams.get('code')!, code_verifier: verifier })).json()) as { error_description: string }).error_description, /expired/);
    assert.equal((await exchange({ grant_type: 'password', username: 'x' })).status, 400);
  } finally {
    await p.close();
  }
});

test('plain PKCE is accepted where the provider advertises it (gitea, gitlab) and the person can say no', async () => {
  const p = await startProvider('gitea');
  try {
    const q = (extra: Record<string, string>) => new URLSearchParams({ response_type: 'code', client_id: 'standin-gitea-client', redirect_uri: PINNED_REDIRECT, code_challenge: 'verifier-as-challenge', code_challenge_method: 'plain', state: 'z', ...extra });
    const ok = await fetch(`${p.authOrigin}/login/oauth/authorize?${q({})}`, { redirect: 'manual' });
    assert.ok(new URL(ok.headers.get('location')!).searchParams.get('code'));
    p.setAuthorize('deny');
    const denied = new URL((await fetch(`${p.authOrigin}/login/oauth/authorize?${q({})}`, { redirect: 'manual' })).headers.get('location')!);
    assert.equal(denied.searchParams.get('error'), 'access_denied');
    assert.equal(denied.searchParams.get('state'), 'z');
    assert.equal(p.requests.at(-1)!.error, 'access_denied');
  } finally {
    await p.close();
  }
});

test('registration is rate limited where the provider limits it (gitlab: 10 an hour per address) and the window moves with the clock', async () => {
  const p = await startProvider('gitlab', { oauth: { dcrLimitPerHour: 3 } });
  try {
    const register = () => fetch(`${p.issuer}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost:24819/callback'], token_endpoint_auth_method: 'none' }) });
    for (let i = 0; i < 3; i++) assert.equal((await register()).status, 201);
    const limited = await register();
    assert.equal(limited.status, 429);
    assert.equal(((await limited.json()) as { error: string }).error, 'too_many_requests');
    p.advance(3_600_001);
    assert.equal((await register()).status, 201);
  } finally {
    await p.close();
  }
});

test('hostile modes: a mismatched iss or issuer is caught by the SDK client', async () => {
  const wrongIss = await startProvider('github', { quirks: { issMismatch: true } });
  try {
    const store = new Memory(PINNED_REDIRECT, known(wrongIss, 'standin-github-oauth-app', 'standin-github-client-secret'), 'client_secret_post');
    assert.equal(await auth(store, { serverUrl: wrongIss.url }), 'REDIRECT');
    const back = new URL((await fetch(store.authUrl!, { redirect: 'manual' })).headers.get('location')!);
    assert.equal(back.searchParams.get('iss'), 'https://issuer.invalid');
    await assert.rejects(auth(store, { serverUrl: wrongIss.url, authorizationCode: back.searchParams.get('code')!, iss: back.searchParams.get('iss')! }), /issuer/i);
  } finally {
    await wrongIss.close();
  }
  const wrongMeta = await startProvider('outline', { quirks: { metadataIssuerMismatch: true } });
  try {
    await assert.rejects(auth(new Memory('http://localhost:24819/callback'), { serverUrl: wrongMeta.url }), /issuer/i);
  } finally {
    await wrongMeta.close();
  }
});

/* ---------- Plumbing ---------- */

test('the request log keeps no secret, and the options can change while it runs', async () => {
  const p = await startProvider('outline');
  try {
    const store = new Memory('http://localhost:24819/callback');
    await signIn(p, store);
    const client = await connect(p.url, store);
    await client.listTools();
    await client.close();
    const dump = JSON.stringify(p.requests);
    for (const [what, secret] of Object.entries({ access: store.tokensSaved!.access_token, refresh: store.tokensSaved!.refresh_token!, verifier: store.verifier })) assert.ok(secret && !dump.includes(secret), `${what} must not be in the log`);
    assert.ok(p.requests.some((r) => r.endpoint === 'mcp' && r.rpc === 'tools/list'));
    assert.ok(p.requests.some((r) => r.endpoint === 'register' && r.params!.client_name === 'Claude Code (kit test)'));
    assert.ok(p.tokens().length >= 1);
    for (let i = 0; i < 600; i++) await post(p.url, INIT);
    assert.equal(p.requests.length, 500, 'the log is capped');
    p.options.oauth && (p.options.oauth.requireState = false);
  } finally {
    await p.close();
  }
});

test('with oauth off the 401 names no metadata, and pre-registered clients can be added at run time', async () => {
  const p = await startProvider(null, { oauth: false });
  try {
    const res = await post(p.url, INIT);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    assert.equal(p.issuer, null);
    assert.equal((await fetch(`${p.origin}/.well-known/oauth-protected-resource/mcp`)).status, 404);
    assert.equal((await post(p.url, INIT, { authorization: 'Bearer standin-pat' })).status, 200);
  } finally {
    await p.close();
  }
  const q = await startProvider('gitlab');
  try {
    q.addClient({ id: 'extra', redirectUris: ['http://localhost:9999/cb'], secret: 's3cret', name: 'Extra' });
    assert.deepEqual(q.clients().find((c) => c.id === 'extra'), { id: 'extra', name: 'Extra', redirectUris: ['http://localhost:9999/cb'], confidential: true, secret: 's3cret', how: 'pre-registered' });
  } finally {
    await q.close();
  }
});

test('https: with a certificate the metadata and the endpoints carry https URLs (Claude Code takes authServerMetadataUrl only as https)', async () => {
  const tls = selfSignedCertificate(1);
  const p = await startProvider('gitea', { tls });
  try {
    assert.match(p.url, /^https:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.match(p.issuer!, /^https:\/\//);
    const get = (url: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const u = new URL(url);
        const req = httpsRequest({ host: u.hostname, port: u.port, path: u.pathname, ca: tls.cert, servername: 'localhost' }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
    const meta = await get(`${p.authOrigin}/.well-known/openid-configuration`);
    assert.equal(meta.status, 200);
    const doc = JSON.parse(meta.body) as { issuer: string; authorization_endpoint: string };
    assert.equal(doc.issuer, p.issuer);
    assert.match(doc.authorization_endpoint, /^https:\/\//);
    assert.equal(JSON.parse((await get(`${p.origin}/.well-known/oauth-protected-resource/mcp`)).body).resource, p.url);
  } finally {
    await p.close();
  }
});

test('standalone: the bundle runs by itself under plain node, announces itself, serves, and is steered by /__standin/*', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-standin-'));
  const file = join(dir, 'standin.cjs');
  writeFileSync(file, buildStandalone(), { mode: 0o755 });
  const child = spawn(process.execPath, [file, '--preset', 'gitea', '--port', '0', '--auth-port', '0', '--control', '--access-ttl', '120', '--static-token', 'fixed-token=ada', '--client', `cli-client=${PINNED_REDIRECT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const ready = await new Promise<{ ready: boolean; url: string; issuer: string; staticTokens: string[]; clients: { id: string }[]; control: boolean }>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (c: Buffer) => {
        out += c;
        if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0]!));
      });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`standin exited ${code}`)));
    });
    assert.equal(ready.ready, true);
    assert.deepEqual(ready.staticTokens, ['fixed-token']);
    assert.deepEqual(ready.clients.map((c) => c.id), ['cli-client'], '--client replaces the preset’s clients');
    assert.equal(ready.control, true);
    const origin = new URL(ready.url).origin;
    assert.equal((await post(ready.url, INIT)).status, 401);
    const who = (await (await post(ready.url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, { authorization: 'Bearer fixed-token' })).json()) as { result: { content: { text: string }[] } };
    assert.equal(JSON.parse(who.result.content[0]!.text).subject, 'ada');

    const state = async () => (await (await fetch(`${origin}/__standin/state`)).json()) as { authorize: string; quirks: { badTokenOk: boolean }; now: number; requests: unknown[] };
    const before = await state();
    assert.equal(before.authorize, 'approve');
    await fetch(`${origin}/__standin/authorize`, { method: 'POST', body: JSON.stringify({ mode: 'deny' }) });
    await fetch(`${origin}/__standin/quirk`, { method: 'POST', body: JSON.stringify({ name: 'badTokenOk', value: true }) });
    const advanced = (await (await fetch(`${origin}/__standin/advance`, { method: 'POST', body: JSON.stringify({ ms: 5000 }) })).json()) as { now: number };
    assert.ok(advanced.now >= before.now + 5000);
    const after = await state();
    assert.equal(after.authorize, 'deny');
    assert.equal(after.quirks.badTokenOk, true);
    assert.equal((await fetch(`${origin}/__standin/nope`, { method: 'POST' })).status, 404);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without --control the steering endpoints do not exist', async () => {
  const p = await startProvider('outline');
  try {
    assert.equal((await fetch(`${p.origin}/__standin/state`)).status, 404);
    p.setAuthorize('deny');
    assert.equal(p.options.oauth && p.options.oauth.authorize, 'deny');
  } finally {
    await p.close();
  }
});
