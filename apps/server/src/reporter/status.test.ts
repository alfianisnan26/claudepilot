// The card's status menu (PILOT-1200): PATCH /reporter/v1/tickets/:key changes the status of a ticket of the token's bucket through the
// portal ticket page's own tickets.update (timeline event, closed_at, listeners), as the person "via reporter", and nothing else.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPORTER_LIMITS } from '@portal/contracts';
import { UI } from '../tickets/testkit.js';
import { PORTAL, STG, build, capture, reporterHarness } from './testkit.js';

type Json = { data?: any; error?: { code: string; message: string } };
const body = async (r: Response) => (await r.json()) as Json;

async function setup(audit?: (kind: string, detail: Record<string, unknown>, actor: string) => void) {
  const h = await reporterHarness(audit ? { audit } : {});
  const t = h.mint().token;
  const patch = (key: string, payload: unknown, token: string | null = t, headers: Record<string, string> = {}) =>
    h.call(`/reporter/v1/tickets/${key}`, {
      method: 'PATCH',
      ...(token ? { token } : {}),
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
  return { h, t, patch };
}

test('status: no token is 401, a cross-site caller and another bucket’s ticket are the same 404, and nothing changes', async () => {
  const { h, patch } = await setup();
  try {
    const mine = h.tickets.create(UI, { bucket: 'KONF', summary: 'On the panel' });
    const other = h.tickets.create(UI, { bucket: 'OTHER', summary: 'Not this bucket' });
    assert.equal((await patch(mine.key!, { status: 'in_progress' }, null)).status, 401);
    assert.equal(
      (await patch(mine.key!, { status: 'in_progress' }, undefined, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }))
        .status,
      404,
    );
    const r = await patch(other.key!, { status: 'done' });
    assert.equal(r.status, 404, 'another bucket’s ticket does not exist for the token');
    assert.equal((await patch(other.id, { status: 'done' })).status, 404, 'by its stable id too');
    assert.equal((await patch('KONF-99999', { status: 'done' })).status, 404);
    assert.equal(h.tickets.get(UI, other.key!).ticket.status, 'open');
    assert.equal(h.tickets.get(UI, mine.key!).ticket.status, 'open');
  } finally {
    h.done();
  }
});

test('status: an unknown status or none is 400 and nothing changes', async () => {
  const { h, patch } = await setup();
  try {
    const tk = h.tickets.create(UI, { bucket: 'KONF', summary: 'Bad input' });
    for (const bad of [{ status: 'closed' }, { status: 'DONE' }, { status: 3 }, {}, { priority: 'low' }]) {
      const r = await patch(tk.key!, bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal((await body(r)).error?.code, 'BAD_REQUEST');
    }
    const d = h.tickets.get(UI, tk.key!);
    assert.equal(d.ticket.status, 'open');
    assert.equal(d.ticket.priority, 'normal', 'a body without a status changed nothing else either');
  } finally {
    h.done();
  }
});

test('status: any ticket of the bucket, written as the person via reporter, the same events and closed_at as the ticket page; listeners told', async () => {
  const audits: { kind: string; detail: Record<string, unknown>; actor: string }[] = [];
  const { h, patch } = await setup((kind, detail, actor) => audits.push({ kind, detail, actor }));
  try {
    // Filed in the portal, not through the widget: the person may still change it from the panel.
    const tk = h.tickets.create(UI, { bucket: 'KONF', summary: 'Landing page adjust' });
    await new Promise((res) => setImmediate(res));
    const told: { ticketId: string; kind: string; actor: string }[] = [];
    const prev = h.tickets.onEvent;
    h.tickets.onEvent = (e) => {
      told.push({ ticketId: e.ticketId, kind: e.kind, actor: e.actor });
      prev?.(e);
    };
    let r = await patch(tk.key!, { status: 'in_review' });
    assert.equal(r.status, 200);
    let v = (await body(r)).data;
    assert.equal(v.key, tk.key);
    assert.equal(v.status, 'in_review');
    assert.equal(v.phase, 'review', 'the card’s view comes back with the new phase');
    let ev = h.tickets.get(UI, tk.key!).events.at(-1)!;
    assert.equal(ev.kind, 'status');
    assert.deepEqual(ev.data, { from: 'open', to: 'in_review' });
    assert.equal(ev.actorLabel, `Owner via reporter (${STG})`);
    assert.match(ev.actor, /^portal-mcp:rpt_/, 'the token is the actor, as a reply is');

    r = await patch(tk.key!, { status: 'done' });
    v = (await body(r)).data;
    assert.equal(v.phase, 'fixed');
    let d = h.tickets.get(UI, tk.key!);
    assert.equal(d.ticket.status, 'done');
    assert.ok(d.ticket.closedAt, 'closed_at set, as the ticket page sets it');
    assert.equal(d.events.at(-1)!.kind, 'closed');

    r = await patch(tk.key!, { status: 'open' });
    assert.equal(r.status, 200);
    d = h.tickets.get(UI, tk.key!);
    assert.equal(d.ticket.closedAt, null, 'reopened: closed_at cleared');
    assert.equal(d.events.at(-1)!.kind, 'reopened');

    // The same status again changes nothing and writes no event.
    const n = d.events.length;
    assert.equal((await patch(tk.key!, { status: 'open' })).status, 200);
    assert.equal(h.tickets.get(UI, tk.key!).events.length, n);

    await new Promise((res) => setImmediate(res));
    assert.deepEqual(
      told.filter((e) => e.ticketId === tk.id).map((e) => e.kind),
      ['status', 'closed', 'reopened'],
      'the tickets listeners (session notice, metrics) hear each change',
    );
    assert.ok(
      audits.some(
        (a) =>
          a.kind === 'reporter.ticket_status' &&
          a.detail.ticket === tk.key &&
          a.detail.status === 'done' &&
          a.actor.startsWith('reporter:'),
      ),
    );
  } finally {
    h.done();
  }
});

test('status: only the status changes, never the bucket, the assignee, the priority or anything else in the body', async () => {
  const { h, t, patch } = await setup();
  try {
    const made = (
      await body(
        await h.postJson('/reporter/v1/tickets', t, { summary: 'Hero cut off', captures: [capture()], build: build(), sdkVersion: '1' }),
      )
    ).data;
    const before = h.tickets.get(UI, made.key).ticket;
    const eventsBefore = h.tickets.get(UI, made.key).events.length;
    const r = await patch(made.key, {
      status: 'blocked',
      bucket: 'OTHER',
      assignee: { kind: 'user', name: 'someone' },
      priority: 'low',
      summary: 'Changed',
      description: 'Changed',
      tags: ['x'],
      type: 'chore',
      workspaceId: 'docker/elsewhere',
    });
    assert.equal(r.status, 200);
    const after = h.tickets.get(UI, made.key).ticket;
    assert.equal(after.status, 'blocked');
    for (const k of ['bucket', 'key', 'assignee', 'priority', 'summary', 'description', 'tags', 'type', 'workspaceId', 'reporter'] as const)
      assert.deepEqual(after[k], before[k], `${k} untouched`);
    assert.deepEqual(
      h.tickets
        .get(UI, made.key)
        .events.slice(eventsBefore)
        .map((e) => e.kind),
      ['status'],
      'one status event, nothing else',
    );
  } finally {
    h.done();
  }
});

test('status: a token makes at most statusChangesPer10Min changes; a refused key is not counted', async () => {
  const { h, patch } = await setup();
  try {
    const tk = h.tickets.create(UI, { bucket: 'KONF', summary: 'Flip' });
    const other = h.tickets.create(UI, { bucket: 'OTHER', summary: 'Not here' });
    for (let i = 0; i < 5; i++) assert.equal((await patch(other.key!, { status: 'done' })).status, 404);
    for (let i = 0; i < REPORTER_LIMITS.statusChangesPer10Min; i++)
      assert.equal((await patch(tk.key!, { status: i % 2 ? 'open' : 'in_progress' })).status, 200, `change ${i + 1}`);
    const r = await patch(tk.key!, { status: 'blocked' });
    assert.equal(r.status, 429);
    assert.notEqual(h.tickets.get(UI, tk.key!).ticket.status, 'blocked');
  } finally {
    h.done();
  }
});

test('status: the route is in REPORTER_ROUTES and answers same-origin only', async () => {
  const { REPORTER_ROUTES } = await import('@portal/contracts');
  assert.equal(REPORTER_ROUTES.ticketStatus, '/reporter/v1/tickets/:key');
  const { h, patch } = await setup();
  try {
    const tk = h.tickets.create(UI, { bucket: 'KONF', summary: 'Same origin' });
    assert.equal(
      (await patch(tk.key!, { status: 'in_progress' }, undefined, { origin: PORTAL, 'sec-fetch-site': 'same-origin' })).status,
      200,
    );
    assert.equal(
      (await patch(tk.key!, { status: 'open' }, undefined, { origin: STG })).status,
      404,
      'the host page itself can not call it',
    );
  } finally {
    h.done();
  }
});
