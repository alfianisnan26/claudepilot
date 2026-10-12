import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { McpProposalRequest } from '@portal/contracts';
import type { FragmentProvider } from '../delivery/reconciler.js';
import type { WorkspaceStep, WorkspaceSteps } from '../delivery/steps.js';
import { References } from '../pools/references.js';
import { PoolService } from '../pools/service.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { McpSets, proposeEntry } from './index.js';

// I3, the global "add MCP" flow: an agent or a token can only PROPOSE a catalog entry. It's a draft
// waiting for a person; nothing makes it deliverable but a person approving it in the portal.

const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;
const field = (f: string) => (e: unknown) => isAppError(e) && !!(e.details as Record<string, string> | undefined)?.[f];
const TOKEN = 'portal-mcp:tok_8f3a1c';

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-mcp-propose-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const providers: FragmentProvider[] = [];
  const pools = new PoolService(store, { providers });
  const references = new References();
  pools.reconciler = { request: () => Promise.resolve() };
  const queued: { ws: string; step: WorkspaceStep }[] = [];
  const steps = { enqueue: (ws: string, list: WorkspaceStep[]) => list.forEach((step) => queued.push({ ws, step })), queued: () => [] } as unknown as WorkspaceSteps;
  const mcp = new McpSets(store, pools, references, () => undefined, { resolveDns: false, steps });
  return { store, pools, mcp, done: () => (store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}
type H = Awaited<ReturnType<typeof setup>>;

const linear = (over: Partial<McpProposalRequest> = {}): McpProposalRequest => ({
  key: 'linear',
  displayName: 'Linear',
  description: 'Issues and projects',
  kind: 'remote',
  spec: { url: 'https://mcp.linear.app/mcp', auth: 'headers' },
  slots: [{ name: 'Authorization', target: 'header', secret: true, required: true, template: 'Bearer {value}' }],
  reason: 'The ticket needs to read Linear issues.',
  ...over,
});

const memory = (over: Partial<McpProposalRequest> = {}): McpProposalRequest => ({
  key: 'memory',
  displayName: 'Memory',
  kind: 'npm',
  version: '1.0.0',
  spec: { package: '@modelcontextprotocol/server-memory' },
  slots: [{ name: 'DEMO_TOKEN', target: 'env', secret: true, required: true, description: 'A token, referenced by name' }],
  ...over,
});

const count = (h: H, sql: string) => Number((h.store.db!.prepare(sql).get() as { n: number }).n);

test('a proposal is a draft with its actor and reason recorded; nothing is deliverable and no set accepts it', async () => {
  const h = await setup();
  try {
    const r = await proposeEntry(h.mcp, TOKEN, linear());
    assert.deepEqual([r.status, r.newEntry, r.duplicate, r.proposedBy, r.key, r.version], ['waiting_review', true, false, TOKEN, 'linear', 'v1']);
    assert.equal(r.reviewPath, `/admin/pools/mcp/catalog/${r.entryId}`);

    const entry = h.mcp.catalog.get(r.entryId);
    const v = entry.versions[0]!;
    assert.equal(v.id, r.versionId);
    assert.equal(v.reviewState, 'draft', 'a draft: the only state a proposal can be in');
    assert.equal(v.reviewedAt, null);
    assert.equal(v.reviewedBy, null);
    assert.deepEqual({ by: v.proposal!.by, reason: v.proposal!.reason }, { by: TOKEN, reason: 'The ticket needs to read Linear issues.' });
    assert.ok(v.proposal!.at);
    assert.equal(v.workspaces, 0);
    assert.equal(h.mcp.catalog.waitingReview(), 1);

    // The review gate every set goes through: a draft can't be put in a set, however it got there.
    assert.throws(
      () => h.pools.create('mcpset', { name: 'Tools', content: { servers: [{ key: 'linear', entry: r.entryId, version: 'v1', enabled: true, config: {}, secrets: { Authorization: 'LINEAR_API_KEY' } }] } }),
      /isn’t approved yet/,
    );
    // The proposal can't approve itself, and approval needs the reviewer's tick.
    assert.throws(() => h.mcp.catalog.approve(r.entryId, r.versionId, {}), field('reviewed'));
    assert.equal(h.mcp.catalog.get(r.entryId).versions[0]!.reviewState, 'draft');
  } finally {
    h.done();
  }
});

test('a person approving it in the portal is the only way in: then it joins a set, and the proposal stays on record', async () => {
  const h = await setup();
  try {
    const r = await h.mcp.proposeEntry(TOKEN, memory());
    const approved = h.mcp.catalog.approve(r.entryId, r.versionId, { reviewed: true, note: 'Read the package.' });
    const v = approved.versions[0]!;
    assert.deepEqual([v.reviewState, v.reviewedBy], ['approved', 'Admin']);
    assert.equal(v.proposal!.by, TOKEN, 'who proposed it is kept for the audit trail');
    assert.equal(h.mcp.catalog.waitingReview(), 0);
    const set = h.pools.create('mcpset', { name: 'Tools', content: { servers: [{ key: 'memory', entry: r.entryId, version: '1.0.0', enabled: true, config: {}, secrets: { DEMO_TOKEN: 'DEMO' } }] } });
    assert.equal(set.revision, 1);
  } finally {
    h.done();
  }
});

test('secrets are named, never held: credential-shaped text in any field is refused, invisible characters too', async () => {
  const h = await setup();
  try {
    const canary = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
    const bad = (over: Partial<McpProposalRequest>, where: string) =>
      assert.rejects(h.mcp.proposeEntry(TOKEN, linear(over)), field(where), where);
    await bad({ description: `Use ${canary} to sign in` }, 'description');
    await bad({ reason: `token: ${canary}` }, 'reason');
    await bad({ displayName: `Linear ${canary}` }, 'displayName');
    await bad({ slots: [{ name: 'Authorization', target: 'header', secret: true, description: `key is ${canary}`, template: 'Bearer {value}' }] }, 'slots.0.description');
    await bad({ description: 'Looks fine‮ but hides a direction override' }, 'description');
    await bad({ reason: 'zero​width' }, 'reason');
    // Arguments and URLs have their own guards (they show in `ps` and logs).
    await assert.rejects(h.mcp.proposeEntry(TOKEN, memory({ spec: { package: 'x', args: ['--token', canary] } })), /looks like a secret/);
    await assert.rejects(h.mcp.proposeEntry(TOKEN, linear({ spec: { url: `https://mcp.example.com/?api_key=${canary}`, auth: 'headers' } })), /secret/);
    // A secret slot can't carry a default value either: only a name.
    await assert.rejects(
      h.mcp.proposeEntry(TOKEN, linear({ slots: [{ name: 'Authorization', target: 'header', secret: true, default: 'Bearer abc', template: 'Bearer {value}' }] })),
      field('slots.0.default'),
    );
    assert.equal(count(h, 'SELECT count(*) AS n FROM mcp_catalog'), 0, 'every refusal left nothing behind');
    // And the canary is nowhere in the database after a good proposal.
    await h.mcp.proposeEntry(TOKEN, linear());
    for (const table of ['mcp_catalog', 'mcp_catalog_versions', 'mcp_events'])
      assert.equal(count(h, `SELECT count(*) AS n FROM ${table} WHERE ${table === 'mcp_catalog' ? 'description' : table === 'mcp_events' ? 'details' : 'proposal_reason'} LIKE '%ghp_%'`), 0, table);
  } finally {
    h.done();
  }
});

test('who is asking must be named as an actor, never as a credential', async () => {
  const h = await setup();
  try {
    for (const bad of ['', 'admin', 'portal-mcp:', 'Bearer abc', 'portal-mcp:has space', 'x:y', `portal-mcp:${'a'.repeat(100)}`])
      await assert.rejects(h.mcp.proposeEntry(bad, linear()), field('actor'), bad);
    for (const ok of ['portal-mcp:tok_1', 'session:abc-123', 'ticket:KOH-42']) await h.mcp.proposeEntry(ok, linear({ key: `k-${ok.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12)}`, spec: { url: `https://mcp.example.com/${ok.length}`, auth: 'none' }, slots: [] }));
    assert.equal(h.mcp.catalog.waitingReview(), 3);
  } finally {
    h.done();
  }
});

test('the same proposal again is the one already waiting; a changed one is another version; reviewed versions never change', async () => {
  const h = await setup();
  try {
    const first = await h.mcp.proposeEntry(TOKEN, memory());
    const again = await h.mcp.proposeEntry(TOKEN, memory());
    assert.deepEqual([again.duplicate, again.versionId, again.newEntry], [true, first.versionId, false]);
    assert.equal(count(h, 'SELECT count(*) AS n FROM mcp_catalog_versions'), 1);

    const approved = h.mcp.catalog.approve(first.entryId, first.versionId, { reviewed: true });
    const before = JSON.stringify(approved.versions[0]!.spec);
    // The agent now wants a newer package version: a new draft next to the approved one.
    const next = await h.mcp.proposeEntry(TOKEN, memory({ version: '1.1.0', spec: { package: '@modelcontextprotocol/server-memory', args: ['--quiet'] } }));
    assert.deepEqual([next.newEntry, next.duplicate, next.entryId, next.version], [false, false, first.entryId, '1.1.0']);
    const entry = h.mcp.catalog.get(first.entryId);
    assert.deepEqual(entry.versions.map((v) => [v.version, v.reviewState]).sort(), [['1.0.0', 'approved'], ['1.1.0', 'draft']]);
    assert.equal(JSON.stringify(entry.versions.find((v) => v.version === '1.0.0')!.spec), before, 'the approved version is untouched');
    // A version number that exists can't be proposed again with different content.
    await assert.rejects(h.mcp.proposeEntry(TOKEN, memory({ spec: { package: '@modelcontextprotocol/server-memory', args: ['--other'] } })), code('CONFLICT'));
    // Another kind under the same key is refused, and so is another entry's package.
    await assert.rejects(h.mcp.proposeEntry(TOKEN, memory({ kind: 'remote', spec: { url: 'https://mcp.example.com/' } })), code('CONFLICT'));
    await assert.rejects(h.mcp.proposeEntry(TOKEN, memory({ key: 'memory-2' })), /already in the catalog/);
  } finally {
    h.done();
  }
});

test('a version another actor proposed is a separate proposal, and only its proposer can withdraw it', async () => {
  const h = await setup();
  try {
    const mine = await h.mcp.proposeEntry(TOKEN, linear());
    const other = await h.mcp.proposeEntry('session:abc', linear());
    assert.deepEqual([other.duplicate, other.newEntry, other.version], [false, false, 'v2']);
    assert.throws(() => h.mcp.withdrawProposal('session:abc', mine.versionId), code('CONFLICT'));
    assert.throws(() => h.mcp.withdrawProposal(TOKEN, 'nope'), code('NOT_FOUND'));
    h.mcp.withdrawProposal(TOKEN, mine.versionId);
    assert.deepEqual(h.mcp.catalog.get(mine.entryId).versions.map((v) => v.version), ['v2'], 'the entry stays: another proposal still uses it');
    h.mcp.withdrawProposal('session:abc', other.versionId);
    assert.equal(count(h, 'SELECT count(*) AS n FROM mcp_catalog'), 0, 'an entry that existed only for proposals goes with the last one');
    // A reviewed version is on record: it can't be withdrawn.
    const kept = await h.mcp.proposeEntry(TOKEN, memory());
    h.mcp.catalog.approve(kept.entryId, kept.versionId, { reviewed: true });
    assert.throws(() => h.mcp.withdrawProposal(TOKEN, kept.versionId), code('NOT_FOUND'));
  } finally {
    h.done();
  }
});

test('proposals are capped, per actor and in all, so a stolen token cannot bury the review queue', async () => {
  const h = await setup();
  try {
    const nth = (n: number, actor = TOKEN) => h.mcp.proposeEntry(actor, linear({ key: `srv-${n}`, spec: { url: `https://mcp.example.com/${n}`, auth: 'none' }, slots: [] }));
    for (let i = 0; i < 10; i++) await nth(i);
    await assert.rejects(nth(10), code('RATE_LIMITED'));
    // Another actor is unaffected, up to the overall limit.
    for (let a = 0; a < 3; a++) for (let i = 0; i < 10; i++) await nth(100 + a * 10 + i, `session:s${a}`);
    assert.equal(h.mcp.catalog.waitingReview(), 40);
    await assert.rejects(nth(500, 'session:late'), code('RATE_LIMITED'));
    // Reviewing one frees a place.
    const first = h.mcp.catalog.list().find((e) => e.key === 'srv-0')!;
    h.mcp.catalog.approve(first.id, first.versions[0]!.id, { reviewed: true });
    await nth(501, 'session:late');
  } finally {
    h.done();
  }
});

test('the same checks as the UI apply: the portal’s own address, private networks and reserved names', async () => {
  const h = await setup();
  try {
    await assert.rejects(h.mcp.proposeEntry(TOKEN, linear({ spec: { url: 'https://mcp.anthropic.com/sse', auth: 'none' }, slots: [] })), /Anthropic-hosted/);
    await assert.rejects(h.mcp.proposeEntry(TOKEN, linear({ key: 'workspace' })), /keeps for itself/);
    await assert.rejects(h.mcp.proposeEntry(TOKEN, linear({ spec: { url: 'http://169.254.169.254/latest', auth: 'none' }, slots: [] })), /metadata/);
    await assert.rejects(h.mcp.proposeEntry(TOKEN, linear({ kind: 'pypi' })), /uv/);
    // A proposal of a command in the image is flagged for the reviewer like any other.
    const cmd = await h.mcp.proposeEntry(TOKEN, { key: 'local-sh', displayName: 'Local', kind: 'command', spec: { path: '/usr/bin/sudo', args: ['rm', '-rf', '/'] } });
    assert.ok(h.mcp.catalog.get(cmd.entryId).versions[0]!.flags.some((f) => f.code === 'sudo'));
    assert.ok(h.mcp.catalog.get(cmd.entryId).versions[0]!.flags.some((f) => f.code === 'not_pinned'));
  } finally {
    h.done();
  }
});

test('the event log says who proposed what, and never carries the reason beyond the cap', async () => {
  const h = await setup();
  try {
    const r = await h.mcp.proposeEntry(TOKEN, linear());
    const row = h.store.db!.prepare("SELECT details FROM mcp_events WHERE type = 'proposed'").get() as { details: string };
    assert.deepEqual(JSON.parse(row.details), { by: TOKEN, key: 'linear', kind: 'remote', version: 'v1', newEntry: true, duplicate: false, reason: 'The ticket needs to read Linear issues.' });
    h.mcp.withdrawProposal(TOKEN, r.versionId);
    assert.equal(count(h, "SELECT count(*) AS n FROM mcp_events WHERE type = 'proposal_withdrawn'"), 1);
    await assert.rejects(h.mcp.proposeEntry(TOKEN, linear({ reason: 'x'.repeat(501) })), field('reason'));
  } finally {
    h.done();
  }
});
