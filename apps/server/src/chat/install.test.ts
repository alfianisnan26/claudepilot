import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workspaces } from '../workspaces/manager.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { CP_SESSION, CP_SESSION_PATH } from './host.js';
import { hostInstaller, IMAGE_HOST_OUTDATED } from './install.js';

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

/**
 * A Kubernetes-like workspace: no delivery, only exec (stdout and stderr merged). `cat` prints the
 * image's file in two chunks, or fails the way cat does; `unreachable` makes the exec itself fail and
 * `dropped` ends it without an exit status after half the file.
 */
function fakeKubernetes(file: string | null, opts: { unreachable?: boolean; dropped?: boolean } = {}) {
  const execs: string[] = [];
  const workspaces = {
    runtimeFor: () => ({ delivery: undefined }),
    exec: async (target: string, name: string, command: string[]): Promise<ExecSession> => {
      execs.push(`${target}/${name}: ${command.join(' ')}`);
      if (opts.unreachable) throw new Error('The workspace isn’t running.');
      const data: ((b: Buffer) => void)[] = [];
      const exits: ((code: number | null) => void)[] = [];
      const isCat = command[0] === 'cat' && command[1] === CP_SESSION_PATH && file !== null;
      const out = Buffer.from(isCat ? file : `cat: ${command[1]}: No such file or directory\n`);
      const half = out.subarray(0, out.length >> 1);
      setImmediate(() => {
        for (const chunk of opts.dropped ? [half] : [half, out.subarray(half.length)]) data.forEach((fn) => fn(chunk));
        exits.forEach((fn) => fn(opts.dropped ? null : isCat ? 0 : 1));
      });
      return { write: () => undefined, close: () => undefined, onData: (fn) => void data.push(fn), onExit: (fn) => void exits.push(fn) };
    },
  } as unknown as Workspaces;
  return { workspaces, execs };
}

test('installs the host root-owned, staged then renamed, when missing or out of date', async () => {
  const fake = fakeWorkspaces(null);
  await hostInstaller(fake.workspaces)('docker/api-dev');
  assert.equal(fake.file(), CP_SESSION);
  assert.ok(fake.calls.some((c) => /^put \/etc\/claudepilot\/bin\/\.cp-session\.[0-9a-f-]{36}\.cp-tmp file uid=0 mode=755/.test(c)));
  assert.ok(fake.calls.some((c) => c.startsWith('run(root) mv -f')));

  const stale = fakeWorkspaces('#!/bin/sh\necho old\n');
  await hostInstaller(stale.workspaces)('docker/api-dev');
  assert.equal(stale.file(), CP_SESSION);
});

test('leaves an up-to-date host alone', async () => {
  const fake = fakeWorkspaces(CP_SESSION);
  await hostInstaller(fake.workspaces)('docker/api-dev');
  assert.deepEqual(fake.calls, [`read ${CP_SESSION_PATH}`]);
});

test('kubernetes: uses the host the image ships when it is the current one', async () => {
  const fake = fakeKubernetes(CP_SESSION);
  await hostInstaller(fake.workspaces)('kubernetes/api-dev');
  assert.deepEqual(fake.execs, [`kubernetes/api-dev: cat ${CP_SESSION_PATH}`]);
});

test('kubernetes: refuses an image without the host, or with an older one, saying what to do', async () => {
  await assert.rejects(hostInstaller(fakeKubernetes(null).workspaces)('kubernetes/api-dev'), { message: IMAGE_HOST_OUTDATED });
  await assert.rejects(hostInstaller(fakeKubernetes('#!/bin/sh\necho old\n').workspaces)('kubernetes/api-dev'), { message: IMAGE_HOST_OUTDATED });
  // One byte off (a missing trailing newline) is still an older host.
  await assert.rejects(hostInstaller(fakeKubernetes(CP_SESSION.slice(0, -1)).workspaces)('kubernetes/api-dev'), { message: IMAGE_HOST_OUTDATED });
});

test('kubernetes: a dropped read fails without blaming the image; an unreachable workspace is left to start', async () => {
  await assert.rejects(hostInstaller(fakeKubernetes(CP_SESSION, { dropped: true }).workspaces)('kubernetes/api-dev'), /connection dropped/);
  // `start` goes through the same exec and fails the same way, leaving the session resumable.
  const down = fakeKubernetes(CP_SESSION, { unreachable: true });
  await hostInstaller(down.workspaces)('kubernetes/api-dev');
  assert.equal(down.execs.length, 1);
});

test('sessions started together share one install (no race on the staged file)', async () => {
  const fake = fakeWorkspaces(null);
  const install = hostInstaller(fake.workspaces);
  await Promise.all([install('docker/api-dev'), install('docker/api-dev'), install('docker/api-dev')]);
  assert.equal(fake.file(), CP_SESSION);
  assert.equal(fake.calls.filter((c) => c.startsWith('run(root) mv -f')).length, 1);
});
