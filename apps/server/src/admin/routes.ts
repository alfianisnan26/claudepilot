// The Admin console's app (docs/prd/organizations.md §6.11, slice 4). app.ts hands it EVERY request whose host is the admin host
// (admin/host.ts), so nothing of the main portal (its /api, /mcp, the reporter, Connect, its pages) is reachable here: this app has its own
// routes, its own UI bundle (apps/web/dist-admin under /admin-ui/), /healthz, and the same 404 for anything else.
//
// - Session: its own (`__Host-pilot_admin`, admin_sessions, idle 15 min, absolute 2 h; ./sessions.ts). Sign-in takes an ACTIVE admin
//   account's email and password (users.verify: throttled, the same refusal for a wrong password, an unknown email or a member). The main
//   portal's cookie is never read here, and a request with any `Authorization` header (a Portal MCP, VS Code or reporter token) is refused.
// - Writes (every method but GET and HEAD) need an `Origin` whose host is the admin host.
// - Every route is declared in ./authz.ts and enforced by `on` below; step-up routes need the password again within 5 minutes.
// - Every write writes a platform audit row (the abilities and the org recovery write theirs in their services).
// - Sign-in through the console's OIDC provider (owner, 2026-11-01; ./oidc.ts): only an identity on the allow list that maps to an active admin
//   account gets the same admin session as the password path, fresh for step-up for 5 minutes; every refusal is an `admin.signin_refused`
//   row and the same neutral page. The step-up dialog can re-authenticate through it too (an SSO-only admin has no password to enter).

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { AppError, codeForStatus, isAppError, success } from '@isnanme/core';
import {
  ADMIN_API,
  ADMIN_COOKIE,
  ADMIN_OIDC_RESULT,
  ADMIN_UI_BASE,
  actorString,
  isAbility,
  workspaceRef,
  type Actor,
  type AdminAuditQuery,
  type AdminMe,
  type AdminPasswordResult,
  type AdminSignInConfig,
  type AdminSignInMethods,
  type AdminUserDetail,
  type AdminUserRow,
  type AdminUserToken,
  type AdminWorkspaceRow,
  type OrgId,
  type UserId,
  type PlatformAuditEntry,
  type PortalUser,
  type RoutePolicy,
  type SsoProvider,
  type SsoProviderRequest,
  type Workspace,
  type WorkspaceTarget,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { requireCan } from '../authz/seam.js';
import { oneTimePassword, type AccountAdmin } from '../identity/accountAdmin.js';
import { revokeAccountTokens } from '../identity/accountGate.js';
import type { OidcClient } from '../identity/oidc.js';
import type { BreakGlassService, OrgsService, UserAbilities } from '../orgs/index.js';
import { requireInstanceAdmin } from '../orgs/index.js';
import { PlatformOrgs } from '../orgs/platformOrgs.js';
import { PlatformAudit, type AuditInput } from '../platform/audit.js';
import type { Portal } from '../portal.js';
import type { Settings } from '../settings/store.js';
import type { Store } from '../store/store.js';
import { contentSecurityPolicy } from '../csp.js';
import { ADMIN_ROUTE_POLICIES, assertDeclared, declareAdminPolicies } from './authz.js';
import type { AdminHostGate } from './host.js';
import { ADMIN_OIDC_COOKIE, ADMIN_OIDC_STATE_TTL_MS, AdminOidc, AdminOidcRefused, type AdminOidcConfig } from './oidc.js';
import { AdminSessions, type AdminSession } from './sessions.js';

type AdminCtx = { session: AdminSession; account: PortalUser };
export type AdminEnv = { Bindings: HttpBindings; Variables: { admin: AdminCtx; actor: Actor } };

export interface AdminUsers {
  verify(email: unknown, password: unknown, address: string): Promise<PortalUser>;
  get(id: string): PortalUser;
  /** The account with this email, or null (OIDC sign-in maps the verified email to it). */
  byEmail(email: string): PortalUser | null;
  /** A sign-in that did not go through `verify`: the last sign-in time. */
  touchLogin(id: string): void;
  list(): PortalUser[];
  update(id: string, req: { state?: 'active' | 'disabled' }): Promise<PortalUser>;
  roleOf(id: string): 'admin' | 'member' | 'disabled' | null;
  principalOf(id: string): string;
}

export interface AdminConsoleDeps {
  store: Store;
  gate: AdminHostGate;
  users: AdminUsers;
  /** Ends an account's main-portal sessions (and cuts their sockets). */
  revokePortalSessions: (accountId: string) => void;
  orgs: OrgsService;
  abilities: UserAbilities;
  /** Slice 5: break-glass (§6.7). Missing: its routes answer 404. */
  breakGlass?: BreakGlassService | null;
  /** The instance's SSO providers (identity/sso.ts). Without `create` and `update` the console only lists them (writes answer 404). */
  sso: {
    list(redirectUri: string): SsoProvider[];
    create?(req: SsoProviderRequest, by: string, redirectUri: string): SsoProvider;
    update?(id: string, req: SsoProviderRequest, redirectUri: string, by?: string): SsoProvider;
  };
  /** The SSO callback URL shown with each provider (PORTAL_SSO_ORIGIN's), or ''. */
  ssoRedirectUri: string;
  /**
   * Owner, 2026-11-01 ("the console controls everything"): the same services the main portal uses, called with the admin as the actor. Each
   * one missing: its routes answer 404 (tests pass what they cover).
   */
  /** Accounts with their side effects (identity/accountAdmin.ts): create, change, remove. */
  accounts?: Pick<AccountAdmin, 'create' | 'update' | 'remove'> | null;
  /** The workspace manager: every workspace and target, start and stop (the seam decides each, as on the main portal). */
  workspaces?: {
    list(): Promise<Workspace[]>;
    targets(fresh?: boolean): Promise<WorkspaceTarget[]>;
    start(target: string, name: string): Promise<unknown>;
    stop(target: string, name: string): Promise<unknown>;
    resolve(ref: string): { id: string } | null;
  } | null;
  /** Sign-in with the server code (portal.ts): its switch, its age and a new code. */
  serverCode?: Pick<Portal, 'summary' | 'setEnabled' | 'rotate' | 'code'> | null;
  /** The portal-wide settings (settings/store.ts). */
  settings?: Pick<Settings, 'view' | 'set'> | null;
  /** The client address (rate limits): the socket, or the trusted proxy's X-Forwarded-For entry. */
  clientKey: (c: Context<AdminEnv>) => string;
  /** The built console (apps/web/dist-admin); missing: the UI paths are 404 and the API still answers. */
  consoleDir?: string | null;
  now?: () => number;
  sessions?: AdminSessions;
  /**
   * Sign-in through one OIDC provider (./oidc.ts `adminOidcConfig`, from PORTAL_ADMIN_OIDC_*); null or missing: off (its routes are 404 and
   * the button is hidden). Tests pass a client that talks to the fake provider.
   */
  oidc?: { config: AdminOidcConfig | null; client?: OidcClient } | null;
}

const WRONG = () => new AppError('UNAUTHORIZED', 'That email or password is not right.');
const SIGN_IN = () => new AppError('UNAUTHORIZED', 'Sign in again.');
const iso = (ms: number) => new Date(ms).toISOString();

async function body(c: Context<AdminEnv>): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await c.req.json();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

/** A path parameter (always present on the routes that read it). */
const param = (c: Context<AdminEnv>, name: string): string => c.req.param(name) ?? '';

const reasonOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : undefined;

export function createAdminApp(d: AdminConsoleDeps): { app: Hono<AdminEnv>; sessions: AdminSessions } {
  declareAdminPolicies();
  const now = d.now ?? Date.now;
  const db = () => d.store.db;
  const writable = () => (d.store.writable ? d.store.db : null);
  const sessions =
    d.sessions ??
    new AdminSessions({
      db,
      writable,
      now,
      isActiveAdmin: (id) => {
        try {
          return d.users.roleOf(id) === 'admin';
        } catch {
          return false;
        }
      },
    });
  const platformAudit = new PlatformAudit(d.store, () => new Date(now()));
  const audit = (e: AuditInput) => platformAudit.record({ ...e, detail: { ...e.detail, via: 'admin-console' } });
  const actorFor = (s: AdminSession): Actor & { kind: 'user' } => {
    let userId = s.userId;
    try {
      userId = d.users.principalOf(s.userId);
    } catch {
      // the account as itself, never the founder
    }
    return { kind: 'user', userId, loginSessionId: s.id, via: 'ui', accountId: s.userId };
  };

  const app = new Hono<AdminEnv>();

  app.onError((e, c) => {
    const error = isAppError(e)
      ? e
      : e instanceof HTTPException
        ? new AppError(codeForStatus(e.status), undefined, { status: e.status, cause: e })
        : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    if (error.status >= 500) console.error(e);
    return c.json(error.toJSON(), error.status as ContentfulStatusCode);
  });
  app.notFound((c) => c.json(new AppError('NOT_FOUND').toJSON(), 404));

  const indexHtml = d.consoleDir ? join(d.consoleDir, 'admin.html') : null;
  const csp = indexHtml ? contentSecurityPolicy(indexHtml) : undefined;
  app.use(
    secureHeaders({
      strictTransportSecurity: false,
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
      ...(csp ? { contentSecurityPolicy: { ...csp, connectSrc: ["'self'"], frameSrc: ["'none'"], frameAncestors: ["'none'"], workerSrc: ["'none'"], manifestSrc: ["'none'"] } } : {}),
    }),
  );

  app.get('/healthz', (c) => c.json({ ok: true, service: 'portal' }));

  // ---------- /admin-api: the doors every request passes ----------
  app.use('/admin-api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use('/admin-api/*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json(new AppError('PAYLOAD_TOO_LARGE', 'That request is too large.').toJSON(), 413) }));
  app.use('/admin-api/*', async (c, next) => {
    // No token of any kind on this host (Portal MCP, VS Code, reporter, agents): only the console's own cookie.
    if (c.req.header('authorization') !== undefined) throw new AppError('UNAUTHORIZED', 'Tokens are not accepted here.');
    if (!/^(GET|HEAD)$/.test(c.req.method)) {
      const origin = c.req.header('origin');
      let host: string | null = null;
      try {
        const o = origin ? new URL(origin) : null;
        host = o && (o.protocol === 'https:' || o.protocol === 'http:') && o.origin === origin ? o.host.toLowerCase() : null;
      } catch {
        host = null;
      }
      const want = d.gate.host;
      const sameHost = !!host && !!want && (want.includes(':') ? host === want : host.replace(/:\d+$/, '') === want);
      if (!sameHost) throw new AppError('FORBIDDEN', 'Forbidden');
    }
    await next();
  });

  /** The live admin session of this request, set on the context; else 401 (the cookie is cleared). */
  const signedIn = (c: Context<AdminEnv>): AdminCtx => {
    const s = sessions.check(getCookie(c, ADMIN_COOKIE));
    if (!s) {
      deleteCookie(c, ADMIN_COOKIE, { path: '/', secure: true });
      throw SIGN_IN();
    }
    let account: PortalUser;
    try {
      account = d.users.get(s.userId);
    } catch {
      sessions.end(s.id, 'account gone');
      throw SIGN_IN();
    }
    const ctx = { session: s, account };
    c.set('admin', ctx);
    c.set('actor', actorFor(s));
    return ctx;
  };

  type Handler = (c: Context<AdminEnv>) => Response | Promise<Response>;
  /** Registers a route with its declaration, enforced: the session, the instance admin, the step-up. */
  const on = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, handler: Handler) => {
    const policy = ADMIN_ROUTE_POLICIES[`${method} ${path}` as keyof typeof ADMIN_ROUTE_POLICIES] as RoutePolicy | undefined;
    if (!policy) throw new Error(`admin route ${method} ${path} is not declared (admin/authz.ts)`);
    app.on(method, path, async (c) => {
      if (policy.kind !== 'public') {
        const { session } = signedIn(c);
        if (policy.kind === 'platform') requireInstanceAdmin(c.get('actor'));
        if (policy.reauth && !sessions.fresh(session)) throw new AppError('REAUTH_REQUIRED', 'Enter your password again.', { status: 403 });
      }
      return handler(c);
    });
  };

  const me = (s: AdminSession, account: PortalUser): AdminMe => {
    const fresh = sessions.freshUntil(s);
    return {
      userId: account.id,
      email: account.email,
      displayName: account.displayName,
      expiresAt: iso(s.expiresAt),
      idleExpiresAt: iso(Math.min(s.expiresAt, s.lastSeenAt + sessions.limits.idleMs)),
      freshUntil: fresh === null ? null : iso(fresh),
    };
  };

  // ---------- Session ----------
  on('POST', '/admin-api/session', async (c) => {
    const b = await body(c);
    let account: PortalUser;
    try {
      account = await d.users.verify(b.email, b.password, d.clientKey(c));
      // A member (or anything but an active admin) gets the same answer as a wrong password: the console does not say who exists.
      if (d.users.roleOf(account.id) !== 'admin') throw WRONG();
    } catch (e) {
      if (isAppError(e) && (e.is('UNAUTHORIZED') || e.is('LOCKED_OUT')))
        audit({ kind: 'admin.signin_failed', severity: 'medium', actor: 'anonymous', userId: null, detail: { code: e.code } });
      throw e;
    }
    const { token, session } = sessions.open(account.id);
    setCookie(c, ADMIN_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: Math.floor(sessions.limits.absoluteMs / 1000) });
    const actor = actorFor(session);
    audit({ kind: 'admin.signin', actor: actorString(actor), userId: actor.userId, subject: `user:${account.id}`, detail: { session: session.id } });
    return c.json(success(me(session, account)));
  });
  on('GET', '/admin-api/session', (c) => {
    const { session, account } = c.get('admin');
    return c.json(success(me(session, account)));
  });
  on('DELETE', '/admin-api/session', (c) => {
    const { session, account } = c.get('admin');
    sessions.end(session.id, 'signed out');
    deleteCookie(c, ADMIN_COOKIE, { path: '/', secure: true });
    const actor = c.get('actor');
    audit({ kind: 'admin.signout', actor: actorString(actor), userId: actorFor(session).userId, subject: `user:${account.id}`, detail: { session: session.id } });
    return c.json(success({ ok: true }));
  });
  on('POST', '/admin-api/session/step-up', async (c) => {
    const { session, account } = c.get('admin');
    const actor = c.get('actor');
    const b = await body(c);
    try {
      await d.users.verify(account.email, b.password, d.clientKey(c));
    } catch (e) {
      if (isAppError(e)) audit({ kind: 'admin.step_up_failed', severity: 'medium', actor: actorString(actor), userId: actorFor(session).userId, subject: `user:${account.id}`, detail: { code: e.code } });
      // A wrong password here is a 403, not a 401: the session itself stays.
      if (isAppError(e) && e.is('UNAUTHORIZED')) throw new AppError('FORBIDDEN', 'That password is not right.');
      throw e;
    }
    const at = sessions.stepUp(session.id);
    audit({ kind: 'admin.step_up', actor: actorString(actor), userId: actorFor(session).userId, subject: `user:${account.id}`, detail: { session: session.id } });
    return c.json(success(me({ ...session, reauthAt: at }, account)));
  });

  // ---------- Sign-in through the console's OIDC provider (owner, 2026-11-01) ----------
  // The redirect URI is the admin host's, never the request's (the provider has exactly this one registered).
  const oidc = d.oidc?.config && d.gate.host ? new AdminOidc(d.oidc.config, `https://${d.gate.host}${ADMIN_API.oidcCallback}`, d.oidc.client, now) : null;
  const needOidc = () => {
    if (!oidc) throw new AppError('NOT_FOUND');
    return oidc;
  };
  const back = (next?: string) => `${ADMIN_UI_BASE}${next ? `#${next}` : ''}`;
  const outcome = (v: string, next?: string) => `${ADMIN_UI_BASE}?${ADMIN_OIDC_RESULT.param}=${v}${next ? `#${next}` : ''}`;
  on('GET', '/admin-api/session/methods', (c) => c.json(success<AdminSignInMethods>({ password: true, oidc: oidc ? { name: oidc.config.name } : null })));
  on('GET', '/admin-api/session/oidc/start', async (c) => {
    const o = needOidc();
    const stepUp = c.req.query('for') === 'step-up';
    // A step-up is bound to the session that asked for it: the return only marks THAT session, and only for the same account.
    const sessionId = stepUp ? signedIn(c).session.id : undefined;
    const next = c.req.query('next');
    let started: { url: string; cookie: string };
    try {
      started = await o.start({ sessionId, next });
    } catch {
      return c.redirect(outcome(ADMIN_OIDC_RESULT.unavailable, next && /^[a-z]{1,20}$/.test(next) ? next : undefined), 302);
    }
    // Lax, not Strict: the provider's redirect back is a top-level navigation that must carry it. Host-only, Secure, HttpOnly, 10 minutes.
    setCookie(c, ADMIN_OIDC_COOKIE, started.cookie, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: Math.floor(ADMIN_OIDC_STATE_TTL_MS / 1000) });
    return c.redirect(started.url, 302);
  });
  on('GET', '/admin-api/session/oidc/callback', async (c) => {
    const o = needOidc();
    const stateCookie = getCookie(c, ADMIN_OIDC_COOKIE);
    deleteCookie(c, ADMIN_OIDC_COOKIE, { path: '/', secure: true });
    const q = c.req.query();
    const refuse = (e: AdminOidcRefused, purpose: 'sign-in' | 'step-up', next?: string) => {
      // Who tried (the provider's subject and the email it gave), never a token or a code: the owner can allow them later.
      audit({
        kind: 'admin.signin_refused',
        severity: 'medium',
        actor: 'anonymous',
        userId: null,
        detail: { method: 'oidc', purpose, reason: e.reason, issuer: o.config.issuer, subject: e.who.subject ?? null, email: e.who.email ?? null },
      });
      return c.redirect(outcome(ADMIN_OIDC_RESULT.refused, next), 302);
    };
    let r: Awaited<ReturnType<AdminOidc['finish']>>;
    try {
      r = await o.finish({ code: q.code, state: q.state, error: q.error }, stateCookie);
    } catch (e) {
      if (e instanceof AdminOidcRefused) return refuse(e, 'sign-in');
      throw e;
    }
    const purpose = r.pending.sid ? 'step-up' : 'sign-in';
    const who = { subject: r.subject, email: r.email };
    let account = d.users.byEmail(r.email);
    if (account && d.users.roleOf(account.id) !== 'admin') account = null; // a member, a disabled account: the same refusal as none
    if (!account) return refuse(new AdminOidcRefused('no_admin_account', who), purpose, r.pending.next);
    if (r.pending.sid) {
      const s = sessions.check(getCookie(c, ADMIN_COOKIE));
      if (!s || s.id !== r.pending.sid || s.userId !== account.id) return refuse(new AdminOidcRefused('session', who), purpose, r.pending.next);
      sessions.stepUp(s.id);
      const actor = actorFor(s);
      audit({ kind: 'admin.step_up', actor: actorString(actor), userId: actor.userId, subject: `user:${account.id}`, detail: { session: s.id, method: 'oidc', issuer: o.config.issuer } });
      return c.redirect(back(r.pending.next), 302);
    }
    const { token, session } = sessions.open(account.id);
    // A sign-in at the provider just now is a fresh authentication: step-up actions work for the next 5 minutes.
    sessions.stepUp(session.id);
    d.users.touchLogin(account.id);
    setCookie(c, ADMIN_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: Math.floor(sessions.limits.absoluteMs / 1000) });
    const actor = actorFor(session);
    audit({
      kind: 'admin.signin',
      actor: actorString(actor),
      userId: actor.userId,
      subject: `user:${account.id}`,
      detail: { session: session.id, method: 'oidc', issuer: o.config.issuer, oidcSubject: r.subject },
    });
    return c.redirect(back(r.pending.next), 302);
  });

  // ---------- Users ----------
  const abilityRows = (actor: Actor) => {
    const by = new Map<string, AdminUserRow['abilities']>();
    for (const r of d.abilities.list(actor)) by.set(r.userId, [...(by.get(r.userId) ?? []), r.ability]);
    return by;
  };
  const row = (u: PortalUser, abilities: AdminUserRow['abilities']): AdminUserRow => ({
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    state: u.state,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    abilities,
  });
  const account = (id: string): PortalUser => {
    try {
      return d.users.get(id);
    } catch {
      throw new AppError('NOT_FOUND', 'No such account.');
    }
  };
  const tableExists = (name: string) => !!db()?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  /** The tokens an account minted: by the account recorded at mint (migration 462), or by the owner the token acts as. */
  const tokensOf = (u: PortalUser): AdminUserToken[] => {
    const r = db();
    if (!r) return [];
    const principal = d.users.principalOf(u.id);
    // The founder account's tokens act as u_owner; so do the server code's. Only tokens recorded as minted by this account count for it.
    const ownerMatch = principal === u.id ? 'OR t.owner_id = ?' : '';
    const pmcp = r
      .prepare(
        `SELECT t.id, t.label, t.created_at, t.expires_at, t.last_used_at, t.revoked_at FROM pmcp_tokens t
         WHERE t.id IN (SELECT token_id FROM token_accounts WHERE kind = 'pmcp' AND account_id = ?) ${ownerMatch} ORDER BY t.created_at DESC LIMIT 200`,
      )
      .all(...(ownerMatch ? [u.id, u.id] : [u.id])) as { id: string; label: string; created_at: string; expires_at: string; last_used_at: string | null; revoked_at: string | null }[];
    const out: AdminUserToken[] = pmcp.map((t) => ({ kind: 'pmcp', id: t.id, label: t.label, createdAt: t.created_at, expiresAt: t.expires_at, lastUsedAt: t.last_used_at, revokedAt: t.revoked_at }));
    if (tableExists('reporter_tokens')) {
      const userMatch = principal === u.id ? 'OR t.actor_user = ?' : '';
      const rep = r
        .prepare(
          `SELECT t.id, t.origin, t.created_at, t.expires_at, t.revoked_at FROM reporter_tokens t
           WHERE t.id IN (SELECT token_id FROM token_accounts WHERE kind = 'reporter' AND account_id = ?) ${userMatch} ORDER BY t.created_at DESC LIMIT 200`,
        )
        .all(...(userMatch ? [u.id, u.id] : [u.id])) as { id: string; origin: string; created_at: string; expires_at: string; revoked_at: string | null }[];
      for (const t of rep) out.push({ kind: 'reporter', id: t.id, label: t.origin, createdAt: t.created_at, expiresAt: t.expires_at, lastUsedAt: null, revokedAt: t.revoked_at });
    }
    return out;
  };
  const portalSessions = (id: string): number =>
    (db()?.prepare('SELECT count(*) AS n FROM web_sessions WHERE user_id = ? AND expires_at > ?').get(id, iso(now())) as { n: number } | undefined)?.n ?? 0;
  const write = () => {
    const w = writable();
    if (!w) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    return w;
  };
  const record = (c: Context<AdminEnv>, kind: string, target: string, detail: Record<string, unknown>, severity: AuditInput['severity'] = 'medium') => {
    const actor = c.get('actor');
    audit({ kind, severity, actor: actorString(actor), userId: target, subject: `user:${target}`, detail });
  };

  on('GET', '/admin-api/users', (c) => {
    const by = abilityRows(c.get('actor'));
    return c.json(success(d.users.list().map((u) => row(u, by.get(u.id) ?? []))));
  });
  on('GET', '/admin-api/users/:id', (c) => {
    const u = account(param(c, 'id'));
    const detail: AdminUserDetail = {
      ...row(u, d.abilities.of(c.get('actor'), u.id).map((a) => a.ability)),
      sessions: { portal: portalSessions(u.id), admin: sessions.liveCount(u.id) },
      tokens: tokensOf(u),
    };
    return c.json(success(detail));
  });
  on('POST', '/admin-api/users/:id/suspend', async (c) => {
    const u = account(param(c, 'id'));
    const reason = reasonOf((await body(c)).reason);
    if (u.id === c.get('admin').account.id) throw new AppError('CONFLICT', 'You cannot suspend your own account.');
    if (u.state === 'disabled') return c.json(success(row(u, [])));
    const next = await d.users.update(u.id, { state: 'disabled' });
    d.revokePortalSessions(u.id);
    const ended = sessions.endAllFor(u.id, 'account suspended');
    const tokens = revokeAccountTokens(write(), u.id, iso(now()), 'account suspended');
    record(c, 'account.suspended', u.id, { email: u.email, adminSessions: ended, ...tokens, ...(reason ? { reason } : {}) });
    return c.json(success(row(next, [])));
  });
  on('POST', '/admin-api/users/:id/resume', async (c) => {
    const u = account(param(c, 'id'));
    const reason = reasonOf((await body(c)).reason);
    if (u.state === 'active') return c.json(success(row(u, [])));
    const next = await d.users.update(u.id, { state: 'active' });
    record(c, 'account.resumed', u.id, { email: u.email, ...(reason ? { reason } : {}) });
    return c.json(success(row(next, [])));
  });
  on('POST', '/admin-api/users/:id/sessions/end', (c) => {
    const u = account(param(c, 'id'));
    const portal = portalSessions(u.id);
    d.revokePortalSessions(u.id);
    // Ending your own: every other admin session ends, this one stays.
    const self = c.get('admin');
    const admin = sessions.endAllFor(u.id, 'ended by an admin', self.account.id === u.id ? self.session.id : undefined);
    record(c, 'account.sessions_ended', u.id, { portal, admin });
    return c.json(success({ portal, admin }));
  });
  on('DELETE', '/admin-api/users/:id/tokens/:tid', (c) => {
    const u = account(param(c, 'id'));
    const tid = param(c, 'tid');
    const t = tokensOf(u).find((x) => x.id === tid);
    if (!t) throw new AppError('NOT_FOUND', 'No such token.');
    const table = t.kind === 'pmcp' ? 'pmcp_tokens' : 'reporter_tokens';
    const changed = Number(write().prepare(`UPDATE ${table} SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL`).run(iso(now()), 'revoked in the Admin console', t.id).changes) > 0;
    if (changed) record(c, 'account.token_revoked', u.id, { kind: t.kind, tokenId: t.id });
    return c.json(success({ revoked: changed }));
  });
  const ability = (c: Context<AdminEnv>) => {
    const a = param(c, 'ability');
    if (!isAbility(a)) throw new AppError('NOT_FOUND', 'No such ability.');
    return a;
  };
  on('PUT', '/admin-api/users/:id/abilities/:ability', (c) => {
    const u = account(param(c, 'id'));
    const r = d.abilities.grant(c.get('actor'), u.id, ability(c), 'Admin console');
    return c.json(success(r));
  });
  on('DELETE', '/admin-api/users/:id/abilities/:ability', (c) => {
    const u = account(param(c, 'id'));
    const r = d.abilities.revoke(c.get('actor'), u.id, ability(c), 'Admin console');
    return c.json(success(r));
  });

  // ---------- Accounts: create, role and name, one-time password, remove (owner, 2026-11-01) ----------
  // The same service as the main portal's /api/admin/users (identity/accountAdmin.ts), so the sessions and tokens end the same way.
  const accounts = () => {
    if (!d.accounts) throw new AppError('NOT_FOUND');
    return d.accounts;
  };
  // The caller is an active admin and may not demote or remove themself, so another active admin always remains.
  // The audit keeps one level of plain values (platform/audit.ts cleanDetail): counts and roles go flat.
  const tokensDetail = (t: { pmcp: number; reporter: number; agent: number } | null) => (t && t.pmcp + t.reporter + t.agent > 0 ? { tokensPmcp: t.pmcp, tokensReporter: t.reporter, agents: t.agent } : {});
  on('POST', '/admin-api/users', async (c) => {
    const b = await body(c);
    const actor = c.get('actor');
    const password = oneTimePassword();
    const u = await accounts().create(
      { email: typeof b.email === 'string' ? b.email : '', displayName: typeof b.displayName === 'string' ? b.displayName : undefined, role: b.role === 'admin' ? 'admin' : 'member', password },
      actorString(actor),
    );
    record(c, 'account.created', u.id, { email: u.email, role: u.role, password: 'one-time' }, u.role === 'admin' ? 'medium' : 'info');
    return c.json(success<AdminPasswordResult>({ user: row(u, []), password }), 201);
  });
  on('PATCH', '/admin-api/users/:id', async (c) => {
    const u = account(param(c, 'id'));
    const b = await body(c);
    const role = b.role === 'admin' || b.role === 'member' ? b.role : undefined;
    const displayName = typeof b.displayName === 'string' && b.displayName.trim() ? b.displayName : undefined;
    if (!role && !displayName) throw new AppError('VALIDATION_FAILED', 'Nothing to change.');
    if (role === 'member' && u.role === 'admin' && u.id === c.get('admin').account.id) throw new AppError('CONFLICT', 'You cannot demote your own account.');
    const { before, after, tokens } = await accounts().update(u.id, { role, displayName });
    // A demoted admin's console sessions end now (the next request would refuse them anyway).
    const adminSessions = before.role === 'admin' && after.role === 'member' ? sessions.endAllFor(u.id, 'account demoted') : 0;
    record(c, 'account.updated', u.id, {
      email: u.email,
      ...(role && role !== before.role ? { roleFrom: before.role, roleTo: after.role } : {}),
      ...(displayName ? { name: true } : {}),
      ...(adminSessions ? { adminSessions } : {}),
      ...tokensDetail(tokens),
    });
    return c.json(success(row(after, d.abilities.of(c.get('actor'), u.id).map((a) => a.ability))));
  });
  on('POST', '/admin-api/users/:id/password', async (c) => {
    const u = account(param(c, 'id'));
    const reason = reasonOf((await body(c)).reason);
    if (u.id === c.get('admin').account.id) throw new AppError('CONFLICT', 'Change your own password in the portal.');
    const password = oneTimePassword();
    const { after } = await accounts().update(u.id, { password });
    const adminSessions = sessions.endAllFor(u.id, 'password reset');
    record(c, 'account.password_reset', u.id, { email: u.email, adminSessions, ...(reason ? { reason } : {}) });
    return c.json(success<AdminPasswordResult>({ user: row(after, []), password }));
  });
  on('DELETE', '/admin-api/users/:id', (c) => {
    const u = account(param(c, 'id'));
    if (u.id === c.get('admin').account.id) throw new AppError('CONFLICT', 'You cannot remove your own account.');
    // The founder account is the founding user's data (principalOf): removing it would orphan everything they own.
    if (d.users.principalOf(u.id) !== u.id) throw new AppError('CONFLICT', 'The founder’s account cannot be removed.');
    const adminSessions = sessions.endAllFor(u.id, 'account removed');
    const { tokens } = accounts().remove(u.id);
    record(c, 'account.removed', u.id, { email: u.email, role: u.role, adminSessions, ...tokensDetail(tokens) });
    return c.json(success({ removed: true }));
  });

  // ---------- Organizations ----------
  on('GET', '/admin-api/orgs', (c) => c.json(success(d.orgs.listAll(c.get('actor')))));
  on('POST', '/admin-api/orgs/:id/recover-owner', async (c) => {
    const b = await body(c);
    const userId = typeof b.userId === 'string' ? b.userId : '';
    d.orgs.recoverOwner(c.get('actor'), param(c, 'id') as OrgId, userId as UserId, typeof b.reason === 'string' ? b.reason : '');
    return c.json(success({ recovered: true }));
  });
  // Slice 8 (§6.9): suspend and resume (step-up, declared). An org the console suspended is resumed only here, never by its owners.
  on('POST', '/admin-api/orgs/:id/suspend', async (c) => {
    const b = await body(c);
    d.orgs.suspend(c.get('actor'), param(c, 'id') as OrgId, { by: 'platform', reason: b.reason });
    return c.json(success({ suspended: true }));
  });
  on('POST', '/admin-api/orgs/:id/resume', (c) => {
    d.orgs.resume(c.get('actor'), param(c, 'id') as OrgId, { by: 'platform' });
    return c.json(success({ resumed: true }));
  });
  // Owner, 2026-11-01: create (with the owner the admin picks), the detail view, delete (orgs/platformOrgs.ts; their audit rows are written there).
  const platformOrgs = new PlatformOrgs({ db, writable, orgs: d.orgs, audit, now: () => new Date(now()) });
  on('POST', '/admin-api/orgs', async (c) => {
    const b = await body(c);
    return c.json(success(platformOrgs.create(c.get('actor'), { name: b.name, slug: b.slug, ownerId: b.ownerId })), 201);
  });
  on('GET', '/admin-api/orgs/:id', (c) => c.json(success(platformOrgs.detail(c.get('actor'), param(c, 'id') as OrgId))));
  on('DELETE', '/admin-api/orgs/:id', async (c) => {
    // A DELETE may come without a body: the reason is optional.
    const reason = c.req.header('content-type')?.includes('json') ? (await body(c)).reason : undefined;
    platformOrgs.delete(c.get('actor'), param(c, 'id') as OrgId, reason);
    return c.json(success({ deleted: true }));
  });

  // ---------- Break-glass (slice 5, §6.7) ----------
  const breakGlass = () => {
    if (!d.breakGlass) throw new AppError('NOT_FOUND');
    return d.breakGlass;
  };
  on('POST', '/admin-api/orgs/:id/break-glass', async (c) => {
    const b = await body(c);
    return c.json(success(breakGlass().start(c.get('actor'), param(c, 'id') as OrgId, b.reason)), 201);
  });
  on('DELETE', '/admin-api/orgs/:id/break-glass', (c) => c.json(success(breakGlass().endByAdmin(c.get('actor'), param(c, 'id') as OrgId))));
  on('GET', '/admin-api/break-glass', (c) => c.json(success(breakGlass().listAll(c.get('actor')))));

  // ---------- SSO providers: the instance's (identity/sso.ts), as the main portal's Access page changes them ----------
  on('GET', '/admin-api/sso', (c) => c.json(success(d.sso.list(d.ssoRedirectUri))));
  const ssoBody = async (c: Context<AdminEnv>) => (await body(c)) as SsoProviderRequest;
  on('POST', '/admin-api/sso', async (c) => {
    if (!d.sso.create) throw new AppError('NOT_FOUND');
    const p = d.sso.create(await ssoBody(c), c.get('admin').account.email, d.ssoRedirectUri);
    audit({ kind: 'sso.provider_created', severity: 'medium', actor: actorString(c.get('actor')), userId: null, subject: null, detail: { providerId: p.id, name: p.name, issuer: p.issuer, domains: p.domains, defaultRole: p.defaultRole } });
    return c.json(success(p), 201);
  });
  on('PATCH', '/admin-api/sso/:id', async (c) => {
    if (!d.sso.update) throw new AppError('NOT_FOUND');
    const req = await ssoBody(c);
    const p = d.sso.update(param(c, 'id'), req, d.ssoRedirectUri, c.get('admin').account.email);
    // The fields that changed, never the secret's value (only that it changed).
    const changed = Object.keys(req).filter((k) => k !== 'clientSecret');
    audit({ kind: 'sso.provider_changed', severity: 'medium', actor: actorString(c.get('actor')), userId: null, subject: null, detail: { providerId: p.id, changed, secretChanged: req.clientSecret !== undefined, domains: p.domains, enabled: p.enabled } });
    return c.json(success(p));
  });

  // ---------- Workspaces and targets: names, owners, status, image; start and stop as the main portal does ----------
  const workspaces = () => {
    if (!d.workspaces) throw new AppError('NOT_FOUND');
    return d.workspaces;
  };
  /** Who owns each workspace (workspace_owners, by `<target>/<name>`), with a name to show: the account's email, the org's or team's name. */
  const ownersOf = (): Map<string, AdminWorkspaceRow['owner']> => {
    const r = db();
    const out = new Map<string, AdminWorkspaceRow['owner']>();
    if (!r || !tableExists('workspace_owners')) return out;
    const rows = r
      .prepare(
        `SELECT w.workspace_id, w.owner_kind, w.owner_id,
           CASE w.owner_kind
             WHEN 'user' THEN (SELECT email FROM users u WHERE u.id = w.owner_id OR (w.owner_id = 'u_owner' AND u.founder = 1) LIMIT 1)
             WHEN 'org' THEN (SELECT name FROM orgs o WHERE o.id = w.owner_id)
             WHEN 'team' THEN (SELECT name FROM teams t WHERE t.id = w.owner_id)
           END AS name
         FROM workspace_owners w`,
      )
      .all() as { workspace_id: string; owner_kind: AdminWorkspaceRow['owner']['kind']; owner_id: string; name: string | null }[];
    for (const o of rows) out.set(o.workspace_id, { kind: o.owner_kind, id: o.owner_kind === 'platform' ? null : o.owner_id, name: o.name ?? null });
    return out;
  };
  on('GET', '/admin-api/workspaces', async (c) => {
    const list = await workspaces().list();
    const owners = ownersOf();
    return c.json(
      success<AdminWorkspaceRow[]>(
        list.map((w) => ({
          id: w.id,
          stableId: w.stableId ?? null,
          label: w.label ?? w.name,
          target: w.target,
          image: w.image,
          status: w.status,
          detail: w.detail ?? null,
          createdAt: w.createdAt,
          owner: owners.get(w.id) ?? { kind: 'none', id: null, name: null },
        })),
      ),
    );
  });
  on('GET', '/admin-api/targets', async (c) => c.json(success<WorkspaceTarget[]>(await workspaces().targets(c.req.query('fresh') === '1'))));
  const runtimeAction = (verb: 'start' | 'stop') => async (c: Context<AdminEnv>) => {
    const ws = workspaces();
    const target = param(c, 'target');
    const name = param(c, 'name');
    const id = `${target}/${name}`;
    // The main portal's check (workspaces/authz.ts workspaceGuard): `operate` on the workspace for this actor. The console adds no right: an
    // instance admin holds none on another person's workspace (D12), and an org's needs a role there or an open break-glass entry.
    requireCan(c.get('actor'), 'operate', workspaceRef(id));
    await (verb === 'start' ? ws.start(target, name) : ws.stop(target, name));
    const actor = c.get('actor');
    audit({ kind: `workspace.${verb}`, severity: 'info', actor: actorString(actor), userId: actor.kind === 'user' ? actor.userId : null, subject: ws.resolve(id)?.id ?? id, detail: { workspace: id } });
    return c.json(success({ ok: true }));
  };
  on('POST', '/admin-api/workspaces/:target/:name/start', runtimeAction('start'));
  on('POST', '/admin-api/workspaces/:target/:name/stop', runtimeAction('stop'));

  // ---------- Sign-in: the server code's switch and a new code; the console's own OIDC allow list (env, read only) ----------
  const signInConfig = (): AdminSignInConfig => ({
    serverCode: d.serverCode ? d.serverCode.summary() : null,
    adminOidc: oidc ? { issuer: oidc.config.issuer, name: oidc.config.name, allow: [...oidc.config.allow] } : null,
    adminHost: d.gate.host,
  });
  const serverCode = () => {
    if (!d.serverCode) throw new AppError('NOT_FOUND');
    return d.serverCode;
  };
  on('GET', '/admin-api/signin', (c) => c.json(success(signInConfig())));
  on('PUT', '/admin-api/signin/server-code', async (c) => {
    const p = serverCode();
    const { enabled } = await body(c);
    if (typeof enabled !== 'boolean') throw new AppError('VALIDATION_FAILED', '`enabled` must be true or false.');
    const was = p.summary().enabled;
    p.setEnabled(enabled);
    if (was !== enabled) audit({ kind: 'portal.server_code_switched', severity: 'medium', actor: actorString(c.get('actor')), userId: null, subject: null, detail: { enabled } });
    return c.json(success(signInConfig()));
  });
  on('POST', '/admin-api/signin/server-code/rotate', (c) => {
    const p = serverCode();
    // No main-portal session is this request's to keep: every one ends, as a rotation on the main portal ends every other.
    const before = p.summary().sessions;
    p.rotate('');
    audit({ kind: 'portal.server_code_rotated', severity: 'medium', actor: actorString(c.get('actor')), userId: null, subject: null, detail: { sessionsEnded: before } });
    return c.json(success({ code: p.code, config: signInConfig() }));
  });

  // ---------- Settings: the portal-wide settings store, the same as the main portal's Settings page ----------
  const settings = () => {
    if (!d.settings) throw new AppError('NOT_FOUND');
    return d.settings;
  };
  on('GET', '/admin-api/settings', (c) => c.json(success(settings().view())));
  on('PUT', '/admin-api/settings/:key', async (c) => {
    const s = settings();
    const key = param(c, 'key');
    const b = await body(c);
    const old = s.view().settings.find((x) => x.key === key)?.value;
    // The store checks the value, asks for `confirm` when a protection is switched off (409), and keeps its own trail of the change.
    const v = s.set(key, b.value, { actor: actorString(c.get('actor')), confirm: b.confirm === true });
    if (old !== v.value) audit({ kind: 'setting.changed', severity: v.protective !== undefined ? 'medium' : 'info', actor: actorString(c.get('actor')), userId: null, subject: null, detail: { key, from: old ?? null, to: v.value } });
    return c.json(success(v));
  });

  // ---------- The audit ----------
  on('GET', '/admin-api/audit', (c) => {
    const q = c.req.query() as Record<keyof AdminAuditQuery, string | undefined>;
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.kind && /^[a-z][a-z0-9_.]{0,120}$/.test(q.kind)) {
      where.push('(kind = ? OR kind LIKE ? ESCAPE \'\\\')');
      args.push(q.kind, `${q.kind.replace(/[\\%_]/g, (x) => `\\${x}`)}.%`);
    }
    if (q.severity === 'info' || q.severity === 'medium' || q.severity === 'high') {
      where.push('severity = ?');
      args.push(q.severity);
    }
    if (q.subject && q.subject.length <= 200) {
      where.push('subject = ?');
      args.push(q.subject);
    }
    // Owner, 2026-11-01: by who acted (exactly, or a prefix ending in ':' such as `system:`), by org, and by date.
    if (q.actor && q.actor.length <= 200) {
      if (q.actor.endsWith(':')) {
        where.push("actor LIKE ? ESCAPE '\\'");
        args.push(`${q.actor.replace(/[\\%_]/g, (x) => `\\${x}`)}%`);
      } else {
        where.push('actor = ?');
        args.push(q.actor);
      }
    }
    if (q.org && /^org_[A-Za-z0-9_-]{1,60}$/.test(q.org)) {
      where.push('org_id = ?');
      args.push(q.org);
    }
    const day = (v: string | undefined, end: boolean): string | null => {
      if (!v || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(v) || !Number.isFinite(Date.parse(v))) return null;
      // A bare date as `to` counts that whole day: before the next one.
      return end && v.length === 10 ? new Date(Date.parse(`${v}T00:00:00Z`) + 86_400_000).toISOString() : new Date(Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v)).toISOString();
    };
    const from = day(q.from, false);
    const to = day(q.to, true);
    if (from) {
      where.push('at >= ?');
      args.push(from);
    }
    if (to) {
      where.push('at < ?');
      args.push(to);
    }
    const before = Number(q.before);
    if (Number.isInteger(before) && before > 0) {
      where.push('id < ?');
      args.push(before);
    }
    const limit = Math.max(1, Math.min(500, Math.floor(Number(q.limit) || 100)));
    const rows = (db()
      ?.prepare(`SELECT id, at, severity, kind, actor, user_id, subject, detail FROM platform_audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`)
      .all(...args) ?? []) as { id: number; at: string; severity: PlatformAuditEntry['severity']; kind: string; actor: string; user_id: string | null; subject: string | null; detail: string }[];
    return c.json(
      success<PlatformAuditEntry[]>(
        rows.map((r) => ({ id: r.id, at: r.at, severity: r.severity, kind: r.kind, actor: r.actor, userId: r.user_id, subject: r.subject, detail: JSON.parse(r.detail) as Record<string, unknown> })),
      ),
    );
  });

  // The console refuses to start with a route its table does not declare (and the test fails on it).
  assertDeclared(app.routes, ADMIN_ROUTE_POLICIES);

  // ---------- The UI bundle (apps/web/dist-admin, built by apps/web/vite.admin.config.ts), on this host only ----------
  if (d.consoleDir && indexHtml && existsSync(indexHtml)) {
    const root = relative(process.cwd(), d.consoleDir) || '.';
    const base = ADMIN_UI_BASE.replace(/\/$/, '');
    app.get('/', (c) => c.redirect(ADMIN_UI_BASE, 302));
    app.use(`${base}/assets/*`, async (c, next) => {
      await next();
      if (c.res.status === 200) c.header('Cache-Control', 'public, max-age=31536000, immutable');
    });
    app.get(`${base}/assets/*`, serveStatic({ root, rewriteRequestPath: (p) => p.slice(base.length) }));
    const shell = (c: Context<AdminEnv>) => {
      c.header('Cache-Control', 'no-store');
      return c.html(readFileSync(indexHtml, 'utf8'));
    };
    app.get(base, shell);
    // Client-side views carry no file extension; a missing file is a 404, never the shell.
    app.get(`${base}/*`, (c) => {
      if (/\.[a-z0-9]{1,8}$/i.test(c.req.path)) throw new AppError('NOT_FOUND');
      return shell(c);
    });
  }

  return { app, sessions };
}
