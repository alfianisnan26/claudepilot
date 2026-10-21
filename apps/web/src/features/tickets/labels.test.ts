import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actorName, bucketOption, fallbackSentence, isTicket, mcpClientName, mergeText, pageFilter, ticketLabel, verdictBatchOf } from './labels';

test('a Portal MCP token on a timeline is named by its label', () => {
  assert.equal(actorName('portal-mcp:ptk_1', 'relay'), 'MCP client “relay”');
  assert.equal(actorName('portal-mcp:ptk_1', ''), 'An MCP client');
  assert.equal(mcpClientName(null), 'An MCP client');
});

test('the other actors read as before', () => {
  assert.equal(actorName('ui', 'Admin'), 'Admin');
  assert.equal(actorName('session:s1', 'Worker'), 'Worker');
  assert.equal(actorName('session:s1', ''), 'An agent');
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
    'Portal moved it to the agent that continues it',
  );
  assert.equal(
    fallbackSentence('Portal', { to: { kind: 'session', sessionId: 's' }, reason: 'title' }),
    'Portal moved it to the live agent of its track',
  );
});

test('T-1098: a ticket shows its bucket key; an address in either form, any case, names it', () => {
  assert.equal(ticketLabel({ id: 'T-9', key: 'KONF-2' }), 'KONF-2');
  assert.equal(ticketLabel({ id: 'T-9' }), 'T-9', 'an older server sends no key');
  const t = { id: 'T-9', key: 'KONF-2' };
  assert.ok(isTicket(t, 'KONF-2') && isTicket(t, 'konf-2') && isTicket(t, 'T-9') && isTicket(t, 't-9'));
  assert.ok(!isTicket(t, 'KONF-3') && !isTicket(t, null));
  assert.equal(pageFilter({ view: 'list', scope: 'active', needs: false, queue: false, orphans: false, priority: null, type: null, tag: null, q: '', bucket: 'KONF' }).bucket, 'KONF');
});

test('T-1967: the merge confirm says how many move, that old keys work and that the bucket goes; a phone picker shows the key alone', () => {
  assert.equal(mergeText('CP', 'PILOT', 12), '12 tickets move to PILOT, CP keys keep working, CP is deleted.');
  assert.equal(mergeText('CP', 'PILOT', 1), '1 ticket moves to PILOT, CP keys keep working, CP is deleted.');
  assert.equal(mergeText('CP', 'PILOT', undefined), 'Its tickets move to PILOT, CP keys keep working, CP is deleted.');
  assert.equal(bucketOption({ key: 'CP', name: 'ClaudePilot' }, false), 'CP');
  assert.equal(bucketOption({ key: 'CP', name: 'ClaudePilot' }, true), 'CP · ClaudePilot');
});

test('verdictBatchOf (T-1987): a verdict entry recorded in a batch gives its branch and job; anything else gives nothing', () => {
  const batch = { jobId: 'job-run-9c1', branch: 'qa/batch-2026-10-21-1', note: 'once on the batch head' };
  assert.deepEqual(verdictBatchOf({ verdictId: 3, verdict: 'pass', batch }), batch);
  assert.deepEqual(verdictBatchOf({ verdictId: 3, batch: { branch: 'qa/batch-1', jobId: 7 } }), { jobId: null, branch: 'qa/batch-1', note: null }, 'only strings are shown');
  assert.equal(verdictBatchOf({ verdictId: 3, verdict: 'pass' }), null, 'a verdict recorded alone');
  assert.equal(verdictBatchOf({ batch }), null, 'not a verdict entry');
  assert.equal(verdictBatchOf(null), null);
});

test('the timeline shares the list’s filters; its first chip is everything in the window, closed included', () => {
  const base = { view: 'timeline' as const, scope: 'active', needs: false, queue: false, orphans: false, priority: null, type: null, tag: null, q: '' };
  assert.deepEqual(pageFilter(base), { limit: 100, includeClosed: true });
  assert.deepEqual(pageFilter({ ...base, scope: 'blocked', bucket: 'KONF', tag: 'ui', q: 'login', queue: true }), {
    limit: 100,
    bucket: 'KONF',
    status: ['blocked'],
    assignee: 'unassigned',
    tag: 'ui',
    query: 'login',
  });
  assert.deepEqual(pageFilter({ ...base, scope: 'closed' }).status, ['done', 'wont_do']);
});
