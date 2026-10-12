// The version module's tables (migrations 300 and 301; docs/prd/claude-version-pinning.md §9): history for Rollback, canary runs with their output, and the audit.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CLAUDE_CANARY_SUITE } from '@portal/contracts';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { ClaudeVersionStore, verdictOf } from './store.js';

let dir: string;
let store: Store;
let cv: ClaudeVersionStore;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cp-cv-store-'));
  store = await Store.open({ dataDir: dir, secretKey: parseSecretKey(generateSecretKey()) });
  cv = new ClaudeVersionStore(store);
});
after(() => rmSync(dir, { recursive: true, force: true }));

const history = (over: Partial<Parameters<ClaudeVersionStore['addHistory']>[0]> = {}) =>
  ({ workspaceId: 'docker/a', kind: 'upgrade', fromVersion: '2.1.296', toVersion: '2.1.300', fromImage: 'claudepilot-workspace:cc-2.1.296', fromImageId: 'sha256:old', toImage: 'claudepilot-workspace:cc-2.1.300', canaryRunId: 4, canary: 'pass', accepted: [], outcome: 'applied', detail: null, actor: 'user:u_owner', ...over }) as Parameters<ClaudeVersionStore['addHistory']>[0];

test('the migrations ran: the three tables exist with owner and creator columns', () => {
  const cols = (t: string) => (store.db!.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  for (const t of ['claude_version_history', 'claude_canary_runs']) for (const c of ['owner_id', 'created_by', 'actor']) assert.ok(cols(t).includes(c), `${t}.${c}`);
  assert.ok(cols('claude_version_events').includes('owner_id'));
  const row = store.db!.prepare("SELECT owner_id, created_by FROM claude_version_history WHERE 0").all();
  assert.deepEqual(row, []);
});

test('history: newest first, per workspace, with the actor; the newest applied change is the rollback target', () => {
  const a1 = cv.addHistory(history({ canaryRunId: 1 }), new Date('2026-10-12T01:00:00Z'));
  cv.addHistory(history({ workspaceId: 'docker/b', fromVersion: '2.1.287', toVersion: '2.1.296' }), new Date('2026-10-12T02:00:00Z'));
  const a2 = cv.addHistory(history({ kind: 'rollback', fromVersion: '2.1.300', toVersion: '2.1.296', fromImage: 'claudepilot-workspace:cc-2.1.300', toImage: 'claudepilot-workspace:cc-2.1.296', fromImageId: null, canary: 'none', canaryRunId: null }), new Date('2026-10-12T03:00:00Z'));
  cv.addHistory(history({ outcome: 'failed', detail: 'could not start' }), new Date('2026-10-12T04:00:00Z'));
  const rows = cv.history('docker/a');
  assert.deepEqual(rows.map((r) => r.id), [a2 + 1, a2, a1], 'newest first');
  assert.equal(rows.every((r) => r.actor === 'user:u_owner' && r.workspaceId === 'docker/a'), true);
  assert.deepEqual(rows[2]!.accepted, []);
  const latest = cv.latestApplied();
  assert.equal(latest.get('docker/a')!.id, a2, 'a failed change is not a rollback target');
  assert.equal(latest.get('docker/a')!.kind, 'rollback');
  assert.equal(latest.get('docker/b')!.toVersion, '2.1.296');
  assert.equal(latest.get('docker/a')!.fromImageId, null);
  assert.equal(cv.history('docker/none').length, 0);
  const owners = store.db!.prepare('SELECT DISTINCT owner_id, created_by FROM claude_version_history').all();
  assert.deepEqual(owners.map((o) => ({ ...o })), [{ owner_id: 'u_owner', created_by: 'u_owner' }]);
});

test('canary runs: started, saved with results as they come, counted and judged; retention keeps the newest', () => {
  const id = cv.startRun({ trigger: 'manual', subject: 'target', version: '2.1.300', image: 'claudepilot-workspace:cc-2.1.300', mode: 'image', status: 'running', note: 'Queued', suite: CLAUDE_CANARY_SUITE, actor: 'user:u_owner' }, new Date('2026-10-12T05:00:00Z'));
  assert.equal(cv.run(id)!.status, 'running');
  assert.equal(cv.run(id)!.verdict, null, 'no verdict while it runs');
  cv.saveRun(id, { note: 'Running: Stream', results: [{ id: 'version', status: 'pass', durationMs: 4, summary: 'ok', detail: '' }] });
  assert.deepEqual([cv.run(id)!.pass, cv.run(id)!.fail, cv.run(id)!.skipped, cv.run(id)!.note], [1, 0, 0, 'Running: Stream']);
  cv.saveRun(id, { status: 'done', reported: '2.1.300', results: [{ id: 'version', status: 'pass', durationMs: 4, summary: 'ok', detail: '' }, { id: 'get-usage', status: 'fail', durationMs: 9, summary: 'bad', detail: 'lines' }, { id: 'mcp-login', status: 'skipped', durationMs: 0, summary: 'no', detail: '' }], finished: true }, new Date('2026-10-12T05:01:00Z'));
  const done = cv.run(id)!;
  assert.deepEqual([done.status, done.pass, done.fail, done.skipped, done.verdict, done.reported, done.finishedAt], ['done', 1, 1, 1, 'fail', '2.1.300', '2026-10-12T05:01:00.000Z']);
  assert.equal(done.results[1]!.detail, 'lines');
  assert.equal(done.suite, CLAUDE_CANARY_SUITE);
  assert.equal(cv.runs({ version: '2.1.300' })[0]!.id, id);
  assert.equal(cv.runs({ subject: 'installed' }).length, 0);
  assert.equal(verdictOf(3, 0, 0), 'pass');
  assert.equal(verdictOf(3, 0, 1), 'partial');
  assert.equal(verdictOf(3, 2, 1), 'fail');
  assert.equal(verdictOf(0, 0, 0), null);
});

test('a run left running by a restart becomes an error; tested versions are the ones a run passed on with nothing failed', () => {
  const stuck = cv.startRun({ trigger: 'scheduled', subject: 'installed', version: '2.1.296', image: null, mode: 'image', status: 'running', note: null, suite: CLAUDE_CANARY_SUITE, actor: 'system:claude-canary' });
  assert.equal(cv.interruptRunning('The portal stopped while it ran.'), 1);
  assert.deepEqual([cv.run(stuck)!.status, cv.run(stuck)!.note, cv.run(stuck)!.verdict], ['error', 'The portal stopped while it ran.', null]);
  const good = cv.startRun({ trigger: 'manual', subject: 'target', version: '2.1.310', image: null, mode: 'image', status: 'running', note: null, suite: CLAUDE_CANARY_SUITE, actor: 'user:u_owner' });
  cv.saveRun(good, { status: 'done', reported: '2.1.310', results: [{ id: 'version', status: 'pass', durationMs: 1, summary: '', detail: '' }], finished: true });
  assert.deepEqual(cv.testedVersions().sort(), ['2.1.310'], 'the failed 2.1.300 run does not count');
});

test('portal_meta keeps the default pin and the last candidate; the audit trail records who did what', () => {
  assert.equal(cv.meta('default'), null);
  cv.setMeta('default', '2.1.300');
  assert.equal(cv.meta('default'), '2.1.300');
  assert.equal(store.db!.prepare("SELECT count(*) AS n FROM portal_meta WHERE key = 'claude_version:default'").get()!.n, 1);
  cv.audit('default_set', { actor: 'user:u_owner' }, { version: '2.1.300' });
  cv.audit('upgrade', { actor: 'user:u_owner' }, { workspaceId: 'docker/a', version: '2.1.300', detail: 'a -> b' });
  const events = cv.events(5);
  assert.deepEqual(events.map((e) => e.action), ['upgrade', 'default_set']);
  assert.equal(events[0]!.workspaceId, 'docker/a');
  assert.equal(store.db!.prepare('SELECT DISTINCT owner_id FROM claude_version_events').get()!.owner_id, 'u_owner');
});
