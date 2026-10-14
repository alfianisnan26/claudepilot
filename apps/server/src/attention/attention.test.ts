import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { ATTENTION_TOOL_WAIT_MS, objectRef, sessionRef, ticketRef, type Actor, type AttentionKind, type AttentionList, type ObjectType } from '@portal/contracts';
import { clearResolvers, ownerActor, policyFor, registerResolver } from '../authz/seam.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { createAttention, createAttentionRoutes, type AttentionChanged } from './index.js';
import { attentionOrder } from './registry.js';

// Needs you (docs/prd/attention.md): each source lists what waits through its module's own can(), counts what it lists, drops what was
// decided, and the registry emits one event per change; the aggregate reads each source with one query.

const MIN = 60_000;
// Times are relative to the real clock: nothing here depends on a fixed date.
const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
const user = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'test', via: 'ui' });

let store: Store;
let db: DatabaseSync;
before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-t146-'), secretKey: null });
  db = store.db!;
});
after(() => store.close());
afterEach(() => {
  clearResolvers();
  for (const t of ['chat_requests', 'chat_sessions', 'mcp_catalog_versions', 'mcp_catalog', 'skill_reviews', 'skill_proposals', 'skill_versions', 'skill_sources', 'ci_deployments', 'ci_runs', 'tickets'])
    db.exec(`DELETE FROM ${t}`);
});

/* ---------- Fixtures: rows as each module writes them ---------- */

function chatSession(id: string, state = 'idle', title = `Session ${id}`) {
  db.prepare('INSERT INTO chat_sessions (id, workspace_id, title, state, state_since, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'docker/dev', title, state, ago(MIN), ago(MIN), ago(MIN));
}
function toolRequest(session: string, id: string, minutesAgo: number, answered = false) {
  db.prepare('INSERT INTO chat_requests (session_id, request_id, kind, tool_name, title, detail, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    session,
    id,
    'tool',
    'Bash',
    'Run a command',
    'ls',
    ago(minutesAgo * MIN),
    answered ? ago(0) : null,
  );
}
function mcpProposal(entry: string, version: string, opts: { by?: string | null; state?: string; url?: string; slots?: unknown[] } = {}) {
  if (!db.prepare('SELECT 1 FROM mcp_catalog WHERE id = ?').get(entry))
    db.prepare('INSERT INTO mcp_catalog (id, key, display_name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(entry, entry, `Entry ${entry}`, 'remote', ago(MIN), ago(MIN));
  db.prepare('INSERT INTO mcp_catalog_versions (id, entry_id, version, spec, slots, review_state, proposed_by, proposed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    version,
    entry,
    'v1',
    JSON.stringify({ url: opts.url ?? 'https://mcp.example.com/sse', allowPrivateNetwork: false }),
    JSON.stringify(opts.slots ?? [{ name: 'API_TOKEN', target: 'env', secret: true, required: true }]),
    opts.state ?? 'draft',
    opts.by === undefined ? 'session:s1' : opts.by,
    ago(5 * MIN),
    ago(5 * MIN),
    ago(5 * MIN),
  );
}
function skillVersion(id: string, hash: string, opts: { proposedBy?: string } = {}) {
  if (!db.prepare('SELECT 1 FROM skill_sources WHERE id = ?').get('src1')) db.prepare('INSERT INTO skill_sources (id, kind, label, created_at) VALUES (?, ?, ?, ?)').run('src1', 'upload', 'kit.zip', ago(MIN));
  db.prepare('INSERT INTO skill_versions (id, source_id, name, path_in_source, tree_hash, size_bytes, file_count, scripted, risk, findings, details, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'src1',
    `skill-${id}`,
    id,
    hash,
    100,
    2,
    1,
    'medium',
    JSON.stringify([{ id: 'f1' }]),
    JSON.stringify({ network: true }),
    ago(20 * MIN),
  );
  if (opts.proposedBy) db.prepare('INSERT INTO skill_proposals (version_id, actor, reason, proposed_at) VALUES (?, ?, ?, ?)').run(id, opts.proposedBy, 'needed', ago(15 * MIN));
}
function review(hash: string, decision = 'approved') {
  db.prepare('INSERT INTO skill_reviews (tree_hash, decision, at) VALUES (?, ?, ?)').run(hash, decision, ago(0));
}
let runNumber = 0;
function deploy(run: string, opts: { approval?: string; status?: string } = {}) {
  db.prepare(
    'INSERT INTO ci_runs (id, number, workspace_id, repo_id, repo, pipeline, trigger, ref, branch, sha, status, actor, state, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    run,
    ++runNumber,
    'docker/dev',
    'repo1',
    'portal',
    'deploy',
    'manual',
    'refs/heads/main',
    'main',
    'abcdef1234567890',
    opts.status ?? 'running',
    'ui',
    JSON.stringify({ jobs: [{ id: 'gate', status: 'passed' }, { id: 'release', status: 'waiting' }] }),
    's1',
    ago(30 * MIN),
  );
  db.prepare('INSERT INTO ci_deployments (id, run_id, run_number, job, repo_id, environment, pipeline, sha, ref, actor, approval, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    `dep-${run}`,
    run,
    runNumber,
    'release',
    'repo1',
    'production',
    'deploy',
    'abcdef1234567890',
    'refs/heads/main',
    'ui',
    opts.approval ?? 'waiting',
    ago(25 * MIN),
  );
}
function ticket(opts: { type?: string; assignee?: 'user' | 'session' | null; status?: string } = {}): string {
  const assignee = opts.assignee === undefined ? 'user' : opts.assignee;
  const r = db
    .prepare(
      `INSERT INTO tickets (type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, assignee_kind, assignee_ref, workspace_id, created_at, updated_at, closed_at)
       VALUES (?, 'high', 1, ?, 'May the agent rotate the key?', 'agent', 'token', 'orchestrator', ?, ?, 'docker/dev', ?, ?, ?)`,
    )
    .run(opts.type ?? 'approval', opts.status ?? 'open', assignee, assignee ? (assignee === 'user' ? 'Admin' : 's1') : null, ago(40 * MIN), ago(40 * MIN), opts.status === 'done' ? ago(0) : null);
  return `T-${r.lastInsertRowid}`;
}

const registry = () => createAttention(store, { now: () => now, tickMs: 0, debounceMs: 1 });
const ids = (l: AttentionList, kind: AttentionKind) => l.items.filter((i) => i.kind === kind).map((i) => i.id);
/** Owner `u_a` for the ids listed, `u_b` for every other: what user A may decide. */
const ownedByA = (type: ObjectType, mine: string[]) =>
  registerResolver({ type, resolve: (id) => ({ ref: objectRef(type, id), owner: { kind: 'user', id: mine.includes(id) ? 'u_a' : 'u_b' } }) });

/* ---------- Per source ---------- */

test('MCP: a proposed draft waits; the count is the list; another user does not see it; approving it resolves it with one event', () => {
  chatSession('s1', 'idle', 'Kit importer');
  mcpProposal('e1', 'v-a');
  mcpProposal('e2', 'v-b');
  mcpProposal('e3', 'v-manual', { by: null }); // a person's own draft: not waiting on them
  mcpProposal('e4', 'v-ok', { state: 'approved' });
  const r = registry();
  const all = r.list(ownerActor());
  assert.deepEqual(ids(all, 'mcp_version').sort(), ['v-a', 'v-b']);
  assert.equal(all.counts.mcp_version, 2);
  const item = all.items.find((i) => i.id === 'v-a')!;
  assert.equal(item.why, 'third_party_code');
  assert.equal(item.risk, 'remote · mcp.example.com · private network no · secrets: API_TOKEN');
  assert.deepEqual(item.who, [{ label: 'Kit importer', link: '/admin/sessions/s1' }]);
  assert.equal(item.link, '/admin/pools/mcp/catalog/e1?version=v-a');
  assert.equal(item.action.path, '/api/mcp/catalog/e1/versions/v-a/approve');

  ownedByA('mcp_entry', ['e1']);
  const a = r.list(user('u_a'));
  assert.deepEqual(ids(a, 'mcp_version'), ['v-a']);
  assert.equal(a.counts.mcp_version, 1, 'a denial is not counted either');

  clearResolvers();
  const events: AttentionChanged[] = [];
  r.onChange((e) => events.push(e));
  r.check();
  db.prepare("UPDATE mcp_catalog_versions SET review_state = 'approved' WHERE id = 'v-a'").run();
  r.check();
  r.check();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.resolved, [{ kind: 'mcp_version', id: 'v-a' }]);
  assert.deepEqual(events[0]!.added, []);
  assert.deepEqual(ids(r.list(ownerActor()), 'mcp_version'), ['v-b']);
});

test('MCP: no secret value ever reaches an item, only slot names', () => {
  const marker = ['sk', 'live', 'x'.repeat(8)].join('_');
  mcpProposal('e1', 'v-a', { slots: [{ name: 'KEY', target: 'env', secret: true, required: true, default: marker }] });
  const json = JSON.stringify(registry().list(ownerActor()));
  assert.ok(!json.includes(marker));
  assert.match(json, /secrets: KEY/);
});

test('skills: an undecided version waits (an agent proposal says who); any decision resolves it; another user does not see it', () => {
  chatSession('s2', 'idle', 'Skill writer');
  skillVersion('sv1', 'h1', { proposedBy: 'session:s2' });
  skillVersion('sv2', 'h2');
  skillVersion('sv3', 'h3');
  review('h3', 'rejected');
  const r = registry();
  const all = r.list(ownerActor());
  assert.deepEqual(ids(all, 'skill_version').sort(), ['sv1', 'sv2']);
  assert.equal(all.counts.skill_version, 2);
  const proposed = all.items.find((i) => i.id === 'sv1')!;
  assert.deepEqual(proposed.who, [{ label: 'Skill writer', link: '/admin/sessions/s2' }]);
  assert.equal(proposed.risk, 'medium risk · scripts · network · 1 finding');
  assert.equal(all.items.find((i) => i.id === 'sv2')!.who[0]!.label, 'kit.zip');
  assert.equal(proposed.link, '/admin/pools/skills/review/sv1');

  ownedByA('skill_version', ['sv2']);
  assert.deepEqual(ids(r.list(user('u_a')), 'skill_version'), ['sv2']);
  clearResolvers();

  const events: AttentionChanged[] = [];
  r.onChange((e) => events.push(e));
  r.check();
  review('h1');
  r.check();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.resolved, [{ kind: 'skill_version', id: 'sv1' }]);
});

test('CI: a waiting deployment of a running run waits for a person; tokens and agents never see it; the decision resolves it', () => {
  chatSession('s1', 'idle', 'Deployer');
  deploy('R1');
  deploy('R2', { approval: 'approved' });
  deploy('R3', { status: 'cancelled' });
  const r = registry();
  const all = r.list(ownerActor());
  assert.deepEqual(ids(all, 'ci_deploy'), ['dep-R1']);
  const item = all.items[0]!;
  assert.equal(item.why, 'production_uat');
  assert.match(item.title, /^portal #\d+: release to production$/);
  assert.equal(item.risk, 'production · gate passed · deploy main@abcdef1');
  assert.equal(item.link, '/admin/ci/runs/R1?job=release');
  assert.deepEqual(item.who[0], { label: 'Deployer', link: '/admin/sessions/s1' });

  assert.equal(r.list({ kind: 'token', userId: 'u_owner', tokenId: 't', scope: 'admin' }).counts.ci_deploy, 0);
  assert.equal(r.list({ kind: 'agent', userId: 'u_owner', tokenId: 't', sessionId: 's1', workspaceId: 'docker/dev' }).counts.ci_deploy, 0);
  ownedByA('ci_run', []);
  assert.equal(r.list(user('u_a')).counts.ci_deploy, 0);
  clearResolvers();

  const events: AttentionChanged[] = [];
  r.onChange((e) => events.push(e));
  r.check();
  db.prepare("UPDATE ci_deployments SET approval = 'approved' WHERE id = 'dep-R1'").run();
  r.check();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.resolved, [{ kind: 'ci_deploy', id: 'dep-R1' }]);
});

test('tickets: an open approval assigned to a person waits; other types, agents\' and closed ones do not', () => {
  const t1 = ticket();
  ticket({ type: 'question' });
  ticket({ assignee: 'session' });
  ticket({ assignee: null });
  ticket({ status: 'done' });
  const r = registry();
  const all = r.list(ownerActor());
  assert.deepEqual(ids(all, 'ticket_approval'), [t1]);
  assert.equal(all.items[0]!.why, 'question');
  assert.equal(all.items[0]!.link, `/admin/tickets/${t1}`);
  assert.equal(all.items[0]!.risk, 'high priority · docker/dev');

  registerResolver({ type: 'ticket', resolve: (id) => ({ ref: ticketRef(id), owner: { kind: 'user', id: 'u_b' } }) });
  assert.equal(r.list(user('u_a')).counts.ticket_approval, 0);
  clearResolvers();

  const events: AttentionChanged[] = [];
  r.onChange((e) => events.push(e));
  r.check();
  db.prepare("UPDATE tickets SET status = 'done', closed_at = ? WHERE number = ?").run(ago(0), Number(t1.slice(2)));
  r.check();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.resolved, [{ kind: 'ticket_approval', id: t1 }]);
});

test('tool approvals: listed only after ten minutes of a session whose live process waits on it; answering resolves it', () => {
  chatSession('w1', 'waiting', 'Stuck one');
  chatSession('w2', 'waiting');
  chatSession('i1', 'idle');
  toolRequest('w1', 'q1', 11);
  toolRequest('w2', 'q2', ATTENTION_TOOL_WAIT_MS / MIN - 1); // not yet
  toolRequest('i1', 'q3', 30); // the session does not wait (stale row)
  toolRequest('w1', 'q4', 30, true); // answered
  // T-284: a working session with a request still open (answering one of two puts it back to working) is listed; a gone process's is not.
  chatSession('k1', 'working');
  toolRequest('k1', 'q5', 10.5); // newer than q1: q1 leads
  chatSession('g1', 'waiting');
  db.prepare("UPDATE chat_sessions SET process = 'gone' WHERE id = 'g1'").run();
  toolRequest('g1', 'q6', 30);
  const r = registry();
  const all = r.list(ownerActor());
  assert.deepEqual(ids(all, 'tool_approval').sort(), ['k1/q5', 'w1/q1']);
  assert.equal(all.items[0]!.why, 'gate');
  assert.equal(all.items[0]!.risk, 'Bash · docker/dev');
  assert.deepEqual(all.items[0]!.who, [{ label: 'Stuck one', link: '/admin/sessions/w1' }]);

  registerResolver({ type: 'session', resolve: (id) => ({ ref: sessionRef(id), owner: { kind: 'user', id: 'u_b' } }) });
  assert.equal(r.list(user('u_a')).counts.tool_approval, 0);
  clearResolvers();

  const events: AttentionChanged[] = [];
  r.onChange((e) => events.push(e));
  r.check();
  db.prepare("UPDATE chat_requests SET answered_at = ? WHERE request_id = 'q1'").run(ago(0));
  r.check();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.resolved, [{ kind: 'tool_approval', id: 'w1/q1' }]);
});

/* ---------- The aggregate ---------- */

test('the aggregate reads each source with exactly one query, however many items there are', () => {
  chatSession('s1', 'waiting');
  for (let i = 0; i < 5; i++) {
    mcpProposal(`e${i}`, `v${i}`);
    skillVersion(`sv${i}`, `h${i}`, { proposedBy: 'session:s1' });
    deploy(`R${i}`);
    ticket();
    toolRequest('s1', `q${i}`, 20 + i);
  }
  let prepared = 0;
  const counting = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          prepared++;
          return target.prepare(sql);
        };
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const r = createAttention({ db: counting }, { now: () => now, tickMs: 0 });
  const list = r.list(ownerActor());
  assert.equal(list.total, 25);
  assert.equal(prepared, 5, 'one query per source');
});

test('the aggregate groups by why then age, pages, filters by kind, and says when a source could not be read', () => {
  chatSession('s1', 'waiting');
  mcpProposal('e1', 'v1');
  skillVersion('sv1', 'h1');
  deploy('R1');
  ticket();
  toolRequest('s1', 'q1', 20);
  const r = registry();
  const all = r.list(ownerActor());
  assert.deepEqual(
    all.items.map((i) => i.why),
    ['production_uat', 'third_party_code', 'third_party_code', 'gate', 'question'],
  );
  // Within a class, the oldest first: the skill (20 min) before the MCP proposal (5 min).
  assert.deepEqual(all.items.filter((i) => i.why === 'third_party_code').map((i) => i.kind), ['skill_version', 'mcp_version']);
  assert.deepEqual([...all.items].sort(attentionOrder), all.items);
  assert.equal(all.total, 5);
  const page = r.list(ownerActor(), { limit: 2, offset: 1 });
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0]!.id, all.items[1]!.id);
  assert.equal(page.total, 5, 'the counts are whole whatever the page');
  assert.deepEqual(ids(r.list(ownerActor(), { kind: 'ci_deploy' }), 'ci_deploy'), ['dep-R1']);
  assert.equal(r.list(ownerActor(), { kind: 'ci_deploy' }).items.length, 1);
  assert.equal(r.count(ownerActor()), 5);

  const broken = createAttention({ db: null }, { now: () => now, tickMs: 0, log: () => undefined });
  const none = broken.list(ownerActor());
  assert.equal(none.counts.mcp_version, null, 'unavailable is a state, never 0');
  assert.equal(none.unavailable.length, 5);
});

test('an item appearing emits one event naming it; nothing changing emits nothing; the first read is the baseline', () => {
  const events: AttentionChanged[] = [];
  let published = 0;
  const r2 = createAttention(store, { now: () => now, tickMs: 0, publish: () => published++ });
  r2.onChange((e) => events.push(e));
  assert.equal(r2.check(), null, 'the baseline emits nothing');
  mcpProposal('e1', 'v1');
  r2.check();
  r2.check();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.added, [{ kind: 'mcp_version', id: 'v1' }]);
  assert.equal(events[0]!.total, 1);
  assert.equal(published, 1);
  assert.ok(!JSON.stringify(events[0]).includes('Entry e1'), 'an event names the item, not its text');
});

test('the route: signed in only, declared, filters by kind and refuses an unknown one', async () => {
  mcpProposal('e1', 'v1');
  const r = registry();
  assert.deepEqual(policyFor('GET /api/attention'), { kind: 'signed-in' });
  const app = (signedIn: boolean) => {
    const a = new Hono<{ Variables: { token: string } }>();
    a.use(async (c, next) => {
      if (signedIn) c.set('token', 'signed-in');
      await next();
    });
    a.onError((e, c) => c.json({ error: (e as { code?: string }).code ?? 'ERR' }, (e as { status?: number }).status === 401 || (e as { code?: string }).code === 'UNAUTHORIZED' ? 401 : 400));
    a.route('/api/attention', createAttentionRoutes(r));
    return a;
  };
  const ok = await app(true).request('/api/attention?kind=mcp_version&limit=10');
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { data: AttentionList };
  assert.equal(body.data.items[0]!.id, 'v1');
  assert.equal((await app(false).request('/api/attention')).status, 401);
  assert.equal((await app(true).request('/api/attention?kind=nope')).status, 400);
});

/* ---------- Slice 2: Later, notifications, the Portal MCP ---------- */

test('Later: a person snoozes an item they see; it stays listed and counted, marked until when; 0 brings it back; another person and a token get 404', async () => {
  mcpProposal('e1', 'v1');
  mcpProposal('e2', 'v2');
  ownedByA('mcp_entry', ['e1']);
  let clock = now;
  const r = createAttention(store, { now: () => clock, tickMs: 0, debounceMs: 1 });
  const a = user('u_a');
  const item = r.snooze(a, 'mcp_version', 'v1');
  assert.equal(item.snoozedUntil, new Date(now + 60 * MIN).toISOString(), 'an hour by default');
  const l = r.list(a);
  assert.equal(l.total, 1, 'a snoozed item still waits and is counted');
  assert.equal(l.items[0]!.snoozedUntil, item.snoozedUntil);
  assert.equal(r.list(ownerActor()).items.find((i) => i.id === 'v1')?.snoozedUntil, undefined, 'a snooze is the person\'s own');
  assert.throws(() => r.snooze(a, 'mcp_version', 'v2'), { code: 'NOT_FOUND' }, 'an item the person does not see');
  assert.throws(() => r.snooze(a, 'mcp_version', 'nope'), { code: 'NOT_FOUND' }, 'the same answer as a missing one');
  assert.throws(() => r.snooze({ kind: 'token', userId: 'u_a', tokenId: 't1', scope: 'admin' } as Actor, 'mcp_version', 'v1'), { code: 'NOT_FOUND' }, 'tokens do not snooze');
  clock = now + 61 * MIN;
  assert.equal(r.list(a).items[0]!.snoozedUntil, undefined, 'back in the deck once the time is up');
  r.snooze(a, 'mcp_version', 'v1', 24 * 60 * 10);
  assert.equal(r.list(a).items[0]!.snoozedUntil, new Date(clock + 24 * 60 * MIN).toISOString(), 'never longer than a day');
  r.snooze(a, 'mcp_version', 'v1', 0);
  assert.equal(r.list(a).items[0]!.snoozedUntil, undefined, '0 brings it back now');
  db.exec('DELETE FROM attention_snoozes');

  // The route: declared, the person's own, validated.
  assert.deepEqual(policyFor('POST /api/attention/snooze'), { kind: 'signed-in' });
  const app = new Hono();
  app.onError((e, c) => c.json({ error: (e as { code?: string }).code }, (e as { code?: string }).code === 'NOT_FOUND' ? 404 : (e as { code?: string }).code === 'UNAUTHORIZED' ? 401 : 400));
  app.route('/api/attention', createAttentionRoutes(r));
  const post = (body: unknown) => app.request('/api/attention/snooze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ kind: 'mcp_version', id: 'v1' })).status, 401, 'signed out');
});

test('notifications: a new item tells each person who may decide it once; kinds announced elsewhere stay quiet; the push opens the deck at the card', async () => {
  const { bridgeAttentionNotify, ATTENTION_NOTIFIED_ELSEWHERE } = await import('./index.js');
  const { render } = await import('../notify/templates.js');
  const { createBus } = await import('../notify/bus.js');
  const bus = createBus();
  const sent: { kind: string; subject: { id: string }; audience?: string[]; detail?: { text: string }; facts: Record<string, unknown> }[] = [];
  bus.on('*', (e) => void sent.push(e as never));
  ownedByA('mcp_entry', ['e1', 'e3']);
  const r = registry();
  const stop = bridgeAttentionNotify(r, bus, () => ['u_a', 'u_b']);
  r.check(); // the baseline: nothing is announced for what already waited
  mcpProposal('e1', 'v1');
  mcpProposal('e2', 'v2');
  chatSession('w1', 'waiting');
  toolRequest('w1', 'q1', 11); // a tool approval has its own notification
  r.check();
  assert.deepEqual(
    sent.map((e) => `${e.audience?.join(',')}|${e.subject.id}`).sort(),
    ['u_a|attention:mcp_version:v1', 'u_b|attention:mcp_version:v2'],
    'each to the person whose own read lists it, and never the tool approval',
  );
  assert.ok(ATTENTION_NOTIFIED_ELSEWHERE.has('tool_approval') && ATTENTION_NOTIFIED_ELSEWHERE.has('ci_deploy') && ATTENTION_NOTIFIED_ELSEWHERE.has('ticket_approval'));
  const e = sent.find((x) => x.subject.id.endsWith(':v1'))!;
  assert.deepEqual(e.facts, { what: 'MCP', why: 'Outside code' });
  assert.ok(e.detail?.text && e.detail.text.length > 0, 'the title travels only as the untrusted detail');
  const shown = render(e as never);
  assert.equal(shown.title, 'Needs you');
  assert.equal(shown.path, `/admin/attention?item=${encodeURIComponent('mcp_version:v1')}`);
  assert.ok(!shown.body.includes('Entry e1'), 'no agent text in the body');

  // Once: resolved and back, read again, or a later change: never a second time.
  r.check();
  db.prepare("UPDATE mcp_catalog_versions SET review_state = 'approved' WHERE id = 'v1'").run();
  r.check();
  db.prepare("UPDATE mcp_catalog_versions SET review_state = 'draft' WHERE id = 'v1'").run();
  r.check();
  mcpProposal('e3', 'v3');
  r.check();
  assert.deepEqual(sent.map((x) => x.subject.id).sort(), ['attention:mcp_version:v1', 'attention:mcp_version:v2', 'attention:mcp_version:v3']);
  stop();
});

test('attention_list: compact rows by default, full on request; an agent sees only its own session; another item is the same NOT_FOUND as a missing one', async () => {
  const { portalMcpHarness } = await import('../portalmcp/testkit.js');
  const { registerAttentionTools } = await import('./index.js');
  const mcp = await portalMcpHarness();
  try {
    const d = mcp.store.db!;
    for (const id of ['s1', 's2'])
      d.prepare("INSERT INTO chat_sessions (id, workspace_id, title, state, state_since, created_at, last_activity_at) VALUES (?, 'docker/dev', ?, 'waiting', ?, ?, ?)").run(id, `Session ${id}`, ago(MIN), ago(MIN), ago(MIN));
    for (const s of ['s1', 's2'])
      d.prepare("INSERT INTO chat_requests (session_id, request_id, kind, tool_name, title, detail, created_at) VALUES (?, 'q1', 'tool', 'Bash', 'Run a command', 'ls', ?)").run(s, ago(20 * MIN));
    const r = createAttention(mcp.store, { now: () => now, tickMs: 0 });
    registerAttentionTools(r, mcp.registry);
    const admin = mcp.token('admin');
    const agent = await mcp.agentToken('docker/dev', 's1');

    const short = (await mcp.call(admin.secret, 'attention_list', {})).result!.structuredContent;
    assert.deepEqual(short.items.map((i: { item: string }) => i.item).sort(), ['tool_approval:s1/q1', 'tool_approval:s2/q1']);
    assert.deepEqual(Object.keys(short.items[0]).sort(), ['item', 'kind', 'link', 'since', 'title', 'why'], 'the short row');
    assert.equal(short.items[0].title.source, 'attention', 'the title is labelled untrusted');
    const full = (await mcp.call(admin.secret, 'attention_list', { full: true })).result!.structuredContent;
    assert.ok('risk' in full.items[0] && 'who' in full.items[0] && 'page' in full.items[0]);

    const mine = (await mcp.call(agent.secret, 'attention_list', {})).result!.structuredContent;
    assert.deepEqual(mine.items.map((i: { item: string }) => i.item), ['tool_approval:s1/q1'], 'an agent sees its own session only');
    const theirs = await mcp.call(agent.secret, 'attention_list', { item: 'tool_approval:s2/q1' });
    const missing = await mcp.call(agent.secret, 'attention_list', { item: 'tool_approval:nope/q1' });
    assert.equal(theirs.result?.isError, true);
    assert.equal(theirs.result?.content?.[0]?.text, missing.result?.content?.[0]?.text, 'not visible and not there are one answer');
    const one = (await mcp.call(agent.secret, 'attention_list', { item: 'tool_approval:s1/q1' })).result!.structuredContent;
    assert.equal(one.item.link, `/admin/attention?item=${encodeURIComponent('tool_approval:s1/q1')}`);
  } finally {
    mcp.done();
  }
});
