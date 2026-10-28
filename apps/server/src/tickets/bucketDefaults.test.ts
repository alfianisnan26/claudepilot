// T-2881 (PILOT-1006): a ticket filed without a bucket goes where its tags, its parent, its workspace or its session's ticket say, and only
// then to PILOT. Konfersi tickets filed through the portal MCP without `bucket` landed in PILOT (214 moved by hand on 2026-10-28).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TICKET_BUCKET_ROUTES_DEFAULT } from '@portal/contracts';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { parseBucketRoutes, routeByTags } from './bucketRoutes.js';
import { registerTicketTools } from './portalTools.js';
import { Tickets } from './service.js';
import { agent, FakeSessions, ticketsHarness, UI } from './testkit.js';

const routes = () => TICKET_BUCKET_ROUTES_DEFAULT;

test('the rules: exact tags beat prefix-*, a tie decides nothing, a bucket that cannot be used is skipped, junk is dropped', () => {
  const r = parseBucketRoutes(TICKET_BUCKET_ROUTES_DEFAULT);
  assert.deepEqual(
    r.map((x) => [x.bucket, x.tags, x.prefixes]),
    [
      ['PILOT', ['claudepilot', 'program-claudepilot'], []],
      ['KONF', ['konfersi-migration'], ['area-']],
      ['TB', ['tradingbot'], []],
    ],
  );
  const all = () => true;
  assert.deepEqual(routeByTags(r, ['area-envscreen'], all), { bucket: 'KONF', tag: 'area-envscreen', rule: 'area-*' });
  assert.deepEqual(routeByTags(r, ['konfersi-migration', 'ui'], all), { bucket: 'KONF', tag: 'konfersi-migration', rule: 'konfersi-migration' });
  // The portal's own tickets carry area-* too (area-sessions, area-qa from CI flakes): claudepilot, an exact tag, keeps them in PILOT.
  assert.deepEqual(routeByTags(r, ['area-sessions', 'claudepilot'], all), { bucket: 'PILOT', tag: 'claudepilot', rule: 'claudepilot' });
  // Many PILOT tickets carry program-claudepilot instead (T-2865): the same exact-tag win.
  assert.deepEqual(routeByTags(r, ['program-claudepilot', 'area-x'], all), { bucket: 'PILOT', tag: 'program-claudepilot', rule: 'program-claudepilot' });
  assert.equal(routeByTags(r, ['claudepilot', 'konfersi-migration'], all), null, 'two buckets by exact tags: no guess');
  assert.equal(routeByTags(r, ['area-'], all), null, 'the bare prefix is not a match');
  assert.equal(routeByTags(r, ['frontend'], all), null);
  assert.equal(routeByTags(r, ['tradingbot'], (k) => k !== 'TB'), null, 'a bucket that does not exist or is not the caller’s');
  assert.deepEqual(parseBucketRoutes('t: a; NOPE7: b; KONF: OK, bad!, -x, *, x*; konf: more'), [{ bucket: 'KONF', tags: ['ok', 'more'], prefixes: [] }]);
  assert.deepEqual(parseBucketRoutes(42), []);
  assert.deepEqual(parseBucketRoutes(''), []);
});

test('a Konfersi lead filing an [environmental-screening] ticket tagged area-* without a bucket lands in KONF, though its own ticket is in PILOT', async () => {
  const h = await ticketsHarness({ bucketRoutes: routes });
  try {
    // The lead's status ticket was misfiled in PILOT: before T-2881 the session-ticket rule copied that.
    const status = h.tickets.create(UI, { summary: 'Konfersi lead status' });
    assert.equal(status.bucket, 'PILOT');
    h.sessions.add({ id: 'konf-lead', workspaceId: 'kubernetes/claudepilot', title: 'Konfersi: lead', ticketId: status.id });
    const made = h.tickets.createExplained(agent('kubernetes/claudepilot', 'konf-lead'), {
      summary: '[environmental-screening] Upload form loses the site id on retry',
      tags: ['area-envscreen', 'bug'],
    });
    assert.equal(made.ticket.bucket, 'KONF');
    assert.match(made.ticket.key!, /^KONF-\d+$/);
    assert.deepEqual(made.bucket, { bucket: 'KONF', reason: 'tags', why: 'KONF: tag area-envscreen matches its rule area-* (tickets.bucketRoutes).' });
    assert.equal(h.tickets.get(UI, made.ticket.id).events[0]!.data!.bucketReason, 'tags', 'the created entry keeps the reason');
  } finally {
    h.done();
  }
});

test('a ClaudePilot dev session lands in PILOT: by its claudepilot tag, and with no tag at all by the default', async () => {
  const h = await ticketsHarness({ bucketRoutes: routes });
  try {
    h.sessions.add({ id: 'cp-dev', workspaceId: 'kubernetes/claudepilot', title: 'ClaudePilot: dev' });
    const caller = agent('kubernetes/claudepilot', 'cp-dev');
    const tagged = h.tickets.createExplained(caller, { summary: 'Sessions list jumps', tags: ['claudepilot', 'area-sessions'] });
    assert.deepEqual([tagged.ticket.bucket, tagged.bucket.reason], ['PILOT', 'tags']);
    const program = h.tickets.createExplained(caller, { summary: 'Perf of the portal', tags: ['program-claudepilot', 'area-x'] });
    assert.deepEqual([program.ticket.bucket, program.bucket.reason], ['PILOT', 'tags'], 'program-claudepilot with area-* stays in PILOT');
    const bare = h.tickets.createExplained(caller, { summary: 'Something else' });
    assert.deepEqual([bare.ticket.bucket, bare.bucket.reason], ['PILOT', 'default']);
    assert.match(bare.bucket.why, /nothing else decided/);
  } finally {
    h.done();
  }
});

test('the parent’s bucket is used when no tag decides; one the caller cannot see is ignored; tags beat it', async () => {
  const h = await ticketsHarness({ bucketRoutes: routes });
  try {
    const epic = h.tickets.create(UI, { summary: 'Epic', bucket: 'CP' });
    const elsewhere = h.tickets.create(UI, { summary: 'Other workspace epic', bucket: 'CP', workspaceId: 'docker/other' });
    h.sessions.add({ id: 'w1', workspaceId: 'docker/api' });
    const caller = agent('docker/api', 'w1');
    const child = h.tickets.createExplained(caller, { summary: 'A part of it', parent: epic.key! });
    assert.deepEqual(child.bucket, { bucket: 'CP', reason: 'parent', why: `CP: the bucket of the parent ${epic.id}.` });
    assert.equal(h.tickets.createExplained(caller, { summary: 'By stable id', parent: epic.id }).bucket.reason, 'parent');
    const hidden = h.tickets.createExplained(caller, { summary: 'Hidden parent', parent: elsewhere.id });
    assert.deepEqual([hidden.ticket.bucket, hidden.bucket.reason], ['PILOT', 'default'], 'another workspace’s ticket says nothing');
    assert.equal(h.tickets.createExplained(caller, { summary: 'Unknown parent', parent: 'T-9999' }).bucket.reason, 'default');
    assert.equal(h.tickets.createExplained(caller, { summary: 'Tagged', parent: epic.id, tags: ['area-x'] }).ticket.bucket, 'KONF');
  } finally {
    h.done();
  }
});

test('an explicit bucket wins over tags and parent; with no rules (the setting empty) the old order holds', async () => {
  const h = await ticketsHarness({ bucketRoutes: routes });
  try {
    const epic = h.tickets.create(UI, { summary: 'Epic', bucket: 'KONF' });
    const t = h.tickets.createExplained(UI, { summary: 'Named', bucket: 'cp', tags: ['konfersi-migration'], parent: epic.id });
    assert.deepEqual(t.bucket, { bucket: 'CP', reason: 'named', why: 'CP: named in the request.' });
    assert.equal(t.ticket.bucket, 'CP');
  } finally {
    h.done();
  }
  const off = await ticketsHarness({ bucketRoutes: () => '' });
  try {
    assert.deepEqual(off.tickets.createExplained(UI, { summary: 'x', tags: ['konfersi-migration'] }).bucket.reason, 'default');
  } finally {
    off.done();
  }
});

test('ticket_create over MCP names the bucket and the reason', async () => {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const sessions = new FakeSessions();
  const tickets = new Tickets(h.store, sessions, { bucketRoutes: routes });
  tickets.start();
  registerTicketTools(tickets, registry);
  try {
    sessions.add({ id: 'konf-lead', workspaceId: 'kubernetes/claudepilot', title: 'Konfersi: lead' });
    const a = await h.agentToken('kubernetes/claudepilot', 'konf-lead');
    const made = (await h.call(a.secret, 'ticket_create', { summary: '[environmental-screening] Map tiles blank', tags: ['area-envscreen'] })).result!.structuredContent as any;
    assert.deepEqual(made.bucket, { key: 'KONF', reason: 'tags', why: 'KONF: tag area-envscreen matches its rule area-* (tickets.bucketRoutes).' });
    assert.match(made.summary, / in KONF \(tags\)\.$/);
    assert.match(made.ticket.key, /^KONF-/);
    const named = (await h.call(a.secret, 'ticket_create', { summary: 'Named', bucket: 'PILOT', tags: ['area-envscreen'] })).result!.structuredContent as any;
    assert.deepEqual([named.bucket.key, named.bucket.reason], ['PILOT', 'named']);
    const parent = (await h.call(a.secret, 'ticket_create', { summary: 'Child', parent: made.ticket.id })).result!.structuredContent as any;
    assert.deepEqual([parent.bucket.key, parent.bucket.reason], ['KONF', 'parent']);
  } finally {
    tickets.stop();
    h.done();
  }
});
