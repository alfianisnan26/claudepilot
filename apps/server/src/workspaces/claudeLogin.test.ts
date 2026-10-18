import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeLogins, cleanCode, cleanEmail, signInLink } from './claudeLogin.js';
import type { Workspaces } from './manager.js';
import type { ExecSession } from './runtime.js';

const LINK = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y';

test('only https links on Anthropic hosts are shown', () => {
  assert.equal(signInLink(`Opening browser to sign in…\nIf the browser didn't open, visit: ${LINK}\nPaste code here if prompted >`), LINK);
  assert.equal(signInLink('visit: https://claude.ai/oauth/x'), 'https://claude.ai/oauth/x');
  assert.equal(signInLink('visit: https://claude.com.evil.example/oauth'), null);
  assert.equal(signInLink('visit: http://claude.com/oauth'), null);
  assert.equal(signInLink('no link yet'), null);
});

test('codes are one line of the characters the callback page uses', () => {
  assert.equal(cleanCode('  abcDEF123_-.~#state99  '), 'abcDEF123_-.~#state99');
  for (const bad of ['', 'short', 'two\nlines-0000', 'has space 000', 42]) assert.throws(() => cleanCode(bad), /whole code/);
});

test('emails are prefilled only when they look like an address', () => {
  assert.equal(cleanEmail('me@example.com'), 'me@example.com');
  assert.equal(cleanEmail('  Dev.User@corp.example  '), 'Dev.User@corp.example');
  for (const bad of ['', 'nope', 'a@', '@b', 'a b@c', 42, '"x"@y']) assert.equal(cleanEmail(bad), null);
});

/**
 * A fake `claude auth login`: answers the code with `answer`, and records every command run.
 * `installed`: whether Claude Code is there at first; `installWorks`: whether its installer succeeds.
 */
function fakeWorkspaces(
  answer: (code: string, s: { out: (t: string) => void; exit: (c: number) => void }) => void,
  opts: { installed?: boolean; installWorks?: boolean } = {},
) {
  const commands: string[][] = [];
  let killed = false;
  let installed = opts.installed ?? true;
  const workspaces = {
    exec: async (_t: string, _n: string, command: string[]): Promise<ExecSession> => {
      commands.push(command);
      const data: ((b: Buffer) => void)[] = [];
      const exits: ((c: number | null) => void)[] = [];
      const out = (t: string) => data.forEach((fn) => fn(Buffer.from(t)));
      const exit = (c: number) => exits.forEach((fn) => fn(c));
      const session: ExecSession = {
        write: (d) => answer(String(d).trim(), { out, exit }),
        close: () => undefined,
        onData: (fn) => void data.push(fn),
        onExit: (fn) => void exits.push(fn),
      };
      const script = command[2] ?? '';
      if (command[0] === 'kill') {
        killed = true;
        setTimeout(() => exit(0), 5);
      } else if (script.includes('command -v claude')) {
        setTimeout(() => exit(installed ? 0 : 1), 1);
      } else if (script.includes('install.sh')) {
        setTimeout(() => {
          if (opts.installWorks === false) return (out('Failed to download binary\n'), exit(1));
          installed = true;
          out('✅ Installation complete!\n');
          exit(0);
        }, 1);
      } else if (script.includes('auth login')) {
        setTimeout(() => out(`cp-pid:4242\nOpening browser to sign in…\nIf the browser didn't open, visit: ${LINK}\nPaste code here if prompted > `), 5);
      }
      return session;
    },
  } as unknown as Workspaces;
  /** The `claude auth login` command, as run. */
  const login = () => commands.find((c) => c[2]?.includes('auth login'))!;
  return { workspaces, commands, login, killed: () => killed };
}

test('a sign-in shows Claude Code’s link, and finishes when Claude Code accepts the code', async () => {
  const fake = fakeWorkspaces((code, s) => (code === 'good-code-123' ? (s.out('Login successful.\n'), s.exit(0)) : undefined));
  const logins = new ClaudeLogins(fake.workspaces);
  assert.deepEqual(await logins.start('docker', 'api-dev'), { url: LINK });
  assert.match(fake.login()[2]!, /^PATH="\$HOME\/\.local\/bin:\$PATH"; export PATH; .*exec timeout 900 claude auth login "\$@"$/);
  assert.deepEqual(fake.login().slice(3), ['sh', '', '--claudeai'], 'Default: no Claude directory');
  assert.ok(!fake.commands.some((c) => c[2]?.includes('install.sh')), 'nothing installed when Claude Code is there');
  await logins.submit('docker', 'api-dev', 'good-code-123');
  await assert.rejects(logins.submit('docker', 'api-dev', 'good-code-123'), /has ended/);
});

test('single sign-on passes --sso to Claude Code as an argument', async () => {
  const fake = fakeWorkspaces(() => undefined);
  const logins = new ClaudeLogins(fake.workspaces);
  await logins.start('docker', 'api-dev', { sso: true });
  assert.deepEqual(fake.login().slice(3), ['sh', '', '--claudeai', '--sso']);
  await logins.cancel('docker', 'api-dev');
});

test('a rejected code can be pasted again; the error never repeats the code', async () => {
  let tries = 0;
  const fake = fakeWorkspaces((code, s) => {
    tries++;
    if (tries === 1) s.out(`Invalid code ${code}. Try again.\nPaste code here if prompted > `);
    else (s.out('Login successful.\n'), s.exit(0));
  });
  const logins = new ClaudeLogins(fake.workspaces);
  await logins.start('docker', 'api-dev');
  await assert.rejects(logins.submit('docker', 'api-dev', 'typo-code-999'), (e: Error) => /Invalid code \[code\]/.test(e.message) && !e.message.includes('typo-code-999'));
  await logins.submit('docker', 'api-dev', 'right-code-1');
});

test('status reads Claude Code’s auth status as status only, never the credential', async () => {
  // Run as `sh -c '<PATH setup> exec claude "$@"' sh auth status --json`.
  const outputs: Record<string, string> = {
    'auth status --json': '{"loggedIn":true,"authMethod":"claudeai","apiProvider":"firstParty"}',
  };
  const workspaces = {
    exec: async (_t: string, _n: string, command: string[]): Promise<ExecSession> => {
      const data: ((b: Buffer) => void)[] = [];
      const exits: ((c: number | null) => void)[] = [];
      setTimeout(() => {
        // `sh -c '<PATH> <as Claude> exec claude "$@"' sh <claude dir> auth status --json`
        const out = command[2]?.endsWith('exec claude "$@"') ? outputs[command.slice(5).join(' ')] : undefined;
        if (out) data.forEach((fn) => fn(Buffer.from(out)));
        exits.forEach((fn) => fn(out ? 0 : 1));
      }, 1);
      return { write: () => undefined, close: () => undefined, onData: (fn) => void data.push(fn), onExit: (fn) => void exits.push(fn) };
    },
  } as unknown as Workspaces;
  const logins = new ClaudeLogins(workspaces);
  assert.deepEqual(await logins.status('docker', 'api-dev'), { loggedIn: true, method: 'claudeai' });
});

test('status is signed-out when Claude Code says so or its output is unreadable', async () => {
  const reply = (out: string) =>
    ({
      exec: async (): Promise<ExecSession> => {
        const data: ((b: Buffer) => void)[] = [];
        const exits: ((c: number | null) => void)[] = [];
        setTimeout(() => (data.forEach((fn) => fn(Buffer.from(out))), exits.forEach((fn) => fn(1))), 1);
        return { write: () => undefined, close: () => undefined, onData: (fn) => void data.push(fn), onExit: (fn) => void exits.push(fn) };
      },
    }) as unknown as Workspaces;
  assert.deepEqual(await new ClaudeLogins(reply('{"loggedIn":false,"authMethod":"none"}')).status('docker', 'x'), { loggedIn: false, method: 'none' });
  assert.deepEqual(await new ClaudeLogins(reply('command not found')).status('docker', 'x'), { loggedIn: false, method: 'unknown' });
});

test('cancelling stops the waiting sign-in in the workspace', async () => {
  const fake = fakeWorkspaces(() => undefined);
  const logins = new ClaudeLogins(fake.workspaces);
  await logins.start('docker', 'api-dev');
  await logins.cancel('docker', 'api-dev');
  assert.ok(fake.killed());
  assert.deepEqual(fake.commands.at(-1), ['kill', '4242']);
  await assert.rejects(logins.submit('docker', 'api-dev', 'late-code-12'), /has ended/);
});

test('a missing Claude Code is installed with its own installer, then the sign-in starts', async () => {
  const fake = fakeWorkspaces(() => undefined, { installed: false });
  const logins = new ClaudeLogins(fake.workspaces);
  assert.deepEqual(await logins.start('local', 'local'), { url: LINK });
  const install = fake.commands.find((c) => c[2]?.includes('install.sh'))!;
  assert.match(install[2]!, /curl -fsSL https:\/\/claude\.ai\/install\.sh -o "\$f" && bash "\$f"/);
  // Checked, installed, checked again, then signed in: in that order.
  const order = fake.commands.map((c) => (c[2]?.includes('install.sh') ? 'install' : c[2]?.includes('command -v') ? 'check' : c[2]?.includes('auth login') ? 'login' : c[0]));
  assert.deepEqual(order, ['check', 'install', 'check', 'login']);
  await logins.cancel('local', 'local');
});

test('a failed install says so, in words the person sees', async () => {
  const fake = fakeWorkspaces(() => undefined, { installed: false, installWorks: false });
  const logins = new ClaudeLogins(fake.workspaces);
  await assert.rejects(logins.start('local', 'local'), (e: Error & { expose?: boolean; toJSON?: () => { error: { message: string } } }) => {
    assert.match(e.message, /Couldn’t install Claude Code in this workspace: Failed to download binary/);
    assert.equal(e.expose, true);
    return true;
  });
  assert.ok(!fake.commands.some((c) => c[2]?.includes('auth login')), 'no sign-in without Claude Code');
});

test('two sign-ins at once share one install', async () => {
  const fake = fakeWorkspaces(() => undefined, { installed: false });
  const logins = new ClaudeLogins(fake.workspaces);
  await Promise.allSettled([logins.start('local', 'local'), logins.start('local', 'local')]);
  assert.equal(fake.commands.filter((c) => c[2]?.includes('install.sh')).length, 1);
  await logins.cancel('local', 'local');
});

test('each Claude signs in, reports and signs out with its own CLAUDE_CONFIG_DIR', async () => {
  const fake = fakeWorkspaces(() => undefined);
  const logins = new ClaudeLogins(fake.workspaces);
  const dir = 'claudes/0123456789abcdef';
  await logins.start('local', 'local', { dir });
  assert.equal(fake.login()[4], dir);
  assert.match(fake.login()[2]!, /if \[ -n "\$1" \]; then CLAUDE_CONFIG_DIR="\$HOME\/\.claudepilot\/\$1"; export CLAUDE_CONFIG_DIR; fi; shift; echo "cp-pid:\$\$"/);
  // A sign-in on Default meanwhile is a separate one: it doesn't cancel this Claude's.
  await logins.start('local', 'local');
  assert.ok(!fake.killed(), 'Default’s sign-in left the other Claude’s running');
  await logins.cancel('local', 'local', dir);
  assert.ok(fake.killed());
  await logins.cancel('local', 'local');
});

test('a Claude directory that isn’t one of ours is refused before anything runs', async () => {
  const fake = fakeWorkspaces(() => undefined);
  const logins = new ClaudeLogins(fake.workspaces);
  for (const dir of ['../etc', 'claudes/x', '/root', 'claudes/0123456789abcdef/..'])
    await assert.rejects(logins.start('local', 'local', { dir }), { code: 'VALIDATION_FAILED' });
  await assert.rejects(logins.status('local', 'local', '$(id)'), { code: 'VALIDATION_FAILED' });
  assert.equal(fake.commands.length, 0);
});
