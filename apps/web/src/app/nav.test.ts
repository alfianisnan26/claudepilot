// D-82 S1a (member access): a member's navigation has no platform areas (their routes are `platform(*)` on the server) and has Shared; an
// admin's is every item as before, without Shared. A platform page's path sends a member home (App.tsx).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authStateOf, isAdminState } from '../lib/authState';
import { NAV, isAdminOnlyPath, navFor } from './nav';

const ids = (items: { id: string }[]) => items.map((i) => i.id);

test('a member’s navigation: the work pages and Notifications, never Usage, Schedules, Pools, Targets, Access or Settings', () => {
  const member = navFor(false);
  for (const id of ['usage', 'schedules', 'pools', 'targets', 'access', 'settings']) assert.ok(!ids(member.items).includes(id), id);
  for (const id of ['home', 'attention', 'workspaces', 'sessions', 'tickets', 'knowledge', 'ci', 'notifications', 'shared']) assert.ok(ids(member.items).includes(id), id);
  assert.deepEqual(ids(member.bar), ['home', 'workspaces', 'sessions', 'tickets']);
  assert.deepEqual([...ids(member.bar), ...ids(member.more)].sort(), ids(member.items).sort(), 'bar and More hold every item once');
  assert.ok(member.groups.flat().every((i) => !i.adminOnly));
});

test('an admin’s navigation is every item as before (Shared is a member’s only)', () => {
  const admin = navFor(true);
  assert.deepEqual(ids(admin.items), ids(NAV.filter((i) => i.id !== 'shared')));
  assert.equal(admin.groups.length, 2, 'work, then admin');
});

test('platform paths, and the session answer to the app state', () => {
  assert.equal(isAdminOnlyPath('/admin/pools'), true);
  assert.equal(isAdminOnlyPath('/admin/pools/skills/library'), true);
  assert.equal(isAdminOnlyPath('/admin/settings'), true);
  assert.equal(isAdminOnlyPath('/admin/sessions/abc'), false);
  assert.equal(isAdminOnlyPath('/admin/poolside'), false, 'a prefix of a name is not the page');
  assert.equal(isAdminOnlyPath('/admin/notifications'), false);
  assert.deepEqual(authStateOf({ authenticated: true, enabled: true, member: true }), { status: 'in', admin: false });
  assert.deepEqual(authStateOf({ authenticated: true, enabled: true, member: false }), { status: 'in', admin: true });
  assert.deepEqual(authStateOf({ authenticated: false, enabled: false, emailSignIn: true }), { status: 'out', enabled: false, emailSignIn: true });
  assert.equal(isAdminState({ status: 'in', admin: false }), false);
  assert.equal(isAdminState({ status: 'loading' }), false);
});
