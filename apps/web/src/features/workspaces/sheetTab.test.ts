// The workspace sheet shows one tab at a time (owner request 2026-11-01): Claudes first when it has them, Repos only where repositories are
// scanned, and a tab asked for that this workspace lacks falls back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sheetTab, sheetTabs } from './sheetTab';

const values = (has: { claudes: boolean; repos: boolean }) => sheetTabs(has).map((t) => t.value);

test('the tabs a workspace offers: Claudes while it runs, Repos where repositories are scanned, Details always', () => {
  assert.deepEqual(values({ claudes: true, repos: true }), ['claudes', 'details', 'repos']);
  assert.deepEqual(values({ claudes: false, repos: true }), ['details', 'repos']);
  assert.deepEqual(values({ claudes: true, repos: false }), ['claudes', 'details'], 'Kubernetes: no Repos');
  assert.deepEqual(values({ claudes: false, repos: false }), ['details'], 'one tab: the sheet shows no switch');
});

test('the row opens on Claudes (or Details), the repositories chip on Repos', () => {
  assert.equal(sheetTab(undefined, { claudes: true, repos: true }), 'claudes');
  assert.equal(sheetTab(undefined, { claudes: false, repos: true }), 'details', 'a stopped workspace has no Claudes tab');
  assert.equal(sheetTab('repos', { claudes: true, repos: true }), 'repos');
  assert.equal(sheetTab('details', { claudes: true, repos: true }), 'details');
});

test('a tab this workspace lacks falls back', () => {
  assert.equal(sheetTab('repos', { claudes: true, repos: false }), 'claudes');
  assert.equal(sheetTab('claudes', { claudes: false, repos: true }), 'details', 'it stopped while the sheet was open');
});
