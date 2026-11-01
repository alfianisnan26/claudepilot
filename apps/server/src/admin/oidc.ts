// The Admin console's sign-in through an OpenID Connect provider (owner, 2026-11-01: "sign in through git.isnan.me, only the owner for
// now"; docs/prd/organizations.md §6.11, §13.4). Not the portal's SSO providers (identity/sso.ts): one issuer, set by env, and an ALLOW LIST
// of identities; nobody else gets in, whatever the provider says, and every refusal is a platform audit row the owner reads in the console.
//
// - Config (env, deploy/k3s/portal.yaml): PORTAL_ADMIN_OIDC_ISSUER, PORTAL_ADMIN_OIDC_CLIENT_ID, PORTAL_ADMIN_OIDC_CLIENT_SECRET (from the
//   OPTIONAL Secret claudepilot-admin-oidc), PORTAL_ADMIN_OIDC_ALLOW (comma-separated), PORTAL_ADMIN_OIDC_ALLOW_PRIVATE ("true": the issuer
//   may resolve to a private address, as git.isnan.me does inside the cluster). Any of the first four missing or unreadable: off (fail closed).
// - The flow reuses the portal's OIDC client (identity/oidc.ts): pinned fetch through the SSRF guard, the discovery and JWKS caches, PKCE
//   (S256), state and nonce, and every ID token check (signature by JWKS, iss, aud/azp, exp/iat/nbf, nonce).
// - The state, the nonce and the PKCE verifier live in a short-lived `__Host-` cookie, HMAC-signed with a key that exists only in this
//   process (a restart only makes a sign-in in flight start again). Nothing here logs a token, a code or a secret.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EMAIL, normalizeEmail } from '@portal/contracts';
import { normalizeIssuer, OidcClient, randomToken, type IdTokenClaims } from '../identity/oidc.js';

export const ADMIN_OIDC_COOKIE = '__Host-pilot_admin_oidc';
/** How long a started sign-in may take at the provider. */
export const ADMIN_OIDC_STATE_TTL_MS = 10 * 60_000;
export const ADMIN_OIDC_SCOPES = 'openid email profile';

export interface AdminOidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Lowercased: emails (matched on the verified `email` claim) and, as a fallback, usernames (`preferred_username`). */
  allow: string[];
  allowPrivate: boolean;
  /** What the sign-in button names: the issuer's host. */
  name: string;
}

export interface AdminOidcEnv {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  allow?: string;
  allowPrivate?: string;
}

/** The config from env, or null (off). A broken value is off too, and says why without echoing a secret. */
export function adminOidcConfig(e: AdminOidcEnv, warn: (m: string) => void = () => {}): AdminOidcConfig | null {
  const clientId = e.clientId?.trim();
  const clientSecret = e.clientSecret?.trim();
  const allow = [...new Set((e.allow ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (!e.issuer?.trim() || !clientId || !clientSecret || !allow.length) {
    if (e.issuer?.trim() || clientId || clientSecret) warn('[portal] Admin console sign-in through OIDC is off: set the issuer, the client id and secret, and the allow list');
    return null;
  }
  let issuer: string;
  try {
    issuer = normalizeIssuer(e.issuer);
  } catch {
    warn('[portal] PORTAL_ADMIN_OIDC_ISSUER is not an https URL: Admin console sign-in through OIDC is off');
    return null;
  }
  return { issuer, clientId, clientSecret, allow, allowPrivate: e.allowPrivate?.trim() === 'true', name: new URL(issuer).host };
}

interface Pending {
  /** state, nonce, PKCE verifier */
  s: string;
  n: string;
  v: string;
  /** started at (ms) */
  at: number;
  /** step-up: the admin session it is for; sign-in: absent */
  sid?: string;
  /** the console section to come back to */
  next?: string;
}

/** Why a sign-in was refused: one code in the audit row, the same neutral page for the browser. */
export type AdminOidcRefusal = 'provider' | 'state' | 'token' | 'email_unverified' | 'not_allowed' | 'no_admin_account' | 'unavailable' | 'session';

export class AdminOidcRefused extends Error {
  constructor(
    readonly reason: AdminOidcRefusal,
    readonly who: { subject?: string; email?: string } = {},
  ) {
    super(`refused: ${reason}`);
  }
}

const SECTION = /^[a-z]{1,20}$/;

export class AdminOidc {
  readonly #key = randomBytes(32);

  constructor(
    readonly config: AdminOidcConfig,
    readonly redirectUri: string,
    private readonly client: OidcClient = new OidcClient(),
    private readonly now: () => number = Date.now,
  ) {}

  #sign(body: string): string {
    return createHmac('sha256', this.#key).update(body).digest('base64url');
  }

  /** Where to send the browser, and the value of the state cookie. */
  async start(o: { sessionId?: string; next?: string } = {}): Promise<{ url: string; cookie: string }> {
    const doc = await this.client.discover(this.config.issuer, this.config.allowPrivate);
    const p: Pending = { s: randomToken(), n: randomToken(), v: randomToken(), at: this.now() };
    if (o.sessionId) p.sid = o.sessionId;
    if (o.next && SECTION.test(o.next)) p.next = o.next;
    const body = Buffer.from(JSON.stringify(p)).toString('base64url');
    return {
      url: this.client.authorizeUrl(doc, { clientId: this.config.clientId, redirectUri: this.redirectUri, scope: ADMIN_OIDC_SCOPES, state: p.s, nonce: p.n, verifier: p.v }),
      cookie: `${body}.${this.#sign(body)}`,
    };
  }

  /** The started sign-in this cookie holds, if it is ours, unexpired and for this `state`; else null. */
  pending(cookie: string | undefined, state: string | undefined): Pending | null {
    if (!cookie || cookie.length > 2000 || !state) return null;
    const [body, mac] = cookie.split('.');
    if (!body || !mac) return null;
    const want = Buffer.from(this.#sign(body));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    let p: Pending;
    try {
      p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Pending;
    } catch {
      return null;
    }
    if (typeof p.s !== 'string' || typeof p.n !== 'string' || typeof p.v !== 'string' || typeof p.at !== 'number') return null;
    const age = this.now() - p.at;
    if (age < 0 || age > ADMIN_OIDC_STATE_TTL_MS) return null;
    const a = Buffer.from(p.s);
    const b = Buffer.from(state);
    return a.length === b.length && timingSafeEqual(a, b) ? p : null;
  }

  /**
   * Finishes a sign-in: the allowed identity's verified email (the account it maps to is the caller's to find). Throws AdminOidcRefused with
   * the reason, and what is known of who it was (subject, email) for the audit row.
   */
  async finish(q: { code?: string; state?: string; error?: string }, cookie: string | undefined): Promise<{ email: string; subject: string; pending: Pending }> {
    const pending = this.pending(cookie, q.state);
    if (!pending) throw new AdminOidcRefused('state');
    if (q.error) throw new AdminOidcRefused('provider');
    if (typeof q.code !== 'string' || !q.code || q.code.length > 4096) throw new AdminOidcRefused('provider');
    let claims: IdTokenClaims;
    try {
      const doc = await this.client.discover(this.config.issuer, this.config.allowPrivate);
      claims = await this.client.finish(doc, {
        code: q.code,
        verifier: pending.v,
        redirectUri: this.redirectUri,
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        nonce: pending.n,
        allowPrivate: this.config.allowPrivate,
      });
    } catch {
      throw new AdminOidcRefused('token');
    }
    const subject = claims.sub;
    const rawEmail = typeof claims.email === 'string' ? normalizeEmail(claims.email) : '';
    const email = EMAIL.test(rawEmail) && rawEmail.length <= 254 ? rawEmail : '';
    const who = { subject, ...(email ? { email } : {}) };
    // email_verified, when the provider says it, must be true: an address the provider does not vouch for maps to nobody.
    if ('email_verified' in claims && claims.email_verified !== true && claims.email_verified !== 'true') throw new AdminOidcRefused('email_unverified', who);
    const username = typeof claims.preferred_username === 'string' ? claims.preferred_username.trim().toLowerCase() : '';
    const allowed = (email && this.config.allow.includes(email)) || (username && this.config.allow.includes(username));
    if (!allowed) throw new AdminOidcRefused('not_allowed', who);
    // The account is found by the verified email only (a username never names an account).
    if (!email) throw new AdminOidcRefused('no_admin_account', who);
    return { email, subject, pending };
  }
}
