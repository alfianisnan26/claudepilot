import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile, CompileError, versionAtLeast } from './compile.js';
import { mayUseEnv, mayWrite } from './ownership.js';
import { FOUNDATION } from './reconciler.js';
import { NODE, ROOT, type Fragment } from './types.js';

const base = { portalId: 'p1', generation: 1, claudeVersion: '2.1.296 (Claude Code)', now: new Date('2026-10-10T00:00:00Z') };
const file = (path: string, content = 'x') => ({ path, content, mode: 0o644, uid: ROOT, gid: ROOT });

test('a pool writes only its own paths and settings', () => {
  assert.ok(mayWrite('account', '/etc/claudepilot/account/a.key'));
  assert.ok(mayWrite('account', '/etc/claudepilot/bin/account-key'));
  assert.ok(!mayWrite('account', '/etc/claudepilot/secrets/x'));
  assert.ok(!mayWrite('foundation', '/etc/claudepilot/bin/account-key'), 'pool script prefixes belong to the pool');
  assert.ok(mayWrite('foundation', '/etc/claudepilot/bin/outbox-pull'));
  assert.throws(() => compile({ ...base, fragments: [{ owner: 'account', files: [file('/etc/claudepilot/secrets/x')] }] }), CompileError);
  assert.throws(() => compile({ ...base, fragments: [{ owner: 'account', settings: { claudeMd: 'hi' } }] }), /may not set claudeMd/);
  assert.throws(() => compile({ ...base, fragments: [{ owner: 'account', settings: { env: { GH_TOKEN: 'x' } } }] }), /may not set env GH_TOKEN/);
});

test('no setting is decided by alphabetical accident: scalars and env vars have one owner', () => {
  const persona: Fragment = { owner: 'persona', settings: { model: 'opus' } };
  const policy: Fragment = { owner: 'policy', settings: { env: { CLAUDE_CODE_MAX_RETRIES: '4' } } };
  const secrets: Fragment = { owner: 'secrets', settings: { env: { CLAUDE_CODE_MAX_RETRIES: '9' } } };
  assert.doesNotThrow(() => compile({ ...base, fragments: [persona, policy] }));
  assert.throws(() => compile({ ...base, fragments: [policy, secrets] }), /secrets: may not set env CLAUDE_CODE_MAX_RETRIES/, 'policy declares it (env registry)');
  // Nested blocks merge key by key, so ownership is per leaf: the same server field twice is a conflict.
  const mcp: Fragment = { owner: 'mcpset', settings: { managedMcpServers: { docs: { url: 'https://a.example/mcp' } } } };
  const browser: Fragment = { owner: 'browser', settings: { managedMcpServers: { docs: { url: 'https://b.example/mcp' } } } };
  assert.throws(() => compile({ ...base, fragments: [mcp, browser] }), /managedMcpServers\.docs\.url is already set by mcpset/);
});

test('list settings may come from several owners', () => {
  const a: Fragment = { owner: 'policy', settings: { permissions: { deny: ['Read(//etc/claudepilot/**)'] } } };
  const b: Fragment = { owner: 'skillset', settings: { permissions: { deny: ['Skill(frontend:review)'] } } };
  const bundle = compile({ ...base, fragments: [a, b] });
  assert.equal(bundle.files.length, 2, 'two drop-ins');
});

test('write order: referenced files first, drop-ins after; the manifest lists every file', () => {
  const bundle = compile({
    ...base,
    fragments: [{ owner: 'account', files: [file('/etc/claudepilot/account/a.key', 'k')], settings: { apiKeyHelper: 'x' } }],
  });
  assert.deepEqual(bundle.files.map((f) => f.path), ['/etc/claudepilot/account/a.key', '/etc/claude-code/managed-settings.d/40-claudepilot-account.json']);
  assert.deepEqual(Object.keys(bundle.manifest.files), bundle.files.map((f) => f.path));
  assert.equal(JSON.parse(bundle.files[1]!.content).apiKeyHelper, 'x');
});

test('the hash covers what is delivered, not when', () => {
  const frags: Fragment[] = [{ owner: 'account', settings: { apiKeyHelper: 'x' } }];
  const a = compile({ ...base, generation: 1, fragments: frags });
  const b = compile({ ...base, generation: 7, now: new Date(), fragments: frags });
  assert.equal(a.hash, b.hash);
  const c = compile({ ...base, fragments: [{ owner: 'account', settings: { apiKeyHelper: 'y' } }] });
  assert.notEqual(a.hash, c.hash);
});

test('fragments needing a newer Claude Code are left out, with the reason', () => {
  const bundle = compile({ ...base, claudeVersion: '2.1.200', fragments: [{ owner: 'account', minClaudeVersion: '2.1.296', settings: { apiKeyHelper: 'x' } }] });
  assert.equal(bundle.files.length, 0);
  assert.match(bundle.skipped[0]!.reason, /2\.1\.296/);
  assert.ok(versionAtLeast('2.1.296 (Claude Code)', '2.1.296'));
  assert.ok(!versionAtLeast('2.0.999', '2.1.0'));
});

/* ---------- Backward compatibility: nothing new unless a fragment asks for it ---------- */

/** An Account Pool fragment shaped exactly as `accounts/pools.ts` builds one. */
const accountFragment = (env: Record<string, string>): Fragment => ({
  owner: 'account',
  pool: { id: 'pool-1', revision: 3 },
  minClaudeVersion: '2.1.296',
  dirs: [{ path: '/etc/claudepilot/account', mode: 0o750, uid: ROOT, gid: NODE }],
  files: [
    { path: '/etc/claudepilot/account/acc-1.key', content: 'sk-ant-api03-test-key', mode: 0o440, uid: ROOT, gid: NODE, secretRef: 'account:acc-1' },
    { path: '/etc/claudepilot/bin/account-key', content: '#!/bin/sh\necho key\n', mode: 0o755, uid: ROOT, gid: ROOT },
    { path: '/etc/claudepilot/bin/account-event', content: '#!/bin/sh\nexit 0\n', mode: 0o755, uid: ROOT, gid: ROOT },
  ],
  settings: {
    apiKeyHelper: '/etc/claudepilot/bin/account-key acc-1',
    env,
    hooks: { StopFailure: [{ matcher: '*', hooks: [{ type: 'command', command: '/etc/claudepilot/bin/account-event' }] }] },
  },
});
const accountEnv = {
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_AUTH_TOKEN: '',
  CLAUDE_CODE_USE_BEDROCK: '',
  CLAUDE_CODE_USE_VERTEX: '',
  CLAUDE_CODE_USE_FOUNDRY: '',
  CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '60000',
  CLAUDEPILOT_ACCOUNT: 'acc-1',
  CLAUDEPILOT_WORKSPACE: 'docker/ws1',
  DISABLE_LOGIN_COMMAND: '',
};

test('workspaces with only an account pool compile to the same bundle hash as before the marketplace and tombstones', () => {
  // Recorded with the compiler as it was before F6 (commit 3ed0335), for the reconciler's own foundation fragment.
  const unassigning: Fragment = { owner: 'account', pool: { id: 'pool-1', revision: 0 }, settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', DISABLE_LOGIN_COMMAND: '', CLAUDEPILOT_ACCOUNT: '' } } };
  const cases: [string, Fragment[], string][] = [
    ['assigned', [accountFragment({ ...accountEnv, ANTHROPIC_MODEL: 'claude-opus-5-5', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000' })], '2f7fdfe050e2cde876ba261d3cd99cba77332ce6385324fbfd5dfaaad81d0ac2'],
    ['minimal', [accountFragment(accountEnv)], '7a751501ab236d6ff5d1fd4b81e1bb3ac25cfc4ad0e03264eea34bf40b8ae0d8'],
    ['unassigning', [unassigning], '25f9aa7072e14d0d49b8cf615ce6e947276eaf14ec0e7faeaf51f9e85bac5520'],
    ['no pools', [], '1391b35c5c4f390048752a3bb1d7ba51ab19332ebebcc5f154c1ab585cedb855'],
  ];
  for (const [label, fragments, hash] of cases) {
    // As the reconciler compiles: with the applied state and both workspace states.
    for (const running of [true, false]) {
      const bundle = compile({ ...base, fragments: [FOUNDATION, ...fragments], previous: { env: undefined }, tombstones: [], running });
      assert.equal(bundle.hash, hash, `${label} (${running ? 'running' : 'stopped'})`);
      assert.deepEqual([bundle.plugins, bundle.tombstones, bundle.revoked], [[], [], []]);
      assert.ok(!('plugins' in bundle.manifest) && !('env' in bundle.manifest), 'the manifest has nothing new');
      assert.ok(bundle.files.every((f) => !f.path.includes('/marketplace') && !f.path.endsWith('00-claudepilot-base.json')));
    }
  }
  // An account unassign removes names, but the account pool doesn't ask for tombstones: none appear.
  const before = compile({ ...base, fragments: [FOUNDATION, accountFragment(accountEnv)] });
  const after = compile({ ...base, fragments: [FOUNDATION, unassigning], previous: { env: before.manifest.env }, running: true });
  assert.equal(after.hash, cases[2]![2]);
  assert.deepEqual(after.tombstones, []);
});

/* ---------- Env registry (secrets A2) ---------- */

test('env registry: each name is checked against its owner, and Secrets & env never takes a name another owner declares', () => {
  assert.ok(mayUseEnv('secrets', 'GH_CONFIG_DIR'));
  assert.ok(mayUseEnv('secrets', 'LINEAR_API_KEY'));
  assert.ok(!mayUseEnv('secrets', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'), 'never CLAUDE_*');
  assert.ok(!mayUseEnv('secrets', 'CLAUDE_CONFIG_DIR'));
  assert.ok(!mayUseEnv('secrets', 'CLAUDEPILOT_VERIFY'), 'never the portal markers');
  assert.ok(!mayUseEnv('secrets', 'ANTHROPIC_BASE_URL'), 'account declares ANTHROPIC_*');
  assert.ok(!mayUseEnv('secrets', 'MCP_TIMEOUT'), 'MCP sets declare it');
  assert.ok(!mayUseEnv('secrets', 'DISABLE_LOGIN_COMMAND'));
  assert.ok(mayUseEnv('account', 'ANTHROPIC_BASE_URL') && mayUseEnv('mcpset', 'MCP_TIMEOUT') && mayUseEnv('policy', 'CLAUDE_CODE_MAX_RETRIES'));
  assert.ok(!mayUseEnv('mcpset', 'GH_TOKEN'), 'owners without a catch-all stay within their declaration');
  assert.throws(() => compile({ ...base, fragments: [{ owner: 'secrets', settings: { env: { ANTHROPIC_API_KEY: 'x' } } }] }), /secrets: may not set env ANTHROPIC_API_KEY/);
  assert.throws(() => compile({ ...base, fragments: [{ owner: 'secrets', settings: { env: 'A=1' } }] }), /env must be an object/);
});

/* ---------- Per-owner settings checks ---------- */

test('Secrets & env may deny only Read and Edit on its own files, its drop-in and other processes’ environments (secrets A1)', () => {
  const secrets = (deny: string[]): Fragment => ({ owner: 'secrets', settings: { permissions: { deny } } });
  const ok = [
    'Read(//etc/claudepilot/secrets/**)',
    'Edit(//etc/claudepilot/secrets/**)',
    'Read(//etc/claudepilot/secrets/files/LINEAR_API_KEY)',
    'Read(//etc/claude-code/managed-settings.d/20-claudepilot-env.json)',
    'Edit(//etc/claude-code/managed-settings.d/20-claudepilot-env.json)',
    'Read(//proc/**/environ)',
  ];
  assert.doesNotThrow(() => compile({ ...base, fragments: [secrets(ok)] }));
  for (const bad of [
    'Bash(*)',
    'Read(/etc/claudepilot/secrets/**)', // a single slash is relative to the settings file
    'Read(//etc/claudepilot/secretsX/**)',
    'Read(//etc/claudepilot/secrets/../account/**)',
    'Read(//etc/claude-code/managed-settings.d/40-claudepilot-account.json)',
    'Edit(//proc/**/environ)',
    'Write(//etc/claudepilot/secrets/**)',
    'Read(//etc/claudepilot/secrets/x) Bash(*)',
  ])
    assert.throws(() => compile({ ...base, fragments: [secrets([bad])] }), /secrets: permissions\.deny: only Read/, bad);
  assert.throws(() => compile({ ...base, fragments: [{ owner: 'secrets', settings: { permissions: { allow: ['Read(//etc/claudepilot/secrets/**)'] } } }] }), /may set only permissions\.deny/);
  assert.throws(() => compile({ ...base, fragments: [{ owner: 'secrets', settings: { sandbox: { enabled: true } } }] }), /may set only sandbox\.credentials/);
});

test('sandbox merges key by key: policy owns its switches, Secrets & env its credentials', () => {
  const policy: Fragment = { owner: 'policy', settings: { sandbox: { enabled: true, failIfUnavailable: true } } };
  const secrets: Fragment = { owner: 'secrets', settings: { sandbox: { credentials: { files: [{ path: '/etc/claudepilot/secrets/files/X', mode: 'deny' }] } } } };
  const bundle = compile({ ...base, fragments: [policy, secrets] });
  assert.equal(bundle.files.length, 2);
  assert.throws(() => compile({ ...base, fragments: [{ owner: 'policy', settings: { sandbox: { credentials: {} } } }] }), /sandbox\.credentials belongs to Secrets & env/);
  // Lists in list keys combine; scalars there stay with the owner allowed to set them.
  assert.doesNotThrow(() => compile({ ...base, fragments: [{ owner: 'policy', settings: { permissions: { defaultMode: 'plan', deny: ['Bash(curl *)'] } } }, { owner: 'secrets', settings: { permissions: { deny: ['Read(//etc/claudepilot/secrets/**)'] } } }] }));
  assert.throws(
    () => compile({ ...base, fragments: [{ owner: 'policy', settings: { permissions: { defaultMode: 'plan' } } }, { owner: 'mcpset', settings: { permissions: { defaultMode: 'acceptEdits' } } }] }),
    /mcpset: may set only permissions\.ask and permissions\.deny, not permissions\.defaultMode/,
  );
});

test('MCP sets and skillsets write rules for their own tools and skills only', () => {
  assert.doesNotThrow(() => compile({ ...base, fragments: [{ owner: 'mcpset', settings: { permissions: { ask: ['mcp__plugin_cpm-team_github__create_issue'], deny: ['mcp__plugin_cpm-team_x__*'] } } }] }));
  assert.throws(() => compile({ ...base, fragments: [{ owner: 'mcpset', settings: { permissions: { deny: ['Bash(rm *)'] } } }] }), /only rules on mcp__plugin_cpm-/);
  assert.throws(() => compile({ ...base, fragments: [{ owner: 'mcpset', settings: { permissions: { deny: ['mcp__plugin_cpm-x__t) Bash(*'] } } }] }), /only rules on mcp__plugin_cpm-/);
  assert.doesNotThrow(() => compile({ ...base, fragments: [{ owner: 'skillset', settings: { permissions: { deny: ['Skill(frontend:review)', 'Skill(frontend:review *)'] } } }] }));
  assert.throws(() => compile({ ...base, fragments: [{ owner: 'skillset', settings: { permissions: { deny: ['Skill(cpm-team:x)'] } } }] }), /only Skill\(<plugin>:<skill>\) rules on its own plugins/);
  assert.throws(() => compile({ ...base, fragments: [{ owner: 'skillset', settings: { permissions: { allow: ['Skill(frontend:review)'] } } }] }), /may set only permissions\.deny/);
});

test('a drop-in holding values only the workspace user may read is root:node 0440; the others stay root:root 0644', () => {
  const bundle = compile({ ...base, fragments: [{ owner: 'secrets', settings: { env: { LINEAR_API_KEY: 'x' } } }, { owner: 'account', settings: { apiKeyHelper: 'h' } }] });
  const mode = (p: string) => bundle.files.filter((f) => f.path.endsWith(p)).map((f) => [f.mode, f.uid, f.gid]);
  assert.deepEqual(mode('20-claudepilot-env.json'), [[0o440, ROOT, NODE]]);
  assert.deepEqual(mode('40-claudepilot-account.json'), [[0o644, ROOT, ROOT]]);
});
