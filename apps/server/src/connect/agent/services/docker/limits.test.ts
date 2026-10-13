// T-POL / T-PERF (docs/prd/targets-connect.md §11.4, §19.6): what the proxy does with big and slow things. An archive streams in and out and is never
// buffered (a 100 MB upload costs a few MB, in both directions of one process); a client that stops reading holds the daemon back instead of the
// agent's memory; a stream with no request in flight is closed after the idle time.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { startDockerRig, PORTAL_ID, type DockerRig } from '../../testkit/dockerRig.js';
import { streamPair } from '../../testkit/streams.js';
import { withTimeout } from '../../../testkit.js';

let rig: DockerRig;
before(async () => {
  rig = await startDockerRig({ service: { idleMs: 200 } });
  rig.fake.addContainer({ name: 'claudepilot-big', labels: { 'claudepilot.managed': 'true', 'claudepilot.workspace': 'big', 'claudepilot.portal': PORTAL_ID } });
  const c = [...rig.fake.containers.values()].find((x) => x.name === 'claudepilot-big')!;
  c.files.set('/big.bin', { content: Buffer.alloc(0), mode: 0o644, uid: 0, gid: 0, virtual: 40 * 1024 * 1024 });
});
after(() => rig.stop());

describe('archives stream, in both directions', () => {
  it('takes a 100 MB upload without holding it: a few MB of growth, and the daemon got every byte', async () => {
    const total = 100 * 1024 * 1024;
    const baseline = process.memoryUsage().rss;
    let peak = 0;
    const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss - baseline)), 25);
    const done = new Promise<number>((resolve, reject) => {
      const req = http.request({ host: 'tunnel.invalid', port: 2375, method: 'PUT', path: '/containers/claudepilot-big/archive?path=%2F', agent: rig.agent, headers: { 'Content-Type': 'application/x-tar', 'Content-Length': total } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      void (async () => {
        const chunk = Buffer.alloc(256 * 1024, 7);
        for (let sent = 0; sent < total; sent += chunk.length) if (!req.write(chunk)) await new Promise<void>((r) => req.once('drain', () => r()));
        req.end();
      })();
    });
    assert.equal(await done, 200);
    clearInterval(sampler);
    const put = rig.fake.requests.filter((r) => r.method === 'PUT').at(-1)!;
    assert.equal(put.bodyBytes, total, 'the daemon received the whole archive');
    assert.ok(peak < 50 * 1024 * 1024, `rss grew by ${(peak / 1048576).toFixed(1)} MB for a 100 MB upload (client, proxy and daemon in one process)`);
  });

  it('a reader that stops reading holds the download back: the proxy buffers a little, not the file', async () => {
    const [portal, agent] = streamPair();
    rig.service.handle(agent as never, 'slow0001');
    portal.write('GET /containers/claudepilot-big/archive?path=%2Fbig.bin HTTP/1.1\r\nHost: x\r\n\r\n');
    portal.pause();
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(portal.readableLength < 2 * 1024 * 1024, `the proxy had pushed ${portal.readableLength} bytes at a reader that wasn't reading`);
    let got = 0;
    portal.on('data', (c: Buffer) => (got += c.length));
    portal.resume();
    const start = Date.now();
    while (got < 40 * 1024 * 1024 && Date.now() - start < 20_000) await new Promise((r) => setTimeout(r, 25));
    assert.ok(got >= 40 * 1024 * 1024, `the download completed once it was read: ${got} bytes`);
    portal.destroy();
  });
});

describe('idle streams', () => {
  it('closes a stream with no request in flight after the idle time, and a kept-alive one after its last request', async () => {
    const [portal, agent] = streamPair();
    rig.service.handle(agent as never, 'idle0001');
    const ended = new Promise<number>((resolve) => {
      const t0 = Date.now();
      portal.on('end', () => resolve(Date.now() - t0));
      portal.on('error', () => undefined);
      portal.resume(); // 'end' is only emitted for a stream that is being read
    });
    const after = await withTimeout(ended, 'the idle stream to end');
    assert.ok(after >= 150 && after < 2000, `closed after ${after} ms`);

    const [p2, a2] = streamPair();
    rig.service.handle(a2 as never, 'idle0002');
    p2.write('GET /_ping HTTP/1.1\r\nHost: x\r\n\r\n');
    const text: Buffer[] = [];
    p2.on('data', (c: Buffer) => text.push(c));
    const t1 = Date.now();
    await withTimeout(new Promise<void>((resolve) => p2.on('end', () => resolve())), 'the kept-alive stream to end');
    assert.match(Buffer.concat(text).toString(), /^HTTP\/1\.1 200 /);
    assert.ok(Date.now() - t1 >= 150, 'the keep-alive connection waited for the idle time, then went');
  });

  it('a request in flight is not idle: a long event stream stays open past the idle time', async () => {
    const req = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const r = http.request({ host: 'tunnel.invalid', port: 2375, path: '/events', agent: rig.agent }, resolve);
      r.on('error', reject);
      r.end();
    });
    let closed = false;
    req.on('close', () => (closed = true));
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(closed, false);
    req.destroy();
  });
});
