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

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { AppError, codeForStatus, isAppError, success } from '@isnanme/core';
import {
  ADMIN_COOKIE,
  ADMIN_UI_BASE,
  actorString,
  isAbility,
  type Actor,
  type AdminAuditQuery,
  type AdminMe,
  type AdminUserDetail,
  type AdminUserRow,
  type AdminUserToken,
  type OrgId,
  type UserId,
  type PlatformAuditEntry,
  type PortalUser,
  type RoutePolicy,
  type SsoProvider,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { revokeAccountTokens } from '../identity/accountGate.js';
import type { OrgsService, UserAbilities } from '../orgs/index.js';
import { requireInstanceAdmin } from '../orgs/index.js';
import { PlatformAudit, type AuditInput } from '../platform/audit.js';
import type { Store } from '../store/store.js';
import { contentSecurityPolicy } from '../csp.js';
import { ADMIN_ROUTE_POLICIES, assertDeclared, declareAdminPolicies } from './authz.js';
import type { AdminHostGate } from './host.js';
import { AdminSessions, type AdminSession } from './sessions.js';

type AdminCtx = { session: AdminSession; account: PortalUser };
export type AdminEnv = { Bindings: HttpBindings; Variables: { admin: AdminCtx; actor: Actor } };

export interface AdminUsers {
  verify(email: unknown, password: unknown, address: string): Promise<PortalUser>;
  get(id: string): PortalUser;
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
  sso: { list(redirectUri: string): SsoProvider[] };
  /** The SSO callback URL shown with each provider (PORTAL_SSO_ORIGIN's), or ''. */
  ssoRedirectUri: string;
  /** The client address (rate limits): the socket, or the trusted proxy's X-Forwarded-For entry. */
  clientKey: (c: Context<AdminEnv>) => string;
  /** The built console (apps/web/dist-admin); missing: the UI paths are 404 and the API still answers. */
  consoleDir?: string | null;
  now?: () => number;
  sessions?: AdminSessions;
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
  const on = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, handler: Handler) => {
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

  // ---------- Organizations ----------
  on('GET', '/admin-api/orgs', (c) => c.json(success(d.orgs.listAll(c.get('actor')))));
  on('POST', '/admin-api/orgs/:id/recover-owner', async (c) => {
    const b = await body(c);
    const userId = typeof b.userId === 'string' ? b.userId : '';
    d.orgs.recoverOwner(c.get('actor'), param(c, 'id') as OrgId, userId as UserId, typeof b.reason === 'string' ? b.reason : '');
    return c.json(success({ recovered: true }));
  });

  // ---------- SSO (read only) and the audit ----------
  on('GET', '/admin-api/sso', (c) => c.json(success(d.sso.list(d.ssoRedirectUri))));
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
