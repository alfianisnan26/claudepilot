// The Home cards and the glance rail follow the org context (owner request 2026-11-01, metrics per org): every summary they read is asked
// with `?org=` (Personal: `org=personal`, an org: its id), a context switch drops what a store holds and a load that started before the
// switch is thrown away, and the live `workspaces` push (every workspace the person may see) never adds a row to a context's list.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { CLAUDE_USAGE_API, GLANCE_API, KEEPGOING_API, USAGE_SPEND_API } from '@portal/contracts';
import { PERSONAL, scopedPath, scopedPush, setCurrentContext } from '@/lib/orgContext';
import { createLiveStore } from './liveStore';

const ORG = { kind: 'org', id: 'org_a' } as const;

afterEach(() => setCurrentContext(PERSONAL));

test('scopedPath: the context as ?org=, after any query the path has', () => {
  assert.equal(scopedPath('/api/glance', PERSONAL), '/api/glance?org=personal');
  assert.equal(scopedPath('/api/claude-usage?watch=1', ORG), '/api/claude-usage?watch=1&org=org_a');
  setCurrentContext(ORG);
  assert.equal(scopedPath('/api/attention'), '/api/attention?org=org_a', 'the current context by default');
});

test('scopedPush: the same ids update the held rows only; a row that came or went, or nothing held, loads again', () => {
  const w = (id: string, status = 'running') => ({ id, status });
  const first = scopedPush([w('a'), w('b'), w('c')], null, '');
  assert.equal(first.next, null, 'nothing held: load in the context');
  const held = [w('a', 'stopped')];
  const same = scopedPush([w('c'), w('a'), w('b')], held, first.ids);
  assert.deepEqual(same.next, [w('a')], 'only the context’s own row, with its new state; b and c are another context’s');
  assert.equal(scopedPush([w('a'), w('b')], held, same.ids).next, null, 'one went away: load again');
  assert.equal(scopedPush([w('a'), w('b'), w('c'), w('d')], held, same.ids).next, null, 'a new one may be this context’s: load again');
});

test('a scoped live store asks in the current context; a switch drops what it holds and a load from before the switch is not kept', async () => {
  const asked: string[] = [];
  const pending: ((v: string) => void)[] = [];
  const store = createLiveStore<string>({
    load: () => {
      asked.push(scopedPath('/api/x'));
      return new Promise<string>((resolve) => pending.push(resolve));
    },
    topics: [],
    scoped: true,
  });
  const first = store.reload();
  pending.shift()!('personal numbers');
  await first;
  assert.equal(store.peek(), 'personal numbers');

  const slow = store.reload(); // asked in Personal...
  setCurrentContext(ORG); // ...and the person switches before it lands
  assert.equal(store.peek(), null, 'the old context’s reading is never shown as the new one’s');
  pending.shift()!('late personal numbers');
  await slow;
  assert.equal(store.peek(), null, 'the late answer of the old context is thrown away');

  const again = store.reload();
  pending.shift()!('org numbers');
  await again;
  assert.equal(store.peek(), 'org numbers');
  assert.deepEqual(asked, ['/api/x?org=personal', '/api/x?org=personal', '/api/x?org=org_a']);
});

test('an unscoped live store keeps its reading across a switch (the auto-move panel is the viewer’s own)', async () => {
  const store = createLiveStore<number>({ load: async () => 1, topics: [] });
  await store.reload();
  setCurrentContext(ORG);
  assert.equal(store.peek(), 1);
});

test('the widgets’ reads carry the context: glance, Needs you, quota, spend and Keep going', async () => {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    setCurrentContext(ORG);
    const { reloadGlance } = await import('./store');
    const { fetchAttention } = await import('@/features/attention/api');
    const { claudeUsageApi } = await import('@/features/usage/claude/api');
    const { usageSpendApi } = await import('@/features/usage/spend/api');
    const { chatApi } = await import('@/features/chat/api');
    await reloadGlance();
    await fetchAttention({ limit: 200 }).catch(() => undefined);
    await claudeUsageApi.report().catch(() => undefined);
    await usageSpendApi.summary().catch(() => undefined);
    await chatApi.keepGoingList().catch(() => undefined);
    assert.deepEqual(urls, [
      `${GLANCE_API.snapshot}?org=org_a`,
      '/api/attention?limit=200&org=org_a',
      `${CLAUDE_USAGE_API.list}?org=org_a`,
      `${USAGE_SPEND_API.summary}?org=org_a`,
      `${KEEPGOING_API.list}?org=org_a`,
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
