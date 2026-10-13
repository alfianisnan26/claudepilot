// T-99 item 2: after a workspace's pod restarts, /etc/claudepilot/bin/cp-ci is gone (it lives in the container, the home volume stays)
// while WorkspacesCiHost.install remembered it as installed for recheckMs: every cp() then ran a missing file and CI was dead for ten
// minutes ("The workspace did not answer in time."). Now a run that gives no reply, or exit 126/127, with a runner that is missing or
// stale, forgets the mark, installs again and tries once more; a workspace seen stopped forgets the mark too.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Workspaces } from '../workspaces/manager.js';
import { CiUnreachable, CP_CI_PATH, WorkspacesCiHost } from './host.js';
import { CP_CI } from './runner.generated.js';

/** A workspace whose files the test can take away, and whose cp-ci answers only when the current runner is there. */
function fakeWorkspaces(opts: { missingHangs?: boolean; alwaysHangs?: boolean } = {}) {
  const files = new Map<string, string>();
  const calls = { exec: 0, put: 0 };
  let running = true;
  const delivery = {
    state: async () => ({ exists: true, running }),
    read: async (_name: string, path: string) => files.get(path) ?? null,
    put: async (_name: string, entries: { path: string; type: string; content?: string }[]) => {
      calls.put++;
      for (const e of entries) if (e.type === 'file') files.set(e.path, e.content ?? '');
    },
    run: async (_name: string, script: string) => {
      const m = /^mv -f '([^']+)' '([^']+)'$/.exec(script);
      if (m) {
        files.set(m[2]!, files.get(m[1]!) ?? '');
        files.delete(m[1]!);
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  const exec = async (_target: string, _name: string, command: string[]) => {
    calls.exec++;
    const present = files.get(command[0]!) === CP_CI;
    const data: ((b: Buffer) => void)[] = [];
    const exits: ((c: number | null) => void)[] = [];
    setTimeout(() => {
      if (opts.alwaysHangs) return;
      if (present) {
        for (const f of data) f(Buffer.from(`@cpci ${JSON.stringify({ ok: true, args: command.slice(1) })}\n`));
        for (const f of exits) f(0);
      } else if (!opts.missingHangs) for (const f of exits) f(127);
    }, 1);
    return {
      write() {},
      close() {},
      onData(f: (b: Buffer) => void) {
        data.push(f);
      },
      onExit(f: (c: number | null) => void) {
        exits.push(f);
      },
    };
  };
  const ws = {
    runtimeFor: () => ({ delivery }),
    exec,
    list: async () => [{ id: 'docker/a', status: running ? 'running' : 'stopped' }],
  } as unknown as Workspaces;
  return { ws, files, calls, stop: () => void (running = false) };
}

test('the runner vanished with the container (exit 127): the install mark is forgotten, the runner installed again and the command answered', async () => {
  const w = fakeWorkspaces();
  const host = new WorkspacesCiHost(w.ws);
  await host.install('docker/a');
  assert.equal(w.calls.put, 1);
  assert.equal(w.files.get(CP_CI_PATH), CP_CI);
  await host.install('docker/a');
  assert.equal(w.calls.put, 1, 'remembered as installed');
  w.files.clear(); // the pod restarted
  const reply = (await host.cp('docker/a', ['status'])) as { ok: boolean; args: string[] };
  assert.deepEqual(reply, { ok: true, args: ['status'] });
  assert.equal(w.calls.put, 2, 'installed again');
  assert.equal(w.calls.exec, 2, 'run once more');
});

test('no reply at all from a missing runner (a Kubernetes exec that hangs) is treated the same: install again, try once more', async () => {
  const w = fakeWorkspaces({ missingHangs: true });
  const host = new WorkspacesCiHost(w.ws);
  await host.install('docker/a');
  w.files.clear();
  const reply = (await host.cp('docker/a', ['status'], { timeoutMs: 30 })) as { ok: boolean };
  assert.equal(reply.ok, true);
  assert.equal(w.calls.put, 2);
  assert.equal(w.calls.exec, 2);
});

test('a current runner that only takes too long is not run again (the command may have run) and the mark stays', async () => {
  const w = fakeWorkspaces({ alwaysHangs: true });
  const host = new WorkspacesCiHost(w.ws);
  await host.install('docker/a');
  await assert.rejects(host.cp('docker/a', ['start', 'r1'], { timeoutMs: 30 }), (e: unknown) => e instanceof CiUnreachable && /did not answer in time/.test(e.message));
  assert.equal(w.calls.exec, 1, 'not retried');
  assert.equal(w.calls.put, 1, 'not installed again');
  await host.install('docker/a');
  assert.equal(w.calls.put, 1, 'still remembered');
});

test('a workspace seen stopped (state or the list) forgets the mark: the next install puts the runner back', async () => {
  const w = fakeWorkspaces();
  const host = new WorkspacesCiHost(w.ws);
  await host.install('docker/a');
  w.stop();
  assert.equal(await host.state('docker/a'), 'stopped');
  w.files.clear();
  await host.install('docker/a');
  assert.equal(w.calls.put, 2, 'installed again after it was seen stopped');

  const again = fakeWorkspaces();
  const host2 = new WorkspacesCiHost(again.ws);
  await host2.install('docker/a');
  again.stop();
  assert.equal((await host2.states()).get('docker/a'), 'stopped');
  again.files.clear();
  await host2.install('docker/a');
  assert.equal(again.calls.put, 2, 'the list forgets it too');
});
