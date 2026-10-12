// The pure parts: reading `claude doctor`, a workspace's flags, the canary report and the warnings (docs/prd/claude-version-pinning.md §12).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_CANARY_SUITE, type ClaudeCanaryResult, type ClaudeCanaryRun, type ClaudeCandidate } from '@portal/contracts';
import { buildReport, canaryWarnings, flagsOf, parseDoctor, testedSet, unacceptedFailures, workspaceWarnings } from './info.js';
import { verdictOf } from './store.js';

const result = (id: string, status: ClaudeCanaryResult['status']): ClaudeCanaryResult => ({ id, status, durationMs: 5, summary: status, detail: '' });
function run(version: string, subject: ClaudeCanaryRun['subject'], statuses: Record<string, ClaudeCanaryResult['status']>, over: Partial<ClaudeCanaryRun> = {}): ClaudeCanaryRun {
  const results = Object.entries(statuses).map(([id, s]) => result(id, s));
  const count = (s: string) => results.filter((r) => r.status === s).length;
  return {
    id: 1, trigger: 'scheduled', subject, version, reported: version, image: `claudepilot-workspace:cc-${version}`, mode: subject === 'candidate' ? 'scratch' : 'image', status: 'done', note: null,
    startedAt: '2026-10-12T06:00:00.000Z', finishedAt: '2026-10-12T06:01:00.000Z', suite: CLAUDE_CANARY_SUITE, results, pass: count('pass'), fail: count('fail'), skipped: count('skipped'),
    verdict: verdictOf(count('pass'), count('fail'), count('skipped')), actor: 'system:claude-canary', ...over,
  };
}
const candidateInfo = (version: string | null, status: ClaudeCandidate['status'] = 'newer'): ClaudeCandidate => ({ status, version, channels: version ? { latest: version } : {}, checkedAt: '2026-10-12T06:00:00.000Z', reason: null });

test('claude doctor: the Auto-updates line says off, on, or nothing we can read', () => {
  assert.equal(parseDoctor('Running: npm-global (2.1.296)\nAuto-updates: disabled (set by env: DISABLE_UPDATES)\nAuto-update channel: latest'), 'off');
  assert.equal(parseDoctor('Auto-updates: disabled (set by env: DISABLE_AUTOUPDATER)'), 'off');
  assert.equal(parseDoctor('Running: npm-global (2.1.296)\nAuto-updates: enabled\nAuto-update channel: latest'), 'on');
  assert.equal(parseDoctor('Auto-updates: Managed by package manager'), 'off');
  assert.equal(parseDoctor('Auto-updates: something new we do not know'), 'unknown');
  assert.equal(parseDoctor(''), 'unknown');
  assert.equal(parseDoctor('Auto-update channel: latest'), 'unknown', 'the channel line is not the switch');
});

test('flags: a flag is a fact; unknown raises nothing', () => {
  const tested = testedSet(['2.1.300']);
  assert.deepEqual(flagsOf({ pinned: '2.1.296', running: '2.1.296', autoUpdate: 'off', tested }), []);
  assert.deepEqual(flagsOf({ pinned: null, running: null, autoUpdate: 'unknown', tested }), [], 'nothing known: nothing flagged');
  assert.deepEqual(flagsOf({ pinned: '2.1.296', running: null, autoUpdate: 'off', tested }), [], 'running unknown: not "differs"');
  assert.deepEqual(flagsOf({ pinned: '2.1.296', running: '2.1.300', autoUpdate: 'off', tested }), ['differs']);
  assert.deepEqual(flagsOf({ pinned: '2.1.300', running: '2.1.300', autoUpdate: 'off', tested }), [], 'a version a canary passed on is tested');
  assert.deepEqual(flagsOf({ pinned: '2.1.310', running: '2.1.310', autoUpdate: 'off', tested }), ['untested']);
  assert.deepEqual(flagsOf({ pinned: '2.1.260', running: '2.1.260', autoUpdate: 'on', tested }), ['below-minimum', 'auto-update-on', 'untested']);
  assert.ok(testedSet([]).has('2.1.296') && testedSet([]).has('2.1.287'), 'the lab’s versions are tested without a run');
});

test('the report: each item for the installed version and the candidate, and what the candidate breaks', () => {
  const installed = run('2.1.296', 'installed', { 'stream-turn': 'pass', 'get-usage': 'pass', 'rate-limit-event': 'pass', 'mcp-login': 'fail' });
  const candidate = run('2.1.300', 'candidate', { 'stream-turn': 'fail', 'get-usage': 'pass', 'rate-limit-event': 'skipped', 'mcp-login': 'fail' });
  const report = buildReport(installed, candidate, candidateInfo('2.1.300'));
  const by = Object.fromEntries(report.items.map((i) => [i.id, i]));
  assert.deepEqual([by['stream-turn']!.installed, by['stream-turn']!.candidate, by['stream-turn']!.breaks], ['pass', 'fail', true]);
  assert.equal(by['get-usage']!.breaks, false);
  assert.equal(by['rate-limit-event']!.breaks, false, 'a skipped item breaks nothing');
  assert.equal(by['mcp-login']!.breaks, false, 'failing on both is not a regression (the installed run warns about it)');
  assert.deepEqual(report.breaks, ['stream-turn']);
  assert.equal(by['version']!.installed, null, 'an item with no result is null, not a pass');
  assert.equal(report.comparable, true);
  assert.equal(buildReport(installed, run('2.1.300', 'candidate', {}, { suite: CLAUDE_CANARY_SUITE + 1 }), candidateInfo('2.1.300')).comparable, false, 'another suite revision is a partial comparison');
  const empty = buildReport(null, null, candidateInfo(null, 'unavailable'));
  assert.deepEqual([empty.breaks, empty.installed, empty.candidate], [[], null, null]);
});

test('warnings: the candidate that breaks something, and an installed version that fails; both name the items and carry a stable id', () => {
  const installed = run('2.1.296', 'installed', { 'stream-turn': 'pass', 'get-usage': 'pass', 'mcp-login': 'fail' });
  const candidate = run('2.1.300', 'candidate', { 'stream-turn': 'fail', 'get-usage': 'fail', 'mcp-login': 'fail' });
  const report = buildReport(installed, candidate, candidateInfo('2.1.300'));
  const warnings = canaryWarnings(report, '2026-10-12T06:02:00.000Z');
  assert.deepEqual(warnings.map((w) => w.kind).sort(), ['candidate-breaks', 'installed-fails']);
  const breaks = warnings.find((w) => w.kind === 'candidate-breaks')!;
  assert.equal(breaks.id, 'candidate-breaks:2.1.300:stream-turn,get-usage');
  assert.match(breaks.detail, /2\.1\.300.*Stream and Usage.*2\.1\.296/s);
  assert.equal(breaks.severity, 'attention');
  const fails = warnings.find((w) => w.kind === 'installed-fails')!;
  assert.equal(fails.severity, 'urgent');
  assert.match(fails.detail, /MCP sign-in/);
  assert.deepEqual(canaryWarnings(buildReport(installed, run('2.1.300', 'candidate', { 'stream-turn': 'pass' }), candidateInfo('2.1.300')), 'x').map((w) => w.kind), ['installed-fails']);
  // A candidate whose run did not finish, or was unavailable, raises nothing.
  const errored = run('2.1.300', 'candidate', {}, { status: 'error', note: 'npm failed' });
  assert.deepEqual(canaryWarnings(buildReport(null, errored, candidateInfo('2.1.300')), 'x'), []);
});

test('workspace warnings: too old, not the pin, updater on', () => {
  const w = workspaceWarnings({ workspaceId: 'docker/api', pinned: '2.1.296', running: '2.1.280', flags: ['differs', 'below-minimum', 'auto-update-on'], featuresBelow: [{ label: 'MCP sets', needs: '2.1.296', enforced: true }, { label: 'Chat', needs: '2.1.296', enforced: false }] }, 'now');
  assert.deepEqual(w.map((x) => x.kind), ['below-minimum', 'pin-differs', 'auto-update-on']);
  assert.match(w[0]!.detail, /too old for MCP sets \(needs 2\.1\.296\) and Chat \(needs 2\.1\.296\)/);
  assert.equal(w[0]!.severity, 'attention');
  assert.equal(workspaceWarnings({ workspaceId: 'a/b', pinned: null, running: '2.1.280', flags: ['below-minimum'], featuresBelow: [{ label: 'Chat', needs: '2.1.296', enforced: false }] }, 'now')[0]!.severity, 'info', 'only warned features: informational');
  assert.deepEqual(workspaceWarnings({ workspaceId: 'a/b', pinned: null, running: null, flags: [], featuresBelow: [] }, 'now'), []);
});

test('accepting failed items: only by name, and only the ones that failed', () => {
  const r = run('2.1.287', 'target', { a: 'pass', b: 'fail', c: 'fail', d: 'skipped' });
  assert.deepEqual(unacceptedFailures(r, undefined), ['b', 'c']);
  assert.deepEqual(unacceptedFailures(r, ['b']), ['c']);
  assert.deepEqual(unacceptedFailures(r, ['b', 'c', 'a', 'zzz']), []);
  assert.deepEqual(unacceptedFailures(run('2.1.296', 'target', { a: 'pass' }), []), []);
});
