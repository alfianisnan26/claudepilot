import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TERMINAL_MAX } from '@portal/contracts';
import type { Workspaces } from './manager.js';
import type { ExecSession } from './runtime.js';
import { attachCommand, cleanFolder, Terminals } from './terminals.js';

/**
 * A workspace with a fake tmux: `sessions` are its tmux sessions (name → created), `installed`
 * whether tmux is there, `installWorks` whether installing it succeeds. Records every command.
 */
function fakeWorkspace(opts: { installed?: boolean; installWorks?: boolean; sessions?: Record<string, number> } = {}) {
  const commands: string[][] = [];
  const sessions = new Map(Object.entries(opts.sessions ?? {}));
  let installed = opts.installed ?? true;
  const reply = (command: string[]): { out: string; code: number } => {
    const script = command[0] === 'sh' ? (command[2] ?? '') : '';
    if (script.includes('tmux list-sessions')) {
      if (!installed) return { out: '', code: 0 };
      const format = command[4] ?? '';
      assert.equal(format.split('\t').length, 6, 'six tab-separated fields');
      // tmux names the pane's shell; the program it started is its child (see the `ps` reply).
      return { out: [...sessions].map(([s, at], i) => `${s}\t${at}\t0\t/home/node/work\tbash\t${s.includes('claude') ? 100 : 200 + i}`).join('\n'), code: 0 };
    }
    if (script === 'command -v tmux') return { out: installed ? '/usr/bin/tmux\n' : '', code: installed ? 0 : 1 };
    if (script.includes('apt-get')) {
      if (opts.installWorks === false) return { out: 'needs passwordless sudo to install tmux\n', code: 4 };
      installed = true;
      return { out: '', code: 0 };
    }
    if (script.includes('tmux new-session')) {
      const [folder, session] = [command[4], command[5]!];
      if (folder === '/nope') return { out: 'No folder /nope\n', code: 3 };
      sessions.set(session, 1_760_000_000 + sessions.size);
      return { out: '', code: 0 };
    }
    if (command[0] === 'ps') {
      assert.deepEqual(command.slice(0, 4), ['ps', '-o', 'ppid=,comm=', '--ppid']);
      // Claude's pane (PID 100) runs Claude Code; the others have nothing running under their shell.
      return { out: command[4]!.split(',').includes('100') ? '  100 claude\n  100 node\n' : '', code: 0 };
    }
    if (command[0] === 'tmux' && command[1] === 'kill-session') return sessions.delete(command[3]!) ? { out: '', code: 0 } : { out: "can't find session\n", code: 1 };
    return { out: '', code: 127 };
  };
  const workspaces = {
    exec: async (_t: string, _n: string, command: string[]): Promise<ExecSession> => {
      commands.push(command);
      const data: ((b: Buffer) => void)[] = [];
      const exits: ((c: number | null) => void)[] = [];
      setTimeout(() => {
        const r = reply(command);
        if (r.out) data.forEach((fn) => fn(Buffer.from(r.out)));
        exits.forEach((fn) => fn(r.code));
      }, 1);
      return { write: () => undefined, close: () => undefined, onData: (fn) => void data.push(fn), onExit: (fn) => void exits.push(fn) };
    },
  } as unknown as Workspaces;
  let claudeInstalls = 0;
  const claude = { ensureInstalled: async () => void claudeInstalls++ };
  return { terminals: new Terminals(workspaces, claude), commands, sessions, claudeInstalls: () => claudeInstalls };
}

test('folders are ~, ~/… or absolute, on one line; empty means home', () => {
  assert.equal(cleanFolder(''), '~');
  assert.equal(cleanFolder('  ~/work/api '), '~/work/api');
  assert.equal(cleanFolder('/srv/app'), '/srv/app');
  for (const bad of ['work', '../etc', '~root', 'a\nb', '/x\0y', 'x'.repeat(5000)]) assert.throws(() => cleanFolder(bad), /Use a folder like/);
});

test('attaching is tmux’s own client onto one of ours, nothing else', () => {
  assert.deepEqual(attachCommand('claude-2'), ['tmux', 'attach-session', '-t', 'cp-claude-2']);
  for (const bad of ['claude-0', 'claude', 'cp-claude-1', 'shell-1;rm', 'other-1', 'claude-100']) assert.throws(() => attachCommand(bad));
});

test('only the portal’s tmux sessions are listed, oldest first', async () => {
  const fake = fakeWorkspace({ sessions: { 'cp-shell-1': 1_760_000_200, 'cp-claude-1': 1_760_000_100, mine: 1_760_000_000, 'cp-weird': 1 } });
  const list = await fake.terminals.list('docker', 'api');
  assert.deepEqual(
    list.map((t) => [t.id, t.kind, t.cwd, t.command]),
    [
      ['claude-1', 'claude', '/home/node/work', 'claude'],
      ['shell-1', 'shell', '/home/node/work', 'bash'],
    ],
  );
  assert.equal(list[0]!.createdAt, new Date(1_760_000_100_000).toISOString());
});

test('no tmux yet means no terminals, not an error', async () => {
  assert.deepEqual(await fakeWorkspace({ installed: false }).terminals.list('local', 'local'), []);
});

test('a new Claude terminal gets the next free number, Claude Code installed first, folder and program as arguments', async () => {
  const fake = fakeWorkspace({ sessions: { 'cp-claude-1': 1_760_000_000 } });
  const t = await fake.terminals.create('docker', 'api', { kind: 'claude', cwd: '~/work/api' });
  assert.equal(t.id, 'claude-2');
  assert.equal(fake.claudeInstalls(), 1);
  const made = fake.commands.find((c) => c[2]?.includes('tmux new-session'))!;
  assert.deepEqual(made.slice(3, 6), ['sh', '~/work/api', 'cp-claude-2']);
  assert.match(made[6]!, /claude; exec "\$\{SHELL:-bash\}" -l$/);
  assert.equal(made[7], 'claude', 'the window is named after its kind');
  assert.match(made[2]!, /new-session -d -s "\$2" -n "\$4" -x 160 -y 48 -c "\$d" "\$3" \|\| exit \$\?/);
  assert.match(made[2]!, /status off.*mouse on/);
});

test('a shell terminal doesn’t need Claude Code', async () => {
  const fake = fakeWorkspace();
  assert.equal((await fake.terminals.create('docker', 'api', { kind: 'shell' })).id, 'shell-1');
  assert.equal(fake.claudeInstalls(), 0);
});

test(`at most ${TERMINAL_MAX} terminals per workspace`, async () => {
  const sessions = Object.fromEntries(Array.from({ length: TERMINAL_MAX }, (_, i) => [`cp-claude-${i + 1}`, 1_760_000_000 + i]));
  const fake = fakeWorkspace({ sessions });
  await assert.rejects(fake.terminals.create('docker', 'api', { kind: 'claude' }), { code: 'CONFLICT' });
  assert.ok(!fake.commands.some((c) => c[2]?.includes('tmux new-session')));
});

test('a missing folder is a validation error naming it', async () => {
  const fake = fakeWorkspace();
  await assert.rejects(fake.terminals.create('docker', 'api', { kind: 'shell', cwd: '/nope' }), (e: Error & { code?: string }) => {
    assert.equal(e.code, 'VALIDATION_FAILED');
    assert.match(e.message, /No folder \/nope/);
    return true;
  });
});

test('tmux is installed with sudo when missing, once, then the terminal opens', async () => {
  const fake = fakeWorkspace({ installed: false });
  const [a, b] = await Promise.all([
    fake.terminals.create('local', 'local', { kind: 'shell' }),
    fake.terminals.create('local', 'local', { kind: 'shell' }).catch(() => null),
  ]);
  assert.equal(a.id, 'shell-1');
  assert.ok(b === null || b.id.startsWith('shell-'));
  assert.equal(fake.commands.filter((c) => c[2]?.includes('apt-get')).length, 1, 'one install for both');
  assert.match(fake.commands.find((c) => c[2]?.includes('apt-get'))![2]!, /sudo -n .*apt-get install -y -qq tmux/);
});

test('when tmux can’t be installed, the reason is shown', async () => {
  const fake = fakeWorkspace({ installed: false, installWorks: false });
  await assert.rejects(fake.terminals.create('local', 'local', { kind: 'claude' }), (e: Error & { expose?: boolean }) => {
    assert.match(e.message, /tmux isn’t installed in this workspace and couldn’t be installed: needs passwordless sudo/);
    assert.equal(e.expose, true);
    return true;
  });
  assert.equal(fake.claudeInstalls(), 0);
});

test('closing kills that tmux session; an unknown one is not found', async () => {
  const fake = fakeWorkspace({ sessions: { 'cp-claude-1': 1_760_000_000 } });
  await fake.terminals.close('docker', 'api', 'claude-1');
  assert.equal(fake.sessions.size, 0);
  await assert.rejects(fake.terminals.close('docker', 'api', 'claude-1'), { code: 'NOT_FOUND' });
  await assert.rejects(fake.terminals.close('docker', 'api', 'mine'), { code: 'NOT_FOUND' });
});
