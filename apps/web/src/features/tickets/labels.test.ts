import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actorName, mcpClientName } from './labels';

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
