import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actorName, fallbackSentence, mcpClientName, pageFilter } from './labels';

test('a Portal MCP token on a timeline is named by its label', () => {
  assert.equal(actorName('portal-mcp:ptk_1', 'relay'), 'MCP client “relay”');
  assert.equal(actorName('portal-mcp:ptk_1', ''), 'An MCP client');
  assert.equal(mcpClientName(null), 'An MCP client');
});

test('the other actors read as before', () => {
  assert.equal(actorName('ui', 'Admin'), 'Admin');
  assert.equal(actorName('session:s1', 'Worker'), 'Worker');
  assert.equal(actorName('session:s1', ''), 'A session');
  assert.equal(actorName('ticket:T-2', ''), 'A ticket');
});

test('the Orphans chip asks for orphans only, on top of the other filters', () => {
  const base = {
    view: 'list' as const,
    scope: 'active',
    needs: false,
    queue: false,
    orphans: false,
    priority: null,
    type: null,
    tag: null,
    q: '',
  };
  assert.deepEqual(pageFilter(base), { limit: 100 });
  assert.deepEqual(pageFilter({ ...base, orphans: true }), { limit: 100, orphan: true });
  assert.deepEqual(pageFilter({ ...base, orphans: true, priority: 'urgent', q: 'x' }), {
    limit: 100,
    orphan: true,
    priority: ['urgent'],
    query: 'x',
  });
});

test('a move by the orphan sweep reads as a sentence', () => {
  assert.equal(fallbackSentence('Portal', { to: null, reason: 'queue' }), 'Portal put it back in the queue');
  assert.equal(
    fallbackSentence('Portal', { to: { kind: 'session', sessionId: 's' }, reason: 'lineage' }),
    'Portal moved it to the session that continues it',
  );
  assert.equal(
    fallbackSentence('Portal', { to: { kind: 'session', sessionId: 's' }, reason: 'title' }),
    'Portal moved it to the live session of its track',
  );
});
