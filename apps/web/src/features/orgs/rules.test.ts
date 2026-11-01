import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORG_SLUG_PATTERN } from '@portal/contracts';
import { canCreateOrg, canManageOrg, canRemoveMember, canSeeMembers, orgErrorText, roleChoices, slugFrom } from './rules';

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

test('a slug made from a name fits the server’s pattern', () => {
  for (const name of ['Acme', 'Konfersi Indonesia', '  Ünïcode -- Co. ', 'a'.repeat(80) + ' b']) {
    const s = slugFrom(name);
    assert.ok(s.length < 2 || ORG_SLUG_PATTERN.test(s), `${name} -> ${s}`);
  }
  assert.equal(slugFrom('Konfersi Indonesia'), 'konfersi-indonesia');
});
