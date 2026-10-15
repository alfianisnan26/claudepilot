// T-292 slice 2: the context pack kept in step as an instruction context (contextPack.ts), on a real database and pool service.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ContextContent } from '@portal/contracts';
import { PoolService } from '../pools/service.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { contextPackHook, contextPackName, syncContextPack, type ContextPackInput } from './contextPack.js';
import { Personas } from './index.js';
import { contextFile } from './render.js';

const WS = 'kubernetes/dev';
const NAME = 'claudepilot-context-pack';
const REPO_ROOT = join(import.meta.dirname, '../../../..');

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-context-pack-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const pools = new PoolService(store, { providers: [] });
  new Personas(store, pools);
  const requests: string[] = [];
  pools.reconciler = { request: (id: string) => (requests.push(id), Promise.resolve()) };
  const done = () => (store.close(), rmSync(dataDir, { recursive: true, force: true }));
  const pool = () => pools.list('context').find((p) => p.name === NAME);
  const body = () => (pool()?.content as ContextContent | undefined)?.body;
  return { store, pools, requests, done, pool, body };
}

const push = (text: string | null, over: Partial<ContextPackInput> = {}): ContextPackInput => ({
  workspaceId: WS,
  repo: 'claudepilot',
  branch: 'integration',
  sha: 'a'.repeat(40),
  file: { text },
  ...over,
});
/** A GitHub-token-shaped string, built here so no such literal is in the repository. */
const tokenShaped = () => ['gh', 'p_'].join('') + 'Ab1'.repeat(12);

test('created: the pack becomes the context pool, assigned to the workspace, its revision noting the commit', async () => {
  const h = await setup();
  try {
    assert.equal(contextPackName('claudepilot'), NAME);
    const r = syncContextPack(h.pools, push('# Context pack\r\n\nRead this first.\n\n'));
    assert.equal(r.outcome, 'created');
    assert.deepEqual([r.outcome === 'created' && r.assigned, r.outcome === 'created' && r.revision], [true, 1]);
    assert.equal(h.body(), '# Context pack\n\nRead this first.', 'stored as the context kind stores a body');
    assert.deepEqual(h.pools.assignmentsFor(WS).map((a) => a.poolId), [h.pool()!.id]);
    assert.match(h.pools.get(h.pool()!.id).revisions[0]!.note ?? '', /^context pack aaaaaaa from claudepilot@integration$/);
    assert.ok(h.requests.includes(WS), 'delivery was asked for');
  } finally {
    h.done();
  }
});

test('updated when the pack changes, unchanged (no revision) when it is equal', async () => {
  const h = await setup();
  try {
    syncContextPack(h.pools, push('one'));
    const same = syncContextPack(h.pools, push('one\n', { sha: 'b'.repeat(40) }));
    assert.deepEqual(same, { outcome: 'unchanged', poolId: h.pool()!.id, revision: 1 });
    const changed = syncContextPack(h.pools, push('two', { sha: 'c'.repeat(40) }));
    assert.equal(changed.outcome, 'updated');
    assert.equal(h.pool()!.latestRevision, 2);
    assert.equal(h.pool()!.revision, 2, 'the new revision is current');
    assert.equal(h.body(), 'two');
    assert.equal(h.pools.get(h.pool()!.id).revisions.length, 2);
  } finally {
    h.done();
  }
});

test('over the 20 KB cap is refused and the pool keeps what it had; so is a pack the snapshot did not read', async () => {
  const h = await setup();
  try {
    assert.deepEqual(syncContextPack(h.pools, push('x'.repeat(20 * 1024 + 1))), { outcome: 'refused', code: 'too_large' });
    assert.equal(h.pool(), undefined, 'nothing created');
    syncContextPack(h.pools, push('small'));
    assert.deepEqual(syncContextPack(h.pools, push('y'.repeat(20 * 1024 + 1))), { outcome: 'refused', code: 'too_large' });
    assert.deepEqual(syncContextPack(h.pools, push(null, { file: { text: null, skipped: 'too_large' } })), { outcome: 'refused', code: 'too_large' });
    assert.deepEqual(syncContextPack(h.pools, push(null, { file: { text: null, skipped: 'binary' } })), { outcome: 'refused', code: 'unreadable' });
    assert.deepEqual([h.body(), h.pool()!.latestRevision], ['small', 1]);
    // Exactly the cap fits.
    assert.equal(syncContextPack(h.pools, push('z'.repeat(20 * 1024))).outcome, 'updated');
  } finally {
    h.done();
  }
});

test('nothing secret-shaped enters the pool', async () => {
  const h = await setup();
  try {
    assert.deepEqual(syncContextPack(h.pools, push(`# Pack\nuse ${tokenShaped()} to push\n`)), { outcome: 'refused', code: 'secret' });
    assert.equal(h.pool(), undefined);
    syncContextPack(h.pools, push('clean'));
    assert.deepEqual(syncContextPack(h.pools, push(`clean\n${tokenShaped()}`)), { outcome: 'refused', code: 'secret' });
    assert.equal(h.body(), 'clean');
    const rows = h.store.db!.prepare("SELECT content FROM pool_revisions r JOIN pools p ON p.id = r.pool_id WHERE p.type = 'context'").all() as { content: string }[];
    assert.ok(rows.every((r) => !r.content.includes(tokenShaped())));
  } finally {
    h.done();
  }
});

test('a pool of that name on another workspace is not overwritten; one a person took off the workspace is not assigned again', async () => {
  const h = await setup();
  try {
    syncContextPack(h.pools, push('mine'));
    const other = syncContextPack(h.pools, push('theirs', { workspaceId: 'docker/other' }));
    assert.deepEqual(other, { outcome: 'refused', code: 'other_workspace', poolId: h.pool()!.id });
    assert.equal(h.body(), 'mine');
    h.pools.setAssignments(WS, 'context', []);
    const r = syncContextPack(h.pools, push('later'));
    assert.deepEqual([r.outcome, r.outcome === 'updated' && r.assigned], ['updated', false]);
    // Only the removal record is left (it holds the manifest's pool until the files are gone), no assignment again.
    assert.deepEqual(h.pools.assignmentsFor(WS).filter((a) => a.poolId === h.pool()!.id).map((a) => a.state), ['removing']);
  } finally {
    h.done();
  }
});

test('the hook audits changes and refusals with fixed codes and never the text; an unchanged pack leaves no row', async () => {
  const h = await setup();
  try {
    const rows: { kind: string; severity?: string; detail?: Record<string, unknown> }[] = [];
    const hook = contextPackHook(h.pools, (e) => void rows.push(e));
    hook(push('first'));
    hook(push('first'));
    hook(push(`leak ${tokenShaped()}`));
    assert.deepEqual(rows.map((r) => [r.kind, r.severity, r.detail?.outcome]), [['pools.context_pack', 'info', 'created'], ['pools.context_pack', 'medium', 'refused']]);
    assert.ok(!JSON.stringify(rows).includes(tokenShaped()) && !JSON.stringify(rows).includes('first'));
  } finally {
    h.done();
  }
});

test('the committed docs/context-pack.md fits and passes the checks', async () => {
  const h = await setup();
  try {
    const text = readFileSync(join(REPO_ROOT, 'docs/context-pack.md'), 'utf8');
    assert.equal(syncContextPack(h.pools, push(text)).outcome, 'created');
  } finally {
    h.done();
  }
});

test('T-472: the pack is a path-scoped rule: its Map folders as paths, so another repository’s sessions do not load it', async () => {
  const h = await setup();
  try {
    const text = readFileSync(join(REPO_ROOT, 'docs/context-pack.md'), 'utf8');
    assert.equal(syncContextPack(h.pools, push(text)).outcome, 'created');
    const body = h.body()!;
    assert.match(body, /^---\npaths:\n/, 'frontmatter first');
    const scope = body.slice(0, body.indexOf('\n---\n')).split('\n').flatMap((l) => /^ {2}- "([^"]+)"$/.exec(l)?.[1] ?? []);
    for (const g of ['apps/server/src/chat/**', 'apps/web/src/features/**', 'packages/contracts/src/**']) assert.ok(scope.includes(g), g);
    for (const g of ['scripts/**', 'deploy/**']) assert.ok(!scope.includes(g), `${g}: a one-level folder other repositories have too`);
    // As delivered: the frontmatter stays at the top of the rule file (Claude Code reads it only there), the portal's comment after it.
    const file = contextFile('claudepilot-context-pack', NAME, 1, body);
    assert.match(file.content, /^---\npaths:\n( {2}- "[^"\n]+"\n)+---\n<!-- Instruction context “claudepilot-context-pack” r1, delivered by the portal\. -->\n<!-- context-pack anchor /);
  } finally {
    h.done();
  }
});
