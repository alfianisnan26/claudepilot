// The guarded outbound client (PWA PRD §11.5): IP literals in every spelling are refused BEFORE a connection (Node never calls `lookup` for
// a literal), names are checked at connect time (a rebinding name cannot slip through), metadata addresses are refused even with the
// private tick, redirects are never followed, and the reply is read to at most 4 KB within the time limit. Only local stand-ins.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createEgress, isMetadataAddress } from './egress.js';
import { standIn } from './testkit.js';

const body = '{"v":1}';
const headers = { 'Content-Type': 'application/json' };

test('literals in every spelling are refused before any connection; the stand-in receives nothing', async () => {
  const svc = await standIn();
  try {
    let lookups = 0;
    const egress = createEgress({ allowHttp: true, resolve: async () => (lookups++, [{ address: '127.0.0.1', family: 4 }]) });
    for (const host of ['127.0.0.1', '2130706433', '0x7f000001', '0177.0.0.1', '127.1', '[::1]', '[::ffff:7f00:1]', '[::ffff:127.0.0.1]', '169.254.169.254', '10.0.0.1', '[fd00:ec2::254]', '0.0.0.0']) {
      const r = await egress.send({ url: `http://${host}:${svc.port}/hook`, headers, body });
      assert.equal(r.error, 'blocked_address', host);
    }
    assert.equal(svc.got.length, 0);
    assert.equal(lookups, 0, 'a literal never reaches the resolver');
    // https only (plain http is a test-only option), no user info, a URL at all
    const strict = createEgress();
    assert.equal(strict.precheck('http://hooks.example.test/x'), 'invalid_url');
    assert.equal(strict.precheck('https://user:pw@hooks.example.test/x'), 'invalid_url');
    assert.equal(strict.precheck('ftp://hooks.example.test/x'), 'invalid_url');
    assert.equal(strict.precheck('not a url'), 'invalid_url');
    assert.equal(strict.precheck('https://metadata.google.internal/x'), 'blocked_address');
    assert.equal(strict.precheck('https://hooks.example.test/x'), null);
  } finally {
    await svc.close();
  }
});

test('a name that resolves to a private address, or to ANY private address among public ones, is refused at connect time', async () => {
  const svc = await standIn();
  try {
    for (const addrs of [['10.1.2.3'], ['127.0.0.1'], ['::1'], ['64:ff9b::7f00:1'], ['93.184.216.34', '192.168.1.5']]) {
      const egress = createEgress({ allowHttp: true, resolve: async () => addrs.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 })) });
      const r = await egress.send({ url: `http://hooks.example.test:${svc.port}/x`, headers, body });
      assert.equal(r.error, 'blocked_address', addrs.join(','));
    }
    assert.equal(svc.got.length, 0);
  } finally {
    await svc.close();
  }
});

test('DNS rebinding: the name was public when checked, private when connecting: refused, nothing received', async () => {
  const svc = await standIn();
  try {
    let n = 0;
    const answers = ['93.184.216.34', '127.0.0.1'];
    const resolve = async () => [{ address: answers[Math.min(n++, 1)]!, family: 4 }];
    // an admission-time check (what accounts/check.ts and mcp/spec.ts do) sees a public address ...
    const first = await resolve();
    assert.equal(first[0]!.address, '93.184.216.34');
    // ... and the connect-time lookup gets the private one
    const egress = createEgress({ allowHttp: true, resolve });
    const r = await egress.send({ url: `http://rebind.example.test:${svc.port}/x`, headers, body });
    assert.equal(r.error, 'blocked_address');
    assert.equal(n, 2);
    assert.equal(svc.got.length, 0);
  } finally {
    await svc.close();
  }
});

test('the private tick lets a webhook reach a private address, never a metadata address', async () => {
  const svc = await standIn();
  try {
    const local = createEgress({ allowHttp: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    assert.equal((await local.send({ url: `http://hooks.lan.test:${svc.port}/x`, headers, body })).error, 'blocked_address');
    assert.deepEqual(await local.send({ url: `http://hooks.lan.test:${svc.port}/x`, headers, body, allowPrivate: true }), { ok: true, status: 201, error: null, retryAfterS: null });
    const meta = createEgress({ allowHttp: true, resolve: async () => [{ address: '169.254.169.254', family: 4 }] });
    assert.equal((await meta.send({ url: `http://hooks.lan.test:${svc.port}/x`, headers, body, allowPrivate: true })).error, 'blocked_address');
    assert.equal((await local.send({ url: `http://169.254.169.254:${svc.port}/x`, headers, body, allowPrivate: true })).error, 'blocked_address');
    for (const ip of ['169.254.169.254', '169.254.170.2', '100.100.100.200', '192.0.0.192', 'fd00:ec2::254', 'fe80::1', '::ffff:a9fe:a9fe']) assert.equal(isMetadataAddress(ip), true, ip);
    for (const ip of ['10.0.0.1', '192.168.1.1', '93.184.216.34', '::1']) assert.equal(isMetadataAddress(ip), false, ip);
    assert.equal(svc.got.length, 1);
  } finally {
    await svc.close();
  }
});

test('a redirect is never followed; 429 carries Retry-After (capped at 300 s); 5xx and 4xx are codes', async () => {
  const codes = [302, 429, 503, 404];
  const svc = await standIn((_r, n): { status: number; headers?: Record<string, string> } => (codes[n - 1] === 302 ? { status: 302, headers: { Location: 'http://127.0.0.1:1/elsewhere' } } : codes[n - 1] === 429 ? { status: 429, headers: { 'Retry-After': '9999' } } : { status: codes[n - 1]! }));
  try {
    const egress = createEgress({ allowHttp: true, allowPrivate: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    const url = `http://hooks.example.test:${svc.port}/x`;
    assert.deepEqual(await egress.send({ url, headers, body }), { ok: false, status: 302, error: 'redirect', retryAfterS: null });
    assert.deepEqual(await egress.send({ url, headers, body }), { ok: false, status: 429, error: 'rate_limited', retryAfterS: 300 });
    assert.equal((await egress.send({ url, headers, body })).error, 'http_5xx');
    assert.equal((await egress.send({ url, headers, body })).error, 'http_4xx');
    assert.equal(svc.got.length, 4, 'the redirect target was never asked');
  } finally {
    await svc.close();
  }
});

test('size and time: a huge reply is cut at 4 KB, a silent server times out', async () => {
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === '/slow') return; // never answers
    res.writeHead(200);
    res.end('x'.repeat(1024 * 1024));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const egress = createEgress({ allowHttp: true, allowPrivate: true, totalMs: 300, resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    const big = await egress.send({ url: `http://h.test:${port}/big`, headers, body });
    assert.equal(big.ok, true);
    const t0 = Date.now();
    const slow = await egress.send({ url: `http://h.test:${port}/slow`, headers, body });
    assert.equal(slow.error, 'timeout');
    assert.ok(Date.now() - t0 < 2000);
    const refused = await createEgress({ allowHttp: true, allowPrivate: true, resolve: async () => [{ address: '127.0.0.1', family: 4 }] }).send({ url: 'http://h.test:1/x', headers, body });
    assert.equal(refused.error, 'connect');
    const nxdomain = await createEgress({ allowHttp: true, resolve: async () => Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })) }).send({ url: 'http://nope.test/x', headers, body });
    assert.equal(nxdomain.error, 'dns');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
