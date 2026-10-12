// PRD Q5 as a test (T-AGENT): `ws` ignores NODE_USE_ENV_PROXY, so the agent dials a CONNECT proxy itself. A local CONNECT proxy and a
// self-signed `wss://` server prove: the tunnel goes through the proxy (with its credentials), certificate verification stays ON (the
// private CA is the only reason it succeeds), PILOT_HEADERS reach the upgrade, and NO_PROXY and the environment are read.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { bypassProxy, describeNetError, httpRequest, parseHeaders, proxyFor, proxyLabel, tlsOptions, transportAgent } from './net.js';
import { TEST_TLS } from './testkit/tls.js';

let web: https.Server;
let wss: WebSocketServer;
let proxy: http.Server;
let webPort = 0;
let proxyPort = 0;
const connects: string[] = [];
const proxyAuth: (string | undefined)[] = [];
const upgradeHeaders: http.IncomingHttpHeaders[] = [];

before(async () => {
  web = https.createServer({ key: TEST_TLS.key, cert: TEST_TLS.cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url, saw: req.headers['x-test'] ?? null }));
  });
  wss = new WebSocketServer({ server: web, handleProtocols: (p) => (p.has('pilot.tunnel.v1') ? 'pilot.tunnel.v1' : false) });
  wss.on('connection', (ws, req) => {
    upgradeHeaders.push(req.headers);
    ws.on('message', (m) => ws.send(`echo:${m}`));
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  webPort = (web.address() as net.AddressInfo).port;

  // A CONNECT proxy that sends every host to the local server (the test names are not real).
  proxy = http.createServer((_req, res) => res.writeHead(405).end());
  proxy.on('connect', (req, client, head) => {
    connects.push(req.url ?? '');
    proxyAuth.push(req.headers['proxy-authorization']);
    const up = net.connect(webPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyPort = (proxy.address() as net.AddressInfo).port;
});

after(() => {
  wss.close();
  web.close();
  web.closeAllConnections();
  proxy.close();
  proxy.closeAllConnections();
});

const echo = (url: string, opts: ConstructorParameters<typeof WebSocket>[2]) =>
  new Promise<string>((resolve) => {
    const ws = new WebSocket(url, 'pilot.tunnel.v1', { perMessageDeflate: false, handshakeTimeout: 4000, ...opts });
    ws.on('open', () => ws.send('hi'));
    ws.on('message', (m) => (ws.close(), resolve(`message ${m}`)));
    ws.on('error', (e) => resolve(`error ${(e as NodeJS.ErrnoException).code ?? e.message}`));
  });

describe('the agent’s own CONNECT dialer (PRD Q5)', () => {
  const target = () => new URL(`wss://${TEST_TLS.host}:${webPort}/connect/v1/tunnel`);

  it('carries a wss tunnel through an HTTP proxy, with verification on and the private CA', async () => {
    connects.length = 0;
    const cfg = { proxy: `http://127.0.0.1:${proxyPort}`, ca: TEST_TLS.cert, headers: { 'CF-Access-Client-Id': 'canary-id' } };
    const result = await echo(target().href, { agent: transportAgent(target(), cfg), headers: cfg.headers });
    assert.equal(result, 'message echo:hi');
    assert.deepEqual(connects, [`${TEST_TLS.host}:${webPort}`], 'the proxy saw the CONNECT for the portal’s address');
    assert.equal(upgradeHeaders.at(-1)?.['cf-access-client-id'], 'canary-id', 'PILOT_HEADERS reach the upgrade');
    assert.equal(upgradeHeaders.at(-1)?.origin, undefined, 'an agent is not a browser: no Origin');
    assert.equal(upgradeHeaders.at(-1)?.['sec-websocket-protocol'], 'pilot.tunnel.v1');
  });

  it('never turns verification off: without the CA the same tunnel fails on the certificate', async () => {
    connects.length = 0;
    const cfg = { proxy: `http://127.0.0.1:${proxyPort}` };
    const result = await echo(target().href, { agent: transportAgent(target(), cfg) });
    assert.equal(result, 'error DEPTH_ZERO_SELF_SIGNED_CERT');
    assert.equal(connects.length, 1, 'it did go through the proxy; it was the certificate that failed');
    assert.equal(tlsOptions({}).rejectUnauthorized, true);
    assert.equal(tlsOptions({ ca: TEST_TLS.cert }).rejectUnauthorized, true);
    assert.equal(describeNetError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }).hint?.includes('PILOT_CA'), true);
  });

  it('sends the proxy’s credentials as Basic auth and does not print them', async () => {
    proxyAuth.length = 0;
    const cfg = { proxy: `http://pilot%40corp:s3cret@127.0.0.1:${proxyPort}`, ca: TEST_TLS.cert };
    assert.equal(await echo(target().href, { agent: transportAgent(target(), cfg) }), 'message echo:hi');
    assert.equal(proxyAuth[0], `Basic ${Buffer.from('pilot@corp:s3cret').toString('base64')}`);
    assert.equal(proxyLabel(new URL(cfg.proxy)), `http://127.0.0.1:${proxyPort}`);
  });

  it('uses the same agent for an ordinary HTTPS request (enrollment) and reports a refusing proxy', async () => {
    connects.length = 0;
    const cfg = { proxy: `http://127.0.0.1:${proxyPort}`, ca: TEST_TLS.cert, headers: { 'X-Test': 'yes' } };
    const url = new URL(`https://${TEST_TLS.host}:${webPort}/connect/v1/health`);
    const res = await httpRequest(url, {}, cfg);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body.toString()), { ok: true, path: '/connect/v1/health', saw: 'yes' });
    assert.equal(connects.length, 1);

    const refusing = http.createServer().on('connect', (_req, socket) => socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'));
    await new Promise<void>((r) => refusing.listen(0, '127.0.0.1', r));
    const port = (refusing.address() as net.AddressInfo).port;
    await assert.rejects(httpRequest(url, { timeoutMs: 3000 }, { proxy: `http://127.0.0.1:${port}`, ca: TEST_TLS.cert }), /refused the connection \(407\)/);
    refusing.close();
  });

  it('reads HTTPS_PROXY and NO_PROXY from the environment; loopback is always direct', () => {
    const portal = new URL('https://pilot.example.test');
    const env = { HTTPS_PROXY: 'proxy.corp:3128', NO_PROXY: 'internal.corp, .lan, 10.0.0.0/8, other.test:8443' };
    assert.equal(proxyFor(portal, { env })?.href, 'http://proxy.corp:3128/');
    assert.equal(proxyFor(new URL('https://notinternal.corp'), { env })?.href, 'http://proxy.corp:3128/', 'a suffix needs a dot boundary');
    assert.equal(proxyFor(new URL('https://internal.corp'), { env }), null);
    assert.equal(proxyFor(new URL('https://x.internal.corp'), { env }), null, 'a name also covers its subdomains');
    assert.equal(proxyFor(new URL('https://nas.lan'), { env }), null);
    assert.equal(proxyFor(new URL('https://10.2.3.4'), { env }), null);
    assert.equal(proxyFor(new URL('https://11.2.3.4'), { env })?.hostname, 'proxy.corp');
    assert.equal(proxyFor(new URL('https://other.test:8443'), { env }), null);
    assert.equal(proxyFor(new URL('https://other.test'), { env })?.hostname, 'proxy.corp');
    assert.equal(proxyFor(new URL('https://localhost:3000'), { env }), null);
    assert.equal(proxyFor(new URL('https://127.0.0.1'), { env }), null);
    assert.equal(proxyFor(portal, { env: { https_proxy: 'http://lower:1' } })?.hostname, 'lower');
    assert.equal(proxyFor(portal, { env: {} }), null);
    assert.equal(proxyFor(portal, { env: { HTTPS_PROXY: 'ftp://x' } }), null);
    assert.equal(proxyFor(new URL('http://pilot.example.test'), { env: { HTTPS_PROXY: 'http://p:1' } }), null, 'http uses HTTP_PROXY');
    assert.equal(bypassProxy('anything.test', '443', '*'), true);
    assert.equal(bypassProxy('a.b.test', '443', '*.b.test'), true);
  });

  it('parses PILOT_HEADERS: Name: value per line; anything else is dropped', () => {
    const text = 'CF-Access-Client-Id: abc.access\nCF-Access-Client-Secret:  s e c\n\nnot a header\n: x\nBad Name: v\nX-Evil: a\u0000b\n';
    assert.deepEqual(parseHeaders(text), { 'CF-Access-Client-Id': 'abc.access', 'CF-Access-Client-Secret': 's e c' });
    assert.deepEqual(parseHeaders(undefined), {});
  });
});
