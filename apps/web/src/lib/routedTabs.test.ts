// Tabs as sub-routes (owner request 2026-11-01): the path picks the tab, legacy `?tab=` links move to the sub-route, and a member never gets
// an admin's tab. Also the Settings page's grouping and which pages keep one frame across their tabs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTINGS_BASE, SETTINGS_TABS, settingsTabOf } from '../features/settings/tabs';
import { pageKey, resolveTab, shownTabs, tabHref, tabSegment, type TabDef } from './routedTabs';

const TABS: TabDef[] = [
  { id: 'general', label: 'General' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'people', label: 'People', adminOnly: true },
  { id: 'later', label: 'Later', hidden: true },
];
const BASE = '/admin/settings';
const ids = (tabs: TabDef[]) => tabs.map((t) => t.id);

test('a member sees only the tabs that are not an admin’s; hidden tabs show to nobody', () => {
  assert.deepEqual(ids(shownTabs(TABS, { admin: true })), ['general', 'sessions', 'people']);
  assert.deepEqual(ids(shownTabs(TABS, { admin: false })), ['general', 'sessions']);
});

test('the segment after the base names the tab; a deeper path is another page’s', () => {
  assert.equal(tabSegment('/admin/settings', BASE), '');
  assert.equal(tabSegment('/admin/settings/', BASE), '');
  assert.equal(tabSegment('/admin/settings/sessions', BASE), 'sessions');
  assert.equal(tabSegment('/admin/settings/sign%2Din', BASE), 'sign-in');
  assert.equal(tabSegment('/admin/pools/skills/library', '/admin/pools'), null);
  assert.equal(tabSegment('/admin/settingsx', BASE), null);
  assert.equal(tabSegment('/admin/other', BASE), null);
});

test('the first tab lives at the page’s own path, the others under it', () => {
  const shown = shownTabs(TABS, { admin: true });
  assert.equal(tabHref(BASE, shown, 'general'), '/admin/settings');
  assert.equal(tabHref(`${BASE}/`, shown, 'people'), '/admin/settings/people');
});

test('the path opens its tab; the base and base/<first> open the first', () => {
  const shown = shownTabs(TABS, { admin: true });
  assert.deepEqual(resolveTab(shown, BASE, '/admin/settings'), { active: shown[0], redirect: null });
  assert.deepEqual(resolveTab(shown, BASE, '/admin/settings/general'), { active: shown[0], redirect: null });
  assert.deepEqual(resolveTab(shown, BASE, '/admin/settings/people'), { active: shown[2], redirect: null });
});

test('an unknown tab, or one this person may not see, goes to the first tab (keeping the query)', () => {
  const member = shownTabs(TABS, { admin: false });
  assert.deepEqual(resolveTab(member, BASE, '/admin/settings/people'), { active: undefined, redirect: '/admin/settings' });
  assert.deepEqual(resolveTab(member, BASE, '/admin/settings/nope', '?a=1'), { active: undefined, redirect: '/admin/settings?a=1' });
  assert.equal(resolveTab(member, BASE, '/admin/settings/later').redirect, '/admin/settings', 'a hidden tab is not reachable by its path');
});

test('a legacy ?tab= link moves to the sub-route with its other parameters', () => {
  const shown = shownTabs(TABS, { admin: true });
  assert.equal(resolveTab(shown, BASE, '/admin/settings', '?tab=sessions').redirect, '/admin/settings/sessions');
  assert.equal(resolveTab(shown, '/admin/ci', '/admin/ci', '?tab=remotes&repo=r1').redirect, '/admin/ci?repo=r1', 'unknown here: the base, the rest kept');
  const ci: TabDef[] = [{ id: 'runs', label: 'Runs' }, { id: 'remotes', label: 'Remotes' }];
  assert.equal(resolveTab(ci, '/admin/ci', '/admin/ci', '?tab=remotes&repo=r1&branch=main').redirect, '/admin/ci/remotes?repo=r1&branch=main');
  assert.equal(resolveTab(ci, '/admin/ci', '/admin/ci', '?tab=runs').redirect, '/admin/ci', 'the first tab is the base');
  assert.equal(resolveTab(shown, BASE, '/admin/settings', '?tab=people').redirect, '/admin/settings/people');
  assert.equal(resolveTab(shownTabs(TABS, { admin: false }), BASE, '/admin/settings', '?tab=people').redirect, '/admin/settings', 'a member’s legacy link to an admin tab: the first tab');
});


test('a tabbed page keeps one frame across its tabs; other paths keep their own', () => {
  assert.equal(pageKey('/admin/settings'), '/admin/settings');
  assert.equal(pageKey('/admin/settings/sessions'), '/admin/settings');
  assert.equal(pageKey('/admin/orgs/org_1/members'), '/admin/orgs/org_1');
  assert.equal(pageKey('/admin/orgs/org_1'), '/admin/orgs/org_1');
  assert.equal(pageKey('/admin/pools/skills'), '/admin/pools');
  assert.equal(pageKey('/admin/pools/skills/library'), '/admin/pools/skills/library', 'a pool type’s own page is a page');
  assert.equal(pageKey('/admin/ci/runs/run_1'), '/admin/ci/runs/run_1');
  assert.equal(pageKey('/admin/workspaces'), '/admin/workspaces');
});

test('Settings: six tabs, every server group has one, an unknown group lands in General', () => {
  assert.deepEqual(
    SETTINGS_TABS.map((t) => t.id),
    ['general', 'agents', 'sessions', 'claude', 'people', 'glance'],
  );
  assert.ok(SETTINGS_TABS.every((t) => t.adminOnly), 'the whole page is a platform area');
  assert.deepEqual(shownTabs(SETTINGS_TABS, { admin: false }), []);
  assert.equal(SETTINGS_BASE, '/admin/settings');
  for (const [group, tab] of Object.entries({ mcp: 'agents', agents: 'agents', sessions: 'sessions', keepgoing: 'sessions', flow: 'sessions', automove: 'sessions', claude: 'claude', usage: 'general', ci: 'general', tickets: 'general', notify: 'general', triggers: 'general', brandnew: 'general' }))
    assert.equal(settingsTabOf(group), tab, group);
});
