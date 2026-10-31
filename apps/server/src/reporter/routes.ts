// The UI reporter's routes (docs/prd/ui-reporter-server.md), mounted by app.ts:
//
//   createReporterOwnerRoutes     /api/reporter/{buckets/:key/config, deployments}   the owner (cookie) and, for POST deployments, a Portal
//                                                                                    MCP token (pipelines and agents after a deploy)
//   createReporterEvidenceRoutes  /api/tickets/:id/reporter-evidence                 the owner's ticket page (cookie)
//   createReporterWidgetRoutes    /reporter/v1/*                                      the SDK script, axe, the embed page, the status, the
//                                                                                    connect popup, and the panel API (bearer cprt_)
//
// The panel API answers same-origin only and sets NO CORS header: only the panel (a page of this portal in an iframe) calls it. A token that
// is unknown, expired, revoked, of another bucket or origin, or whose origin or bucket is no longer allowed is the same 404 as a missing
// object; a call with no token at all is 401 (the panel then shows Connect).

import { AppError, success } from '@isnanme/core';
import {
  REPORTER_BRIDGE_VERSION,
  REPORTER_LIMITS,
  ticketBucketRef,
  type Actor,
  type ReporterConfig,
  type ReporterConnectMessage,
  type ReporterDeployment,
  type ReporterTicketQuery,
  type TicketReporterEvidence,
  type UpdateReporterConfigRequest,
} from '@portal/contracts';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { stream } from 'hono/streaming';
import { actorOf, actorString, requireCan } from '../authz/seam.js';
import { RateLimiter } from '../rateLimit.js';
import { declareReporterPolicies } from './authz.js';
import { BLANK_PAGE, REFUSED_CSP, connectCsp, connectPage, embedCsp, embedHtml, scriptNonce, vendorFile } from './pages.js';
import type { ReporterService, ReporterTokenCtx } from './service.js';
import { normalizeOrigin } from './validate.js';

type Vars = { Variables: { reporter: ReporterTokenCtx } };

async function jsonBody<T>(c: Context): Promise<Partial<T>> {
  const v: unknown = await c.req.json().catch(() => null);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  return v as Partial<T>;
}

const tooLarge = (max: number) =>
  bodyLimit({
    maxSize: max,
    onError: (c) => {
      const e = new AppError('PAYLOAD_TOO_LARGE', 'That request is too large.');
      return c.json(e.toJSON(), e.status as 413);
    },
  });

/* ---------- The owner's routes ---------- */

export interface ReporterOwnerDeps {
  /** The session guard of every /api route (app.ts requireSession). */
  guard: MiddlewareHandler;
  /** A Portal MCP token (cpat_) as the seam's actor, with its label, or null when it is not a live operate/admin token. */
  portalToken: (secret: string) => { actor: Actor; label: string } | null;
  audit?: (kind: string, detail: Record<string, unknown>, actor: string) => void;
}

export function createReporterOwnerRoutes(service: ReporterService, deps: ReporterOwnerDeps): Hono {
  declareReporterPolicies();
  const r = new Hono();

  r.get('/buckets/:key/config', deps.guard, (c) => {
    const key = c.req.param('key').toUpperCase();
    requireCan(actorOf(c), 'view', ticketBucketRef(key));
    return c.json(success<ReporterConfig>(service.config(key)));
  });

  r.put('/buckets/:key/config', deps.guard, async (c) => {
    const actor = actorOf(c);
    const key = c.req.param('key').toUpperCase();
    requireCan(actor, 'manage', ticketBucketRef(key));
    const body = await jsonBody<UpdateReporterConfigRequest>(c);
    const cfg = service.updateConfig(key, body, actorString(actor));
    deps.audit?.('reporter.config_updated', { bucket: key, enabled: cfg.enabled, sites: cfg.sites.map((s) => s.origin), sessionTargets: cfg.sessionTargets.length }, actorString(actor));
    return c.json(success<ReporterConfig>(cfg));
  });

  r.get('/deployments', deps.guard, (c) => {
    const key = (c.req.query('bucket') ?? '').toUpperCase();
    requireCan(actorOf(c), 'view', ticketBucketRef(key));
    if (!/^[A-Z]{2,6}$/.test(key)) throw new AppError('NOT_FOUND', 'Not found.');
    return c.json(success<ReporterDeployment[]>(service.deployments(key, c.req.query('repo') || undefined)));
  });

  // A pipeline or an agent after a deploy: `Authorization: Bearer cpat_…` (operate) on a bucket whose site serves that repo and environment.
  // No cookie here: the token is the door (the /api Origin rule still refuses a browser's cross-site POST).
  const posts = new RateLimiter(120, 60 * 60_000);
  r.post('/deployments', async (c) => {
    const secret = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
    const who = secret ? deps.portalToken(secret) : null;
    if (!who) throw new AppError('UNAUTHORIZED', 'A Portal MCP token with the operate scope.');
    const key = who.actor.kind === 'token' ? who.actor.tokenId : 'token';
    if (posts.blocked(key)) throw new AppError('RATE_LIMITED', 'Too many deployments recorded. Wait a while.');
    posts.fail(key);
    const body = await jsonBody<{ bucket: string; repo: string; environment: string; commit: string; branch: string; label: string }>(c);
    const repo = typeof body.repo === 'string' ? body.repo.trim() : '';
    const env = typeof body.environment === 'string' ? body.environment.trim().toLowerCase() : '';
    const only = typeof body.bucket === 'string' && body.bucket ? body.bucket.trim().toUpperCase() : null;
    // Recorded for each bucket the token may operate on whose site serves this repo and environment (or the one `bucket` names): a token
    // of one bucket never writes what another bucket reads. None: the same not found.
    const buckets = service.bucketsServing(repo, env).filter((b) => {
      if (only && b !== only) return false;
      try {
        requireCan(who.actor, 'operate', ticketBucketRef(b));
        return true;
      } catch {
        return false;
      }
    });
    if (!buckets.length) throw new AppError('NOT_FOUND', 'No bucket you can operate on has a site for that repo and environment.');
    const via = typeof body.label === 'string' && body.label ? body.label : who.label;
    const recorded = buckets.map((b) => service.recordDeployment({ bucketKey: b, repo, environment: env, commit: String(body.commit ?? ''), branch: typeof body.branch === 'string' ? body.branch : null, source: 'pipeline', via }));
    const d = recorded[0]!;
    deps.audit?.('reporter.deployment_recorded', { repo: d.repo, environment: d.environment, commit: d.commit, buckets }, actorString(who.actor));
    return c.json(success<ReporterDeployment>(d), 201);
  });

  return r;
}

export function createReporterEvidenceRoutes(service: ReporterService, deps: { guard: MiddlewareHandler; visibleTicket: (actor: Actor, ref: string) => string | null }): Hono {
  declareReporterPolicies();
  const r = new Hono();
  r.get('/:id/reporter-evidence', deps.guard, (c) => {
    const id = deps.visibleTicket(actorOf(c), c.req.param('id'));
    if (!id) throw new AppError('NOT_FOUND', 'Not found.');
    // A ticket that did not come from the widget has no evidence: null, not an error (the ticket page asks for every ticket).
    return c.json(success<TicketReporterEvidence | null>(service.evidence(id)));
  });
  return r;
}

/* ---------- The widget's routes ---------- */

export interface ReporterWidgetDeps {
  /** The web app's build (dist), where the panel's embed.html is; null in development or when the web app is not served. */
  webDist: string | null;
  vendorDirs: string[];
  /** The portal's own origin as the person reaches it (the connect page and absolute links). */
  portalOrigin: (c: Context) => string;
  /** The signed-in person (the portal cookie), or null. */
  signedIn: (c: Context) => (Actor & { userId: string }) | null;
  userLabel?: (userId: string) => string;
  clientKey: (c: Context) => string;
  audit?: (kind: string, detail: Record<string, unknown>, actor: string) => void;
}

const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const notFound = () => new AppError('NOT_FOUND', 'Not found.');

/** Same-origin only: a browser names the origin on a non-GET request, and `sec-fetch-site` on every one; a foreign page is refused. */
function sameOrigin(c: Context, portalOrigin: string): boolean {
  const site = c.req.header('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = c.req.header('origin');
  return origin === undefined || origin === portalOrigin || sameHost(origin, c.req.header('host'));
}

const sameHost = (origin: string, host: string | undefined) => {
  try {
    const o = new URL(origin);
    return (o.protocol === 'http:' || o.protocol === 'https:') && host !== undefined && o.host === host;
  } catch {
    return false;
  }
};

export function createReporterWidgetRoutes(service: ReporterService, deps: ReporterWidgetDeps): Hono<Vars> {
  declareReporterPolicies();
  const r = new Hono<Vars>();
  const perToken = new RateLimiter(900, 10 * 60_000);
  const connects = new RateLimiter(20, 10 * 60_000);
  const statusHits = new RateLimiter(300, 10 * 60_000);
  const streams = new Map<string, number>();

  /* ----- Public files ----- */

  const file = (name: 'reporter.js' | 'axe.min.js') => (c: Context) => {
    const f = vendorFile(name, deps.vendorDirs);
    if (!f) throw notFound();
    if (c.req.header('if-none-match') === f.etag) return c.body(null, 304, { ETag: f.etag, 'Cache-Control': 'public, max-age=300' });
    return c.body(new Uint8Array(f.bytes), 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      ETag: f.etag,
      'X-Content-Type-Options': 'nosniff',
      // A public page loads it with <script src>: it must not be refused as a cross-origin resource.
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
  };
  r.get('/reporter.js', file('reporter.js'));
  r.get('/axe.js', file('axe.min.js'));

  // Chrome's Private Network Access: a public page fetching from a private address first asks with a preflight; only the public files and
  // the embed page answer it. The panel API never does (no CORS at all).
  r.options('*', (c) => {
    const path = c.req.path.replace(/^.*\/reporter\/v1/, '');
    const pna = c.req.header('access-control-request-private-network') === 'true';
    const origin = normalizeOrigin(c.req.header('origin') ?? '');
    if (!pna || !origin || !['/reporter.js', '/axe.js', '/embed'].includes(path)) return c.body(null, 404);
    if (path === '/embed' && !service.siteOf(origin)) return c.body(null, 404);
    return c.body(null, 204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
  });

  /* ----- The embed page and the status ----- */

  r.get('/embed', (c) => {
    const origin = normalizeOrigin(c.req.query('origin') ?? '');
    const site = origin ? service.allowedSite(c.req.query('bucket') ?? '', origin) : null;
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    if (!site || !origin) {
      c.header('Content-Security-Policy', REFUSED_CSP);
      c.header('X-Frame-Options', 'DENY');
      return c.html(BLANK_PAGE, 200);
    }
    const html = embedHtml(deps.webDist);
    c.header('Content-Security-Policy', embedCsp(html, origin));
    return c.html(html, 200);
  });

  r.get('/status', (c) => {
    const ip = deps.clientKey(c);
    if (statusHits.blocked(ip)) throw new AppError('RATE_LIMITED', 'Too many requests.');
    statusHits.fail(ip);
    if (!sameOrigin(c, deps.portalOrigin(c))) throw notFound();
    const origin = normalizeOrigin(c.req.query('origin') ?? '') ?? '';
    c.header('Cache-Control', 'no-store');
    return c.json(success({ ...service.status(c.req.query('bucket') ?? '', origin), bridge: REPORTER_BRIDGE_VERSION }));
  });

  /* ----- The connect popup ----- */

  r.get('/connect', (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const nonce = c.req.query('nonce') ?? '';
    const origin = normalizeOrigin(c.req.query('origin') ?? '') ?? '';
    const bucket = (c.req.query('bucket') ?? '').toUpperCase();
    const script = scriptNonce();
    c.header('Content-Security-Policy', connectCsp(script));
    c.header('X-Frame-Options', 'DENY');
    const who = deps.signedIn(c);
    const here = deps.portalOrigin(c);
    // Sign in, then back to THIS connect page (the login page follows `next` only for a /reporter/v1/connect path: features/auth/next.ts).
    const back = `/reporter/v1/connect?${new URLSearchParams({ bucket, origin, nonce: NONCE.test(nonce) ? nonce : '' }).toString()}`;
    const base = { bucketKey: bucket, bucketName: '', origin, environment: '', repo: '', person: '', nonce, signInUrl: `${here}/login?next=${encodeURIComponent(back)}` };
    if (!who) return c.html(connectPage({ ...base, state: 'sign-in' }, script));
    const site = origin && NONCE.test(nonce) ? service.allowedSite(bucket, origin) : null;
    if (!site) return c.html(connectPage({ ...base, state: 'refused' }, script));
    const st = service.status(bucket, origin);
    return c.html(connectPage({ ...base, state: 'approve', bucketName: st.bucketName, environment: site.environment, repo: site.repo, person: deps.userLabel?.(who.userId) ?? 'You' }, script));
  });

  r.post('/connect', tooLarge(4 * 1024), async (c) => {
    // The usual CSRF: same origin (Origin and Sec-Fetch-Site), JSON only (a cross-site form cannot send it without a preflight), the cookie.
    const here = deps.portalOrigin(c);
    const origin = c.req.header('origin');
    if (!origin || !(origin === here || sameHost(origin, c.req.header('host'))) || c.req.header('sec-fetch-site') === 'cross-site') throw new AppError('FORBIDDEN', 'Forbidden');
    if (!/^application\/json/i.test(c.req.header('content-type') ?? '')) throw new AppError('FORBIDDEN', 'Forbidden');
    const who = deps.signedIn(c);
    if (!who) throw new AppError('UNAUTHORIZED', 'Sign in again.');
    if (connects.blocked(who.userId)) throw new AppError('RATE_LIMITED', 'Too many connects. Wait a few minutes.');
    connects.fail(who.userId);
    const body = await jsonBody<{ bucket: string; origin: string; nonce: string }>(c);
    const site = normalizeOrigin(body.origin ?? '');
    if (typeof body.nonce !== 'string' || !NONCE.test(body.nonce) || !site || typeof body.bucket !== 'string') throw notFound();
    const label = deps.userLabel?.(who.userId) ?? 'Owner';
    const t = service.mint(body.bucket, site, who, label);
    deps.audit?.('reporter.connected', { bucket: t.bucketKey, origin: site, tokenId: t.id }, actorString(who));
    return c.json(success<ReporterConnectMessage>({ type: 'pilot-reporter:connected', nonce: body.nonce, token: t.token, expiresAt: t.expiresAt, bucketKey: t.bucketKey, actorLabel: t.actorLabel }));
  });

  /* ----- The panel API (bearer) ----- */

  const api = new Hono<Vars>();
  const guarded = ['/me', '/tickets', '/tickets/*', '/reviews', '/reviews/*', '/duplicates', '/events', '/session-targets', '/observed-build', '/sessions', '/knowledge', '/knowledge/*'];
  for (const p of guarded) api.use(p, async (c, next) => {
    // '/tickets' and '/tickets/*' may both match one path: the token is checked (and counted) once.
    if (c.get('reporter')) return next();
    c.header('Cache-Control', 'no-store');
    if (!sameOrigin(c, deps.portalOrigin(c))) throw notFound();
    const secret = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    if (!secret) throw new AppError('UNAUTHORIZED', 'Connect the reporter first.');
    const expectOrigin = c.req.header('x-reporter-origin');
    const ctx = service.verify(secret, { bucket: c.req.header('x-reporter-bucket') ?? null, origin: expectOrigin ? (normalizeOrigin(expectOrigin) ?? '\u0000') : null });
    if (!ctx) throw notFound();
    if (perToken.blocked(ctx.id)) throw new AppError('RATE_LIMITED', 'Too many requests. Wait a minute.');
    perToken.fail(ctx.id);
    c.set('reporter', ctx);
    await next();
  });
  const ctxOf = (c: Context<Vars>) => c.get('reporter');
  const base = (c: Context) => deps.portalOrigin(c);
  const json = tooLarge(512 * 1024);
  const raw = tooLarge(REPORTER_LIMITS.screenshotBytes + 64 * 1024);

  api.get('/me', (c) => {
    const x = ctxOf(c);
    return c.json(success({ bucketKey: x.bucketKey, origin: x.origin, site: x.site, actorLabel: x.actorLabel, expiresAt: x.expiresAt, status: service.status(x.bucketKey, x.origin) }));
  });
  // Sign out: the panel's own token revokes itself.
  api.delete('/me', (c) => {
    const x = ctxOf(c);
    service.revoke(x.id, 'signed out from the panel');
    return c.json(success({ ok: true }));
  });

  const query = (c: Context): ReporterTicketQuery => {
    const many = (k: string) => (c.req.queries(k) ?? []).flatMap((v) => v.split(',')).filter(Boolean) as never[];
    const q = c.req.query();
    return {
      status: (q.status as ReporterTicketQuery['status']) || undefined,
      type: many('type'),
      priority: many('priority'),
      tags: many('tags'),
      q: q.q || undefined,
      path: q.path || undefined,
      mine: q.mine === 'true' || q.mine === '1',
      sort: (q.sort as ReporterTicketQuery['sort']) || undefined,
      order: q.order === 'asc' ? 'asc' : q.order === 'desc' ? 'desc' : undefined,
      cursor: q.cursor || undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    };
  };

  api.get('/tickets', (c) => {
    const x = ctxOf(c);
    // `as=callouts` with a path: what the panel sends the SDK, the viewer's pending draft comments included.
    if (c.req.query('as') === 'callouts') {
      const path = c.req.query('path') ?? '/';
      return c.json(success({ path, callouts: [...service.callouts(x, path, base(c)), ...service.pendingCallouts(x, path, base(c))] }));
    }
    return c.json(success(service.listTickets(x, query(c), base(c))));
  });
  api.post('/tickets', json, async (c) => c.json(success(service.createTicket(ctxOf(c), await jsonBody(c), base(c))), 201));
  api.get('/tickets/:key', (c) => c.json(success(service.ticket(ctxOf(c), c.req.param('key'), base(c)))));
  api.post('/tickets/:key/captures', json, async (c) => c.json(success(service.addCaptures(ctxOf(c), c.req.param('key'), await jsonBody(c), base(c)))));
  api.post('/tickets/:key/attachments', raw, async (c) => {
    const bytes = Buffer.from(await c.req.arrayBuffer());
    const out = service.attach(ctxOf(c), c.req.param('key'), c.req.header('x-reporter-capture') ?? '', c.req.header('x-reporter-kind') ?? '', bytes, c.req.header('content-type'));
    return c.json(success(out), 201);
  });
  const image = (c: Context, f: { bytes: Buffer; type: string }) =>
    c.body(new Uint8Array(f.bytes), 200, { 'Content-Type': f.type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=300' });
  api.get('/tickets/:key/captures/:captureId/screenshot', (c) => image(c, service.screenshot(ctxOf(c), c.req.param('key'), c.req.param('captureId'))));
  api.get('/tickets/:key/comments', (c) => c.json(success(service.comments(ctxOf(c), c.req.param('key')))));
  api.post('/tickets/:key/comments', json, async (c) => c.json(success(service.reply(ctxOf(c), c.req.param('key'), (await jsonBody<{ body: string }>(c)).body)), 201));

  api.get('/reviews', (c) => c.json(success(service.reviews(ctxOf(c), c.req.query('status'), base(c)))));
  api.post('/reviews', json, async (c) => c.json(success(service.startReview(ctxOf(c), await jsonBody(c), base(c))), 201));
  api.get('/reviews/:id', (c) => c.json(success(service.review(ctxOf(c), c.req.param('id'), base(c)))));
  api.patch('/reviews/:id', json, async (c) => c.json(success(service.renameReview(ctxOf(c), c.req.param('id'), (await jsonBody<{ title: string }>(c)).title, base(c)))));
  api.delete('/reviews/:id', (c) => {
    service.discardReview(ctxOf(c), c.req.param('id'));
    return c.json(success({ ok: true }));
  });
  api.post('/reviews/:id/comments', json, async (c) => c.json(success(service.addComment(ctxOf(c), c.req.param('id'), await jsonBody(c), base(c))), 201));
  api.patch('/reviews/:id/comments/:captureId', json, async (c) => c.json(success(service.updateComment(ctxOf(c), c.req.param('id'), c.req.param('captureId'), await jsonBody(c), base(c)))));
  api.delete('/reviews/:id/comments/:captureId', (c) => c.json(success(service.deleteComment(ctxOf(c), c.req.param('id'), c.req.param('captureId'), base(c)))));
  api.post('/reviews/:id/attachments', raw, async (c) => {
    const bytes = Buffer.from(await c.req.arrayBuffer());
    return c.json(success(service.attachToReview(ctxOf(c), c.req.param('id'), c.req.header('x-reporter-capture') ?? '', c.req.header('x-reporter-kind') ?? '', bytes, c.req.header('content-type'))), 201);
  });
  api.get('/reviews/:id/comments/:captureId/screenshot', (c) => image(c, service.reviewScreenshot(ctxOf(c), c.req.param('id'), c.req.param('captureId'))));
  api.post('/reviews/:id/submit', json, async (c) => c.json(success(service.submitReview(ctxOf(c), c.req.param('id'), await jsonBody(c), base(c))), 201));

  api.post('/duplicates', json, async (c) => c.json(success({ candidates: service.duplicates(ctxOf(c), await jsonBody(c), base(c)) })));
  api.get('/session-targets', (c) => c.json(success(service.sessionTargets(ctxOf(c)))));
  api.post('/observed-build', json, async (c) => c.json(success(await service.observedBuild(ctxOf(c), await jsonBody(c)))));
  api.get('/sessions', (c) => c.json(success(service.sessions(ctxOf(c), base(c)))));
  api.get('/knowledge', (c) => c.json(success(service.knowledge(ctxOf(c), c.req.query('q') ?? '', base(c)))));
  api.get('/knowledge/note', (c) => c.json(success(service.note(ctxOf(c), c.req.query('path') ?? ''))));

  // Changes to this bucket's tickets and deployments as NDJSON lines ({"type":"changed"}), checked every 2 s, a ping every 25 s, closed
  // after 10 minutes (the panel reconnects; it polls every 30 s when this fails). At most 3 open per token.
  api.get('/events', (c) => {
    const x = ctxOf(c);
    const open = streams.get(x.id) ?? 0;
    if (open >= 3) throw new AppError('RATE_LIMITED', 'Too many open event streams.');
    streams.set(x.id, open + 1);
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('X-Accel-Buffering', 'no');
    return stream(c, async (s) => {
      let mark = service.changeMark(x.bucketKey);
      const started = Date.now();
      let lastPing = Date.now();
      let alive = true;
      s.onAbort(() => {
        alive = false;
      });
      try {
        await s.write(`${JSON.stringify({ type: 'hello', at: new Date().toISOString() })}\n`);
        while (alive && Date.now() - started < 10 * 60_000) {
          await s.sleep(2_000);
          // The token may have been revoked, its site removed or the bucket turned off meanwhile.
          if (!service.verifyId(x.id)) break;
          const now = service.changeMark(x.bucketKey);
          if (now !== mark) {
            mark = now;
            await s.write(`${JSON.stringify({ type: 'changed', at: new Date().toISOString() })}\n`);
          } else if (Date.now() - lastPing > 25_000) {
            lastPing = Date.now();
            await s.write(`${JSON.stringify({ type: 'ping' })}\n`);
          }
        }
      } finally {
        const n = (streams.get(x.id) ?? 1) - 1;
        if (n > 0) streams.set(x.id, n);
        else streams.delete(x.id);
      }
    });
  });

  r.route('/', api);
  return r;
}
