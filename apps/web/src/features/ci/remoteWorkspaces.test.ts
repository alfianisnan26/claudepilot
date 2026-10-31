import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workspace } from '@portal/contracts';
import { remoteWorkspaces } from './remoteWorkspaces';

const ws = (target: string, name: string, status: Workspace['status'] = 'running') => ({ id: `${target}/${name}`, name, target, image: '', status, createdAt: '' }) as Workspace;

test('Kubernetes workspaces are left out by the target kind, an org target (PORTAL_K8S_TARGETS) as much as `kubernetes`', () => {
  const targets = [
    { id: 'docker', kind: 'docker' as const },
    { id: 'kubernetes', kind: 'kubernetes' as const },
    { id: 'konfersi', kind: 'kubernetes' as const },
  ];
  const got = remoteWorkspaces([ws('docker', 'a'), ws('kubernetes', 'b'), ws('konfersi', 'c'), ws('docker', 'd', 'stopped')], targets);
  assert.deepEqual(got.map((w) => w.id), ['docker/a']);
});
