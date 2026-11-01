// Usage per org (owner bug 2026-11-01): with the switcher on one org, the Usage page showed every org's spend and Claudes, and the history of
// the decommissioned workspaces (kubernetes/kohi-event, kubernetes/memorid-project). A usage row is anchored through its session as it is
// now (relocation moved the sessions, not their usage rows), else a decommissioned workspace goes to its heir (authz/usageAnchor.ts):
//   1. the mapping helper (heirOf, anchorWorkspace, oldName) and the session reader on a real migrated store;
//   2. the Requests report, the strip and the export (claudeusage) keep only the requests anchored in the context, and name old Claudes "(old)";
//   3. the spend summary, attribution, budgets and spikes (usagespend) do the same.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOW as USAGE_NOW, usageHarness } from '../claudeusage/fixtures.js';
import { outlierEvidence } from '../usagespend/spikes.js';
import { NOW, spendHarness } from '../usagespend/testkit.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { anchorWorkspace, heirOf, isRetiredWorkspace, oldName, sessionPlaces, type InWorkspace } from './usageAnchor.js';

const KOHI = 'kubernetes/kohi-event';
const MEMORID = 'kubernetes/memorid-project';
const ISNAN = 'isnan/isnan';
const KONFERSI = 'konfersi/konfersi';
const KOHILABS = 'kohilabs/kohilabs';
const MIN = 60_000;

/** The org context as the routes hand it down: one org's workspace (byWorkspace(orgScopeFilter(...)) is tested in orgScopeMetrics.test.ts). */
const only =
  (ws: string): InWorkspace =>
  (w) =>
    w === ws;

test('the mapping helper: kohi-event goes to isnan (its Konfersi repository to Konfersi), memorid-project to Kohilabs; nothing else moves', () => {
  assert.equal(heirOf(KOHI), ISNAN);
  assert.equal(heirOf(KOHI, '/home/node/work/claudepilot'), ISNAN);
  assert.equal(heirOf(KOHI, '/home/node/work/konfersi'), KONFERSI);
  assert.equal(heirOf(KOHI, '/home/node/work/Konfersi-api/src'), KONFERSI);
  assert.equal(heirOf(KOHI, '/home/node/work/notkonfersi'), ISNAN, 'a folder only named like it is not the repository');
  assert.equal(heirOf(MEMORID), KOHILABS);
  assert.equal(heirOf(MEMORID, '/home/node/work/konfersi'), KOHILABS);
  assert.equal(heirOf(ISNAN), null);
  assert.equal(heirOf(null), null);
  assert.equal(isRetiredWorkspace(KOHI), true);
  assert.equal(isRetiredWorkspace('docker/ws'), false);
  assert.equal(isRetiredWorkspace('toString'), false, 'an inherited property is no workspace');
  // A row's anchor: its session where it lives now, else a retired workspace's heir, else where it ran.
  assert.equal(anchorWorkspace(KOHI, { workspaceId: KONFERSI, cwd: '/home/node/work/x' }), KONFERSI, 'a relocated session wins');
  assert.equal(anchorWorkspace(KOHI, null), ISNAN);
  assert.equal(anchorWorkspace(KOHI, { workspaceId: KOHI, cwd: '/home/node/work/konfersi' }), KONFERSI, 'a session not moved: its folder decides');
  assert.equal(anchorWorkspace('docker/ws', null), 'docker/ws');
  assert.equal(oldName('fadlilah', KOHI), 'fadlilah (old)');
  assert.equal(oldName('fadlilah', KONFERSI), 'fadlilah');
});

test('sessionPlaces: the workspace a session lives in now, as its key (a stable id through workspace_identities); a gone session is null', async () => {
  const store = await Store.open({ dataDir: tempDirectory('cp-usageanchor-'), secretKey: null });
  try {
    const db = store.db!;
    const at = new Date(NOW).toISOString();
    db.prepare("INSERT INTO workspace_identities (id, target, name, legacy_id, created_at) VALUES ('ws_konfersi0001', 'konfersi', 'konfersi', ?, ?)").run(KONFERSI, at);
    const session = db.prepare('INSERT INTO chat_sessions (id, workspace_id, cwd, title, state, state_since, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    session.run('s_moved', 'ws_konfersi0001', '/home/node/work/konfersi', 't', 'idle', at, at, at);
    session.run('s_key', KOHI, '', 't', 'idle', at, at, at);
    const place = sessionPlaces(() => store.db);
    assert.deepEqual(place('s_moved'), { workspaceId: KONFERSI, cwd: '/home/node/work/konfersi' });
    assert.deepEqual(place('s_key'), { workspaceId: KOHI, cwd: '' });
    assert.equal(place('s_gone'), null);
    assert.equal(place(undefined), null);
    assert.equal(sessionPlaces(() => null)('s_moved'), null, 'no store: every session reads as gone');
  } finally {
    store.close();
  }
});

/** The same history in both modules: four requests on the retired workspaces and one on isnan's own. */
function seedHistory(db: NonNullable<Store['db']>, at: number): void {
  const iso = new Date(at).toISOString();
  db.prepare("INSERT INTO workspace_identities (id, target, name, legacy_id, created_at) VALUES ('ws_konfersi0001', 'konfersi', 'konfersi', ?, ?)").run(KONFERSI, iso);
  const claude = db.prepare('INSERT INTO workspace_claudes (id, workspace_id, name, directory, created_at) VALUES (?, ?, ?, ?, ?)');
  claude.run('c_oldfad', KOHI, 'fadlilah', 'claudes/0000000000000001', iso);
  claude.run('c_oldmem', MEMORID, 'satria', 'claudes/0000000000000002', iso);
  claude.run('c_isnan', ISNAN, 'alfian', 'claudes/0000000000000003', iso);
  const session = db.prepare('INSERT INTO chat_sessions (id, workspace_id, cwd, title, state, state_since, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  // Relocated to Konfersi (stored by its stable id), and a chat of isnan's own. `s_gone` was deleted: its rows go to the heir.
  session.run('s_moved', 'ws_konfersi0001', '/home/node/work/konfersi', 't', 'idle', iso, iso, iso);
  session.run('s_isnan', ISNAN, '/home/node/work/x', 't', 'idle', iso, iso, iso);
  const usage = db.prepare(
    `INSERT INTO chat_usage (at, at_ms, session_id, workspace_id, claude_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, requests, agents, duration_ms)
     VALUES (?, ?, ?, ?, ?, 'claude-opus-4-5', 10, 0, 0, 0, ?, 1, 0, 0)`,
  );
  usage.run(iso, at, 's_moved', KOHI, 'c_oldfad', 1);
  usage.run(iso, at, 's_gone', KOHI, 'c_oldfad', 2);
  usage.run(iso, at, 's_mem', MEMORID, 'c_oldmem', 4);
  usage.run(iso, at, 's_isnan', ISNAN, 'c_isnan', 8);
}

test('claude usage: the Requests report, the strip and the export keep only the requests anchored in the context; old Claudes read "(old)"', async () => {
  const h = await usageHarness();
  try {
    seedHistory(h.store.db!, USAGE_NOW - 5 * MIN);
    const cost = (ws?: string) => h.usage.requestsReport('1d', ws ? { inWorkspace: only(ws) } : {}).totals.costUsd;
    assert.equal(cost(), 15, 'no context: every request, as before');
    assert.equal(cost(KONFERSI), 1, 'the relocated chat’s request follows it to Konfersi');
    assert.equal(cost(ISNAN), 10, 'kohi-event’s request with no session goes to isnan, with isnan’s own');
    assert.equal(cost(KOHILABS), 4, 'memorid-project goes to Kohilabs');
    assert.equal(cost('docker/elsewhere'), 0);
    const isnan = h.usage.requestsReport('1d', { inWorkspace: only(ISNAN) });
    assert.deepEqual(isnan.byClaude.map((c) => c.name).sort(), ['alfian', 'fadlilah (old)']);
    assert.deepEqual(isnan.claudes.map((s) => s.label).sort(), ['alfian', 'fadlilah (old)']);
    const strip = await h.usage.summary({ inWorkspace: only(KONFERSI) });
    assert.equal(strip.today.costUsd.value, 1);
    const file = await h.usage.exportFile({ what: 'requests', format: 'csv', range: '1d' }, undefined, only(KOHILABS));
    assert.match(file.body, /satria \(old\)/);
    assert.doesNotMatch(file.body, /alfian|fadlilah/);
  } finally {
    h.done();
  }
});

test('usage spend: the summary, attribution, budgets and spikes keep only what is anchored in the context', async () => {
  const h = await spendHarness({ now: { t: NOW } });
  try {
    seedHistory(h.db, NOW - 5 * MIN);
    const today = (ws?: string) => h.spend.summary(undefined, ws ? only(ws) : undefined).today.costUsd;
    assert.equal(today(), 15);
    assert.equal(today(KONFERSI), 1);
    assert.equal(today(ISNAN), 10);
    assert.equal(today(KOHILABS), 4);
    const byClaude = h.spend.attribution({ by: 'claude', range: '1d' }, undefined, { inWorkspace: only(ISNAN) });
    assert.equal(byClaude.totals.costUsd, 10);
    assert.deepEqual(byClaude.rows.map((r) => r.label).sort(), ['alfian', 'fadlilah (old)']);
    assert.equal(h.spend.attribution({ by: 'session', range: '1d' }, undefined, { inWorkspace: only(KONFERSI) }).totals.costUsd, 1);
    // Budgets: by the workspace they count (a retired one's heir); one on everything has no workspace.
    await h.spend.createBudget({ name: 'konfersi', scope: { kind: 'workspace', id: KONFERSI }, period: 'month', limitUsd: 100 });
    await h.spend.createBudget({ name: 'old fadlilah', scope: { kind: 'claude', id: 'c_oldfad' }, period: 'month', limitUsd: 100 });
    await h.spend.createBudget({ name: 'all', scope: { kind: 'all' }, period: 'month', limitUsd: 100 });
    const names = (inWorkspace?: InWorkspace) => h.spend.budgets(undefined, inWorkspace).budgets.map((b) => b.budget.name).sort();
    assert.deepEqual(names(), ['all', 'konfersi', 'old fadlilah']);
    assert.deepEqual(names(only(KONFERSI)), ['konfersi']);
    assert.deepEqual(names(only(ISNAN)), ['old fadlilah']);
    assert.deepEqual(names((w) => w === null), ['all'], 'a budget on everything: no workspace (Personal only)');
    // A spike recorded on the old workspace for the relocated chat follows the chat.
    const evidence = JSON.stringify(outlierEvidence(5, { medianUsd: 0.5, factor: 10, requests: 20 }));
    h.db
      .prepare("INSERT INTO usage_spikes (at_ms, kind, subject, session_id, workspace_id, claude_id, evidence, alerted, owner) VALUES (?, 'outlier', 's_moved', 's_moved', ?, 'c_oldfad', ?, 1, 'u_owner')")
      .run(NOW - MIN, KOHI, evidence);
    const spikes = (ws: string) => h.spend.spikes('1d', undefined, only(ws)).events.length;
    assert.equal(spikes(KONFERSI), 1);
    assert.equal(spikes(ISNAN), 0);
  } finally {
    h.done();
  }
});
