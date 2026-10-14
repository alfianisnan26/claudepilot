import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttentionItem, AttentionList } from '@portal/contracts';
import { reviewCompact, reviewView } from './model.js';

const now = Date.now();
const at = (min: number) => new Date(now + min * 60_000).toISOString();
const item = (kind: AttentionItem['kind'], id: string, since: string): AttentionItem => ({
  kind,
  id,
  title: id,
  who: [],
  why: 'gate',
  risk: '',
  since,
  link: '/admin/x',
  action: { label: 'Review', method: 'POST', path: '/x' },
});
const list = (over: Partial<AttentionList> = {}): AttentionList => ({
  total: 3,
  counts: { mcp_version: 2, skill_version: 0, ci_deploy: null, ticket_approval: 1, tool_approval: null, keepgoing_down: 0 },
  unavailable: ['ci_deploy'],
  items: [item('mcp_version', 'a', at(-30)), item('ticket_approval', 'T-9', at(-2)), item('mcp_version', 'b', at(-10))],
  offset: 0,
  limit: 200,
  at: at(0),
  ...over,
});

test('Review: a figure per source the server has, unavailable as null, and the newest item linked to its card in the deck', () => {
  const v = reviewView(list());
  assert.deepEqual(
    v.sources.map((s) => [s.label, s.count]),
    [
      ['MCP', 2],
      ['Skills', 0],
      ['Deploys', null],
      ['Tickets', 1],
    ],
    'a source the server does not have (null and not unavailable) is left out',
  );
  assert.equal(v.newest?.item.id, 'T-9');
  assert.equal(v.newest?.to, `/admin/attention?item=${encodeURIComponent('ticket_approval:T-9')}`);
  assert.equal(reviewView(list({ total: 0, items: [] })).newest, null);
});

test('Review chip: the count, amber while something waits, unknown when unread', () => {
  assert.deepEqual(reviewCompact(list(), false), { value: '3', level: 'warn', title: 'Review: 3 things wait for you, Deploys unavailable' });
  assert.equal(reviewCompact(list({ total: 0, items: [], unavailable: [] }), false).level, 'idle');
  assert.equal(reviewCompact(null, true).value, '-');
  assert.equal(reviewCompact(null, false).loading, true);
});
