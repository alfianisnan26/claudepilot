import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATTENTION_KIND_LABEL, type AttentionItem, type AttentionList } from '@portal/contracts';
import { badgeText, groupByWhy, kindChoices, refusalsOf, refusedTitle, waited } from './model.js';

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  kind: 'mcp_version',
  id: 'x',
  title: 'X',
  who: [],
  why: 'third_party_code',
  risk: '',
  since: new Date(0).toISOString(),
  link: '/admin/home',
  action: { label: 'Review', method: 'POST', path: '/api/x' },
  ...over,
});

test('rows are grouped by why in the class order, the oldest first, with no empty group', () => {
  const t = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const groups = groupByWhy([
    item({ id: 'q', why: 'question', since: t(5) }),
    item({ id: 'new', since: t(1) }),
    item({ id: 'old', since: t(50) }),
    item({ id: 'p', why: 'production_uat', since: t(2) }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.why, g.items.map((i) => i.id)]),
    [
      ['production_uat', ['p']],
      ['third_party_code', ['old', 'new']],
      ['question', ['q']],
    ],
  );
});

test('T-3114: refused calls leave the why groups for their own group, which counts the calls (a card refused 3 times is 3)', () => {
  const t = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const items = [
    item({ id: 'bypass', kind: 'approval', why: 'gate', since: t(1) }),
    item({ id: 'r1', kind: 'approval', why: 'gate', group: 'refusal', since: t(3) }),
    item({ id: 'r2', kind: 'approval', why: 'gate', group: 'refusal', count: 3, since: t(9) }),
  ];
  assert.deepEqual(groupByWhy(items).map((g) => [g.why, g.items.map((i) => i.id)]), [['gate', ['bypass']]], 'the real ask alone in its group');
  const refused = refusalsOf(items);
  assert.deepEqual(refused.items.map((i) => i.id), ['r2', 'r1'], 'oldest first');
  assert.equal(refused.calls, 4);
  assert.equal(refusedTitle(refused.calls), 'Agents refused 4 calls');
  assert.equal(refusedTitle(1), 'Agents refused 1 call');
  assert.deepEqual(refusalsOf([items[0]!]), { items: [], calls: 0 });
});

test('the age is one short word, relative to now', () => {
  const now = Date.now();
  assert.equal(waited(new Date(now - 20_000).toISOString(), now), 'now');
  assert.equal(waited(new Date(now - 12 * 60_000).toISOString(), now), '12m');
  assert.equal(waited(new Date(now - 3 * 3_600_000).toISOString(), now), '3h');
  assert.equal(waited(new Date(now - 72 * 3_600_000).toISOString(), now), '3d');
  assert.equal(waited('not a date', now), '');
});

test('the badge: nothing at zero or unknown, 99+ when large', () => {
  assert.equal(badgeText(0), null);
  assert.equal(badgeText(null), null);
  assert.equal(badgeText(3), '3');
  assert.equal(badgeText(150), '99+');
});

test('the filter offers All and each kind with something, or that could not be read', () => {
  const list: AttentionList = {
    total: 3,
    counts: { mcp_version: 2, skill_version: 0, ci_deploy: 1, ticket_approval: null, tool_approval: 0, keepgoing_down: 0, persona_proposal: 0, ci_upstream: 0, workspace_memory: 0, approval: 0 },
    unavailable: ['ticket_approval'],
    items: [],
    offset: 0,
    limit: 100,
    at: new Date().toISOString(),
  };
  assert.deepEqual(
    kindChoices(list, ATTENTION_KIND_LABEL).map((c) => [c.value, c.count]),
    [
      ['all', 3],
      ['mcp_version', 2],
      ['ci_deploy', 1],
      ['ticket_approval', null],
    ],
  );
  assert.deepEqual(kindChoices(null, ATTENTION_KIND_LABEL), []);
});
