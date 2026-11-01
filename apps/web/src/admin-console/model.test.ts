// The Admin console's helpers, and the separation of the console from the main app (docs/prd/organizations.md §6.11, §13.2 row 4: "the
// main UI has no admin page"): nothing outside src/admin-console imports it or calls /admin-api, and the main build has no console entry.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditSearch } from './api';
import { AUDIT_KINDS, ago, auditWho, oidcOutcome, oidcStartHref, tabFromHash } from './model';

const src = fileURLToPath(new URL('..', import.meta.url));
const web = fileURLToPath(new URL('../..', import.meta.url));

test('tabFromHash names a section or falls back to Users', () => {
  assert.equal(tabFromHash('#orgs'), 'orgs');
  assert.equal(tabFromHash('#audit'), 'audit');
  assert.equal(tabFromHash(''), 'users');
  assert.equal(tabFromHash('#nope'), 'users');
});

test('ago is relative to the given clock and says unknown for a bad time', () => {
  const now = Date.now();
  assert.equal(ago(new Date(now - 10_000).toISOString(), now), 'now');
  assert.equal(ago(new Date(now - 5 * 60_000).toISOString(), now), '5 min ago');
  assert.equal(ago(new Date(now - 3 * 3600_000).toISOString(), now), '3 h ago');
  assert.equal(ago(new Date(now - 2 * 86_400_000).toISOString(), now), '2 d ago');
  assert.equal(ago('not a date', now), 'unknown');
});

test('auditSearch drops empty filters', () => {
  assert.equal(auditSearch({}), '');
  assert.equal(auditSearch({ kind: 'account', severity: 'medium', limit: 50 }), '?kind=account&severity=medium&limit=50');
  assert.equal(auditSearch({ kind: '' }), '');
});

test('OIDC sign-in: the outcome query, the start link, and who a refused sign-in was (owner, 2026-11-01)', () => {
  assert.equal(oidcOutcome('?oidc=refused'), 'refused');
  assert.equal(oidcOutcome('?oidc=unavailable'), 'unavailable');
  assert.equal(oidcOutcome('?oidc=<script>'), null);
  assert.equal(oidcOutcome(''), null);
  const start = '/admin-api/session/oidc/start';
  assert.equal(oidcStartHref(start), start);
  assert.equal(oidcStartHref(start, { stepUp: true, next: 'orgs' }), `${start}?for=step-up&next=orgs`);
  assert.ok(AUDIT_KINDS.includes('admin.signin_refused'), 'the Audit filter offers refused sign-ins');
  assert.equal(auditWho('admin.signin_refused', { method: 'oidc', reason: 'not_allowed', email: 'eve@example.test', subject: '77' }), 'eve@example.test · oidc · not allowed');
  assert.equal(auditWho('admin.signin_refused', { method: 'oidc', reason: 'state', email: null, subject: null }), 'oidc · state');
  assert.equal(auditWho('admin.signin_refused', { subject: '77' }), 'subject 77');
  assert.equal(auditWho('admin.signin', { email: 'x@example.test' }), null);
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css|html)$/.test(n) ? [p] : [];
  });
}

test('the main UI has no admin console page: no import of it, no /admin-api call, no console entry in the main build', () => {
  const offenders = files(src)
    .filter((p) => !relative(src, p).startsWith('admin-console'))
    .filter((p) => /admin-console|\/admin-api|\/admin-ui|ADMIN_API/.test(readFileSync(p, 'utf8')))
    .map((p) => relative(web, p));
  assert.deepEqual(offenders, []);
  const main = readFileSync(join(web, 'vite.config.ts'), 'utf8');
  assert.doesNotMatch(main, /admin\.html|admin-console/);
  assert.doesNotMatch(readFileSync(join(web, 'index.html'), 'utf8'), /admin-console/);
});
