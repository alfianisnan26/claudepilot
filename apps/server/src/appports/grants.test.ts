// T-948 (docs/prd/app-ports.md §4): the one-time code is single use, expires, and is bound to its app host; the cookie it buys is bound to
// that host too. Values are made at run time by the code under test; nothing token-shaped is written here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOUNDING_USER_ID, type Actor } from '@portal/contracts';
import { AppPortGrants, type AppGrant } from './grants.js';

const actor: Actor = { kind: 'user', userId: FOUNDING_USER_ID, loginSessionId: 'l1', via: 'ui' };
const HOST = 'app-ws-1-8080.apps.test';
const grant = (over: Partial<AppGrant> = {}): AppGrant => ({
  workspaceId: 'docker/ws-1',
  port: 8080,
  host: HOST,
  sessionToken: 'session-under-test',
  actor,
  portalOrigin: 'https://pilot.apps.test',
  scheme: 'https',
  ...over,
});

test('a code is single use: the second redeem is refused', () => {
  const g = new AppPortGrants();
  const { code } = g.mint(grant());
  const first = g.redeem(code, HOST);
  assert.ok(first, 'the first redeem gives a cookie');
  assert.equal(first.grant.port, 8080);
  assert.equal(g.redeem(code, HOST), null);
  assert.equal(g.size.codes, 0);
});

test('a code expires after its TTL (30 s by default)', () => {
  let now = 1_000_000;
  const g = new AppPortGrants({ now: () => now });
  assert.equal(g.codeTtlMs, 30_000);
  const a = g.mint(grant());
  const b = g.mint(grant());
  now += 29_999;
  assert.ok(g.redeem(a.code, HOST), 'still valid just before the TTL');
  now += 1;
  assert.equal(g.redeem(b.code, HOST), null, 'expired at the TTL');
});

test('a code redeemed on another host is refused and burned', () => {
  const g = new AppPortGrants();
  const { code } = g.mint(grant());
  assert.equal(g.redeem(code, 'app-ws-1-8081.apps.test'), null);
  assert.equal(g.redeem(code, HOST), null, 'a wrong-host try burns the code');
  assert.equal(g.redeem('', HOST), null);
  assert.equal(g.redeem('not-a-code', HOST), null);
});

test('a cookie is bound to its host and expires; forgetWorkspace drops it', () => {
  let now = 5_000_000;
  const g = new AppPortGrants({ now: () => now, cookieTtlMs: 60_000 });
  const r = g.redeem(g.mint(grant()).code, HOST.toUpperCase());
  assert.ok(r);
  assert.equal(r.maxAgeS, 60);
  assert.equal(g.lookup(r.cookie, HOST)?.workspaceId, 'docker/ws-1');
  assert.equal(g.lookup(r.cookie, 'app-ws-1-8081.apps.test'), null);
  assert.equal(g.lookup(undefined, HOST), null);
  now += 60_000;
  assert.equal(g.lookup(r.cookie, HOST), null, 'expired');
  const s = g.redeem(g.mint(grant()).code, HOST);
  assert.ok(s);
  g.forgetWorkspace('docker/ws-1');
  assert.equal(g.lookup(s.cookie, HOST), null);
});

test('codes and cookies are random and differ every time', () => {
  const g = new AppPortGrants();
  const a = g.mint(grant()).code;
  const b = g.mint(grant()).code;
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
});
