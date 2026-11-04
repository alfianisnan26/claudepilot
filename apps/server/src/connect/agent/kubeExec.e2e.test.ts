// Exec streams through the REAL agent's kube proxy and the portal's enrolled-cluster runtime (ConnectKubeRuntime over the real hub link), to
// the fake API server (no cluster). docs/prd/cf-bridge.md:
//   G7 (PILOT-1160): a chat upload is base64 on exec stdin up to CHAT_MAX_UPLOAD_BYTES (25 MB) and must arrive whole and in order; the
//       cp-session tail is a long-lived exec and must not be cut by the proxy's idle timeout (60 s; 150 ms here, through `idleMs`).
//   G5 (PILOT-1158): an app-port dial on an enrolled cluster runs the real bridge (`node -e BRIDGE <port>`) in the "pod" and reaches the app.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CHAT_MAX_UPLOAD_BYTES } from '@portal/contracts';
import { bridgeCommand, createDialer } from '../../appports/dial.js';
import { ConnectKubeRuntime } from '../../workspaces/connect/kube.js';
import { memoryDeps, targetRecord } from '../../workspaces/connect/testkit.js';
import type { ExecSession } from '../../workspaces/runtime.js';
import { runAgent, type AgentHandle } from './client.js';
import { collectingLogger } from './log.js';
import { agentConfig } from './testkit/agentConfig.js';
import { FakeKube } from './testkit/fakeKube.js';
import { openPortal, stopAgents, type Portal } from './testkit/portalRig.js';

const IDLE_MS = 150;
const TARGET = 'kx-kube';
let portal: Portal;
let fake: FakeKube;
let dir: string;
let rt: ConnectKubeRuntime;
const agents: AgentHandle[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  portal = await openPortal();
  fake = await FakeKube.start();
  dir = mkdtempSync(join(tmpdir(), 'kx-agent-'));
  mkdirSync(join(dir, 'home'));
  const tokenFile = join(dir, 'sa-token');
  writeFileSync(tokenFile, `${fake.token}\n`);
  const t = portal.target({ id: TARGET, kind: 'kubernetes', options: { namespace: fake.namespace } });
  const h = runAgent({
    config: agentConfig({ home: join(dir, 'home'), url: portal.origin, mode: 'kubernetes', dataDir: join(dir, 'agent'), enrollToken: t.token, kubeNamespace: fake.namespace, identitySecret: 'claudepilot-agent-identity' }),
    log: collectingLogger().logger,
    build: 'ffffffffffff',
    serviceDeps: { kube: { server: fake.url, tokenFile, caFile: null, idleMs: IDLE_MS } },
  });
  agents.push(h);
  await h.whenConnected();
  const node = h.identity()!.node;
  const link = portal.hub.hub.link({ id: node, targetId: TARGET });
  rt = new ConnectKubeRuntime(
    targetRecord({ id: TARGET, kind: 'kubernetes', settings: { namespace: fake.namespace } }),
    { record: { id: node, targetId: TARGET, name: 'k', drained: false, keyFingerprint: 'x' }, link },
    memoryDeps(),
  );
  for (let i = 0; !link.kubeToken(); i++) {
    if (i > 400) throw new Error('no kube token from the agent');
    await sleep(25);
  }
  await rt.create({ name: 'kw' }, () => undefined);
});
after(async () => {
  rt?.dispose();
  await stopAgents(agents);
  await fake?.stop();
  await portal?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Collects an exec's output and its exit. */
function watch(s: ExecSession) {
  const w = { out: Buffer.alloc(0), code: undefined as number | null | undefined, ended: false };
  s.onData((d) => (w.out = Buffer.concat([w.out, d])));
  s.onExit((c) => ((w.code = c), (w.ended = true)));
  return w;
}
const until = async (fn: () => boolean, ms: number, what: string) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
};

describe('G7: long and large execs through the agent kube proxy', () => {
  it(`a stdin of CHAT_MAX_UPLOAD_BYTES (${CHAT_MAX_UPLOAD_BYTES} bytes) arrives whole and in order`, { timeout: 120_000 }, async () => {
    const want = createHash('sha256');
    const got = createHash('sha256');
    let received = 0;
    let chunks = 0;
    fake.onExec = (io) => {
      assert.deepEqual(io.command, ['sh', '-c', 'cat > /tmp/upload']);
      io.onStdin((d) => {
        got.update(d);
        received += d.length;
        chunks++;
        if (received >= CHAT_MAX_UPLOAD_BYTES) {
          io.stdout(`${received} ${got.copy().digest('hex')}`);
          io.exit(0);
        }
      });
    };
    const s = await rt.exec('kw', ['sh', '-c', 'cat > /tmp/upload']);
    const w = watch(s);
    // Distinct bytes per chunk (a counter in each), so a reordered or repeated chunk changes the digest.
    const CHUNK = 64 * 1024;
    for (let at = 0, n = 0; at < CHAT_MAX_UPLOAD_BYTES; at += CHUNK, n++) {
      const c = randomBytes(Math.min(CHUNK, CHAT_MAX_UPLOAD_BYTES - at));
      c.writeUInt32BE(n, 0);
      want.update(c);
      s.write(c);
    }
    await until(() => w.ended, 110_000, 'the upload exec to end');
    assert.equal(w.code, 0);
    assert.equal(w.out.toString(), `${CHAT_MAX_UPLOAD_BYTES} ${want.digest('hex')}`);
    assert.ok(chunks > 1, 'it came in pieces');
  });

  it(`an exec held open well past the proxy's idle timeout (${IDLE_MS} ms) is not cut, quiet or talking`, { timeout: 30_000 }, async () => {
    fake.onExec = (io) =>
      io.onStdin((d) => {
        const text = d.toString();
        if (text.includes('ping')) io.stdout(`pong ${text.trim()}\n`);
        if (text.includes('exit')) io.exit(0);
      });
    const s = await rt.exec('kw', ['cp-session', 'tail']);
    const w = watch(s);
    // Quiet both ways for 10 idle periods: the tail of an idle chat.
    await sleep(IDLE_MS * 10);
    assert.equal(w.ended, false, 'still open after a quiet spell');
    s.write('ping 1\n');
    await until(() => w.out.toString().includes('pong ping 1'), 5000, 'the first answer');
    // Again quiet, then output only (the tail prints, the portal writes nothing).
    await sleep(IDLE_MS * 10);
    assert.equal(w.ended, false, 'still open after a second quiet spell');
    s.write('ping 2\n');
    await until(() => w.out.toString().includes('pong ping 2'), 5000, 'the second answer');
    s.write('exit\n');
    await until(() => w.ended, 5000, 'the exit');
    assert.equal(w.code, 0);
  });

  it('after the quiet spells (idle kube streams ended by the proxy), the next API call still works', async () => {
    await sleep(IDLE_MS * 4);
    const list = await rt.list();
    assert.deepEqual(list.map((x) => x.name), ['kw']);
  });
});

describe('G5: an app-port dial on an enrolled cluster', () => {
  it('runs the real bridge in the pod and reaches the app on 127.0.0.1:<port>', { timeout: 30_000 }, async () => {
    const app = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => res.end(`app saw ${req.method} ${req.url} ${body}`));
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    const port = (app.address() as AddressInfo).port;
    const seen: string[][] = [];
    // The "pod": each exec runs its command here, as a container would. Only the bridge is expected.
    fake.onExec = (io) => {
      seen.push(io.command);
      const [cmd, ...args] = io.command;
      const child = spawn(cmd === 'node' ? process.execPath : cmd!, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => undefined);
      io.onStdin((d) => void child.stdin.write(d));
      child.stdout.on('data', (d: Buffer) => io.stdout(d));
      child.on('close', (code) => io.exit(code ?? 1));
    };
    try {
      assert.equal(rt.target.source, 'enrolled');
      const dial = createDialer({ runtimeFor: (t) => (t === TARGET ? rt : undefined), exec: (_t, name, command) => rt.exec(name, command) });
      const socket = await dial(`${TARGET}/kw`, port);
      const answer = await new Promise<string>((resolve, reject) => {
        const req = http.request({ method: 'POST', path: '/hello?x=1', headers: { host: `127.0.0.1:${port}`, connection: 'close' }, createConnection: () => socket as never }, (res) => {
          let text = '';
          res.on('data', (c: Buffer) => (text += c.toString()));
          res.on('end', () => resolve(`${res.statusCode} ${text}`));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end('through the bridge');
      });
      assert.equal(answer, '200 app saw POST /hello?x=1 through the bridge');
      assert.deepEqual(seen, [bridgeCommand(port)]);
      // The API server saw only the exec of the workspace container, carrying the bridge's argv.
      const last = new URL(fake.upgrades.at(-1)!.url, 'http://x');
      assert.equal(last.searchParams.get('container'), 'workspace');
      assert.deepEqual(last.searchParams.getAll('command'), bridgeCommand(port));
    } finally {
      app.close();
    }
  });
});
