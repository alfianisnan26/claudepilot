import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PortalAgentWorkspace } from '@portal/contracts';
import { invalidWorkspaceKeys, settingsPayload, toggleWorkspace, workspaceChoices } from './agentWorkspaces';

const ws = (workspaceId: string): PortalAgentWorkspace => ({ workspaceId, name: workspaceId.split('/')[1]!, enabled: true, liveTokens: 0 });

test('T-436: the save payload carries the chosen workspaces, sorted, with the other settings', () => {
  assert.deepEqual(settingsPayload({ rewrite: true, labels: 'heading', agentWorkspaces: ['kubernetes/web', 'docker/api'] }), {
    rewriteLinksOnRename: true,
    labels: 'heading',
    agentWorkspaces: ['docker/api', 'kubernetes/web'],
  });
  // None chosen is sent as an empty list (it clears the grants), never left out.
  assert.deepEqual(settingsPayload({ rewrite: false, labels: 'filename', agentWorkspaces: [] }).agentWorkspaces, []);
});

test('T-436: ticking and clearing a box adds and removes one workspace, with no duplicates', () => {
  assert.deepEqual(toggleWorkspace([], 'docker/api', true), ['docker/api']);
  assert.deepEqual(toggleWorkspace(['docker/api'], 'docker/api', true), ['docker/api']);
  assert.deepEqual(toggleWorkspace(['docker/api', 'kubernetes/web'], 'docker/api', false), ['kubernetes/web']);
  assert.deepEqual(toggleWorkspace(['kubernetes/web'], 'docker/api', false), ['kubernetes/web']);
});

test('T-436: a listed workspace the portal no longer shows stays a ticked row, so a save does not drop it silently', () => {
  const rows = workspaceChoices([ws('kubernetes/web'), ws('docker/api')], ['docker/api', 'docker/old']);
  assert.deepEqual(
    rows.map((r) => [r.workspaceId, r.checked, r.gone]),
    [
      ['docker/api', true, false],
      ['docker/old', true, true],
      ['kubernetes/web', false, false],
    ],
  );
});

test('T-436 S2: a listed key that is not <target>/<name> is named, and its row is flagged invalid', () => {
  assert.deepEqual(invalidWorkspaceKeys(['docker/api', 'bad key', 'bad key']), ['bad key']);
  assert.deepEqual(invalidWorkspaceKeys(['docker/api']), []);
  const rows = workspaceChoices([ws('docker/api')], ['docker/api', 'bad key']);
  assert.deepEqual(rows.map((r) => [r.workspaceId, r.invalid]), [['bad key', true], ['docker/api', false]]);
});
