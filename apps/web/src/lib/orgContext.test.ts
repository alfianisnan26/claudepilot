import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PERSONAL,
  contextKey,
  currentContext,
  parseContext,
  readContext,
  resolveContext,
  scopedList,
  setCurrentContext,
  subscribeContext,
  withOrg,
  writeContext,
  type ContextStorage,
} from './orgContext';

const memory = (): ContextStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
};
const throwing: ContextStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

test('the context is kept per device and per user, under claudepilot.context.<userId>', () => {
  const s = memory();
  writeContext(s, 'u_a', { kind: 'org', id: 'org_abc123' });
  assert.equal(s.map.get(contextKey('u_a')), 'org:org_abc123');
  assert.equal(contextKey('u_a'), 'claudepilot.context.u_a');
  assert.deepEqual(readContext(s, 'u_a'), { kind: 'org', id: 'org_abc123' });
  assert.deepEqual(readContext(s, 'u_b'), PERSONAL, 'another person on the same device starts Personal');
  writeContext(s, 'u_a', PERSONAL);
  assert.equal(s.map.has(contextKey('u_a')), false, 'Personal is the absence of a choice');
});

test('blocked or missing storage means Personal, never a throw', () => {
  assert.deepEqual(readContext(throwing, 'u_a'), PERSONAL);
  assert.doesNotThrow(() => writeContext(throwing, 'u_a', { kind: 'org', id: 'org_x1' }));
  assert.deepEqual(readContext(null, 'u_a'), PERSONAL);
});

test('a stored value that is not an org id is Personal', () => {
  for (const raw of [null, '', 'personal', 'org:', 'org:../x', 'org:org_<script>', 'u_owner', '{"kind":"org"}', `org:org_${'a'.repeat(80)}`]) assert.deepEqual(parseContext(raw), PERSONAL, String(raw));
});

test('an org the person is no longer in (or a forged one) falls back to Personal', () => {
  assert.deepEqual(resolveContext({ kind: 'org', id: 'org_mine' }, ['org_mine']), { kind: 'org', id: 'org_mine' });
  assert.deepEqual(resolveContext({ kind: 'org', id: 'org_theirs' }, ['org_mine']), PERSONAL);
  assert.deepEqual(resolveContext(PERSONAL, []), PERSONAL);
});

test('withOrg adds the parameter after an existing query or as the first, encoded', () => {
  assert.equal(withOrg('/api/workspaces', 'org_a'), '/api/workspaces?org=org_a');
  assert.equal(withOrg('/api/ci/runs?limit=5', 'org_a'), '/api/ci/runs?limit=5&org=org_a');
  assert.equal(withOrg('/x', 'org_a&b'), '/x?org=org_a%26b');
});

test('scopedList: Personal sends org=personal and an org its id (after an existing query too)', async () => {
  const asked: string[] = [];
  const run = async (p: string) => (asked.push(p), ['row']);
  assert.deepEqual(await scopedList('/api/w', run, PERSONAL), ['row']);
  assert.deepEqual(await scopedList('/api/ci/runs?limit=5', run, PERSONAL), ['row']);
  assert.deepEqual(await scopedList('/api/w', run, { kind: 'org', id: 'org_a' }), ['row']);
  assert.deepEqual(await scopedList('/api/ci/runs?limit=5', run, { kind: 'org', id: 'org_a' }), ['row']);
  assert.deepEqual(asked, ['/api/w?org=personal', '/api/ci/runs?limit=5&org=personal', '/api/w?org=org_a', '/api/ci/runs?limit=5&org=org_a']);
});

test('the default context sends the current one', async () => {
  const asked: string[] = [];
  const run = async (p: string) => (asked.push(p), 1);
  setCurrentContext({ kind: 'org', id: 'org_b' });
  await scopedList('/api/tickets/buckets', run);
  setCurrentContext(PERSONAL);
  await scopedList('/api/tickets/buckets', run);
  assert.deepEqual(asked, ['/api/tickets/buckets?org=org_b', '/api/tickets/buckets?org=personal']);
});

test('the current context notifies its listeners only on a change', () => {
  let calls = 0;
  const off = subscribeContext(() => calls++);
  setCurrentContext({ kind: 'org', id: 'org_a' });
  setCurrentContext({ kind: 'org', id: 'org_a' });
  assert.deepEqual(currentContext(), { kind: 'org', id: 'org_a' });
  setCurrentContext(PERSONAL);
  off();
  setCurrentContext({ kind: 'org', id: 'org_b' });
  setCurrentContext(PERSONAL);
  assert.equal(calls, 2);
});
