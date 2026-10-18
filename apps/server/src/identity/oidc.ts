// An OpenID Connect client for portal sign-in (owner, 2026-10-17: "support external SSO oauth approach"). The authorization code flow with
// PKCE (S256), a state and a nonce; the ID token is checked here, not trusted: its signature against the issuer's JWKS (RS*, PS*, ES* only:
// never `none`, never an HMAC a client secret could forge), its issuer, its audience (and `azp` when there are several), its expiry and
// its nonce. Every outbound call goes through the SSRF guard (a public address unless the provider allows a private network), with a
// time limit and a size cap. Nothing here logs a token, a code or a secret.

import { createHash, createPublicKey, randomBytes, verify as verifySig, constants, type JsonWebKey, type KeyObject } from 'node:crypto';
import { AppError } from '@isnanme/core';
import { assertPublicUrl } from '../mcp/spec.js';
import './errors.js';

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  preferred_username?: string;
  [k: string]: unknown;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
/** The SSRF guard: throws when `url` may not be called. */
export type Guard = (url: string, allowPrivate: boolean) => Promise<void>;

const ALGS: Record<string, { hash: string; kind: 'rsa' | 'pss' | 'ec' }> = {
  RS256: { hash: 'sha256', kind: 'rsa' },
  RS384: { hash: 'sha384', kind: 'rsa' },
  RS512: { hash: 'sha512', kind: 'rsa' },
  PS256: { hash: 'sha256', kind: 'pss' },
  PS384: { hash: 'sha384', kind: 'pss' },
  PS512: { hash: 'sha512', kind: 'pss' },
  ES256: { hash: 'sha256', kind: 'ec' },
  ES384: { hash: 'sha384', kind: 'ec' },
  ES512: { hash: 'sha512', kind: 'ec' },
};
const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 10_000;
const SKEW_S = 120;

const b64url = (b: Buffer) => b.toString('base64url');
export const randomToken = () => b64url(randomBytes(32));
export const pkceChallenge = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

/** An issuer as written, without a trailing slash (the discovery document must name the same one). */
export function normalizeIssuer(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new AppError('VALIDATION_FAILED', 'The issuer is a URL.', { details: { issuer: 'https://…' } });
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new AppError('VALIDATION_FAILED', 'The issuer must be https.', { details: { issuer: 'https://…' } });
  if (u.username || u.password || u.search || u.hash) throw new AppError('VALIDATION_FAILED', 'The issuer is a plain URL.', { details: { issuer: 'No query, fragment or login.' } });
  return u.href.replace(/\/+$/, '');
}

const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

export class OidcClient {
  readonly #discovery = new Map<string, { at: number; doc: OidcDiscovery }>();
  readonly #jwks = new Map<string, { at: number; keys: JsonWebKey[] }>();

  constructor(
    private readonly fetchImpl: Fetch = (u, i) => fetch(u, i),
    private readonly guard: Guard = assertPublicUrl,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async #json(url: string, allowPrivate: boolean, init?: RequestInit): Promise<unknown> {
    const u = new URL(url);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new AppError('BAD_GATEWAY', 'The provider gave an address that is not https.');
    await this.guard(url, allowPrivate);
    const res = await this.fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => {
      throw new AppError('BAD_GATEWAY', 'The provider did not answer.');
    });
    const text = await res.text();
    if (text.length > MAX_BODY) throw new AppError('BAD_GATEWAY', 'The provider’s answer is too large.');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new AppError('BAD_GATEWAY', `The provider answered ${res.status} without JSON.`);
    }
    if (!res.ok) {
      // The provider's error code only (`invalid_grant`), never its description (it may echo a code or a client id back).
      const code = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? String((body as { error: string }).error).slice(0, 60) : `HTTP ${res.status}`;
      throw new AppError('BAD_GATEWAY', `The provider refused: ${code}.`);
    }
    return body;
  }

  /** The issuer's discovery document, cached ten minutes. */
  async discover(issuer: string, allowPrivate: boolean, fresh = false): Promise<OidcDiscovery> {
    const hit = this.#discovery.get(issuer);
    if (hit && !fresh && this.now() - hit.at < 10 * 60_000) return hit.doc;
    const doc = (await this.#json(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, allowPrivate)) as Partial<OidcDiscovery>;
    for (const f of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const)
      if (typeof doc?.[f] !== 'string') throw new AppError('BAD_GATEWAY', `The provider’s discovery document has no ${f}.`);
    if (!sameIssuer(doc.issuer!, issuer)) throw new AppError('BAD_GATEWAY', 'The provider’s discovery document names another issuer.');
    for (const f of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      const u = new URL(doc[f]!);
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new AppError('BAD_GATEWAY', `The provider’s ${f} is not https.`);
    }
    this.#discovery.set(issuer, { at: this.now(), doc: doc as OidcDiscovery });
    return doc as OidcDiscovery;
  }

  authorizeUrl(
    doc: OidcDiscovery,
    p: { clientId: string; redirectUri: string; scope: string; state: string; nonce: string; verifier: string; loginHint?: string },
  ): string {
    const u = new URL(doc.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', p.clientId);
    u.searchParams.set('redirect_uri', p.redirectUri);
    u.searchParams.set('scope', p.scope);
    u.searchParams.set('state', p.state);
    u.searchParams.set('nonce', p.nonce);
    u.searchParams.set('code_challenge', pkceChallenge(p.verifier));
    u.searchParams.set('code_challenge_method', 'S256');
    if (p.loginHint) u.searchParams.set('login_hint', p.loginHint);
    return u.href;
  }

  /** Trades the code for tokens and returns the checked ID token's claims. */
  async finish(
    doc: OidcDiscovery,
    p: { code: string; verifier: string; redirectUri: string; clientId: string; clientSecret: string | null; nonce: string; allowPrivate: boolean },
  ): Promise<IdTokenClaims> {
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const methods = doc.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    if (p.clientSecret && methods.includes('client_secret_basic')) {
      const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
      headers.authorization = `Basic ${Buffer.from(`${enc(p.clientId)}:${enc(p.clientSecret)}`).toString('base64')}`;
    } else {
      form.set('client_id', p.clientId);
      if (p.clientSecret) form.set('client_secret', p.clientSecret);
    }
    const tokens = (await this.#json(doc.token_endpoint, p.allowPrivate, { method: 'POST', headers, body: form.toString() })) as { id_token?: unknown };
    if (typeof tokens?.id_token !== 'string') throw new AppError('BAD_GATEWAY', 'The provider gave no ID token.');
    return this.verifyIdToken(tokens.id_token, doc, p.clientId, p.nonce, p.allowPrivate);
  }

  async #keys(doc: OidcDiscovery, allowPrivate: boolean, fresh: boolean): Promise<JsonWebKey[]> {
    const hit = this.#jwks.get(doc.jwks_uri);
    if (hit && !fresh && this.now() - hit.at < 10 * 60_000) return hit.keys;
    const body = (await this.#json(doc.jwks_uri, allowPrivate)) as { keys?: unknown };
    const keys = Array.isArray(body?.keys) ? (body.keys as JsonWebKey[]) : [];
    this.#jwks.set(doc.jwks_uri, { at: this.now(), keys });
    return keys;
  }

  async verifyIdToken(token: string, doc: OidcDiscovery, clientId: string, nonce: string, allowPrivate: boolean): Promise<IdTokenClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new AppError('UNAUTHORIZED', 'The ID token is not a JWT.');
    const [h, b, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string; typ?: string };
    let claims: IdTokenClaims;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    } catch {
      throw new AppError('UNAUTHORIZED', 'The ID token cannot be read.');
    }
    const alg = typeof header.alg === 'string' ? ALGS[header.alg] : undefined;
    if (!alg) throw new AppError('UNAUTHORIZED', 'The ID token is signed with an algorithm the portal does not accept.');
    const pick = (keys: JsonWebKey[]) =>
      keys.filter((k) => (header.kid ? (k as { kid?: string }).kid === header.kid : true) && (!(k as { use?: string }).use || (k as { use?: string }).use === 'sig'));
    let candidates = pick(await this.#keys(doc, allowPrivate, false));
    if (!candidates.length) candidates = pick(await this.#keys(doc, allowPrivate, true)); // a rotated key: read the set again once
    const data = Buffer.from(`${h}.${b}`);
    const sig = Buffer.from(s, 'base64url');
    const ok = candidates.some((jwk) => {
      let key: KeyObject;
      try {
        key = createPublicKey({ key: jwk, format: 'jwk' });
      } catch {
        return false;
      }
      // The key's own alg and curve, when it names them, must be the token's (no checking an ES384 token with a P-256 key).
      const kAlg = (jwk as { alg?: string }).alg;
      if (kAlg && kAlg !== header.alg) return false;
      const crv = (jwk as { crv?: string }).crv;
      if (alg.kind === 'ec' && crv && crv !== { sha256: 'P-256', sha384: 'P-384', sha512: 'P-521' }[alg.hash]) return false;
      const type = key.asymmetricKeyType;
      if (alg.kind === 'ec' ? type !== 'ec' : type !== 'rsa' && type !== 'rsa-pss') return false;
      try {
        if (alg.kind === 'ec') return verifySig(alg.hash, data, { key, dsaEncoding: 'ieee-p1363' }, sig);
        if (alg.kind === 'pss') return verifySig(alg.hash, data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, sig);
        return verifySig(alg.hash, data, key, sig);
      } catch {
        return false;
      }
    });
    if (!ok) throw new AppError('UNAUTHORIZED', 'The ID token’s signature does not check out.');
    const nowS = Math.floor(this.now() / 1000);
    if (typeof claims.iss !== 'string' || !sameIssuer(claims.iss, doc.issuer)) throw new AppError('UNAUTHORIZED', 'The ID token is from another issuer.');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(clientId)) throw new AppError('UNAUTHORIZED', 'The ID token is for another client.');
    if (aud.length > 1 && claims.azp !== clientId) throw new AppError('UNAUTHORIZED', 'The ID token is for another client.');
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < nowS) throw new AppError('UNAUTHORIZED', 'The ID token has expired.');
    if (typeof claims.iat === 'number' && claims.iat - SKEW_S > nowS) throw new AppError('UNAUTHORIZED', 'The ID token is from the future.');
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW_S > nowS) throw new AppError('UNAUTHORIZED', 'The ID token is not valid yet.');
    if (claims.nonce !== nonce) throw new AppError('UNAUTHORIZED', 'The ID token is not for this sign-in.');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new AppError('UNAUTHORIZED', 'The ID token names no subject.');
    return claims;
  }
}
