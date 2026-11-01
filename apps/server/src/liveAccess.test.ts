// Organizations slice 2 (docs/prd/organizations.md §13 P5, §14 G9): the live socket cuts what it sends to the person on each tab. Two people
// (`u_a`, `u_b`) and an admin account, the founding user, workspaces owned by each, and the X-cases: nobody gets another person's
// workspaces or their usage figures; the portal's own topics reach only who may view that area; a nudge for one person reaches only their
// tabs; a right taken away is applied to an open tab at once.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, test } from 'node:test';
import { FOUNDING_USER_ID, workspaceRef, type Actor, type LiveMessage, type Workspace, type WorkspaceUsage } from '@portal/contracts';
import { WebSocket } from 'ws';
import { emitAccessChange, registerResolver, useAccountRoles, useSocketActor } from './authz/seam.js';
import { LIVE_TOPIC_AREA, LiveHub } from './live.js';

const A = 'u_Alice_000001';
const B = 'u_Bob_00000001';
const ADMIN = 'u_Adm1n_00001';
const person = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'x', via: 'ui' });
const PEOPLE: Record<string, Actor> = { 'portal_session=a': person(A), 'portal_session=b': person(B), 'portal_session=admin': person(ADMIN), 'portal_session=owner': person(FOUNDING_USER_ID) };

const ws = (name: string) => ({ id: `docker/${name}`, name, target: 'docker', image: '', status: 'running', detail: '', createdAt: '2026-10-10T00:00:00Z' }) as Workspace;
/** Who owns each workspace: the resolver reads it on every call, so a test can move one. */
const owners: Record<string, string> = { 'docker/alpha': A, 'docker/beta': B, 'docker/shared': FOUNDING_USER_ID };
const list = [ws('alpha'), ws('beta'), ws('shared')];
const usage: WorkspaceUsage[] = list.map((w, i) => ({ id: w.id, cpuPercent: 10 * (i + 1), memoryBytes: 1000 * (i + 1) }));

let server: Server;
let hub: LiveHub;
let port = 0;
before(async () => {
  useAccountRoles((id) => (id === ADMIN ? 'admin' : id === A || id === B ? 'member' : null));
  useSocketActor((req) => PEOPLE[req.headers.cookie ?? ''] ?? null);
  registerResolver({ type: 'workspace', resolve: (id) => (owners[id] ? { ref: workspaceRef(id), owner: { kind: 'user', id: owners[id]! } } : null) });
  hub = new LiveHub({ workspaces: async () => list, usage: async () => usage }, (req) => !!PEOPLE[req.headers.cookie ?? '']);
  server = createServer();
  hub.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  hub.close();
  server.close();
});
const tabs: WebSocket[] = [];
afterEach(async () => {
  for (const t of tabs.splice(0)) t.close();
  const end = Date.now() + 2000;
  while (hub.clients > 0 && Date.now() < end) await sleep(10);
});

async function tab(cookie: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live`, { headers: { cookie, origin: `http://127.0.0.1:${port}` } });
  const got: LiveMessage[] = [];
  socket.on('message', (d) => got.push(JSON.parse(String(d)) as LiveMessage));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  tabs.push(socket);
  const subscribe = (...topics: string[]) => socket.send(JSON.stringify({ type: 'subscribe', topics }));
  return { socket, got, subscribe };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}
const names = (m: LiveMessage | undefined) => ((m as { data: { id: string }[] } | undefined)?.data ?? []).map((w) => w.id).sort();
const last = (got: LiveMessage[], type: string) => got.filter((m) => m.type === type).at(-1);

test('X: each person gets only their own workspaces; the founding user and an admin account get theirs and the founder’s', async () => {
  const [a, b, owner, admin] = await Promise.all([tab('portal_session=a'), tab('portal_session=b'), tab('portal_session=owner'), tab('portal_session=admin')]);
  for (const t of [a, b, owner, admin]) t.subscribe('workspaces');
  await until(() => [a, b, owner, admin].every((t) => t.got.some((m) => m.type === 'workspaces')));
  assert.deepEqual(names(last(a.got, 'workspaces')), ['docker/alpha']);
  assert.deepEqual(names(last(b.got, 'workspaces')), ['docker/beta']);
  assert.deepEqual(names(last(owner.got, 'workspaces')), ['docker/shared']);
  assert.deepEqual(names(last(admin.got, 'workspaces')), ['docker/shared'], 'D-82: an admin holds the founder’s objects, never another person’s');
  assert.ok(!JSON.stringify(a.got).includes('beta') && !JSON.stringify(b.got).includes('alpha'));
});

test('X: the usage snapshot carries only the rows of workspaces the person may view', async () => {
  const [a, b] = await Promise.all([tab('portal_session=a'), tab('portal_session=b')]);
  a.subscribe('usage');
  b.subscribe('usage');
  await until(() => a.got.some((m) => m.type === 'usage') && b.got.some((m) => m.type === 'usage'));
  assert.deepEqual(names(last(a.got, 'usage')), ['docker/alpha']);
  assert.deepEqual(names(last(b.got, 'usage')), ['docker/beta']);
});

test('X: the portal’s own topics reach only who may view that area; a content nudge reaches every signed-in subscriber', async () => {
  const [a, admin] = await Promise.all([tab('portal_session=a'), tab('portal_session=admin')]);
  const platformTopics = Object.keys(LIVE_TOPIC_AREA);
  assert.deepEqual(platformTopics.sort(), ['accounts', 'autotransfer', 'claudeusage', 'claudeversion', 'connect', 'pools', 'system']);
  a.subscribe(...platformTopics, 'tickets');
  admin.subscribe(...platformTopics, 'tickets');
  await until(() => hub.watching('accounts'));
  for (const t of [...platformTopics, 'tickets']) hub.publish(t as never);
  await until(() => admin.got.length === platformTopics.length + 1);
  await until(() => a.got.length >= 1);
  await sleep(350);
  assert.deepEqual(a.got, [{ type: 'tickets' }], 'a member hears of tickets (its page filters them), never of accounts, storage or targets');
  assert.equal(admin.got.length, platformTopics.length + 1);
});

test('X: a notification’s nudge goes to the tabs of the people it is for, and to nobody else', async () => {
  const [a1, a2, b] = await Promise.all([tab('portal_session=a'), tab('portal_session=a'), tab('portal_session=b')]);
  for (const t of [a1, a2, b]) t.subscribe('notify');
  await sleep(50);
  hub.publish('notify', [A]);
  await until(() => a1.got.length === 1 && a2.got.length === 1);
  await sleep(300);
  assert.deepEqual(b.got, [], 'B’s tab is not told that A got something');
  hub.publish('notify');
  await until(() => b.got.length === 1);
});

test('X: a right taken away reaches an open tab at once: the workspace leaves its list without a reload', async () => {
  const b = await tab('portal_session=b');
  b.subscribe('workspaces');
  await until(() => b.got.some((m) => m.type === 'workspaces'));
  owners['docker/beta'] = A; // ownership moved (a later slice's Move); the seam is told
  try {
    emitAccessChange({ userId: B, ref: workspaceRef('docker/beta'), why: 'owner_changed' });
    await until(() => b.got.filter((m) => m.type === 'workspaces').length === 2);
    assert.deepEqual(names(last(b.got, 'workspaces')), []);
  } finally {
    owners['docker/beta'] = B;
  }
});

test('an anonymous socket (a session no reader knows) hears nothing, whatever it asks for', async () => {
  // The module's own `authorized` lets it in (a valid session), but no person is named: P1's fail-closed socket.
  const was = useSocketActor(() => null);
  try {
    const t = await tab('portal_session=a');
    t.subscribe('workspaces', 'usage', 'tickets', 'accounts');
    await sleep(100);
    hub.publish('tickets');
    hub.publish('accounts');
    await sleep(400);
    assert.deepEqual(t.got, []);
  } finally {
    useSocketActor(was);
  }
});
