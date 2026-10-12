// T-SEC, the log canary run (docs/prd/targets-connect.md FR30, §17.3): every service runs with canary values, at debug level, and none of them may
// appear anywhere the agent writes: its log lines, and the `log` messages it sends to the portal's audit. The canaries are what must never be
// logged: the enrollment token, the node's private key, the extra request headers (an Access service token), a command line and its environment
// and its stdin, a file name from a `put` and its content, the Kubernetes bearers (the portal's and the service account's), a Docker exec's
// command and archive.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import net, { type AddressInfo } from 'node:net';
import { pack } from 'tar-stream';
import { runAgent, type AgentHandle } from './client.js';
import { collectingLogger } from './log.js';
import { agentConfig } from './testkit/agentConfig.js';
import { FakeDocker } from './testkit/fakeDocker.js';
import { FakeKube } from './testkit/fakeKube.js';
import { openPortal, type Portal } from './testkit/portalRig.js';
import { parseResult, RECORD, RecordParser, encodeRecord } from '../tunnel/records.js';

const C = {
  header: 'canary-header-secret-5f3a',
  argv: 'canary-argv-9c1d',
  env: 'canary-env-value-7e22',
  stdin: 'canary-stdin-4b8a',
  file: 'canary-file-name-3d6f',
  content: 'canary-content-8a90',
  sa: 'canary-sa-token-1c7e',
  dockerCmd: 'canary-docker-cmd-62ab',
  dockerArchive: 'canary-docker-archive-0f4c',
};

let portal: Portal;
let dir: string;
before(async () => {
  portal = await openPortal();
  dir = mkdtempSync(join(tmpdir(), 'cx2-canary-'));
  mkdirSync(join(dir, 'home'));
});
after(async () => {
  await portal.close();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (fn: () => boolean, ms = 10_000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Everything the agent said: its log, and the log messages the portal received. */
const everythingSaid = (log: ReturnType<typeof collectingLogger>, targetId: string) => `${log.text()}\n${JSON.stringify(portal.events(targetId).filter((e) => e.type === 'agent.log'))}`;

const mustNotAppear = (said: string, canaries: string[], where: string) => {
  for (const canary of canaries) assert.equal(said.includes(canary), false, `${where}: the log contains ${canary}`);
};

describe('what the agent never logs', () => {
  it('host service: a command, its environment and stdin, a file name and its content, the headers, the token and the key', async () => {
    const t = portal.target({ id: 'can-host' });
    const log = collectingLogger();
    const config = agentConfig({ dataDir: join(dir, 'host-agent'), home: join(dir, 'home'), url: portal.origin, enrollToken: t.token, headers: { 'CF-Access-Client-Secret': C.header } });
    const h: AgentHandle = runAgent({ config, log: log.logger, build: 'abababababab' });
    try {
      await h.whenConnected();
      const id = h.identity()!;
      const link = portal.hub.hub.link({ id: id.node, targetId: 'can-host' });

      const exec = await link.open('host', { op: 'exec', argv: ['sh', '-c', `cat; echo ${C.argv}`], env: { CANARY: C.env }, cwd: `/home/node/${C.file}-dir` });
      const parser = new RecordParser();
      let result: unknown = null;
      exec.on('data', (c: Buffer) => parser.push(c).forEach((r) => r.kind === RECORD.result && (result = parseResult(r.payload))));
      exec.write(encodeRecord(RECORD.data, C.stdin));
      exec.write(encodeRecord(RECORD.eof));
      await until(() => result !== null);
      exec.end();

      const archive = pack();
      archive.entry({ name: `home/node/${C.file}.txt`, type: 'file', mode: 0o600 }, C.content);
      archive.finalize();
      const put = await link.open('host', { op: 'put' });
      let putResult: unknown = null;
      const pparser = new RecordParser();
      put.on('data', (c: Buffer) => pparser.push(c).forEach((r) => r.kind === RECORD.result && (putResult = parseResult(r.payload))));
      for await (const chunk of archive) put.write(encodeRecord(RECORD.data, chunk as Buffer));
      put.write(encodeRecord(RECORD.eof));
      await until(() => putResult !== null);
      put.end();

      for (const op of [
        { op: 'read' as const, path: `/home/node/${C.file}.txt` },
        { op: 'read' as const, path: `/home/node/${C.file}-missing` },
        { op: 'exec' as const, argv: [`/nonexistent/${C.argv}`] },
      ]) {
        const s = await link.open('host', op);
        let r: unknown = null;
        const p = new RecordParser();
        s.on('data', (c: Buffer) => p.push(c).forEach((x) => x.kind === RECORD.result && (r = x)));
        await until(() => r !== null);
        s.end();
      }
      assert.ok(log.lines.length > 5, 'it did log');
      await new Promise((r) => setTimeout(r, 300));
      mustNotAppear(everythingSaid(log, 'can-host'), [C.argv, C.env, C.stdin, C.file, C.content, C.header, t.token, id.privateKey, readFileSync(join(config.dataDir, 'identity.json'), 'utf8').match(/"privateKey": "([^"]+)"/)![1]!], 'host');
    } finally {
      await h.stop();
    }
  });

  it('docker service: an exec’s command and environment, an archive, the headers, and the refusals’ details', async () => {
    const fake = await FakeDocker.start();
    const t = portal.target({ id: 'can-dock', kind: 'docker', options: {} });
    const log = collectingLogger();
    const config = agentConfig({ mode: 'docker', dataDir: join(dir, 'dock-agent'), url: portal.origin, enrollToken: t.token, dockerSocket: fake.socketPath, images: ['claudepilot-workspace:latest'], headers: { 'CF-Access-Client-Secret': C.header } });
    const h = runAgent({ config, log: log.logger, build: 'abababababab' });
    try {
      await h.whenConnected();
      const link = portal.hub.hub.link({ id: h.identity()!.node, targetId: 'can-dock' });
      const portalId = portal.core.store.portalId!;
      fake.addContainer({ name: 'claudepilot-cn', labels: { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'cn', 'claudepilot.portal': portalId } });
      const agent = new (class extends http.Agent {
        override createConnection(_o: http.ClientRequestArgs, cb?: (err: Error | null, s: never) => void) {
          link.open('docker').then((s) => cb?.(null, s as never), (e: Error) => cb?.(e, undefined as never));
          return undefined;
        }
      })({ keepAlive: true });
      const call = (method: string, path: string, body?: unknown) =>
        new Promise<number>((resolve, reject) => {
          const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
          const req = http.request({ host: 'x.invalid', port: 1, method, path, agent, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          });
          req.on('error', reject);
          req.end(payload);
        });
      assert.equal(await call('POST', '/containers/claudepilot-cn/exec', { Cmd: ['sh', '-c', C.dockerCmd], Env: [`SECRET=${C.env}`], AttachStdout: true }), 201);
      assert.equal(await call('PUT', '/containers/claudepilot-cn/archive?path=%2F', C.dockerArchive), 200);
      // refusals: the details of the request are in the response to the caller, not in the agent's log
      assert.equal(await call('POST', '/containers/create?name=claudepilot-cn2', { Image: 'claudepilot-workspace:latest', Env: [`SECRET=${C.env}`], HostConfig: { Binds: [`/${C.file}:/x`] } }), 403);
      assert.equal(await call('POST', `/containers/${C.file}/exec`, { Cmd: [C.dockerCmd] }), 404);
      agent.destroy();
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(log.text().includes('policy.denied'), 'the refusal was logged by its rule');
      mustNotAppear(everythingSaid(log, 'can-dock'), [C.dockerCmd, C.env, C.dockerArchive, C.file, C.header, t.token], 'docker');
    } finally {
      await h.stop();
      await fake.stop();
    }
  });

  it('kubernetes service: the portal’s bearer, the service account’s token, an exec’s command, an object’s body', async () => {
    const fake = await FakeKube.start({ token: C.sa });
    const tokenFile = join(dir, 'sa-token');
    writeFileSync(tokenFile, `${C.sa}\n`);
    const t = portal.target({ id: 'can-kube', kind: 'kubernetes', options: { namespace: fake.namespace } });
    const log = collectingLogger();
    const config = agentConfig({ mode: 'kubernetes', dataDir: join(dir, 'kube-agent'), url: portal.origin, enrollToken: t.token, kubeNamespace: fake.namespace, identitySecret: 'claudepilot-agent-identity', headers: { 'CF-Access-Client-Secret': C.header } });
    const h = runAgent({ config, log: log.logger, build: 'abababababab', serviceDeps: { kube: { server: fake.url, tokenFile, caFile: null } } });
    try {
      await h.whenConnected();
      const link = portal.hub.hub.link({ id: h.identity()!.node, targetId: 'can-kube' });
      await until(() => link.kubeToken() !== null);
      const bearer = link.kubeToken()!;
      const listener = net.createServer((socket) => {
        link.open('kube').then((s) => {
          socket.pipe(s);
          s.pipe(socket);
          socket.on('close', () => s.destroy());
          s.on('close', () => socket.destroy());
          socket.on('error', () => s.destroy());
        });
      });
      await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
      const port = (listener.address() as AddressInfo).port;
      const call = (method: string, path: string, body?: unknown, bearerToken = bearer) =>
        new Promise<number>((resolve, reject) => {
          const payload = body === undefined ? undefined : JSON.stringify(body);
          const req = http.request({ host: '127.0.0.1', port, method, path, agent: false, headers: { Authorization: `Bearer ${bearerToken}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          });
          req.on('error', reject);
          req.end(payload);
        });
      const base = `/api/v1/namespaces/${fake.namespace}`;
      assert.equal(await call('GET', `${base}/pods`), 200);
      assert.equal(await call('POST', `/apis/apps/v1/namespaces/${fake.namespace}/deployments`, { metadata: { name: 'ws-can', labels: { note: C.content } }, spec: { replicas: 1, template: { metadata: { labels: { 'claudepilot.managed': 'true' } } } } }), 201);
      assert.equal(await call('GET', `${base}/pods`, undefined, 'a-wrong-bearer'), 401);
      assert.equal(await call('GET', `${base}/secrets/${C.file}`), 403);
      assert.equal(await call('GET', `/api/v1/namespaces/other-ns-${C.file}/pods`), 403);
      listener.close();
      await new Promise((r) => setTimeout(r, 300));
      mustNotAppear(everythingSaid(log, 'can-kube'), [C.sa, bearer, 'a-wrong-bearer', C.content, C.file, C.header, t.token, h.identity()!.privateKey], 'kubernetes');
    } finally {
      await h.stop();
      await fake.stop();
    }
  });
});
