// Test rig for the Kubernetes proxy: a FakeKube, the agent's kube service in front of it (its server URL, token file and CA injected, so
// nothing can reach a real cluster), and a loopback listener like the portal's (T3's `kubeLoopback`): 127.0.0.1 only, one stream per
// accepted connection, a bearer only the portal knows. A `KubeConfig` pointed at the listener is what `KubernetesRuntime` is given.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KubeConfig } from '@kubernetes/client-node';
import { createService, type KubeService, type KubeServiceOptions } from '../services/kube/index.js';
import { collectingLogger } from '../log.js';
import { FakeKube } from './fakeKube.js';
import { streamPair } from './streams.js';

export const NAMESPACE = 'claudepilot-workspaces';
/** The portal's per-connection bearer for this rig: made fresh, so no token-shaped text is in the source. */
export const LOCAL_TOKEN = `local-${randomBytes(8).toString('hex')}`;

export interface KubeRig {
  fake: FakeKube;
  service: KubeService;
  log: ReturnType<typeof collectingLogger>;
  dir: string;
  tokenFile: string;
  /** `http://127.0.0.1:<port>`: the loopback listener. */
  loopback: string;
  /** What the portal's client library is given. */
  kubeConfig: KubeConfig;
  setLocalToken(token: string | null): void;
  /** One request to the loopback; `bearer` defaults to the right local one. */
  request(method: string, path: string, opts?: { body?: unknown; rawBody?: string | Buffer; headers?: Record<string, string>; bearer?: string | null }): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: () => any }>;
  raw(bytes: string | Buffer, opts?: { quietMs?: number }): Promise<string>;
  stop(): Promise<void>;
}

export async function startKubeRig(opts: { namespace?: string; service?: Partial<KubeServiceOptions> } = {}): Promise<KubeRig> {
  const namespace = opts.namespace ?? NAMESPACE;
  const fake = await FakeKube.start({ namespace });
  const dir = mkdtempSync(join(tmpdir(), 'cx2-kube-'));
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, `${fake.token}\n`);
  let local: string | null = LOCAL_TOKEN;
  const log = collectingLogger();
  const service = createService({ server: fake.url, tokenFile, caFile: null, namespace, localToken: () => local, log: log.logger, ...opts.service });
  await service.refresh!();

  // The portal's loopback listener: every accepted connection is one `kube` stream.
  const listener = net.createServer((socket) => {
    const [portal, agent] = streamPair();
    service.handle(agent, 'abcd1234');
    socket.pipe(portal);
    portal.pipe(socket);
    socket.on('error', () => portal.destroy());
    portal.on('error', () => socket.destroy());
    socket.on('close', () => portal.destroy());
    portal.on('close', () => socket.destroy());
  });
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
  const loopback = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromOptions({
    clusters: [{ name: 'tunnel', server: loopback, skipTLSVerify: true }],
    users: [{ name: 'portal', token: LOCAL_TOKEN }],
    contexts: [{ name: 'tunnel', cluster: 'tunnel', user: 'portal', namespace }],
    currentContext: 'tunnel',
  });

  const request: KubeRig['request'] = (method, path, o = {}) =>
    new Promise((resolve, reject) => {
      const payload = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
      const headers: Record<string, string | number> = { ...(o.headers ?? {}) };
      if (o.bearer !== null) headers.Authorization = `Bearer ${o.bearer ?? LOCAL_TOKEN}`;
      if (payload !== undefined) {
        headers['Content-Length'] = Buffer.byteLength(payload);
        headers['Content-Type'] ??= 'application/json';
      }
      const req = http.request({ host: '127.0.0.1', port: (listener.address() as AddressInfo).port, method, path, headers, agent: false }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });

  const raw: KubeRig['raw'] = (bytes, o = {}) =>
    new Promise((resolve) => {
      const s = net.connect((listener.address() as AddressInfo).port, '127.0.0.1');
      const parts: Buffer[] = [];
      let timer = setTimeout(() => s.destroy(), 3000);
      const quiet = o.quietMs ?? 250;
      s.on('data', (c: Buffer) => {
        parts.push(c);
        clearTimeout(timer);
        timer = setTimeout(() => s.destroy(), quiet);
      });
      s.on('close', () => resolve(Buffer.concat(parts).toString('latin1')));
      s.on('error', () => undefined);
      timer = setTimeout(() => s.destroy(), quiet * 2);
      s.write(bytes);
    });

  return {
    fake,
    service,
    log,
    dir,
    tokenFile,
    loopback,
    kubeConfig,
    setLocalToken: (t) => void (local = t),
    request,
    raw,
    async stop() {
      service.close();
      await new Promise<void>((r) => listener.close(() => r()));
      await fake.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
