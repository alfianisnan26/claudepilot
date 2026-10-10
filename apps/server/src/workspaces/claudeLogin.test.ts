import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeLogins, cleanCode, signInLink } from './claudeLogin.js';
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

/** A fake `claude auth login`: answers the code with `answer`, and records every command run. */
function fakeWorkspaces(answer: (code: string, s: { out: (t: string) => void; exit: (c: number) => void }) => void) {
  const commands: string[][] = [];
  let killed = false;
  const workspaces = {
    exec: async (_t: string, _n: string, command: string[]): Promise<ExecSession> => {
      commands.push(command);
      const data: ((b: Buffer) => void)[] = [];
      const exits: ((c: number | null) => void)[] = [];
      const out = (t: string) => data.forEach((fn) => fn(Buffer.from(t)));
      const exit = (c: number) => exits.forEach((fn) => fn(c));
      const session: ExecSession = {
        write: (d) => answer(d.trim(), { out, exit }),
        close: () => undefined,
        onData: (fn) => void data.push(fn),
        onExit: (fn) => void exits.push(fn),
      };
      if (command[0] === 'kill') {
        killed = true;
        setTimeout(() => exit(0), 5);
      } else if (command[0] === 'sh') {
        setTimeout(() => out(`cp-pid:4242\nOpening browser to sign in…\nIf the browser didn't open, visit: ${LINK}\nPaste code here if prompted > `), 5);
      }
      return session;
    },
  } as unknown as Workspaces;
  return { workspaces, commands, killed: () => killed };
}

test('a sign-in shows Claude Code’s link, and finishes when Claude Code accepts the code', async () => {
  const fake = fakeWorkspaces((code, s) => (code === 'good-code-123' ? (s.out('Login successful.\n'), s.exit(0)) : undefined));
  const logins = new ClaudeLogins(fake.workspaces);
  assert.deepEqual(await logins.start('docker', 'api-dev'), { url: LINK });
  assert.match(fake.commands[0]!.join(' '), /timeout 900 claude auth login --claudeai/);
  await logins.submit('docker', 'api-dev', 'good-code-123');
  await assert.rejects(logins.submit('docker', 'api-dev', 'good-code-123'), /has ended/);
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

test('cancelling stops the waiting sign-in in the workspace', async () => {
  const fake = fakeWorkspaces(() => undefined);
  const logins = new ClaudeLogins(fake.workspaces);
  await logins.start('docker', 'api-dev');
  await logins.cancel('docker', 'api-dev');
  assert.ok(fake.killed());
  assert.deepEqual(fake.commands.at(-1), ['kill', '4242']);
  await assert.rejects(logins.submit('docker', 'api-dev', 'late-code-12'), /has ended/);
});
