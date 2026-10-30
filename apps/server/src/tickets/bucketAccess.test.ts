// T-1098: buckets through the routes and the Portal MCP tools. Both ticket forms (T-<n> and KONF-<n>) resolve in every route and tool, and a
// bucket the caller may not reach answers exactly like a missing one (the same 404 and the same text).
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Hono } from 'hono';
import { isAppError } from '@isnanme/core';
import { TICKET_API, type Actor } from '@portal/contracts';
import { clearResolvers, declaredPolicies, declaredToolPolicies } from '../authz/seam.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { TICKET_BUCKET_POLICIES } from './authz.js';
import { ticketKeyField, ticketKeyOf } from './keys.js';
import { registerTicketTools } from './portalTools.js';
import { createTicketRoutes } from './routes.js';
import { Tickets } from './service.js';
import { FakeSessions, ticketsHarness, UI } from './testkit.js';

afterEach(() => clearResolvers());

function routes(tickets: Tickets, actor?: Actor) {
  const a = new Hono<{ Variables: { token: string; actor: Actor } }>();
  a.use(async (c, next) => {
    if (actor) c.set('actor', actor);
    else c.set('token', 'signed-in');
    await next();
  });
  a.onError((e, c) => (isAppError(e) ? c.json({ error: { code: e.code, message: e.message } }, e.status as 400) : c.json({ error: { code: 'INTERNAL', message: String(e) } }, 500)));
  a.route('/api/tickets', createTicketRoutes(tickets));
  return a;
}
const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const read = async (r: Response) => ({ status: r.status, body: (await r.json()) as { data?: any; error?: { code: string; message: string } } });

test('routes: a ticket by T-<n> or by its key, every route; bucket admin; declared in the seam', async () => {
  const h = await ticketsHarness();
  try {
    const app = routes(h.tickets);
    for (const key of Object.keys(TICKET_BUCKET_POLICIES)) assert.ok(declaredPolicies().has(key), key);
    const made = await read(await app.request(TICKET_API.list, json('POST', { summary: 'route work', bucket: 'KONF' })));
    assert.equal(made.status, 201);
    assert.deepEqual([made.body.data.id, made.body.data.key], ['T-1', 'KONF-1']);
    for (const ref of ['T-1', 'KONF-1', 'konf-1']) assert.equal((await read(await app.request(TICKET_API.one(ref)))).body.data.ticket.id, 'T-1', ref);
    assert.equal((await read(await app.request(TICKET_API.brief('KONF-1')))).body.data.key, 'KONF-1');
    assert.equal((await app.request(TICKET_API.one('KONF-1'), json('PATCH', { priority: 'high' }))).status, 200);
    assert.equal((await app.request(TICKET_API.comments('KONF-1'), json('POST', { text: 'by key' }))).status, 201);
    assert.equal((await app.request(TICKET_API.attachments('KONF-1'))).status, 200);
    assert.equal((await app.request(TICKET_API.close('KONF-1'), json('POST', { summary: 'done' }))).status, 200);
    assert.equal((await read(await app.request(`${TICKET_API.list}?bucket=KONF&includeClosed=1`))).body.data.items.length, 1);
    assert.equal((await read(await app.request(`${TICKET_API.list}?bucket=CP`))).body.data.items.length, 0);
    // The search box: by its key and by its old id.
    for (const q of ['KONF-1', 'konf-1', 'T-1']) assert.deepEqual((await read(await app.request(`${TICKET_API.list}?q=${q}&includeClosed=1`))).body.data.items.map((t: { key: string }) => t.key), ['KONF-1'], q);

    const b = await read(await app.request(TICKET_API.buckets, json('POST', { key: 'OPS', name: 'Ops', defaultTags: ['ops'] })));
    assert.deepEqual([b.status, b.body.data.key, b.body.data.defaultTags], [201, 'OPS', ['ops']]);
    assert.equal((await read(await app.request(TICKET_API.bucket('ops'), json('PATCH', { name: 'Operations' })))).body.data.name, 'Operations');
    assert.deepEqual((await read(await app.request(TICKET_API.buckets))).body.data.map((x: { key: string }) => x.key), ['CP', 'KONF', 'OPS', 'PILOT', 'TB']);
    assert.equal((await app.request(TICKET_API.bucket('NOPE'))).status, 404);
  } finally {
    h.done();
  }
});

test('routes: another person’s bucket is the same 404 as a missing one, for the bucket and for every ticket in it', async () => {
  const h = await ticketsHarness();
  try {
    h.tickets.createBucket(UI, { key: 'PRIV', name: 'Private' }, { ownerId: 'u_alice' });
    const theirs = h.tickets.create(UI, { summary: 'hers', bucket: 'PRIV' });
    h.tickets.create(UI, { summary: 'mine', bucket: 'CP' });
    const me = routes(h.tickets, { kind: 'user', userId: 'u_owner', loginSessionId: 'l', via: 'ui' });

    const hidden = await read(await me.request(TICKET_API.one(theirs.key!)));
    const missing = await read(await me.request(TICKET_API.one('PRIV-99')));
    assert.deepEqual(hidden, { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No such ticket.' } } });
    assert.deepEqual(hidden, missing, 'byte for byte a missing ticket');
    assert.deepEqual(await read(await me.request(TICKET_API.one(theirs.id))), missing, 'the old id too');
    assert.equal((await me.request(TICKET_API.comments(theirs.id), json('POST', { text: 'x' }))).status, 404);
    const bucketHidden = await read(await me.request(TICKET_API.bucket('PRIV')));
    assert.deepEqual(bucketHidden, await read(await me.request(TICKET_API.bucket('NONE'))));
    assert.equal(bucketHidden.status, 404);
    assert.equal((await me.request(TICKET_API.list, json('POST', { summary: 'x', bucket: 'PRIV' }))).status, 404);
    const listed = (await read(await me.request(`${TICKET_API.list}?includeClosed=1`))).body.data.items.map((t: { key: string }) => t.key);
    assert.deepEqual(listed, ['CP-1'], 'a list leaves the hidden bucket’s tickets out');
    assert.deepEqual((await read(await me.request(TICKET_API.buckets))).body.data.map((x: { key: string }) => x.key), ['CP', 'KONF', 'PILOT', 'TB']);
    // The person whose bucket it is sees it.
    const alice = routes(h.tickets, { kind: 'user', userId: 'u_alice', loginSessionId: 'l2', via: 'ui' });
    assert.equal((await alice.request(TICKET_API.one(theirs.key!))).status, 200);
    assert.equal((await alice.request(TICKET_API.bucket('PRIV'))).status, 200);
  } finally {
    h.done();
  }
});

/** The endpoint, the ticket tools and the service around a fake of the chat side. */
async function rig() {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const sessions = new FakeSessions();
  const tickets = new Tickets(h.store, sessions, {});
  tickets.start();
  registerTicketTools(tickets, registry);
  const out = (r: { result?: { structuredContent?: any; isError?: boolean; content?: { text: string }[] } }) => r.result!;
  return { h, tickets, sessions, out, done: () => (tickets.stop(), h.done()) };
}

test('tools: every ticket tool takes the key and the old id; ticket_create picks a bucket; ticket_buckets lists them', async () => {
  const r = await rig();
  try {
    for (const name of ['ticket_create', 'ticket_list', 'ticket_buckets']) assert.ok(declaredToolPolicies().has(name), name);
    r.sessions.add({ id: 'sa', workspaceId: 'docker/api', title: 'Lead' });
    const a = await r.h.agentToken('docker/api', 'sa');
    const call = async (name: string, args: Record<string, unknown> = {}) => r.out(await r.h.call(a.secret, name, args));

    const made = await call('ticket_create', { summary: 'by tool', bucket: 'cp' });
    assert.equal(made.isError, undefined, JSON.stringify(made));
    assert.equal(made.structuredContent.summary, 'Created CP-1 (T-1) in CP (named).', 'T-2881: the summary names the bucket and why');
    assert.deepEqual([made.structuredContent.ticket.key, made.structuredContent.ticket.bucket], ['CP-1', 'CP']);

    for (const id of ['T-1', 'CP-1', 'cp-1']) assert.equal((await call('ticket_get', { id })).structuredContent.ticket.id, 'T-1', id);
    assert.equal((await call('ticket_list', { query: 'CP-1' })).structuredContent.tickets[0].key, 'CP-1');
    assert.equal((await call('ticket_list', { bucket: 'CP' })).structuredContent.total, 1);
    assert.equal((await call('ticket_claim_next', { id: 'CP-1' })).structuredContent.summary, 'Claimed CP-1 (T-1): it is yours and in progress.');
    assert.equal((await call('ticket_update', { id: 'CP-1', priority: 'high' })).structuredContent.ticket.priority, 'high');
    assert.equal((await call('ticket_comment', { id: 'CP-1', text: 'by key' })).structuredContent.comment.ticket_id, 'T-1');
    const att = await call('ticket_attach', { id: 'CP-1', name: 'n.txt', text: 'hello' });
    assert.equal((await call('ticket_attachment_get', { id: 'CP-1', attachment_id: att.structuredContent.attachment.id })).structuredContent.text.untrusted_text, 'hello');
    assert.equal((await call('ticket_attachment_remove', { id: 'CP-1', attachment_id: att.structuredContent.attachment.id })).isError, undefined);
    assert.equal((await call('ticket_verdict', { id: 'CP-1' })).structuredContent.verdicts.length, 0);
    assert.equal((await call('ticket_close', { id: 'CP-1', summary: 'done' })).structuredContent.ticket.status, 'done');

    const buckets = (await call('ticket_buckets')).structuredContent.buckets.map((b: { key: string }) => b.key);
    assert.deepEqual(buckets, ['CP', 'KONF', 'PILOT', 'TB']);
  } finally {
    r.done();
  }
});

test('tools: another workspace’s bucket and another person’s bucket are the same not found as a missing one', async () => {
  const r = await rig();
  try {
    r.tickets.createBucket(UI, { key: 'WEB', name: 'Web', defaultWorkspaceId: 'docker/web' });
    r.tickets.createBucket(UI, { key: 'PRIV', name: 'Private' }, { ownerId: 'u_alice' });
    r.sessions.add({ id: 'sa', workspaceId: 'docker/api', title: 'Lead' });
    const a = await r.h.agentToken('docker/api', 'sa');
    const call = async (name: string, args: Record<string, unknown> = {}) => r.out(await r.h.call(a.secret, name, args));
    const missing = await call('ticket_create', { summary: 'x', bucket: 'NOPE' });
    const otherWorkspace = await call('ticket_create', { summary: 'x', bucket: 'WEB' });
    const otherPerson = await call('ticket_create', { summary: 'x', bucket: 'PRIV' });
    assert.equal(missing.isError, true);
    assert.match(missing.content![0]!.text, /No such bucket/);
    assert.deepEqual(otherWorkspace.content, missing.content, 'another workspace’s bucket reads like a missing one');
    assert.deepEqual(otherPerson.content, missing.content, 'another person’s bucket reads like a missing one');
    assert.deepEqual((await call('ticket_list', { bucket: 'PRIV' })).content, (await call('ticket_list', { bucket: 'NOPE' })).content);
    const listed = (await call('ticket_buckets')).structuredContent.buckets.map((b: { key: string }) => b.key);
    assert.deepEqual(listed, ['CP', 'KONF', 'PILOT', 'TB'], 'neither WEB (another workspace) nor PRIV (another person)');
    assert.equal((r.h.store.db!.prepare('SELECT count(*) AS n FROM tickets').get() as { n: number }).n, 0, 'nothing was filed');
  } finally {
    r.done();
  }
});

test('MCP surface: every ticket tool says both forms; comment and close name peer leads; results carry keys; the server says 0.2.0 and why', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'sa', workspaceId: 'docker/api', title: 'Lead' });
    const a = await r.h.agentToken('docker/api', 'sa');
    const { client, close } = await r.h.client(a.secret, 'modern');
    try {
      assert.equal(client.getServerVersion()?.version, '0.2.0');
      assert.match(client.getInstructions() ?? '', /bucket key \(KONF-3\)/);
      const tools = (await client.listTools()).tools.filter((t) => t.name.startsWith('ticket_'));
      for (const t of tools) assert.match(t.description ?? '', /KONF-3/, t.name);
      for (const name of ['ticket_comment', 'ticket_close']) assert.match(tools.find((t) => t.name === name)!.description ?? '', /tickets\.leadPeerGroups/, name);
      const idArg = (tools.find((t) => t.name === 'ticket_get')!.inputSchema as unknown as { properties: { id: { description?: string } } }).properties.id.description;
      assert.match(idArg ?? '', /T-12 or its bucket key/);
    } finally {
      await close();
    }
    const call = async (name: string, args: Record<string, unknown> = {}) => r.out(await r.h.call(a.secret, name, args));
    await call('ticket_create', { summary: 'mine', bucket: 'TB' });
    await call('ticket_claim_next', { id: 'TB-1' });
    const c = (await call('ticket_comment', { id: 'TB-1', text: 'note' })).structuredContent;
    assert.deepEqual([c.summary, c.comment.ticket_id, c.comment.ticket_key], ['Commented on TB-1 (T-1).', 'T-1', 'TB-1']);
    // Other modules' rows (CI runs, trigger runs, the lab, usage) get the key through the lookup the ticket tools installed, as their caller
    // may see it (T-1993; bucketScope.test.ts has the hidden cases).
    const owner: Actor = { kind: 'user', userId: 'u_owner', loginSessionId: 'l', via: 'ui' };
    assert.equal(ticketKeyOf('T-1', owner), 'TB-1');
    assert.deepEqual(ticketKeyField('T-1', owner), { ticket_key: 'TB-1' });
    assert.deepEqual(ticketKeyField('T-404', owner), {});
    assert.deepEqual(ticketKeyField(null, owner), {});
  } finally {
    r.done();
  }
});
