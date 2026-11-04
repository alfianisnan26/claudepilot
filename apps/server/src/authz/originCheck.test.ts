// PILOT-1139: before the portal is on a public host, every route that changes state and that a cookie can reach refuses a request from
// another site (Origin not allowed, or Sec-Fetch-Site: cross-site). ONE enumeration over the whole app's route table: a new unsafe route is
// checked by the global middleware unless its path is one of the cookieless doors in ORIGIN_EXEMPT, so this test fails when someone adds
// an exemption a cookie route falls under, or mounts an unsafe route the middleware does not cover.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CROSS_SITE_MESSAGE, ORIGIN_EXEMPT, crossSite, originAllowed, originExempt, parseAllowedOrigins, socketOriginAllowed } from '../originCheck.js';
import { buildWholeApp, routeKeys } from './wholeApp.testkit.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'ALL']);
const HOST = 'localhost';
const FOREIGN = 'https://attacker.example';

/** A concrete path for a route pattern: every parameter and wildcard becomes `x`. */
const concrete = (pattern: string) => pattern.replace(/:[A-Za-z_]\w*(\{[^}]*\})?\??/g, 'x').replace(/\*/g, 'x');

const refusedCrossSite = async (res: Response) => res.status === 403 && (await res.clone().text()).includes(CROSS_SITE_MESSAGE);

test('whole app: every unsafe route a cookie can reach refuses another site; only the cookieless doors are exempt', async () => {
  const { app, portal } = await buildWholeApp();
  const cookie = `portal_session=${portal.signIn('24681357')}`;
  const unsafe = [...routeKeys(app)].filter((k) => UNSAFE.has(k.split(' ')[0]!));
  assert.ok(unsafe.length >= 250, `found only ${unsafe.length} unsafe routes; the whole app must be built`);
  const open: string[] = [];
  const exemptButRefused: string[] = [];
  for (const key of unsafe) {
    const [method, pattern] = key.split(' ') as [string, string];
    const path = concrete(pattern);
    const send = (headers: Record<string, string>) =>
      app.request(`http://${HOST}${path}`, { method: method === 'ALL' ? 'POST' : method, headers: { host: HOST, cookie, 'content-type': 'application/json', ...headers }, body: '{}' });
    const byOrigin = await refusedCrossSite(await send({ origin: FOREIGN }));
    const bySite = await refusedCrossSite(await send({ 'sec-fetch-site': 'cross-site' }));
    if (originExempt(path)) {
      if (byOrigin || bySite) exemptButRefused.push(key);
    } else if (!byOrigin || !bySite) open.push(`${key}${byOrigin ? '' : ' (origin)'}${bySite ? '' : ' (sec-fetch-site)'}`);
  }
  assert.deepEqual(open, [], 'unsafe routes that a page on another site could call with the cookie');
  assert.deepEqual(exemptButRefused, [], 'exempt doors must not be touched by the check');
});

test('whole app: the same site, and a client that is not a browser (no Origin, no Sec-Fetch-Site), pass the check', async () => {
  const { app, portal } = await buildWholeApp();
  const cookie = `portal_session=${portal.signIn('24681357')}`;
  const send = (headers: Record<string, string>) => app.request(`http://${HOST}/api/logout`, { method: 'POST', headers: { host: HOST, cookie, 'content-type': 'application/json', ...headers }, body: '{}' });
  for (const h of [{ origin: `http://${HOST}` }, { origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin' }, {}]) {
    const res = await send(h);
    assert.equal(await refusedCrossSite(res), false, JSON.stringify(h));
    assert.equal(res.status, 200, `${JSON.stringify(h)}: ${await res.text()}`);
  }
});

test('the exempt doors are exactly the cookieless ones (a change here needs a review: each must never read the session cookie)', () => {
  assert.deepEqual([...ORIGIN_EXEMPT], ['/mcp', '/connect/', '/hooks/']);
  assert.equal(originExempt('/mcp'), true);
  assert.equal(originExempt('/mcpx'), false, 'a prefix match is on whole segments');
  assert.equal(originExempt('/connect/v1/enroll'), true);
  assert.equal(originExempt('/api/connect/targets'), false, 'the admin REST of Connect is a cookie route');
  assert.equal(originExempt('/api/mcp/entries'), false);
});

test('originAllowed: the request host, or an exact configured origin; nothing looser', () => {
  const allowed = parseAllowedOrigins(' https://pilot-next.example.com , http://bad path , ftp://x.example, https://a.example/withpath, https://b.example:8443 ');
  assert.deepEqual(allowed, ['https://pilot-next.example.com', 'https://b.example:8443'], 'only well-formed http(s) origins, no path');
  assert.equal(originAllowed('https://portal.example', 'portal.example', []), true);
  assert.equal(originAllowed('http://portal.example', 'portal.example', []), true, 'TLS ends at the proxy: the scheme is not compared on the own host');
  assert.equal(originAllowed('https://pilot-next.example.com', 'origin.internal:3000', allowed), true);
  assert.equal(originAllowed('https://b.example:8443', 'x', allowed), true);
  for (const o of ['https://pilot-next.example.com.attacker.example', 'https://evil.pilot-next.example.com', 'http://pilot-next.example.com', 'https://b.example', 'null', '', 'https://portal.example/'])
    assert.equal(originAllowed(o, 'portal.example', allowed), false, o);
});

test('crossSite: a foreign Origin, or Sec-Fetch-Site cross-site when there is no Origin; neither header is a non-browser client', () => {
  assert.equal(crossSite({ origin: FOREIGN, host: HOST }, []), true);
  assert.equal(crossSite({ secFetchSite: 'cross-site', host: HOST }, []), true);
  assert.equal(crossSite({ origin: 'https://pilot-next.example.com', secFetchSite: 'cross-site', host: HOST }, ['https://pilot-next.example.com']), false, 'an Origin decides when there is one: a configured site is cross-site to the browser');
  assert.equal(crossSite({ origin: `https://${HOST}`, secFetchSite: 'same-origin', host: HOST }, []), false);
  assert.equal(crossSite({ secFetchSite: 'same-site', host: HOST }, []), false);
  assert.equal(crossSite({ host: HOST }, []), false);
});

test('sockets: a handshake needs an allowed Origin (a browser always sends one)', () => {
  assert.equal(socketOriginAllowed(undefined, HOST, []), false);
  assert.equal(socketOriginAllowed(FOREIGN, HOST, []), false);
  assert.equal(socketOriginAllowed(`https://${HOST}`, HOST, []), true);
  assert.equal(socketOriginAllowed('https://pilot-next.example.com', 'origin.internal', ['https://pilot-next.example.com']), true);
});
