import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelledLine, startedBy } from './startedBy';

test('a run started by a Portal MCP token names the token’s label', () => {
  assert.equal(startedBy({ actor: 'portal-mcp:ptk_1', actorLabel: 'relay' }), 'MCP client “relay”');
  assert.equal(startedBy({ actor: 'portal-mcp:ptk_1', actorLabel: null }), 'a Portal MCP token');
});

test('a session is an agent and anything else a person', () => {
  assert.equal(startedBy({ actor: 'session:s1', actorLabel: null }), 'an agent');
  assert.equal(startedBy({ actor: 'ui', actorLabel: null }), 'a person');
});

test('a cancelled run says who cancelled it and why (T-95); a run nobody cancelled says nothing', () => {
  assert.equal(cancelledLine({ status: 'cancelled', cancelledBy: 'pipeline', cancelNote: 'for #12' }), 'Cancelled by the pipeline, for #12');
  assert.equal(cancelledLine({ status: 'cancelled', cancelledBy: 'portal-mcp:ptk_1', cancelledByLabel: 'relay' }), 'Cancelled by MCP client “relay”');
  assert.equal(cancelledLine({ status: 'cancelled', cancelledBy: 'session:s1' }), 'Cancelled by an agent');
  assert.equal(cancelledLine({ status: 'cancelled', cancelledBy: 'ui' }), 'Cancelled by a person');
  assert.equal(cancelledLine({ status: 'cancelled', cancelledBy: null }), null, 'cancelled before it was recorded');
  assert.equal(cancelledLine({ status: 'failed', cancelledBy: 'ui' }), null);
});
