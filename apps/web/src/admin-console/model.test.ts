// The Admin console's helpers, and the separation of the console from the main app (docs/prd/organizations.md §6.11, §13.2 row 4: "the
// main UI has no admin page"): nothing outside src/admin-console imports it or calls /admin-api, and the main build has no console entry.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditSearch } from './api';
import {
  AUDIT_KINDS,
  AUDIT_TABS,
  ORG_TABS,
  TABS,
  USER_FILTERS,
  ago,
  auditDates,
  auditTabKind,
  auditWho,
  oidcOutcome,
  oidcStartHref,
  popupResult,
  settingInput,
  slugOf,
  tabFromHash,
  userShows,
} from './model';

const src = fileURLToPath(new URL('..', import.meta.url));
const web = fileURLToPath(new URL('../..', import.meta.url));

test('tabFromHash names a section or falls back to Users; the six sections are in order; #sso opens Sign-in', () => {
  assert.deepEqual([...TABS], ['users', 'orgs', 'workspaces', 'signin', 'settings', 'audit']);
  assert.equal(tabFromHash('#orgs'), 'orgs');
  assert.equal(tabFromHash('#workspaces'), 'workspaces');
  assert.equal(tabFromHash('#settings'), 'settings');
  assert.equal(tabFromHash('#audit'), 'audit');
  assert.equal(tabFromHash('#sso'), 'signin');
  assert.equal(tabFromHash(''), 'users');
  assert.equal(tabFromHash('#nope'), 'users');
  // The OIDC return names the section to come back to; the server takes only [a-z]{1,20}.
  for (const t of TABS) assert.match(t, /^[a-z]{1,20}$/);
});

test('slugOf makes a slug the server accepts, or nothing', () => {
  const ok = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,39}$/;
  assert.equal(slugOf('Acme Corp'), 'acme-corp');
  assert.equal(slugOf('  Café -- Ünïcode!  '), 'cafe-unicode');
  assert.equal(slugOf('x'), '');
  assert.equal(slugOf('!!!'), '');
  const long = slugOf(`${'ab-'.repeat(30)}end`);
  assert.ok(long.length <= 40 && ok.test(long), long);
  assert.ok(ok.test(slugOf('Team 42')));
});

test('settingInput: numbers become numbers (or null), text stays text', () => {
  assert.equal(settingInput('number', ' 30 '), 30);
  assert.equal(settingInput('number', '1.5'), 1.5);
  assert.equal(settingInput('number', 'abc'), null);
  assert.equal(settingInput('number', ''), null);
  assert.equal(settingInput('string', ' keep '), ' keep ');
});

test('auditDates passes date fields as they are and drops empty or malformed ones', () => {
  assert.deepEqual(auditDates('', ''), {});
  assert.deepEqual(auditDates('2026-01-02', ''), { from: '2026-01-02' });
  assert.deepEqual(auditDates('2026-01-02', '2026-01-03'), { from: '2026-01-02', to: '2026-01-03' });
  assert.deepEqual(auditDates('yesterday', '2026-1-3'), {});
  assert.equal(auditSearch({ actor: 'system:', org: 'org_x', ...auditDates('2026-01-02', '') }), '?actor=system%3A&org=org_x&from=2026-01-02');
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
  assert.equal(oidcStartHref(start, { stepUp: true, popup: true, next: 'orgs' }), `${start}?for=step-up&popup=1&next=orgs`);
  assert.equal(oidcStartHref(start, { popup: true }), start, 'a sign-in is never a popup');
  assert.ok(AUDIT_KINDS.includes('admin.signin_refused'), 'the Audit filter offers refused sign-ins');
  assert.equal(auditWho('admin.signin_refused', { method: 'oidc', reason: 'not_allowed', email: 'eve@example.test', subject: '77' }), 'eve@example.test · oidc · not allowed');
  assert.equal(auditWho('admin.signin_refused', { method: 'oidc', reason: 'state', email: null, subject: null }), 'oidc · state');
  assert.equal(auditWho('admin.signin_refused', { subject: '77' }), 'subject 77');
  assert.equal(auditWho('admin.signin', { email: 'x@example.test' }), null);
});

test('a step-up popup reads its outcome only with popup=1; the org and audit tabs (owner, 2026-11-01)', () => {
  assert.equal(popupResult('?oidc=stepped&popup=1'), 'stepped');
  assert.equal(popupResult('?oidc=refused&popup=1'), 'refused');
  assert.equal(popupResult('?oidc=stepped'), null, 'not a popup: the console itself');
  assert.equal(popupResult('?oidc=<x>&popup=1'), null);
  assert.deepEqual([...ORG_TABS], ['overview', 'members', 'objects', 'invitations', 'signin', 'breakglass']);
  assert.deepEqual([...AUDIT_TABS], ['all', 'refused', 'org', 'security']);
  assert.equal(auditTabKind('all'), null);
  assert.equal(auditTabKind('refused'), 'admin.signin_refused');
  assert.equal(auditTabKind('org'), 'org');
  assert.equal(auditTabKind('security'), 'admin');
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

test('Users tabs: All, Admins, Members, Disabled; a disabled admin shows under Disabled only (owner, 2026-11-01)', () => {
  assert.deepEqual([...USER_FILTERS], ['all', 'admins', 'members', 'disabled']);
  const rows = [{ role: 'admin', state: 'active' }, { role: 'member', state: 'active' }, { role: 'admin', state: 'disabled' }, { role: 'member', state: 'disabled' }] as const;
  const under = (f: (typeof USER_FILTERS)[number]) => rows.map((r, i) => (userShows(r, f) ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(under('all'), [0, 1, 2, 3]);
  assert.deepEqual(under('admins'), [0]);
  assert.deepEqual(under('members'), [1]);
  assert.deepEqual(under('disabled'), [2, 3]);
});

test('the console follows the UI standard: on a desktop only the content pane scrolls, and it draws the shared TabBar (owner, 2026-11-01)', () => {
  const consoleSrc = readFileSync(join(src, 'admin-console', 'Console.tsx'), 'utf8');
  assert.match(consoleSrc, /id="console-pane"[^>]*lg:overflow-y-auto/);
  assert.match(consoleSrc, /lg:h-dvh[^'"]*lg:overflow-hidden/);
  assert.match(readFileSync(join(src, 'admin-console', 'UsersView.tsx'), 'utf8'), /from '\.\.\/components\/TabBar'/);
  assert.match(readFileSync(join(src, 'admin-console', 'console.css'), 'utf8'), /@source '\.\.\/components\/TabBar\.tsx'/);
  // Users and Audit are THE windowed list; Users and Orgs open their detail beside the list (master-detail).
  for (const f of ['UsersView.tsx', 'AuditView.tsx']) assert.match(readFileSync(join(src, 'admin-console', f), 'utf8'), /<WindowedList\b/, f);
  for (const f of ['UsersView.tsx', 'OrgsView.tsx']) assert.match(readFileSync(join(src, 'admin-console', f), 'utf8'), /<MasterDetail\b/, f);
  assert.match(readFileSync(join(src, 'admin-console', 'console.css'), 'utf8'), /@source '\.\.\/components\/WindowedList\.tsx'/);
});
