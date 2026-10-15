// T-306 step 2: the rtk subset hook (tools/rtk/hook.mjs) and the per-class fidelity scorer (tools/qa/rtk-fidelity.mjs --class).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDirectory } from '../store/testTmp.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const HOOK = join(ROOT, 'tools/rtk/hook.mjs');
const PARITY = join(ROOT, 'tools/qa/rtk-deny-parity.mjs');
type Decision = { action: 'rewrite' | 'skip'; class?: string; command?: string; reason?: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hook: any = await import(pathToFileURL(HOOK).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fid: any = await import(pathToFileURL(join(ROOT, 'tools/qa/rtk-fidelity.mjs')).href);

const repoDeny: string[] = hook.loadDeny([[join(ROOT, '.claude/settings.json'), true]]);
const decide = (cmd: string, deny: string[] = repoDeny, rtkOnPath = true): Decision => hook.classify(cmd, { deny, rtkOnPath });

test('allowlisted read-only commands are rewritten to their rtk form', () => {
  for (const [cmd, cls] of <[string, string][]>[
    ['git status', 'git-status'], ['git status apps/server', 'git-status'], ['git status apps/web/src docs', 'git-status'],
    ['git status -- apps/server/src/chat', 'git-status'], ['git status .env', 'git-status'],
    ['grep -rl actorOf apps/server/src', 'grep-list'], ["grep -rli 'sameHost' apps", 'grep-list'], ['rg -l actorOf apps/server/src', 'grep-list'],
    ['rg --files-with-matches actorOf docs', 'grep-list'],
  ]) {
    const d = decide(cmd);
    assert.equal(d.action, 'rewrite', `${cmd}: ${d.reason}`);
    assert.equal(d.class, cls, cmd);
    assert.equal(d.command, `rtk ${cmd}`);
  }
});

test('test runners, builds, typecheck, kubectl, cat/sed, writes and unmeasured flags are never rewritten', () => {
  for (const cmd of [
    'npm test', 'npm run typecheck', 'npm run build -w @portal/web', 'npx tsc --noEmit -p apps/server', 'node --import tsx --test src/a.test.ts',
    'kubectl get pods', 'kubectl logs x', 'cat README.md', 'sed -n 1,20p README.md', 'head -n 5 x', 'git push origin dev/x', 'git commit -m x',
    'git diff', 'git diff HEAD~1', 'git log -p', 'git log --format=%H', 'git status --porcelain', 'git -C x status', 'ls -R', 'ls -la --color=always',
    'grep -rn actorOf apps', 'grep actorOf x', 'rg -n actorOf apps', 'find . -name x', 'find . -delete', 'tree -L 2', 'npm ls', 'rtk git status',
    'FOO=1 git status', '/usr/bin/ls -la',
    // T-341: git log is off the allowlist (rtk drops body lines past three, the e-mail and the absolute date); status takes no flag, one `--` at most.
    'git log -5', 'git log -20 main', 'git log --max-count=3', 'git log -5 -- apps/server', 'git log --merges -5', 'git status -u', 'git status --ignored apps',
    'git status -- -- x', 'git status docs --short',
    // Dropped on fidelity (ls, find, grep -n) or passed through byte for byte by rtk (no saving): never rewritten.
    'ls', 'ls -la', 'ls -la apps/server/src/chat', 'git status -sb', 'git status -s', 'git log --oneline -20', 'git log --stat -3', 'git diff --stat',
    'git diff --name-only HEAD~1', 'grep -rc actorOf apps', 'rg --count actorOf apps', 'grep -rlw x apps', 'grep -rl --include=*.ts x apps',
  ]) assert.equal(decide(cmd).action, 'skip', cmd);
});

test('compound commands, pipes, subshells, redirects and expansions stay untouched even when every part is allowlisted', () => {
  for (const cmd of [
    'git status && git log --oneline -5', 'git status; ls', 'ls -la | head', 'ls -la || true', '(git status)', 'ls $(pwd)', 'ls `pwd`', 'ls > out.txt',
    'ls < x', 'git status\nls', 'ls $HOME', 'ls ~/x & ls', 'ls {a,b}', 'ls # x', 'ls \\;', "ls 'unclosed",
  ]) assert.equal(decide(cmd).action, 'skip', JSON.stringify(cmd));
});

test('a command a deny rule names is untouched, read from the rules given (no mirrored copy)', () => {
  assert.equal(decide('git status', ['git status:*']).action, 'skip');
  assert.equal(decide('git status', ['git status:*']).reason, 'matches a deny rule');
  assert.equal(decide('git status docs', ['git status docs']).reason, 'matches a deny rule');
  assert.equal(decide('git status docs main', ['git status * main']).reason, 'matches a deny rule');
  assert.equal(decide('git status', ['*']).reason, 'matches a deny rule');
  assert.equal(decide('git  status  docs', ['git status docs']).reason, 'matches a deny rule', 'collapsed spaces still match');
  assert.equal(decide('git status', ['rtk git:*']).reason, 'the rewritten form matches a deny rule');
  // The repository's own wildcard rule: an allowlisted command aimed at another process's environment.
  assert.equal(decide('git status /proc/1/environ').reason, 'matches a deny rule');
  assert.equal(decide('grep -rl x /proc/1/environ').reason, 'matches a deny rule');
  assert.equal(decide('git status docs', []).action, 'rewrite');
  assert.equal(decide('git status /proc/1/status').action, 'rewrite', 'the wildcard rule only catches what it names');
});

test('no rtk on PATH, no rewrite', () => {
  assert.equal(decide('git status', repoDeny, false).reason, 'rtk is not on PATH');
});

test('the deny list loader: bare Bash denies everything, a missing project file or a broken one throws (fail closed)', () => {
  const dir = tempDirectory('rtk-hook-deny');
  const a = join(dir, 'a.json'), b = join(dir, 'b.json');
  writeFileSync(a, JSON.stringify({ permissions: { deny: ['Bash(git clean:*)', 'Read(~/.ssh/**)', 'Bash'] } }));
  writeFileSync(b, '{ not json');
  assert.deepEqual(hook.loadDeny([[a, true], [join(dir, 'missing.json'), false]]), ['git clean:*', '*']);
  assert.throws(() => hook.loadDeny([[join(dir, 'missing.json'), true]]));
  assert.throws(() => hook.loadDeny([[a, true], [b, false]]));
});

// The hook as Claude Code runs it: JSON on stdin, a project folder with its settings, a stand-in rtk on PATH.
function project(settings: string | null): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tempDirectory('rtk-hook-proj');
  mkdirSync(join(dir, '.claude'));
  if (settings !== null) writeFileSync(join(dir, '.claude/settings.json'), settings);
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'rtk'), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, 'rtk'), 0o755);
  const home = join(dir, 'home'); mkdirSync(home);
  return { dir, env: { PATH: bin + delimiter + (process.env.PATH ?? ''), HOME: home, CLAUDE_PROJECT_DIR: dir } };
}
const run = (env: NodeJS.ProcessEnv, input: unknown) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env, encoding: 'utf8' });

test('hook end to end: rewrites an allowlisted Bash command, keeps the other input fields, sets no permission decision', () => {
  const p = project(JSON.stringify({ permissions: { deny: ['Bash(git push:*)'] } }));
  const r = run(p.env, { tool_name: 'Bash', tool_input: { command: 'git status', description: 'Show status' }, cwd: p.dir });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'rtk git status', description: 'Show status' } } });
  for (const input of [
    { tool_name: 'Bash', tool_input: { command: 'git push origin x' } },
    { tool_name: 'Bash', tool_input: { command: 'npm test' } },
    { tool_name: 'Read', tool_input: { file_path: '/etc/hostname' } },
    'not an object',
  ]) {
    const s = run(p.env, input);
    assert.equal(s.status, 0);
    assert.equal(s.stdout, '', JSON.stringify(input));
  }
});

test('hook end to end: no project settings, or broken settings, means no rewrite at all', () => {
  for (const settings of [null, '{ broken']) {
    const p = project(settings);
    const r = run(p.env, { tool_name: 'Bash', tool_input: { command: 'git status' } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

test('deny parity against the hook: 0 bypass for the whole deny list of .claude/settings.json', () => {
  const r = spawnSync(process.execPath, [PARITY, join(ROOT, '.claude/settings.json'), '--hook', HOOK, '--json'], { encoding: 'utf8' });
  const { summary } = JSON.parse(r.stdout);
  assert.equal(summary.probe_rewritten, 'rtk git status', 'the stand-in rtk must make the hook rewrite, or the run proves nothing');
  assert.equal(summary.bash_rules, JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8')).permissions.deny.filter((x: string) => x.startsWith('Bash(')).length);
  assert.ok(summary.samples > summary.bash_rules, 'the wildcard rules get extra samples with allowlisted commands in front');
  assert.equal(summary.sanity_failures, 0);
  assert.equal(summary.bypassed, 0);
  assert.equal(summary.hook_errors, 0);
  assert.equal(r.status, 0);
});

test('fidelity per class: git status long vs short form keeps every path and state; a dropped path is counted', () => {
  const plain = [
    'On branch main', 'Changes to be committed:', '  (use "git restore --staged <file>..." to unstage)', '\tdeleted:    docs/a.md', '\tnew file:   b/c.txt', '',
    'Changes not staged for commit:', '\tmodified:   src/x.ts', '', 'Untracked files:', '\tnew.txt', '',
  ].join('\n');
  const rtk = ['* main', 'D  docs/a.md', 'A  b/c.txt', ' M src/x.ts', '?? new.txt'].join('\n');
  assert.equal(fid.scoreClass('git-status', plain, rtk).parity_percent, 100);
  const lost = fid.scoreClass('git-status', plain, rtk.replace(' M src/x.ts\n', ''));
  assert.equal(lost.missing_items, 1);
  assert.deepEqual(lost.by_kind.status.missing, ['WM:src/x.ts']);
  // A changed state is a loss too (staged shown as unstaged).
  assert.equal(fid.scoreClass('git-status', plain, rtk.replace('D  docs/a.md', ' D docs/a.md')).missing_items, 1);
});

test('fidelity per class: ls -la names and folders, find grouped by folder, grep listing grouped under a root, grep lines', () => {
  const ls = ['total 8', 'drwxr-xr-x  3 n n   60 Oct 14 21:31 .', 'drwxr-xr-x  3 n n   60 Oct 14 21:31 ..', 'drwxr-xr-x  3 n n   60 Oct 14 21:31 apps', '-rw-r--r--  1 n n 7197 Oct 14 21:31 CLAUDE.md'].join('\n');
  assert.equal(fid.scoreClass('ls', ls, '755  apps/\n644  CLAUDE.md  7.0K').parity_percent, 100);
  assert.equal(fid.scoreClass('ls', ls, '755  apps\n644  CLAUDE.md  7.0K').missing_items, 1, 'a folder must still read as a folder');
  const find = 'docs/a.md\ndocs/coord/PLAN.md\ndocs/coord/b.sh';
  assert.equal(fid.scoreClass('find', find, '3F 1D:\n\n./ a.md\ncoord/ PLAN.md b.sh').parity_percent, 100);
  assert.equal(fid.scoreClass('find', find, '3F 1D:\n\n./ a.md\n+2 more').missing_items, 2);
  assert.equal(fid.scoreClass('grep-list', 'apps/s/a.ts\napps/s/b/c.ts', 'apps/s/ (2 files)\na.ts\nb/c.ts').parity_percent, 100);
  const lines = 'apps/a.ts:12:  const actor = actorOf(c);\napps/b.ts:3:import { actorOf } from "x";';
  assert.equal(fid.scoreClass('grep-lines', lines, 'apps/a.ts:12:const actor = actorOf(c);\napps/b.ts:3:import { actorOf } from "x";').parity_percent, 100);
  const cut = fid.scoreClass('grep-lines', lines, 'apps/a.ts:12:...actor = actorOf(c);\napps/b.ts:3:import { actorOf } from "x";');
  assert.deepEqual(cut.by_kind.text.missing, ['const actor = actorOf(c);'], 'a cut line is a loss');
  assert.equal(cut.by_kind.loc.missing.length, 0);
});

test('fidelity per class: git log keeps hashes, subjects, authors and body lines; dates and e-mail are not scored', () => {
  const plain = ['commit 7e74674aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Author: rtk-scratch <s@example.invalid>', 'Date:   Tue Oct 14 21:31:00 2026 +0000', '', '    scratch 1: touch x', '', '    Why: a body line.', '', '    Ticket: T-901', ''].join('\n');
  assert.equal(fid.scoreClass('git-log', plain, '7e74674 scratch 1: touch x (0 seconds ago) <rtk-scratch>\nWhy: a body line.\nTicket: T-901').parity_percent, 100);
  const r = fid.scoreClass('git-log', plain, '7e74674 scratch 1: touch x (0 seconds ago) <rtk-scratch>');
  assert.deepEqual(r.by_kind.text.missing, ['Why: a body line.', 'Ticket: T-901']);
});

test('fidelity per class (T-341): git-log-meta scores the e-mail and the date line, ls-meta owner, size and date', () => {
  const plain = ['commit 7e74674aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Author: A B <a@example.invalid>', 'Date:   Tue Oct 14 21:31:00 2026 +0000', '', '    s', ''].join('\n');
  assert.equal(fid.scoreClass('git-log-meta', plain, '7e74674 s (20 minutes ago) <A B>').parity_percent, 0, 'rtk shows neither');
  assert.equal(fid.scoreClass('git-log-meta', plain, 'a@example.invalid\nTue Oct 14 21:31:00 2026 +0000').parity_percent, 100);
  const ls = '-rw-r--r--  1 node staff 7197 Oct 14 21:31 CLAUDE.md';
  assert.equal(fid.scoreClass('ls-meta', ls, '644  CLAUDE.md  7.0K').parity_percent, 0);
  assert.equal(fid.scoreClass('ls-meta', ls, 'node staff 7197 Oct 14 21:31 CLAUDE.md').parity_percent, 100);
});
