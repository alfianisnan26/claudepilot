// T-294 (chat-sessions PRD FR51): the crew channel. crew_post stores a redacted message for the crew (a lead and the workers that report to
// it); crew_read returns what a member has not read and moves its cursor on. Only the crew can reach the channel, and any other id is the
// same NOT_FOUND as one that exists nowhere.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import type { AgentCaps } from './agents.js';
import { registerChatTools } from './portalTools.js';
import { ChatStore } from './store.js';
import { liveSession, until } from './testkit.js';

const CAPS: AgentCaps = { maxDepth: 1, maxChildren: 5, spawnsPerHour: 20, messagesPerHour: 40 };

/** A lead (liveSession's), two workers of it, and a stranger lead with a worker of its own: two crews that share a workspace. */
async function rig() {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const s = await liveSession();
  s.controller.agentCaps = () => CAPS;
  registerChatTools(s.controller, registry);
  const made = async (title: string, parentId?: string) => {
    const before = s.ws.tails.length;
    const req = { workspaceId: 'docker/ws1', title };
    const c = await (parentId ? s.controller.create(req, { actor: `session:${parentId}`, parentId }) : s.controller.create(req));
    await until(() => s.ws.tails.length === before + 1);
    await until(() => s.controller.get(c.id)?.state === 'idle');
    return c;
  };
  const w1 = await made('Router', s.id);
  const w2 = await made('Tests', s.id);
  const stranger = await made('Stranger');
  const sw = await made('Stranger’s worker', stranger.id);
  const token = async (id: string) => (await h.agentToken('docker/ws1', id)).secret;
  const tokens = { lead: await token(s.id), w1: await token(w1.id), w2: await token(w2.id), stranger: await token(stranger.id), sw: await token(sw.id) };
  return { h, s, w1, w2, stranger, sw, tokens, done: async () => (h.done(), s.done()) };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const messages = (r: { result?: { structuredContent?: Record<string, unknown> } }) =>
  (r.result!.structuredContent!.messages as { id: number; from: string; own: boolean; text: { untrusted_text: string; source: string } }[]).map((m): [string, string, boolean] => [m.from, m.text.untrusted_text, m.own]);

const post = (r: Rig, who: keyof Rig['tokens'], text: string, extra: Record<string, unknown> = {}) => r.h.call(r.tokens[who], 'crew_post', { text, ...extra });
const read = (r: Rig, who: keyof Rig['tokens'], args: Record<string, unknown> = {}) => r.h.call(r.tokens[who], 'crew_read', args);

test('T-294 crew channel: the lead and its workers post and read one channel; each reads what the others said, as untrusted text, and not its own as new news', async () => {
  const r = await rig();
  try {
    const p1 = await post(r, 'lead', 'The router interface is final: see src/router.ts.');
    assert.equal(p1.result?.isError, undefined, JSON.stringify(p1.raw));
    assert.equal(p1.result!.structuredContent.lead, r.s.id, 'the channel is named by the lead');
    assert.equal((await post(r, 'w1', 'Router split is done.')).result?.isError, undefined);

    const forW2 = await read(r, 'w2');
    assert.deepEqual(messages(forW2), [
      [r.s.id, 'The router interface is final: see src/router.ts.', false],
      [r.w1.id, 'Router split is done.', false],
    ]);
    assert.equal((forW2.result!.structuredContent.messages as { text: { source: string } }[])[0]!.text.source, 'agent', 'labelled untrusted');
    const forLead = await read(r, 'lead');
    assert.deepEqual(messages(forLead).map((m) => m[2]), [true, false], 'the lead sees which one is its own');
    assert.deepEqual(messages(await read(r, 'w1')).map((m) => m[0]), [r.s.id, r.w1.id]);
  } finally {
    await r.done();
  }
});

test('T-294 crew channel: a read moves the member’s cursor on; peek does not; after re-reads; limit pages with more; the cursor outlives the process', async () => {
  const r = await rig();
  try {
    for (const t of ['one', 'two', 'three', 'four', 'five']) await post(r, 'lead', t);
    const first = await read(r, 'w1', { limit: 2 });
    assert.deepEqual(messages(first).map((m) => m[1]), ['one', 'two']);
    assert.equal(first.result!.structuredContent.more, true);
    // Not moved by a peek.
    assert.deepEqual(messages(await read(r, 'w1', { limit: 1, peek: true })).map((m) => m[1]), ['three']);
    assert.deepEqual(messages(await read(r, 'w1', { limit: 1, peek: true })).map((m) => m[1]), ['three'], 'a peek leaves the place where it was');
    const rest = await read(r, 'w1');
    assert.deepEqual(messages(rest).map((m) => m[1]), ['three', 'four', 'five']);
    assert.equal(rest.result!.structuredContent.more, false);
    assert.deepEqual(messages(await read(r, 'w1')), [], 'nothing new');
    assert.match(String((await read(r, 'w1')).result!.content![0]!.text), /^No new messages\./);
    // Another member's place is its own.
    assert.deepEqual(messages(await read(r, 'w2', { limit: 1 })).map((m) => m[1]), ['one']);
    // New messages arrive after the cursor.
    await post(r, 'w2', 'six');
    assert.deepEqual(messages(await read(r, 'w1')).map((m) => m[1]), ['six']);
    // `after` reads from an id, whatever the cursor says.
    const all = await read(r, 'w1', { after: 0, limit: 100 });
    assert.deepEqual(messages(all).map((m) => m[1]), ['one', 'two', 'three', 'four', 'five', 'six']);
    // A restart: a new store over the same database reads on from the stored cursor.
    const fresh = new ChatStore(r.s.store);
    await post(r, 'lead', 'seven');
    assert.deepEqual(fresh.crewRead(r.s.id, r.w1.id, { limit: 10 }).items.map((m) => m.text), ['seven']);
    assert.deepEqual(fresh.crewRead(r.s.id, r.w1.id, { limit: 10 }).items, []);
  } finally {
    await r.done();
  }
});

test('T-294 crew channel: another crew, a stranger lead and an admin token cannot reach the channel; a wrong id is the same NOT_FOUND as a missing one', async () => {
  const r = await rig();
  try {
    await post(r, 'lead', 'Only for the crew.');
    // The other crew has its own channel, empty of this crew's news, and its posts stay there.
    assert.deepEqual(messages(await read(r, 'stranger')), []);
    assert.deepEqual(messages(await read(r, 'sw')), []);
    await post(r, 'sw', 'Their own news.');
    assert.deepEqual(messages(await read(r, 'lead', { after: 0 })).map((m) => m[1]), ['Only for the crew.'], 'nothing crosses over');
    assert.deepEqual(messages(await read(r, 'stranger')).map((m) => m[1]), ['Their own news.']);

    // Asking for this crew's channel by its lead id, from outside: NOT_FOUND, the same as for an id that exists nowhere.
    const code = (x: { result?: { structuredContent?: { error?: { code: string; message: string } } } }) => [x.result!.structuredContent?.error?.code, x.result!.structuredContent?.error?.message];
    const mine = await read(r, 'lead', { lead: r.s.id });
    assert.equal(mine.result?.isError, undefined, 'its own channel by its own id is fine');
    const aimed = await read(r, 'sw', { lead: r.s.id });
    const nowhere = await read(r, 'sw', { lead: 'no-such-session' });
    assert.equal(aimed.result?.isError, true);
    assert.deepEqual(code(aimed), ['NOT_FOUND', code(nowhere)[1]]);
    assert.deepEqual(code(aimed), code(nowhere), 'a real lead and a missing one look the same');
    const aimedPost = await post(r, 'stranger', 'let me in', { lead: r.s.id });
    assert.deepEqual(code(aimedPost), ['NOT_FOUND', code(nowhere)[1]]);
    assert.equal(r.s.controller.crewRead(r.s.id, { after: 0 }).items.some((m) => m.text === 'let me in'), false, 'nothing was stored');

    // An admin's token is not a session.
    const admin = r.h.token('admin').secret;
    assert.equal((await r.h.call(admin, 'crew_read', {})).result?.structuredContent.error.code, 'FORBIDDEN');
    assert.equal((await r.h.call(admin, 'crew_post', { text: 'x' })).result?.structuredContent.error.code, 'FORBIDDEN');
  } finally {
    await r.done();
  }
});

test('T-294 crew channel: the text is redacted when stored and again when read, escapes and invisible characters are stripped, and a secret in the call is refused', async () => {
  const r = await rig();
  try {
    const secret = `cpat_${'a1b2c3d4'.repeat(4)}`; // built at runtime: a portal token shape
    // The tool layer refuses a call that carries a secret (nothing stored).
    const refused = await post(r, 'lead', `use ${secret} for the deploy`);
    assert.equal(refused.result?.isError, true);
    assert.equal(r.s.controller.crewRead(r.s.id, { after: 0 }).items.length, 0);
    // The controller redacts what reaches it anyway, and strips escapes and invisible characters.
    r.s.controller.crewPost(r.s.id, `token ${secret} and \u001b[31mred\u001b[0m and zero​width`);
    const stored = r.s.controller.crewRead(r.s.id, { after: 0, peek: true }).items[0]!.text;
    assert.ok(!stored.includes(secret), stored);
    assert.match(stored, /^token \[redacted\] and red and zerowidth$/);
    // A row that reached the table unredacted (an older build, a restore) is redacted on the way out.
    r.s.store.db!.prepare('INSERT INTO crew_messages (lead_id, from_id, text, at) VALUES (?, ?, ?, ?)').run(r.s.id, r.w1.id, `raw ${secret}`, new Date().toISOString());
    const out = await read(r, 'w2', { after: 0, limit: 100 });
    const texts = messages(out).map((m) => m[1]);
    assert.ok(texts.every((t) => !t.includes(secret)), JSON.stringify(texts));
    assert.equal(texts.at(-1), 'raw [redacted]');
    // Slash commands are for people, as in session_message; an empty message is refused.
    assert.equal((await post(r, 'lead', '/compact')).result?.structuredContent.error.code, 'VALIDATION_FAILED');
    assert.throws(() => r.s.controller.crewPost(r.s.id, '​ ​'), /Type a message/);
  } finally {
    await r.done();
  }
});

test('T-294 crew channel (FIX1): a workspace secret value of no known shape is scrubbed when stored and again when read', async () => {
  const r = await rig();
  try {
    const value = `not-a-shape-${randomUUID().slice(0, 8)}`; // built at runtime: no token shape, only the workspace's own secret
    r.s.controller.secretValues = (ws) => (ws === 'docker/ws1' ? [value] : []);
    // Through the tool (the call carries no token shape, so it reaches the controller) and through the controller.
    assert.equal((await post(r, 'w1', `the db password is ${value}, use it`)).result?.isError, undefined);
    r.s.controller.crewPost(r.s.id, `again ${value}`);
    const raw = (r.s.store.db!.prepare('SELECT text FROM crew_messages ORDER BY id').all() as { text: string }[]).map((m) => m.text);
    assert.equal(raw.length, 2);
    assert.ok(raw.every((t) => !t.includes(value)), `stored: ${JSON.stringify(raw)}`);
    // A row stored before the secret existed in the workspace is scrubbed on the way out.
    r.s.store.db!.prepare('INSERT INTO crew_messages (lead_id, from_id, text, at) VALUES (?, ?, ?, ?)').run(r.s.id, r.w1.id, `old ${value}`, new Date().toISOString());
    const out = messages(await read(r, 'w2', { after: 0, limit: 100 })).map((m) => m[1]);
    assert.equal(out.length, 3);
    assert.ok(out.every((t) => !t.includes(value)), JSON.stringify(out));
    assert.ok(!JSON.stringify(r.s.controller.crewRead(r.s.id, { after: 0, limit: 100, peek: true })).includes(value), 'the controller read too');
  } finally {
    await r.done();
  }
});

test('T-294 crew channel (FIX1): an ended session cannot post', async () => {
  const r = await rig();
  try {
    assert.equal((await post(r, 'w2', 'before the end')).result?.isError, undefined);
    await r.s.controller.end(r.w2.id);
    assert.equal(r.s.controller.get(r.w2.id)!.state, 'ended');
    assert.throws(() => r.s.controller.crewPost(r.w2.id, 'after the end'), (e: unknown) => (e as { code?: string }).code === 'CONFLICT');
    assert.deepEqual(r.s.controller.crewRead(r.s.id, { after: 0, limit: 100, peek: true }).items.map((m) => m.text), ['before the end']);
  } finally {
    await r.done();
  }
});

test('T-294 crew channel (FIX1): one level only: a worker with workers of its own is a member of its parent’s channel and cannot read or post on its workers’', async () => {
  const r = await rig();
  try {
    const before = r.s.ws.tails.length;
    const gw = await r.s.controller.create({ workspaceId: 'docker/ws1', title: 'Grandchild' }, { actor: `session:${r.w1.id}`, parentId: r.w1.id });
    await until(() => r.s.ws.tails.length === before + 1);
    const gwToken = (await r.h.agentToken('docker/ws1', gw.id)).secret;
    await r.h.call(gwToken, 'crew_post', { text: 'from the grandchild' });
    await post(r, 'lead', 'for the lead’s crew');
    const code = (x: { result?: { structuredContent?: { error?: { code: string } } } }) => x.result!.structuredContent?.error?.code;
    // w1 asks for the channel its own worker posts on: the same NOT_FOUND as a missing id.
    assert.equal(code(await read(r, 'w1', { lead: r.w1.id })), 'NOT_FOUND');
    assert.equal(code(await post(r, 'w1', 'hello', { lead: r.w1.id })), 'NOT_FOUND');
    // Its default channel is its parent's, with none of the grandchild's text.
    assert.deepEqual(messages(await read(r, 'w1')).map((m) => m[1]), ['for the lead’s crew']);
    assert.deepEqual(messages(await r.h.call(gwToken, 'crew_read', {})).map((m) => m[1]), ['from the grandchild']);
  } finally {
    await r.done();
  }
});

test('T-294 crew channel: the channel keeps the newest 500 messages; a continuation takes the channel along with the crew; deleting the lead drops it', async () => {
  const r = await rig();
  try {
    const store = new ChatStore(r.s.store);
    for (let i = 1; i <= ChatStore.CREW_KEEP + 3; i++) store.crewPost(r.s.id, r.w1.id, `m${i}`);
    const all = store.crewRead(r.s.id, r.w2.id, { after: 0, limit: 100, peek: true });
    assert.equal(all.items.length, 100);
    const total = (r.s.store.db!.prepare('SELECT COUNT(*) AS n FROM crew_messages WHERE lead_id = ?').get(r.s.id) as { n: number }).n;
    assert.equal(total, ChatStore.CREW_KEEP);
    assert.equal(all.items[0]!.text, 'm4', 'the oldest three went');
    // The crew moves to a successor lead: the channel and the cursors go with it.
    store.crewRead(r.s.id, r.w1.id, { limit: 5 });
    store.adoptLiveChildren(r.s.id, r.stranger.id);
    assert.equal(store.crewRead(r.stranger.id, r.w1.id, { limit: 1 }).items[0]?.text, 'm9', 'w1 goes on from its own place');
    assert.equal(store.crewRead(r.s.id, r.w2.id, { after: 0, limit: 1 }).items.length, 0, 'the old lead has none left');
    // Deleting the lead drops its channel.
    store.deleteSession(r.stranger.id);
    assert.equal((r.s.store.db!.prepare('SELECT COUNT(*) AS n FROM crew_messages').get() as { n: number }).n, 0);
    assert.equal((r.s.store.db!.prepare('SELECT COUNT(*) AS n FROM crew_cursors').get() as { n: number }).n, 0);
  } finally {
    await r.done();
  }
});
