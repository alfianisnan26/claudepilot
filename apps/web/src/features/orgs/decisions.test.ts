// D-111: the owner of a new workspace (D1) and Move to organization for sets (D2), as the web offers them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORGS_ERROR_CODES, type Org } from '@portal/contracts';
import { moveTargets, objectRows, orgErrorText, workspaceOwners } from './rules.js';

const org = (id: string, myRole: Org['myRole'], createWorkspace: boolean, state: Org['state'] = 'active') =>
  ({ id, name: id.toUpperCase(), state, myRole, may: { invite: false, createTeam: false, createWorkspace } }) as Org;

test('D1: New workspace offers Personal and the orgs where the person may create; the current context is the default when allowed', () => {
  const orgs = [org('org_a', 'admin', true), org('org_m', 'member', false), org('org_s', 'owner', true, 'suspended')];
  const r = workspaceOwners(orgs, { kind: 'org', id: 'org_a' });
  assert.deepEqual(r.options.map((o) => o.value), ['personal', 'org_a'], 'a member without the policy and a suspended org are not offered');
  assert.equal(r.initial, 'org_a');
  assert.equal(workspaceOwners(orgs, { kind: 'org', id: 'org_m' }).initial, 'personal', 'a context where they may not create falls back to Personal');
  assert.equal(workspaceOwners(orgs, { kind: 'personal' }).initial, 'personal');
  assert.deepEqual(workspaceOwners(null, { kind: 'personal' }).options, [{ value: 'personal', label: 'Personal' }]);
  assert.match(orgErrorText({ details: { reason: ORGS_ERROR_CODES.ORG_CREATE_WORKSPACE_NOT_ALLOWED } }, 'x'), /owners and admins/);
});

test('D2: a set moves into active orgs the person is a member or up in, never the one that owns it; Objects lists sets', () => {
  const orgs = [org('org_a', 'member', false), org('org_g', 'guest', false), org('org_b', 'owner', true), org('org_s', 'admin', true, 'suspended')];
  assert.deepEqual(moveTargets(orgs, null), ['org_a', 'org_b']);
  assert.deepEqual(moveTargets(orgs, 'org_b'), ['org_a']);
  assert.deepEqual(moveTargets(null, null), []);
  const rows = objectRows({ workspaces: [], buckets: [], vaults: [], sets: [{ id: 'p1', name: 'Keys', type: 'secrets' }, { id: 'p2', name: 'Agents', type: 'skillset' }] });
  assert.deepEqual(
    rows.map((r) => [r.kind, r.id, r.href, r.poolType]),
    [
      ['pool', 'p2', '/admin/pools/skills', 'skillset'],
      ['pool', 'p1', '/admin/pools/secrets', 'secrets'],
    ],
  );
});
