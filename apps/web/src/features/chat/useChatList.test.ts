// useChatList mounted (QA 9691 gap 1, T-382 S5): the real hook runs over a stubbed `fetch`, so the wiring around ListPager is under test, not
// just the pager. Each test names the one-line change in the hook that turns it red:
//   a  `failMore(...) === 'restart'` -> `await reload()` removed   (a refused cursor must start over from page 1)
//   b  the poll's `applyHead(page)` -> `head = page`               (the poll must apply the seam rule)
//   c  `pager.current.restart()` removed from `reload`             (a reload must drop the older pages)
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { mountHook, type Mounted } from './hookHarness';
import { useChatList, type ChatListApi } from './useChatSocket';

interface Call {
  url: string;
  reply(status: number, body: unknown): void;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let mounted: Mounted<ChatListApi> | null = null;

beforeEach(() => {
  calls = [];
  mock.timers.enable({ apis: ['setInterval'] });
  globalThis.fetch = ((url: unknown) =>
    new Promise<Response>((resolve) => {
      calls.push({
        url: String(url),
        reply: (status, body) => resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
      });
    })) as typeof fetch;
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  mock.timers.reset();
  globalThis.fetch = realFetch;
});

const tick = () => new Promise<void>((r) => setImmediate(r));
async function until<T>(f: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const v = f();
    if (v) return v;
    await tick();
  }
  throw new Error('timed out waiting');
}
/** The next request nobody answered yet, `more` for one that carries a cursor, else one for page 1. */
const pending = (more: boolean) => until(() => calls.find((c) => !('done' in c) && c.url.includes('cursor=') === more));
const take = async (more: boolean): Promise<Call> => {
  const c = await pending(more);
  (c as Call & { done?: true }).done = true;
  return c;
};
const page = (ids: string[], next: string | null) => ({ data: { items: ids.map((id) => ({ id })), next } });
const ids = () => mounted!.current.sessions?.map((s) => s.id);

/** Mounts the hook and answers its first request with page 1 [a, b] (next c1). */
async function start() {
  mounted = mountHook(useChatList);
  (await take(false)).reply(200, page(['a', 'b'], 'c1'));
  await until(() => ids());
  assert.deepEqual(ids(), ['a', 'b']);
  assert.equal(mounted.current.hasMore, true);
}

/** Loads the older page [c, d] (end of the list). */
async function loadOlder() {
  const p = mounted!.current.loadMore();
  (await take(true)).reply(200, page(['c', 'd'], null));
  await p;
  assert.deepEqual(ids(), ['a', 'b', 'c', 'd']);
}

test('a refused cursor starts over from page 1 (a: without the reload the list stays on the old pages)', async () => {
  await start();
  const p = mounted!.current.loadMore();
  const more = await take(true);
  assert.ok(more.url.includes('cursor=c1'));
  more.reply(400, { error: { code: 'BAD_REQUEST', message: 'That cursor is not valid for this list.' } });
  // the hook asks for page 1 again, and what it answers replaces the list
  (await take(false)).reply(200, page(['x', 'y'], null));
  await p;
  assert.deepEqual(ids(), ['x', 'y'], 'the list was reloaded from page 1');
  assert.equal(mounted!.current.hasMore, false);
  assert.equal(mounted!.current.loadingMore, false);
});

test('another failure keeps the list and the button, and asks for nothing else', async () => {
  await start();
  const p = mounted!.current.loadMore();
  (await take(true)).reply(500, { error: { code: 'INTERNAL_ERROR', message: 'down' } });
  await p;
  await tick();
  assert.deepEqual(ids(), ['a', 'b']);
  assert.equal(mounted!.current.hasMore, true);
  assert.equal(calls.filter((c) => !c.url.includes('cursor=')).length, 1, 'no second request for page 1');
});

test('the poll that finds a moved seam drops the older pages (b: applyHead is the seam rule)', async () => {
  await start();
  await loadOlder();
  mock.timers.tick(5_000);
  // a new session arrived: page 1 is now [z, a] and its cursor moved
  (await take(false)).reply(200, page(['z', 'a'], 'c9'));
  await until(() => ids()?.[0] === 'z');
  assert.deepEqual(ids(), ['z', 'a'], 'the old pages are gone, not glued under a head they no longer follow');
  assert.equal(mounted!.current.hasMore, true);
});

test('the poll that finds the same seam keeps the older pages', async () => {
  await start();
  await loadOlder();
  const renders = mounted!.renders;
  mock.timers.tick(5_000);
  (await take(false)).reply(200, page(['a', 'b'], 'c1'));
  await until(() => mounted!.renders > renders);
  assert.deepEqual(ids(), ['a', 'b', 'c', 'd']);
});

test('reload drops the older pages even when the seam did not move (c: reload restarts the pager)', async () => {
  await start();
  await loadOlder();
  const r = mounted!.current.reload();
  (await take(false)).reply(200, page(['a', 'b'], 'c1'));
  await r;
  assert.deepEqual(ids(), ['a', 'b'], 'back to page 1 only');
  assert.equal(mounted!.current.hasMore, true, 'and the older pages can be loaded again');
});

test('a failed poll keeps the list on screen', async () => {
  await start();
  mock.timers.tick(5_000);
  (await take(false)).reply(500, { error: { code: 'INTERNAL_ERROR', message: 'down' } });
  await tick();
  assert.deepEqual(ids(), ['a', 'b']);
  assert.equal(mounted!.current.failed, false);
});
