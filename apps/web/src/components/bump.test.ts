import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BumpTarget } from '@portal/contracts';
import { firstPick, spansWorkspaces, targetLine } from './bump';

const t = (id: string, over: Partial<BumpTarget> = {}): BumpTarget => ({ id, title: id, state: 'idle', workspaceId: 'docker/api', lastActivityAt: '', preferred: false, refusal: null, ...over });

test('the first pick: the preferred session when it can take the bump, else the first that can, else none', () => {
  assert.equal(firstPick([t('a'), t('pref', { preferred: true })]), 'pref');
  assert.equal(firstPick([t('pref', { preferred: true, refusal: 'waiting' }), t('b'), t('c')]), 'b');
  assert.equal(firstPick([t('x', { refusal: 'ended' })]), '');
  assert.equal(firstPick([]), '');
});

test('a row says its state, or why it can’t; the workspace when it matters', () => {
  assert.equal(targetLine(t('a', { state: 'working' }), false), 'Working');
  assert.equal(targetLine(t('a', { state: 'waiting', refusal: 'waiting' }), false), 'Waiting on an approval');
  assert.equal(targetLine(t('a', { workspaceId: 'docker/web', refusal: 'other_workspace' }), false), 'Another workspace · docker/web');
  assert.equal(targetLine(t('a'), true), 'Idle · docker/api');
  assert.equal(spansWorkspaces([t('a'), t('b')]), false);
  assert.equal(spansWorkspaces([t('a'), t('b', { workspaceId: 'docker/web' })]), true);
});
