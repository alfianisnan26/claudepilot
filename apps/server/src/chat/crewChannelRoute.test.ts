// T-294 slice 3, the server half: GET /api/chat/sessions/:id/crew-channel?after=&limit= serves one read-only page of the crew channel a
// session leads to a person's thread (CHAT_API.crewChannel, CrewChannelPage). Declared and checked through the seam with `view`, the same
// 404 as GET /sessions/:id for a session that is hidden or missing (whatever the parameters), never for an agent; a read never moves any
// member's cursor; the text is scrubbed again on the way out. Fixtures (secrets included) are built here, at run time.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { CHAT_API, CREW_CHANNEL_LIMIT_MAX, type CrewChannelPage } from '@portal/contracts';
import { Hono } from 'hono';
import { clearResolvers, declaredPolicies } from '../authz/seam.js';
import type { AgentCaps } from './agents.js';
import { registerChatAuthz } from './authz.js';
import { createChatRoutes, crewChannelQuery } from './routes.js';
import { liveSession, until, type Live } from './testkit.js';

afterEach(() => clearResolvers());

const CAPS: AgentCaps = { maxDepth: 2, maxChildren: 5, spawnsPerHour: 20, messagesPerHour: 40 };

/** A lead (liveSession's) with two workers. */
async function rig() {
  const s = await liveSession();
  s.controller.agentCaps = () => CAPS;
  const made = async (title: string, parentId: string) => {
    const before = s.ws.tails.length;
    const c = await s.controller.create({ workspaceId: 'docker/ws1', title }, { actor: `session:${parentId}`, parentId });
    await until(() => s.ws.tails.length === before + 1);
    await until(() => s.controller.get(c.id)?.state === 'idle');
    return c;
  };
  const w1 = await made('Router', s.id);
  const w2 = await made('Tests', s.id);
  registerChatAuthz((id) => s.controller.sessionFacts(id));
  return { s, w1, w2, made };
}

const app = (s: Live, actor: unknown = 'owner') => {
  const a = new Hono();
  a.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    return c.json(err.toJSON(), err.status as 404);
  });
  a.use(async (c, next) => {
    if (actor === 'owner') (c as unknown as { set(k: string, v: unknown): void }).set('token', 'signed-in');
    else if (actor) (c as unknown as { set(k: string, v: unknown): void }).set('actor', actor);
    await next();
  });
  a.route('/', createChatRoutes(s.controller));
  return a;
};
/** The route as the web asks it (CHAT_API.crewChannel), relative to where createChatRoutes is mounted. */
const path = (id: string, q = '') => `${CHAT_API.crewChannel(id).replace('/api/chat/sessions', '')}${q}`;
const page = async (res: Response): Promise<CrewChannelPage> => {
  assert.equal(res.status, 200);
  return ((await res.json()) as { data: CrewChannelPage }).data;
};
const texts = (p: CrewChannelPage) => p.items.map((m) => m.text);
const cursors = (s: Live) =>
  s.store.db!.prepare('SELECT lead_id, session_id, last_id FROM crew_cursors ORDER BY lead_id, session_id').all();

test('T-294 crew-channel route: the lead’s channel, oldest first, paged with after and limit, cursor and more; the web’s path', async () => {
  const { s, w1 } = await rig();
  try {
    const owner = app(s);
    for (const [who, t] of [
      [s.id, 'one'],
      [w1.id, 'two'],
      [s.id, 'three'],
      [w1.id, 'four'],
      [s.id, 'five'],
    ] as const)
      s.controller.crewPost(who, t);

    const all = await page(await owner.request(path(s.id)));
    assert.deepEqual(texts(all), ['one', 'two', 'three', 'four', 'five'], 'no parameter: from the first kept, oldest first');
    assert.deepEqual(
      all.items.map((m) => m.from),
      [s.id, w1.id, s.id, w1.id, s.id],
    );
    assert.ok(all.items.every((m) => typeof m.id === 'number' && typeof m.at === 'string'));
    assert.equal(all.more, false);
    assert.equal(all.cursor, all.items.at(-1)!.id);

    const first = await page(await owner.request(path(s.id, '?limit=2')));
    assert.deepEqual(texts(first), ['one', 'two']);
    assert.equal(first.more, true);
    assert.equal(first.cursor, first.items[1]!.id);
    const second = await page(await owner.request(path(s.id, `?after=${first.cursor}&limit=2`)));
    assert.deepEqual(texts(second), ['three', 'four']);
    assert.equal(second.more, true);
    const last = await page(await owner.request(path(s.id, `?after=${second.cursor}&limit=2`)));
    assert.deepEqual(texts(last), ['five']);
    assert.equal(last.more, false);
    const none = await page(await owner.request(path(s.id, `?after=${last.cursor}`)));
    assert.deepEqual(none, { items: [], cursor: last.cursor, more: false }, 'nothing new: the cursor stays where it was asked');

    // Exactly what chatApi.crewChannel sends (after omitted for 0, limit 100).
    assert.deepEqual(texts(await page(await owner.request(path(s.id, `?limit=${CREW_CHANNEL_LIMIT_MAX}`)))), texts(all));
    // A worker's page is its own crew (none here), never its parent’s channel.
    assert.deepEqual(await page(await owner.request(path(w1.id))), { items: [], cursor: 0, more: false });
  } finally {
    await s.done();
  }
});

test('T-294 crew-channel route: a worker with workers of its own leads their channel; its page shows that one, not its parent’s', async () => {
  const { s, w1, made } = await rig();
  try {
    const gw = await made('Grandchild', w1.id);
    s.controller.crewPost(gw.id, 'from the grandchild');
    s.controller.crewPost(s.id, 'for the lead’s crew');
    const owner = app(s);
    assert.deepEqual(texts(await page(await owner.request(path(w1.id)))), ['from the grandchild']);
    assert.deepEqual(texts(await page(await owner.request(path(s.id)))), ['for the lead’s crew']);
  } finally {
    await s.done();
  }
});

test('T-294 crew-channel route: a person reading never moves a member’s cursor, nor makes one', async () => {
  const { s, w1, w2 } = await rig();
  try {
    const owner = app(s);
    for (const t of ['one', 'two', 'three']) s.controller.crewPost(w1.id, t);
    // w2 reads two (its cursor moves); the lead and w1 have read nothing.
    assert.deepEqual(
      s.controller.crewRead(w2.id, { limit: 2 }).items.map((m) => m.text),
      ['one', 'two'],
    );
    const before = cursors(s);
    assert.equal(before.length, 1, JSON.stringify(before));

    for (const q of ['', '?limit=1', '?after=0&limit=100', '?after=1']) await page(await owner.request(path(s.id, q)));
    assert.deepEqual(cursors(s), before, 'the stored cursors are exactly as they were');

    // Each member goes on from its own place, untouched by the person's reads.
    assert.deepEqual(
      s.controller.crewRead(w2.id).items.map((m) => m.text),
      ['three'],
    );
    assert.deepEqual(
      s.controller.crewRead(s.id).items.map((m) => m.text),
      ['one', 'two', 'three'],
      'the lead still has all three as new',
    );
    assert.deepEqual(
      s.controller.crewRead(w1.id).items.map((m) => m.text),
      ['one', 'two', 'three'],
    );
  } finally {
    await s.done();
  }
});

test('T-294 crew-channel route: declared with view; another user, an agent, an unknown id get the same 404 as GET /sessions/:id, even with bad parameters; signed out is refused', async () => {
  const { s, w1 } = await rig();
  try {
    s.controller.crewPost(w1.id, 'only for the crew');
    assert.deepEqual(declaredPolicies().get('GET /api/chat/sessions/:id/crew-channel'), {
      kind: 'objects',
      checks: [{ type: 'session', verb: 'view', from: 'path', param: 'id' }],
    });

    const owner = app(s);
    const unknownOne = await owner.request(`/no-such-session`);
    assert.equal(unknownOne.status, 404);
    const shape = await unknownOne.json();
    const unknown = await owner.request(path('no-such-session'));
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), shape, 'an unknown id answers as GET /sessions/:id does');

    const other = app(s, { kind: 'user', userId: 'u_a', loginSessionId: 'l1', via: 'ui' });
    const agentOfLead = app(s, { kind: 'agent', userId: 'u_owner', tokenId: 't1', sessionId: s.id, workspaceId: 'docker/ws1' });
    const agentElsewhere = app(s, { kind: 'agent', userId: 'u_owner', tokenId: 't2', sessionId: w1.id, workspaceId: 'docker/ws1' });
    for (const [label, a] of [
      ['another user', other],
      ['the lead’s own agent', agentOfLead],
      ['another session’s agent', agentElsewhere],
    ] as const) {
      for (const q of ['', '?limit=0', '?after=x', `?limit=${CREW_CHANNEL_LIMIT_MAX + 1}`]) {
        const res = await a.request(path(s.id, q));
        assert.equal(res.status, 404, `${label} ${q}`);
        const body = await res.text();
        assert.deepEqual(JSON.parse(body), shape, `${label} ${q}: the same body as a missing session`);
        assert.ok(!body.includes('only for the crew') && !body.includes(w1.id), `${label} ${q}`);
      }
    }
    const signedOut = await app(s, null).request(path(s.id));
    assert.equal(signedOut.status, 401);
    assert.ok(!(await signedOut.text()).includes('only for the crew'));
  } finally {
    await s.done();
  }
});

test('T-294 crew-channel route: bad parameters are a 422 naming the parameter; the parser keeps the bounds', async () => {
  const { s } = await rig();
  try {
    const owner = app(s);
    for (const [q, field] of [
      ['?limit=0', 'limit'],
      [`?limit=${CREW_CHANNEL_LIMIT_MAX + 1}`, 'limit'],
      ['?limit=abc', 'limit'],
      ['?limit=1.5', 'limit'],
      ['?limit=-3', 'limit'],
      ['?limit=%201', 'limit'],
      ['?after=-1', 'after'],
      ['?after=x', 'after'],
      ['?after=1e3', 'after'],
      ['?after=99999999999999999999', 'after'],
    ] as const) {
      const res = await owner.request(path(s.id, q));
      assert.equal(res.status, 422, q);
      const body = (await res.json()) as { error: { code: string; details?: Record<string, string> } };
      assert.equal(body.error.code, 'VALIDATION_FAILED', q);
      assert.ok(body.error.details?.[field], `${q} names ${field}`);
    }
    assert.deepEqual(crewChannelQuery({}), { after: 0, limit: CREW_CHANNEL_LIMIT_MAX });
    assert.deepEqual(crewChannelQuery({ after: '', limit: '' }), { after: 0, limit: CREW_CHANNEL_LIMIT_MAX });
    assert.deepEqual(crewChannelQuery({ after: '0', limit: '1' }), { after: 0, limit: 1 });
    assert.deepEqual(crewChannelQuery({ after: '42', limit: String(CREW_CHANNEL_LIMIT_MAX) }), {
      after: 42,
      limit: CREW_CHANNEL_LIMIT_MAX,
    });
  } finally {
    await s.done();
  }
});

test('T-294 crew-channel route: the text is scrubbed on the way out: a token shape, the lead workspace’s secret value and the author workspace’s', async () => {
  const { s, w1, w2 } = await rig();
  try {
    const shaped = `cpat_${'a1b2c3d4'.repeat(4)}`; // built at runtime: a portal token shape
    const leadValue = `lead-value-${randomUUID().slice(0, 8)}`; // built at runtime: no known shape
    const authorValue = `author-value-${randomUUID().slice(0, 8)}`;
    // w2 runs in another workspace (moved there for the test): its workspace's secret values are scrubbed from what it wrote.
    s.store.db!.prepare('UPDATE chat_sessions SET workspace_id = ? WHERE id = ?').run('docker/ws2', w2.id);
    s.controller.secretValues = (ws) => (ws === 'docker/ws1' ? [leadValue] : ws === 'docker/ws2' ? [authorValue] : []);
    // Rows that reached the table unredacted (an older build, a restore, a secret added later).
    const insert = s.store.db!.prepare('INSERT INTO crew_messages (lead_id, from_id, text, at) VALUES (?, ?, ?, ?)');
    const at = new Date().toISOString();
    insert.run(s.id, w1.id, `raw ${shaped} here`, at);
    insert.run(s.id, w1.id, `the db password is ${leadValue}`, at);
    insert.run(s.id, w2.id, `mine is ${authorValue}`, at);

    const res = await app(s).request(path(s.id));
    const body = await res.clone().text();
    for (const v of [shaped, leadValue, authorValue]) assert.ok(!body.includes(v), 'nothing unredacted in the answer');
    const out = texts(await page(res));
    assert.equal(out.length, 3);
    assert.equal(out[0], 'raw [redacted] here');
    assert.ok(out[1]!.startsWith('the db password is ') && out[2]!.startsWith('mine is '), JSON.stringify(out));
  } finally {
    await s.done();
  }
});
