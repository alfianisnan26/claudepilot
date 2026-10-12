// The adapter that reaches a workspace's session host through the runtime's exec: what it runs, how it gathers the answer, when it gives up.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CP_SESSION_PATH } from '../chat/host.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { workspacesHost } from './host.js';

function fakeExec(answer: { out?: string; code?: number | null; hang?: boolean }) {
  const seen: { target: string; name: string; command: string[]; closed: number }[] = [];
  const workspaces = {
    exec: async (target: string, name: string, command: string[]): Promise<ExecSession> => {
      const entry = { target, name, command, closed: 0 };
      seen.push(entry);
      let onData: (b: Buffer) => void = () => undefined;
      let onExit: (c: number | null) => void = () => undefined;
      if (!answer.hang) setImmediate(() => (onData(Buffer.from(answer.out ?? '')), onExit(answer.code ?? 0)));
      return { write: () => undefined, close: () => void entry.closed++, onData: (fn) => (onData = fn), onExit: (fn) => (onExit = fn) };
    },
  };
  return { seen, workspaces };
}

test('reading runs niced, acting does not; the workspace id is split into target and name; the output and the exit code come back', async () => {
  const f = fakeExec({ out: 'hello\n', code: 3 });
  const host = workspacesHost(f.workspaces, async () => undefined);
  assert.deepEqual(await host.run('docker/my-ws', ['repo-state', '/home/node/a', '-']), { code: 3, out: 'hello\n' });
  await host.run('docker/my-ws', ['repo-find', '~', '6', '300']);
  await host.run('local/this', ['repo-sync', '/home/node/a']);
  await host.run('docker/my-ws', ['wt-add', '/home/node/a', 'leaf', 'branch', '-']);
  assert.deepEqual(f.seen.map((s) => [s.target, s.name, s.command.slice(0, 4)]), [
    ['docker', 'my-ws', ['nice', '-n', '10', 'sh']],
    ['docker', 'my-ws', ['nice', '-n', '10', 'sh']],
    ['local', 'this', ['sh', CP_SESSION_PATH, 'repo-sync', '/home/node/a']],
    ['docker', 'my-ws', ['sh', CP_SESSION_PATH, 'wt-add', '/home/node/a']],
  ]);
  assert.deepEqual(f.seen[0]!.command.slice(4), [CP_SESSION_PATH, 'repo-state', '/home/node/a', '-']);
  assert.ok(f.seen.every((s) => s.closed === 1), 'every exec is closed after it ends');
});

test('a command that does not end in time is closed and reads as failed (no exit code); the install is the caller’s own', async () => {
  const f = fakeExec({ hang: true });
  let installed = '';
  const host = workspacesHost(f.workspaces, async (id) => void (installed = id), 30);
  assert.deepEqual(await host.run('docker/w', ['repo-find', '~', '6', '3']), { code: null, out: '' });
  assert.equal(f.seen[0]!.closed, 1);
  await host.ensure('docker/w');
  assert.equal(installed, 'docker/w');
});
