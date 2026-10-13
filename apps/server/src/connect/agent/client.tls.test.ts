// T-AGENT / acceptance A13 in its test form (docs/prd/targets-connect.md §13.7, FR53): a portal behind a self-signed certificate (a tiny TLS
// terminator in front of the real hub), a local CONNECT proxy, PILOT_HEADERS. With the private CA and the proxy the agent enrolls and connects;
// without the CA it does not (certificate verification is never turned off); the extra headers reach both the enrollment and the upgrade.
import assert from 'node:assert/strict';
import http, { type IncomingHttpHeaders } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import tls from 'node:tls';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { runAgent, type AgentHandle } from './client.js';
import { collectingLogger } from './log.js';
import { agentConfig } from './testkit/agentConfig.js';
import { openPortal, stopAgents, type Portal } from './testkit/portalRig.js';
import { TEST_TLS } from './testkit/tls.js';

let portal: Portal;
let terminator: tls.Server;
let proxy: http.Server;
let tlsPort = 0;
let proxyPort = 0;
let dir: string;
const connects: string[] = [];
const requestHeaders: IncomingHttpHeaders[] = [];
const upgradeHeaders: IncomingHttpHeaders[] = [];
const agents: AgentHandle[] = [];

before(async () => {
  portal = await openPortal();
  portal.hub.server.prependListener('request', (req) => requestHeaders.push(req.headers));
  portal.hub.server.prependListener('upgrade', (req) => upgradeHeaders.push(req.headers));
  // TLS terminator: decrypts and hands the bytes to the hub's plain port.
  terminator = tls.createServer({ key: TEST_TLS.key, cert: TEST_TLS.cert }, (socket) => {
    const up = net.connect(portal.hub.port, '127.0.0.1');
    socket.pipe(up);
    up.pipe(socket);
    socket.on('error', () => up.destroy());
    up.on('error', () => socket.destroy());
    socket.on('close', () => up.destroy());
    up.on('close', () => socket.destroy());
  });
  await new Promise<void>((r) => terminator.listen(0, '127.0.0.1', r));
  tlsPort = (terminator.address() as AddressInfo).port;
  // A CONNECT proxy that sends every name to the terminator (the test host name is not real).
  proxy = http.createServer((_req, res) => res.writeHead(405).end());
  proxy.on('connect', (req, client, head) => {
    connects.push(req.url ?? '');
    const up = net.connect(tlsPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyPort = (proxy.address() as AddressInfo).port;
});
after(async () => {
  proxy.close();
  proxy.closeAllConnections();
  terminator.close();
  await portal.close();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cx2-tls-'));
  mkdirSync(join(dir, 'home'));
  connects.length = 0;
  requestHeaders.length = 0;
  upgradeHeaders.length = 0;
});
afterEach(async () => {
  await stopAgents(agents);
  rmSync(dir, { recursive: true, force: true });
});

const url = () => `https://${TEST_TLS.host}:${tlsPort}`;
const start = (token: string, net: Parameters<typeof runAgent>[0]['net']) => {
  const log = collectingLogger();
  const h = runAgent({
    config: agentConfig({ dataDir: join(dir, 'agent'), home: join(dir, 'home'), url: url(), enrollToken: token, headers: { 'CF-Access-Client-Id': 'canary-id', 'CF-Access-Client-Secret': 'canary-secret-value' } }),
    log: log.logger,
    build: 'dddddddddddd',
    net,
    timing: { fatalMs: 60_000, notEnrolledPollMs: 60_000 },
  });
  agents.push(h);
  return { h, log };
};

describe('a portal behind a private CA and a CONNECT proxy', () => {
  it('enrolls and connects with the CA and the proxy, and the extra headers reach the enrollment and the upgrade', async () => {
    const t = portal.target({ id: 'tls-ok' });
    const { h, log } = start(t.token, { ca: TEST_TLS.cert, proxy: `http://127.0.0.1:${proxyPort}` });
    await h.whenConnected(20_000);
    assert.ok(connects.length >= 2, `the proxy carried the enrollment and the tunnel: ${connects}`);
    assert.ok(connects.every((c) => c === `${TEST_TLS.host}:${tlsPort}`));
    assert.equal(requestHeaders.find((x) => x.authorization)?.['cf-access-client-id'], 'canary-id', 'PILOT_HEADERS on the enrollment request');
    assert.equal(upgradeHeaders.at(-1)?.['cf-access-client-secret'], 'canary-secret-value', 'PILOT_HEADERS on the upgrade');
    assert.equal(upgradeHeaders.at(-1)?.origin, undefined, 'an agent is not a browser: no Origin');
    assert.equal(log.text().includes('canary-secret-value'), false, 'the header values are never logged');
    assert.equal(log.text().includes(t.token), false);
  });

  it('does not connect without the CA: verification is never turned off, and the failure says why', async () => {
    const t = portal.target({ id: 'tls-no-ca' });
    const { h, log } = start(t.token, { proxy: `http://127.0.0.1:${proxyPort}` });
    const refused: string[] = [];
    h.events.on('refused', (r) => refused.push(`${r.code}:${r.message}`));
    const start1 = Date.now();
    while (!refused.length && Date.now() - start1 < 10_000) await new Promise((r) => setTimeout(r, 25));
    assert.match(refused[0] ?? '', /^unreachable:The portal’s certificate is not trusted \(DEPTH_ZERO_SELF_SIGNED_CERT\)/);
    assert.equal(h.connected(), false);
    assert.match(log.text(), /enroll\.unreachable code=DEPTH_ZERO_SELF_SIGNED_CERT/);
    assert.equal(portal.core.registry.liveNodes('tls-no-ca').length, 0, 'nothing was enrolled');
    assert.ok(connects.length >= 1, 'it did go through the proxy; the certificate is what stopped it');
  });

  it('ignores NODE_TLS_REJECT_UNAUTHORIZED=0: the agent states its own verification', async () => {
    const t = portal.target({ id: 'tls-env' });
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const { h } = start(t.token, { proxy: `http://127.0.0.1:${proxyPort}` });
      const refused: string[] = [];
      h.events.on('refused', (r) => refused.push(r.code));
      const t0 = Date.now();
      while (!refused.length && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 25));
      assert.deepEqual(refused, ['unreachable'], 'the environment variable did not switch verification off');
    } finally {
      if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
    }
  });
});
