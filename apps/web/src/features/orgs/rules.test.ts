import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORG_INVITE_PATH, ORG_SLUG_PATTERN } from '@portal/contracts';
import {
  canCreateOrg,
  canManageOrg,
  canRemoveMember,
  canSeeMembers,
  canSeeSignIn,
  canSetSsoPolicy,
  cleanRules,
  inviteCodeFrom,
  inviteLink,
  inviteRoleChoices,
  orgErrorText,
  outsideMembers,
  parseFreshness,
  roleChoices,
  slugFrom,
} from './rules';

test('New organization shows only with the ability (an instance admin is answered with it too)', () => {
  assert.equal(canCreateOrg(null), false, 'not loaded yet: hidden');
  assert.equal(canCreateOrg([]), false);
  assert.equal(canCreateOrg(['orgs.create']), true);
});

test('managing and the directory by role: owner and admin manage; a guest sees no members', () => {
  assert.deepEqual((['owner', 'admin', 'member', 'guest'] as const).map(canManageOrg), [true, true, false, false]);
  assert.deepEqual((['owner', 'admin', 'member', 'guest'] as const).map(canSeeMembers), [true, true, true, false]);
});

test('role choices mirror the service: owners anything, admins up to admin and never an owner, others none', () => {
  assert.deepEqual(roleChoices('owner', 'owner'), ['owner', 'admin', 'member', 'guest']);
  assert.deepEqual(roleChoices('admin', 'member'), ['admin', 'member', 'guest']);
  assert.deepEqual(roleChoices('admin', 'owner'), []);
  assert.deepEqual(roleChoices('member', 'guest'), []);
  assert.deepEqual(roleChoices('guest', 'member'), []);
});

test('removing: never yourself (leave), an owner by an owner only, nobody by a member', () => {
  assert.equal(canRemoveMember('owner', 'owner', true), false);
  assert.equal(canRemoveMember('owner', 'owner', false), true);
  assert.equal(canRemoveMember('admin', 'owner', false), false);
  assert.equal(canRemoveMember('admin', 'member', false), true);
  assert.equal(canRemoveMember('member', 'guest', false), false);
});

test('the last-owner refusal reads plainly; other errors keep the server’s words', () => {
  const needsOwner = Object.assign(new Error('raw'), { details: { reason: 'ORG_NEEDS_OWNER' } });
  assert.match(orgErrorText(needsOwner, 'x'), /needs an owner/);
  assert.equal(orgErrorText(new Error('Only an owner removes an owner.'), 'x'), 'Only an owner removes an owner.');
  assert.equal(orgErrorText(null, 'Couldn’t.'), 'Couldn’t.');
});

test('Sign-in tab: owners and admins see it, only owners change Require SSO', () => {
  assert.deepEqual((['owner', 'admin', 'member', 'guest'] as const).map(canSeeSignIn), [true, true, false, false]);
  assert.deepEqual((['owner', 'admin', 'member', 'guest'] as const).map(canSetSsoPolicy), [true, false, false, false]);
});

test('token freshness: empty is off, whole days 1-365, anything else invalid', () => {
  assert.equal(parseFreshness(''), null);
  assert.equal(parseFreshness(' 7 '), 7);
  for (const bad of ['0', '366', '1.5', '-1', 'abc', '1000']) assert.equal(parseFreshness(bad), 'invalid', bad);
});

test('outside members: emails off the VERIFIED domains, never an owner; blank group rules are dropped', () => {
  const m = (userId: string, email: string, role: 'owner' | 'admin' | 'member' | 'guest') => ({ userId, email, displayName: userId, role, via: 'invite' as const, joinedAt: '' });
  const d = (domain: string, state: 'pending' | 'verified' | 'lost') => ({ domain, state, record: { name: '', value: '' }, verifiedAt: null, lastCheckedAt: null, failures: 0 });
  const members = [m('u_a', 'a@acme.test', 'admin'), m('u_b', 'b@other.test', 'member'), m('u_c', 'c@pending.test', 'member'), m('u_o', 'o@other.test', 'owner')];
  assert.deepEqual(
    outsideMembers(members, [d('acme.test', 'verified'), d('pending.test', 'pending')]).map((x) => x.userId),
    ['u_b', 'u_c'],
  );
  assert.deepEqual(cleanRules([{ group: ' admins ', role: 'admin' }, { group: '  ', role: 'member' }]), [{ group: 'admins', role: 'admin' }]);
});

test('the lock-out guard and a taken domain read plainly', () => {
  assert.match(orgErrorText(Object.assign(new Error('raw'), { details: { reason: 'SSO_LOCKOUT_GUARD' } }), 'x'), /locked out/);
  assert.match(orgErrorText(Object.assign(new Error('raw'), { details: { reason: 'DOMAIN_TAKEN' } }), 'x'), /already has that domain/);
});

test('a slug made from a name fits the server’s pattern', () => {
  for (const name of ['Acme', 'Konfersi Indonesia', '  Ünïcode -- Co. ', 'a'.repeat(80) + ' b']) {
    const s = slugFrom(name);
    assert.ok(s.length < 2 || ORG_SLUG_PATTERN.test(s), `${name} -> ${s}`);
  }
  assert.equal(slugFrom('Konfersi Indonesia'), 'konfersi-indonesia');
});

test('invitation roles mirror the service: never owner, never above your own; a guest invites nobody', () => {
  assert.deepEqual(inviteRoleChoices('owner'), ['admin', 'member', 'guest']);
  assert.deepEqual(inviteRoleChoices('admin'), ['admin', 'member', 'guest']);
  assert.deepEqual(inviteRoleChoices('member'), ['member', 'guest']);
  assert.deepEqual(inviteRoleChoices('guest'), []);
});

test('the invitation link carries the code in the fragment, and the accept page reads it back', () => {
  const code = ['k', 'Q', '9', '_', 'z'].join('').repeat(9);
  const link = inviteLink('https://pilot.example.test/', code);
  assert.equal(link, `https://pilot.example.test${ORG_INVITE_PATH}#${code}`);
  const url = new URL(link);
  assert.equal(url.search, '', 'nothing in the query (it would reach a server log)');
  assert.equal(inviteCodeFrom(url.hash), code);
  assert.equal(inviteCodeFrom(''), '');
  assert.equal(inviteCodeFrom('#%E0%A4%A'), '', 'a broken fragment is no code');
});

test('invitation refusals read plainly', () => {
  for (const [reason, words] of [
    ['INVITATION_INVALID', /not valid/],
    ['INVITATION_EXPIRED', /expired/],
    ['INVITATION_EMAIL_MISMATCH', /another email/],
  ] as const)
    assert.match(orgErrorText(Object.assign(new Error('raw'), { details: { reason } }), 'x'), words);
});
