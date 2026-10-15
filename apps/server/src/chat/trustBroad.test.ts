// Folder trust's broad-rule classifier (T-366, D-55): the jq behind `trustscan`'s `broadAllow` and its skill, command and agent
// frontmatter reading, run on tables. It imports only TRUST_BROAD_JQ, so the same file runs against an older host.ts as a proof.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TRUST_BROAD_JQ } from './host.js';

/** The folder the rules are read for, and the home folder `~` means (both as `trustscan` passes them). */
const HERE = '/home/node/work/claudepilot';
const HOME = '/home/node';

/** `cpBroad` of each rule, in order. */
function classify(rules: unknown[]): boolean[] {
  const out = execFileSync('jq', ['-cn', '--arg', 'here', HERE, '--arg', 'home', HOME, '--argjson', 'rules', JSON.stringify(rules), `${TRUST_BROAD_JQ} [$rules[] | cpBroad]`], {
    encoding: 'utf8',
  });
  return JSON.parse(out) as boolean[];
}

/** The rules of `rules` that `cpBroad` does not classify as `broad`. */
function misread(rules: unknown[], broad: boolean): string[] {
  const got = classify(rules);
  return rules.filter((_, i) => got[i] !== broad).map((r) => JSON.stringify(r));
}

/** Blankets, runners and what it can't read: broad since d647d14, still broad. */
const BROAD_BEFORE: unknown[] = [
  'Bash', 'bash', ' Bash ', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'Read', '*', 'mcp__*',
  'Bash(*)', 'Bash(:*)', 'Bash()', 'Bash( * )', 'Edit(**)', 'Write(*)', 'WebFetch(domain:*)', 'WebFetch(https://x.example)',
  'Edit(/**)', 'Edit(//**)', 'Write(~/**)', 'Read(~/**)', 'Edit($HOME/**)', 'Edit(~)', 'Edit(//*/x)', 'Read(~/.ssh/id_x)',
  'Edit(~/.claude/settings.json)', 'Edit(//home/node/**)', 'Edit(/home/*/work/**)', 'Read(//etc/**)', 'Edit(../**)', 'Edit(src/../../x)',
  'Bash(sudo:*)', 'Bash(sudo *)', 'Bash( sudo:* )', 'Bash(SUDO:*)', 'Bash(Sudo ls)', 'Bash(/usr/bin/env:*)', 'Bash(env FOO=1 npm test)',
  'Bash("bash" -c x)', 'Bash(\\sudo ls)', 'Bash(FOO=1 npm test)', 'Bash(flock /tmp/heavy.lock:*)', 'Bash(flock /tmp/heavy.lock *)',
  'Bash(timeout 60 npm test:*)', 'Bash(nice -n 10:*)', 'Bash(nohup:*)', 'Bash(stdbuf -oL:*)', 'Bash(time:*)', 'Bash(watch:*)',
  'Bash(setsid:*)', 'Bash(chroot:*)', 'Bash(ssh host:*)', 'Bash(xargs:*)', 'Bash(eval:*)', 'Bash(exec:*)', 'Bash(sh -c:*)',
  'Bash(zsh:*)', 'Bash(dash:*)', 'Bash(su:*)', 'Bash(doas:*)', 'Bash(awk:*)',
  'Bash(node -e:*)', 'Bash(node --eval:*)', 'Bash(node:*)', 'Bash(node --import tsx:*)', 'Bash(python -c:*)', 'Bash(python3 -c:*)',
  'Bash(python3:*)', 'Bash(perl -e:*)', 'Bash(perl -pe s/a/b/ x)', 'Bash(deno eval:*)',
  'Bash(find . -name x -exec rm {} ;)', 'Bash(find:*)', 'Bash(npx:*)', 'Bash(npx tsx:*)', 'Bash(npx -y:*)', 'Bash(npx -c:*)',
  'Bash(npm exec:*)', 'Bash(npm:*)', 'Bash(uv run:*)', 'Bash(uv run python:*)',
  'Bash(git:*)', 'Bash(git -c alias.x=y x)', 'Bash(git config:*)', 'Bash(kubectl exec:*)', 'Bash(docker run:*)',
  'Bash(* /x)', 'Bash(npm test && *)', 'Bash($(x):*)', 'Bash(foo', 'Bash(ls)\nBash(sudo:*)', 42, null, { rule: 'Bash' },
];

/**
 * B1 (review of d647d14): a Bash rule with a wildcard is broad unless its command is on the vetted list (ls, cat, head, tail, wc,
 * grep, echo, pwd, git status). d647d14 had a deny list of runners, so every one of these was narrow there.
 */
const BROAD_WILDCARD: string[] = [
  'Bash(sed *)', 'Bash(make *)', 'Bash(tar *)', 'Bash(sort *)', 'Bash(zip *)', 'Bash(rsync *)', 'Bash(scp *)', 'Bash(vim *)',
  'Bash(man *)', 'Bash(tmux *)', 'Bash(screen *)', 'Bash(socat *)', 'Bash(sqlite3 *)', 'Bash(go run *)', 'Bash(cargo run *)',
  'Bash(npm install *)', 'Bash(pip install *)', 'Bash(git grep *)', 'Bash(git fetch *)', 'Bash(git push *)', 'Bash(git push:*)',
  'Bash(cp *)', 'Bash(tee *)', 'Bash(dd *)', 'Bash(curl *)', 'Bash(wget *)', 'Bash(install *)', 'Bash(ln *)', 'Bash(mv *)',
  'Bash(kubectl apply *)', 'Bash(make:*)',
  // Run repository code or read config that runs a program.
  'Bash(npm run *)', 'Bash(npm test *)', 'Bash(npm run typecheck:*)', 'Bash(npm test:*)', 'Bash(npx tsc:*)', 'Bash(node scripts/x.mjs:*)',
  'Bash(python3 -m pytest:*)', 'Bash(uv run pytest:*)', 'Bash(scripts/job-run.sh:*)', 'Bash(./scripts/quiet.sh *)',
  'Bash(kubectl get:*)', 'Bash(kubectl rollout restart:*)', 'Bash(gh pr view:*)',
  // Write anywhere: `git diff --output`, `git log --output`, chmod, update-index.
  'Bash(git diff *)', 'Bash(git log:*)', 'Bash(git show *)', 'Bash(chmod +x:*)', 'Bash(git update-index --chmod=+x:*)',
  'Bash(rg *)', // --pre runs a program
  // Unknown commands: when unsure, broad.
  'Bash(sudoku:*)', 'Bash(envsubst:*)', 'Bash(timeouts:*)',
  // The vetted names only bare and exact: a path may be a repository script, another case another program.
  'Bash(/bin/ls *)', 'Bash(./ls *)', 'Bash(LS *)', 'Bash(git -C /x status *)', 'Bash(git * status)', 'Bash(git status* x)', 'Bash(ls (x) *)',
];

/** M1 (review of d647d14): an absolute or home path outside the folder is broad. */
const BROAD_PATHS: string[] = [
  'Edit(//usr/**)', 'Read(//opt/**)', 'Write(//var/**)', 'Edit(//home/node/work/**)', 'Read(//home/node/work/x/**)', 'Edit(/usr/**)',
  'Edit(/src/**)', // `/x` read as absolute: the stricter of its two readings
  'Write(~/work/claudepilot.worktrees/**)', 'Edit(~/work/other/**)', 'Read(~/work/claudepilotx/**)', 'Edit(~node/x)',
  'NotebookEdit(//tmp/x.ipynb)', 'MultiEdit(~/.bashrc)', 'Edit($HOME/work/other/x)', 'Edit(//home/node/work/claudepilot/../x)',
];

/**
 * B1 (second review, of aed422b): a `<` or `>` anywhere in a Bash rule, and a path token outside the folder or on its `.git` or
 * `.claude`, or any other `$`. Narrow on aed422b: `echo` and `cat` were vetted, and an exact rule's arguments were not read.
 */
const BROAD_REDIRECT_PATHS: string[] = [
  'Bash(echo * > *)', 'Bash(cat *>*)', 'Bash(cat * > ~/.bashrc)', 'Bash(echo * >> ~/.bashrc)', 'Bash(cp a ~/.bashrc)', 'Bash(rm -rf ~)',
  'Bash(tee ~/.bashrc)', 'Bash(echo x > out.txt)', 'Bash(sort < /etc/shadow)', 'Bash(ls>x)', 'Bash(echo 1 2>err)',
  'Bash(cp a /home/node/work/claudepilot/.git/config)', 'Bash(cp a .git/hooks/pre-commit)', 'Bash(cp a ./.claude/settings.json)',
  'Bash(rm -rf /home/node/work/claudepilot)', 'Bash(dd if=x of=/etc/passwd)', 'Bash(cp a "~/.bashrc")', 'Bash(rm -rf $HOME)',
  'Bash(rm -rf $HOME/.ssh)', 'Bash(cat $X)', 'Bash(ls /*)', 'Bash(/usr/bin/git status)', 'Bash(npm test --prefix=/tmp/x)',
];

/** M1 (second review): `cat`, `head`, `tail`, `wc`, `grep` and `git status` with a wildcard; a home file read exactly. */
const BROAD_READERS: string[] = [
  'Bash(cat *)', 'Bash(grep -r * /)', 'Bash(cat ~/.git-credentials)', 'Bash(head -n 5 *)', 'Bash(tail:*)', 'Bash(wc -l *)',
  'Bash(grep -rn *)', 'Bash("grep" *)', 'Bash(egrep *)', 'Bash(fgrep:*)', 'Bash(git status:*)', 'Bash(git status *)',
];

/**
 * B2 (second review): an editing rule that may cover the folder's `.git` or `.claude`, with no deny list. Narrow on aed422b: a
 * path inside the folder was enough.
 */
const BROAD_GIT_CLAUDE: string[] = [
  'Edit(./**)', 'Edit(.git/**)', 'Write(.git/config)', 'Edit(.claude/**)', 'Edit(//home/node/work/claudepilot/**)',
  'Edit(/home/node/work/claudepilot/**)', 'Edit(~/work/claudepilot/**)', 'Edit(//home/node/work/claudepilot)', 'Edit(.)',
  'Edit(./.git/hooks/pre-commit)', 'MultiEdit(.claude/settings.json)', 'NotebookEdit(./*)', 'Edit(*.md)', 'Edit(config)',
  'Edit(./README.md)', 'Edit(.GIT/config)', 'Edit(.g*/config)', 'Edit($HOME/work/claudepilot/.claude/x)', 'Write(./.claude/commands/x.md)',
  'Edit(//home/node/work/claudepilot/.git)', 'Edit({.git,src}/**)',
];

/** Rules it leaves alone: vetted wildcard commands, exact commands that run nothing else, paths inside the folder off `.git` and `.claude`. */
const NARROW_RULES: string[] = [
  'Bash(ls:*)', 'Bash(ls *)', 'Bash(echo:*)', 'Bash(echo hello)', 'Bash(pwd)', 'Bash(npm ci)', 'Bash(npm test)',
  'Bash(node --import tsx --test src/a.test.ts)', 'Bash(git status)', 'Bash(ls /home/node/work/claudepilot/src)',
  'Edit(src/**)', 'Edit(./src/**)', 'Read(//home/node/work/claudepilot/**)', 'Read(./**)', 'Read(~/work/claudepilot/.git/config)',
  'Edit(/home/node/work/claudepilot/docs/**)', 'Edit($HOME/work/claudepilot/src/*.ts)', 'Write(docs/prd/x.md)',
  'WebFetch(domain:github.com)', 'Glob', 'Grep', 'mcp__pilot__ticket_get',
  // Observed limit (FR43, T-403): an exact rule that runs code the folder controls can't be told from any command; the scan can't catch it.
  'Bash(scripts/release.sh deploy)',
];

/** The deny lists that make an editing rule on the folder's `.git` and `.claude` narrow again (B2), and ones that don't. */
const GUARDS: unknown[] = [
  ['Edit(.git)', 'Edit(.git/**)', 'Edit(.claude/**)'],
  ['Bash(sudo:*)', ' Edit(./.git) ', 'Edit(**/.git/**)', 'Edit(./.claude/**)'],
];
const NOT_GUARDS: unknown[] = [
  null, 'Edit(.git/**)', [], ['Edit(.git/**)', 'Edit(.claude/**)'], // the gitfile of a worktree is `.git` itself
  ['Edit(.git)', 'Edit(.git/**)'], ['Write(.git)', 'Write(.git/**)', 'Write(.claude/**)'], ['Edit(.git)', 'Edit(.git/*)', 'Edit(.claude/**)'],
  ['Edit(/.git)', 'Edit(/.git/**)', 'Edit(/.claude/**)'], // `/x` is relative to the settings file, not the folder
];

/** `cpBroadIn($deny)` of each rule with one deny list. */
function classifyIn(rules: unknown[], deny: unknown): boolean[] {
  const out = execFileSync(
    'jq',
    ['-cn', '--arg', 'here', HERE, '--arg', 'home', HOME, '--argjson', 'rules', JSON.stringify(rules), '--argjson', 'deny', JSON.stringify(deny), `${TRUST_BROAD_JQ} [$rules[] | cpBroadIn($deny)]`],
    { encoding: 'utf8' },
  );
  return JSON.parse(out) as boolean[];
}

test('cpBroad: blankets, runners and what it cannot read stay broad', () => {
  assert.deepEqual(misread(BROAD_BEFORE, true), []);
  assert.ok(!TRUST_BROAD_JQ.includes("'"), 'the script holds it in single quotes');
});

test('cpBroad B1: a wildcard Bash rule is broad unless its command is vetted (allow list, not a deny list)', () => {
  assert.deepEqual(misread(BROAD_WILDCARD, true), []);
});

test('cpBroad M1: an absolute or home path outside the folder is broad', () => {
  assert.deepEqual(misread(BROAD_PATHS, true), []);
});

test('cpBroad: vetted wildcard commands, exact commands that run nothing else and paths inside the folder stay narrow', () => {
  assert.deepEqual(misread(NARROW_RULES, false), []);
});

test('cpBroad B1 (second review): a redirect anywhere, or a path argument outside the folder or on .git or .claude, is broad', () => {
  assert.deepEqual(misread(BROAD_REDIRECT_PATHS, true), []);
});

test('cpBroad M1 (second review): cat, head, tail, wc, grep and git status with a wildcard are broad; only ls, pwd and echo stay vetted', () => {
  assert.deepEqual(misread(BROAD_READERS, true), []);
});

test('cpBroad B2: an editing rule that may cover .git or .claude is broad unless the same file denies Edit(.git), Edit(.git/**) and Edit(.claude/**)', () => {
  assert.deepEqual(misread(BROAD_GIT_CLAUDE, true), []);
  for (const deny of GUARDS) assert.deepEqual(classifyIn(BROAD_GIT_CLAUDE, deny), BROAD_GIT_CLAUDE.map(() => false), JSON.stringify(deny));
  for (const deny of NOT_GUARDS) assert.deepEqual(classifyIn(BROAD_GIT_CLAUDE, deny), BROAD_GIT_CLAUDE.map(() => true), JSON.stringify(deny));
  // A deny list never narrows anything else: outside the folder, a Bash rule, a blanket.
  const others = ['Edit(//usr/**)', 'Edit(~/.bashrc)', 'Bash(cp a .git/config)', 'Edit', 'Edit(**)', 'Edit(../x)', 'Bash(cat *)'];
  assert.deepEqual(classifyIn(others, GUARDS[0]), others.map(() => true));
});

test('cpBroad M1: with no usable home, every home path is broad', () => {
  const out = execFileSync('jq', ['-cn', '--arg', 'here', HERE, '--arg', 'home', '', `${TRUST_BROAD_JQ} ["Edit(~/work/claudepilot/**)", "Edit(./src/**)"] | map(cpBroad)`], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), [true, false]);
});

type Front = { hooks: boolean; mode: boolean; broad: boolean; odd: boolean };
const NONE: Front = { hooks: false, mode: false, broad: false, odd: false };

/** Skill, command and agent Markdown and what `cpFront` must find in its frontmatter (M2). */
const FRONT: [string, Partial<Front>][] = [
  ['# Title\nhooks: x\n', {}], // no frontmatter: the body is not read
  ['---\nname: a\ndescription: d\n---\nhooks: in the body\n', {}],
  // Hooks and a permission mode are named, and (M3, an allow list of keys) make the file odd too.
  ['---\nhooks:\n  PreToolUse: []\n---\n', { hooks: true, odd: true }],
  ['---\n"hooks": {}\n---\n', { hooks: true, odd: true }],
  ['﻿---\r\nHooks:\r\n---\r\n', { hooks: true, odd: true }],
  ['---\nname: x\nhooks: {}\n', { hooks: true, odd: true }], // never closed: all of it counts
  ['\n\n---\npermissionMode: plan\n---\n', { mode: true, odd: true }],
  ['---\npermission-mode: x\n---\n', { mode: true, odd: true }],
  ['---\nallowed-tools: Grep, Glob, Bash(ls:*)\n---\n', {}],
  ['---\nallowed-tools: Grep, Glob, Bash(git status:*)\n---\n', { broad: true }], // M1: fsmonitor
  ['---\nallowed-tools: [Grep, "Bash(ls:*)"]\n---\n', {}],
  ['---\nallowed-tools:\n- Grep\n# a comment\n  - Bash(ls *)\nname: x\n---\n', {}],
  ['---\nallowed-tools:\n- Grep\n  - Bash(cat *)\n---\n', { broad: true }], // M1: reads any file
  ['---\ntools: Bash, Edit\n---\n', {}], // an agent's tool list grants nothing
  ['---\nallowed-tools: Read, Grep\n---\n', { broad: true }], // a bare Read
  ['---\nallowed-tools: Bash(curl:*)\n---\n', { broad: true }],
  ['---\nallowed-tools: Edit(./**)\n---\n', { broad: true }], // B2: a skill has no deny list
  ['---\nallowed-tools: Bash(echo * > ~/.bashrc)\n---\n', { broad: true }], // B1
  ['---\nallowed_tools: Bash\n---\n', { broad: true, odd: true }],
  ['---\nallowed-tools:\n  - Grep\n  - Bash(make *)\ndescription: x\n---\n', { broad: true }],
  ['---\nallowed-tools: >\n  Grep\n---\n', { broad: true }],
  ['---\nallowed-tools:\n  Grep,\n  Bash\n---\n', { broad: true }],
  ['---\nallowed-tools: Grep # Bash\n---\n', { broad: true }],
  ['---\nallowed-tools: Bash(git status:*) Bash(rm *)\n---\n', { broad: true }],
  ['---\nallowed-tools: [Grep, Bash(a, b)]\n---\n', { broad: true }],
  ['---\nallowed-tools: *tools\n---\n', { broad: true }],
  ['---\n{hooks: x}\n---\n', { hooks: true, odd: true }],
  ['---\n<<: *base\n---\n', { odd: true }],
  ['---\n"ho\\u006bs": x\n---\n', { odd: true }],
  ['---\n? hooks\n: x\n---\n', { odd: true }], // a complex key: not read as hooks, so odd
  // M3: only the plain-text keys of TRUST_FRONTMATTER_KEYS; anything else is odd.
  ['---\nname: a\nmcpServers:\n  x: {}\n---\n', { odd: true }],
  ['---\nname: a\nx-new: 1\n---\n', { odd: true }],
  ['---\nName: a\n---\n', { odd: true }],
  ['---\nname:a\n---\n', { odd: true }],
  ['---\n"name": a\n---\n', { odd: true }],
  ['---\n-hooks: x\n---\n', { odd: true }],
  ['---\n  name: a\n  hooks: x\n---\n', { hooks: true, odd: true }], // an indented mapping
  ['---\n- a\n---\n', { odd: true }],
  ['---x\nname: a\n---\n', { odd: true }], // an opening line other than ---
  ['---\nname: a\ndescription: >\n  long\n  text\nmodel: opus\ncolor: blue\ntools: Read, Grep\nargument-hint: [x] [y]\n# a note\n---\nbody\n', {}],
  // 2026-10-15: an ordinary agent file (the keys the persona renders) is clean, so a repository with such agents can be trusted by itself.
  ['---\nname: event-qa\ndescription: QA\nmodel: sonnet\neffort: high\nmaxTurns: 80\ndisallowedTools: Edit, NotebookEdit\n---\nbody\n', {}],
  // m1: only --- ends the frontmatter; a ... line is odd, and what follows it is read.
  ['---\nname: a\n...\n---\n', { odd: true }],
  ['---\ndescription: a\n...\nallowed-tools: Bash\n---\n', { broad: true, odd: true }],
  ['---\nname: a\n...\nhooks: x\n', { hooks: true, odd: true }],
];

test('cpFront M2: frontmatter hooks, a permission mode, a broad or unreadable allowed-tools entry, and YAML it does not read', () => {
  const docs = FRONT.map(([doc]) => doc);
  const out = execFileSync('jq', ['-cn', '--arg', 'here', HERE, '--arg', 'home', HOME, '--argjson', 'docs', JSON.stringify(docs), `${TRUST_BROAD_JQ} [$docs[] | cpFront]`], {
    encoding: 'utf8',
  });
  const got = JSON.parse(out) as Front[];
  const wrong = FRONT.flatMap(([doc, want], i) => {
    const expected = { ...NONE, ...want };
    return JSON.stringify(got[i]) === JSON.stringify(expected) ? [] : [`${JSON.stringify(doc)}: ${JSON.stringify(got[i])}, expected ${JSON.stringify(expected)}`];
  });
  assert.deepEqual(wrong, []);
});

test('cpFront M3: this repository’s own agents and commands use only allowed keys (the allow list is not narrower than real use)', () => {
  const files = ['agents', 'commands'].flatMap((d) => {
    const dir = fileURLToPath(new URL(`../../../../.claude/${d}/`, import.meta.url));
    return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f));
  });
  assert.ok(files.length >= 10, `found ${files.length} files`);
  const docs = files.map((f) => readFileSync(f, 'utf8'));
  const out = execFileSync('jq', ['-cn', '--arg', 'here', HERE, '--arg', 'home', HOME, '--argjson', 'docs', JSON.stringify(docs), `${TRUST_BROAD_JQ} [$docs[] | cpFront]`], {
    encoding: 'utf8',
  });
  const got = JSON.parse(out) as Front[];
  assert.deepEqual(files.filter((_, i) => got[i]!.odd || got[i]!.hooks || got[i]!.mode), []);
});
