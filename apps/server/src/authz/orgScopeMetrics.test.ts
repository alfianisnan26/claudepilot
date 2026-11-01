// The org context of the Home dashboard and the glance rail (owner request 2026-11-01, metrics per org; authz/orgScope.ts) against a real
// migrated database and the real owner resolvers: every summary route reads `?org=` and counts only rows anchored in that context. Org A is
// the owner's, org B is not (she left it), and one object of each kind sits in org A, in the owner's own space and in org B:
//   - `?org=<orgA>` keeps org A's, `?org=personal` the owner's own (what no org owns), no `?org=` today's numbers;
//   - an org she is not in, or a forged id, answers empty numbers, never wider ones.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FOUNDING_USER_ID, workspaceRef, type Actor, type AttentionItem, type ChatSession, type CiRunSummary, type UserId } from '@portal/contracts';
import { Hono } from 'hono';
import { AttentionRegistry, type AnchoredItem } from '../attention/registry.js';
import { createAttentionRoutes } from '../attention/routes.js';
import { registerChatAuthz } from '../chat/authz.js';
import { registerCiAuthz } from '../ci/authz.js';
import type { ClaudeUsageMonitor } from '../claudeusage/service.js';
import { createClaudeUsageRoutes } from '../claudeusage/routes.js';
import { glanceSources } from '../glance/authz.js';
import { createGlanceRoutes } from '../glance/routes.js';
import { Glance } from '../glance/service.js';
import { createKeepGoingListRoutes } from '../keepgoing/routes.js';
import { createOrgs, type OrgsModule } from '../orgs/index.js';
import type { PlatformOwner } from '../platform/owner.js';
import { registerTicketBucketAuthz } from '../tickets/authz.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import type { InWorkspace, UsageSpend } from '../usagespend/service.js';
import { createUsageSpendRoutes } from '../usagespend/routes.js';
import { bucketsInScope, effectiveOrgScope, orgScopeFilter, orgScopeKey } from './orgScope.js';
import { registerOwnerResolvers } from './owners.js';
import { clearResolvers, useAccountRoles, useOrgAuthority, type AccountRoleOf } from './seam.js';

const OWNER = FOUNDING_USER_ID as UserId; // owner of org A, not in org B
const EVE = 'u_Eve0000000s' as UserId; // owner of org B, not in org A
const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'legacy', via: 'ui' });

let store: Store;
let m: OrgsModule;
let restoreRoles: AccountRoleOf;
let orgA = '';
let orgB = '';

const WS = { org: 'docker/ws-org', own: 'docker/ws-own', oth: 'docker/ws-oth' } as const;
const KEYS = ['org', 'own', 'oth'] as const;
const at = () => new Date().toISOString();

function addUser(id: string, role: 'admin' | 'member') {
  const t = at();
  store.db!
    .prepare('INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `${id}@example.test`, `${id.toLowerCase()}@example.test`, id, role, 'active', 'not-a-hash', t, t, 'ui');
}

/** A route module mounted under `/x` with the caller set, and a GET that returns the envelope's data. */
function caller(routes: Hono, who: Actor) {
  const app = new Hono<{ Variables: { actor: Actor } }>();
  app.use('*', async (c, next) => {
    c.set('actor', who);
    await next();
  });
  app.route('/x', routes as never);
  return async <T>(path: string): Promise<T> => {
    // A route mounted at `/x` answers `/x` and `/x?org=`, not `/x/` (strict paths): the tests write `/` and `/?org=` for it.
    const res = await app.request(`/x${path.replace(/^\/(?=$|\?)/, '')}`);
    assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
    return ((await res.json()) as { data: T }).data;
  };
}

/** One session, CI run and Claude per workspace (s_org, r_own, c_oth, ...). */
const session = (k: (typeof KEYS)[number]) => ({ id: `s_${k}`, workspaceId: WS[k], title: k, state: 'working', process: 'live', waiting: 0, archivedAt: null, parentId: null, lastActivityAt: at() }) as unknown as ChatSession;
const run = (k: (typeof KEYS)[number], status: 'failed' | 'running'): CiRunSummary =>
  ({
    id: `r_${status}_${k}`,
    number: 1,
    repoId: `cr_${k}`,
    repo: k,
    pipeline: 'ci',
    ref: `refs/heads/${k}`,
    branch: k,
    status,
    finishedAt: status === 'failed' ? at() : null,
    startedAt: at(),
    workspaceId: WS[k],
    jobs: status === 'running' ? [{ id: 'deploy', status: 'waiting' }] : [],
  }) as unknown as CiRunSummary;
const RUNS = KEYS.flatMap((k) => [run(k, 'failed'), run(k, 'running')]);

before(async () => {
  store = await Store.open({ dataDir: tempDirectory('cp-orgmetrics-'), secretKey: null });
  const db = store.db!;
  addUser(OWNER, 'admin');
  addUser(EVE, 'member');
  restoreRoles = useAccountRoles((id) => {
    const r = db.prepare('SELECT role, state FROM users WHERE id = ?').get(id) as { role: 'admin' | 'member'; state: string } | undefined;
    return r ? (r.state === 'active' ? r.role : 'disabled') : null;
  });
  m = createOrgs({ store, now: () => new Date(), credentials: () => ({ list: () => [], remove: () => undefined }), notifyBreakGlass: () => undefined });
  registerOwnerResolvers({
    db: () => store.db,
    workspace: (ref) => {
      const r = db.prepare('SELECT id, legacy_id FROM workspace_identities WHERE (legacy_id = ? OR id = ?) AND removed_at IS NULL').get(ref, ref) as { id: string; legacy_id: string } | undefined;
      return r ? { id: r.id, legacyId: r.legacy_id } : null;
    },
  });
  orgA = m.orgs.create(person(OWNER), { name: 'Acme', slug: 'acme' }).id;
  orgB = m.orgs.create(person(OWNER), { name: 'Other', slug: 'other' }).id;
  m.orgs.admit(orgB, EVE, 'owner', 'invite', 'test');
  m.orgs.leave(person(OWNER), orgB);
  const owners: [string, string][] = [
    ['org', orgA],
    ['user', OWNER],
    ['org', orgB],
  ];
  KEYS.forEach((k, i) => {
    const [kind, id] = owners[i]!;
    const uid = `ws_${k}aaaaaaaaa`;
    const t = at();
    db.prepare("INSERT INTO workspace_identities (id, target, name, legacy_id, created_at) VALUES (?, 'docker', ?, ?, ?)").run(uid, `ws-${k}`, WS[k], t);
    db.prepare("INSERT INTO workspace_owners (workspace_id, uid, owner_kind, owner_id, created_by, created_at, origin) VALUES (?, ?, ?, ?, ?, ?, 'created')").run(WS[k], uid, kind, id, OWNER, t);
    db.prepare('INSERT INTO ticket_buckets (key, name, owner_kind, owner_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(k.toUpperCase(), k, kind, id, OWNER, t, t);
  });
  registerChatAuthz((id) => {
    const k = KEYS.find((x) => `s_${x}` === id);
    return k ? { id, workspaceId: WS[k], ownerId: OWNER } : null;
  });
  registerTicketBucketAuthz({
    bucketOwner: () => null,
    bucketOwnerOf: (key) => (db.prepare('SELECT owner_kind AS kind, owner_id AS id FROM ticket_buckets WHERE key = ?').get(key) as { kind: string; id: string } | undefined) ?? null,
  });
  registerCiAuthz({ workspaceOfRun: (id: string) => RUNS.find((r) => r.id === id)?.workspaceId ?? null, workspaceOfRepo: () => null } as never);
});

after(() => {
  useAccountRoles(restoreRoles);
  useOrgAuthority(null);
  clearResolvers();
});

test('effectiveOrgScope and orgScopeKey: an org the caller is not in, or a forged id, is one empty scope (a cache keyed by it stays bounded)', () => {
  const me = person(OWNER);
  assert.deepEqual(effectiveOrgScope(me, { kind: 'org', id: orgA }), { kind: 'org', id: orgA });
  assert.deepEqual(effectiveOrgScope(me, { kind: 'personal' }), { kind: 'personal' });
  assert.equal(effectiveOrgScope(me, null), null);
  assert.equal(orgScopeKey(effectiveOrgScope(me, { kind: 'org', id: orgB })), orgScopeKey(effectiveOrgScope(me, { kind: 'org', id: 'org_forged000000' })));
  assert.equal(orgScopeKey(null), '');
});

test('glance (Sessions, Agents, Needs attention): sessions by workspace, tickets by bucket, failed runs and held deploys by workspace', async () => {
  const withins: (readonly string[] | undefined)[] = [];
  const sources = glanceSources({
    chat: { list: () => KEYS.map(session), openRequests: () => [], runningTasks: () => [] },
    tickets: {
      // The ticket service narrows its own count by `within` (tickets/within.test.ts); here it reports how many buckets it was handed.
      list: (_c: unknown, _f: unknown, within?: readonly string[]) => (withins.push(within), { items: [], total: within ? within.length : 3, counts: {} as never }),
      bucketKeys: () => ['ORG', 'OWN', 'OTH'],
    } as never,
    ci: { list: (f: { status?: string[] }) => ({ items: RUNS.filter((r) => !f.status || f.status.includes(r.status)), next: null }) } as never,
  });
  const get = caller(createGlanceRoutes(new Glance(sources, { notify: () => undefined })), person(OWNER));
  type Snap = { sessions: { open: number; items: { id: string }[] }; attention: { tickets: { count: number }; ci: { count: number; items: { workspaceId: string }[] }; deploys: { count: number } } };

  const all = await get<Snap>('/');
  assert.equal(all.sessions.open, 3, 'today: everything she may see (the founding user sees every session)');
  assert.equal(all.attention.tickets.count, 3);
  assert.equal(withins.at(-1), undefined, 'no context: the ticket count is not narrowed');

  const a = await get<Snap>(`/?org=${orgA}`);
  assert.deepEqual(a.sessions.items.map((s) => s.id), ['s_org']);
  assert.deepEqual(withins.at(-1), ['ORG']);
  assert.equal(a.attention.tickets.count, 1);
  assert.equal(a.attention.ci.count, 1);
  assert.deepEqual(a.attention.ci.items.map((r) => r.workspaceId), [WS.org]);
  assert.equal(a.attention.deploys.count, 1);

  const own = await get<Snap>('/?org=personal');
  assert.deepEqual(own.sessions.items.map((s) => s.id), ['s_own']);
  assert.deepEqual(withins.at(-1), ['OWN']);
  assert.deepEqual(own.attention.ci.items.map((r) => r.workspaceId), [WS.own]);

  for (const id of [orgB, 'org_forged000000', 'not-an-org']) {
    const none = await get<Snap>(`/?org=${id}`);
    assert.equal(none.sessions.open, 0, `${id}: no sessions`);
    assert.deepEqual(withins.at(-1), [], `${id}: no buckets`);
    assert.equal(none.attention.tickets.count, 0);
    assert.equal(none.attention.ci.count + none.attention.deploys.count, 0);
  }
});

test('Needs you: an item through its anchor; counts and total follow; the anchor never leaves', async () => {
  const registry = new AttentionRegistry();
  const item = (id: string, anchor: AnchoredItem['anchor']): AnchoredItem => ({
    kind: 'tool_approval',
    id,
    title: id,
    who: [],
    why: 'gate',
    risk: '',
    since: at(),
    link: '/',
    action: { label: 'Answer', method: 'SOCKET', path: '/' },
    anchor,
  });
  registry.register({
    kind: 'tool_approval',
    list: () => [item('i_org', workspaceRef(WS.org)), item('i_own', workspaceRef(WS.own)), item('i_oth', workspaceRef(WS.oth)), item('i_none', null)],
  });
  const get = caller(createAttentionRoutes(registry), person(OWNER));
  type List = { total: number; counts: { tool_approval: number }; items: AttentionItem[] };
  const ids = (l: List) => l.items.map((i) => i.id).sort();
  const all = await get<List>('/');
  assert.equal(all.total, 4, 'no context: what the source lists, as today');
  assert.ok(all.items.every((i) => !('anchor' in i)), 'the anchor is internal');
  const a = await get<List>(`/?org=${orgA}`);
  assert.deepEqual(ids(a), ['i_org']);
  assert.equal(a.counts.tool_approval, 1);
  assert.equal(a.total, 1);
  assert.deepEqual(ids(await get<List>('/?org=personal')), ['i_none', 'i_own'], 'personal: not org-owned, and no anchor');
  assert.equal((await get<List>(`/?org=${orgB}`)).total, 0);
  assert.equal((await get<List>('/?org=org_forged000000')).total, 0);
});

test('Quota (claude usage): a Claude through its workspace; its alerts follow it', async () => {
  const claudes = KEYS.map((k) => ({ claudeId: `c_${k}`, workspaceId: WS[k] }));
  const usage = { report: async () => ({ claudes, alerts: claudes.map((c) => ({ id: c.claudeId, claudeId: c.claudeId })), thresholds: {}, intervalMs: 1, now: at() }) } as unknown as ClaudeUsageMonitor;
  const get = caller(createClaudeUsageRoutes(usage), person(OWNER));
  type R = { claudes: { claudeId: string }[]; alerts: { claudeId: string }[] };
  const ids = (r: R) => [r.claudes.map((c) => c.claudeId), r.alerts.map((a) => a.claudeId)];
  assert.equal((await get<R>('/')).claudes.length, 3, 'no context: the report as it was');
  assert.deepEqual(ids(await get<R>(`/?org=${orgA}`)), [['c_org'], ['c_org']]);
  assert.deepEqual(ids(await get<R>('/?org=personal')), [['c_own'], ['c_own']]);
  assert.deepEqual(ids(await get<R>(`/?org=${orgB}`)), [[], []]);
});

test('Usage (spend summary): the summary is asked with the workspaces of the context', async () => {
  let asked: InWorkspace | undefined;
  const spend = { summary: (_a: string, inWorkspace?: InWorkspace) => ((asked = inWorkspace), { kept: inWorkspace ? [...Object.values(WS), null].filter((w) => inWorkspace(w)) : 'all' }) } as unknown as UsageSpend;
  const get = caller(createUsageSpendRoutes(spend), person(OWNER));
  assert.deepEqual(await get('/'), { kept: 'all' });
  assert.equal(asked, undefined, 'no context: no narrowing');
  assert.deepEqual(await get(`/?org=${orgA}`), { kept: [WS.org] });
  assert.deepEqual(await get('/?org=personal'), { kept: [WS.own, null] }, 'personal: not org-owned, and a budget on everything');
  assert.deepEqual(await get(`/?org=${orgB}`), { kept: [] });
});

test('Usage page per org (owner bug 2026-11-01): the strip, Requests, attribution, budgets, spikes and alerts are asked in the context', async () => {
  const kept = (inWorkspace: InWorkspace | undefined) => (inWorkspace ? [...Object.values(WS), null].filter((w) => inWorkspace(w)) : 'all');
  const usage = {
    summary: async (o: { inWorkspace?: InWorkspace }) => ({ kept: kept(o.inWorkspace) }),
    requestsReport: (_r: string, o: { inWorkspace?: InWorkspace }) => ({ kept: kept(o.inWorkspace) }),
  } as unknown as ClaudeUsageMonitor;
  const u = caller(createClaudeUsageRoutes(usage), person(OWNER));
  for (const path of ['/summary', '/requests?range=1d']) {
    assert.deepEqual(await u(path), { kept: 'all' }, `${path}: no context, as before`);
    assert.deepEqual(await u(`${path}${path.includes('?') ? '&' : '?'}org=${orgA}`), { kept: [WS.org] }, path);
    assert.deepEqual(await u(`${path}${path.includes('?') ? '&' : '?'}org=personal`), { kept: [WS.own, null] }, path);
    assert.deepEqual(await u(`${path}${path.includes('?') ? '&' : '?'}org=${orgB}`), { kept: [] }, `${path}: an org she is not in`);
  }
  const spend = {
    attribution: (_q: unknown, _a: string, o: { inWorkspace?: InWorkspace }) => ({ kept: kept(o.inWorkspace) }),
    budgets: (_a: string, inWorkspace?: InWorkspace) => ({ kept: kept(inWorkspace) }),
    spikes: (_r: string, _a: string, inWorkspace?: InWorkspace) => ({ kept: kept(inWorkspace) }),
    alerts: (_a: string, inWorkspace?: InWorkspace) => ({ kept: kept(inWorkspace) }),
  } as unknown as UsageSpend;
  const s = caller(createUsageSpendRoutes(spend), person(OWNER));
  for (const path of ['/attribution?by=claude&range=1d', '/budgets', '/spikes?range=7d', '/alerts']) {
    const and = path.includes('?') ? '&' : '?';
    assert.deepEqual(await s(path), { kept: 'all' }, `${path}: no context, as before`);
    assert.deepEqual(await s(`${path}${and}org=${orgA}`), { kept: [WS.org] }, path);
    assert.deepEqual(await s(`${path}${and}org=personal`), { kept: [WS.own, null] }, path);
    assert.deepEqual(await s(`${path}${and}org=${orgB}`), { kept: [] }, path);
  }
});

test('Autonomy (Keep going): a chat through its workspace, after view', async () => {
  const chats = KEYS.map((k) => ({ id: `s_${k}`, workspaceId: WS[k] }));
  const owner = { actorOf: (c: { get(k: string): Actor }) => ({ actor: c.get('actor'), userId: OWNER, admin: true, label: 'test' }), can: () => true, isAdmin: () => true } as unknown as PlatformOwner;
  const engine = { list: (keep: (s: { id: string; workspaceId: string }) => boolean) => ({ paused: false, chats: chats.filter(keep).map((s) => ({ sessionId: s.id })) }), setPause: () => undefined } as never;
  const get = caller(createKeepGoingListRoutes({ owner, engine }), person(OWNER));
  type L = { chats: { sessionId: string }[] };
  const ids = (l: L) => l.chats.map((c) => c.sessionId).sort();
  assert.deepEqual(ids(await get<L>('/')), ['s_org', 's_oth', 's_own'], 'no context: as today');
  assert.deepEqual(ids(await get<L>(`/?org=${orgA}`)), ['s_org']);
  assert.deepEqual(ids(await get<L>('/?org=personal')), ['s_own']);
  assert.deepEqual(ids(await get<L>(`/?org=${orgB}`)), []);
});

test('bucketsInScope: the ticket buckets a context keeps (a key with no bucket row is no org’s, so it is personal)', () => {
  const keys = ['ORG', 'OWN', 'OTH', 'GONE'];
  assert.deepEqual(bucketsInScope(keys, orgScopeFilter(person(OWNER), { kind: 'org', id: orgA })!), ['ORG']);
  assert.deepEqual(bucketsInScope(keys, orgScopeFilter(person(OWNER), { kind: 'personal' })!), ['OWN', 'GONE']);
  assert.deepEqual(bucketsInScope(keys, orgScopeFilter(person(OWNER), { kind: 'org', id: orgB })!), []);
  assert.deepEqual(bucketsInScope(keys, orgScopeFilter(person(EVE), { kind: 'org', id: orgB })!), ['OTH']);
});
