// The stored transcript over HTTP (T-376): GET /api/chat/sessions/:id/events pages from the newest with ?before=&limit= (oldest first,
// `more`, tool_result previews that keep their whole length), ?after= and no parameter answer exactly as before (the whole array),
// GET …/events/:seq returns one event whole, both are declared and give another user the same 404 as none, and JSON answers are
// gzip-compressed when the client accepts it while an event stream never is (jsonCompress.ts). Fixtures are built here, at run time.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { AppError, isAppError } from '@isnanme/core';
import { EVENT_PAGE_LIMIT, EVENT_PREVIEW_CHARS, type ChatEvent, type ChatEventPage } from '@portal/contracts';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { clearResolvers, declaredPolicies } from '../authz/seam.js';
import { jsonCompress } from '../jsonCompress.js';
import { registerChatAuthz } from './authz.js';
import { createChatRoutes } from './routes.js';
import { line, liveSession, until, type Live } from './testkit.js';

afterEach(() => clearResolvers());

const TEXTS = 250;
const say = (i: number) => line({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: `message ${i}` }] }, parent_tool_use_id: null, uuid: `a-${i}` });
const call = (id: string) => line({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls -la' } }] }, parent_tool_use_id: null, uuid: `c-${id}` });
const result = (id: string, text: string) =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] }, parent_tool_use_id: null });
/** A long, plain tool output (no secret-shaped text): numbered lines. */
const LONG_OUTPUT = Array.from({ length: 600 }, (_, i) => `listing line ${i} of the folder`).join('\n');

/** A session with TEXTS assistant messages, then one Bash call whose result is long. */
async function seeded(): Promise<Live> {
  const s = await liveSession();
  for (let i = 0; i < TEXTS; i++) s.tail.push(say(i));
  s.tail.push(call('toolu_long'));
  s.tail.push(result('toolu_long', LONG_OUTPUT));
  await until(() => s.controller.history(s.id).some((e) => e.kind === 'tool_result' && e.toolUseId === 'toolu_long'), 10_000);
  return s;
}

const app = (s: Live, actor: unknown = 'owner', withCompress = false) => {
  const a = new Hono();
  a.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    return c.json(err.toJSON(), err.status as 404);
  });
  a.use(async (c, next) => {
    if (actor === 'owner') ((c as unknown as { set(k: string, v: unknown): void }).set('token', 'signed-in'), (c as unknown as { set(k: string, v: unknown): void }).set('actor', { kind: 'user', userId: 'u_owner', loginSessionId: 'legacy', via: 'ui' }));
    else if (actor) (c as unknown as { set(k: string, v: unknown): void }).set('actor', actor);
    await next();
  });
  if (withCompress) a.use(jsonCompress());
  a.route('/', createChatRoutes(s.controller));
  return a;
};
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data;
const seqs = (events: ChatEvent[]) => events.map((e) => e.seq);

test('pages: from the newest, oldest first, more and before, walked back to the first event with nothing lost or repeated', async () => {
  const s = await seeded();
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    const owner = app(s);
    const whole = s.controller.history(s.id);
    assert.ok(whole.length > TEXTS, `seeded ${whole.length}`);

    const res = await owner.request(`/${s.id}/events?limit=50`);
    assert.equal(res.status, 200);
    const first = await data<ChatEventPage>(res);
    assert.deepEqual(seqs(first.events), seqs(whole.slice(-50)), 'the newest 50, oldest first');
    assert.equal(first.more, true);
    assert.equal(first.before, first.events[0]!.seq);

    const second = await data<ChatEventPage>(await owner.request(`/${s.id}/events?before=${first.before}&limit=50`));
    assert.deepEqual(seqs(second.events), seqs(whole.slice(-100, -50)));

    const walked: number[] = [];
    let before: number | null = null;
    for (let pages = 0; pages < 100; pages++) {
      const page: ChatEventPage = await data<ChatEventPage>(await owner.request(`/${s.id}/events?limit=37${before === null ? '' : `&before=${before}`}`));
      walked.unshift(...seqs(page.events));
      if (!page.more) {
        assert.equal(page.before, null);
        break;
      }
      before = page.before;
    }
    assert.deepEqual(walked, seqs(whole), 'every event once, in order');

    const byDefault = await data<ChatEventPage>(await owner.request(`/${s.id}/events?before=`));
    assert.equal(byDefault.events.length, EVENT_PAGE_LIMIT, 'no limit: the default page size');
    assert.deepEqual(seqs(byDefault.events), seqs(whole.slice(-EVENT_PAGE_LIMIT)));

    assert.equal((await owner.request(`/${s.id}/events?limit=0`)).status, 422);
    assert.equal((await owner.request(`/${s.id}/events?after=3&limit=10`)).status, 422, 'after does not mix with a page');
  } finally {
    await s.done();
  }
});

test('after and no parameter answer exactly as before T-376: the whole events after a seq, as an array, nothing cut', async () => {
  const s = await seeded();
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    const owner = app(s);
    const whole = s.controller.history(s.id);
    const all = await data<ChatEvent[]>(await owner.request(`/${s.id}/events`));
    assert.ok(Array.isArray(all), 'old clients still get an array');
    assert.deepEqual(all, JSON.parse(JSON.stringify(whole)));
    const after = await data<ChatEvent[]>(await owner.request(`/${s.id}/events?after=${whole[9]!.seq}`));
    assert.deepEqual(seqs(after), seqs(whole.slice(10)));
    const tool = after.find((e) => e.kind === 'tool_result')!;
    assert.equal(tool.textLength, undefined, 'the after form never cuts');
    assert.ok(tool.text!.length > EVENT_PREVIEW_CHARS);
  } finally {
    await s.done();
  }
});

test('a page cuts a long tool_result to a preview with its whole length; GET …/events/:seq returns it whole', async () => {
  const s = await seeded();
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    const owner = app(s);
    const stored = s.controller.history(s.id).find((e) => e.kind === 'tool_result')!;
    assert.ok(stored.text!.length > EVENT_PREVIEW_CHARS, `stored ${stored.text!.length} characters`);

    const page = await data<ChatEventPage>(await owner.request(`/${s.id}/events?limit=5`));
    const cut = page.events.find((e) => e.kind === 'tool_result')!;
    assert.equal(cut.seq, stored.seq);
    assert.equal(cut.text, stored.text!.slice(0, EVENT_PREVIEW_CHARS));
    assert.equal(cut.textLength, stored.text!.length);

    const res = await owner.request(`/${s.id}/events/${stored.seq}`);
    assert.equal(res.status, 200);
    const one = await data<ChatEvent>(res);
    assert.deepEqual(one, JSON.parse(JSON.stringify(stored)), 'whole, as stored');
    assert.equal(one.textLength, undefined);

    assert.equal((await owner.request(`/${s.id}/events/999999`)).status, 404, 'no such seq');
    assert.equal((await owner.request(`/${s.id}/events/abc`)).status, 404);
    assert.equal((await owner.request(`/nope/events/${stored.seq}`)).status, 404, 'no such session');
  } finally {
    await s.done();
  }
});

test('both routes go through the seam: declared, and another user gets the same 404 as none, with nothing of the transcript', async () => {
  const s = await seeded();
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    const view = { kind: 'objects', checks: [{ type: 'session', verb: 'view', from: 'path', param: 'id' }] };
    assert.deepEqual(declaredPolicies().get('GET /api/chat/sessions/:id/events'), view);
    assert.deepEqual(declaredPolicies().get('GET /api/chat/sessions/:id/events/:seq'), view);
    const seq = s.controller.history(s.id).find((e) => e.kind === 'tool_result')!.seq;

    const other = app(s, { kind: 'user', userId: 'u_a', loginSessionId: 'l1', via: 'ui' });
    for (const path of [`/${s.id}/events`, `/${s.id}/events?limit=10`, `/${s.id}/events?after=0`, `/${s.id}/events/${seq}`]) {
      const denied = await other.request(path);
      assert.equal(denied.status, 404, path);
      const text = await denied.text();
      assert.ok(!text.includes('message 1') && !text.includes('listing line'), path);
    }
    assert.notEqual((await app(s, null).request(`/${s.id}/events/${seq}`)).status, 200, 'not signed in: refused');
  } finally {
    await s.done();
  }
});

test('gzip: a JSON answer is compressed when the client accepts gzip, and not otherwise; an event stream never is', async () => {
  const s = await seeded();
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    const a = app(s, 'owner', true);
    a.get('/t/stream', (c) =>
      streamSSE(c, async (stream) => {
        for (let i = 0; i < 50; i++) await stream.writeSSE({ data: `tick ${i} ${'padding '.repeat(10)}` });
      }),
    );
    // streamSSE also sets Transfer-Encoding, which compress skips by itself; a stream made by hand has only its content type, and the
    // JSON-only filter is what keeps it plain. A large text answer is not JSON either.
    const ticks = Array.from({ length: 50 }, (_, i) => `data: tick ${i} ${'padding '.repeat(10)}\n\n`).join('');
    a.get('/t/raw-stream', () => new Response(new Blob([ticks]).stream(), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }));
    a.get('/t/text', (c) => c.text(ticks));

    const zipped = await a.request(`/${s.id}/events`, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    assert.equal(zipped.status, 200);
    assert.equal(zipped.headers.get('content-encoding'), 'gzip');
    assert.match(zipped.headers.get('vary') ?? '', /accept-encoding/i);
    const raw = Buffer.from(await zipped.arrayBuffer());
    const body = JSON.parse(gunzipSync(raw).toString('utf8')) as { data: ChatEvent[] };
    assert.deepEqual(seqs(body.data), seqs(s.controller.history(s.id)));
    assert.ok(raw.length * 3 < gunzipSync(raw).length, `compressed ${raw.length} bytes`);

    const plain = await a.request(`/${s.id}/events`);
    assert.equal(plain.headers.get('content-encoding'), null, 'no Accept-Encoding: as it was');
    assert.ok(Array.isArray(((await plain.json()) as { data: unknown }).data));

    const sse = await a.request('/t/stream', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.match(sse.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(sse.headers.get('content-encoding'), null, 'an event stream is never compressed');
    assert.match(await sse.text(), /data: tick 49/);

    for (const path of ['/t/raw-stream', '/t/text']) {
      const res = await a.request(path, { headers: { 'Accept-Encoding': 'gzip' } });
      assert.equal(res.headers.get('content-encoding'), null, path);
      assert.equal(await res.text(), ticks, path);
    }
  } finally {
    await s.done();
  }
});
