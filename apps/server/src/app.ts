import { relative } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { AppError, codeForStatus, isAppError, success } from '@isnanme/core';
import {
  API,
  type AdminState,
  type CreateWorkspaceRequest,
  type LoginRequest,
  type RotateCodeRequest,
  type SessionStatus,
  type SetEnabledRequest,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { config } from './config.js';
import type { Portal } from './portal.js';
import { RateLimiter } from './rateLimit.js';
import type { Workspaces } from './workspaces/manager.js';

type Env = { Bindings: HttpBindings; Variables: { token: string } };

const clientKey = (c: Context<Env>) => c.env.incoming?.socket.remoteAddress ?? 'unknown';

async function body<T>(c: Context<Env>): Promise<Partial<T>> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === 'object' ? (value as Partial<T>) : {};
  } catch {
    throw new AppError('BAD_REQUEST', 'Expected a JSON body.');
  }
}

export function createApp(portal: Portal, workspaces: Workspaces, { serveWeb }: { serveWeb: boolean }) {
  const app = new Hono<Env>();
  const limiter = new RateLimiter(config.loginLimit.attempts, config.loginLimit.windowMs);
  const { cookie, ttlMs } = config.session;

  // Served over plain HTTP: no HSTS.
  app.use(secureHeaders({ strictTransportSecurity: false }));
  app.use('/api/*', csrf());

  app.onError((e, c) => {
    const error = isAppError(e)
      ? e
      : e instanceof HTTPException // Hono's own middleware (csrf): keep its status
        ? new AppError(codeForStatus(e.status), undefined, { status: e.status, cause: e })
        : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    if (error.status >= 500) console.error(e);
    return c.json(error.toJSON(), error.status as ContentfulStatusCode);
  });

  app.get('/healthz', (c) => c.json({ ok: true, service: 'portal' }));

  app.get(API.session, (c) => {
    const status: SessionStatus = {
      authenticated: !!portal.session(getCookie(c, cookie)),
      enabled: portal.enabled,
    };
    return c.json(success(status));
  });

  app.post(API.login, async (c) => {
    const key = clientKey(c);
    if (limiter.blocked(key)) throw new AppError('RATE_LIMITED', 'Too many tries. Wait a few minutes.');
    const { code } = await body<LoginRequest>(c);
    let token: string;
    try {
      token = portal.signIn(typeof code === 'string' ? code : '');
    } catch (e) {
      if (isAppError(e) && e.is('UNAUTHORIZED')) limiter.fail(key);
      throw e;
    }
    limiter.reset(key);
    setCookie(c, cookie, token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
      maxAge: Math.floor(ttlMs / 1000),
    });
    return c.json(success(portal.adminState(token)));
  });

  app.post(API.logout, (c) => {
    const token = getCookie(c, cookie);
    if (token) portal.signOut(token);
    deleteCookie(c, cookie, { path: '/' });
    return c.json(success({ ok: true }));
  });

  const requireSession = createMiddleware<Env>(async (c, next) => {
    const token = getCookie(c, cookie);
    if (!token || !portal.session(token)) throw new AppError('UNAUTHORIZED', 'Sign in again.');
    c.set('token', token);
    await next();
  });

  const admin = new Hono<Env>();
  admin.use(requireSession);
  const state = (c: Context<Env>) => c.json(success<AdminState>(portal.adminState(c.get('token'))));

  admin.get('/state', state);
  admin.post('/code', async (c) => {
    const { code } = await body<RotateCodeRequest>(c);
    if (code !== undefined && typeof code !== 'string') throw new AppError('VALIDATION_FAILED', 'Code must be text.');
    portal.rotate(c.get('token'), code);
    console.log(`[portal] server code rotated (${portal.source})`);
    return state(c);
  });
  admin.put('/enabled', async (c) => {
    const { enabled } = await body<SetEnabledRequest>(c);
    if (typeof enabled !== 'boolean') throw new AppError('VALIDATION_FAILED', '`enabled` must be true or false.');
    portal.setEnabled(enabled);
    console.log(`[portal] sign-in ${enabled ? 'enabled' : 'disabled'}`);
    return state(c);
  });
  app.route('/api/admin', admin);

  const ws = new Hono<Env>();
  ws.use(requireSession);
  ws.get('/targets', async (c) => c.json(success(await workspaces.targets(c.req.query('fresh') === '1'))));
  ws.get('/usage', async (c) => c.json(success(await workspaces.usage())));
  ws.get('/', async (c) => c.json(success(await workspaces.list())));
  ws.post('/', async (c) => {
    const created = await workspaces.create(await body<CreateWorkspaceRequest>(c));
    console.log(`[workspaces] creating ${created.id}`);
    return c.json(success(created), 202);
  });
  ws.post('/:target/:name/start', async (c) => {
    await workspaces.start(c.req.param('target'), c.req.param('name'));
    return c.json(success({ ok: true }));
  });
  ws.post('/:target/:name/stop', async (c) => {
    await workspaces.stop(c.req.param('target'), c.req.param('name'));
    return c.json(success({ ok: true }));
  });
  ws.delete('/:target/:name', async (c) => {
    await workspaces.remove(c.req.param('target'), c.req.param('name'));
    return c.json(success({ ok: true }));
  });
  app.route('/api/workspaces', ws);

  app.all('/api/*', () => {
    throw new AppError('NOT_FOUND');
  });

  if (serveWeb) {
    // serveStatic resolves `root` from the working directory.
    const root = relative(process.cwd(), config.paths.webDist) || '.';
    app.use('/assets/*', async (c, next) => {
      await next();
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    });
    app.use('*', serveStatic({ root }));
    // Client-side routes: every other path gets the app shell.
    app.get('*', serveStatic({ root, path: 'index.html' }));
  }

  return app;
}
