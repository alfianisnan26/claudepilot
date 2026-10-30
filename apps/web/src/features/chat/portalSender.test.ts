import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portalSender } from './portalSender';

test('an MCP client is named by its token label', () => {
  assert.equal(portalSender('portal-mcp:ptk_ab12', 'relay').who, 'MCP client “relay”');
  assert.equal(portalSender('portal-mcp:ptk_ab12', 'relay').kind, 'mcp');
});

test('an MCP message stored without a label stays anonymous (an event from before labels travelled)', () => {
  assert.equal(portalSender('portal-mcp:ptk_ab12', undefined).who, 'an MCP client');
});

test('a session, a ticket and CI keep their words', () => {
  assert.deepEqual(portalSender('session:s1', 'Fix login'), { kind: 'session', id: 's1', who: 'agent “Fix login”' });
  assert.equal(portalSender('session:s1', undefined).who, 'another agent');
  assert.equal(portalSender('ticket:T-4', undefined).who, 'ticket T-4');
  assert.equal(portalSender('ci:r1', 'deploy').who, 'CI · deploy');
  assert.equal(portalSender('portal:ci-r9', undefined).who, 'CI');
  assert.equal(portalSender('ci:r9', '#12').who, 'CI #12', 'a bumped run says its number');
  assert.equal(portalSender('ci:r9', 'CI').who, 'CI', 'a report is not “CI · CI”');
});

test('a crew report (T-294) is from the crew, not an MCP client', () => {
  assert.deepEqual(portalSender('portal:crew', 'Crew report'), { kind: 'crew', id: '', who: 'your crew' });
});

test('a delegate (account:<id>) is named by its email, not as an MCP client', () => {
  assert.deepEqual(portalSender('account:u_1', 'alfian@example.com'), { kind: 'account', id: 'u_1', who: 'alfian@example.com' });
  assert.equal(portalSender('account:u_1', undefined).who, 'a shared account');
});
