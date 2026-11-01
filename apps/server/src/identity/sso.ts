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
import {
  EMAIL,
  normalizeEmail,
  type OrgGroupRule,
  type OrgSsoProvider,
  type OrgSsoProviderRequest,
  type PortalUser,
  type SsoErrorCode,
  type SsoProvider,
  type SsoProviderRequest,
} from '@portal/contracts';
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
  /** Migration 420: when (and by whom) "every new account from these domains is a full admin" was confirmed; null: never, or cleared. */
  admin_ack_at: string | null;
  admin_ack_by: string | null;
  /** An organization's provider (organizations PRD §9.1, migration 472): never makes an instance admin. Null: instance-wide. */
  org_id?: string | null;
  groups_claim?: string | null;
  group_rules?: string;
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
  /** Organizations slice 10: a step-up of this signed-in account (adds the org's provider to its session; no new session). */
  stepUpAccount?: string;
  /** The hash of the web session that started it (the callback is a cross-site navigation: the Strict session cookie is not on it). */
  stepUpSession?: string;
}

/** What a finished sign-in returns to the route. `orgId` and `groups` for an organization's provider (slice 10). */
export interface SsoResult {
  user: PortalUser;
  providerId: string;
  created: boolean;
  linked: boolean;
  guarded: boolean;
  orgId: string | null;
  /** The groups claim's values (at most 200, strings only), or null when the provider reads none. Never stored. */
  groups: string[] | null;
  stepUp: boolean;
  /** A step-up: the web session (by its hash) to mark. */
  stepUpSession: string | null;
  returnTo: string;
}

/** Organizations slice 10: an org provider's own checks (group rules), given by the orgs module. */
export type OrgRulesCheck = (orgId: string, raw: unknown) => { group: string; role?: string; team?: string }[];

const ORG_GROUPS_MAX = 200;

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

/**
 * The platform role an account made at first sign-in gets (organizations slice 2, P6): admin only from an INSTANCE provider whose "every new
 * account is a full admin" was confirmed and recorded (migration 420); an organization's provider never makes an instance admin (it makes
 * org roles, §9.1); anything else is a member.
 */
export function jitRole(r: Pick<Row, 'default_role' | 'auto_create' | 'admin_ack_at' | 'org_id'>): 'admin' | 'member' {
  if (r.org_id) return 'member';
  return r.default_role === 'admin' && r.auto_create === 1 && !!r.admin_ack_at ? 'admin' : 'member';
}

/** An issuer is trusted when its https origin is exactly one on the list (no path, user info or suffix tricks: the URL's own origin). */
export function isTrustedIssuer(issuer: string, trusted: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(issuer);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  return trusted.includes(u.origin);
}

/** PORTAL_ORG_SSO_TRUSTED_ISSUERS: comma-separated https origins; anything else in it is dropped. */
export function parseTrustedIssuers(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    try {
      const u = new URL(part);
      if (u.protocol === 'https:' && !u.username && !u.password && (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash) out.push(u.origin);
      else console.warn(`[sso] PORTAL_ORG_SSO_TRUSTED_ISSUERS: ignored ${JSON.stringify(part)} (an https origin only)`);
    } catch {
      console.warn(`[sso] PORTAL_ORG_SSO_TRUSTED_ISSUERS: ignored ${JSON.stringify(part)} (not a URL)`);
    }
  }
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
    /**
     * Org providers whose issuer the operator trusts to be on the private network (PORTAL_ORG_SSO_TRUSTED_ISSUERS, exact https origins; the
     * owner's own IdPs run in the same cluster, 2026-11-01). Env only: an org admin cannot add to it. Every other org provider stays public.
     */
    private readonly trustedIssuers: readonly string[] = [],
  ) {}

  /** Whether this provider's issuer may resolve to a private address: its own flag (instance providers), or the operator's trust list. */
  #privateOk(r: Pick<Row, 'issuer' | 'allow_private_network'>): boolean {
    if (r.allow_private_network === 1) return true;
    return isTrustedIssuer(r.issuer, this.trustedIssuers);
  }

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

  /** Any provider by id (the sign-in flow). */
  #row(id: string): Row {
    const r = this.#db().prepare('SELECT * FROM sso_providers WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new AppError('NOT_FOUND', 'No such provider.');
    return r;
  }
  /** An INSTANCE provider by id (the platform admin's routes): an organization's provider is not one of them (slice 10). */
  #instanceRow(id: string): Row {
    const r = this.#row(id);
    if (r.org_id) throw new AppError('NOT_FOUND', 'No such provider.');
    return r;
  }

  /** The instance-wide providers (an organization's own provider is managed in its Org settings, slice 10). */
  list(redirectUri: string): SsoProvider[] {
    return (this.#db().prepare('SELECT * FROM sso_providers WHERE org_id IS NULL ORDER BY created_at').all() as unknown as Row[]).map((r) => this.#view(r, redirectUri));
  }

  get(id: string, redirectUri: string): SsoProvider {
    return this.#view(this.#instanceRow(id), redirectUri);
  }

  /* ---------- Organizations slice 10 (§9.2, §9.3, §9.5): org domains route to the org's provider ---------- */

  /** The org that holds this domain VERIFIED, while the org is active, with its enabled provider; null otherwise. */
  #orgRoute(domain: string): { id: string; name: string; orgId: string; requireSso: boolean } | null {
    const r = this.db()
      ?.prepare(
        `SELECT p.id, p.name, o.id AS org_id, o.policies FROM org_domains d JOIN orgs o ON o.id = d.org_id AND o.state = 'active'
         JOIN sso_providers p ON p.org_id = d.org_id AND p.enabled = 1 WHERE d.domain = ? AND d.state = 'verified'`,
      )
      .get(domain) as { id: string; name: string; org_id: string; policies: string } | undefined;
    if (!r) return null;
    let requireSso = false;
    try {
      requireSso = (JSON.parse(r.policies) as { requireSso?: unknown })?.requireSso === true;
    } catch {
      requireSso = false;
    }
    return { id: r.id, name: r.name, orgId: r.org_id, requireSso };
  }

  /**
   * The enabled provider that vouches for this email's domain, or null (the email uses its password). A domain verified by an org goes to
   * that org's provider first (§9.3); `passwordToo` when that org does not require SSO (an account with a password may still use it, §9.4).
   */
  forEmail(rawEmail: string): { id: string; name: string; orgId?: string; passwordToo?: boolean } | null {
    const email = normalizeEmail(rawEmail);
    if (!EMAIL.test(email)) return null;
    const domain = email.slice(email.lastIndexOf('@') + 1);
    let org: ReturnType<SsoProviders['forEmail']> = null;
    try {
      const o = this.#orgRoute(domain);
      if (o) org = { id: o.id, name: o.name, orgId: o.orgId, passwordToo: !o.requireSso };
    } catch {
      org = null; // the org tables cannot be read: instance providers only
    }
    if (org) return org;
    const rows = (this.db()?.prepare('SELECT id, name, domains FROM sso_providers WHERE enabled = 1 AND org_id IS NULL').all() ?? []) as { id: string; name: string; domains: string }[];
    const hit = rows.find((r) => (JSON.parse(r.domains) as string[]).includes(domain));
    return hit ? { id: hit.id, name: hit.name } : null;
  }

  /** Whether a password sign-in is refused for this email: an instance provider's domain, or an org domain whose org requires SSO (§9.5). */
  passwordRefused(rawEmail: string): boolean {
    const hit = this.forEmail(rawEmail);
    return !!hit && !hit.passwordToo;
  }

  /** A domain is vouched for by one enabled provider at most, and never by an instance provider once an org has verified it (slice 10). */
  #assertDomainsFree(domains: string[], self: string | null): void {
    const rows = (this.#db().prepare('SELECT id, name, domains FROM sso_providers WHERE enabled = 1 AND org_id IS NULL').all() as { id: string; name: string; domains: string }[]).filter(
      (r) => r.id !== self,
    );
    for (const r of rows) {
      const taken = (JSON.parse(r.domains) as string[]).find((d) => domains.includes(d));
      if (taken) throw new AppError('CONFLICT', `${taken} already signs in through ${r.name}.`, { details: { domains: 'Already used.' } });
    }
    const verified = this.#db().prepare(`SELECT domain FROM org_domains WHERE state = 'verified' AND domain IN (${domains.map(() => '?').join(', ')})`).get(...domains) as
      | { domain: string }
      | undefined;
    if (verified) throw new AppError('CONFLICT', `${verified.domain} is verified by an organization.`, { details: { domains: 'Already used.' } });
  }

  /** Whether an enabled instance provider serves this domain (an org cannot verify it then, §9.2 step 3). */
  instanceServes(domain: string): boolean {
    const rows = (this.#db().prepare('SELECT domains FROM sso_providers WHERE enabled = 1 AND org_id IS NULL').all() as { domains: string }[]) ?? [];
    return rows.some((r) => (JSON.parse(r.domains) as string[]).includes(domain));
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
    // Migration 420: the confirmation is recorded; it lasts while the provider still makes admins, and goes when it stops.
    const makesAdmins = defaultRole === 'admin' && autoCreate === 1;
    const adminAck = !makesAdmins ? null : newlyAdmin || !base?.admin_ack_at ? (req.acknowledgeAdminAutoCreate === true ? 'now' : null) : 'kept';
    if (makesAdmins && adminAck === null)
      throw new AppError('VALIDATION_FAILED', 'Every new account from these domains would be a full admin. Confirm that, or pick member.', {
        details: { acknowledgeAdminAutoCreate: 'Required for admin with Make accounts.' },
      });
    return {
      adminAck,
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
    const ackAt = f.adminAck ? at : null;
    this.#w()
      .prepare(
        `INSERT INTO sso_providers (id, name, issuer, client_id, client_secret, domains, scopes, default_role, default_team_id, auto_create,
           trust_unverified_email, allow_private_network, enabled, admin_ack_at, admin_ack_by, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, f.name, f.issuer, f.clientId, secret, JSON.stringify(f.domains), f.scopes, f.defaultRole, f.defaultTeamId, f.autoCreate, f.trustUnverified, f.allowPrivate, f.enabled, ackAt, ackAt ? by : null, by, at, at);
    return this.get(id, redirectUri);
  }

  update(id: string, req: SsoProviderRequest, redirectUri: string, by = 'ui'): SsoProvider {
    const base = this.#instanceRow(id);
    const f = this.#fields(req, base);
    if (f.enabled) this.#assertDomainsFree(f.domains, id);
    // Review: a secret is for one client at one issuer; a new issuer or client id never gets the old one.
    const moved = f.issuer !== base.issuer || f.clientId !== base.client_id;
    if (moved && base.client_secret && req.clientSecret === undefined)
      throw new AppError('VALIDATION_FAILED', 'A new issuer or client ID needs its client secret again.', { details: { clientSecret: 'Enter it again (or clear it).' } });
    const secret = req.clientSecret !== undefined ? this.#sealSecret(id, req.clientSecret) : base.client_secret;
    const at = this.now().toISOString();
    const [ackAt, ackBy] = f.adminAck === 'kept' ? [base.admin_ack_at, base.admin_ack_by] : f.adminAck === 'now' ? [at, by] : [null, null];
    this.#w()
      .prepare(
        `UPDATE sso_providers SET name = ?, issuer = ?, client_id = ?, client_secret = ?, domains = ?, scopes = ?, default_role = ?, default_team_id = ?,
           auto_create = ?, trust_unverified_email = ?, allow_private_network = ?, enabled = ?, admin_ack_at = ?, admin_ack_by = ?, updated_at = ? WHERE id = ?`,
      )
      .run(f.name, f.issuer, f.clientId, secret, JSON.stringify(f.domains), f.scopes, f.defaultRole, f.defaultTeamId, f.autoCreate, f.trustUnverified, f.allowPrivate, f.enabled, ackAt, ackBy, at, id);
    for (const [k, p] of this.#pending) if (p.providerId === id) this.#pending.delete(k); // a changed provider: sign-ins started before it start again
    return this.get(id, redirectUri);
  }

  remove(id: string): void {
    this.#instanceRow(id);
    this.#delete(id);
  }

  #delete(id: string): void {
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
    const r = this.#instanceRow(id);
    const doc = await this.oidc.discover(r.issuer, this.#privateOk(r), true);
    return { ok: true, authorizationEndpoint: doc.authorization_endpoint };
  }

  /* ---------- An organization's own provider (slice 10, §9.1) ---------- */

  #orgRow(orgId: string): Row | null {
    return (this.#db().prepare('SELECT * FROM sso_providers WHERE org_id = ?').get(orgId) as Row | undefined) ?? null;
  }

  #orgView = (r: Row, redirectUri: string): OrgSsoProvider => ({
    id: r.id,
    name: r.name,
    issuer: r.issuer,
    clientId: r.client_id,
    hasClientSecret: r.client_secret !== null,
    scopes: r.scopes,
    groupsClaim: r.groups_claim ?? null,
    groupRules: JSON.parse(r.group_rules ?? '[]') as OrgGroupRule[],
    autoCreate: r.auto_create === 1,
    enabled: r.enabled === 1,
    redirectUri,
    updatedAt: r.updated_at,
  });

  /** The org's provider, or null. */
  orgProvider(orgId: string, redirectUri: string): OrgSsoProvider | null {
    const r = this.#orgRow(orgId);
    return r ? this.#orgView(r, redirectUri) : null;
  }

  /**
   * Creates or changes the org's one provider. Refused for an org provider, whatever is sent (§9.1): a private network, unverified emails,
   * an instance admin role (it makes members; org roles come from the group rules). It serves the org's VERIFIED domains (its `domains`
   * column stays empty). The caller (orgs/sso.ts) has decided who may, and checks the group rules with `checkRules`.
   */
  putOrgProvider(orgId: string, req: OrgSsoProviderRequest, by: string, redirectUri: string, checkRules: OrgRulesCheck): OrgSsoProvider {
    const base = this.#orgRow(orgId);
    const f = this.#fields(
      {
        name: req.name,
        issuer: req.issuer,
        clientId: req.clientId,
        scopes: req.scopes,
        autoCreate: req.autoCreate,
        enabled: req.enabled,
        domains: base ? undefined : ['org.invalid'],
        defaultRole: 'member',
        defaultTeamId: null,
        trustUnverifiedEmail: false,
        allowPrivateNetwork: false,
      },
      base,
    );
    const groupsClaim = req.groupsClaim !== undefined ? req.groupsClaim : (base?.groups_claim ?? null);
    if (groupsClaim !== null && (typeof groupsClaim !== 'string' || !/^[A-Za-z0-9_:./-]{1,100}$/.test(groupsClaim)))
      throw new AppError('VALIDATION_FAILED', 'The groups claim is a claim name, like groups.', { details: { groupsClaim: 'e.g. groups' } });
    const rules = req.groupRules !== undefined ? checkRules(orgId, req.groupRules) : (JSON.parse(base?.group_rules ?? '[]') as unknown[]);
    const at = this.now().toISOString();
    if (!base) {
      const id = `sso_${randomBytes(9).toString('base64url')}`;
      const secret = req.clientSecret !== undefined ? this.#sealSecret(id, req.clientSecret) : null;
      this.#w()
        .prepare(
          `INSERT INTO sso_providers (id, name, issuer, client_id, client_secret, domains, scopes, default_role, default_team_id, auto_create,
             trust_unverified_email, allow_private_network, enabled, org_id, groups_claim, group_rules, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, '[]', ?, 'member', NULL, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, f.name, f.issuer, f.clientId, secret, f.scopes, f.autoCreate, f.enabled, orgId, groupsClaim, JSON.stringify(rules), by, at, at);
    } else {
      const moved = f.issuer !== base.issuer || f.clientId !== base.client_id;
      if (moved && base.client_secret && req.clientSecret === undefined)
        throw new AppError('VALIDATION_FAILED', 'A new issuer or client ID needs its client secret again.', { details: { clientSecret: 'Enter it again (or clear it).' } });
      const secret = req.clientSecret !== undefined ? this.#sealSecret(base.id, req.clientSecret) : base.client_secret;
      this.#w()
        .prepare(
          `UPDATE sso_providers SET name = ?, issuer = ?, client_id = ?, client_secret = ?, scopes = ?, auto_create = ?, enabled = ?, groups_claim = ?,
             group_rules = ?, trust_unverified_email = 0, allow_private_network = 0, default_role = 'member', updated_at = ? WHERE id = ?`,
        )
        .run(f.name, f.issuer, f.clientId, secret, f.scopes, f.autoCreate, f.enabled, groupsClaim, JSON.stringify(rules), at, base.id);
      for (const [k, p] of this.#pending) if (p.providerId === base.id) this.#pending.delete(k);
    }
    return this.orgProvider(orgId, redirectUri)!;
  }

  /** Removes the org's provider and its links (its people sign in with their passwords, or are invited again). */
  removeOrgProvider(orgId: string): boolean {
    const r = this.#orgRow(orgId);
    if (!r) return false;
    this.#delete(r.id);
    return true;
  }

  async testOrg(orgId: string): Promise<{ ok: true; authorizationEndpoint: string }> {
    const r = this.#orgRow(orgId);
    if (!r) throw new AppError('NOT_FOUND', 'No provider yet.');
    const doc = await this.oidc.discover(r.issuer, this.#privateOk(r), true);
    return { ok: true, authorizationEndpoint: doc.authorization_endpoint };
  }

  #sweep(): void {
    const now = this.now().getTime();
    for (const [k, p] of this.#pending) if (now - p.at > STATE_TTL_MS) this.#pending.delete(k);
    while (this.#pending.size >= MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value!);
  }

  /**
   * Starts a sign-in: where to send the browser, and the value of the binding cookie. `stepUp` (organizations slice 10): the signed-in
   * account that adds an org's provider to its session; the callback then signs nobody in, it marks that session.
   */
  async begin(providerId: string, email: string | null, redirectUri: string, stepUp?: { account: string; sessionHash: string; returnTo: string }): Promise<{ url: string; binding: string }> {
    const r = this.#row(providerId);
    if (r.enabled !== 1) throw new AppError('NOT_FOUND', 'No such provider.');
    if (stepUp && !r.org_id) throw new AppError('NOT_FOUND', 'No such provider.');
    const doc = await this.oidc.discover(r.issuer, this.#privateOk(r));
    this.#sweep();
    const state = randomToken();
    const pending: Pending = {
      providerId,
      nonce: randomToken(),
      verifier: randomToken(),
      redirectUri,
      binding: randomToken(),
      returnTo: stepUp?.returnTo ?? '/',
      at: this.now().getTime(),
      ...(stepUp ? { stepUpAccount: stepUp.account, stepUpSession: stepUp.sessionHash } : {}),
    };
    this.#pending.set(state, pending);
    const hint = email && EMAIL.test(normalizeEmail(email)) ? normalizeEmail(email) : undefined;
    return {
      url: this.oidc.authorizeUrl(doc, { clientId: r.client_id, redirectUri, scope: r.scopes, state, nonce: pending.nonce, verifier: pending.verifier, loginHint: hint }),
      binding: `${state}.${pending.binding}`,
    };
  }

  /** The org's provider id (enabled), for a step-up; null when it has none. */
  orgProviderId(orgId: string): string | null {
    const r = this.db()?.prepare('SELECT id FROM sso_providers WHERE org_id = ? AND enabled = 1').get(orgId) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /**
   * Finishes a sign-in: the account to open a session for. `binding` is the cookie `begin` set (the state and its secret half), so a code
   * that lands in another browser (login CSRF) is refused. A step-up marks the session that started it (its hash, kept with the state).
   */
  async finish(q: { code?: string; state?: string; error?: string }, binding: string | undefined): Promise<SsoResult> {
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
    if (r.org_id && !this.#orgActive(r.org_id)) throw new SsoError('unavailable', 'That organization is not active.');
    let secret: string | null = null;
    if (r.client_secret) {
      const box = this.box();
      if (!box) throw new SsoError('unavailable', 'The portal is locked.');
      secret = box.open(r.client_secret, this.#slot(r.id));
    }
    let claims: IdTokenClaims;
    try {
      const doc = await this.oidc.discover(r.issuer, this.#privateOk(r));
      claims = await this.oidc.finish(doc, {
        code: q.code,
        verifier: pending.verifier,
        redirectUri: pending.redirectUri,
        clientId: r.client_id,
        clientSecret: secret,
        nonce: pending.nonce,
        allowPrivate: this.#privateOk(r),
      });
    } catch (e) {
      throw new SsoError('token', e instanceof Error ? e.message : 'The provider’s answer did not check out.');
    }
    const out = pending.stepUpAccount ? this.#stepUp(r, claims, pending.stepUpAccount) : await this.#account(r, claims);
    return { ...out, orgId: r.org_id ?? null, groups: r.org_id ? this.#groups(r, claims) : null, returnTo: pending.returnTo, stepUpSession: pending.stepUpSession ?? null };
  }

  #orgActive(orgId: string): boolean {
    return (this.#db().prepare('SELECT state FROM orgs WHERE id = ?').get(orgId) as { state: string } | undefined)?.state === 'active';
  }

  /** The groups claim's string values, at most 200 (§9.6); null when the provider reads none. */
  #groups(r: Row, claims: IdTokenClaims): string[] | null {
    if (!r.groups_claim) return null;
    const raw = claims[r.groups_claim];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    return list
      .slice(0, ORG_GROUPS_MAX)
      .filter((g): g is string => typeof g === 'string' && g.length > 0 && g.length <= 256);
  }

  /**
   * The email's domain check. An instance provider: one of its domains. An org's provider (§9.2, §9.4): a domain the org holds VERIFIED; a
   * `lost` one lets only an identity linked before sign in (nothing is linked, made or joined through it).
   */
  #domainOf(r: Row, email: string): 'ok' | 'lost' {
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (!r.org_id) {
      if (!(JSON.parse(r.domains) as string[]).includes(domain)) throw new SsoError('domain', 'That email’s domain does not sign in through this provider.');
      return 'ok';
    }
    const st = (this.#db().prepare('SELECT state FROM org_domains WHERE org_id = ? AND domain = ?').get(r.org_id, domain) as { state: string } | undefined)?.state;
    if (st === 'verified') return 'ok';
    if (st === 'lost') return 'lost';
    throw new SsoError('domain', 'That email’s domain is not verified by this organization.');
  }

  #email(r: Row, claims: IdTokenClaims): { email: string; verified: boolean } {
    const email = typeof claims.email === 'string' ? normalizeEmail(claims.email) : '';
    if (!EMAIL.test(email)) throw new SsoError('email', 'The provider gave no email address.');
    const verified = claims.email_verified === true || claims.email_verified === 'true';
    // An org provider never trusts an unverified address (§9.1), whatever its row says.
    if (!verified && (r.trust_unverified_email !== 1 || r.org_id)) throw new SsoError('email', 'The provider does not vouch for this email address.');
    return { email, verified };
  }

  /**
   * A step-up (slice 10, §9.4 "links from Profile", §9.5): the signed-in account adds the org's provider to its session. The identity must be
   * this account's already, or free and carrying this account's own (verified) email on a verified domain: then it is linked. Nothing else.
   */
  #stepUp(r: Row, claims: IdTokenClaims, accountId: string): Omit<SsoResult, 'orgId' | 'groups' | 'returnTo' | 'stepUpSession'> {
    const { email } = this.#email(r, claims);
    const domain = this.#domainOf(r, email);
    let user: PortalUser;
    try {
      user = this.users.get(accountId);
    } catch {
      throw new SsoError('no_account', 'This account is gone.');
    }
    if (user.state !== 'active') throw new SsoError('disabled', 'This account is disabled.');
    const db = this.#w();
    const at = this.now().toISOString();
    const linked = db.prepare('SELECT user_id FROM sso_identities WHERE provider_id = ? AND subject = ?').get(r.id, claims.sub) as { user_id: string } | undefined;
    let newLink = false;
    if (linked) {
      if (linked.user_id !== user.id) throw new SsoError('no_account', 'That sign-in belongs to another account.');
    } else {
      if (domain === 'lost') throw new SsoError('domain', 'That email’s domain is no longer verified by this organization.');
      if (normalizeEmail(user.email) !== email) throw new SsoError('no_account', 'That sign-in is for another email address than this account’s.');
      if (db.prepare('SELECT 1 FROM sso_identities WHERE provider_id = ? AND user_id = ?').get(r.id, user.id))
        throw new SsoError('no_account', 'This account is linked to another sign-in at this provider.');
      db.prepare('INSERT INTO sso_identities (provider_id, subject, user_id, email, linked_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)').run(r.id, claims.sub, user.id, email, at, at);
      newLink = true;
    }
    db.prepare('UPDATE sso_identities SET last_login_at = ?, email = ? WHERE provider_id = ? AND subject = ?').run(at, email, r.id, claims.sub);
    return { user, providerId: r.id, created: false, linked: newLink, guarded: false, stepUp: true };
  }

  async #account(r: Row, claims: IdTokenClaims): Promise<Omit<SsoResult, 'orgId' | 'groups' | 'returnTo' | 'stepUpSession'>> {
    const { email, verified } = this.#email(r, claims);
    const domain = this.#domainOf(r, email);
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
    if (!user && domain === 'lost') throw new SsoError('domain', 'That email’s domain is no longer verified by this organization.');
    if (!user) {
      user = this.users.byEmail(email);
      // Review: an account already linked to ANOTHER subject at this provider is not taken over by a new one with the same email (a
      // mailbox the provider gave to someone else). An admin unlinks it first (removing and re-adding the provider, or the account).
      if (user && db.prepare('SELECT 1 FROM sso_identities WHERE provider_id = ? AND user_id = ? AND subject != ?').get(r.id, user.id, claims.sub))
        throw new SsoError('no_account', 'This email belongs to an account another sign-in already holds.');
      // Organizations slice 0 (P6, organizations PRD §9.4): an email match alone never takes over an account with a password of its own, an
      // admin (the founder included) or one any other SSO identity holds: whoever runs the IdP could otherwise sign in as them. The person
      // signs in with their password and links it with a step-up from inside the portal (slice 10).
      if (user && !this.users.linkableByEmail(user.id))
        throw new SsoError('no_account', 'An account with this email exists. Sign in with its password, then connect this sign-in.');
      // Organizations slice 2 (P6, §9.4 "with a verified email"): an address the provider does not vouch for (a provider set to trust
      // unverified emails) may make a NEW account, never take an existing one by its email.
      if (user && !verified) throw new SsoError('no_account', 'An account with this email exists, and the provider does not vouch for the address.');
      if (!user) {
        if (r.auto_create !== 1)
          throw new SsoError('no_account', r.org_id ? 'Ask your organization’s admin for an invitation.' : 'There is no account for this email. Ask an admin.');
        const name = typeof claims.name === 'string' ? claims.name : typeof claims.preferred_username === 'string' ? claims.preferred_username : '';
        user = await this.users.createExternal(email, name, jitRole(r), `sso:${r.id}`);
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
    // Review m2: a link that existed before to an account the linking rule now guards keeps working, and says so (the route audits it).
    return { user, providerId: r.id, created, linked: newLink && !created, guarded: !newLink && this.users.guarded(user.id), stepUp: false };
  }
}
