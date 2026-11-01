// Organization SSO (docs/prd/organizations.md §9, slice 10). Read this header before calling it.
//
// - Domains (§9.2): an org owner or admin adds a domain; the portal keeps a random challenge and shows the TXT record
//   `_claudepilot-challenge.<domain>` = `cp-verify=<challenge>`. "Check now" (rate limited per org) and a daily job look it up with
//   `node:dns` (no HTTP: no SSRF surface; a timeout, at most 20 records of 1 KiB read). Found: `verified`, unless another org holds it
//   verified (the unique index of migration 471) or an instance provider serves it. 7 failed checks in a row make a verified domain `lost`.
//   Public mail and hosting domains and public suffixes are refused (a built-in list; the full Public Suffix List is §12 Q4).
// - The provider (§9.1): one per org, stored in `sso_providers` with `org_id` by identity/sso.ts (never a private network, never an
//   unverified email, never an instance admin). It serves every domain the org holds verified. Group rules are checked here: `owner` is
//   never mapped; a team must be a team OF THIS ORG (`teams.org_id`, slice 7; its triggers also keep non-members out of it).
// - At every sign-in or step-up through it (`onSignIn`, called by identity/routes.ts): the person's last sign-in and the session's mark are
//   written; a person not in the org joins (JIT, `via = sso_jit`) with the mapped role or `defaultJoinRole`; a member removed by an admin is
//   not brought back (removal sticks until re-invited); an owner's role is never touched; with role rules the role follows the groups (no
//   match: `defaultJoinRole`); teams joined by a rule and no longer matched are left (only rows `added_by = sso:<provider>`).
// - requireSso (§9.5, owners only, and only once an owner has signed in through the provider: the lock-out guard). While on: a member whose
//   email is on a verified domain reaches the org's objects only from a web session marked by the provider (sign-in or step-up); a token, an
//   agent or a job of theirs only while their last sign-in through it is within `ssoFreshnessDays` (null: at least one, ever). Members
//   outside the verified domains count as guests unless an owner lists them as exceptions; owners are never capped. The provider cannot be
//   disabled or removed while it is on. Every decision reads these on every call (`gate`, `effectiveRole`); nothing is cached.

import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import {
  FOUNDING_USER_ID,
  ORG_DOMAIN_CHALLENGE_PREFIX,
  ORG_DOMAIN_TXT_PREFIX,
  ORG_POLICY_DEFAULTS,
  ORG_ROLE_RANK,
  ORG_SSO_LIMITS,
  ORGS_ERROR_CODES,
  SSO_API,
  actorString,
  actorUserId,
  isUserId,
  orgRef,
  type Actor,
  type OrgDomain,
  type OrgDomainState,
  type OrgGroupRule,
  type OrgId,
  type OrgRole,
  type OrgSignInSettings,
  type OrgSsoPolicyRequest,
  type OrgSsoProvider,
  type OrgSsoProviderRequest,
  type UserId,
} from '@portal/contracts';
import { emitAccessChange, requireCan } from '../authz/seam.js';
import type { SsoProviders } from '../identity/sso.js';
import type { AuditInput } from '../platform/audit.js';
import { RateLimiter } from '../rateLimit.js';
import type { OrgsService } from './service.js';

/** Looks up a name's TXT records (`node:dns` `resolveTxt`): each record is its strings. A test passes a fake. */
export type TxtResolver = (name: string) => Promise<string[][]>;

const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DNS_TIMEOUT_MS = 5_000;
const SESSION_MARK_TTL_MS = 30 * 24 * 60 * 60_000;

/** Public mail providers: one org can never vouch for everyone's address there. */
const MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'pm.me', 'aol.com', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'yandex.ru', 'zoho.com', 'tutanota.com',
  'fastmail.com', 'hey.com', 'qq.com', '163.com',
]);
/** Hosting suffixes: the suffix and every name under it (each subdomain is someone else's). */
const HOSTING_SUFFIXES = [
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com', 'web.app', 'firebaseapp.com',
  'azurewebsites.net', 'cloudfront.net', 'appspot.com', 'blogspot.com', 'wordpress.com', 'ngrok.io', 'ngrok-free.app', 'onrender.com',
  'fly.dev', 'glitch.me', 'repl.co', 'surge.sh', 'amazonaws.com',
];
/** Public suffixes of two labels (a domain that IS one is refused; the full list is a later dependency decision). */
const PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.id', 'ac.id', 'or.id', 'go.id', 'web.id', 'my.id', 'biz.id',
  'sch.id', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.cn', 'com.sg', 'com.my', 'co.nz', 'co.za', 'co.in', 'com.mx', 'com.tr', 'co.kr', 'com.hk',
  'com.tw', 'eu.org',
]);

/** The domain an org may add, or a refusal (§9.2 step 5). */
export function normalizeOrgDomain(raw: unknown): string {
  const d = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '') : '';
  if (!DOMAIN.test(d)) throw new AppError('VALIDATION_FAILED', 'A domain is like example.com (no @, no wildcard).', { details: { domain: 'e.g. example.com' } });
  const refused = () =>
    new AppError('VALIDATION_FAILED', `${d} is a public mail, hosting or registry domain: no organization can verify it.`, {
      details: { domain: 'Not allowed.', reason: ORGS_ERROR_CODES.DOMAIN_REFUSED },
    });
  if (MAIL_DOMAINS.has(d) || PUBLIC_SUFFIXES.has(d)) throw refused();
  if (HOSTING_SUFFIXES.some((s) => d === s || d.endsWith(`.${s}`))) throw refused();
  return d;
}

interface DomainRow {
  org_id: string;
  domain: string;
  state: OrgDomainState;
  challenge: string;
  verified_at: string | null;
  last_checked_at: string | null;
  failures: number;
}

export interface OrgSsoDeps {
  db: () => DatabaseSync | null;
  writable?: () => DatabaseSync | null;
  orgs: OrgsService;
  sso: SsoProviders;
  audit: (e: AuditInput) => void;
  now?: () => Date;
  resolveTxt?: TxtResolver;
}

const takenError = (domain: string) =>
  new AppError('CONFLICT', `${domain} belongs to another organization or to the portal’s own sign-in.`, { details: { domain: 'Taken.', reason: ORGS_ERROR_CODES.DOMAIN_TAKEN } });

export class OrgSso {
  readonly #db: () => DatabaseSync | null;
  readonly #w: () => DatabaseSync | null;
  readonly #orgs: OrgsService;
  readonly #sso: SsoProviders;
  readonly #audit: (e: AuditInput) => void;
  readonly #now: () => Date;
  readonly #resolveTxt: TxtResolver;
  readonly #checkLimiter = new RateLimiter(10, 60 * 60_000);
  readonly #testLimiter = new RateLimiter(10, 60 * 60_000);

  constructor(deps: OrgSsoDeps) {
    this.#db = deps.db;
    this.#w = deps.writable ?? deps.db;
    this.#orgs = deps.orgs;
    this.#sso = deps.sso;
    this.#audit = deps.audit;
    this.#now = deps.now ?? (() => new Date());
    this.#resolveTxt =
      deps.resolveTxt ??
      ((name) => {
        const r = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
        return r.resolveTxt(name);
      });
  }

  #read(): DatabaseSync {
    const db = this.#db();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is not available.');
    return db;
  }
  #write(): DatabaseSync {
    const db = this.#w();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    return db;
  }

  #record(kind: string, actor: Actor | string, orgId: string, detail: Record<string, unknown>, severity: AuditInput['severity'] = 'info'): void {
    try {
      const who = typeof actor === 'string' ? actor : actorString(actor);
      this.#audit({ kind, severity, actor: who, userId: typeof actor === 'string' ? null : actorUserId(actor), subject: `org:${orgId}`, detail: { orgId, ...detail } });
    } catch {
      // the audit never breaks a sign-in
    }
  }

  /* ---------- What every decision reads (the seam's OrgAuthority, the org resolver) ---------- */

  #policies(orgId: string): { requireSso: boolean; ssoFreshnessDays: number | null; defaultJoinRole: Exclude<OrgRole, 'owner'>; raw: Record<string, unknown> } {
    const row = this.#db()?.prepare('SELECT policies FROM orgs WHERE id = ?').get(orgId) as { policies: string } | undefined;
    let raw: Record<string, unknown> = {};
    try {
      const v = JSON.parse(row?.policies ?? '{}') as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) raw = v as Record<string, unknown>;
    } catch {
      raw = {};
    }
    const days = raw.ssoFreshnessDays;
    const join = raw.defaultJoinRole;
    return {
      requireSso: raw.requireSso === true,
      ssoFreshnessDays: typeof days === 'number' && Number.isInteger(days) && days > 0 && days <= 365 ? days : null,
      defaultJoinRole: join === 'admin' || join === 'member' || join === 'guest' ? join : ORG_POLICY_DEFAULTS.defaultJoinRole,
      raw,
    };
  }

  #verifiedDomains(orgId: string): string[] {
    return (this.#read().prepare("SELECT domain FROM org_domains WHERE org_id = ? AND state = 'verified'").all(orgId) as { domain: string }[]).map((r) => r.domain);
  }

  /** The domain of the account's email (the founding user: the founder account's), or null. */
  #emailDomain(userId: string): string | null {
    const r = (
      userId === FOUNDING_USER_ID
        ? this.#read().prepare('SELECT email FROM users WHERE founder = 1').get()
        : this.#read().prepare('SELECT email FROM users WHERE id = ?').get(userId)
    ) as { email: string } | undefined;
    if (!r?.email) return null;
    return r.email.slice(r.email.lastIndexOf('@') + 1).toLowerCase();
  }

  /** Whether the person's email is on one of the org's VERIFIED domains (whom requireSso binds). */
  #inDomain(orgId: string, userId: string): boolean {
    const d = this.#emailDomain(userId);
    return !!d && this.#verifiedDomains(orgId).includes(d);
  }

  #exception(orgId: string, userId: string): boolean {
    return !!this.#read().prepare('SELECT 1 FROM org_sso_exceptions WHERE org_id = ? AND user_id = ?').get(orgId, userId);
  }

  /**
   * The role that counts (§9.5): with requireSso on, a member outside the org's verified domains who is not an exception counts as a guest.
   * An owner is never capped. Fails closed: an unreadable database caps to guest.
   */
  effectiveRole(orgId: string, userId: UserId, role: OrgRole | null): OrgRole | null {
    if (!role || role === 'owner' || role === 'guest') return role;
    try {
      if (!this.#policies(orgId).requireSso) return role;
      if (this.#inDomain(orgId, userId) || this.#exception(orgId, userId)) return role;
      return 'guest';
    } catch {
      return 'guest';
    }
  }

  /** Whether the person's last sign-in through the org's provider is fresh enough for a token (§9.5). */
  #fresh(orgId: string, userId: string, days: number | null): boolean {
    const r = this.#read().prepare('SELECT last_at FROM org_sso_signins WHERE org_id = ? AND user_id = ?').get(orgId, userId) as { last_at: string } | undefined;
    if (!r) return false;
    if (days === null) return true;
    return this.#now().getTime() - Date.parse(r.last_at) <= days * 24 * 60 * 60_000;
  }

  /**
   * Whether this actor may reach the org's objects under requireSso (true when it is off, or the person is not bound by it). A web session
   * must carry the org's mark (`loginSessionId` `ws:<hash>`); a token, an agent or a job needs a fresh sign-in. Fails closed.
   */
  gate(orgId: string, actor: Actor): boolean {
    const userId = actorUserId(actor);
    if (!userId) return true;
    try {
      const p = this.#policies(orgId);
      if (!p.requireSso) return true;
      if (!this.#inDomain(orgId, userId)) return true; // outside the domains: capped to guest by `effectiveRole` instead
      if (actor.kind === 'user') {
        const hash = actor.loginSessionId.startsWith('ws:') ? actor.loginSessionId.slice(3) : '';
        return !!hash && !!this.#read().prepare('SELECT 1 FROM org_sso_sessions WHERE session_hash = ? AND org_id = ? AND user_id = ?').get(hash, orgId, userId);
      }
      return this.#fresh(orgId, userId, p.ssoFreshnessDays);
    } catch {
      return false;
    }
  }

  /* ---------- Sign-in through the org's provider (identity/routes.ts) ---------- */

  /** Marks the session and the person's last sign-in, then JIT and the group rules (see the header). */
  onSignIn(e: { orgId: string; providerId: string; userId: string; groups: string[] | null; created: boolean; sessionHash: string | null }): void {
    const db = this.#write();
    const at = this.#now().toISOString();
    if (!isUserId(e.userId)) return;
    db.prepare(
      'INSERT INTO org_sso_signins (org_id, user_id, provider_id, last_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, user_id) DO UPDATE SET provider_id = excluded.provider_id, last_at = excluded.last_at',
    ).run(e.orgId, e.userId, e.providerId, at);
    if (e.sessionHash) {
      db.prepare('DELETE FROM org_sso_sessions WHERE at < ?').run(new Date(this.#now().getTime() - SESSION_MARK_TTL_MS).toISOString());
      db.prepare(
        'INSERT INTO org_sso_sessions (session_hash, org_id, provider_id, user_id, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (session_hash, org_id) DO UPDATE SET provider_id = excluded.provider_id, user_id = excluded.user_id, at = excluded.at',
      ).run(e.sessionHash, e.orgId, e.providerId, e.userId, at);
    }
    if (this.#orgs.stateOf(e.orgId) !== 'active') return;
    const provider = this.#sso.orgProvider(e.orgId, '');
    if (!provider || provider.id !== e.providerId) return;
    const by = `sso:${e.providerId}`;
    const groups = new Set(e.groups ?? []);
    const matched = provider.groupRules.filter((r) => groups.has(r.group));
    const roleRules = provider.groupRules.some((r) => r.role);
    const mapped = matched.reduce<Exclude<OrgRole, 'owner'> | null>((best, r) => (r.role && (!best || ORG_ROLE_RANK[r.role] > ORG_ROLE_RANK[best]) ? r.role : best), null);
    const policies = this.#policies(e.orgId);
    const member = db.prepare('SELECT role, state FROM org_members WHERE org_id = ? AND user_id = ?').get(e.orgId, e.userId) as { role: OrgRole; state: string } | undefined;
    if (member?.state === 'removed') {
      this.#record('org.sso_signin', by, e.orgId, { userId: e.userId, joined: false, removed: true });
      return; // removal sticks until re-invited (§9.4)
    }
    let joined = false;
    let roleChange: { from: OrgRole; to: OrgRole } | null = null;
    if (!member) {
      this.#orgs.admit(e.orgId as OrgId, e.userId, mapped ?? policies.defaultJoinRole, 'sso_jit', by);
      joined = true;
    } else if (member.role !== 'owner' && roleRules) {
      const to = mapped ?? policies.defaultJoinRole;
      if (to !== member.role) {
        db.prepare("UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ? AND state = 'active' AND role != 'owner'").run(to, e.orgId, e.userId);
        roleChange = { from: member.role, to };
        emitAccessChange({ userId: e.userId, ref: orgRef(e.orgId), why: 'membership_ended' });
      }
    }
    // Teams by rule: joined when matched, left when a rule-made membership is no longer matched; manual memberships are never touched.
    const want = new Set(matched.map((r) => r.team).filter((t): t is string => !!t && this.#teamOfOrg(t, e.orgId)));
    const had = (db.prepare('SELECT team_id FROM team_members WHERE user_id = ? AND added_by = ?').all(e.userId, by) as { team_id: string }[]).map((r) => r.team_id);
    for (const t of want) {
      try {
        db.prepare("INSERT INTO team_members (team_id, user_id, role, added_by, added_at) VALUES (?, ?, 'member', ?, ?) ON CONFLICT (team_id, user_id) DO NOTHING").run(t, e.userId, by, at);
      } catch {
        // slice 7's trigger: not an active member of the team's org (never here after the checks above); the sign-in goes on
      }
    }
    for (const t of had) if (!want.has(t)) db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ? AND added_by = ?').run(t, e.userId, by);
    this.#record('org.sso_signin', by, e.orgId, { userId: e.userId, joined, roleChange, matchedGroups: matched.map((r) => r.group), created: e.created });
  }

  /** A team that belongs to this org (`teams.org_id`, slice 7). Fails closed: unreadable, no team qualifies. */
  #teamOfOrg(teamId: string, orgId: string): boolean {
    try {
      return (this.#read().prepare('SELECT org_id FROM teams WHERE id = ?').get(teamId) as { org_id?: unknown } | undefined)?.org_id === orgId;
    } catch {
      return false;
    }
  }

  /** Checks group rules (§9.6): at most 50; a group; a role (never owner) and/or a team of this org. */
  checkRules(orgId: string, raw: unknown): OrgGroupRule[] {
    if (!Array.isArray(raw) || raw.length > ORG_SSO_LIMITS.groupRulesMax)
      throw new AppError('VALIDATION_FAILED', `Up to ${ORG_SSO_LIMITS.groupRulesMax} group rules.`, { details: { groupRules: 'A list.' } });
    return raw.map((x, i) => {
      const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      const group = typeof r.group === 'string' ? r.group.trim() : '';
      if (!group || group.length > 256 || /[\u0000-\u001f\u007f]/.test(group))
        throw new AppError('VALIDATION_FAILED', `Rule ${i + 1} needs a group.`, { details: { groupRules: 'A group value.' } });
      if (r.role === 'owner') throw new AppError('VALIDATION_FAILED', 'A group never makes an owner.', { details: { groupRules: 'Admin, member or guest.' } });
      if (r.role !== undefined && r.role !== 'admin' && r.role !== 'member' && r.role !== 'guest')
        throw new AppError('VALIDATION_FAILED', `Rule ${i + 1}: admin, member or guest.`, { details: { groupRules: 'Admin, member or guest.' } });
      if (r.team !== undefined && (typeof r.team !== 'string' || !this.#teamOfOrg(r.team, orgId)))
        throw new AppError('VALIDATION_FAILED', `Rule ${i + 1}: pick a team of this organization.`, { details: { groupRules: 'A team of this organization.' } });
      if (r.role === undefined && r.team === undefined) throw new AppError('VALIDATION_FAILED', `Rule ${i + 1} gives a role or a team.`, { details: { groupRules: 'A role or a team.' } });
      return { group, ...(r.role ? { role: r.role as Exclude<OrgRole, 'owner'> } : {}), ...(r.team ? { team: r.team as string } : {}) };
    });
  }

  /* ---------- The Sign-in tab (owners and admins) ---------- */

  #domainView = (r: DomainRow): OrgDomain => ({
    domain: r.domain,
    state: r.state,
    record: { name: `${ORG_DOMAIN_CHALLENGE_PREFIX}${r.domain}`, value: `${ORG_DOMAIN_TXT_PREFIX}${r.challenge}` },
    verifiedAt: r.verified_at,
    lastCheckedAt: r.last_checked_at,
    failures: r.failures,
  });

  #domainRow(orgId: string, domain: string): DomainRow | null {
    return (this.#read().prepare('SELECT * FROM org_domains WHERE org_id = ? AND domain = ?').get(orgId, domain) as DomainRow | undefined) ?? null;
  }

  #ownerSignedIn(orgId: string, providerId: string | null): boolean {
    if (!providerId) return false;
    return !!this.#read()
      .prepare(
        `SELECT 1 FROM org_sso_signins s JOIN org_members m ON m.org_id = s.org_id AND m.user_id = s.user_id AND m.role = 'owner' AND m.state = 'active'
         WHERE s.org_id = ? AND s.provider_id = ?`,
      )
      .get(orgId, providerId);
  }

  settings(actor: Actor, orgId: OrgId, redirectUri: string): OrgSignInSettings {
    requireCan(actor, 'manage', orgRef(orgId));
    const db = this.#read();
    const domains = (db.prepare('SELECT * FROM org_domains WHERE org_id = ? ORDER BY domain').all(orgId) as unknown as DomainRow[]).map(this.#domainView);
    const provider = this.#sso.orgProvider(orgId, redirectUri);
    const p = this.#policies(orgId);
    const exceptions = (db.prepare('SELECT user_id FROM org_sso_exceptions WHERE org_id = ? ORDER BY user_id').all(orgId) as { user_id: string }[])
      .map((r) => r.user_id)
      .filter((u): u is UserId => isUserId(u));
    const hash = actor.kind === 'user' && actor.loginSessionId.startsWith('ws:') ? actor.loginSessionId.slice(3) : '';
    return {
      domains,
      provider,
      requireSso: p.requireSso,
      ssoFreshnessDays: p.ssoFreshnessDays,
      exceptions,
      ownerSignedIn: this.#ownerSignedIn(orgId, provider?.id ?? null),
      thisSession: !!hash && !!db.prepare('SELECT 1 FROM org_sso_sessions WHERE session_hash = ? AND org_id = ?').get(hash, orgId),
      stepUp: provider?.enabled ? `${SSO_API.start}?org=${encodeURIComponent(orgId)}&for=step-up` : null,
    };
  }

  addDomain(actor: Actor, orgId: OrgId, raw: unknown): OrgDomain {
    requireCan(actor, 'manage', orgRef(orgId));
    const domain = normalizeOrgDomain(raw);
    const have = this.#domainRow(orgId, domain);
    if (have) return this.#domainView(have);
    const db = this.#write();
    if ((db.prepare('SELECT count(*) AS n FROM org_domains WHERE org_id = ?').get(orgId) as { n: number }).n >= ORG_SSO_LIMITS.domainsPerOrg)
      throw new AppError('CONFLICT', `An organization has at most ${ORG_SSO_LIMITS.domainsPerOrg} domains.`);
    if (db.prepare("SELECT 1 FROM org_domains WHERE domain = ? AND state = 'verified' AND org_id != ?").get(domain, orgId) || this.#sso.instanceServes(domain)) throw takenError(domain);
    const at = this.#now().toISOString();
    db.prepare("INSERT INTO org_domains (org_id, domain, state, challenge, added_by, added_at) VALUES (?, ?, 'pending', ?, ?, ?)").run(
      orgId,
      domain,
      randomBytes(18).toString('base64url'),
      actorString(actor),
      at,
    );
    this.#record('org.domain_added', actor, orgId, { domain });
    return this.#domainView(this.#domainRow(orgId, domain)!);
  }

  removeDomain(actor: Actor, orgId: OrgId, domain: string): void {
    requireCan(actor, 'manage', orgRef(orgId));
    const row = this.#domainRow(orgId, String(domain).toLowerCase());
    if (!row) throw new AppError('NOT_FOUND', 'No such domain.');
    this.#write().prepare('DELETE FROM org_domains WHERE org_id = ? AND domain = ?').run(orgId, row.domain);
    this.#record('org.domain_removed', actor, orgId, { domain: row.domain, state: row.state }, row.state === 'verified' ? 'medium' : 'info');
  }

  /** "Check now" (rate limited per org). */
  async checkDomain(actor: Actor, orgId: OrgId, domain: string): Promise<OrgDomain> {
    requireCan(actor, 'manage', orgRef(orgId));
    const row = this.#domainRow(orgId, String(domain).toLowerCase());
    if (!row) throw new AppError('NOT_FOUND', 'No such domain.');
    if (this.#checkLimiter.blocked(orgId)) throw new AppError('RATE_LIMITED', 'Too many checks. Try again in an hour.');
    this.#checkLimiter.fail(orgId);
    await this.#check(row, actorString(actor));
    return this.#domainView(this.#domainRow(orgId, row.domain)!);
  }

  /** The TXT values at the challenge name (joined strings), at most 20 of at most 1 KiB; an error or a timeout reads as none. */
  async #txt(domain: string): Promise<string[]> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const records = await Promise.race([
        this.#resolveTxt(`${ORG_DOMAIN_CHALLENGE_PREFIX}${domain}`),
        new Promise<string[][]>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), DNS_TIMEOUT_MS);
        }),
      ]);
      return (Array.isArray(records) ? records : [])
        .slice(0, ORG_SSO_LIMITS.txtRecords)
        .map((chunks) => (Array.isArray(chunks) ? chunks.join('') : ''))
        .filter((v) => v.length <= ORG_SSO_LIMITS.txtBytes);
    } catch {
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #check(row: DomainRow, by: string): Promise<void> {
    const found = (await this.#txt(row.domain)).includes(`${ORG_DOMAIN_TXT_PREFIX}${row.challenge}`);
    const db = this.#write();
    const at = this.#now().toISOString();
    if (found) {
      if (this.#sso.instanceServes(row.domain)) throw takenError(row.domain);
      try {
        db.prepare(
          "UPDATE org_domains SET state = 'verified', verified_at = CASE WHEN state = 'verified' THEN verified_at ELSE ? END, verified_by = CASE WHEN state = 'verified' THEN verified_by ELSE ? END, failures = 0, last_checked_at = ? WHERE org_id = ? AND domain = ?",
        ).run(at, by, at, row.org_id, row.domain);
      } catch (e) {
        if (e instanceof Error && /UNIQUE/i.test(e.message)) {
          db.prepare('UPDATE org_domains SET last_checked_at = ? WHERE org_id = ? AND domain = ?').run(at, row.org_id, row.domain);
          throw takenError(row.domain);
        }
        throw e;
      }
      if (row.state !== 'verified') this.#record('org.domain_verified', by, row.org_id, { domain: row.domain, by: by === 'system:orgs-dns' ? 'daily' : 'check' }, 'medium');
      return;
    }
    const failures = row.failures + 1;
    const lost = row.state === 'verified' && failures >= ORG_SSO_LIMITS.lostAfter;
    db.prepare('UPDATE org_domains SET failures = ?, last_checked_at = ?, state = ? WHERE org_id = ? AND domain = ?').run(failures, at, lost ? 'lost' : row.state, row.org_id, row.domain);
    if (lost) this.#record('org.domain_lost', by, row.org_id, { domain: row.domain, failures }, 'medium');
  }

  /** The daily job: every domain is looked up again (pending, verified and lost), one after the other. */
  async recheckAll(): Promise<void> {
    const rows = this.#read().prepare('SELECT * FROM org_domains ORDER BY org_id, domain').all() as unknown as DomainRow[];
    for (const r of rows) {
      try {
        await this.#check(r, 'system:orgs-dns');
      } catch {
        // taken by another org meanwhile, or the database: the next day tries again
      }
    }
  }

  /* ---------- The provider ---------- */

  putProvider(actor: Actor, orgId: OrgId, req: OrgSsoProviderRequest, redirectUri: string): OrgSsoProvider {
    requireCan(actor, 'manage', orgRef(orgId));
    if (req.enabled === false && this.#policies(orgId).requireSso)
      throw new AppError('CONFLICT', 'Turn off Require SSO first: nobody could reach the organization.', { details: { reason: ORGS_ERROR_CODES.SSO_LOCKOUT_GUARD } });
    const p = this.#sso.putOrgProvider(orgId, req, actorString(actor), redirectUri, (o, raw) => this.checkRules(o, raw));
    const changed = Object.keys(req).filter((k) => k !== 'clientSecret');
    this.#record('org.sso_provider_saved', actor, orgId, { providerId: p.id, changed, secretChanged: req.clientSecret !== undefined, enabled: p.enabled }, 'medium');
    return p;
  }

  removeProvider(actor: Actor, orgId: OrgId): void {
    requireCan(actor, 'manage', orgRef(orgId));
    if (this.#policies(orgId).requireSso)
      throw new AppError('CONFLICT', 'Turn off Require SSO first: nobody could reach the organization.', { details: { reason: ORGS_ERROR_CODES.SSO_LOCKOUT_GUARD } });
    if (!this.#sso.removeOrgProvider(orgId)) throw new AppError('NOT_FOUND', 'No provider yet.');
    const db = this.#write();
    db.prepare('DELETE FROM org_sso_signins WHERE org_id = ?').run(orgId);
    db.prepare('DELETE FROM org_sso_sessions WHERE org_id = ?').run(orgId);
    this.#record('org.sso_provider_removed', actor, orgId, {}, 'medium');
  }

  async testProvider(actor: Actor, orgId: OrgId): Promise<{ ok: true; authorizationEndpoint: string }> {
    requireCan(actor, 'manage', orgRef(orgId));
    if (this.#testLimiter.blocked(orgId)) throw new AppError('RATE_LIMITED', 'Too many tests. Try again in an hour.');
    this.#testLimiter.fail(orgId);
    return this.#sso.testOrg(orgId);
  }

  /* ---------- requireSso, freshness, exceptions (owners) ---------- */

  setPolicy(actor: Actor, orgId: OrgId, req: OrgSsoPolicyRequest, redirectUri: string): OrgSignInSettings {
    requireCan(actor, 'manage', orgRef(orgId));
    const me = actorUserId(actor);
    if (!me || this.#orgs.roleOf(orgId, me) !== 'owner') throw new AppError('FORBIDDEN', 'Only an owner changes how the organization signs in.');
    const p = this.#policies(orgId);
    const next = { ...p.raw };
    const changed: string[] = [];
    if (req.ssoFreshnessDays !== undefined) {
      const d = req.ssoFreshnessDays;
      if (d !== null && !(typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= 365))
        throw new AppError('VALIDATION_FAILED', 'Days from 1 to 365, or off.', { details: { ssoFreshnessDays: '1-365 or null' } });
      next.ssoFreshnessDays = d;
      changed.push('ssoFreshnessDays');
    }
    let turnedOn = false;
    if (req.requireSso !== undefined) {
      if (typeof req.requireSso !== 'boolean') throw new AppError('VALIDATION_FAILED', 'On or off.', { details: { requireSso: 'true or false' } });
      if (req.requireSso && !p.requireSso) {
        const provider = this.#sso.orgProvider(orgId, redirectUri);
        // The lock-out guard (§9.5): an enabled provider, and an owner who has signed in through it.
        if (!provider?.enabled || !this.#ownerSignedIn(orgId, provider.id))
          throw new AppError('CONFLICT', 'An owner signs in through the organization’s provider first (use Connect), so nobody is locked out.', {
            details: { reason: ORGS_ERROR_CODES.SSO_LOCKOUT_GUARD },
          });
        turnedOn = true;
      }
      next.requireSso = req.requireSso;
      changed.push('requireSso');
    }
    const db = this.#write();
    if (req.exceptions !== undefined) {
      const list = Array.isArray(req.exceptions) ? [...new Set(req.exceptions)] : null;
      if (!list || list.length > 1000 || list.some((u) => typeof u !== 'string' || !this.#orgs.roleOf(orgId, u as UserId)))
        throw new AppError('VALIDATION_FAILED', 'Exceptions are members of this organization.', { details: { exceptions: 'Members.' } });
      const at = this.#now().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM org_sso_exceptions WHERE org_id = ?').run(orgId);
        for (const u of list) db.prepare('INSERT INTO org_sso_exceptions (org_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)').run(orgId, u, actorString(actor), at);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      changed.push('exceptions');
    }
    db.prepare('UPDATE orgs SET policies = ? WHERE id = ?').run(JSON.stringify(next), orgId);
    this.#record('org.sso_policy_changed', actor, orgId, { changed, requireSso: next.requireSso === true, ssoFreshnessDays: next.ssoFreshnessDays ?? null }, 'medium');
    if (turnedOn) {
      // An access change, not a sign-out: open sockets of the members it binds re-check (their password sessions lose the org's objects).
      for (const r of db.prepare("SELECT user_id FROM org_members WHERE org_id = ? AND state = 'active'").all(orgId) as { user_id: string }[])
        if (isUserId(r.user_id)) emitAccessChange({ userId: r.user_id, ref: orgRef(orgId), why: 'membership_ended' });
    }
    return this.settings(actor, orgId, redirectUri);
  }
}
