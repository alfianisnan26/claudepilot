// T-591: the reporter with a fake store, a fake cp-ci and a fake vault: what is written, when, and that a rerun replaces instead of adding.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CI_API } from '@portal/contracts';
import { CI_POLICIES } from './authz.js';
import type { CiReply } from './host.js';
import { parseSetting, ReleaseReporter, ReportRefused, type ReleaseNoteSink } from './releaseReporter.js';
import { MANIFEST_FILE } from './releaseReport.js';
import type { CiStore, DeploymentRow, RepoRow, RunRow } from './store.js';
import type { CiTicketsPort } from './tickets.js';

const SETTING = { pipeline: 'deploy', vaultId: 'vault1', folder: 'Releases' };
const sha = (c: string) => c.repeat(40);
const migs = (...v: number[]) => v.map((n) => `  {\n    version: ${n},\n    sql: '',\n  },`).join('\n');
const MANIFEST = (p: string, w: string) => `image: reg:5000/claudepilot/portal:${p}\nvalue: reg:5000/claudepilot/workspace:${w}`;

interface Setup {
  state?: Record<string, string>;
  inputs?: Record<string, unknown>;
  setting?: unknown;
  releaseLog?: string | null;
  subject?: string;
  status?: RunRow['status'];
}

function make(o: Setup = {}) {
  const state = { jobs: Object.entries(o.state ?? { gate: 'passed', build: 'passed', release: 'passed', verify: 'passed' }).map(([id, status]) => ({ id, name: id, status, durationMs: 1000, steps: [{ idx: 0 }] })) };
  const run = {
    id: 'run41',
    number: 41,
    workspace_id: 'ws',
    repo_id: 'repo1',
    repo: 'claudepilot',
    pipeline: 'deploy',
    ref: 'refs/heads/integration',
    branch: 'integration',
    tag: null,
    sha: sha('c'),
    status: o.status ?? 'passed',
    actor: 'ui',
    actor_label: null,
    inputs: JSON.stringify(o.inputs ?? { dry_run: 'false', deploy: 'true' }),
    state: JSON.stringify(state),
    started_at: '2026-10-15T10:00:00.000Z',
    finished_at: '2026-10-15T10:20:00.000Z',
    duration_ms: 1_200_000,
  } as unknown as RunRow;
  const repo = { id: 'repo1', release_report: o.setting === undefined ? JSON.stringify(SETTING) : o.setting } as unknown as RepoRow;
  const logs: Record<string, string> = {
    release: o.releaseLog === undefined ? `release: ${sha('d')} (portal p-2, workspace w-2) to main` : (o.releaseLog ?? ''),
    gate: 'gate: typecheck ok\nSUMMARY 10 pass 0 fail',
  };
  const cs = {
    run: (id: string) => (id === run.id ? run : undefined),
    repo: (id: string) => (id === repo.id ? repo : undefined),
    log: (_r: string, job: string) => (logs[job] ? { text: logs[job] } : undefined),
    deploymentsOfRun: () => [{ job: 'release', environment: 'production', approval: 'approved', decided_by: 'user:me', decided_at: '2026-10-15T10:10:00.000Z' }] as unknown as DeploymentRow[],
    lastReleased: () => ({ sha: sha('a'), run_number: 40 }) as unknown as DeploymentRow,
  } as unknown as CiStore;
  const commits: Record<string, { message: string; parents: string[] }> = {
    [sha('c')]: { message: `${o.subject ?? 'Add the thing'}\n\nTicket: T-10\nPilot-Agent: x`, parents: [sha('b')] },
    [sha('b')]: { message: 'No ticket here', parents: [sha('a')] },
  };
  const calls: string[][] = [];
  const cp = async (_ws: string, args: string[]): Promise<CiReply> => {
    calls.push(args);
    if (args[0] === 'snapshot') {
      const c = commits[args[2]!];
      return c ? { ok: true, message: c.message, subject: c.message.split('\n')[0], parents: c.parents } : { ok: false };
    }
    const path = args[5];
    if (path === MANIFEST_FILE) return { ok: true, ancestor: true, truncated: false, paths: ['packages/contracts/src/ci.ts'], show: { base: MANIFEST('p-1', 'w-1'), head: MANIFEST('p-1', 'w-1'), tooLarge: false } };
    return { ok: true, ancestor: true, truncated: false, paths: ['packages/contracts/src/ci.ts'], show: { base: migs(1, 2), head: migs(1, 2, 3), tooLarge: false } };
  };
  const vault = new Map<string, string>();
  const puts: string[] = [];
  const sink: ReleaseNoteSink = {
    read: (v, p) => vault.get(`${v}:${p}`) ?? null,
    put: (v, p, content) => {
      const k = `${v}:${p}`;
      const had = vault.has(k);
      const unchanged = vault.get(k) === content;
      vault.set(k, content);
      puts.push(k);
      return { created: !had, unchanged };
    },
  };
  const audits: { kind: string; actor: string; detail?: Record<string, unknown> }[] = [];
  const tickets = { info: (id: string) => (id === 'T-10' ? { summary: 'The thing', type: 'feature', status: 'closed' } : null) } as unknown as CiTicketsPort;
  const reporter = new ReleaseReporter({ cs, cp, tickets, sink, audit: (e) => void audits.push(e) });
  const deps = { cs, cp, tickets, audit: (e: (typeof audits)[number]) => void audits.push(e) };
  return { reporter, vault, puts, audits, calls, deps };
}

const noteKeys = (vault: Map<string, string>) => [...vault.keys()].filter((k) => !k.endsWith('README.md'));

test('a passed release writes the note and the README list', async () => {
  const t = make();
  const r = await t.reporter.report('run41');
  assert.ok(r);
  assert.equal(r.created, true);
  assert.equal(r.path, 'Releases/2026-10-15 portal p-2 workspace w-2.md');
  const note = t.vault.get(`vault1:${r.path}`)!;
  assert.match(note, /Portal image: p-2, before: p-1/);
  assert.match(note, /- T-10 \(feature, now closed\): The thing, 1 commit/);
  assert.match(note, /Commits without a ticket:\n\n- bbbbbbb No ticket here|2 commits in the range/);
  assert.match(note, /Migrations added: 3/);
  assert.match(note, /Contracts changed: yes/);
  assert.match(note, /Release approval: approved by user:me/);
  assert.match(note, /gate: typecheck ok/);
  const readme = t.vault.get('vault1:Releases/README.md')!;
  assert.match(readme, /- \[\[2026-10-15 portal p-2 workspace w-2\]\] · 2026-10-15T10:20:00.000Z · run #41, 2 commits, ok/);
  const a = t.audits.find((e) => e.kind === 'ci.release_report')!;
  assert.equal(a.actor, 'portal');
  assert.equal(a.detail?.outcome, 'written');
  assert.ok(!JSON.stringify(a).includes('Portal image'), 'the note text is not copied into the audit row');
});

test('the same run twice: one note, one README line (idempotent)', async () => {
  const t = make();
  await t.reporter.report('run41');
  const second = await t.reporter.report('run41');
  assert.equal(noteKeys(t.vault).length, 1);
  assert.equal(second?.created, false);
  assert.equal(second?.unchanged, true);
  const lines = t.vault.get('vault1:Releases/README.md')!.split('\n').filter((l) => l.startsWith('- [['));
  assert.equal(lines.length, 1);
});

test('no report for a dry run, deploy=false, a release that did not pass, or one that pushed nothing', async () => {
  for (const o of [
    { inputs: { dry_run: 'true', deploy: 'true' } },
    { inputs: { dry_run: 'false', deploy: 'false' } },
    { state: { gate: 'passed', build: 'passed', release: 'skipped' }, status: 'failed' as const },
    { state: { gate: 'failed', build: 'skipped', release: 'skipped' }, status: 'failed' as const },
    { releaseLog: 'nothing to release' },
  ]) {
    const t = make(o);
    assert.equal(await t.reporter.report('run41'), null, JSON.stringify(o));
    assert.equal(t.vault.size, 0, JSON.stringify(o));
    await assert.rejects(() => t.reporter.report('run41', true), ReportRefused, JSON.stringify(o));
  }
});

test('off when the remote has no setting, or a setting that is not valid', async () => {
  for (const setting of [null, 'not json', JSON.stringify({ pipeline: 'deploy', vaultId: 'v', folder: '../x' }), JSON.stringify({ pipeline: 'deploy' })]) {
    const t = make({ setting });
    assert.equal(await t.reporter.report('run41'), null);
    assert.equal(t.vault.size, 0);
  }
  assert.equal(parseSetting(JSON.stringify(SETTING))?.folder, 'Releases');
  assert.equal(parseSetting(null), null);
});

test('a rollback after the release: the report says rolled back', async () => {
  const t = make({ state: { gate: 'passed', build: 'passed', release: 'passed', verify: 'failed', rollback: 'passed' }, status: 'failed' });
  const r = await t.reporter.report('run41');
  assert.ok(r);
  assert.match(t.vault.get(`vault1:${r.path}`)!, /result: rolled back/);
  assert.match(t.vault.get('vault1:Releases/README.md')!, /rolled back/);
});

test('the vault and folder are the remote\'s own setting: the report writes nowhere else', async () => {
  const t = make();
  await t.reporter.report('run41');
  assert.ok(t.puts.every((k) => k.startsWith('vault1:Releases/')), t.puts.join());
});

test('a credential-shaped string in a commit message never reaches the vault (fixture built at runtime)', async () => {
  const secret = ['gh', 'p_'].join('') + 'B'.repeat(36);
  const t = make({ subject: `Fix leak ${secret}` });
  await t.reporter.report('run41');
  for (const v of t.vault.values()) assert.ok(!v.includes(secret));
});

test('the repository is read with read-only commands only', async () => {
  const t = make();
  await t.reporter.report('run41');
  assert.ok(t.calls.length > 0);
  assert.ok(t.calls.every((c) => c[0] === 'changes' || c[0] === 'snapshot'), JSON.stringify(t.calls.map((c) => c[0])));
});

test('a failed vault write leaves a fixed-code audit row and the error', async () => {
  const t = make();
  const secret = ['gh', 'p_'].join('') + 'C'.repeat(36);
  const sink: ReleaseNoteSink = {
    read: () => null,
    put: () => {
      throw new Error(`vault said ${secret}`);
    },
  };
  const reporter = new ReleaseReporter({ ...t.deps, sink });
  await assert.rejects(() => reporter.report('run41'), /vault said/);
  const row = t.audits.find((e) => e.kind === 'ci.release_report')!;
  assert.equal(row.detail?.outcome, 'failed');
  assert.equal(row.detail?.code, 'write_failed');
  assert.ok(!JSON.stringify(row).includes(secret), 'the vault error text is not copied into the audit row');
  // The service's hook swallows this error (it logs it): the poll never breaks. A retry after the vault heals writes the note.
  const healed = new ReleaseReporter({ ...t.deps, sink: { read: () => null, put: () => ({ created: true, unchanged: false }) } });
  assert.equal((await healed.report('run41'))?.created, true);
});

test('routes: the setting and the backfill are declared as a person with manage, and take no vault argument', () => {
  const put = CI_POLICIES['PUT /api/ci/repos/:id/release-report'];
  const post = CI_POLICIES['POST /api/ci/runs/:id/release-report'];
  assert.equal(put.checks[0]!.verb, 'manage');
  assert.equal(post.checks[0]!.verb, 'manage');
  assert.equal(CI_POLICIES['GET /api/ci/repos/:id/release-report'].checks[0]!.verb, 'view');
  // The only parameter the backfill takes is the run id in its path.
  assert.equal(post.checks[0]!.from, 'path');
  assert.equal(CI_API.runReleaseReport('run41').includes('vault'), false);
});
