// The routes of teams, session shares and SSO (owner, 2026-10-17: "elevate access management dan sharing biar bisa lebih granular dan
// controllable ... team based multiaccount ... external SSO"). Mounted by app.ts in two places: `mountPublic` on the app (sign-in by SSO
// needs no session; an account's own team pages need an account session) and `mountAdmin` on the admin router (a FULL session only).
// Every write is audited with who did it.

import type { HttpBindings } from '@hono/node-server';
import { AppError, success } from '@isnanme/core';
import {
  levelOfCaps,
  normalizeEmail,
  PORTAL_TEAM_API,
  SESSION_GRANT_API,
  SESSION_SHARE_PRESETS,
  SSO_API,
  type AddPortalTeamMemberRequest,
  type CreatePortalTeamRequest,
  type PortalTeamDetail,
  type PortalTeamRole,
  type SessionShareOverview,
  type SessionShareRequest,
  type SessionGrantRequest,
  type ShareSubjectRef,
  type SignInMethod,
  type SsoProviderRequest,
  type UpdatePortalTeamRequest,
} from '@portal/contracts';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Portal } from '../portal.js';
import { RateLimiter } from '../rateLimit.js';
import type { SessionGrants } from './grants.js';
import { SsoError, type SsoProviders } from './sso.js';
import type { PortalTeams } from './teams.js';
import type { PortalUsers } from './users.js';

type Env = { Bindings: HttpBindings; Variables: { token: string } };

export interface IdentityRouteDeps {
  portal: Portal;
  users: PortalUsers;
  teams: PortalTeams;
  grants: SessionGrants;
  sso: SsoProviders;
  /** The chat sessions: id resolution (aliases), title and mode. */
  sessions: { resolve(id: string): string; get(id: string): { id: string; title: string; workspaceId: string; mode: string } | null };
  audit: (kind: string, subject: string | null, detail: Record<string, unknown>, severity?: 'info' | 'medium', by?: string | null) => void;
  /** The session token of a request: app.ts, by the read rule of sessionCookie.ts (`__Host-portal_session` wins; T-976). */
  sessionToken: (c: Context<Env>) => string | undefined;
  /** Sets the session cookie after a sign-in: app.ts (`__Host-` and Secure over https, the old name on plain http; T-976). */
  setSessionCookie: (c: Context<Env>, token: string) => void;
  trustProxy: boolean;
  /** PORTAL_SSO_ORIGIN when set (https://pilot.example.com): the origin the provider sends the browser back to. */
  publicUrl: string | null;
  clientKey: (c: Context<Env>) => string;
  body: <T>(c: Context<Env>) => Promise<Partial<T>>;
}

export const SSO_COOKIE = 'portal_sso';

export function identityRoutes(d: IdentityRouteDeps) {
  const { portal, users, teams, grants, sso, sessions, audit } = d;

  /** The callback URL the provider must have registered. */
  const redirectUri = (c: Context<Env>) => {
    if (d.publicUrl) return `${d.publicUrl.replace(/\/+$/, '')}${SSO_API.callback}`;
    const host = c.req.header('host') ?? 'localhost';
    const forwarded = d.trustProxy ? c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() : undefined;
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    const proto = forwarded === 'http' || forwarded === 'https' ? forwarded : local ? 'http' : 'https';
    return `${proto}://${host}${SSO_API.callback}`;
  };

  const subjectName = (s: ShareSubjectRef) => {
    if (s.kind === 'team') return teams.nameOf(s.id);
    try {
      return users.get(s.id).email;
    } catch {
      return 'a removed account';
    }
  };
  const overview = (list: ReturnType<SessionGrants['all']>): SessionShareOverview[] =>
    list.map((g) => {
      const x = sessions.get(g.sessionId);
      return { ...g, sessionTitle: x?.title ?? null, workspaceId: x?.workspaceId ?? null };
    });

  /** The signed-in account (any role), or a refusal. */
  const account = (c: Context<Env>) => {
    const token = d.sessionToken(c);
    const s = portal.anySession(token);
    if (!s) throw new AppError('UNAUTHORIZED', 'Sign in again.');
    return { userId: s.userId ?? null, full: !!portal.session(token) };
  };
  /** Who did it, for the row and the audit: `account:<id>`, or `ui` for the server code. */
  const actorOfAdmin = (c: Context<Env>) => {
    const by = portal.session(c.get('token'))?.userId ?? null;
    return { by, label: by ? `account:${by}` : 'ui' };
  };

  // Shares: the subject must be an active account or an existing team.
  const checkSubject = (raw: unknown): ShareSubjectRef => {
    const s = raw as Partial<ShareSubjectRef> | undefined;
    if (s?.kind === 'user' && typeof s.id === 'string') {
      const role = users.roleOf(s.id);
      if (role === 'admin' || role === 'member') return { kind: 'user', id: s.id };
      throw new AppError('VALIDATION_FAILED', 'Pick an active account.', { details: { subject: 'An active account.' } });
    }
    if (s?.kind === 'team' && typeof s.id === 'string' && teams.exists(s.id)) return { kind: 'team', id: s.id };
    throw new AppError('VALIDATION_FAILED', 'Pick an account or a team.', { details: { subject: 'An account or a team.' } });
  };
  const bypassCheck = (sessionId: string, caps: string[], ack: unknown) => {
    const bypass = sessions.get(sessionId)?.mode === 'bypassPermissions';
    const acts = caps.some((x) => x === 'send' || x === 'respond');
    if (bypass && acts && ack !== true)
      throw new AppError('VALIDATION_FAILED', 'This session is in Bypass: confirm that they may make it run any command.', {
        details: { acknowledgeBypass: 'Required to send or answer in Bypass.' },
      });
    return bypass;
  };

  function mountAdmin(admin: Hono<Env>) {
    // ---------- Session shares (granular) ----------
    admin.get('/session-grants/:sid', (c) => c.json(success(grants.forSession(sessions.resolve(c.req.param('sid')), subjectName))));
    admin.put('/session-grants/:sid', async (c) => {
      const sid = sessions.resolve(c.req.param('sid'));
      if (!sessions.get(sid)) throw new AppError('NOT_FOUND', 'No such session.');
      const raw = await d.body<SessionShareRequest & SessionGrantRequest>(c);
      // The old body ({ userId, level }) still works.
      const legacy = raw.subject === undefined && typeof raw.userId === 'string';
      if (legacy && raw.level !== 'view' && raw.level !== 'operate')
        throw new AppError('VALIDATION_FAILED', 'View or operate.', { details: { level: 'view or operate' } });
      const subject = checkSubject(legacy ? { kind: 'user', id: raw.userId } : raw.subject);
      const caps = legacy ? SESSION_SHARE_PRESETS[raw.level as 'view' | 'operate'] : raw.caps;
      const g0 = grants.validate({ caps, expiresAt: raw.expiresAt, note: raw.note }); // nothing is written before every check passed
      const bypass = bypassCheck(sid, g0.caps, raw.acknowledgeBypass);
      const { by, label } = actorOfAdmin(c);
      const g = grants.share(
        sid,
        subject,
        { caps: g0.caps, expiresAt: g0.expiresAt, note: g0.note, bypassAck: raw.acknowledgeBypass === true },
        label,
        subjectName,
      );
      const acts = g.caps.some((x) => x !== 'read');
      audit(
        'session.shared',
        subject.kind === 'user' ? subject.id : null,
        { sessionId: sid, subject, caps: g.caps, expiresAt: g.expiresAt, bypass },
        bypass && acts ? 'medium' : 'info',
        by,
      );
      return c.json(success(g));
    });
    admin.delete('/session-grants/:sid/:uid', (c) => {
      const sid = sessions.resolve(c.req.param('sid'));
      const removed = grants.revoke(sid, c.req.param('uid'));
      if (removed) audit('session.share_revoked', c.req.param('uid'), { sessionId: sid }, 'info', actorOfAdmin(c).by);
      return c.json(success({ removed }));
    });
    admin.get('/session-shares', (c) => c.json(success(overview(grants.all(subjectName)))));
    admin.patch('/session-shares/:id', async (c) => {
      const before = grants.byId(c.req.param('id'));
      if (!before) throw new AppError('NOT_FOUND', 'No such share.');
      const raw = await d.body<Omit<SessionShareRequest, 'subject'>>(c);
      const caps = grants.validate({
        caps: raw.caps ?? before.caps.split(','),
        expiresAt: raw.expiresAt !== undefined ? raw.expiresAt : before.expires_at,
      }).caps;
      bypassCheck(before.session_id, caps, raw.acknowledgeBypass ?? before.bypass_ack === 1);
      const { by, label } = actorOfAdmin(c);
      const g = grants.update(
        before.id,
        { caps, expiresAt: raw.expiresAt, note: raw.note, bypassAck: raw.acknowledgeBypass ?? before.bypass_ack === 1 },
        label,
        subjectName,
      );
      audit(
        'session.share_changed',
        before.subject_kind === 'user' ? before.subject_id : null,
        { sessionId: before.session_id, caps: g.caps, expiresAt: g.expiresAt },
        'info',
        by,
      );
      return c.json(success(g));
    });
    admin.delete('/session-shares/:id', (c) => {
      const r = grants.revokeId(c.req.param('id'));
      if (r)
        audit(
          'session.share_revoked',
          r.subject_kind === 'user' ? r.subject_id : null,
          { sessionId: r.session_id, subject: { kind: r.subject_kind, id: r.subject_id } },
          'info',
          actorOfAdmin(c).by,
        );
      return c.json(success({ removed: !!r }));
    });

    // ---------- Teams ----------
    admin.get('/teams', (c) => c.json(success(teams.list(actorOfAdmin(c).by ?? undefined))));
    admin.post('/teams', async (c) => {
      const req = await d.body<CreatePortalTeamRequest>(c);
      const { by, label } = actorOfAdmin(c);
      const owners = Array.isArray(req.owners) ? req.owners.filter((x): x is string => typeof x === 'string') : by ? [by] : [];
      for (const o of owners) {
        const role = users.roleOf(o);
        if (role !== 'admin' && role !== 'member')
          throw new AppError('VALIDATION_FAILED', 'An owner is an active account.', { details: { owners: 'Active accounts.' } });
      }
      const t = teams.create(req, owners, label);
      audit('team.created', null, { teamId: t.id, name: t.name, owners }, 'info', by);
      return c.json(success(t), 201);
    });
    admin.get('/teams/:id', (c) => c.json(success(detail(c.req.param('id'), actorOfAdmin(c).by, true))));
    admin.patch('/teams/:id', async (c) => {
      const t = teams.update(c.req.param('id'), await d.body<UpdatePortalTeamRequest>(c));
      audit('team.changed', null, { teamId: t.id, name: t.name }, 'info', actorOfAdmin(c).by);
      return c.json(success(t));
    });
    admin.delete('/teams/:id', (c) => {
      const id = c.req.param('id');
      const t = teams.get(id);
      grants.removeTeam(id);
      teams.remove(id);
      audit('team.removed', null, { teamId: id, name: t.name }, 'medium', actorOfAdmin(c).by);
      return c.json(success({ removed: true }));
    });

    // ---------- SSO providers ----------
    admin.get('/sso', (c) => c.json(success(sso.list(redirectUri(c)))));
    admin.post('/sso', async (c) => {
      const { by, label } = actorOfAdmin(c);
      const p = sso.create(await d.body<SsoProviderRequest>(c), label, redirectUri(c));
      audit(
        'sso.provider_created',
        null,
        { providerId: p.id, name: p.name, issuer: p.issuer, domains: p.domains, defaultRole: p.defaultRole },
        'medium',
        by,
      );
      return c.json(success(p), 201);
    });
    admin.patch('/sso/:id', async (c) => {
      const req = await d.body<SsoProviderRequest>(c);
      const p = sso.update(c.req.param('id'), req, redirectUri(c));
      // The fields that changed, never the secret's value (only that it changed).
      const changed = Object.keys(req).filter((k) => k !== 'clientSecret');
      audit(
        'sso.provider_changed',
        null,
        { providerId: p.id, changed, secretChanged: req.clientSecret !== undefined, domains: p.domains, enabled: p.enabled },
        'medium',
        actorOfAdmin(c).by,
      );
      return c.json(success(p));
    });
    admin.delete('/sso/:id', (c) => {
      const id = c.req.param('id');
      sso.remove(id);
      audit('sso.provider_removed', null, { providerId: id }, 'medium', actorOfAdmin(c).by);
      return c.json(success({ removed: true }));
    });
    admin.post('/sso/:id/test', async (c) => c.json(success(await sso.test(c.req.param('id')))));
  }

  const detail = (id: string, me: string | null, full: boolean): PortalTeamDetail => {
    const t = teams.get(id, me ?? undefined);
    const owner = full || t.myRole === 'owner';
    return { ...t, people: teams.members(id), shares: owner ? overview(grants.forTeam(id, subjectName)) : [] };
  };

  /** An admin (full session) or an owner of this team. */
  const teamManager = (c: Context<Env>, teamId: string) => {
    const a = account(c);
    if (a.full) return a;
    if (!a.userId) throw new AppError('NOT_FOUND', 'Not found.');
    const role = teams.roleIn(teamId, a.userId);
    // Not a member: the same not-found as a team that does not exist.
    if (!role) throw new AppError('NOT_FOUND', 'Not found.');
    if (role !== 'owner') throw new AppError('FORBIDDEN', 'Only the team’s owners manage its people.');
    return a;
  };

  // Per address (behind the ingress with PORTAL_TRUST_PROXY, the client's). Generous: a page reload is one discover and one start.
  const discoverLimiter = new RateLimiter(60, 60_000);
  const callbackLimiter = new RateLimiter(30, 60_000);
  const memberLimiter = new RateLimiter(60, 60 * 60_000);

  function mountPublic(app: Hono<Env>) {
    // ---------- SSO sign-in (no session) ----------
    app.post(SSO_API.discover, async (c) => {
      const key = d.clientKey(c);
      if (discoverLimiter.blocked(key)) throw new AppError('RATE_LIMITED', 'Too many tries. Wait a minute.');
      discoverLimiter.fail(key);
      if (!portal.enabled) throw new AppError('FORBIDDEN', 'Sign-in is turned off on this server.');
      const { email } = await d.body<{ email: string }>(c);
      // Only the DOMAIN decides: an email that has no account answers the same as one that has (nothing about accounts is told).
      const hit = typeof email === 'string' ? sso.forEmail(email) : null;
      const out: SignInMethod = hit
        ? {
            method: 'sso',
            provider: hit.id,
            name: hit.name,
            start: `${SSO_API.start}?provider=${encodeURIComponent(hit.id)}&email=${encodeURIComponent(normalizeEmail(email!))}`,
          }
        : { method: 'password' };
      return c.json(success(out));
    });
    app.get(SSO_API.start, async (c) => {
      if (!portal.enabled) return c.redirect('/login?sso_error=unavailable', 302);
      const key = d.clientKey(c);
      if (discoverLimiter.blocked(key)) return c.redirect('/login?sso_error=unavailable', 302);
      discoverLimiter.fail(key);
      const email = c.req.query('email') ?? null;
      // The email's domain names the provider; `provider` is used only for an email on no provider's domain, and even then the callback
      // signs in only an email on THAT provider's domains (sso.ts), so naming another provider gains nothing.
      const byDomain = email ? sso.forEmail(email) : null;
      const providerId = byDomain?.id ?? c.req.query('provider') ?? '';
      try {
        const { url, binding } = await sso.begin(providerId, email, redirectUri(c));
        setCookie(c, SSO_COOKIE, binding, {
          httpOnly: true,
          sameSite: 'Lax',
          path: SSO_API.callback,
          maxAge: 600,
          secure: redirectUri(c).startsWith('https:'),
        });
        return c.redirect(url, 302);
      } catch (e) {
        console.log(`[portal] SSO start failed: ${e instanceof Error ? e.message : String(e)}`);
        return c.redirect('/login?sso_error=unavailable', 302);
      }
    });
    app.get(SSO_API.callback, async (c) => {
      const binding = getCookie(c, SSO_COOKIE);
      deleteCookie(c, SSO_COOKIE, { path: SSO_API.callback });
      if (!portal.enabled) return c.redirect('/login?sso_error=unavailable', 302);
      // Review: unauthenticated, so bounded per address; a callback with no cookie of a started sign-in is refused without an audit row.
      const key = d.clientKey(c);
      if (callbackLimiter.blocked(key)) return c.redirect('/login?sso_error=unavailable', 302);
      callbackLimiter.fail(key);
      if (!binding) return c.redirect('/login?sso_error=state', 302);
      try {
        const r = await sso.finish({ code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error') }, binding);
        const token = portal.openSession(r.user.id);
        d.setSessionCookie(c, token);
        audit('portal.signin', null, {
          method: 'sso',
          providerId: r.providerId,
          userId: r.user.id,
          role: r.user.role,
          created: r.created,
          linked: r.linked,
        });
        if (r.created) audit('account.created', r.user.id, { email: r.user.email, role: r.user.role, via: `sso:${r.providerId}` }, 'info');
        console.log(`[portal] signed in with SSO (${r.user.id}, ${r.user.role}${r.created ? ', new' : ''})`);
        return c.redirect('/', 302);
      } catch (e) {
        const code = e instanceof SsoError ? e.code : 'unavailable';
        audit(
          'portal.signin_failed',
          null,
          { method: 'sso', code, reason: e instanceof Error ? e.message.slice(0, 200) : 'error' },
          'medium',
        );
        return c.redirect(`/login?sso_error=${code}`, 302);
      }
    });

    // ---------- Teams, the account's side ----------
    app.get(PORTAL_TEAM_API.mine, (c) => {
      const a = account(c);
      return c.json(success(a.userId ? teams.mine(a.userId) : []));
    });
    app.get('/api/teams/:id', (c) => {
      const a = account(c);
      const id = c.req.param('id');
      if (!a.full) {
        if (!a.userId || !teams.roleIn(id, a.userId)) throw new AppError('NOT_FOUND', 'Not found.');
      }
      return c.json(success(detail(id, a.userId, a.full)));
    });
    app.post('/api/teams/:id/members', async (c) => {
      const id = c.req.param('id');
      const a = teamManager(c, id);
      // Review: adding by email tells whether an active account exists; bounded per manager.
      const lk = a.userId ?? 'server-code';
      if (memberLimiter.blocked(lk)) throw new AppError('RATE_LIMITED', 'Too many changes. Wait a while.');
      memberLimiter.fail(lk);
      const req = await d.body<AddPortalTeamMemberRequest>(c);
      const target =
        typeof req.userId === 'string' ? safeUser(req.userId) : typeof req.email === 'string' ? users.byEmail(req.email) : null;
      if (!target || target.state !== 'active')
        throw new AppError('VALIDATION_FAILED', 'No active account with that email.', { details: { email: 'An existing account.' } });
      const role: PortalTeamRole = req.role === 'owner' ? 'owner' : 'member';
      teams.setMember(id, target.id, role, a.userId ? `account:${a.userId}` : 'ui');
      audit('team.member_set', target.id, { teamId: id, role }, 'info', a.userId);
      return c.json(success(detail(id, a.userId, a.full)));
    });
    app.patch('/api/teams/:id/members/:uid', async (c) => {
      const id = c.req.param('id');
      const a = teamManager(c, id);
      const uid = c.req.param('uid');
      if (!teams.roleIn(id, uid)) throw new AppError('NOT_FOUND', 'Not in this team.');
      const { role } = await d.body<{ role: PortalTeamRole }>(c);
      if (role !== 'owner' && role !== 'member')
        throw new AppError('VALIDATION_FAILED', 'Owner or member.', { details: { role: 'owner or member' } });
      teams.setMember(id, uid, role, a.userId ? `account:${a.userId}` : 'ui');
      audit('team.member_set', uid, { teamId: id, role }, 'info', a.userId);
      return c.json(success(detail(id, a.userId, a.full)));
    });
    app.delete('/api/teams/:id/members/:uid', (c) => {
      const id = c.req.param('id');
      const uid = c.req.param('uid');
      const a = account(c);
      // A member may leave by themselves; removing someone else is a manager's.
      if (!(a.userId === uid && !a.full && teams.roleIn(id, uid))) teamManager(c, id);
      const removed = teams.removeMember(id, uid);
      if (removed) audit('team.member_removed', uid, { teamId: id, self: a.userId === uid }, 'info', a.userId);
      return c.json(success({ removed }));
    });
  }

  const safeUser = (id: string) => {
    try {
      return users.get(id);
    } catch {
      return null;
    }
  };

  return { mountAdmin, mountPublic, redirectUri, levelOfCaps, SESSION_GRANT_API };
}
