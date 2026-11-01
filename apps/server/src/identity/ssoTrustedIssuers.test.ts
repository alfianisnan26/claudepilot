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
