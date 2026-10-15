// T-591: the pure half of the release report: when to report, what the log and manifest say, the note and the README list.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CiRunStateFile } from '@portal/contracts';
import {
  buildReport,
  gateSummary,
  manifestTags,
  migrationsAdded,
  notePath,
  parseReleaseLog,
  reportDecision,
  updateReadme,
  validFolder,
  type ReportFacts,
} from './releaseReport.js';

const setting = { pipeline: 'deploy', vaultId: 'v1', folder: 'Releases' };
const jobs = (o: Record<string, string>): CiRunStateFile => ({ jobs: Object.entries(o).map(([id, status]) => ({ id, name: id, status, durationMs: 1000, steps: [] })) }) as unknown as CiRunStateFile;
const run = (over: Partial<{ status: string; pipeline: string; inputs: string }> = {}) => ({ status: 'passed', pipeline: 'deploy', inputs: JSON.stringify({ dry_run: 'false', deploy: 'true' }), ...over });
const passedState = jobs({ gate: 'passed', build: 'passed', release: 'passed', verify: 'passed' });

test('decision: a passed release reports', () => {
  assert.deepEqual(reportDecision(run(), passedState, setting), { report: true, rolledBack: 'no' });
});

test('decision: no setting, another pipeline, a running run: no report', () => {
  assert.equal(reportDecision(run(), passedState, null).report, false);
  assert.equal(reportDecision(run({ pipeline: 'ci' }), passedState, setting).report, false);
  assert.equal(reportDecision(run({ status: 'running' }), passedState, setting).report, false);
});

test('decision: dry_run and deploy=false never report, as booleans or strings', () => {
  for (const inputs of [{ dry_run: true }, { dry_run: 'true' }, { deploy: false }, { deploy: 'false' }]) {
    assert.equal(reportDecision(run({ inputs: JSON.stringify(inputs) }), passedState, setting).report, false, JSON.stringify(inputs));
  }
  assert.equal(reportDecision(run({ inputs: 'not json' }), passedState, setting).report, false);
});

test('decision: a release that did not pass or never ran does not report', () => {
  for (const s of [jobs({ gate: 'failed', build: 'skipped', release: 'skipped' }), jobs({ gate: 'passed', build: 'passed', release: 'failed' }), jobs({ gate: 'passed', build: 'passed' })]) {
    assert.equal(reportDecision(run({ status: 'failed' }), s, setting).report, false);
  }
  assert.equal(reportDecision(run(), null, setting).report, false);
});

test('decision: a rollback after a passed release still reports, and says so', () => {
  assert.deepEqual(reportDecision(run({ status: 'failed' }), jobs({ release: 'passed', verify: 'failed', rollback: 'passed' }), setting), { report: true, rolledBack: 'yes' });
  assert.deepEqual(reportDecision(run({ status: 'failed' }), jobs({ release: 'passed', verify: 'failed', rollback: 'failed' }), setting), { report: true, rolledBack: 'failed' });
  assert.deepEqual(reportDecision(run({ status: 'failed' }), jobs({ release: 'passed', verify: 'failed', rollback: 'skipped' }), setting), { report: true, rolledBack: 'no' });
});

test('the release log line gives the tags; no line means nothing was released', () => {
  const log = ['building', 'release: 0123abcdef0123 (portal 2026.10.15-3, workspace 2026.10.14-9) to main', 'done'].join('\n');
  assert.deepEqual(parseReleaseLog(log), { commit: '0123abc', portal: '2026.10.15-3', workspace: '2026.10.14-9' });
  assert.deepEqual(parseReleaseLog('release: 0123abc (portal t1) to main'), { commit: '0123abc', portal: 't1', workspace: null });
  assert.equal(parseReleaseLog('nothing to release\n'), null);
  assert.equal(parseReleaseLog(''), null);
});

test('manifest tags: exactly one of each, else unavailable', () => {
  const m = ['image: registry.local:5000/claudepilot/portal:p-1', 'value: registry.local:5000/claudepilot/workspace:w-2'].join('\n');
  assert.deepEqual(manifestTags(m), { portal: 'p-1', workspace: 'w-2' });
  assert.deepEqual(manifestTags(`${m}\nimage: registry.local:5000/claudepilot/portal:p-9`), { portal: null, workspace: 'w-2' });
  assert.deepEqual(manifestTags(null), { portal: null, workspace: null });
});

test('gate summary keeps only gate and SUMMARY lines', () => {
  assert.equal(gateSummary(null), null);
  assert.equal(gateSummary('noise\nmore'), null);
  assert.deepEqual(gateSummary('x\ngate: typecheck ok\nSUMMARY 2400 pass 0 fail\ny'), ['gate: typecheck ok', 'SUMMARY 2400 pass 0 fail']);
});

test('migrations added: the versions the head has and the base lacks', () => {
  const file = (...v: number[]) => v.map((n) => `  {\n    version: ${n},\n    sql: '',\n  },`).join('\n');
  assert.deepEqual(migrationsAdded(file(1, 2), file(1, 2, 5, 4)), [4, 5]);
  assert.deepEqual(migrationsAdded(file(1), file(1)), []);
  assert.equal(migrationsAdded(null, file(1)), null);
  assert.equal(migrationsAdded(file(1), 'no versions here'), null);
});

const facts = (over: Partial<ReportFacts> = {}): ReportFacts => ({
  repo: 'claudepilot',
  pipeline: 'deploy',
  runId: 'run1',
  runNumber: 41,
  runLink: '/admin/ci/runs/run1',
  sha: 'abcdef0123456789abcdef0123456789abcdef01',
  ref: 'integration',
  status: 'passed',
  startedAt: '2026-10-15T10:00:00.000Z',
  finishedAt: '2026-10-15T10:20:00.000Z',
  durationMs: 1_200_000,
  actor: 'ui',
  tags: { portal: 'p-2', workspace: 'w-2', prevPortal: 'p-1', prevWorkspace: 'w-1' },
  releaseCommit: '1234567',
  previous: { sha: '1111111111111111111111111111111111111111', runNumber: 40 },
  commits: {
    list: [
      { sha: 'aaaaaaa1111111', subject: 'Add the thing', tickets: ['T-10'] },
      { sha: 'bbbbbbb2222222', subject: 'Fix the other', tickets: ['T-10', 'T-11'] },
      { sha: 'ccccccc3333333', subject: 'No ticket here', tickets: [] },
    ],
    truncated: false,
  },
  tickets: [
    { id: 'T-10', summary: 'The thing', type: 'feature', status: 'closed' },
    { id: 'T-11', summary: null, type: null, status: null },
  ],
  migrations: [784],
  contractsChanged: true,
  jobs: [{ id: 'release', name: 'release', status: 'passed', durationMs: 5000 }],
  gate: ['gate: ok'],
  approval: { approval: 'approved', by: 'user:me', at: '2026-10-15T10:10:00.000Z' },
  rolledBack: 'no',
  ...over,
});

test('the note has its sections, tickets by type and loose commits', () => {
  const md = buildReport(facts());
  for (const h of ['## Release', '## Tickets', '## Changes', '## Pipeline']) assert.ok(md.includes(h), h);
  assert.match(md, /Portal image: p-2, before: p-1/);
  assert.match(md, /3 commits in the range, 2 tickets, 1 without a ticket/);
  assert.match(md, /By type: feature 1, unavailable 1/);
  assert.match(md, /- T-10 \(feature, now closed\): The thing, 2 commits/);
  assert.match(md, /- T-11 \(unavailable, now unavailable\): unavailable, 1 commit/);
  assert.match(md, /- ccccccc No ticket here/);
  assert.match(md, /Migrations added: 784/);
  assert.match(md, /result: released and verified/);
});

test('unavailable facts read "unavailable", never a guess', () => {
  const md = buildReport(
    facts({
      tags: { portal: null, workspace: null, prevPortal: null, prevWorkspace: null },
      releaseCommit: null,
      previous: null,
      commits: { unavailable: 'no earlier release is recorded' },
      tickets: [],
      migrations: null,
      contractsChanged: null,
      jobs: [],
      gate: null,
      approval: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      actor: null,
    }),
  );
  assert.match(md, /Commits in the range: unavailable \(no earlier release is recorded\)/);
  assert.match(md, /Migrations added: unavailable/);
  assert.match(md, /Contracts changed: unavailable/);
  assert.match(md, /Release approval: unavailable/);
  assert.match(md, /Jobs: unavailable/);
  assert.match(md, /Gate:\n\n- unavailable/);
  assert.match(md, /took unavailable/);
  assert.match(md, /Portal image: not released by this run, before: unavailable/);
});

test('a rolled-back release says so', () => {
  const md = buildReport(facts({ status: 'failed', rolledBack: 'yes' }));
  assert.match(md, /result: rolled back/);
  assert.match(md, /Rollback: ran, the previous tags are back on main/);
  assert.match(buildReport(facts({ status: 'failed', rolledBack: 'failed' })), /result: rollback ran and failed/);
});

test('credential-shaped text in a commit subject or a ticket summary is redacted (fixture built at runtime)', () => {
  const secret = ['gh', 'p_'].join('') + 'A'.repeat(36);
  const md = buildReport(facts({ commits: { list: [{ sha: 'ddddddd4444444', subject: `leak ${secret}`, tickets: [] }], truncated: false }, tickets: [] }));
  assert.ok(!md.includes(secret));
  const md2 = buildReport(facts({ tickets: [{ id: 'T-10', summary: `s ${secret}`, type: 'bug', status: 'open' }] }));
  assert.ok(!md2.includes(secret));
});

test('a truncated walk is said', () => {
  assert.match(buildReport(facts({ commits: { list: [], truncated: true } })), /the walk stopped at 200/);
});

test('the note path is a function of the run: same facts, same path', () => {
  assert.equal(notePath('Releases', facts()), 'Releases/2026-10-15 portal p-2 workspace w-2.md');
  assert.equal(notePath('Releases', facts()), notePath('Releases', facts()));
  assert.equal(notePath('Releases', facts({ tags: { portal: null, workspace: null, prevPortal: null, prevWorkspace: null }, finishedAt: null })), 'Releases/undated run 41.md');
  assert.ok(!notePath('Releases', facts({ tags: { portal: 'a/b', workspace: null, prevPortal: null, prevWorkspace: null } })).slice('Releases/'.length).includes('/'));
});

test('folder: plain relative segments only', () => {
  for (const ok of ['Releases', 'Ops/Releases']) assert.equal(validFolder(ok), true, ok);
  for (const bad of ['', '/Releases', 'Releases/', '../x', 'a/../b', 'a//b', 'a\\b', '.hidden', 'a/b/c/d/e', 'x.']) assert.equal(validFolder(bad), false, bad);
});

test('README: newest first, one line per note, a second report replaces its line', () => {
  let md = updateReadme(null, { name: 'old', at: '2026-10-01T00:00:00.000Z', summary: 'run #1' });
  md = updateReadme(md, { name: 'new', at: '2026-10-15T00:00:00.000Z', summary: 'run #2' });
  md = updateReadme(md, { name: 'mid', at: '2026-10-08T00:00:00.000Z', summary: 'run #3' });
  const lines = md.split('\n').filter((l) => l.startsWith('- [['));
  assert.deepEqual(lines.map((l) => /\[\[(.*?)\]\]/.exec(l)![1]), ['new', 'mid', 'old']);
  const again = updateReadme(md, { name: 'mid', at: '2026-10-08T00:00:00.000Z', summary: 'run #3, rolled back' });
  const after = again.split('\n').filter((l) => l.startsWith('- [['));
  assert.equal(after.length, 3);
  assert.match(after[1]!, /rolled back/);
  assert.equal(updateReadme(again, { name: 'mid', at: '2026-10-08T00:00:00.000Z', summary: 'run #3, rolled back' }), again);
});
