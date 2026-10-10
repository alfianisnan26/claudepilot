import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { formatCode } from '@portal/contracts';
import { createApp } from './app.js';
import { config } from './config.js';
import { JsonFile } from './jsonFile.js';
import { Portal } from './portal.js';
import { DockerRuntime } from './workspaces/docker.js';
import { KubernetesRuntime } from './workspaces/kubernetes.js';
import { Workspaces } from './workspaces/manager.js';
import type { Runtime } from './workspaces/runtime.js';
import { attachShell } from './workspaces/shell.js';

const portal = new Portal(config.serverCode, config.session.ttlMs);
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

const app = createApp(portal, workspaces, { serveWeb: !config.dev });
const handleApi = getRequestListener(app.fetch);
const server = createServer();
attachShell(server, portal, workspaces);

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
    process.exit(0);
  });
