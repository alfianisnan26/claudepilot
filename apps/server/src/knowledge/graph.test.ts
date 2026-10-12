import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { GraphEdge, GraphNode, GraphResponse } from '@portal/contracts';
import { Directory } from './directory.js';
import { makePng } from './fixtures.js';
import { agenticGraph, capGraph, contextGraph, docsGraph, GraphBuilder, neighbourhood, parseSince, type Mention } from './graph.js';
import { parseActor } from './journal.js';
import { KnowledgeService } from './service.js';
import { harness, outside, UI, type Harness } from './testkit.js';

const open: Harness[] = [];
after(() => open.forEach((h) => h.close()));
const reason = (r: string) => (e: unknown) => (e as { reason?: string }).reason === r;

async function make() {
  const h = await harness();
  open.push(h);
  const svc = new KnowledgeService(h.store, { dir: join(h.dir, 'knowledge'), backupsDir: join(h.dir, 'backups'), limits: h.limits, now: () => h.clock.now });
  return { h, svc };
}

const ids = (g: GraphResponse) => g.nodes.map((n) => n.id).sort();
const labels = (g: GraphResponse, kind?: string) => g.nodes.filter((n) => !kind || n.kind === kind).map((n) => n.label).sort();
const edgeOf = (g: GraphResponse, a: string, b: string): GraphEdge | undefined => g.edges.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
const noteId = (v: string, p: string) => `note:${v}:${p}`;

/** A small vault: Home links to Alpha, Beta and a note that doesn't exist, embeds a picture and mentions a ticket. */
async function smallVault() {
  const h = await harness();
  open.push(h);
  const v = h.vault('v00000000001');
  v.writeNote('Home.md', '# Home\nSee [[Projects/Alpha]] and [[Beta]] and [[Nowhere]]. ![[pic.png]] #home\nWork: [[ticket:T-1]]\n', { actor: UI, create: true });
  v.writeNote('Projects/Alpha.md', 'Back to [[Home]] and [[Beta]] #proj/web\n', { actor: UI, create: true });
  v.writeNote('Beta.md', 'Links [[Alpha]]\n', { actor: UI, create: true });
  v.writeNote('Lonely.md', 'Nothing links here.\n', { actor: UI, create: true });
  outside(v, 'pic.png', makePng());
  await v.scan();
  const docs = (q: Partial<Parameters<typeof docsGraph>[0]['q']> = {}) => docsGraph({ vaultId: v.id, index: v.index, labels: 'filename', q: { lens: 'docs', ...q } });
  return { h, v, docs };
}

test('docs graph: notes and the links between them, one edge per pair with its weight', async () => {
  const { v, docs } = await smallVault();
  const g = docs();
  assert.deepEqual(labels(g), ['Alpha', 'Beta', 'Home', 'Lonely']);
  assert.equal(g.truncated, false);
  assert.equal(g.message, null);
  assert.deepEqual(g.totals, { nodes: 4, edges: 3 });
  const home = noteId(v.id, 'Home.md');
  const alpha = noteId(v.id, 'Projects/Alpha.md');
  const beta = noteId(v.id, 'Beta.md');
  // Home and Alpha link each other; Alpha and Beta too: weight 2. Home to Beta once.
  assert.equal(edgeOf(g, home, alpha)?.weight, 2);
  assert.equal(edgeOf(g, alpha, beta)?.weight, 2);
  assert.equal(edgeOf(g, home, beta)?.weight, 1);
  const n = (id: string) => g.nodes.find((x) => x.id === id)!;
  assert.deepEqual([n(home).degree, n(alpha).degree, n(beta).degree], [2, 2, 2]);
  assert.equal(n(alpha).group, 'Projects');
  assert.equal(n(home).group, '');
  assert.deepEqual([n(alpha).vault, n(alpha).path], [v.id, 'Projects/Alpha.md']);
  assert.equal(g.nodes.find((x) => x.label === 'Lonely')!.degree, 0);
});

test('docs graph: tags, unresolved names and attachments are drawn only when asked for', async () => {
  const { v, docs } = await smallVault();
  const g = docs({ tags: true, unresolved: true, attachments: true });
  assert.ok(g.nodes.some((n) => n.id === `tag:${v.id}:home` && n.kind === 'tag' && n.label === '#home'));
  assert.ok(g.nodes.some((n) => n.id === `tag:${v.id}:proj/web`));
  assert.deepEqual(labels(g, 'unresolved'), ['Nowhere']);
  assert.deepEqual(labels(g, 'attachment'), ['pic.png']);
  assert.equal(edgeOf(g, noteId(v.id, 'Home.md'), `attachment:${v.id}:pic.png`)?.kind, 'embeds');
  assert.equal(edgeOf(g, noteId(v.id, 'Home.md'), `tag:${v.id}:home`)?.kind, 'tagged');
  assert.equal(edgeOf(g, noteId(v.id, 'Home.md'), `unresolved:${v.id}:nowhere`)?.kind, 'links-to');
  // The portal things a note links to are not drawn in the docs graph.
  assert.ok(!g.nodes.some((n) => n.kind === 'ticket'));
  const plain = docs();
  assert.ok(!plain.nodes.some((n) => ['tag', 'unresolved', 'attachment'].includes(n.kind)));
  // Every edge ends at nodes that are drawn.
  const have = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges) assert.ok(have.has(e.from) && have.has(e.to));
});

test('docs graph: folder and tag filters (a tag includes its sub-tags), and leaving out notes nothing links to', async () => {
  const { v, docs } = await smallVault();
  assert.deepEqual(labels(docs({ folder: 'Projects' })), ['Alpha']);
  assert.deepEqual(labels(docs({ folder: '/projects/' })), ['Alpha'], 'folders match without case or slashes');
  assert.deepEqual(labels(docs({ tag: 'proj' })), ['Alpha']);
  assert.deepEqual(labels(docs({ tag: '#home' })), ['Home']);
  assert.deepEqual(labels(docs({ hideOrphans: true })), ['Alpha', 'Beta', 'Home']);
  // A tag drawn gives a note a link, so it is no longer an orphan.
  assert.ok(docs({ hideOrphans: true, tags: true }).nodes.every((n) => n.label !== 'Lonely'));
  assert.equal(docs({ folder: 'Nope' }).nodes.length, 0);
  void v;
});

test('docs graph: a local graph is the nodes within a few steps of one note', async () => {
  const { v, docs } = await smallVault();
  const home = noteId(v.id, 'Home.md');
  const one = docs({ around: home, depth: 1 });
  assert.deepEqual(labels(one), ['Alpha', 'Beta', 'Home']);
  assert.equal(one.center, home);
  assert.deepEqual(labels(docs({ around: noteId(v.id, 'Lonely.md') })), ['Lonely']);
  assert.throws(() => docs({ around: noteId(v.id, 'Missing.md') }), reason('NOT_FOUND'));
  assert.throws(() => docs({ around: 'note:otherVault:Home.md' }), reason('NOT_FOUND'));
  // Around a tag draws tags and the notes that have it.
  const tag = docs({ around: `tag:${v.id}:home` });
  assert.deepEqual(labels(tag), ['#home', 'Home']);
  // Depth 2 from Lonely adds nothing; from Beta it reaches Home through Alpha.
  assert.deepEqual(labels(docs({ around: noteId(v.id, 'Beta.md'), depth: 2 })), ['Alpha', 'Beta', 'Home']);
  assert.deepEqual(labels(docs({ around: noteId(v.id, 'Beta.md'), depth: 99 })), ['Alpha', 'Beta', 'Home'], 'depth is limited');
});

test('docs graph: heading labels when the vault labels notes by heading', async () => {
  const { v } = await smallVault();
  const g = docsGraph({ vaultId: v.id, index: v.index, labels: 'heading', q: { lens: 'docs' } });
  assert.ok(g.nodes.some((n) => n.label === 'Home' && n.path === 'Home.md'));
  v.writeNote('Titled.md', '# A Fine Title\ntext\n', { actor: UI, create: true });
  const g2 = docsGraph({ vaultId: v.id, index: v.index, labels: 'heading', q: { lens: 'docs' } });
  assert.ok(g2.nodes.some((n) => n.label === 'A Fine Title' && n.path === 'Titled.md'));
});

/* ---------- Capping ---------- */

function bigGraph(n: number, folders = 6) {
  const b = new GraphBuilder();
  for (let i = 0; i < n; i++) b.node({ id: `note:v:f${i % folders}/n${i}.md`, kind: 'note', label: `n${i}`, group: `f${i % folders}`, href: null, vault: 'v', path: `f${i % folders}/n${i}.md` });
  const at = (i: number) => `note:v:f${i % folders}/n${i}.md`;
  // Ten hubs that link to everything after them, and a ring.
  for (let i = 0; i < n; i++) {
    b.link(at(i), at((i + 1) % n), 'links-to');
    for (let h = 0; h < 10; h++) if (i > h) b.link(at(h), at(i), 'links-to');
  }
  return { b, built: b.finish(), at };
}

test('cap: the most linked stay, the rest fold into one node per folder, and nothing is dropped silently', () => {
  const { built, at } = bigGraph(3000);
  const capped = capGraph(built.nodes, built.edges, { cap: 500, edgeCap: 2000, clusterOf: (n) => ({ key: n.group, label: n.group, group: n.group }) });
  assert.ok(capped.nodes.length <= 500, `nodes ${capped.nodes.length}`);
  assert.ok(capped.edges.length <= 2000);
  const clusters = capped.nodes.filter((n) => n.kind === 'cluster');
  assert.equal(clusters.length, 6, 'one per folder');
  const kept = capped.nodes.length - clusters.length;
  assert.equal(kept + clusters.reduce((s, c) => s + (c.count ?? 0), 0), 3000, 'every node is kept or counted in a cluster');
  assert.equal(capped.folded, 3000 - kept);
  for (let h = 0; h < 10; h++) assert.ok(capped.nodes.some((n) => n.id === at(h)), 'the hubs are kept');
  const have = new Set(capped.nodes.map((n) => n.id));
  const seen = new Set<string>();
  for (const e of capped.edges) {
    assert.ok(have.has(e.from) && have.has(e.to), 'edges end at nodes that are drawn');
    assert.notEqual(e.from, e.to);
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    assert.ok(!seen.has(key), 'one edge per pair');
    seen.add(key);
  }
  // A graph within the cap is returned as it is.
  const small = bigGraph(40);
  const same = capGraph(small.built.nodes, small.built.edges, { cap: 500, edgeCap: 2000 });
  assert.deepEqual([same.nodes.length, same.edges.length, same.folded, same.edgesCut], [40, small.built.edges.length, 0, 0]);
});

test('cap: a pinned node stays, many folders share one "other" cluster, and over the edge cap one edge per node survives', () => {
  const { built, at } = bigGraph(600, 200);
  const pin = at(599);
  const capped = capGraph(built.nodes, built.edges, { cap: 100, edgeCap: 150, pinned: new Set([pin]), clusterOf: (n) => ({ key: n.group, label: n.group, group: n.group }) });
  assert.ok(capped.nodes.some((n) => n.id === pin));
  assert.ok(capped.nodes.filter((n) => n.kind === 'cluster').length <= 48, 'at most 48 clusters');
  assert.ok(capped.nodes.some((n) => n.id === 'cluster:other'));
  assert.ok(capped.nodes.length <= 100);
  assert.ok(capped.edges.length <= 150);
  assert.ok(capped.edgesCut > 0);
  const touched = new Set(capped.edges.flatMap((e) => [e.from, e.to]));
  assert.ok(capped.nodes.length - touched.size <= capped.nodes.length * 0.5, 'most nodes keep an edge');
});

test('cap: the answer says what was folded and the totals are the whole graph', async () => {
  const h = await harness();
  open.push(h);
  const v = h.vault('v00000000002');
  for (let i = 0; i < 80; i++) v.writeNote(`F${i % 4}/n${i}.md`, `hub [[n0]] ${i > 0 ? `[[n${i - 1}]]` : ''}`, { actor: UI, create: true });
  await v.scan();
  const g = docsGraph({ vaultId: v.id, index: v.index, labels: 'filename', q: { lens: 'docs', cap: 50 } });
  assert.equal(g.truncated, true);
  assert.equal(g.totals.nodes, 80);
  assert.match(g.message ?? '', /^\d+ of 80, most linked/);
  assert.ok(g.nodes.length <= 50);
  assert.ok(g.nodes.some((n) => n.kind === 'cluster' && (n.count ?? 0) > 0));
  assert.ok(g.nodes.some((n) => n.label === 'n0'), 'the hub is kept');
});

test('neighbourhood: breadth first with a budget that keeps the most linked of the level that overflows', () => {
  const b = new GraphBuilder();
  for (const id of ['c', 'a', 'b', 'd', 'e', 'x']) b.node({ id, kind: 'note', label: id, group: '', href: null });
  b.link('c', 'a', 'links-to');
  b.link('c', 'b', 'links-to');
  b.link('a', 'd', 'links-to');
  b.link('d', 'e', 'links-to');
  b.link('b', 'e', 'links-to');
  b.link('b', 'x', 'links-to');
  b.link('x', 'a', 'links-to');
  const { nodes, edges } = b.finish();
  assert.deepEqual([...neighbourhood(nodes, edges, 'c', 1, 100).ids].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...neighbourhood(nodes, edges, 'c', 2, 100).ids].sort(), ['a', 'b', 'c', 'd', 'e', 'x']);
  const tight = neighbourhood(nodes, edges, 'c', 2, 4);
  assert.equal(tight.ids.size, 4);
  assert.equal(tight.complete, false);
  assert.ok(tight.ids.has('c') && tight.ids.has('a') && tight.ids.has('b'));
  assert.deepEqual([...neighbourhood(nodes, edges, 'c', 0, 100).ids], ['c']);
});

test('the time window: hours and days, bounded, anything else refused', () => {
  assert.equal(parseSince(undefined), 7 * 86_400_000);
  assert.equal(parseSince(undefined, 30), 30 * 86_400_000);
  assert.equal(parseSince('24h'), 24 * 3_600_000);
  assert.equal(parseSince('7d'), 7 * 86_400_000);
  assert.equal(parseSince('999d'), 365 * 86_400_000);
  for (const bad of ['x', '7', '-1d', '0d', '7 weeks', '1.5d']) assert.throws(() => parseSince(bad), reason('INVALID_INPUT'), bad);
});

/* ---------- Context ---------- */

const touch = (o: Partial<Parameters<typeof contextGraph>[0]['touches'][number]> & { path: string }) => ({ vaultId: 'v1', sourceKind: 'session' as const, sourceId: 's1', kind: 'read' as const, count: 1, lastAt: '2026-10-12T09:00:00.000Z', ...o });

test('context graph: who touched which note, the strongest touch on an edge, and the ticket a session works for', () => {
  const sessionInfo = { id: 's1', workspaceId: 'docker/dev', title: 'Fix login', state: 'running', claudeId: '', ticketId: 'T-7', parentId: null, startedBy: null, worktreePath: null, worktreeBranch: null, at: '2026-10-12T09:30:00.000Z' };
  const g = contextGraph({
    touches: [
      touch({ path: 'A.md', kind: 'read', count: 3 }),
      touch({ path: 'A.md', kind: 'edited', count: 1, lastAt: '2026-10-12T09:10:00.000Z' }),
      touch({ path: 'Folder/B.md', kind: 'created' }),
      touch({ path: 'A.md', sourceKind: 'token', sourceId: 't1', kind: 'read', count: 2 }),
      touch({ path: 'A.md', sourceKind: 'user', sourceId: 'ui', kind: 'edited' }),
      touch({ path: 'Gone.md', sourceKind: 'session', sourceId: 'old-alias', kind: 'deleted' }),
    ],
    // The alias of a session that was folded into s1 finds it.
    sessions: new Map([
      ['s1', sessionInfo],
      ['old-alias', sessionInfo],
    ]),
    tickets: new Map([['T-7', { id: 'T-7', summary: 'Login is broken', status: 'in_progress', assigneeKind: 'session', assigneeRef: 's1', workspaceId: null, worktreeBranch: null, at: '2026-10-12T08:00:00.000Z' }]]),
    tokens: new Map([['t1', 'My laptop']]),
    exists: (_v, p) => p !== 'Gone.md',
    q: { lens: 'context' },
  });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const s = byId.get('session:s1')!;
  assert.deepEqual([s.kind, s.label, s.state, s.href], ['session', 'Fix login', 'running', '/admin/sessions/s1']);
  assert.ok(!byId.has('session:old-alias'), 'an alias is the session it became');
  assert.equal(byId.get('ticket:T-7')?.label, 'T-7 Login is broken');
  assert.equal(edgeOf(g, 'session:s1', 'ticket:T-7')?.kind, 'works-in');
  const a = noteId('v1', 'A.md');
  const toA = edgeOf(g, 'session:s1', a)!;
  assert.deepEqual([toA.kind, toA.weight], ['edited', 4], 'the strongest kind, the touches added');
  assert.equal(toA.at, '2026-10-12T09:10:00.000Z');
  assert.equal(edgeOf(g, 'actor:token:t1', a)?.kind, 'read');
  assert.equal(byId.get('actor:token:t1')?.label, 'My laptop');
  assert.equal(byId.get('actor:user:ui')?.label, 'You');
  assert.equal(edgeOf(g, 'session:s1', noteId('v1', 'Folder/B.md'))?.kind, 'created');
  assert.equal(edgeOf(g, 'session:s1', noteId('v1', 'Gone.md'))?.kind, 'deleted');
  assert.equal(byId.get(noteId('v1', 'Gone.md'))?.state, 'gone');
  assert.equal(byId.get(a)?.state, null);
  assert.equal(byId.get(noteId('v1', 'Folder/B.md'))?.group, 'Folder');
});

test('context graph: a session that is gone is still drawn, with a short id; a local graph with nothing is empty, not an error', () => {
  const base = { sessions: new Map(), tickets: new Map(), tokens: new Map(), exists: () => true };
  const g = contextGraph({ ...base, touches: [touch({ path: 'A.md', sourceId: 'abcdef0123456789' })], q: { lens: 'context' } });
  const s = g.nodes.find((n) => n.kind === 'session')!;
  assert.deepEqual([s.label, s.state, s.href], ['Session abcdef01', 'gone', null]);
  const none = contextGraph({ ...base, touches: [], q: { lens: 'context', around: noteId('v1', 'Nothing.md') } });
  assert.deepEqual([none.nodes.length, none.edges.length, none.center], [0, 0, null]);
  const around = contextGraph({ ...base, touches: [touch({ path: 'A.md' }), touch({ path: 'B.md', sourceId: 's2' })], q: { lens: 'context', around: 'session:s1' } });
  assert.deepEqual(ids(around), ['note:v1:A.md', 'session:s1']);
});

/* ---------- The portal's own tables ---------- */

const NOW = '2026-10-12T09:00:00.000Z';

function seed(db: DatabaseSync) {
  const session = db.prepare("INSERT INTO chat_sessions (id, workspace_id, title, state, claude_id, ticket_id, parent_id, worktree_branch, state_since, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  session.run('s-1', 'docker/dev', 'Fix login', 'running', 'cl-1', 'T-1', null, 'fix-login', NOW, NOW, NOW);
  session.run('s-2', 'docker/dev', 'Child task', 'idle', 'cl-1', null, 's-1', null, NOW, NOW, NOW);
  session.run('s-old', 'docker/other', 'Old one', 'ended', '', null, null, null, NOW, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z');
  db.prepare("INSERT INTO chat_session_aliases (alias_id, session_id) VALUES ('s-1-before', 's-1')").run();
  db.prepare("INSERT INTO workspace_claudes (id, workspace_id, name, created_at) VALUES ('cl-1', 'docker/dev', 'Main', ?)").run(NOW);
  db.prepare("INSERT INTO workspace_claudes (id, workspace_id, name, created_at) VALUES ('cl-idle', 'docker/dev', 'Spare', ?)").run(NOW);
  const ticket = db.prepare("INSERT INTO tickets (type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, assignee_kind, assignee_ref, workspace_id, worktree_branch, created_at, updated_at) VALUES ('task', 'normal', 2, ?, ?, 'human', 'ui', 'Admin', ?, ?, ?, ?, ?, ?)");
  ticket.run('in_progress', 'Login is broken', 'session', 's-1', 'docker/dev', 'fix-login', NOW, NOW);
  ticket.run('open', 'Write the docs', null, null, null, null, NOW, NOW);
  const pool = db.prepare("INSERT INTO pools (id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  pool.run('p-per', 'persona', 'Reviewer', NOW, NOW);
  pool.run('p-sec', 'secrets', 'Keys', NOW, NOW);
  const assign = db.prepare("INSERT INTO assignments (workspace_id, pool_id, pool_type, assigned_at) VALUES (?, ?, ?, ?)");
  assign.run('docker/dev', 'p-per', 'persona', NOW);
  assign.run('docker/dev', 'p-sec', 'secrets', NOW);
}

const kindsOf = (g: GraphResponse) => Object.fromEntries([...new Set(g.nodes.map((n) => n.kind))].map((k) => [k, g.nodes.filter((n) => n.kind === k).length]));

test('agentic graph: workspaces, sessions, tickets, Claudes, worktrees and pools with how they relate; secrets are not drawn', async () => {
  const { h, svc } = await make();
  seed(h.store.db!);
  const g = svc.graph({ lens: 'agentic' }, UI);
  assert.deepEqual(kindsOf(g), { session: 2, ticket: 2, workspace: 1, claude: 1, worktree: 1, persona: 1 });
  const has = (a: string, b: string, kind: string) => assert.equal(edgeOf(g, a, b)?.kind, kind, `${a} - ${b}`);
  has('session:s-1', 'workspace:docker/dev', 'runs-in');
  has('session:s-1', 'claude:cl-1', 'runs-as');
  has('session:s-2', 'session:s-1', 'spawned-by');
  has('session:s-1', 'worktree:docker/dev:fix-login', 'works-in');
  has('worktree:docker/dev:fix-login', 'workspace:docker/dev', 'belongs-to');
  has('claude:cl-1', 'workspace:docker/dev', 'belongs-to');
  has('workspace:docker/dev', 'persona:p-per', 'uses');
  const t1 = g.nodes.find((n) => n.id === 'ticket:T-1')!;
  assert.deepEqual([t1.label, t1.state, t1.href], ['T-1 Login is broken', 'in_progress', '/admin/tickets/T-1']);
  // A ticket assigned to a session and a session working on that ticket is one edge.
  assert.equal(g.edges.filter((e) => [e.from, e.to].sort().join() === ['session:s-1', 'ticket:T-1'].sort().join()).length, 1);
  assert.ok(!g.nodes.some((n) => n.label === 'Keys'), 'secret pools are not drawn');
  assert.ok(!g.nodes.some((n) => n.id === 'claude:cl-idle'), 'a Claude nothing runs as is not drawn');
  assert.ok(!g.nodes.some((n) => n.id === 'session:s-old'), 'a session outside the window is left out');
  const wide = svc.graph({ lens: 'agentic', since: '365d' }, UI);
  assert.ok(wide.nodes.some((n) => n.id === 'session:s-old'), 'a wider window draws older sessions');
  assert.ok(wide.nodes.some((n) => n.id === 'workspace:docker/other'));
  const only = svc.graph({ lens: 'agentic', kinds: ['session', 'ticket'] }, UI);
  assert.deepEqual(Object.keys(kindsOf(only)).sort(), ['session', 'ticket']);
  assert.ok(only.edges.every((e) => e.from.split(':')[0] !== 'workspace' && e.to.split(':')[0] !== 'workspace'));
});

test('agentic graph: notes appear when they mention something that is drawn, by id, old id, name or number', async () => {
  const { h, svc } = await make();
  seed(h.store.db!);
  const vault = svc.create({ name: 'Brain' });
  const v = svc.vault(vault.id);
  v.writeNote('Plan.md', 'For [[ticket:T-1]] and [[session:s-1-before]] and [[workspace:docker/dev]] and [[persona:reviewer]] and [[claude:Main]] and [[ticket:T-99]] and [[mcp:nothing]].\n', { actor: UI, create: true });
  h.store.db!
    .prepare("INSERT INTO tickets (type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at, closed_at) VALUES ('task', 'low', 3, 'done', 'Long closed', 'human', 'ui', 'Admin', '2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z', '2024-01-02T00:00:00.000Z')")
    .run();
  v.writeNote('Other.md', 'Only [[ticket:T-3]] (closed long ago).\n', { actor: UI, create: true });
  v.writeNote('Quiet.md', 'Mentions [[session:never-existed]] and nothing else.\n', { actor: UI, create: true });
  const g = svc.graph({ lens: 'agentic' }, UI);
  const plan = noteId(vault.id, 'Plan.md');
  for (const target of ['ticket:T-1', 'session:s-1', 'workspace:docker/dev', 'persona:p-per', 'claude:cl-1']) assert.equal(edgeOf(g, plan, target)?.kind, 'mentions', target);
  assert.equal(edgeOf(g, noteId(vault.id, 'Other.md'), 'ticket:T-3')?.kind, 'mentions', 'a ticket outside the recent ones is found by its number');
  assert.ok(!g.nodes.some((n) => n.path === 'Quiet.md'), 'a note that mentions nothing drawn is not drawn');
  assert.equal(g.edges.filter((e) => e.from === plan || e.to === plan).length, 5);
  // The kinds filter can leave the notes out; the vault filter limits where notes come from.
  assert.ok(!svc.graph({ lens: 'agentic', kinds: ['session'] }, UI).nodes.some((n) => n.kind === 'note'));
  const other = svc.create({ name: 'Other brain' });
  assert.ok(!svc.graph({ lens: 'agentic', vault: other.id }, UI).nodes.some((n) => n.kind === 'note'));
});

test('agentic graph: local graph around a session', async () => {
  const { h, svc } = await make();
  seed(h.store.db!);
  const g = svc.graph({ lens: 'agentic', around: 'session:s-2', depth: 1 }, UI);
  assert.deepEqual(ids(g), ['claude:cl-1', 'session:s-1', 'session:s-2', 'workspace:docker/dev']);
  assert.equal(g.center, 'session:s-2');
  assert.deepEqual(svc.graph({ lens: 'agentic', around: 'session:not-there' }, UI).nodes, []);
});

test('the directory reads what is there and nothing else: no tables, or fewer columns, is "none", not an error', () => {
  const bare = new DatabaseSync(':memory:');
  const none = new Directory(() => bare);
  assert.deepEqual(none.recentSessions(10, null), []);
  assert.deepEqual(none.recentTickets(10, NOW), []);
  assert.deepEqual(none.claudes(), []);
  assert.deepEqual(none.poolUses(null), []);
  assert.equal(none.sessionsByIds(['a']).size, 0);
  assert.equal(none.ticketsByIds(['T-1']).size, 0);
  assert.equal(none.tokenLabels(['x']).size, 0);
  assert.deepEqual(new Directory(() => null).recentSessions(1, null), [], 'a frozen portal has no database to read');
  // Sessions from before the columns of tickets and worktrees existed.
  bare.exec("CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT, state TEXT, last_activity_at TEXT, archived_at TEXT); INSERT INTO chat_sessions VALUES ('old', 'docker/x', 'Old', 'idle', '2026-10-01T00:00:00Z', NULL)");
  const basic = new Directory(() => bare).recentSessions(10, null);
  assert.deepEqual(basic.map((s) => [s.id, s.title, s.ticketId, s.claudeId]), [['old', 'Old', null, '']]);
  // A real error is not swallowed.
  bare.exec('CREATE TABLE workspace_claudes (other TEXT)');
  assert.deepEqual(none.claudes(), [], 'missing columns count as missing');
  const bad = { prepare: () => { throw new Error('disk I/O error'); } } as unknown as DatabaseSync;
  assert.throws(() => new Directory(() => bad).claudes(), /disk I\/O/);
});

test('the directory: aliases find the session a chat became, tickets by number, tokens by id', async () => {
  const h = await harness();
  open.push(h);
  seed(h.store.db!);
  h.store.db!
    .prepare("INSERT INTO pmcp_tokens (id, label, token_hash, last4, scope, created_at, expires_at) VALUES ('tok-1', 'My laptop', 'h', '1234', 'read', ?, ?)")
    .run(NOW, '2027-01-01T00:00:00.000Z');
  const dir = new Directory(() => h.store.db);
  const s = dir.sessionsByIds(['s-1-before', 's-2', 'ghost']);
  assert.deepEqual([...s.keys()].sort(), ['s-1-before', 's-2']);
  assert.equal(s.get('s-1-before')?.id, 's-1');
  assert.deepEqual([...dir.ticketsByIds(['T-1', 't-2', 'junk', 'T-99']).keys()].sort(), ['T-1', 'T-2']);
  assert.equal(dir.tokenLabels(['tok-1', 'nope']).get('tok-1'), 'My laptop');
  assert.deepEqual(dir.recentSessions(10, '2026-09-01T00:00:00Z').map((x) => x.id).sort(), ['s-1', 's-2']);
});

/* ---------- Through the service ---------- */

test('service: the docs graph of a vault, policy for agents, and the lenses agents may use', async () => {
  const { svc } = await make();
  const vault = svc.create({ name: 'Brain' });
  const v = svc.vault(vault.id);
  v.writeNote('A.md', '[[B]]', { actor: UI, create: true });
  v.writeNote('B.md', '', { actor: UI, create: true });
  const session = parseActor('session:s-9');
  assert.equal(svc.graph({ lens: 'docs', vault: vault.id }, UI).nodes.length, 2);
  assert.equal(svc.graph({ lens: 'docs' }, UI).nodes.length, 2, 'the only vault needs no name');
  assert.equal(svc.graph({ lens: 'docs', vault: 'brain' }, session).nodes.length, 2, 'by name, as an agent');
  assert.throws(() => svc.graph({ lens: 'context' }, session), reason('NOT_ALLOWED_BY_POLICY'));
  assert.throws(() => svc.graph({ lens: 'agentic' }, parseActor('ticket:T-1')), reason('NOT_ALLOWED_BY_POLICY'));
  assert.equal(svc.graph({ lens: 'context' }, parseActor('portal-mcp:tok-1')).nodes.length, 0, 'the admin’s own Claude may');
  svc.update(vault.id, { agents: 'off' });
  assert.throws(() => svc.graph({ lens: 'docs', vault: vault.id }, session), reason('VAULT_UNAVAILABLE'));
  assert.equal(svc.graph({ lens: 'docs', vault: vault.id }, UI).nodes.length, 2, 'people still see it');
  assert.throws(() => svc.graph({ lens: 'docs', vault: vault.id }, UI, { vaults: ['someone-else'] }), reason('NOT_FOUND'));
  assert.throws(() => svc.graph({ lens: 'weird' as never }, UI), reason('INVALID_INPUT'));
  assert.throws(() => svc.graph({ lens: 'docs' }, UI, { vaults: [] }), reason('INVALID_INPUT'));
});

test('service: what agents write shows in the context graph with the session and its ticket; reads only on request', async () => {
  const { h, svc } = await make();
  seed(h.store.db!);
  const vault = svc.create({ name: 'Brain' });
  svc.vault(vault.id).writeNote('Spec.md', 'the spec', { actor: UI, create: true });
  const s1 = parseActor('session:s-1');
  svc.putNote(vault.id, 'Findings.md', { content: 'found it', create: true }, s1);
  svc.getNote(vault.id, 'Spec.md', s1);
  svc.getNote(vault.id, 'Spec.md', parseActor('session:s-2'));
  svc.getNote(vault.id, 'Spec.md', UI);
  const g = svc.graph({ lens: 'context', vault: vault.id }, UI);
  const spec = noteId(vault.id, 'Spec.md');
  const findings = noteId(vault.id, 'Findings.md');
  assert.equal(edgeOf(g, 'session:s-1', findings)?.kind, 'created');
  assert.equal(edgeOf(g, 'session:s-1', spec)?.kind, 'read');
  assert.equal(edgeOf(g, 'session:s-2', spec)?.kind, 'read');
  assert.equal(edgeOf(g, 'session:s-1', 'ticket:T-1')?.kind, 'works-in', 'the ticket the session works for');
  assert.equal(g.nodes.find((n) => n.id === 'session:s-1')?.label, 'Fix login');
  // A person's read leaves nothing; a person's write is theirs.
  assert.ok(!g.nodes.some((n) => n.id === 'actor:user:ui' && g.edges.some((e) => e.from === n.id && e.to === spec)));
  // Only writes, only reads.
  const writes = svc.graph({ lens: 'context', vault: vault.id, access: 'write' }, UI);
  assert.deepEqual(ids(writes), ['note:' + vault.id + ':Findings.md', 'session:s-1', 'ticket:T-1'].sort());
  const reads = svc.graph({ lens: 'context', vault: vault.id, access: 'read' }, UI);
  assert.ok(reads.nodes.some((n) => n.id === 'session:s-2'));
  assert.ok(!reads.nodes.some((n) => n.id === findings));
  // Around a note: who used it.
  const around = svc.graph({ lens: 'context', around: spec }, UI);
  assert.deepEqual(ids(around), [spec, 'session:s-1', 'session:s-2'].sort());
  // A time window that excludes it all.
  h.clock.now = new Date('2026-12-30T00:00:00.000Z');
  assert.equal(svc.graph({ lens: 'context', since: '24h' }, UI).nodes.length, 0);
  assert.equal(svc.graph({ lens: 'context', since: '90d' }, UI).nodes.length > 0, true);
  // A note deleted since is drawn as gone.
  h.clock.now = new Date('2026-10-12T09:00:00.000Z');
  await svc.deleteNote(vault.id, 'Findings.md', UI);
  const after = svc.graph({ lens: 'context', vault: vault.id }, UI);
  assert.equal(after.nodes.find((n) => n.id === findings)?.state, 'gone');
});

test('service: a token limited to some vaults sees only those in the context graph', async () => {
  const { svc } = await make();
  const a = svc.create({ name: 'Alpha vault' });
  const b = svc.create({ name: 'Beta vault' });
  svc.putNote(a.id, 'One.md', { content: 'x', create: true }, parseActor('portal-mcp:t1'));
  svc.putNote(b.id, 'Two.md', { content: 'x', create: true }, parseActor('portal-mcp:t1'));
  const all = svc.graph({ lens: 'context' }, parseActor('portal-mcp:t1'));
  assert.deepEqual(all.nodes.filter((n) => n.kind === 'note').map((n) => n.label).sort(), ['One', 'Two']);
  const limited = svc.graph({ lens: 'context' }, parseActor('portal-mcp:t1'), { vaults: [a.id] });
  assert.deepEqual(limited.nodes.filter((n) => n.kind === 'note').map((n) => n.label), ['One']);
  assert.throws(() => svc.graph({ lens: 'context', vault: b.id }, parseActor('portal-mcp:t1'), { vaults: [a.id] }), reason('NOT_FOUND'));
});

test('service: the graphs of a portal whose database lacks the knowledge tables are empty, not a crash', async () => {
  const h = await harness();
  open.push(h);
  h.store.db!.exec('DROP TABLE kg_edges; DROP TABLE kg_versions; DROP TABLE kg_audit; DROP TABLE kg_vaults');
  const svc = new KnowledgeService(h.store, { dir: join(h.dir, 'knowledge'), limits: h.limits });
  assert.throws(() => svc.graph({ lens: 'docs' }, UI), reason('UNAVAILABLE'));
  assert.equal(svc.graph({ lens: 'context' }, UI).nodes.length, 0);
  assert.equal(svc.graph({ lens: 'agentic' }, UI).nodes.length >= 0, true);
});

test('agentic: mentions and many things keep to the cap', () => {
  const mentions: Mention[] = [];
  const sessions = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, workspaceId: `docker/w${i % 5}`, title: `S${i}`, state: 'idle', claudeId: '', ticketId: null, parentId: i > 0 ? 's0' : null, startedBy: null, worktreePath: null, worktreeBranch: null, at: NOW }));
  const g: GraphResponse = agenticGraph({ sessions, known: new Map(), tickets: [], claudes: [], pools: [], mentions, q: { lens: 'agentic', cap: 60 } });
  assert.ok(g.nodes.length <= 60);
  assert.equal(g.truncated, true);
  assert.equal(g.totals.nodes, 205);
  assert.ok(g.nodes.some((n: GraphNode) => n.id === 'session:s0'), 'the parent of the rest is the most linked');
});

test('service: a whole-vault graph is answered once until the vault changes', async () => {
  const { svc } = await make();
  const vault = svc.create({ name: 'Brain' });
  const v = svc.vault(vault.id);
  v.writeNote('A.md', '[[B]]', { actor: UI, create: true });
  v.writeNote('B.md', '', { actor: UI, create: true });
  const first = svc.graph({ lens: 'docs', vault: vault.id }, UI);
  assert.equal(svc.graph({ lens: 'docs', vault: vault.id }, UI), first, 'same question, same index: the same answer');
  assert.notEqual(svc.graph({ lens: 'docs', vault: vault.id, tags: true }, UI), first, 'another question is its own answer');
  assert.equal(svc.graph({ lens: 'docs', vault: vault.id, around: noteId(vault.id, 'A.md') }, UI).nodes.length, 2);
  v.writeNote('C.md', '[[A]]', { actor: UI, create: true });
  const second = svc.graph({ lens: 'docs', vault: vault.id }, UI);
  assert.notEqual(second, first);
  assert.equal(second.nodes.length, 3);
  assert.equal(first.nodes.length, 2, 'an answer already given is not changed');
  // Renaming the vault's label style changes what the answer says.
  svc.update(vault.id, { settings: { labels: 'heading' } });
  v.writeNote('Titled.md', '# Fine Title\n', { actor: UI, create: true });
  assert.ok(svc.graph({ lens: 'docs', vault: vault.id }, UI).nodes.some((n) => n.label === 'Fine Title'));
});
