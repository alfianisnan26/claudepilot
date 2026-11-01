// Org SSO with the operator's trusted in-cluster issuers (PORTAL_ORG_SSO_TRUSTED_ISSUERS, owner 2026-11-01): exact https origins only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTrustedIssuer, parseTrustedIssuers } from './sso.js';

const LIST = parseTrustedIssuers('https://auth.konfersi.com, https://auth.kohi-labs.com,https://git.isnan.me/,http://plain.example,https://x.example/path,not a url');

test('the list keeps https origins only', () => {
  assert.deepEqual(LIST, ['https://auth.konfersi.com', 'https://auth.kohi-labs.com', 'https://git.isnan.me']);
  assert.deepEqual(parseTrustedIssuers(undefined), []);
  assert.deepEqual(parseTrustedIssuers(''), []);
});

test('a listed issuer (with its path) is trusted', () => {
  assert.equal(isTrustedIssuer('https://auth.konfersi.com/application/o/claudepilot/', LIST), true);
  assert.equal(isTrustedIssuer('https://git.isnan.me', LIST), true);
});

test('lookalikes are not trusted: suffix, user info, http, another port, an unlisted host', () => {
  for (const bad of [
    'https://auth.konfersi.com.evil.example/application/o/x/',
    'https://auth.konfersi.com@evil.example/',
    'https://user:pw@auth.konfersi.com/',
    'http://auth.konfersi.com/application/o/claudepilot/',
    'https://auth.konfersi.com:8443/',
    'https://evil.example/',
    'not a url',
  ])
    assert.equal(isTrustedIssuer(bad, LIST), false, bad);
  assert.equal(isTrustedIssuer('https://auth.konfersi.com/', []), false, 'an empty list trusts nobody');
});

test('an org provider on the trust list is tested (and signs in) with private addresses allowed; an unlisted one is not', async () => {
  const { Store } = await import('../store/store.js');
  const { tempDirectory } = await import('../store/testTmp.js');
  const { SsoProviders } = await import('./sso.js');
  const store = await Store.open({ dataDir: tempDirectory('cp-sso-trust-'), secretKey: null });
  const db = store.db!;
  const seen: Array<{ issuer: string; allowPrivate: boolean }> = [];
  const oidc = { discover: async (issuer: string, allowPrivate: boolean) => (seen.push({ issuer, allowPrivate }), { authorization_endpoint: `${issuer}/authorize` }) };
  const sso = new SsoProviders(() => db, () => db, () => null, null as never, null as never, oidc as never, undefined, LIST);
  const at = new Date().toISOString();
  const add = (id: string, org: string, issuer: string) =>
    db
      .prepare(
        `INSERT INTO sso_providers (id, name, issuer, client_id, client_secret, domains, scopes, default_role, default_team_id, auto_create,
           trust_unverified_email, allow_private_network, enabled, org_id, groups_claim, group_rules, created_by, created_at, updated_at)
           VALUES (?, 'x', ?, 'cid', NULL, '[]', 'openid email', 'member', NULL, 1, 0, 0, 0, ?, NULL, '[]', 'test', ?, ?)`,
      )
      .run(id, issuer, org, at, at);
  for (const [id, slug] of [['org_trusted', 'trusted'], ['org_other', 'other']] as const) db.prepare('INSERT INTO orgs (id, slug, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, slug, slug, 'test', at);
  add('sso_trusted', 'org_trusted', 'https://auth.konfersi.com/application/o/claudepilot/');
  add('sso_other', 'org_other', 'https://idp.elsewhere.example/');
  await sso.testOrg('org_trusted');
  await sso.testOrg('org_other');
  assert.deepEqual(
    seen.map((s) => s.allowPrivate),
    [true, false],
  );
  store.close?.();
});
