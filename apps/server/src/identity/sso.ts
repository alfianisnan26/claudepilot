// SSO sign-in (owner, 2026-10-17): "login by email, kalo kedetect domainnya di whitelist SSO, jadinya pake SSO instead. kalo gak baru pake
// password." A provider names the email domains it vouches for; an email on one of them signs in through that provider only (a password is
// refused for it), any other email uses its password. The server code always works (the way back in if a provider breaks).
//
// The flow: `begin` keeps a state (provider, nonce, PKCE verifier, the redirect URI, the email hint) for ten minutes under a random id and
// binds it to the browser with a cookie holding a second random value; `finish` takes it once, checks the cookie, trades the code, checks
// the ID token (oidc.ts), then finds the account: by the provider's subject first (an identity linked before), else by email (linking
// it), else makes one when the provider allows (role and team from the provider). A disabled account is refused. The email must be on one
// of the provider's domains and verified, unless the provider says its emails are trusted.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import { EMAIL, normalizeEmail, type PortalUser, type SsoErrorCode, type SsoProvider, type SsoProviderRequest } from '@portal/contracts';
import type { SecretBox } from '../store/secretBox.js';
import { normalizeIssuer, OidcClient, randomToken, type IdTokenClaims } from './oidc.js';
import type { PortalTeams } from './teams.js';
import type { PortalUsers } from './users.js';

interface Row {
  id: string;
  name: string;
  issuer: string;
  client_id: string;
  client_secret: string | null;
  domains: string;
  scopes: string;
  default_role: 'admin' | 'member';
  default_team_id: string | null;
  auto_create: number;
  trust_unverified_email: number;
  allow_private_network: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface Pending {
  providerId: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  binding: string;
  returnTo: string;
  at: number;
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 2000;

/** A failed SSO sign-in, with the code the sign-in page shows. */
export class SsoError extends Error {
  constructor(
    readonly code: SsoErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const sha = (v: string) => createHash('sha256').update(v).digest();

export function normalizeDomains(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new AppError('VALIDATION_FAILED', 'List the email domains.', { details: { domains: 'e.g. konfersi.com' } });
  const out = [...new Set(raw.map((d) => (typeof d === 'string' ? d.trim().toLowerCase().replace(/^@/, '') : '')))];
  if (!out.length || out.length > 50 || out.some((d) => !DOMAIN.test(d)))
    throw new AppError('VALIDATION_FAILED', 'Each domain is like konfersi.com (no @, no wildcard).', { details: { domains: 'e.g. konfersi.com' } });
  return out;
}

export class SsoProviders {
  readonly #pending = new Map<string, Pending>();

  constructor(
    private readonly db: () => DatabaseSync | null,
    private readonly writable: () => DatabaseSync | null,
    private readonly box: () => SecretBox | null,
    private readonly users: PortalUsers,
    private readonly teams: PortalTeams,
    readonly oidc: OidcClient = new OidcClient(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  #db(): DatabaseSync {
    const db = this.db();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is not available.');
    return db;
  }
  #w(): DatabaseSync {
    const db = this.writable();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    return db;
  }
  #slot = (id: string) => ({ table: 'sso_providers', row: id, column: 'client_secret' });

  #view = (r: Row, redirectUri: string): SsoProvider => ({
    id: r.id,
    name: r.name,
    issuer: r.issuer,
    clientId: r.client_id,
    hasClientSecret: r.client_secret !== null,
    domains: JSON.parse(r.domains) as string[],
    scopes: r.scopes,
    defaultRole: r.default_role,
    defaultTeamId: r.default_team_id,
    autoCreate: r.auto_create === 1,
    trustUnverifiedEmail: r.trust_unverified_email === 1,
    allowPrivateNetwork: r.allow_private_network === 1,
    enabled: r.enabled === 1,
    redirectUri,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  #row(id: string): Row {
    const r = this.#db().prepare('SELECT * FROM sso_providers WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new AppError('NOT_FOUND', 'No such provider.');
    return r;
  }

  list(redirectUri: string): SsoProvider[] {
    return (this.#db().prepare('SELECT * FROM sso_providers ORDER BY created_at').all() as unknown as Row[]).map((r) => this.#view(r, redirectUri));
  }

  get(id: string, redirectUri: string): SsoProvider {
    return this.#view(this.#row(id), redirectUri);
  }

  /** The enabled provider that vouches for this email's domain, or null (the email uses its password). */
  forEmail(rawEmail: string): { id: string; name: string } | null {
    const email = normalizeEmail(rawEmail);
    if (!EMAIL.test(email)) return null;
    const domain = email.slice(email.lastIndexOf('@') + 1);
    const rows = (this.db()?.prepare('SELECT id, name, domains FROM sso_providers WHERE enabled = 1').all() ?? []) as { id: string; name: string; domains: string }[];
    const hit = rows.find((r) => (JSON.parse(r.domains) as string[]).includes(domain));
    return hit ? { id: hit.id, name: hit.name } : null;
  }

  /** A domain is vouched for by one enabled provider at most. */
  #assertDomainsFree(domains: string[], self: string | null): void {
    const rows = (this.#db().prepare('SELECT id, name, domains FROM sso_providers WHERE enabled = 1').all() as { id: string; name: string; domains: string }[]).filter((r) => r.id !== self);
    for (const r of rows) {
      const taken = (JSON.parse(r.domains) as string[]).find((d) => domains.includes(d));
      if (taken) throw new AppError('CONFLICT', `${taken} already signs in through ${r.name}.`, { details: { domains: 'Already used.' } });
    }
  }

  #fields(req: SsoProviderRequest, base: Row | null) {
    const name = req.name !== undefined ? (typeof req.name === 'string' ? req.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60) : '') : base?.name;
    if (!name) throw new AppError('VALIDATION_FAILED', 'Give it a name.', { details: { name: 'e.g. Google Workspace' } });
    const issuer = req.issuer !== undefined ? normalizeIssuer(String(req.issuer)) : base?.issuer;
    if (!issuer) throw new AppError('VALIDATION_FAILED', 'Give the issuer URL.', { details: { issuer: 'https://…' } });
    const clientId = req.clientId !== undefined ? (typeof req.clientId === 'string' ? req.clientId.trim() : '') : base?.client_id;
    if (!clientId || clientId.length > 255 || /[\s]/.test(clientId)) throw new AppError('VALIDATION_FAILED', 'Give the client ID.', { details: { clientId: 'Required.' } });
    const domains = req.domains !== undefined ? normalizeDomains(req.domains) : base ? (JSON.parse(base.domains) as string[]) : normalizeDomains(undefined);
    const scopes = req.scopes !== undefined ? String(req.scopes).trim() : (base?.scopes ?? 'openid email profile');
    if (!/^[\x21-\x7e]+( [\x21-\x7e]+)*$/.test(scopes) || !scopes.split(' ').includes('openid') || scopes.length > 300)
      throw new AppError('VALIDATION_FAILED', 'Scopes include openid.', { details: { scopes: 'openid email profile' } });
    const defaultRole = req.defaultRole !== undefined ? (req.defaultRole === 'admin' ? 'admin' : 'member') : (base?.default_role ?? 'member');
    const defaultTeamId = req.defaultTeamId !== undefined ? req.defaultTeamId : (base?.default_team_id ?? null);
    if (defaultTeamId !== null && (typeof defaultTeamId !== 'string' || !this.teams.exists(defaultTeamId)))
      throw new AppError('VALIDATION_FAILED', 'Pick an existing team.', { details: { defaultTeamId: 'No such team.' } });
    const flag = (v: boolean | undefined, old: number | undefined, dflt: boolean) => (v !== undefined ? (v === true ? 1 : 0) : old !== undefined ? old : dflt ? 1 : 0);
    const autoCreate = flag(req.autoCreate, base?.auto_create, true);
    // Review: every verified address of the domain becoming a full admin is a decision, not a default.
    const newlyAdmin = defaultRole === 'admin' && autoCreate === 1 && !(base?.default_role === 'admin' && base.auto_create === 1);
    if (newlyAdmin && req.acknowledgeAdminAutoCreate !== true)
      throw new AppError('VALIDATION_FAILED', 'Every new account from these domains would be a full admin. Confirm that, or pick member.', {
        details: { acknowledgeAdminAutoCreate: 'Required for admin with Make accounts.' },
      });
    return {
      name,
      issuer,
      clientId,
      domains,
      scopes,
      defaultRole,
      defaultTeamId,
      autoCreate,
      trustUnverified: flag(req.trustUnverifiedEmail, base?.trust_unverified_email, false),
      allowPrivate: flag(req.allowPrivateNetwork, base?.allow_private_network, false),
      enabled: flag(req.enabled, base?.enabled, true),
    };
  }

  #sealSecret(id: string, raw: unknown): string | null {
    if (raw === null) return null;
    if (typeof raw !== 'string' || !raw || raw.length > 2000) throw new AppError('VALIDATION_FAILED', 'Give the client secret.', { details: { clientSecret: 'Required.' } });
    const box = this.box();
    if (!box) throw new AppError('SERVICE_UNAVAILABLE', 'The portal is locked: its secret key isn’t loaded, so a client secret can’t be stored.');
    return box.seal(raw, this.#slot(id));
  }

  create(req: SsoProviderRequest, by: string, redirectUri: string): SsoProvider {
    const f = this.#fields(req, null);
    if (f.enabled) this.#assertDomainsFree(f.domains, null);
    const id = `sso_${randomBytes(9).toString('base64url')}`;
    const secret = req.clientSecret !== undefined ? this.#sealSecret(id, req.clientSecret) : null;
    const at = this.now().toISOString();
    this.#w()
      .prepare(
        `INSERT INTO sso_providers (id, name, issuer, client_id, client_secret, domains, scopes, default_role, default_team_id, auto_create,
           trust_unverified_email, allow_private_network, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, f.name, f.issuer, f.clientId, secret, JSON.stringify(f.domains), f.scopes, f.defaultRole, f.defaultTeamId, f.autoCreate, f.trustUnverified, f.allowPrivate, f.enabled, by, at, at);
    return this.get(id, redirectUri);
  }

  update(id: string, req: SsoProviderRequest, redirectUri: string): SsoProvider {
    const base = this.#row(id);
    const f = this.#fields(req, base);
    if (f.enabled) this.#assertDomainsFree(f.domains, id);
    // Review: a secret is for one client at one issuer; a new issuer or client id never gets the old one.
    const moved = f.issuer !== base.issuer || f.clientId !== base.client_id;
    if (moved && base.client_secret && req.clientSecret === undefined)
      throw new AppError('VALIDATION_FAILED', 'A new issuer or client ID needs its client secret again.', { details: { clientSecret: 'Enter it again (or clear it).' } });
    const secret = req.clientSecret !== undefined ? this.#sealSecret(id, req.clientSecret) : base.client_secret;
    this.#w()
      .prepare(
        `UPDATE sso_providers SET name = ?, issuer = ?, client_id = ?, client_secret = ?, domains = ?, scopes = ?, default_role = ?, default_team_id = ?,
           auto_create = ?, trust_unverified_email = ?, allow_private_network = ?, enabled = ?, updated_at = ? WHERE id = ?`,
      )
      .run(f.name, f.issuer, f.clientId, secret, JSON.stringify(f.domains), f.scopes, f.defaultRole, f.defaultTeamId, f.autoCreate, f.trustUnverified, f.allowPrivate, f.enabled, this.now().toISOString(), id);
    for (const [k, p] of this.#pending) if (p.providerId === id) this.#pending.delete(k); // a changed provider: sign-ins started before it start again
    return this.get(id, redirectUri);
  }

  remove(id: string): void {
    this.#row(id);
    const db = this.#w();
    db.prepare('DELETE FROM sso_identities WHERE provider_id = ?').run(id);
    db.prepare('DELETE FROM sso_providers WHERE id = ?').run(id);
    for (const [k, p] of this.#pending) if (p.providerId === id) this.#pending.delete(k);
  }

  removeUser(userId: string): void {
    this.writable()?.prepare('DELETE FROM sso_identities WHERE user_id = ?').run(userId);
  }

  /** Whether the issuer's discovery document reads and checks out (the admin's Test button). */
  async test(id: string): Promise<{ ok: true; authorizationEndpoint: string }> {
    const r = this.#row(id);
    const doc = await this.oidc.discover(r.issuer, r.allow_private_network === 1, true);
    return { ok: true, authorizationEndpoint: doc.authorization_endpoint };
  }

  #sweep(): void {
    const now = this.now().getTime();
    for (const [k, p] of this.#pending) if (now - p.at > STATE_TTL_MS) this.#pending.delete(k);
    while (this.#pending.size >= MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value!);
  }

  /** Starts a sign-in: where to send the browser, and the value of the binding cookie. */
  async begin(providerId: string, email: string | null, redirectUri: string): Promise<{ url: string; binding: string }> {
    const r = this.#row(providerId);
    if (r.enabled !== 1) throw new AppError('NOT_FOUND', 'No such provider.');
    const doc = await this.oidc.discover(r.issuer, r.allow_private_network === 1);
    this.#sweep();
    const state = randomToken();
    const pending: Pending = { providerId, nonce: randomToken(), verifier: randomToken(), redirectUri, binding: randomToken(), returnTo: '/', at: this.now().getTime() };
    this.#pending.set(state, pending);
    const hint = email && EMAIL.test(normalizeEmail(email)) ? normalizeEmail(email) : undefined;
    return {
      url: this.oidc.authorizeUrl(doc, { clientId: r.client_id, redirectUri, scope: r.scopes, state, nonce: pending.nonce, verifier: pending.verifier, loginHint: hint }),
      binding: `${state}.${pending.binding}`,
    };
  }

  /**
   * Finishes a sign-in: the account to open a session for. `binding` is the cookie `begin` set (the state and its secret half), so a code
   * that lands in another browser (login CSRF) is refused.
   */
  async finish(q: { code?: string; state?: string; error?: string }, binding: string | undefined): Promise<{ user: PortalUser; providerId: string; created: boolean; linked: boolean }> {
    if (q.error) throw new SsoError('provider', 'The provider refused the sign-in.');
    const state = typeof q.state === 'string' ? q.state : '';
    const pending = state ? this.#pending.get(state) : undefined;
    if (state) this.#pending.delete(state); // once
    const [bState, bSecret] = (binding ?? '').split('.');
    if (!pending || this.now().getTime() - pending.at > STATE_TTL_MS || bState !== state || !bSecret || !timingSafeEqual(sha(bSecret), sha(pending.binding)))
      throw new SsoError('state', 'This sign-in expired or was started in another browser.');
    if (typeof q.code !== 'string' || !q.code || q.code.length > 4096) throw new SsoError('provider', 'The provider sent no code.');
    let r: Row;
    try {
      r = this.#row(pending.providerId);
    } catch {
      throw new SsoError('unavailable', 'That provider is gone.');
    }
    if (r.enabled !== 1) throw new SsoError('unavailable', 'That provider is off.');
    let secret: string | null = null;
    if (r.client_secret) {
      const box = this.box();
      if (!box) throw new SsoError('unavailable', 'The portal is locked.');
      secret = box.open(r.client_secret, this.#slot(r.id));
    }
    let claims: IdTokenClaims;
    try {
      const doc = await this.oidc.discover(r.issuer, r.allow_private_network === 1);
      claims = await this.oidc.finish(doc, {
        code: q.code,
        verifier: pending.verifier,
        redirectUri: pending.redirectUri,
        clientId: r.client_id,
        clientSecret: secret,
        nonce: pending.nonce,
        allowPrivate: r.allow_private_network === 1,
      });
    } catch (e) {
      throw new SsoError('token', e instanceof Error ? e.message : 'The provider’s answer did not check out.');
    }
    return this.#account(r, claims);
  }

  async #account(r: Row, claims: IdTokenClaims): Promise<{ user: PortalUser; providerId: string; created: boolean; linked: boolean }> {
    const domains = JSON.parse(r.domains) as string[];
    const email = typeof claims.email === 'string' ? normalizeEmail(claims.email) : '';
    if (!EMAIL.test(email)) throw new SsoError('email', 'The provider gave no email address.');
    const verified = claims.email_verified === true || claims.email_verified === 'true';
    if (!verified && r.trust_unverified_email !== 1) throw new SsoError('email', 'The provider does not vouch for this email address.');
    if (!domains.includes(email.slice(email.lastIndexOf('@') + 1))) throw new SsoError('domain', 'That email’s domain does not sign in through this provider.');
    const db = this.#w();
    const at = this.now().toISOString();
    const linked = db.prepare('SELECT user_id FROM sso_identities WHERE provider_id = ? AND subject = ?').get(r.id, claims.sub) as { user_id: string } | undefined;
    let user: PortalUser | null = null;
    let created = false;
    let newLink = false;
    if (linked) {
      try {
        user = this.users.get(linked.user_id);
      } catch {
        db.prepare('DELETE FROM sso_identities WHERE provider_id = ? AND subject = ?').run(r.id, claims.sub); // its account was removed
      }
    }
    if (!user) {
      user = this.users.byEmail(email);
      // Review: an account already linked to ANOTHER subject at this provider is not taken over by a new one with the same email (a
      // mailbox the provider gave to someone else). An admin unlinks it first (removing and re-adding the provider, or the account).
      if (user && db.prepare('SELECT 1 FROM sso_identities WHERE provider_id = ? AND user_id = ? AND subject != ?').get(r.id, user.id, claims.sub))
        throw new SsoError('no_account', 'This email belongs to an account another sign-in already holds.');
      // Organizations slice 0 (P6, organizations PRD §9.4): an email match alone never takes over an account with a password of its own, an
      // admin (the founder included) or one any other SSO identity holds: whoever runs the IdP could otherwise sign in as them. An admin
      // links such an account from inside the portal (later slice), or the person keeps signing in with their password.
      if (user && !this.users.linkableByEmail(user.id))
        throw new SsoError('no_account', 'An account with this email exists. Sign in with its password, or ask an admin to link it.');
      if (!user) {
        if (r.auto_create !== 1) throw new SsoError('no_account', 'There is no account for this email. Ask an admin.');
        const name = typeof claims.name === 'string' ? claims.name : typeof claims.preferred_username === 'string' ? claims.preferred_username : '';
        user = await this.users.createExternal(email, name, r.default_role, `sso:${r.id}`);
        created = true;
        if (r.default_team_id && this.teams.exists(r.default_team_id)) this.teams.setMember(r.default_team_id, user.id, 'member', `sso:${r.id}`);
      }
      db.prepare(
        'INSERT INTO sso_identities (provider_id, subject, user_id, email, linked_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (provider_id, subject) DO UPDATE SET user_id = excluded.user_id, email = excluded.email',
      ).run(r.id, claims.sub, user.id, email, at, at);
      newLink = true;
    }
    if (user.state !== 'active') throw new SsoError('disabled', 'This account is disabled.');
    db.prepare('UPDATE sso_identities SET last_login_at = ?, email = ? WHERE provider_id = ? AND subject = ?').run(at, email, r.id, claims.sub);
    this.users.touchLogin(user.id);
    return { user, providerId: r.id, created, linked: newLink && !created };
  }
}
