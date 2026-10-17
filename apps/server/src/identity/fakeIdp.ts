// A fake OpenID Connect provider for tests: real keys (RSA and EC), a discovery document, a JWKS and a token endpoint, all answered by a
// `fetch` stand-in, so the client's checks run on genuinely signed tokens. Tests set what the next ID token says (`next`) and can sign
// one by hand (`sign`) with any header to try a forgery.

import { createHmac, generateKeyPairSync, sign as signRaw, type KeyObject } from 'node:crypto';
import { OidcClient } from './oidc.js';

export const ISSUER = 'https://idp.example.com';
export const CLIENT_ID = 'portal-client';

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

export function fakeIdp(now: () => number = () => Date.now()) {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keys: { kid: string; key: KeyObject; pub: KeyObject; alg: string }[] = [
    { kid: 'rsa1', key: rsa.privateKey, pub: rsa.publicKey, alg: 'RS256' },
    { kid: 'ec1', key: ec.privateKey, pub: ec.publicKey, alg: 'ES256' },
  ];
  const calls: { url: string; init?: RequestInit }[] = [];
  /** Claims the next token answer carries (merged over sane defaults; the nonce must be set by the test from the authorize URL). */
  let next: Record<string, unknown> = {};
  let nextHeader: Record<string, unknown> | null = null;
  let rawToken: string | null = null;
  let tokenError: string | null = null;

  const sign = (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'rsa1', typ: 'JWT' }) => {
    const h = b64(header);
    const b = b64(claims);
    const data = Buffer.from(`${h}.${b}`);
    const k = keys.find((x) => x.kid === header.kid) ?? keys[0]!;
    let sig: Buffer;
    if (header.alg === 'HS256') sig = createHmac('sha256', CLIENT_ID).update(data).digest();
    else if (header.alg === 'none') sig = Buffer.alloc(0);
    else if (String(header.alg).startsWith('ES')) sig = signRaw('sha256', data, { key: k.key, dsaEncoding: 'ieee-p1363' });
    else sig = signRaw('sha256', data, k.key);
    return `${h}.${b}.${sig.toString('base64url')}`;
  };

  const claims = () => {
    const t = Math.floor(now() / 1000);
    return { iss: ISSUER, aud: CLIENT_ID, sub: 'sub-1', iat: t, exp: t + 300, email: 'ana@example.com', email_verified: true, name: 'Ana', ...next };
  };

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (url === `${ISSUER}/.well-known/openid-configuration`)
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    if (url === `${ISSUER}/jwks`) return json({ keys: keys.map((k) => ({ ...k.pub.export({ format: 'jwk' }), kid: k.kid, alg: k.alg, use: 'sig' })) });
    if (url === `${ISSUER}/token`) {
      if (tokenError) return json({ error: tokenError, error_description: 'the code abc123 is bad' }, 400);
      const tok = rawToken ?? sign(claims(), nextHeader ?? undefined);
      return json({ access_token: 'at', token_type: 'Bearer', id_token: tok });
    }
    return json({ error: 'not_found' }, 404);
  };

  return {
    calls,
    client: new OidcClient(fetchImpl, async () => {}, now),
    sign,
    claims,
    /** Rotate: a new RSA key replaces rsa1 under a new kid. */
    rotate() {
      const k = generateKeyPairSync('rsa', { modulusLength: 2048 });
      keys[0] = { kid: 'rsa2', key: k.privateKey, pub: k.publicKey, alg: 'RS256' };
    },
    set next(v: Record<string, unknown>) {
      next = v;
    },
    set header(v: Record<string, unknown> | null) {
      nextHeader = v;
    },
    set raw(v: string | null) {
      rawToken = v;
    },
    set error(v: string | null) {
      tokenError = v;
    },
  };
}

/** The state and nonce of an authorize URL. */
export function authorizeParams(url: string) {
  const u = new URL(url);
  return Object.fromEntries(u.searchParams) as Record<string, string>;
}
