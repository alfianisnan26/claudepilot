// T-404 (D-60): the rule-file guard, run for real (node, the delivered script) against scratch folders built here at runtime.
// Every rule file below lives in a temp folder this test makes; nothing in the repository is touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ChatStore } from '../chat/store.js';
import { compile } from '../delivery/compile.js';
import { parseOutbox } from '../delivery/outbox.js';
import { mayWrite } from '../delivery/ownership.js';
import { FOUNDATION } from '../delivery/reconciler.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { RULE_GUARD_FILES, RULE_GUARD_HOOKS, RULE_GUARD_MATCHER, RULE_GUARD_MESSAGE, RULE_GUARD_PATH, RULE_GUARD_SCRIPT, RULE_GUARD_WRAPPER } from './ruleGuard.js';
import { GUARD_CHANNEL, recordGuardRefusals } from './ruleGuardAudit.js';

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';
const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A scratch workspace: the guard's two files, a home with an outbox and a config folder, and a repository with its rule files. */
function rig() {
  const root = mkdtempSync(join(tmpdir(), 'cp-ruleguard-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const guard = join(bin, 'policy-rule-guard');
  writeFileSync(guard, RULE_GUARD_WRAPPER, { mode: 0o755 });
  writeFileSync(`${guard}.cjs`, RULE_GUARD_SCRIPT);
  const home = join(root, 'home');
  mkdirSync(join(home, '.claudepilot', 'outbox'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  const configDir = join(home, '.claudepilot', 'claudes', 'c1');
  mkdirSync(configDir, { recursive: true });
  const repo = join(root, 'repo');
  for (const d of ['.claude/agents', 'src', 'scripts', 'evil', '.vscode', 'docs']) mkdirSync(join(repo, d), { recursive: true });
  const rules = '{"permissions":{"deny":["Bash(git push --force *)"]}}\n';
  writeFileSync(join(repo, '.claude', 'settings.json'), rules);
  writeFileSync(join(repo, '.claude', 'settings.local.json'), rules);
  writeFileSync(join(repo, '.mcp.json'), '{"mcpServers":{}}\n');
  // A checker that reads the settings: running it is a read, writing it is not.
  writeFileSync(join(repo, 'scripts', 'check-allowlist.mjs'), "import { readFileSync } from 'node:fs';\nJSON.parse(readFileSync('.claude/settings.json', 'utf8'));\nconsole.log('ok');\n");
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'src', 'a.test.ts'), "import { test } from 'node:test';\ntest('a', () => {});\n");
  writeFileSync(join(repo, 'evil', 'settings.json'), '{"permissions":{"allow":["Bash"]}}\n');
  writeFileSync(join(repo, 'new.json'), '{}\n');
  writeFileSync(join(repo, 'fix.sh'), "#!/bin/sh\necho '{}' > .claude/settings.json\n", { mode: 0o755 });
  writeFileSync(join(repo, 'build.sh'), "#!/bin/sh\n# writes nothing near .claude/settings.json\necho built > out.txt\n", { mode: 0o755 });
  writeFileSync(join(repo, 'fix.patch'), 'diff --git a/.claude/settings.json b/.claude/settings.json\n--- a/.claude/settings.json\n+++ b/.claude/settings.json\n@@ -1 +1 @@\n-{}\n+{"x":1}\n');
  writeFileSync(join(repo, 'ok.patch'), 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n');
  symlinkSync(join(repo, '.claude'), join(repo, 'link'));
  linkSync(join(repo, '.claude', 'settings.json'), join(repo, 'hard.json'));
  // A second repository without a .claude folder yet.
  const bare = join(root, 'bare');
  mkdirSync(join(bare, 'x'), { recursive: true });
  writeFileSync(join(bare, 'x', 'settings.json'), '{}\n');
  return { root, guard, home, configDir, repo, bare, rules };
}

type Rig = ReturnType<typeof rig>;
const R = rig();

function run(r: Rig, tool: string, toolInput: Record<string, unknown>, opts: { cwd?: string; mode?: string; env?: Record<string, string> } = {}) {
  const res = spawnSync(process.execPath, [`${r.guard}.cjs`], {
    input: JSON.stringify({
      session_id: SESSION,
      transcript_path: '/dev/null',
      cwd: opts.cwd ?? r.repo,
      permission_mode: opts.mode ?? 'default',
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: toolInput,
    }),
    cwd: opts.cwd ?? r.repo,
    env: { HOME: r.home, PATH: process.env.PATH ?? '/usr/bin:/bin', CLAUDE_CONFIG_DIR: r.configDir, ...opts.env },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { code: res.status, stderr: res.stderr };
}

const bash = (command: string, opts?: Parameters<typeof run>[3]) => run(R, 'Bash', { command, description: 'x' }, opts);

function refused(res: { code: number | null; stderr: string }, what: string) {
  assert.equal(res.code, 2, `refused: ${what}\n${res.stderr}`);
  assert.ok(res.stderr.startsWith(RULE_GUARD_MESSAGE), `the message names D-60: ${res.stderr}`);
}
function allowed(res: { code: number | null; stderr: string }, what: string) {
  assert.equal(res.code, 0, `allowed: ${what}\n${res.stderr}`);
}

test('Edit, Write, MultiEdit and NotebookEdit of a rule file are refused, in any folder', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['Edit', { file_path: join(R.repo, '.claude/settings.json'), old_string: 'a', new_string: 'b' }],
    ['Edit', { file_path: '.claude/settings.json', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: join(R.repo, '.claude/settings.local.json'), content: '{}' }],
    ['MultiEdit', { file_path: join(R.repo, '.mcp.json'), edits: [] }],
    ['NotebookEdit', { notebook_path: join(R.repo, '.claude/settings.json'), new_source: 'x' }],
    ['Write', { file_path: join(R.repo, 'scripts/check-allowlist.mjs'), content: 'process.exit(0)' }],
    ['Write', { file_path: join(R.home, '.claude/settings.json'), content: '{}' }],
    ['Write', { file_path: join(R.configDir, 'settings.json'), content: '{}' }],
    ['Write', { file_path: join(R.home, '.claude.json'), content: '{}' }],
    ['Write', { file_path: '/elsewhere/other-repo/.claude/settings.json', content: '{}' }],
    ['Edit', { file_path: join(R.repo, 'src/../.claude/./settings.json'), old_string: 'a', new_string: 'b' }],
    // Through a symlinked folder and a hard link made earlier.
    ['Write', { file_path: join(R.repo, 'link/settings.json'), content: '{}' }],
    ['Write', { file_path: join(R.repo, 'hard.json'), content: '{}' }],
  ];
  for (const [tool, input] of cases) refused(run(R, tool, input), `${tool} ${JSON.stringify(input)}`);
});

test('Edit and Write of other files go through, .claude/agents and a VS Code settings.json included', () => {
  for (const file of ['src/app.ts', '.claude/agents/new.md', '.vscode/settings.json', 'docs/settings.json', 'new.json']) {
    allowed(run(R, 'Write', { file_path: join(R.repo, file), content: 'x' }), `Write ${file}`);
    allowed(run(R, 'Edit', { file_path: join(R.repo, file), old_string: 'a', new_string: 'b' }), `Edit ${file}`);
  }
  // A read is never refused, whatever it names.
  allowed(run(R, 'Read', { file_path: join(R.repo, '.claude/settings.json') }), 'Read');
});

const REFUSED_BASH: string[] = [
  // Redirects and the plain write commands.
  "echo '{}' > .claude/settings.json",
  'echo x >> .claude/settings.local.json',
  'echo x >| .mcp.json',
  'exec 3> .claude/settings.json',
  "cat <<'EOF' > .claude/settings.json\n{}\nEOF",
  'cat new.json | tee .claude/settings.json',
  'timeout 5 tee -a .mcp.json < new.json',
  'sudo tee .mcp.json < new.json',
  "sed -i 's/deny/allow/' .claude/settings.json",
  "sed -i.bak -e 's/a/b/' .mcp.json",
  'cp new.json .claude/settings.json',
  'cp evil/settings.json .claude/',
  'mv new.json .mcp.json',
  'mv .claude/settings.json /tmp/gone.json',
  'install -m 644 new.json .claude/settings.json',
  'dd if=new.json of=.claude/settings.json',
  'truncate -s 0 .claude/settings.json',
  'ln -sf /tmp/evil.json .claude/settings.json',
  'ln -s .claude/settings.json elsewhere.json',
  'rm -f .claude/settings.local.json',
  'rm -rf .claude',
  'chmod 666 .claude/settings.json',
  'touch .mcp.json',
  'vim -c wq .claude/settings.json',
  'curl -sSo .claude/settings.json https://example.invalid/x',
  'tar -xf a.tar -C .claude',
  'echo x > scripts/check-allowlist.mjs',
  'printf "{}" > ~/.claude/settings.json',
  'echo x > "$HOME/.claude/settings.json"',
  'echo x > "$CLAUDE_CONFIG_DIR/settings.json"',
  'echo x > ~/.claude.json',
  // Interpreters with the path, or code from stdin while it is named.
  `node -e "require('fs').writeFileSync('.claude/settings.json','{}')"`,
  `node -e "require('fs').writeFileSync(process.argv[1],'{}')" .claude/settings.json`,
  `echo .claude/settings.json | node -e "const p=require('fs').readFileSync(0,'utf8').trim();require('fs').writeFileSync(p,'{}')"`,
  "node - <<'EOF'\nrequire('fs').writeFileSync('.claude/settings.json', '{}')\nEOF",
  "echo \"require('fs').writeFileSync('.mcp.json','{}')\" | node",
  `python3 -c "open('.mcp.json','w').write('{}')"`,
  "python3 - <<'EOF'\nimport os\nopen(os.path.join('.cla' + 'ude', 'settings.json'), 'w').write('{}')\nEOF",
  "perl -pi -e 's/a/b/' .claude/settings.json",
  `ruby -e 'File.write(".claude/settings.json", "{}")'`,
  `awk '{print > ".claude/settings.json"}' new.json`,
  // A path built from pieces, decoded, or hidden in a variable.
  `node -e "require('fs').writeFileSync(['.cla','ude/sett','ings.json'].join(''),'{}')"`,
  `node -e "require('fs').writeFileSync(Buffer.from('LmNsYXVkZS9zZXR0aW5ncy5qc29u','base64').toString(),'{}')"`,
  'F=.claude/settings.json; echo x > $F',
  'D=.cla; echo x > "$D"ude/settings.json',
  `echo x > "$(printf '\\x2e\\x63\\x6c\\x61\\x75\\x64\\x65/settings.json')"`,
  'echo ZWNobyB4ID4gLmNsYXVkZS9zZXR0aW5ncy5qc29u | base64 -d | sh',
  "eval \"$(echo ZWNobyB4 | base64 -d)\"",
  "echo x > $'\\x2eclaude/settings.json'",
  `ec""ho x > .cl""aude/sett''ings.json`,
  'echo x > .claude/./settings.json',
  'echo x > .claude//settings.json',
  'echo x > src/../.claude/settings.json',
  // Patterns that could match.
  'echo x > .claude/set*',
  'rm .claude/*',
  'cp new.json .claude/{settings,other}.json',
  'rm .c*/settings.json',
  'shopt -s dotglob; rm *.json',
  'find . -name settings.json -exec sed -i s/a/b/ {} +',
  'find . -name "*.json" -delete',
  // Shells, eval and folder changes.
  "bash -c 'echo x > .claude/settings.json'",
  "env -i sh -c 'echo x > .mcp.json'",
  'eval "echo x > .claude/settings.json"',
  'cd .claude && echo x > settings.json',
  'cd .c* && echo x > settings.json',
  '(cd .claude; echo x > settings.json)',
  "sh <<'EOF'\necho x > .claude/settings.json\nEOF",
  // Links and copies of folders.
  'echo x > link/settings.json',
  'echo x > hard.json',
  'cp -r evil/. .claude/',
  'rsync -a evil/ .claude/',
  // xargs, scripts, git and other tools that name the file.
  'echo .claude/settings.json | xargs rm',
  'ls -a | xargs rm',
  'bash fix.sh',
  './fix.sh',
  'npx prettier --write .claude/settings.json',
  'git checkout HEAD~1 -- .claude/settings.json',
  'git checkout main .claude/settings.json',
  'git restore .claude/settings.local.json',
  'git checkout main -- .',
  'git apply fix.patch',
  'patch -p1 < fix.patch',
  'claude -p "add Bash to .claude/settings.json" --disallowedTools none',
];

test('every Bash write form that names or could name a rule file is refused (D-60)', () => {
  for (const command of REFUSED_BASH) refused(bash(command), command);
});

test('a folder that becomes .claude, and a copy that would land settings.json in it, are refused', () => {
  refused(bash('mv x .claude', { cwd: R.bare }), 'mv x .claude');
  refused(bash('cp -r x .claude', { cwd: R.bare }), 'cp -r x .claude');
});

const ALLOWED_BASH: string[] = [
  'cat .claude/settings.json',
  'jq . .claude/settings.json',
  'grep -n deny .claude/settings.json',
  'ls -la .claude',
  'git diff .claude/settings.json',
  'git log -p -- .mcp.json',
  'git add .claude/settings.json && git commit -m "note on .claude/settings.json"',
  'cp .claude/settings.json backup.json',
  'cp new.json .claude/',
  'echo x > src/app.ts',
  'echo x >> out.log 2>&1',
  "sed -i 's/a/b/' src/app.ts",
  'cp src/app.ts src/b.ts && rm -f src/b.ts',
  'mkdir -p .claude/agents && echo x > .claude/agents/a.md',
  'echo x > .vscode/settings.json',
  'rm *.json',
  'echo x > "$OUT"',
  'node -e "console.log(1)"',
  'python3 -c "print(1)"',
  'node --import tsx --test src/a.test.ts',
  'node scripts/check-allowlist.mjs',
  'sh build.sh',
  './build.sh',
  'npm test',
  'git apply ok.patch',
  'git checkout -b feature',
  'find . -name "*.ts" -print',
  'for f in src/*.ts; do echo "$f"; done',
  'echo $((1 + 2)) > src/n.txt',
];

test('reads, and writes of other files, go through', () => {
  for (const command of ALLOWED_BASH) allowed(bash(command), command);
});

test('Bypass is covered by construction: the guard reads no permission mode and refuses the same', () => {
  for (const mode of ['bypassPermissions', 'acceptEdits', 'dontAsk', 'plan', 'default']) {
    refused(run(R, 'Edit', { file_path: join(R.repo, '.claude/settings.json'), old_string: 'a', new_string: 'b' }, { mode }), `Edit in ${mode}`);
    refused(bash(`node -e "require('fs').writeFileSync('.claude/settings.json','{}')"`, { mode }), `node -e in ${mode}`);
    allowed(run(R, 'Edit', { file_path: join(R.repo, 'src/app.ts'), old_string: 'a', new_string: 'b' }, { mode }), `a source file in ${mode}`);
  }
});

test('MCP tools: a path argument of a writing tool is refused; reads and ticket text naming the file are not', () => {
  refused(run(R, 'mcp__fs__write_file', { path: join(R.repo, '.claude/settings.json'), content: '{}' }), 'mcp write_file');
  refused(run(R, 'mcp__fs__move_file', { source: 'x', destination: '.mcp.json' }), 'mcp move_file');
  allowed(run(R, 'mcp__fs__read_file', { path: join(R.repo, '.claude/settings.json') }), 'mcp read_file');
  allowed(run(R, 'mcp__pilot__ticket_comment', { id: 'T-1', body: 'Proposal: add a deny to .claude/settings.json' }), 'ticket text');
});

test('input it cannot read is refused, never let through', () => {
  const res = spawnSync(process.execPath, [`${R.guard}.cjs`], { input: 'not json', env: { HOME: R.home, PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
  assert.equal(res.status, 2);
});

test('each refusal leaves one outbox line (session, tool, form, path), never the content; the portal makes it an audit row', async () => {
  const r = rig();
  const marker = 'CONTENT-MARKER-0123';
  refused(run(r, 'Bash', { command: `echo '${marker}' > .claude/settings.json` }), 'redirect');
  allowed(run(r, 'Bash', { command: 'echo x > src/app.ts' }), 'allowed');
  const file = join(r.home, '.claudepilot', 'outbox', `${GUARD_CHANNEL}.jsonl`);
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes(marker), 'no content in the outbox');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 1, 'one line per refusal, none for an allowed call');
  const line = JSON.parse(lines[0]!) as Record<string, string>;
  assert.equal(line.type, 'refused');
  assert.equal(line.session, SESSION);
  assert.equal(line.tool, 'Bash');
  assert.equal(line.form, 'redirect');
  assert.equal(line.path, join(r.repo, '.claude/settings.json'));
  assert.ok(lines[0]!.length < 4096, 'within the outbox line limit');
  // The rule file is as it was: the guard decides, and nothing ran.
  assert.equal(readFileSync(join(r.repo, '.claude/settings.json'), 'utf8'), r.rules);

  // The portal pulls it like any outbox channel and writes a guard.refused audit row, tied to the chat it ran in.
  const parsed = parseOutbox(`\x1e${GUARD_CHANNEL}.1.pulling\n${raw}`);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0]!.channel, GUARD_CHANNEL);
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-ruleguard-db-'));
  roots.push(dataDir);
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  try {
    const chat = new ChatStore(store);
    chat.create({ id: SESSION, workspaceId: 'docker/ws1', cwd: r.repo, title: 't', origin: 'ui' });
    assert.equal(recordGuardRefusals(store, 'docker/ws1', parsed.events.map((e) => e.event)), 1);
    const rows = chat.audit({ kind: 'guard' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, 'guard.refused');
    assert.equal(rows[0]!.sessionId, SESSION);
    assert.equal(rows[0]!.workspaceId, 'docker/ws1');
    assert.deepEqual([rows[0]!.detail.tool, rows[0]!.detail.form, rows[0]!.detail.path], ['Bash', 'redirect', join(r.repo, '.claude/settings.json')]);
    assert.ok(!JSON.stringify(rows[0]).includes(marker));
  } finally {
    store.close();
  }
});

test('the wrapper runs the Node half with a fixed node and without NODE_OPTIONS; a missing half refuses', (t) => {
  if (!['/usr/local/bin/node', '/usr/bin/node'].some((n) => existsSync(n))) return t.skip('no node at /usr/local/bin or /usr/bin here');
  const r = rig();
  const hook = (command: string, env: Record<string, string> = {}) =>
    spawnSync('/bin/sh', ['-c', `${r.guard} || exit 2`], {
      input: JSON.stringify({ session_id: SESSION, cwd: r.repo, tool_name: 'Bash', tool_input: { command } }),
      cwd: r.repo,
      env: { HOME: r.home, PATH: '/usr/bin:/bin', ...env },
      encoding: 'utf8',
    });
  assert.equal(hook('echo x > src/app.ts').status, 0);
  assert.equal(hook('echo x > .claude/settings.json').status, 2);
  // A NODE_OPTIONS that would stop node from starting changes nothing: the wrapper drops it.
  assert.equal(hook('echo x > src/app.ts', { NODE_OPTIONS: '--require /nonexistent/preload.js' }).status, 0);
  renameSync(`${r.guard}.cjs`, `${r.guard}.gone`);
  assert.equal(hook('echo x > src/app.ts').status, 2, 'a guard that cannot run refuses');
  chmodSync(r.guard, 0o000);
  assert.equal(hook('echo x > src/app.ts').status, 2, 'a guard that cannot start refuses');
});

test('delivery: the policy owner ships the guard root-owned outside every workspace folder, and only its own hook', () => {
  const bundle = compile({
    portalId: 'p',
    generation: 1,
    claudeVersion: '2.1.296 (Claude Code)',
    fragments: [FOUNDATION, { owner: 'policy', files: RULE_GUARD_FILES, settings: { env: {}, hooks: RULE_GUARD_HOOKS } }],
  });
  for (const path of [RULE_GUARD_PATH, `${RULE_GUARD_PATH}.cjs`]) {
    const f = bundle.files.find((x) => x.path === path);
    assert.ok(f, path);
    assert.deepEqual([f.uid, f.gid], [0, 0]);
    assert.ok(path.startsWith('/etc/claudepilot/bin/'));
  }
  const dropIn = JSON.parse(bundle.files.find((f) => f.path.endsWith('10-claudepilot-policy.json'))!.content) as { hooks: typeof RULE_GUARD_HOOKS };
  assert.deepEqual(dropIn.hooks, RULE_GUARD_HOOKS);
  assert.equal(dropIn.hooks.PreToolUse[0]!.hooks[0]!.command, `${RULE_GUARD_PATH} || exit 2`);
  // The matcher covers the file tools, Bash and MCP tools; not reads.
  const matcher = new RegExp(`^(?:${RULE_GUARD_MATCHER})$`);
  for (const tool of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__fs__write_file']) assert.ok(matcher.test(tool), tool);
  for (const tool of ['Read', 'Grep', 'Glob']) assert.ok(!matcher.test(tool), tool);
  // Nobody else writes its scripts, and its drop-in runs nothing else.
  assert.equal(mayWrite('mcpset', RULE_GUARD_PATH), false);
  assert.equal(mayWrite('foundation', RULE_GUARD_PATH), false);
  assert.throws(
    () => compile({ portalId: 'p', generation: 1, claudeVersion: null, fragments: [{ owner: 'policy', settings: { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/home/node/x.sh' }] }] } } }] }),
    /may only run the policy owner/,
  );
  assert.throws(() => compile({ portalId: 'p', generation: 1, claudeVersion: null, fragments: [{ owner: 'policy', settings: { hooks: { SessionStart: [] } } }] }), /hooks\.PreToolUse/);
  // The Node half is a String.raw: no backtick or dollar-brace may hide in it.
  assert.ok(!RULE_GUARD_SCRIPT.includes('`') && !RULE_GUARD_SCRIPT.includes('$' + '{'));
});
