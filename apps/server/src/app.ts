import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { AppError, codeForStatus, isAppError, success } from '@isnanme/core';
import {
  API,
  type AccountPoolRequest,
  type AdminState,
  type AssignAccountPoolRequest,
  type BulkAddAccountsRequest,
  type CreateAccountRequest,
  type CreateWorkspaceRequest,
  type KeySetupResult,
  type KeyUnlockResult,
  type EndpointRequest,
  type LoginRequest,
  type RotateCodeRequest,
  type SessionStatus,
  type SetEnabledRequest,
  type SystemStatus,
  type UpdateAccountRequest,
  type Workspace,
  type WorkspaceDeliveryState,
  type LiveTopic,
  type ClaudeAuthStatus,
  type ClaudeLoginRequest,
  type ClaudeLoginStart,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AccountHealthService } from './accounts/health.js';
import type { ChatController } from './chat/controller.js';
import { createChatFileRoutes } from './chat/fileRoutes.js';
import { createChatRoutes } from './chat/routes.js';
import { createChatTrustRoutes } from './chat/trustRoutes.js';
import type { AccountPools } from './accounts/pools.js';
import type { AccountsService } from './accounts/service.js';
import { runPreflight } from './delivery/preflight.js';
import type { Reconciler } from './delivery/reconciler.js';
import { config } from './config.js';
import type { Portal } from './portal.js';
import { RateLimiter } from './rateLimit.js';
import { ClaudeLogins } from './workspaces/claudeLogin.js';
import { deliveryState, workspaceView } from './workspaces/view.js';
import { generateSecretKey, parseSecretKey, SecretKeyError } from './store/secretBox.js';
import type { Store } from './store/store.js';
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

export function createApp(
  portal: Portal,
  workspaces: Workspaces,
  store: Store,
  accounts: AccountsService,
  pools: AccountPools,
  reconciler: Reconciler,
  health: AccountHealthService,
  chatController: ChatController,
  { serveWeb, notify = () => {} }: { serveWeb: boolean; notify?: (...topics: LiveTopic[]) => void },
) {
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
  const keyFileFilled = () => {
    const file = config.secretKey.file;
    return !!file && existsSync(file) && statSync(file).size > 0;
  };
  const systemStatus = (): SystemStatus => {
    const backups = store.listBackups();
    const locked = !store.secrets;
    return {
      portalId: store.portalId,
      schemaVersion: store.schemaVersion,
      trust: store.trust,
      resumable: store.resumable,
      lastBackupAt: backups[0]?.at.toISOString() ?? null,
      backups: backups.length,
      secretKey: {
        source: store.keySource,
        canSetUp: locked && store.writable && !store.hasKeyCheck,
        canUnlock: locked && store.writable && store.hasKeyCheck,
        // A new key must also stick after a restart: not while PORTAL_SECRET_KEY or a filled key file supplies the old one.
        canReset: locked && store.writable && store.hasKeyCheck && store.sealedCount === 0 && !config.secretKey.value && !keyFileFilled(),
        keyFile: config.secretKey.file ?? null,
      },
    };
  };
  const system = (c: Context<Env>) => c.json(success(systemStatus()));

  /** Saves a panel key to PORTAL_SECRET_KEY_FILE when that file is set and empty. Never overwrites a key file. */
  const saveKeyFile = (key: string): string | null => {
    const file = config.secretKey.file;
    if (!file || keyFileFilled()) return null;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, key, { mode: 0o600 });
      renameSync(tmp, file);
      return file;
    } catch (e) {
      console.error(`[store] could not save the key file: ${(e as Error).message}`);
      return null;
    }
  };
  const unlockLimiter = new RateLimiter(10, 10 * 60 * 1000);
  admin.post('/system/key/reset', (c) => {
    if (!systemStatus().secretKey.canReset) throw new AppError('CONFLICT', 'Secrets are stored with the current key. Unlock with it instead.');
    const key = generateSecretKey();
    store.resetKey(parseSecretKey(key));
    const savedTo = saveKeyFile(key);
    console.log(`[store] lost key replaced from the panel; nothing was encrypted with it (${savedTo ? `saved to ${savedTo}` : 'kept in memory'})`);
    reconciler.requestAll('key reset');
    notify('system', 'accounts');
    return c.json(success<KeySetupResult>({ key, savedTo, status: systemStatus() }));
  });
  admin.get('/system', system);
  admin.post('/system/key/setup', (c) => {
    if (!systemStatus().secretKey.canSetUp) throw new AppError('CONFLICT', 'This database already has a key. Unlock it with that key.');
    const key = generateSecretKey();
    store.setUpKey(parseSecretKey(key));
    const savedTo = saveKeyFile(key);
    console.log(`[store] encryption set up from the panel (${savedTo ? `saved to ${savedTo}` : 'kept in memory'})`);
    reconciler.requestAll('key set up');
    notify('system', 'accounts');
    return c.json(success<KeySetupResult>({ key, savedTo, status: systemStatus() }));
  });
  admin.post('/system/key/unlock', async (c) => {
    const who = clientKey(c);
    if (unlockLimiter.blocked(who)) throw new AppError('RATE_LIMITED', 'Too many tries. Wait a few minutes.');
    if (!systemStatus().secretKey.canUnlock) throw new AppError('CONFLICT', 'Nothing to unlock.');
    const { key } = await body<{ key: string }>(c);
    let parsed: Buffer;
    try {
      parsed = parseSecretKey(typeof key === 'string' ? key : '', 'The key');
      store.unlock(parsed);
    } catch (e) {
      unlockLimiter.fail(who);
      const message = e instanceof SecretKeyError ? e.message : (e as Error).message;
      throw new AppError('VALIDATION_FAILED', message, { details: { key: message } });
    }
    unlockLimiter.reset(who);
    const savedTo = saveKeyFile((key as string).trim());
    console.log(`[store] unlocked from the panel${savedTo ? `; key saved to ${savedTo}` : ''}`);
    reconciler.requestAll('unlocked');
    notify('system', 'accounts');
    return c.json(success<KeyUnlockResult>({ savedTo, status: systemStatus() }));
  });
  admin.post('/system/resume', (c) => {
    if (!store.resumable) throw new AppError('CONFLICT', 'Nothing to resume: fix the reasons shown first.');
    store.resume();
    console.log('[store] delivery resumed by an admin');
    notify('system');
    return system(c);
  });
  app.route('/api/admin', admin);

  const ws = new Hono<Env>();
  ws.use(requireSession);
  ws.get('/targets', async (c) => c.json(success(await workspaces.targets(c.req.query('fresh') === '1'))));
  ws.get('/usage', async (c) => c.json(success(await workspaces.usage())));
  const delivery = (id: string) => deliveryState(reconciler, id);
  const decorate = workspaceView(pools, reconciler);

  // Claude Code's own sign-in, driven from the portal; the credential stays in the workspace.
  const logins = new ClaudeLogins(workspaces);
  const ownSignIn = (c: Context<Env>) => {
    const [target, name] = [c.req.param('target')!, c.req.param('name')!];
    if (pools.stateFor(`${target}/${name}`))
      throw new AppError('CONFLICT', 'This workspace uses its account pool’s keys. Unassign the pool to sign in with your own Claude account.');
    return [target, name] as const;
  };
  ws.get('/:target/:name/claude-login', async (c) =>
    c.json(success<ClaudeAuthStatus>(await logins.status(c.req.param('target'), c.req.param('name')))),
  );
  ws.post('/:target/:name/claude-login', async (c) => {
    const [target, name] = ownSignIn(c);
    const req = (await c.req.json().catch(() => ({}))) as Partial<ClaudeLoginRequest> | null;
    return c.json(success<ClaudeLoginStart>(await logins.start(target, name, { sso: req?.sso === true, email: req?.email })));
  });
  ws.post('/:target/:name/claude-login/code', async (c) => {
    const { code } = await body<{ code: string }>(c);
    await logins.submit(...ownSignIn(c), code);
    return c.json(success({ ok: true }));
  });
  ws.delete('/:target/:name/claude-login', async (c) => {
    await logins.cancel(c.req.param('target'), c.req.param('name'));
    return c.json(success({ ok: true }));
  });
  ws.post('/:target/:name/claude-logout', async (c) => {
    await logins.logout(...ownSignIn(c));
    return c.json(success({ ok: true }));
  });
  ws.get('/', async (c) => c.json(success((await workspaces.list()).map(decorate))));
  ws.post('/', async (c) => {
    const req = await body<CreateWorkspaceRequest>(c);
    const poolId = req.accountPoolId ?? null;
    if (poolId && !pools.list().some((p) => p.id === poolId))
      throw new AppError('VALIDATION_FAILED', 'That account pool no longer exists.', { details: { accountPoolId: 'Pick another pool.' } });
    const created = await workspaces.create(req);
    // A new workspace has no sign-in of its own yet, so no override confirmation is needed.
    if (poolId) pools.assign(created.id, { poolId }, { existing: false });
    console.log(`[workspaces] creating ${created.id}${poolId ? ' with an account pool' : ''}`);
    return c.json(success(decorate(created)), 202);
  });
  ws.put('/:target/:name/account', async (c) => {
    const id = `${c.req.param('target')}/${c.req.param('name')}`;
    const state = pools.assign(id, await body<AssignAccountPoolRequest>(c), { existing: true });
    return c.json(success({ account: state }));
  });
  ws.get('/:target/:name/preflight', async (c) => {
    const access = workspaces.runtimeFor(c.req.param('target'))?.delivery;
    if (!access) return c.json(success({ findings: null }));
    return c.json(success({ findings: await runPreflight(access, c.req.param('name')) }));
  });
  ws.post('/:target/:name/adopt', async (c) => {
    await reconciler.adopt(`${c.req.param('target')}/${c.req.param('name')}`);
    return c.json(success({ delivery: delivery(`${c.req.param('target')}/${c.req.param('name')}`) }));
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
    pools.forgetWorkspace(`${c.req.param('target')}/${c.req.param('name')}`);
    return c.json(success({ ok: true }));
  });
  app.route('/api/workspaces', ws);

  const acc = new Hono<Env>();
  acc.use(requireSession);
  acc.get('/', (c) => c.json(success(accounts.overview())));
  acc.post('/', async (c) => c.json(success(await accounts.create(await body<CreateAccountRequest>(c))), 201));
  acc.post('/bulk', async (c) => c.json(success(accounts.bulkAdd(await body<BulkAddAccountsRequest>(c)))));
  acc.patch('/:id', async (c) => c.json(success(await accounts.update(c.req.param('id'), await body<UpdateAccountRequest>(c)))));
  // Check now: the key check, plus a probe when the account is cooling or has a problem (FR19).
  acc.post('/:id/check', async (c) => {
    const id = c.req.param('id');
    const account = await accounts.check(id);
    if (account.health.state !== 'ok') await health.probe(id, { reasons: ['admin re-check'], manual: true });
    return c.json(success(accounts.get(id)));
  });
  acc.post('/:id/clear', (c) => {
    const id = c.req.param('id');
    accounts.get(id);
    health.clear(id);
    return c.json(success(accounts.get(id)));
  });
  acc.delete('/:id', (c) => {
    accounts.remove(c.req.param('id'));
    return c.json(success({ ok: true }));
  });
  app.route('/api/accounts', acc);

  const ep = new Hono<Env>();
  ep.use(requireSession);
  ep.post('/', async (c) => c.json(success(accounts.createEndpoint(await body<EndpointRequest>(c))), 201));
  ep.patch('/:id', async (c) => c.json(success(accounts.updateEndpoint(c.req.param('id'), await body<EndpointRequest>(c)))));
  ep.get('/:id/models', async (c) => c.json(success(await accounts.endpointModels(c.req.param('id')))));
  ep.delete('/:id', (c) => {
    accounts.removeEndpoint(c.req.param('id'));
    return c.json(success({ ok: true }));
  });
  app.route('/api/endpoints', ep);

  const ap = new Hono<Env>();
  ap.use(requireSession);
  ap.get('/', (c) => c.json(success(pools.list())));
  ap.post('/', async (c) => c.json(success(pools.create(await body<AccountPoolRequest>(c))), 201));
  ap.patch('/:id', async (c) => c.json(success(pools.update(c.req.param('id'), await body<AccountPoolRequest>(c)))));
  ap.delete('/:id', (c) => {
    pools.remove(c.req.param('id'));
    return c.json(success({ ok: true }));
  });
  app.route('/api/account-pools', ap);

  // Chat sessions (REST); the live part rides its own socket (chat/socket.ts).
  const chat = new Hono<Env>();
  chat.use(requireSession);
  chat.route('/', createChatRoutes(chatController));
  chat.route('/', createChatFileRoutes({ controller: chatController, workspaces, store }));
  app.route('/api/chat/sessions', chat);
  const trust = new Hono<Env>();
  trust.use(requireSession);
  trust.route('/', createChatTrustRoutes({ controller: chatController, workspaces, store }));
  app.route('/api/chat/trust', trust);

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
