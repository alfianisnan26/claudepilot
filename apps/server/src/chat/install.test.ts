import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workspaces } from '../workspaces/manager.js';
import { CP_SESSION, CP_SESSION_PATH } from './host.js';
import { hostInstaller } from './install.js';

/** A Docker-like workspace: reads, archive writes and root commands, recorded. */
function fakeWorkspaces(initial: string | null) {
  let file = initial;
  const calls: string[] = [];
  const staged = new Map<string, string>();
  const access = {
    read: async (_n: string, path: string) => (calls.push(`read ${path}`), path === CP_SESSION_PATH ? file : null),
    put: async (_n: string, entries: { path: string; type: string; content?: string; uid: number; mode: number }[]) => {
      for (const e of entries) {
        calls.push(`put ${e.path} ${e.type} uid=${e.uid} mode=${e.mode.toString(8)}`);
        if (e.type === 'file') staged.set(e.path, e.content ?? '');
      }
    },
    run: async (_n: string, script: string, opts?: { user?: string }) => {
      calls.push(`run(${opts?.user}) ${script}`);
      const m = /mv -f '([^']+)' '([^']+)'/.exec(script);
      if (m && m[2] === CP_SESSION_PATH) file = staged.get(m[1]!) ?? null;
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  const workspaces = { runtimeFor: (t: string) => (t === 'docker' ? { delivery: access } : { delivery: undefined }) } as unknown as Workspaces;
  return { workspaces, calls, file: () => file };
}

test('installs the host root-owned, staged then renamed, when missing or out of date', async () => {
  const fake = fakeWorkspaces(null);
  await hostInstaller(fake.workspaces)('docker/api-dev');
  assert.equal(fake.file(), CP_SESSION);
  assert.ok(fake.calls.some((c) => c.startsWith(`put /etc/claudepilot/bin/.cp-session.cp-tmp file uid=0 mode=755`)));
  assert.ok(fake.calls.some((c) => c.startsWith('run(root) mv -f')));

  const stale = fakeWorkspaces('#!/bin/sh\necho old\n');
  await hostInstaller(stale.workspaces)('docker/api-dev');
  assert.equal(stale.file(), CP_SESSION);
});

test('leaves an up-to-date host alone, and refuses targets without delivery', async () => {
  const fake = fakeWorkspaces(CP_SESSION);
  await hostInstaller(fake.workspaces)('docker/api-dev');
  assert.deepEqual(fake.calls, [`read ${CP_SESSION_PATH}`]);
  await assert.rejects(hostInstaller(fake.workspaces)('kubernetes/api-dev'), /Docker workspaces/);
});
