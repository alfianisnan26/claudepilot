import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile, CompileError, versionAtLeast } from './compile.js';
import { mayWrite } from './ownership.js';
import { ROOT, type Fragment } from './types.js';

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
  assert.throws(() => compile({ ...base, fragments: [policy, secrets] }), /already set by policy/);
});

test('list settings may come from several owners', () => {
  const a: Fragment = { owner: 'policy', settings: { permissions: { deny: ['Read(//etc/claudepilot/**)'] } } };
  const b: Fragment = { owner: 'skillset', settings: { permissions: { deny: ['Skill(x)'] } } };
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
