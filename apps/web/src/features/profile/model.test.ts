// The account area's states (owner request 2026-11-01: the menu said "Admin · Signed in with server code" for every session): an account shows
// its own name, email, picture or initials, role and org; the server code says it is the server code and names the founder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MyProfile, PortalUser, SignedInAs } from '@portal/contracts';
import { accountView, deviceLine, initialsOf, linkResult, profileReturnPath, profileSections, profileTabs, signInLine } from './model';

const user: PortalUser = {
  id: 'u_a',
  email: 'alfian@isnan.me',
  displayName: 'Alfian Isnan',
  role: 'admin',
  state: 'active',
  createdAt: '2026-10-17T00:00:00.000Z',
  createdBy: 'ui',
  lastLoginAt: null,
};
const profile = (over: Partial<MyProfile> = {}): MyProfile => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  username: null,
  avatar: null,
  role: 'admin',
  founder: true,
  passwordSet: true,
  signIns: [],
  createdAt: user.createdAt,
  lastLoginAt: null,
  ...over,
});

test('initials: two words, one word, the email, nothing', () => {
  assert.equal(initialsOf('Alfian Isnan'), 'AI');
  assert.equal(initialsOf('  sari  '), 'S');
  assert.equal(initialsOf('', 'mia@konfersi.com'), 'M');
  assert.equal(initialsOf(null, null), '?');
});

test('an admin account: its name, email, initials, the Admin chip, how it signed in, and the org with its role', () => {
  const me: SignedInAs = { kind: 'account', user, profile: profile(), session: { method: 'password', provider: null } };
  const v = accountView(me, { name: 'Konfersi', myRole: 'owner' });
  assert.deepEqual(
    [v.title, v.subtitle, v.initials, v.avatar, v.role, v.org, v.serverCode, v.signIn],
    ['Alfian Isnan', 'alfian@isnan.me', 'AI', null, 'Admin', 'Konfersi · Owner', false, 'Signed in with a password'],
  );
  assert.equal(accountView(me, null).org, null, 'Personal: no org line');
});

test('a member signed in through SSO, with a picture', () => {
  const me: SignedInAs = {
    kind: 'account',
    user: { ...user, id: 'u_m', email: 'mia@konfersi.com', displayName: 'Mia', role: 'member' },
    profile: profile({ id: 'u_m', email: 'mia@konfersi.com', displayName: 'Mia', role: 'member', founder: false, passwordSet: false, avatar: '/api/users/avatars/abc' }),
    session: { method: 'sso', provider: 'Konfersi Team' },
  };
  const v = accountView(me, { name: 'KohiLabs', myRole: 'member' });
  assert.deepEqual([v.title, v.role, v.avatar, v.signIn, v.org], ['Mia', 'Member', '/api/users/avatars/abc', 'Signed in with Konfersi Team', 'KohiLabs · Member']);
  assert.deepEqual(profileSections(me), ['identity', 'devices', 'orgs', 'tokens', 'preferences'], 'no password change for an SSO-only account');
});

test('the server code: "Owner (server code)", the founder’s name and picture when there is one, never an account’s role guess', () => {
  const withFounder = accountView({ kind: 'code', founder: { displayName: 'Alfian', email: 'alfian@isnan.me', username: null, avatar: '/api/users/avatars/f' }, session: { method: 'code', provider: null } }, null);
  assert.deepEqual([withFounder.title, withFounder.subtitle, withFounder.avatar, withFounder.serverCode, withFounder.signIn], ['Owner (server code)', 'Alfian', '/api/users/avatars/f', true, 'Signed in with the server code']);
  const bare = accountView({ kind: 'code' }, null);
  assert.deepEqual([bare.title, bare.subtitle, bare.initials, bare.serverCode], ['Owner (server code)', null, 'SC', true], 'an older server or no founder');
  assert.deepEqual(profileSections({ kind: 'code' }), ['serverCode', 'preferences']);
});

test('an older server (no profile) still shows the account; loading shows a neutral line', () => {
  const v = accountView({ kind: 'account', user: { ...user, role: 'member' } }, null);
  assert.deepEqual([v.title, v.role, v.signIn], ['Alfian Isnan', 'Member', null]);
  assert.deepEqual(profileSections({ kind: 'account', user }), ['identity', 'password', 'devices', 'orgs', 'tokens', 'preferences']);
  const loading = accountView(null, null);
  assert.deepEqual([loading.title, loading.role, loading.serverCode], ['Account', null, false]);
  assert.deepEqual(profileSections(null), []);
});

test('sign-in and device lines', () => {
  assert.equal(signInLine({ method: 'sso', provider: null }), 'Signed in with SSO');
  assert.equal(signInLine({ method: 'unknown', provider: null }), null);
  assert.equal(signInLine(undefined), null);
  assert.deepEqual(deviceLine({ device: 'Safari on iPhone', method: 'sso', provider: 'git.isnan.me' }), { name: 'Safari on iPhone', how: 'git.isnan.me' });
  assert.deepEqual(deviceLine({ device: null, method: 'unknown', provider: null }), { name: 'Unknown browser', how: null });
});

test('the Profile’s tabs: Account, Sign-in, Orgs, Tokens, Preferences for an account; Account and Preferences for the server code', () => {
  const tabs = (me: SignedInAs | null) => profileTabs(me).map((t) => [t.id, ...t.sections].join(':'));
  const linked = profile({ signIns: [{ providerId: 'p1', provider: 'Konfersi Team', email: user.email, linkedAt: user.createdAt, lastUsedAt: null }] });
  assert.deepEqual(tabs({ kind: 'account', user, profile: linked }), ['account:identity', 'sign-in:password:signIns:devices', 'orgs:orgs', 'tokens:tokens', 'preferences:preferences']);
  assert.deepEqual(tabs({ kind: 'account', user }), ['account:identity', 'sign-in:password:devices', 'orgs:orgs', 'tokens:tokens', 'preferences:preferences'], 'no linked sign-ins: the tab stays for the devices');
  assert.deepEqual(tabs({ kind: 'code' }), ['account:serverCode', 'preferences:preferences']);
  const linkable = profile({ linkable: [{ providerId: 'sso_g', provider: 'git.isnan.me', start: '/api/auth/sso/start?for=link' }] });
  assert.deepEqual(tabs({ kind: 'account', user, profile: linkable })[1], 'sign-in:password:signIns:devices', 'Link git.isnan.me sits in the Sign-in tab');
  assert.deepEqual(tabs(null), [], 'loading: no tabs yet');
  assert.deepEqual(
    profileTabs({ kind: 'code' }).map((t) => t.label),
    ['Account', 'Preferences'],
  );
});

test('Profile → Link (owner request 2026-11-01): the sign-ins section shows while there is something to link; the return is read once', () => {
  const me = (p: MyProfile): SignedInAs => ({ kind: 'account', user, profile: p });
  assert.ok(!profileSections(me(profile())).includes('signIns'));
  assert.ok(profileSections(me(profile({ linkable: [{ providerId: 'sso_g', provider: 'git.isnan.me', start: '/api/auth/sso/start?for=link' }] }))).includes('signIns'));
  assert.deepEqual(linkResult('?linked=1'), { ok: true });
  assert.equal(linkResult(''), null);
  const bad = linkResult('?link_error=no_account');
  assert.ok(bad && !bad.ok && /another/.test(bad.message));
  const odd = linkResult('?link_error=<script>');
  assert.ok(odd && !odd.ok && odd.message === 'Couldn’t link it. Try again.');
});

test('a link’s return (/profile?linked=1 or ?link_error=) opens the Sign-in tab, where Linked sign-ins are', () => {
  assert.equal(profileReturnPath('?linked=1'), '/admin/profile/sign-in');
  assert.equal(profileReturnPath('?link_error=state'), '/admin/profile/sign-in');
  assert.equal(profileReturnPath(''), '/admin/profile');
});
