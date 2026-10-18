// T-1079 S1: the branch release report's pure part (merged PRs from commit subjects, the upstream's web address, the note and its name) and the
// setting of kind `branch` (parsed fail closed; set by a person only on a remote that follows an upstream).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { branchNoteName, branchSummary, buildBranchReport, mergedPr, migrationPaths, upstreamWeb, type BranchFacts } from './branchReport.js';
import { reportDecision, validBranch } from './releaseReport.js';
import { parseSetting } from './releaseReporter.js';
import { codeOf, harness, remote } from './testkit.js';

const sha = (c: string) => c.repeat(40);
const BY = { actor: 'user:u_owner', userId: 'u_owner' };

test('mergedPr: Gitea and GitHub merge subjects and a squash subject; anything else is none', () => {
  assert.deepEqual(mergedPr("Merge pull request 'Add the course page' (#42) from feat/course into stg"), { number: 42, title: 'Add the course page' });
  assert.deepEqual(mergedPr('Merge pull request #7 from owner/branch'), { number: 7, title: '' });
  assert.deepEqual(mergedPr('Fix the login redirect (#13)'), { number: 13, title: 'Fix the login redirect' });
  for (const s of ['Fix the login redirect', "Merge branch 'stg' into feat", 'Merge pull request (#x) from a into b', 'Refs (#12) in the middle']) assert.equal(mergedPr(s), null, s);
});

test('upstreamWeb: https only, no user, password, query or fragment; .git dropped', () => {
  assert.equal(upstreamWeb('https://git.konfersi.com/platform/konfersi-backend.git'), 'https://git.konfersi.com/platform/konfersi-backend');
  assert.equal(upstreamWeb('https://git.konfersi.com/platform/lab/'), 'https://git.konfersi.com/platform/lab');
  const user = `u${randomBytes(4).toString('hex')}`;
  for (const u of [`https://${user}:pw@git.konfersi.com/p/x.git`, `https://${user}@git.konfersi.com/p/x.git`, 'http://git.konfersi.com/p/x', 'https://git.konfersi.com/p/x?a=1', 'https://git.konfersi.com/p/x#f', 'not a url', null, undefined])
    assert.equal(upstreamWeb(u), null, String(u));
});

test('validBranch: plain branch names only', () => {
  for (const b of ['stg', 'main', 'release/1.2', 'feat_x-1']) assert.equal(validBranch(b), true, b);
  for (const b of ['', '-x', 'a..b', 'a b', 'x.lock', 'x.', '/stg', 'stg/', 'a//b', 'x~1', 'x^', 'a:b', 'refs/heads/*', 'x'.repeat(101)]) assert.equal(validBranch(b), false, b);
});

const facts = (o: Partial<BranchFacts> = {}): BranchFacts => ({
  module: 'konfersi-backend',
  branch: 'stg',
  from: sha('a'),
  to: sha('c'),
  headAt: '2026-10-18T09:30:00+07:00',
  seenAt: '2026-10-18T02:31:00.000Z',
  web: 'https://git.konfersi.com/platform/konfersi-backend',
  commits: {
    list: [
      { sha: sha('c'), subject: "Merge pull request 'Add the course page' (#42) from feat/course into stg", author: 'Satria', at: '2026-10-18T09:30:00+07:00', tickets: ['T-84'] },
      { sha: sha('b'), subject: 'Fix the login redirect', author: 'Sekar', at: '2026-10-18T09:00:00+07:00', tickets: [] },
    ],
    truncated: false,
  },
  tickets: [{ id: 'T-84', summary: 'Konfersi status', type: 'task', status: 'open' }],
  migrations: ['src/migrations/0042_course.sql'],
  ...o,
});

test('the note: module, from..to, merged PRs with links and who merged them, authors, tickets, migrations; its name is the module, the head date and sha', () => {
  const f = facts();
  assert.equal(branchNoteName('Releases', f), `Releases/konfersi-backend/2026-10-18-${sha('c').slice(0, 7)}`);
  const note = buildBranchReport(f);
  assert.match(note, /^---\nmodule: konfersi-backend\nbranch: stg\n/);
  assert.match(note, /- Commits: aaaaaaa\.\.ccccccc/);
  assert.match(note, /- \[#42\]\(https:\/\/git\.konfersi\.com\/platform\/konfersi-backend\/pulls\/42\) Add the course page, merged by Satria/);
  assert.match(note, /2 commits on the first-parent line; authors: Satria, Sekar\./);
  assert.match(note, /- bbbbbbb Fix the login redirect \(Sekar\)/);
  assert.match(note, /- T-84 \(task, now open\): Konfersi status/);
  assert.match(note, /## Migrations\n\n- src\/migrations\/0042_course\.sql/);
  assert.equal(branchSummary(f), 'konfersi-backend stg: 2 commits, 1 pull request');
  // The same head is the same note, whenever it is written.
  assert.equal(buildBranchReport({ ...f, seenAt: f.seenAt }), note);
  assert.equal(branchNoteName('Releases', { ...f, from: null }), branchNoteName('Releases', f));
});

test('the note, twins: no upstream link, no PR, commits unavailable, migrations unavailable, an unknown start', () => {
  const plain = buildBranchReport(facts({ web: null, from: null, migrations: null, commits: { list: [{ sha: sha('c'), subject: 'Merge pull request #9 from o/b', author: null, at: null, tickets: [] }], truncated: true }, tickets: [] }));
  assert.match(plain, /- #9 unavailable, merged by unavailable/);
  assert.match(plain, /- Commits: unavailable\.\.ccccccc/);
  assert.match(plain, /the walk stopped/);
  assert.match(plain, /## Migrations\n\n- unavailable/);
  assert.match(plain, /## Tickets\n\nNone in the commit trailers\./);
  const none = buildBranchReport(facts({ commits: { unavailable: 'commit ccccccc can not be read' }, tickets: [], migrations: [] }));
  assert.match(none, /Commits in the range: unavailable \(commit ccccccc can not be read\)\./);
  assert.match(none, /## Migrations\n\n- none/);
  assert.equal(branchNoteName('Releases', facts({ headAt: null })), `Releases/konfersi-backend/undated-ccccccc`);
});

test('the note never carries a credential-shaped value, whichever field it came in through', () => {
  const value = `ghp_${randomBytes(18).toString('hex')}`; // built at runtime
  const note = buildBranchReport(
    facts({
      commits: { list: [{ sha: sha('c'), subject: `Merge pull request 'leak ${value}' (#1) from a into stg`, author: `x ${value}`, at: null, tickets: [] }], truncated: false },
      tickets: [{ id: 'T-1', summary: value, type: null, status: null }],
      migrations: [`m/${value}`],
    }),
  );
  assert.ok(!note.includes(value), note);
});

test('migrationPaths: a migration(s) folder anywhere', () => {
  assert.deepEqual(migrationPaths(['src/app.ts', 'db/migrations/002.sql', 'Migration/1.sql', 'a/migrationsx/3.sql', 'migrations/001.sql']), ['Migration/1.sql', 'db/migrations/002.sql', 'migrations/001.sql']);
});

test('the setting of kind branch: parsed fail closed; a run never reports through it', () => {
  assert.deepEqual(parseSetting(JSON.stringify({ kind: 'branch', branch: 'stg', vaultId: 'v1', folder: 'Releases' })), { kind: 'branch', branch: 'stg', vaultId: 'v1', folder: 'Releases' });
  for (const bad of [{ kind: 'branch', branch: 'a..b', vaultId: 'v1', folder: 'Releases' }, { kind: 'branch', vaultId: 'v1', folder: 'Releases' }, { kind: 'branch', branch: 'stg', vaultId: '', folder: 'Releases' }, { kind: 'branch', branch: 'stg', vaultId: 'v1', folder: '../x' }, { kind: 'tag', branch: 'stg', pipeline: 'deploy', vaultId: 'v1', folder: 'Releases' }])
    assert.equal(parseSetting(JSON.stringify(bad)), null, JSON.stringify(bad));
  // The pipeline kind still reads as before, with or without `kind`.
  assert.deepEqual(parseSetting(JSON.stringify({ pipeline: 'deploy', vaultId: 'v1', folder: 'Releases' })), { pipeline: 'deploy', vaultId: 'v1', folder: 'Releases' });
  assert.deepEqual(parseSetting(JSON.stringify({ kind: 'pipeline', pipeline: 'deploy', vaultId: 'v1', folder: 'Releases' })), { pipeline: 'deploy', vaultId: 'v1', folder: 'Releases' });
  const run = { status: 'passed', pipeline: 'deploy', inputs: '{}' };
  const state = { jobs: [{ id: 'release', status: 'passed' }] } as never;
  assert.equal(reportDecision(run, state, { kind: 'branch', branch: 'stg', vaultId: 'v1', folder: 'Releases' }).report, false);
  assert.equal(reportDecision(run, state, { pipeline: 'deploy', vaultId: 'v1', folder: 'Releases' }).report, true, 'the twin: the pipeline kind reports');
});

test('setReleaseReport: kind branch needs a plain branch and a remote that follows an upstream; the audit names the branch', async () => {
  const audits: { kind: string; detail?: Record<string, unknown> }[] = [];
  const h = await harness({ lookup: async () => ['93.184.216.34'], audit: (e) => void audits.push(e) });
  try {
    const repo = await remote(h);
    const branch = { kind: 'branch' as const, branch: 'stg', vaultId: 'v1', folder: 'Releases' };
    assert.equal(await codeOf(async () => h.svc.setReleaseReport(repo.id, branch, BY)), 'VALIDATION_FAILED', 'no upstream yet');
    await h.svc.updateRepo(repo.id, { upstream: { url: 'https://upstream.test/x.git' } }, BY);
    assert.equal(await codeOf(async () => h.svc.setReleaseReport(repo.id, { ...branch, branch: 'a..b' }, BY)), 'VALIDATION_FAILED');
    assert.equal(await codeOf(async () => h.svc.setReleaseReport(repo.id, { ...branch, kind: 'tag' } as never, BY)), 'VALIDATION_FAILED');
    assert.deepEqual(h.svc.setReleaseReport(repo.id, { ...branch, branch: ' stg ', folder: '/Releases/' }, BY), branch);
    assert.deepEqual(h.svc.releaseReportSetting(repo.id), branch);
    const a = audits.filter((x) => x.kind === 'ci.release_report_setting').at(-1)!;
    assert.deepEqual(a.detail, { repo: 'app', vault: 'v1', folder: 'Releases', pipeline: null, branch: 'stg' });
    // The twin: the pipeline kind is unchanged (no upstream needed, no branch in the audit).
    assert.deepEqual(h.svc.setReleaseReport(repo.id, { pipeline: 'deploy', vaultId: 'v1', folder: 'Releases' }, BY), { pipeline: 'deploy', vaultId: 'v1', folder: 'Releases' });
    assert.deepEqual(audits.filter((x) => x.kind === 'ci.release_report_setting').at(-1)!.detail, { repo: 'app', vault: 'v1', folder: 'Releases', pipeline: 'deploy' });
  } finally {
    h.done();
  }
});
