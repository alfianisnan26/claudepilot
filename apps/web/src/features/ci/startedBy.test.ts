import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startedBy } from './startedBy';

test('a run started by a Portal MCP token names the token’s label', () => {
  assert.equal(startedBy({ actor: 'portal-mcp:ptk_1', actorLabel: 'relay' }), 'MCP client “relay”');
  assert.equal(startedBy({ actor: 'portal-mcp:ptk_1', actorLabel: null }), 'a Portal MCP token');
});

test('a session is an agent and anything else a person', () => {
  assert.equal(startedBy({ actor: 'session:s1', actorLabel: null }), 'an agent');
  assert.equal(startedBy({ actor: 'ui', actorLabel: null }), 'a person');
});
