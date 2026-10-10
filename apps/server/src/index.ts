import { existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { formatCode, type LiveTopic } from '@portal/contracts';
import { AccountHealthService } from './accounts/health.js';
import { AccountPools } from './accounts/pools.js';
import { AccountsService } from './accounts/service.js';
import { Outbox } from './delivery/outbox.js';
import { LiveHub } from './live.js';
import { workspaceView } from './workspaces/view.js';
import { Reconciler } from './delivery/reconciler.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { JsonFile } from './jsonFile.js';
import { Portal } from './portal.js';
import { acquireLock } from './store/lock.js';
import { loadSecretKey, SecretKeyError } from './store/secretBox.js';
import { sessionStore } from './store/sessions.js';
import { Store } from './store/store.js';
import { DockerRuntime } from './workspaces/docker.js';
import { attachShell, cookie } from './workspaces/shell.js';
import { ChatController } from './chat/controller.js';
import { hostInstaller } from './chat/install.js';
import { attachChat } from './chat/socket.js';
import { KubernetesRuntime } from './workspaces/kubernetes.js';
import { Workspaces } from './workspaces/manager.js';
import type { Runtime } from './workspaces/runtime.js';

// One portal per data dir: the database has a single writer.
await acquireLock(config.paths.data).catch((e: unknown) => {
  console.error(`portal: ${(e as Error).message}`);
  process.exit(1);
});

let secretKey: Buffer | null = null;
let keyError: string | undefined;
// A key file that doesn't exist yet (or is empty) just means "no key yet": the panel can set one up.
const keyFileEmpty = !!config.secretKey.file && !config.secretKey.value && (!existsSync(config.secretKey.file) || statSync(config.secretKey.file).size === 0);
try {
  secretKey = keyFileEmpty ? null : loadSecretKey(config.secretKey);
} catch (e) {
  if (!(e instanceof SecretKeyError)) throw e;
  keyError = e.message;
}
const store = await Store.open({
  dataDir: config.paths.data,
  secretKey,
  keyError,
  keySource: config.secretKey.value ? 'env' : config.secretKey.file ? 'file' : null,
});
const { trust } = store;
console.log(
  trust.state === 'ok'
    ? `[store] ready (portal ${store.portalId?.slice(0, 8)}, schema ${store.schemaVersion})`
    : `[store] ${trust.state.toUpperCase()}: ${trust.reasons.map((r) => r.message).join(' ')}`,
);
const dailyBackup = () =>
  void store.backupIfDue().then(
    (file) => file && console.log(`[store] daily backup ${file}`),
    (e: unknown) => console.error(`[store] daily backup failed: ${(e as Error).message}`),
  );
dailyBackup();
const backupTimer = setInterval(dailyBackup, 60 * 60 * 1000);
backupTimer.unref();

const portal = new Portal(config.serverCode, config.session.ttlMs);
// Sign-ins survive restarts (12 hours each); only token hashes are stored.
portal.useStore(sessionStore(store));
const { workspaces: ws } = config;
const runtimes: Runtime[] = ws.docker.map((d) => new DockerRuntime(d, ws.dockerImage, ws.imageContext));
if (ws.kubernetes.enabled) {
  try {
    runtimes.push(new KubernetesRuntime(ws.kubernetes));
  } catch (e) {
    console.error(`[workspaces] kubernetes target off: ${(e as Error).message}`);
  }
}
const workspaces = new Workspaces(runtimes, new JsonFile(`${config.paths.data}/pending-creates.json`, []));
void workspaces.resume().catch((e: unknown) => console.error(`[workspaces] resume failed: ${(e as Error).message}`));

// Chat sessions: one controller shared by the REST routes and the chat socket.
const chatController = new ChatController(store, workspaces);
chatController.installHost = hostInstaller(workspaces);

const accounts = new AccountsService(store);
const pools = new AccountPools(store);
const health = new AccountHealthService(store);
accounts.hooks = {
  changed: (id, why) => pools.accountChanged(id, why),
  checked: (id, result, manual) => health.fromCheck(id, result, manual),
  poolsWith: (id) => pools.poolsWith(id),
};
const reconciler = new Reconciler(store, (t) => workspaces.runtimeFor(t), () => workspaces.runtimeList(), [pools]);
pools.reconciler = reconciler;
health.onChange = (id, why, opts) => pools.accountChanged(id, why, opts);
health.check = async (id) => void (await accounts.check(id, { manual: false }));
health.activeAccount = (workspaceId) => pools.activeAccount(workspaceId);
health.onUnconfirmed = (ids) => ids.forEach((id) => void reconciler.request(id, 'unconfirmed signal'));
// Failure signals from assigned workspaces: helper runs and StopFailure (Account Pool §11.5).
const outbox = new Outbox(store, (t) => workspaces.runtimeFor(t));
outbox.subscribe('account', (workspaceId, events) => health.onSignals(workspaceId, events), () => pools.assignedWorkspaces());
workspaces.hooks.beforeStop = (id) => outbox.pull(id);
reconciler.start();
outbox.start();
health.start();
// Live pages (`/api/live`): one socket per tab, fed by every place that changes what they show.
const view = workspaceView(pools, reconciler);
const live = new LiveHub(
  { workspaces: async () => (await workspaces.list()).map(view), usage: () => workspaces.usage() },
  (req) => !!portal.session(cookie(req, config.session.cookie)),
);
const notify = (...topics: LiveTopic[]) => topics.forEach((t) => live.publish(t));
workspaces.hooks.changed = () => notify('workspaces');
reconciler.onChange(() => notify('workspaces'));
accounts.hooks.event = () => notify('accounts');
health.onEvent = () => notify('accounts');
pools.onChange = () => notify('accounts', 'workspaces');
const stopWatching = runtimes.flatMap((r) => (r.watch ? [r.watch(() => notify('workspaces'))] : []));
const app = createApp(portal, workspaces, store, accounts, pools, reconciler, health, chatController, { serveWeb: !config.dev, notify });
const handleApi = getRequestListener(app.fetch);
const server = createServer();
attachShell(server, portal, workspaces);
live.attach(server);
attachChat(server, chatController, (req) => !!portal.session(cookie(req, config.session.cookie)));

if (config.dev) {
  // One port for everything: the API through Hono, the rest through Vite (with HMR on this server).
  const { createServer: createVite } = await import('vite');
  const vite = await createVite({
    root: config.paths.web,
    configFile: `${config.paths.web}/vite.config.ts`,
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  server.on('request', (req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/api/') || url === '/healthz') void handleApi(req, res);
    else vite.middlewares(req, res);
  });
} else {
  server.on('request', (req, res) => void handleApi(req, res));
}

server.listen(config.port, config.host, () => {
  const where = `http://localhost:${config.port}`;
  const code =
    portal.source === 'env' ? '(from PORTAL_SERVER_CODE)' : formatCode(portal.code);
  console.log(
    [
      '',
      `  portal ${config.dev ? 'dev' : 'production'} server on ${where}`,
      `  server code: ${code}`,
      '',
    ]
      .filter((line, i, all) => line || i === 0 || i === all.length - 1)
      .join('\n'),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.close();
    clearInterval(backupTimer);
    reconciler.stop();
    outbox.stop();
    health.stop();
    live.close();
    for (const stop of stopWatching) stop();
    store.close();
    process.exit(0); // releases the data-dir lock
  });
