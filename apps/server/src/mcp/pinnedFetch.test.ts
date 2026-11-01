// Organizations slice 2 (docs/prd/organizations.md §9.8, P6): the DNS-rebinding guard. A fake resolver answers a public address the first time
// it is asked and a private one after that, the classic rebinding. The old pair (`assertPublicUrl`, then a fetch by name) would check the
// first answer and connect to the second; the pinned fetch resolves once and connects to the address it checked.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { pinnedFetch, resolvePinned, type Resolver } from './pinnedFetch.js';

let server: Server;
let port = 0;
let hits = 0;
before(async () => {
  server = createServer((req, res) => {
    hits++;
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1/' });
      return res.end();
    }
    if (req.url === '/big') return res.end('x'.repeat(5000));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ host: req.headers.host, method: req.method }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

/** Answers `first` once, then `then` for every later question, and counts the questions. */
function rebinding(first: string, then: string) {
  const asked: string[] = [];
  const resolve: Resolver = async (host) => {
    asked.push(host);
    return [{ address: asked.length === 1 ? first : then, family: 4 }];
  };
  return { resolve, asked };
}

test('rebinding: a name that answers public then private is resolved once and the connection goes to the checked (public) address', async () => {
  // The documentation ranges are private by our rule, so the first answer is an ordinary public address (next to TEST-NET-3) on a port
  // nothing there listens on: the request fails or times out, and above all it never reaches the private server the second answer names.
  const r = rebinding('203.0.114.1', '127.0.0.1');
  hits = 0;
  await assert.rejects(pinnedFetch(`http://idp.rebind.test:${port}/.well-known/openid-configuration`, undefined, { allowPrivate: false, resolve: r.resolve, timeoutMs: 400 }));
  assert.equal(hits, 0, 'the private server behind the second answer was never reached');
  assert.deepEqual(r.asked, ['idp.rebind.test'], 'the name was resolved exactly once');
});

test('the pinned connection really is the checked address: a name nothing else can resolve reaches the server its one answer named', async () => {
  const r = rebinding('127.0.0.1', '10.255.255.1'); // a second answer would go nowhere
  hits = 0;
  const res = await pinnedFetch(`http://idp.only-in-the-fake.test:${port}/x`, { method: 'POST', headers: { accept: 'application/json' }, body: 'a=1' }, { allowPrivate: true, resolve: r.resolve });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { host: string; method: string };
  assert.deepEqual(body, { host: `idp.only-in-the-fake.test:${port}`, method: 'POST' }, 'the Host header is the name (TLS would verify the name too)');
  assert.equal(hits, 1);
  assert.deepEqual(r.asked, ['idp.only-in-the-fake.test']);
});

test('the guard: private refused unless allowed; metadata and link-local never; a literal is checked without resolving; no answer is refused', async () => {
  const fixed = (address: string): Resolver => async () => [{ address, family: address.includes(':') ? 6 : 4 }];
  const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
  assert.equal(await code(resolvePinned(new URL('https://idp.example.test/'), false, fixed('10.0.0.5'))), 'VALIDATION_FAILED');
  assert.equal(await code(resolvePinned(new URL('https://idp.example.test/'), true, fixed('10.0.0.5'))), 'ok');
  for (const meta of ['169.254.169.254', '169.254.10.10', 'fe80::1', '::ffff:a9fe:a9fe', '100.100.100.200'])
    assert.equal(await code(resolvePinned(new URL('https://idp.example.test/'), true, fixed(meta))), 'VALIDATION_FAILED', meta);
  assert.equal(await code(resolvePinned(new URL('http://169.254.169.254/latest'), true)), 'VALIDATION_FAILED');
  assert.equal(await code(resolvePinned(new URL('http://127.0.0.1/'), false, async () => assert.fail('a literal is never resolved'))), 'VALIDATION_FAILED');
  assert.equal(await code(resolvePinned(new URL('https://nothing.example.test/'), false, async () => [])), 'BAD_GATEWAY');
  assert.equal(await code(resolvePinned(new URL('https://mixed.example.test/'), false, async () => [{ address: '93.184.215.14', family: 4 }, { address: '127.0.0.1', family: 4 }])), 'VALIDATION_FAILED', 'one private answer among public ones is refused');
});

test('a redirect is never followed, and an answer over the cap is refused', async () => {
  const local: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(pinnedFetch(`http://idp.test:${port}/redirect`, undefined, { allowPrivate: true, resolve: local }), /redirect/);
  await assert.rejects(pinnedFetch(`http://idp.test:${port}/big`, undefined, { allowPrivate: true, resolve: local, maxBytes: 1000 }), /too large/);
});
