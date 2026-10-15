import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { AppError, codeForStatus, isAppError, success } from '@isnanme/core';
import {
  API,
  isStableWorkspaceId,
  type RenameWorkspaceRequest,
  type UpdateWorkspaceResourcesRequest,
  type WorkspaceResources,
  type RenameWorkspaceResult,
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
  type CreateTerminalRequest,
  type WorkspaceClaudeState,
  type WorkspaceTerminal,
} from '@portal/contracts';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AccountHealthService } from './accounts/health.js';
import type { ChatController } from './chat/controller.js';
import { createChatFileRoutes } from './chat/fileRoutes.js';
import { Reauth } from './chat/reauth.js';
import { createChatMetaRoutes, createChatRoutes, createClaudeRoutes, createUsageRoutes } from './chat/routes.js';
import { createChatTrustRoutes } from './chat/trustRoutes.js';
import type { AccountPools } from './accounts/pools.js';
import type { AccountsService } from './accounts/service.js';
import { runPreflight } from './delivery/preflight.js';
import type { Reconciler } from './delivery/reconciler.js';
import { config } from './config.js';
import { contentSecurityPolicy } from './csp.js';
import type { Portal } from './portal.js';
import { RateLimiter } from './rateLimit.js';
import { ClaudeLogins } from './workspaces/claudeLogin.js';
import { Terminals } from './workspaces/terminals.js';
import { deliveryState, workspaceView } from './workspaces/view.js';
import { declareWorkspacePolicies } from './workspaces/authz.js';
import { generateSecretKey, parseSecretKey, SecretKeyError } from './store/secretBox.js';
import type { Store } from './store/store.js';
import type { Workspaces } from './workspaces/manager.js';
import { createPoolRoutes, createWorkspacePoolRoutes } from './pools/routes.js';
import { createSecretsRoutes } from './secrets/routes.js';
import type { PoolService } from './pools/service.js';
import type { McpSets } from './mcp/index.js';
import { createMcpRoutes } from './mcp/routes.js';
import type { SkillsModule } from './skills/module.js';
import { createSkillRoutes } from './skills/routes.js';
import { createKnowledgeRoutes } from './knowledge/routes.js';
import type { KnowledgeService } from './knowledge/service.js';
import { createPersonaRoutes, type Personas } from './personas/index.js';
import { createSettingsRoutes, type SettingsModule } from './settings/index.js';
import { createSecretsAdminRoutes } from './secrets/adminRoutes.js';
import type { SecretRotations } from './secrets/rotation.js';
import type { PortalMcpModule } from './portalmcp/module.js';
import { createPortalMcpEndpoint, createPortalMcpRoutes } from './portalmcp/routes.js';
import type { Tickets } from './tickets/service.js';
import { createTicketRoutes } from './tickets/routes.js';
import type { CiService } from './ci/service.js';
import { createCiRoutes } from './ci/routes.js';
import type { BrowserModule } from './browser/index.js';
import { createReposRoutes, createWorkspaceReposRoutes, type ReposService } from './repos/index.js';
import { isWorkspaceId, PLAIN_NAME } from './names.js';
import { createClaudeUsageRoutes, type ClaudeUsageMonitor } from './claudeusage/index.js';
import { createUsageSpendRoutes, type UsageSpend } from './usagespend/index.js';
import type { Lab } from './lab/index.js';
import { createLabRoutes } from './lab/routes.js';
import { createGlanceRoutes, type Glance } from './glance/index.js';
import { createAttentionRoutes, type AttentionRegistry } from './attention/index.js';
import type { ConnectModule } from './connect/index.js';
import { createClaudeVersionRoutes, createWorkspaceClaudeVersionRoutes, type ClaudeVersions } from './claudeversion/index.js';
import { createCodespacesRoutes, type Codespaces } from './codespaces/index.js';
import type { Platform } from './platform/index.js';
import { actorOf, visible } from './authz/seam.js';
import { jsonCompress } from './jsonCompress.js';

type Env = { Bindings: HttpBindings; Variables: { token: string } };

/** Letters, digits, dot, underscore and dash, starting with a letter or digit: what a target or a workspace is ever called. */
export { PLAIN_NAME };

/**
 * The page that sent this request is this portal: its Origin, exactly as a browser writes it, is http or https and names the
 * request's own Host. The scheme is not compared, since TLS ends at a proxy and the server sees http (T-143); x-forwarded-*
 * is not trusted. Both Origin checks on /api use this one rule.
 */
export function sameHostOrigin(origin: string, host: string | undefined): boolean {
  try {
    const o = new URL(origin);
    return (o.protocol === 'http:' || o.protocol === 'https:') && o.origin === origin && host !== undefined && o.host === host;
  } catch {
    return false;
  }
}

const clientKey = (c: Context<Env>) => {
  const forwarded = config.trustProxy ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined;
  return forwarded || (c.env.incoming?.socket.remoteAddress ?? 'unknown');
};

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
  {
    serveWeb,
    notify = () => {},
    poolService,
    mcp,
    skills,
    personas,
    settings,
    secrets,
    portalMcp,
    tickets,
    ci,
    knowledge,
    browser,
    claudeUsage,
    usageSpend,
    lab,
    repos,
    glance,
    attention,
    codespaces,
    platform,
    claudeVersions,
    connect,
  }: {
    serveWeb: boolean;
    notify?: (...topics: LiveTopic[]) => void;
    /** Multi-assignment pools (secrets & env, skillsets, MCP sets). */
    poolService: PoolService;
    /** MCP sets: the catalog and each workspace's MCP status (`/api/mcp`). */
    mcp?: McpSets;
    /** Skillsets: the skill library, reviews and each workspace's skills (`/api/skills`). */
    skills?: SkillsModule;
    /** Personas and instruction contexts: what a workspace's persona is (`/api/personas`). */
    personas?: Personas;
    /** The settings store and the MCP lockdown (`/api/settings`). */
    settings?: SettingsModule;
    /** Secrets & env: rotation, versions and revocation (`/api/secrets`). */
    secrets?: SecretRotations;
    /** Portal MCP: the `/mcp` endpoint (bearer tokens) and its admin routes (`/api/portal-mcp`). */
    portalMcp?: PortalMcpModule;
    /** Tickets: the queue of work for people and agents (`/api/tickets`). */
    tickets?: Tickets;
    /** CI: remotes, runs and their logs (`/api/ci`). */
    ci?: CiService;
    /** Knowledge: vaults of notes, search and graphs (`/api/knowledge`). */
    knowledge?: KnowledgeService;
    /** Browser & desktop: each workspace's browser container (`/api/workspaces/:target/:name/browser`). */
    browser?: BrowserModule;
    /** Claude usage: the plan limits of each Claude (`/api/claude-usage`). */
    claudeUsage?: ClaudeUsageMonitor;
    /** Usage spend: who spent what, budgets and spikes (`/api/usage-spend`). */
    usageSpend?: UsageSpend;
    /** Efficiency lab: slice economy, outcomes, the summary and experiments, read only (`/api/lab`, docs/prd/claude-usage.md §28). */
    lab?: Lab;
    /** Workspace git: the repositories inside each workspace (`/api/repos`, `/api/workspaces/:target/:name/repos`). */
    repos?: ReposService;
    /** Glance widgets: sessions, agents and what needs attention in one snapshot (`/api/glance`). */
    glance?: Glance;
    /** Needs you: what waits for a person, from every module, read only (`/api/attention`). */
    attention?: AttentionRegistry;
    /** GitHub Codespaces POC: GitHub connections and the codespace lifecycle (`/api/codespaces`, docs/prd/codespaces-poc.md). */
    codespaces?: Codespaces;
    /** The platform track: notifications, the platform audit, and the modules that register with it (`/api/notify`, `/api/platform`, `/hooks`). */
    platform?: Platform;
    /** Claude Code version pinning: each workspace's version, the compatibility canary, images, Apply and Rollback (`/api/claude-version`, `/api/workspaces/:target/:name/claude-version`). */
    claudeVersions?: ClaudeVersions;
    /** Connect: targets and agents enrolled from the web (`/api/connect` behind the session; `/connect/` for agents, no cookie). */
    connect?: ConnectModule;
  },
) {
  const app = new Hono<Env>();
  const limiter = new RateLimiter(config.loginLimit.attempts, config.loginLimit.windowMs);
  const { cookie, ttlMs } = config.session;

  // Served over plain HTTP: no HSTS.
  // The built app also gets a CSP (csp.ts); the dev server's pages come from Vite, not from here.
  app.use(secureHeaders({ strictTransportSecurity: false, ...(serveWeb ? { contentSecurityPolicy: contentSecurityPolicy(`${config.paths.webDist}/index.html`) } : {}) }));
  // What the API says is for this session only: never kept by a shared cache or replayed from the back/forward cache.
  // (Blobs and downloads set their own Cache-Control.)
  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });
  // JSON answers gzip-compressed when the client accepts it (T-376); never a stream, a blob or a download (jsonCompress.ts).
  app.use('/api/*', jsonCompress());
  app.use('/api/*', csrf({ origin: (origin, c) => sameHostOrigin(origin, c.req.header('host')) }));
  // csrf() only looks at form-like content types. Browsers name the origin on every request that is not a plain
  // GET, so a JSON request from another origin (or marked cross-site) is refused here too (same host rule as the sockets).
  app.use('/api/*', async (c, next) => {
    if (!/^(GET|HEAD|OPTIONS)$/.test(c.req.method)) {
      const origin = c.req.header('origin');
      let foreign = c.req.header('sec-fetch-site') === 'cross-site';
      if (origin !== undefined) foreign = !sameHostOrigin(origin, c.req.header('host'));
      if (foreign) throw new AppError('FORBIDDEN', 'Forbidden');
    }
    await next();
  });
  // Bodies are refused by their size before anything reads them into memory: sign-in takes a few bytes (and needs no session, so
  // it must not buffer megabytes for a stranger), a JSON call a few MB; uploads have their own, lower limits (QA-028).
  const limit = (maxSize: number) =>
    bodyLimit({
      maxSize,
      onError: (c) => {
        const e = new AppError('PAYLOAD_TOO_LARGE', 'That request is too large.');
        return c.json(e.toJSON(), e.status as ContentfulStatusCode);
      },
    });
  const loginLimit = limit(4 * 1024);
  const jsonLimit = limit(4 * 1024 * 1024);
  const anyLimit = limit(256 * 1024 * 1024);
  app.use(API.login, loginLimit);
  app.use('/api/*', (c, next) => (/^application\/json/i.test(c.req.header('content-type') ?? '') ? jsonLimit(c, next) : anyLimit(c, next)));

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

  // A workspace id in a body or a query string ends up in Docker API URLs, tmux names, shell words and the database just like one in a path
  // (QA-029, QA-032): a call that names one that is not `<target>/<name>` of plain names is refused here, signed in, before a handler
  // sees it. Empty means "none" and is the handler's to judge.
  const WORKSPACE_FIELDS = ['workspaceId', 'workspaceIds', 'workspace', 'workspaces'];
  const notAnId = (v: unknown) => typeof v === 'string' && v !== '' && !isWorkspaceId(v);
  const hostileWorkspaceField = async (c: Context<Env>): Promise<string | null> => {
    for (const f of WORKSPACE_FIELDS) if (c.req.queries(f)?.some(notAnId)) return f;
    if (/^(POST|PUT|PATCH|DELETE)$/.test(c.req.method) && /^application\/json/i.test(c.req.header('content-type') ?? '')) {
      // A clone, so the handler still gets the stream untouched (the avatar and file routes read it themselves).
      const json: unknown = await c.req.raw.clone().json().catch(() => undefined);
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        for (const f of WORKSPACE_FIELDS) {
          const v = (json as Record<string, unknown>)[f];
          if (Array.isArray(v) ? v.some(notAnId) : notAnId(v)) return f;
        }
      }
    }
    return null;
  };
  const requireSession = createMiddleware<Env>(async (c, next) => {
    const token = getCookie(c, cookie);
    if (!token || !portal.session(token)) throw new AppError('UNAUTHORIZED', 'Sign in again.');
    const field = await hostileWorkspaceField(c);
    if (field) throw new AppError('VALIDATION_FAILED', 'A workspace is `<target>/<name>`.', { details: { [field]: 'Not a workspace.' } });
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
    // Locked means a key problem. A database that froze before its key was looked at (a failed migration, a newer
    // schema) has no secrets either, but entering a key can't fix that, so no key action is offered for it.
    const locked = !store.secrets && store.trust.reasons.some((r) => r.code.startsWith('key-'));
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

  declareWorkspacePolicies();
  const ws = new Hono<Env>();
  ws.use(requireSession);
  // The target and name in these paths end up in Docker API URLs, tmux session names and shell commands. A name with a slash, `..`
  // or a control character (`..%2f..%2fcontainers`) used to reach the Docker daemon as a path, and its redirect crashed the portal
  // (QA-029). Only plain names get past here; anything else is a workspace that doesn't exist.
  const plainName = createMiddleware<Env>(async (c, next) => {
    const [target, name] = [c.req.param('target') ?? '', c.req.param('name') ?? ''];
    if (!PLAIN_NAME.test(target) || !PLAIN_NAME.test(name)) throw new AppError('NOT_FOUND', 'That workspace doesn’t exist.');
    await next();
  });
  ws.use('/:target/:name', plainName);
  ws.use('/:target/:name/*', plainName);
  // The same check for the `…/:target/:name…` paths of the other modules (MCP sets, skills, personas, lockdown, the portal MCP's agent
  // switches). They hand the name on to the reconciler and the runtimes, which kept a hostile one as a "known workspace" and asked
  // Docker for it again every 15 seconds. Mounted right after each module's session guard.
  const plainNamesOn = (group: Hono<Env>, base: string) => {
    group.use(base, plainName);
    group.use(`${base}/*`, plainName);
  };
  ws.get('/targets', async (c) => c.json(success(await workspaces.targets(c.req.query('fresh') === '1'))));
  ws.get('/usage', async (c) => c.json(success(await workspaces.usage())));
  // The labels of renamed workspaces (T-42), from the records only: the app learns them once, so every place that holds an id shows the label.
  ws.get('/labels', (c) => {
    const labels = workspaces.identities.labels();
    const mine = visible(actorOf(c), 'workspace', Object.keys(labels), (id) => id);
    return c.json(success(Object.fromEntries(mine.map((id) => [id, labels[id]!]))));
  });
  const delivery = (id: string) => deliveryState(reconciler, id);
  const decorate = workspaceView(pools, reconciler, claudeVersions?.brief);

  // Claude Code's own sign-in, driven from the portal; the credential stays in the workspace.
  const logins = new ClaudeLogins(workspaces);
  // A session without a pool runs on its Claude's own sign-in (chat PRD §6): checked before each start.
  chatController.signedIn = async (workspaceId, directory) => {
    const slash = workspaceId.indexOf('/');
    return (await logins.status(workspaceId.slice(0, slash), workspaceId.slice(slash + 1), directory)).loggedIn;
  };
  const ownSignIn = (c: Context<Env>) => {
    const [target, name] = [c.req.param('target')!, c.req.param('name')!];
    if (pools.stateFor(`${target}/${name}`))
      throw new AppError('CONFLICT', 'This workspace uses its account pool’s keys. Unassign the pool to sign in with your own Claude account.');
    return [target, name] as const;
  };
  /** `?claude=<id>`: which of the workspace's Claudes (its directory, each with its own login); Default when absent. */
  const claudeDir = (c: Context<Env>) => {
    const id = c.req.query('claude');
    if (!id) return '';
    const claude = chatController.claudeOf(`${c.req.param('target')}/${c.req.param('name')}`, id);
    if (!claude) throw new AppError('NOT_FOUND', 'That Claude isn’t on this workspace.');
    return claude.directory;
  };
  ws.get('/:target/:name/claude-login', async (c) =>
    c.json(success<ClaudeAuthStatus>(await logins.status(c.req.param('target'), c.req.param('name'), claudeDir(c)))),
  );
  ws.post('/:target/:name/claude-login', async (c) => {
    const [target, name] = ownSignIn(c);
    const req = (await c.req.json().catch(() => ({}))) as Partial<ClaudeLoginRequest> | null;
    return c.json(success<ClaudeLoginStart>(await logins.start(target, name, { sso: req?.sso === true, email: req?.email, dir: claudeDir(c) })));
  });
  ws.post('/:target/:name/claude-login/code', async (c) => {
    const { code } = await body<{ code: string }>(c);
    const [target, name] = ownSignIn(c);
    const dir = claudeDir(c);
    await logins.submit(target, name, code, dir);
    chatController.forgetClaudeModelsAt(`${target}/${name}`, dir); // T-109: another account may offer other models
    return c.json(success({ ok: true }));
  });
  ws.delete('/:target/:name/claude-login', async (c) => {
    await logins.cancel(c.req.param('target'), c.req.param('name'), claudeDir(c));
    return c.json(success({ ok: true }));
  });
  ws.post('/:target/:name/claude-logout', async (c) => {
    const [target, name] = ownSignIn(c);
    const dir = claudeDir(c);
    await logins.logout(target, name, dir);
    chatController.forgetClaudeModelsAt(`${target}/${name}`, dir);
    return c.json(success({ ok: true }));
  });

  // Terminals that outlive the browser (tmux sessions), several Claude Codes side by side.
  const terminals = new Terminals(workspaces, logins, chatController);
  ws.get('/:target/:name/terminals', async (c) =>
    c.json(success<WorkspaceTerminal[]>(await terminals.list(c.req.param('target'), c.req.param('name')))),
  );
  ws.post('/:target/:name/terminals', async (c) => {
    const req = (await c.req.json().catch(() => ({}))) as Partial<CreateTerminalRequest> | null;
    return c.json(success<WorkspaceTerminal>(await terminals.create(c.req.param('target'), c.req.param('name'), req ?? {})), 201);
  });
  ws.delete('/:target/:name/terminals/:term', async (c) => {
    await terminals.close(c.req.param('target'), c.req.param('name'), c.req.param('term'));
    return c.json(success({ ok: true }));
  });

  // The workspace's Claudes (Workspace Claudes), each with its own Claude Code login: sign-in state
  // from `claude auth status` (status and method only), and the terminals running as each.
  ws.get('/:target/:name/claudes', async (c) => {
    const [target, name] = [c.req.param('target'), c.req.param('name')];
    const live = (await chatController.claudesOf(`${target}/${name}`)).filter((x) => !x.removedAt);
    const open = await terminals.list(target, name).catch(() => []);
    const states = await Promise.all(
      live.map(async (claude): Promise<WorkspaceClaudeState> => ({
        claude,
        auth: await logins.status(target, name, claude.directory).catch(() => null),
        terminals: open.filter((t) => t.claudeId === claude.id).length,
      })),
    );
    return c.json(success(states));
  });
  ws.patch('/:target/:name/claudes/:claude', async (c) => {
    const { name: label } = await body<{ name: string }>(c);
    return c.json(success(chatController.renameClaude(`${c.req.param('target')}/${c.req.param('name')}`, c.req.param('claude'), String(label ?? ''))));
  });
  ws.delete('/:target/:name/claudes/:claude', async (c) => {
    const [target, name, claudeId] = [c.req.param('target'), c.req.param('name'), c.req.param('claude')];
    if ((await terminals.list(target, name).catch(() => [])).some((t) => t.claudeId === claudeId))
      throw new AppError('CONFLICT', 'Close this Claude’s terminals first.');
    chatController.removeClaude(`${target}/${name}`, claudeId);
    return c.json(success({ ok: true }));
  });
  ws.get('/', async (c) => c.json(success((await workspaces.list()).map(decorate))));
  // One workspace by either form of its id (T-42): `/api/workspaces/ws_0123456789ab` or the alias `/api/workspaces/<target>/<name>`. Both go
  // through the manager's one resolver, which follows the alias before the seam is asked; unknown and not yours are the same 404.
  ws.get('/:ref', async (c) => {
    const ref = c.req.param('ref');
    if (!isStableWorkspaceId(ref)) throw new AppError('NOT_FOUND', 'Not found.');
    return c.json(success(decorate(await workspaces.get(ref, actorOf(c)))));
  });
  // CPU and memory of a Kubernetes workspace (T-98), by either form of the id. `/<stable id>/resources` has two segments, like
  // `/<target>/<name>`: anything that is not a stable id goes on to those routes.
  ws.get('/:ref/resources', async (c, next) => {
    const ref = c.req.param('ref');
    if (!isStableWorkspaceId(ref)) return next();
    return c.json(success<WorkspaceResources>(await workspaces.resourcesOf(ref, actorOf(c))));
  });
  ws.patch('/:ref/resources', async (c, next) => {
    const ref = c.req.param('ref');
    if (!isStableWorkspaceId(ref)) return next();
    return c.json(success<WorkspaceResources>(await workspaces.setResources(ref, await body<UpdateWorkspaceResourcesRequest>(c), actorOf(c))));
  });
  ws.get('/:target/:name/resources', async (c) => c.json(success<WorkspaceResources>(await workspaces.resourcesOf(`${c.req.param('target')}/${c.req.param('name')}`, actorOf(c)))));
  ws.patch('/:target/:name/resources', async (c) =>
    c.json(success<WorkspaceResources>(await workspaces.setResources(`${c.req.param('target')}/${c.req.param('name')}`, await body<UpdateWorkspaceResourcesRequest>(c), actorOf(c)))),
  );
  ws.get('/:target/:name', async (c) => c.json(success(decorate(await workspaces.get(`${c.req.param('target')}/${c.req.param('name')}`, actorOf(c))))));
  // Rename (T-42 slice 2): the label only, by either form of the id. Nothing running is touched; the old forms keep resolving.
  const rename = async (c: Context<Env>, ref: string) => {
    const { label } = await body<RenameWorkspaceRequest>(c);
    return c.json(success<RenameWorkspaceResult>(await workspaces.rename(ref, label, actorOf(c))));
  };
  ws.patch('/:ref', async (c) => {
    const ref = c.req.param('ref');
    if (!isStableWorkspaceId(ref)) throw new AppError('NOT_FOUND', 'Not found.');
    return rename(c, ref);
  });
  ws.patch('/:target/:name', async (c) => rename(c, `${c.req.param('target')}/${c.req.param('name')}`));
  ws.post('/', async (c) => {
    const req = await body<CreateWorkspaceRequest>(c);
    const poolId = req.accountPoolId ?? null;
    if (poolId && !pools.list().some((p) => p.id === poolId))
      throw new AppError('VALIDATION_FAILED', 'That account pool no longer exists.', { details: { accountPoolId: 'Pick another pool.' } });
    const addOns = poolService.checkAddOns(req.pools);
    const created = await workspaces.create(req, actorOf(c));
    // A new workspace has no sign-in of its own yet, so no override confirmation is needed.
    if (poolId) pools.assign(created.id, { poolId }, { existing: false });
    for (const [type, ids] of Object.entries(addOns)) poolService.setAssignments(created.id, type, ids.map((id) => ({ poolId: id })));
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
    poolService.forgetWorkspace(`${c.req.param('target')}/${c.req.param('name')}`);
    settings?.lockdown.forgetWorkspace(`${c.req.param('target')}/${c.req.param('name')}`);
    settings?.agentEnv.forgetWorkspace(`${c.req.param('target')}/${c.req.param('name')}`);
    repos?.forgetWorkspace(`${c.req.param('target')}/${c.req.param('name')}`);
    return c.json(success({ ok: true }));
  });
  // A workspace's multi-assignment pools: GET …/pools, PUT …/pools/:type.
  ws.route('/', createWorkspacePoolRoutes({ service: poolService, reconciler }));
  // Secrets & env: what a workspace's sets deliver (names only) and the migration check (FR15).
  ws.route('/', createSecretsRoutes({ pools: poolService, workspaces }));
  // Browser & desktop: a workspace's browser status, wake, stop and restart.
  if (browser) ws.route('/', browser.routes());
  // Workspace git: a workspace's repositories as a tree, a scan, and its scan settings.
  if (repos) ws.route('/', createWorkspaceReposRoutes(repos));
  // Claude Code version pinning: a workspace's version, the upgrade plan, Apply, Rollback and history.
  if (claudeVersions) ws.route('/', createWorkspaceClaudeVersionRoutes(claudeVersions));
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

  // Multi-assignment pools (secrets & env, skillsets, MCP sets): one set of routes for every type.
  const pl = new Hono<Env>();
  pl.use(requireSession);
  pl.route('/', createPoolRoutes({ service: poolService }));
  app.route('/api/pools', pl);

  // MCP sets: the catalog, "Try in set" and each workspace's MCP status (the sets use /api/pools/mcpset).
  if (mcp) {
    const mc = new Hono<Env>();
    mc.use(requireSession);
    plainNamesOn(mc, '/workspaces/:target/:name');
    mc.route('/', createMcpRoutes(mcp));
    app.route('/api/mcp', mc);
  }

  // Skillsets: the library, imports, reviews and each workspace's skills (the sets use /api/pools/skillset).
  if (skills) {
    const sk = new Hono<Env>();
    sk.use(requireSession);
    plainNamesOn(sk, '/workspaces/:target/:name');
    sk.route('/', createSkillRoutes(skills));
    app.route('/api/skills', sk);
  }

  // Secrets & env: rotate a secret, the tracker, versions, revoke (values are write-only; none is ever returned).
  if (secrets) {
    const sr = new Hono<Env>();
    sr.use(requireSession);
    sr.route('/', createSecretsAdminRoutes(() => secrets));
    app.route('/api/secrets', sr);
  }

  // The settings store: every setting, one change (audited), the audit trail and a workspace's MCP lockdown status.
  if (settings) {
    const st = new Hono<Env>();
    st.use(requireSession);
    plainNamesOn(st, '/lockdown/:target/:name');
    plainNamesOn(st, '/agent-env/:target/:name');
    st.route('/', createSettingsRoutes(settings));
    app.route('/api/settings', st);
  }

  // Personas and instruction contexts: a workspace's persona and contexts (the pools use /api/pools/persona and …/context).
  if (personas) {
    const pr = new Hono<Env>();
    pr.use(requireSession);
    plainNamesOn(pr, '/workspaces/:target/:name');
    pr.route('/', createPersonaRoutes(personas));
    app.route('/api/personas', pr);
  }

  // Knowledge: vaults of Markdown notes, search, history and the graphs (docs/prd/knowledge-graph.md).
  if (knowledge) {
    const kg = new Hono<Env>();
    kg.use(requireSession);
    kg.route('/', createKnowledgeRoutes(knowledge));
    app.route('/api/knowledge', kg);
  }

  // Portal MCP: `/mcp` takes bearer tokens, not the session cookie, and sits outside /api (whose CSRF check rejects
  // form posts); the admin's routes for its tokens, switches and audit are guarded like every other /api route.
  if (portalMcp) {
    app.route('/', createPortalMcpEndpoint(portalMcp));
    const pm = new Hono<Env>();
    pm.use(requireSession);
    plainNamesOn(pm, '/agents/:target/:name');
    pm.route('/', createPortalMcpRoutes(portalMcp, { workspaces: async () => (await workspaces.list()).map((w) => ({ id: w.id, name: w.name })) }));
    app.route('/api/portal-mcp', pm);
  }

  // Tickets: the queue of work for people and agents; agents reach it through Portal MCP tools instead.
  if (tickets) {
    const tk = new Hono<Env>();
    tk.use(requireSession);
    tk.route('/', createTicketRoutes(tickets));
    app.route('/api/tickets', tk);
  }

  // CI: a git remote on each workspace and the runs of its pipelines (docs/prd/local-git-ci.md).
  if (ci) {
    const cr = new Hono<Env>();
    cr.use(requireSession);
    cr.route('/', createCiRoutes(ci));
    app.route('/api/ci', cr);
  }

  // Workspace git: every workspace's repositories at a glance, the audit, and one repository (docs/prd/workspace-git.md).
  if (repos) {
    const rp = new Hono<Env>();
    rp.use(requireSession);
    rp.route('/', createReposRoutes(repos));
    app.route('/api/repos', rp);
  }

  // Glance widgets: one snapshot of what waits on a person and who is working (docs/prd/glance-widgets.md); read-only.
  if (glance) {
    const gl = new Hono<Env>();
    gl.use(requireSession);
    gl.route('/', createGlanceRoutes(glance));
    app.route('/api/glance', gl);
  }

  // Needs you: one list of what waits for a person (docs/prd/attention.md); read only, deciding stays on each module's own route.
  if (attention) {
    const at = new Hono<Env>();
    at.use(requireSession);
    at.route('/', createAttentionRoutes(attention));
    app.route('/api/attention', at);
  }

  // Claude Code version pinning: the registry, the compatibility canary and its schedule, images and the default pin (docs/prd/claude-version-pinning.md).
  if (claudeVersions) {
    const cv = new Hono<Env>();
    cv.use(requireSession);
    cv.route('/', createClaudeVersionRoutes(claudeVersions));
    app.route('/api/claude-version', cv);
  }

  // GitHub Codespaces POC: connections (token or device flow) and the codespace lifecycle (docs/prd/codespaces-poc.md).
  if (codespaces) {
    const cs = new Hono<Env>();
    cs.use(requireSession);
    cs.route('/', createCodespacesRoutes(codespaces));
    app.route('/api/codespaces', cs);
  }

  // Claude usage: the plan limits of each Claude, read from Claude Code itself (docs/prd/claude-usage.md).
  if (claudeUsage) {
    const cu = new Hono<Env>();
    cu.use(requireSession);
    cu.route('/', createClaudeUsageRoutes(claudeUsage));
    app.route('/api/claude-usage', cu);
  }

  // Usage spend: who spent what (per session, workspace, ticket, persona), budgets and spike alerts (docs/prd/claude-usage.md §21 to §26).
  if (usageSpend) {
    const us = new Hono<Env>();
    us.use(requireSession);
    us.route('/', createUsageSpendRoutes(usageSpend));
    app.route('/api/usage-spend', us);
  }

  // Efficiency lab: slices, the summary and experiments, read only (docs/prd/claude-usage.md §28.10; lab/authz.ts).
  if (lab) {
    const lb = new Hono<Env>();
    lb.use(requireSession);
    lb.route('/', createLabRoutes(lab));
    app.route('/api/lab', lb);
  }

  // Chat sessions (REST); the live part rides its own socket (chat/socket.ts).
  const chat = new Hono<Env>();
  chat.use(requireSession);
  chat.route('/', createChatRoutes(chatController));
  chat.route('/', createChatFileRoutes({ controller: chatController, workspaces, store }));
  app.route('/api/chat/sessions', chat);
  const claudes = new Hono<Env>();
  claudes.use(requireSession);
  claudes.route('/', createClaudeRoutes(chatController));
  const usage = new Hono<Env>();
  usage.use(requireSession);
  usage.route('/', createUsageRoutes(chatController));
  app.route('/api/chat/usage', usage);
  app.route('/api/chat/claudes', claudes);
  const trust = new Hono<Env>();
  trust.use(requireSession);
  trust.route('/', createChatTrustRoutes({ controller: chatController, workspaces, store }));
  app.route('/api/chat/trust', trust);
  // The server code checked again (guards Bypass in chat), the chat policy and its audit trail.
  const chatReauth = new Reauth(portal);
  chatController.reauth = chatReauth;
  const chatMeta = new Hono<Env>();
  chatMeta.use(requireSession);
  chatMeta.route('/', createChatMetaRoutes(chatController, chatReauth));
  app.route('/api/chat', chatMeta);
  // The platform track (docs/prd/platform-roadmap.md): each module's routes behind the session guard; `/hooks` outside `/api` and the
  // guard (a receiver is its own door: a signed secret), before the web app's catch-all.
  if (platform) {
    platform.useReauth((token) => chatReauth.fresh(token));
    for (const r of platform.routes()) {
      const pr = new Hono<Env>();
      pr.use(requireSession);
      pr.route('/', r.app);
      app.route(r.path, pr);
    }
    app.route('/hooks', platform.hooks);
  }

  // Connect (docs/prd/targets-connect.md): the admin REST is guarded like every /api route; the agent-facing routes live under /connect/ with
  // no cookie and none of /api's Origin machinery (an enrollment token or a signed challenge is their door), full paths, so mounted at the root.
  if (connect) {
    const cn = new Hono<Env>();
    cn.use(requireSession);
    cn.route('/', connect.routes() as never);
    app.route('/api/connect', cn);
    app.route('/', connect.publicRoutes() as never);
  }

  app.all('/api/*', () => {
    throw new AppError('NOT_FOUND');
  });

  if (serveWeb) {
    // serveStatic resolves `root` from the working directory.
    const root = relative(process.cwd(), config.paths.webDist) || '.';
    app.use('/assets/*', async (c, next) => {
      await next();
      // Only a file that exists is immutable: a miss must never be kept for a year as if it were that file.
      if (c.res.status === 200) c.header('Cache-Control', 'public, max-age=31536000, immutable');
    });
    // The worker and the manifest must always be re-checked, or an update can take days to reach installed copies.
    app.use('/sw.js', async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-cache');
    });
    app.use('/manifest.webmanifest', async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-cache');
    });
    app.use('*', serveStatic({ root }));
    // A missing file is a 404, not the app shell: the shell served for a missing script fails with a MIME error and blanks the
    // page of a tab that stayed open across a deploy (the hashed chunks it still asks for are gone). Client-side routes
    // never carry a file extension.
    app.get('*', async (c, next) => {
      if (!/^\/assets\/|\.(?:m?js|css|map|json|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|txt|xml|webmanifest|wasm)$/i.test(c.req.path)) return next();
      c.header('Cache-Control', 'no-store');
      return c.text('Not found', 404);
    });
    // Client-side routes: every other path gets the app shell.
    app.get('*', serveStatic({ root, path: 'index.html' }));
  }

  return app;
}
