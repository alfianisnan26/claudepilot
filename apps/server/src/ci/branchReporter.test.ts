// T-1079 S2: the branch release report is written when the upstream sync moves the setting's branch. Unit rows on fakes (what qualifies, the
// facts, idempotence, a failure), then the service on real temporary git repositories (the upstream is a bare repository reached by an https
// URL the remote's own git configuration rewrites to it, as upstream.test.ts does), so nothing leaves the machine.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BranchReporter, type BranchMove } from './branchReporter.js';
import type { CiReply } from './host.js';
import { NULL_SHA } from './plan.js';
import type { ReleaseNoteSink, ReporterDeps } from './releaseReporter.js';
import type { Home } from './runner/testkit.js';
import { harness, remote } from './testkit.js';

const sha = (c: string) => c.repeat(40);
const BY = { actor: 'user:u_owner', userId: 'u_owner' };
const NOW = new Date('2026-10-18T02:31:00.000Z');

/** A vault in memory: what a note path holds, and every put. */
function memorySink() {
  const notes = new Map<string, string>();
  const puts: string[] = [];
  const sink: ReleaseNoteSink = {
    exists: () => true,
    read: (v, p) => notes.get(`${v}:${p}`) ?? null,
    put: (v, p, c) => {
      const k = `${v}:${p}`;
      const before = notes.get(k);
      puts.push(k);
      notes.set(k, c);
      return { created: before === undefined, unchanged: before === c };
    },
  };
  return { sink, notes, puts };
}

type Audit = { kind: string; detail?: Record<string, unknown> };

/** A remote row, the setting on it, and `cp` answering from a table of snapshots (a -> b -> c, c the new head). */
function fakes(o: { setting?: unknown; upstream?: string | null; snapshots?: Record<string, CiReply>; changes?: CiReply; throwPut?: boolean } = {}) {
  const row = {
    id: 'r1',
    name: 'konfersi-backend',
    workspace_id: 'ws1',
    removed_at: null,
    upstream_url: o.upstream === undefined ? 'https://git.konfersi.com/platform/konfersi-backend.git' : o.upstream,
    release_report: JSON.stringify(o.setting ?? { kind: 'branch', branch: 'stg', vaultId: 'v1', folder: 'Releases' }),
  };
  const snapshots: Record<string, CiReply> = o.snapshots ?? {
    [sha('c')]: { ok: true, parents: [sha('b'), sha('9')], author: { name: 'Satria', email: 's@example.test' }, at: '2026-10-18T09:30:00+07:00', subject: "Merge pull request 'Add the course page' (#42) from feat/course into stg", message: "Merge pull request 'Add the course page' (#42) from feat/course into stg\n\nTicket: T-84" },
    [sha('b')]: { ok: true, parents: [sha('a')], author: { name: 'Sekar', email: 'k@example.test' }, at: '2026-10-18T09:00:00+07:00', subject: 'Fix the login redirect', message: 'Fix the login redirect' },
  };
  const calls: string[][] = [];
  const audits: Audit[] = [];
  const { sink, notes, puts } = memorySink();
  const deps: ReporterDeps = {
    cs: { repo: (id: string) => (id === row.id ? row : undefined) } as never,
    cp: async (_ws, args) => {
      calls.push(args);
      if (args[0] === 'snapshot') return snapshots[args[2]!] ?? { ok: false, error: 'no_commit' };
      if (args[0] === 'changes') return o.changes ?? { ok: true, paths: ['src/app.ts', 'src/migrations/0042_course.sql'], truncated: false, ancestor: true };
      return { ok: false };
    },
    tickets: { info: (id: string) => (id === 'T-84' ? { summary: 'Konfersi status', type: 'task', status: 'open' } : null) } as never,
    sink: o.throwPut
      ? {
          ...sink,
          put: () => {
            throw new Error(`vault down ${'x'.repeat(3)}`);
          },
        }
      : sink,
    audit: (e) => void audits.push(e),
  };
  return { reporter: new BranchReporter(deps, () => NOW), row, calls, audits, notes, puts };
}

const MOVE: BranchMove = { branch: 'stg', old: sha('a'), new: sha('c') };
const NOTE = `v1:Releases/konfersi-backend/2026-10-18-${sha('c').slice(0, 7)}.md`;

test('a move of the setting branch writes one note and one README line, from the remote own setting', async () => {
  const f = fakes();
  const r = await f.reporter.moved('r1', [{ branch: 'main', old: sha('1'), new: sha('2') }, MOVE], false);
  assert.deepEqual(r, { path: NOTE.slice(3), created: true, unchanged: false });
  const note = f.notes.get(NOTE)!;
  assert.match(note, /- \[#42\]\(https:\/\/git\.konfersi\.com\/platform\/konfersi-backend\/pulls\/42\) Add the course page, merged by Satria/);
  assert.match(note, /- Commits: aaaaaaa\.\.ccccccc/);
  assert.match(note, /2 commits on the first-parent line; authors: Satria, Sekar\./);
  assert.match(note, /- T-84 \(task, now open\): Konfersi status/);
  assert.match(note, /## Migrations\n\n- src\/migrations\/0042_course\.sql/);
  assert.match(f.notes.get('v1:Releases/README.md')!, /^- \[\[konfersi-backend\/2026-10-18-ccccccc\]\] · 2026-10-18T09:30:00\+07:00 · konfersi-backend stg: 2 commits, 1 pull request$/m);
  // Read only: two snapshots (the head once), one changes; nothing else reaches the workspace.
  assert.deepEqual(f.calls.map((c) => c[0]), ['snapshot', 'snapshot', 'changes']);
  assert.deepEqual(f.calls.at(-1), ['changes', 'konfersi-backend', sha('a'), sha('c')]);
  assert.deepEqual(f.audits.map((a) => [a.kind, a.detail?.outcome, a.detail?.branch, a.detail?.path]), [['ci.release_report', 'written', 'stg', NOTE.slice(3)]]);
});

test('idempotent: the same head again replaces the same note (unchanged), and the README keeps one line', async () => {
  const f = fakes();
  await f.reporter.moved('r1', [MOVE], false);
  const r = await f.reporter.moved('r1', [MOVE], false);
  assert.deepEqual(r, { path: NOTE.slice(3), created: false, unchanged: true });
  assert.equal([...f.notes.keys()].length, 2);
  assert.equal(f.notes.get('v1:Releases/README.md')!.split('\n').filter((l) => l.startsWith('- [[')).length, 1);
});

test('nothing is written: the first sight (a baseline, a created branch), another branch, no setting, a pipeline setting; the twin writes', async () => {
  const none = async (o: Parameters<typeof fakes>[0], moves: BranchMove[], baseline = false) => {
    const f = fakes(o);
    assert.equal(await f.reporter.moved('r1', moves, baseline), null);
    assert.equal(f.puts.length, 0);
    assert.equal(f.calls.length, 0, 'not even a read');
  };
  await none({}, [MOVE], true);
  await none({}, [{ ...MOVE, old: NULL_SHA }]);
  await none({}, [{ ...MOVE, branch: 'main' }]);
  await none({ setting: { pipeline: 'deploy', vaultId: 'v1', folder: 'Releases' } }, [MOVE]);
  await none({ setting: { kind: 'branch', branch: 'stg', vaultId: 'v1', folder: '../x' } }, [MOVE]);
  await none({}, [{ ...MOVE, new: 'not a sha' }]);
  const twin = fakes();
  assert.notEqual(await twin.reporter.moved('r1', [MOVE], false), null);
  assert.equal(await twin.reporter.moved('nope', [MOVE], false), null, 'no such remote');
});

test('the vault and folder come from the setting only: another setting writes elsewhere', async () => {
  const f = fakes({ setting: { kind: 'branch', branch: 'stg', vaultId: 'v2', folder: 'Konfersi/Releases' } });
  await f.reporter.moved('r1', [MOVE], false);
  assert.deepEqual([...f.notes.keys()].sort(), [`v2:Konfersi/Releases/README.md`, `v2:Konfersi/Releases/konfersi-backend/2026-10-18-ccccccc.md`]);
});

test('facts with no source read unavailable: a commit that can not be read, a range git does not vouch for, an upstream with no web address', async () => {
  const f = fakes({ snapshots: {}, changes: { ok: true, paths: ['m/migrations/1.sql'], truncated: true, ancestor: true }, upstream: 'http://plain.test/x' });
  await f.reporter.moved('r1', [MOVE], false);
  const note = f.notes.get(NOTE.replace('2026-10-18', 'undated'))!;
  assert.match(note, /Commits in the range: unavailable \(commit ccccccc can not be read\)\./);
  assert.match(note, /## Migrations\n\n- unavailable/);
  assert.match(note, /- Upstream: unavailable/);
  // A head not on the first-parent line of the new one.
  const g = fakes({ snapshots: { [sha('c')]: { ok: true, parents: [], author: { name: 'S', email: '' }, at: '2026-10-18T09:30:00+07:00', subject: 's', message: 's' } } });
  await g.reporter.moved('r1', [MOVE], false);
  assert.match(g.notes.get(NOTE)!, /unavailable \(the earlier head is not on the first-parent line of the new one\)/);
});

test('a failed write is audited with a fixed code, never the error text, and never throws into the sync', async () => {
  const f = fakes({ throwPut: true });
  assert.equal(await f.reporter.moved('r1', [MOVE], false), null);
  assert.deepEqual(f.audits.map((a) => [a.detail?.outcome, a.detail?.code]), [['failed', 'write_failed']]);
  assert.ok(!JSON.stringify(f.audits).includes('vault down'));
});

/* ---------- The service, on real repositories ---------- */

const URL_ = 'https://upstream.test/x.git';
const pilotDir = (home: Home, name = 'app') => join(home.home, '.claudepilot', 'git', `${name}.git`);

function upstream(home: Home, from: string) {
  const bare = join(home.home, 'up', 'x.git');
  mkdirSync(join(home.home, 'up'), { recursive: true });
  home.git(['clone', '--bare', '--quiet', from, bare]);
  appendFileSync(join(pilotDir(home), 'config'), `[url "${bare}"]\n\tinsteadOf = ${URL_}\n[protocol "file"]\n\tallow = always\n`);
  const work = join(home.home, 'upwork');
  home.git(['clone', '--quiet', bare, work], home.home);
  return { bare, work };
}

test('the service: the first sync writes nothing; a merge into the branch writes its note; no move, no new write; no secret value in the vault', async () => {
  const audits: Audit[] = [];
  const h = await harness({ lookup: async () => ['93.184.216.34'], audit: (e) => void audits.push(e), secrets: (_ws, name) => (name === 'GIT_READ' ? { kind: 'secret', asFile: true, asVariable: false } : null) });
  const { sink, notes, puts } = memorySink();
  h.svc.releaseNotes = sink;
  try {
    const repo = await remote(h);
    const up = upstream(h.home, h.src);
    const value = `fixture-${randomBytes(18).toString('hex')}`; // built at runtime, never a literal
    mkdirSync(join(h.home.home, 'secrets', 'files'), { recursive: true });
    writeFileSync(join(h.home.home, 'secrets', 'files', 'GIT_READ'), value);
    await h.svc.updateRepo(repo.id, { upstream: { url: URL_, secret: 'GIT_READ' } }, BY);
    h.svc.setReleaseReport(repo.id, { kind: 'branch', branch: 'main', vaultId: 'v1', folder: 'Releases' }, BY);

    // The first sync is the baseline: nothing is written.
    await h.svc.syncUpstream(repo.id, BY);
    await h.svc.syncsSettled();
    assert.equal(puts.length, 0, 'nothing on the first sight');

    // A merge into main upstream: a feature branch merged with Gitea's subject, a migration and a ticket trailer.
    h.home.git(['checkout', '--quiet', '-b', 'feat'], up.work);
    h.home.commit(up.work, { 'db/migrations/0042_course.sql': 'create table c (id int);\n' }, 'Add the course table');
    h.home.git(['checkout', '--quiet', 'main'], up.work);
    // The merge commit is on the first-parent line, so its trailer is the one read (the feature commit is not walked).
    h.home.git(['merge', '--quiet', '--no-ff', 'feat', '-m', "Merge pull request 'Add the course page' (#42) from feat into main", '-m', 'Ticket: T-84'], up.work);
    h.home.git(['push', '--quiet', 'origin', 'main', 'feat'], up.work);
    const head = h.home.git(['rev-parse', 'HEAD'], up.work);

    assert.ok((await h.svc.syncUpstream(repo.id, BY)).moved.some((m) => m.branch === 'main' && m.new === head));
    await h.svc.syncsSettled();
    const names = [...notes.keys()].sort();
    assert.equal(names.length, 2, names.join(', '));
    const noteKey = names.find((n) => n.endsWith(`-${head.slice(0, 7)}.md`))!;
    assert.match(noteKey, new RegExp(`^v1:Releases/app/\\d{4}-\\d{2}-\\d{2}-${head.slice(0, 7)}\\.md$`));
    const note = notes.get(noteKey)!;
    assert.match(note, /- \[#42\]\(https:\/\/upstream\.test\/x\/pulls\/42\) Add the course page, merged by /);
    assert.match(note, /- db\/migrations\/0042_course\.sql/);
    assert.match(note, /- T-84 /);
    const written = audits.filter((a) => a.kind === 'ci.release_report');
    assert.deepEqual(written.map((a) => [a.detail?.outcome, a.detail?.branch, a.detail?.to]), [['written', 'main', head]]);

    // Nothing moves: nothing is written again.
    const before = puts.length;
    await h.svc.syncUpstream(repo.id, BY);
    await h.svc.syncsSettled();
    assert.equal(puts.length, before);
    assert.ok(![...notes.values(), JSON.stringify(audits)].some((t) => t.includes(value)), 'the secret value is in no note and no audit row');
  } finally {
    h.done();
  }
});
