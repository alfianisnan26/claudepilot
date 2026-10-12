// The installers' routes (PRD §13, §15, FR45 to FR47, FR12): scripts with their ETag, the plan and the manifest behind the token (not
// used up, refusals with their reason, wrong tokens limited per address, no browser), latest.json, the bundle and the build context.
import assert from 'node:assert/strict';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { CONNECT_PUBLIC } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { extract } from 'tar-stream';
import { policyFor } from '../../authz/seam.js';
import type { InstallDeps } from '../seams.js';
import { INSTALL_PS1, INSTALL_SH } from './installers.generated.js';
import { createInstallRoutes, declareInstallPolicies, INSTALLERS, workspaceContextTgz } from './routes.js';
import { BUNDLE_FIXTURE, CONFIG_FIXTURE, FakeEnrollments, newToken, sha256 } from './testkit.js';

function portal(enrollments = new FakeEnrollments(), ip = '198.51.100.7') {
  const logs: string[] = [];
  const deps: InstallDeps = { enrollments, bundle: BUNDLE_FIXTURE, config: CONFIG_FIXTURE, workspaceContext: () => workspaceContextTgz(), log: (l) => logs.push(l) };
  const app = new Hono();
  app.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    return c.json(err.toJSON(), err.status as ContentfulStatusCode);
  });
  app.route('/', createInstallRoutes(deps, { clientIp: () => ip }));
  return { app, logs, enrollments };
}
const bearer = (t: string, extra: Record<string, string> = {}) => ({ headers: { Authorization: `Bearer ${t}`, ...extra } });

test('the scripts: the generated text, text/plain, ETag = sha256, 304 on a match', async () => {
  const { app } = portal();
  for (const [path, text] of [
    [CONNECT_PUBLIC.installSh, INSTALL_SH],
    [CONNECT_PUBLIC.installPs1, INSTALL_PS1],
  ] as const) {
    const res = await app.request(path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /^text\/plain/);
    assert.equal(res.headers.get('etag'), `"${sha256(text)}"`);
    assert.equal(await res.text(), text);
    assert.equal((await app.request(path, { headers: { 'If-None-Match': `"${sha256(text)}"` } })).status, 304);
  }
  assert.equal(INSTALLERS.sh.sha256, sha256(INSTALL_SH));
});

test('the plan: answered for a usable token without using it; each refusal has its reason', async () => {
  const good = newToken();
  const f = new FakeEnrollments().add(good, 'docker');
  for (const [state, reason] of [
    ['used', 'token_used'],
    ['expired', 'token_expired'],
    ['revoked', 'token_revoked'],
  ] as const) {
    f.add(`${state}-tok`, 'docker', { enrollment: { state } });
  }
  const { app, logs } = portal(f);
  for (let i = 0; i < 2; i++) {
    const res = await app.request(CONNECT_PUBLIC.plan, bearer(good));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await res.text(), /^PILOT_PLAN=1\nPILOT_KIND=docker\n/);
  }
  assert.equal(f.rows.get(good)!.enrollment.state, 'waiting', 'GET plan uses nothing');
  for (const [state, reason] of [
    ['used', 'token_used'],
    ['expired', 'token_expired'],
    ['revoked', 'token_revoked'],
  ] as const) {
    const res = await app.request(CONNECT_PUBLIC.plan, bearer(`${state}-tok`));
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    assert.equal(body.error.details.reason, reason);
  }
  const none = await app.request(CONNECT_PUBLIC.plan);
  assert.equal(none.status, 401);
  assert.match(await none.text(), /"reason":"token_invalid"/, 'the shape install.sh greps for');
  assert.ok(logs.every((l) => !l.includes(good)), 'the token never reaches a log line');
});

test('wrong tokens: ten per address, then 429 even for a good one; another address is unaffected', async () => {
  const good = newToken();
  const f = new FakeEnrollments().add(good, 'docker');
  const a = portal(f, '192.0.2.1');
  for (let i = 0; i < 10; i++) assert.equal((await a.app.request(CONNECT_PUBLIC.plan, bearer(newToken()))).status, 401);
  assert.equal((await a.app.request(CONNECT_PUBLIC.plan, bearer(good))).status, 429);
  assert.equal((await portal(f, '192.0.2.2').app.request(CONNECT_PUBLIC.plan, bearer(good))).status, 200);
});

test('a request with an Origin (a browser) is refused', async () => {
  const good = newToken();
  const { app } = portal(new FakeEnrollments().add(good, 'docker'));
  assert.equal((await app.request(CONNECT_PUBLIC.plan, bearer(good, { Origin: 'https://evil.example' }))).status, 403);
});

test('the manifest: Kubernetes enrollments only, with the bearer token in its Secret', async () => {
  const k = newToken();
  const d = newToken();
  const { app } = portal(new FakeEnrollments().add(k, 'kubernetes').add(d, 'docker'));
  const res = await app.request(CONNECT_PUBLIC.manifest, bearer(k));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /yaml/);
  const text = await res.text();
  assert.match(text, new RegExp(`token: "${k}"`));
  assert.equal((await app.request(CONNECT_PUBLIC.manifest, bearer(d))).status, 404);
});

test('latest.json, the bundle of this build only, and the build context as a tar.gz', async () => {
  const { app } = portal();
  const latest = (await (await app.request(CONNECT_PUBLIC.latest)).json()) as Record<string, unknown>;
  assert.deepEqual(latest, { build: BUNDLE_FIXTURE.build, sha256: BUNDLE_FIXTURE.sha256, version: '0.1.0', protocol: 1, url: CONNECT_PUBLIC.bundle(BUNDLE_FIXTURE.build) });
  const b = await app.request(CONNECT_PUBLIC.bundle(BUNDLE_FIXTURE.build));
  assert.equal(b.status, 200);
  assert.equal(await b.text(), BUNDLE_FIXTURE.source);
  assert.match(b.headers.get('content-type')!, /javascript/);
  assert.equal((await app.request(CONNECT_PUBLIC.bundle('000000000000'))).status, 404);

  const ctx = await app.request(CONNECT_PUBLIC.workspaceContext);
  assert.equal(ctx.status, 200);
  const names: string[] = [];
  const x = extract();
  x.on('entry', (h, s, next) => {
    names.push(h.name);
    s.resume();
    s.on('end', next);
  });
  await new Promise<void>((ok, fail) => {
    Readable.fromWeb(ctx.body as never).pipe(createGunzip()).pipe(x).on('finish', ok).on('error', fail);
  });
  assert.ok(names.includes('Dockerfile') && names.includes('cp-session'), names.join(','));
});

test('the routes are declared to the authorization layer: public, or the token', () => {
  declareInstallPolicies();
  assert.equal(policyFor(`GET ${CONNECT_PUBLIC.installSh}`)?.kind, 'public');
  assert.equal(policyFor(`GET ${CONNECT_PUBLIC.plan}`)?.kind, 'bearer');
  assert.equal(policyFor(`GET ${CONNECT_PUBLIC.manifest}`)?.kind, 'bearer');
});
