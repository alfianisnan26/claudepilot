// The feature-minimum registry, the version helpers, the image tag scheme and the constants the other areas derive from the registry
// (docs/prd/claude-version-pinning.md §5, FR5): one list, exact versions, and every older constant still exports what it did.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLAUDE_CANARY_CHECKS,
  CLAUDE_FEATURES,
  CLAUDE_IMAGE_REPO,
  CLAUDE_LABELS,
  claudeBelowMinimum,
  claudeFeature,
  claudeImageRef,
  claudeImageTag,
  claudeMinimum,
  claudeObservedVersions,
  claudeVersionAtLeast,
  claudeVersionOfImageRef,
  compareClaudeVersions,
  DEFAULT_CLAUDE_CODE_VERSION,
  isExactClaudeVersion,
  normalizeClaudeVersion,
  parseClaudeVersion,
  SKILLSET_MIN_CLAUDE_VERSION,
} from '@portal/contracts';
import { BROWSER_MIN_CLAUDE } from '../browser/compile.js';
import { MCP_MIN_CLAUDE, VERIFY_TESTED_CLAUDE } from '../mcp/spec.js';
import { MIN_CLAUDE_VERSION } from '../settings/lockdown.js';
import { canaryChecks } from './canary/checks.js';

test('versions: exact means three numbers and nothing else; unknown stays unknown', () => {
  for (const ok of ['2.1.296', '0.0.1', '10.20.30000']) assert.equal(isExactClaudeVersion(ok), true, ok);
  for (const bad of ['latest', '^2.1.296', '~2.1', '2.1', 'v2.1.296', '2.1.296-beta', '2.1.296 (Claude Code)', ' 2.1.296', '', '2.1.296\n', '99999.1.1', undefined, null, 2.1, {}]) assert.equal(isExactClaudeVersion(bad), false, String(bad));
  assert.deepEqual(parseClaudeVersion('2.1.296 (Claude Code)'), [2, 1, 296]);
  assert.equal(parseClaudeVersion('no version'), null);
  assert.equal(normalizeClaudeVersion('2.1.296 (Claude Code)\n'), '2.1.296');
  assert.equal(normalizeClaudeVersion(null), null);
  assert.equal(compareClaudeVersions('2.1.296', '2.1.273')! > 0, true);
  assert.equal(compareClaudeVersions('2.1.9', '2.1.10')! < 0, true, 'numeric, not text, order');
  assert.equal(compareClaudeVersions('2.1.296', '2.1.296'), 0);
  assert.equal(compareClaudeVersions('2.1.296', 'unknown'), null);
  assert.equal(claudeVersionAtLeast('2.1.296', '2.1.296'), true);
  assert.equal(claudeVersionAtLeast('2.1.287', '2.1.296'), false);
  assert.equal(claudeVersionAtLeast(null, '2.1.296'), null, 'unknown is neither fine nor too old');
  assert.equal(claudeVersionAtLeast('garbage', '2.1.296'), null);
});

test('image tags: cc-<x.y.z> in a repository, and the version read back only from that scheme', () => {
  assert.equal(claudeImageTag('2.1.296'), 'cc-2.1.296');
  assert.equal(claudeImageRef('2.1.296'), `${CLAUDE_IMAGE_REPO}:cc-2.1.296`);
  assert.equal(claudeImageRef('2.1.296', 'ghcr.io/me/claudepilot-workspace'), 'ghcr.io/me/claudepilot-workspace:cc-2.1.296');
  assert.equal(claudeVersionOfImageRef('claudepilot-workspace:cc-2.1.296'), '2.1.296');
  assert.equal(claudeVersionOfImageRef('registry.example:5000/x/y:cc-2.1.296'), '2.1.296');
  for (const other of ['claudepilot-workspace:latest', 'claudepilot-workspace:cc-latest', 'claudepilot-workspace:cc-2.1', 'claudepilot-workspace:cc-2.1.296-rc1', 'sha256:abc', '', null, undefined, 'cc-2.1.296'])
    assert.equal(claudeVersionOfImageRef(other), null, String(other));
  assert.equal(CLAUDE_LABELS.version, 'claudepilot.claude-version');
});

test('the registry: unique ids, exact minimums, an observed entry says where it was observed, every source named', () => {
  assert.ok(isExactClaudeVersion(DEFAULT_CLAUDE_CODE_VERSION));
  assert.equal(new Set(CLAUDE_FEATURES.map((f) => f.id)).size, CLAUDE_FEATURES.length, 'ids are unique');
  for (const f of CLAUDE_FEATURES) {
    assert.ok(isExactClaudeVersion(f.needs), `${f.id}: needs is exact`);
    assert.ok(f.label.length > 0 && f.label.split(' ').length <= 3, `${f.id}: a label of one to three words`);
    assert.ok(f.why.length > 20, `${f.id}: says why`);
    assert.ok(f.source.length > 0, `${f.id}: names its source`);
    assert.ok(['observed', 'documented', 'unverified'].includes(f.basis));
    if (f.basis === 'observed') assert.ok(f.observedOn.length > 0 && f.observedOn.every(isExactClaudeVersion) && f.observedOn.includes(f.needs), `${f.id}: observed on the version it needs`);
    if (f.enforced) assert.ok(f.degrades, `${f.id}: an enforced minimum says what happens below it`);
    // The minimum is never newer than what was observed: nothing is claimed above what was run.
    for (const v of f.observedOn) assert.ok((compareClaudeVersions(v, f.needs) ?? -1) >= 0, `${f.id}: observed on ${v}, below its own minimum`);
  }
  assert.equal(claudeFeature('mcp-lockdown').basis, 'documented', 'the one minimum taken from the vendor’s documentation says so');
  assert.throws(() => claudeFeature('nope' as never), /No Claude Code feature/);
});

test('the older constants are the registry’s, and keep working', () => {
  assert.equal(MIN_CLAUDE_VERSION, claudeMinimum('mcp-lockdown'));
  assert.equal(MIN_CLAUDE_VERSION, '2.1.273');
  assert.equal(MCP_MIN_CLAUDE, claudeMinimum('mcp-sets'));
  assert.equal(BROWSER_MIN_CLAUDE, claudeMinimum('browser-pool'));
  assert.equal(SKILLSET_MIN_CLAUDE_VERSION, claudeMinimum('skillsets'));
  assert.deepEqual(VERIFY_TESTED_CLAUDE, claudeFeature('mcp-sets').observedOn);
  for (const v of [MCP_MIN_CLAUDE, BROWSER_MIN_CLAUDE, SKILLSET_MIN_CLAUDE_VERSION]) assert.equal(v, '2.1.296');
});

test('below the minimum: only known versions are judged, each feature says whether the portal enforces it', () => {
  assert.deepEqual(claudeBelowMinimum('2.1.296'), []);
  assert.deepEqual(claudeBelowMinimum(null), [], 'an unknown version raises nothing');
  assert.deepEqual(claudeBelowMinimum('unreadable'), []);
  const old = claudeBelowMinimum('2.1.280 (Claude Code)');
  assert.ok(old.some((b) => b.feature === 'mcp-sets' && b.enforced && b.needs === '2.1.296'));
  assert.ok(old.some((b) => b.feature === 'chat-protocol' && !b.enforced));
  assert.ok(!old.some((b) => b.feature === 'mcp-lockdown'), '2.1.280 meets the lockdown’s 2.1.273');
  assert.deepEqual(claudeBelowMinimum('2.1.270').map((b) => b.feature).includes('mcp-lockdown'), true);
  assert.deepEqual(claudeObservedVersions().slice(-1), ['2.1.296']);
  assert.ok(claudeObservedVersions().includes('2.1.287'), 'safe-mode was observed on 2.1.287');
});

test('the canary: every definition has a runner and every runner a definition, in the contracts’ order, the update pin last', () => {
  const runners = canaryChecks().map((c) => c.def.id);
  assert.deepEqual(runners, CLAUDE_CANARY_CHECKS.map((d) => d.id));
  assert.equal(runners.at(-1), 'update-pin');
  assert.equal(new Set(runners).size, runners.length);
  const featureIds = new Set(CLAUDE_FEATURES.map((f) => f.id));
  for (const d of CLAUDE_CANARY_CHECKS) {
    assert.ok(d.label.split(' ').length <= 3, `${d.id}: a short label`);
    assert.ok(d.features.length > 0 && d.features.every((f) => featureIds.has(f)), `${d.id}: names registry features`);
    assert.ok(d.what.length > 30);
  }
  // Every feature the portal degrades on is exercised by a check, except these two, which the canary does not cover yet (PRD §19, open questions):
  // skill plugins need the skills pool's compile pipeline as a fixture, and the browser plugin needs Chrome; each has its own integration test.
  const NOT_CANARIED = new Set(['skillsets', 'browser-pool']);
  const covered = new Set(CLAUDE_CANARY_CHECKS.flatMap((d) => d.features));
  for (const f of CLAUDE_FEATURES.filter((x) => x.enforced && !NOT_CANARIED.has(x.id))) assert.ok(covered.has(f.id), `${f.id} is enforced but no canary check exercises it`);
  for (const id of NOT_CANARIED) assert.equal(covered.has(id as never), false, `${id} now has a check: take it out of the list above`);
});
