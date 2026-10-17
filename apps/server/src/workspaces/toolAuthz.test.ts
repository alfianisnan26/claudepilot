// T-356: the `workspace` resolver of the seam resolves every form a tool takes (stable id, `<target>/<name>`, an old label, a unique bare name),
// so workspace_rename and workspace_resources are decided on the workspace itself; a workspace that is another person's, missing or ambiguous
// by name gives the one answer the tools' own resolver gives for a missing one.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AppError } from '@isnanme/core';
import { FOUNDING_USER_ID, type Actor, type UserId } from '@portal/contracts';
import { clearResolvers, requireToolPolicy } from '../authz/seam.js';
import { resolveWorkspace } from '../portalmcp/tools/common.js';
import { canonicalWorkspaceId, declareWorkspacePolicies, NO_WORKSPACE, registerWorkspaceAuthz, type WorkspaceAuthzFacts } from './authz.js';

after(() => clearResolvers());

const OTHER = 'u_b' as UserId;
// docker/api (label "front", once "old-front"), docker/theirs (u_b's), docker/twin and kubernetes/twin (one name, two workspaces).
const ROWS: { id: string; stable: string; labels: string[]; owner: UserId }[] = [
  { id: 'docker/api', stable: 'ws_aaaaaaaaaaaa', labels: ['api', 'front'], owner: FOUNDING_USER_ID },
  { id: 'docker/theirs', stable: 'ws_bbbbbbbbbbbb', labels: ['theirs'], owner: OTHER },
  { id: 'docker/twin', stable: 'ws_cccccccccccc', labels: ['twin'], owner: FOUNDING_USER_ID },
  { id: 'kubernetes/twin', stable: 'ws_dddddddddddd', labels: ['twin'], owner: FOUNDING_USER_ID },
];
const facts: WorkspaceAuthzFacts = {
  resolve: (ref) => {
    const row = ROWS.find((r) => r.id === ref || r.stable === ref) ?? (ref === 'docker/old-front' ? ROWS[0] : undefined);
    return row ? { legacyId: row.id } : null;
  },
  named: (name) => ROWS.filter((r) => r.labels.includes(name)).map((r) => r.id),
};
const token: Actor = { kind: 'token', userId: FOUNDING_USER_ID, tokenId: 'tok1', scope: 'admin' };

test('canonicalWorkspaceId: every form resolves to <target>/<name>; unknown and ambiguous names to null', () => {
  assert.equal(canonicalWorkspaceId(facts, 'ws_aaaaaaaaaaaa'), 'docker/api');
  assert.equal(canonicalWorkspaceId(facts, 'docker/api'), 'docker/api');
  assert.equal(canonicalWorkspaceId(facts, 'docker/old-front'), 'docker/api', 'a label it had');
  assert.equal(canonicalWorkspaceId(facts, 'api'), 'docker/api', 'a bare name only one has');
  assert.equal(canonicalWorkspaceId(facts, ' front '), 'docker/api', 'a bare label, trimmed');
  assert.equal(canonicalWorkspaceId(facts, 'twin'), null, 'two have it: never decided on one of them');
  assert.equal(canonicalWorkspaceId(facts, 'docker/nope'), null);
  assert.equal(canonicalWorkspaceId(facts, 'nope'), null);
  assert.equal(canonicalWorkspaceId(facts, ''), null);
});

for (const tool of ['workspace_rename', 'workspace_resources'] as const) {
  test(`${tool}: decided on the workspace for any form of its id; another person's, missing and ambiguous read exactly like a missing one`, () => {
    declareWorkspacePolicies();
    registerWorkspaceAuthz(facts, (ws) => ROWS.find((r) => r.id === ws)!.owner);
    const call = (id: string) => requireToolPolicy(token, tool, { id });
    for (const mine of ['ws_aaaaaaaaaaaa', 'docker/api', 'docker/old-front', 'api', 'front']) assert.doesNotThrow(() => call(mine), mine);

    // What the tools' own resolver says for a workspace that does not exist (the handler's answer) is the answer to every refusal here.
    const own = (() => {
      try {
        resolveWorkspace([], 'nope');
      } catch (e) {
        return e as AppError;
      }
      throw new Error('resolveWorkspace did not throw');
    })();
    assert.equal(own.message, NO_WORKSPACE);
    for (const refused of ['ws_bbbbbbbbbbbb', 'docker/theirs', 'theirs', 'nope', 'docker/nope', 'twin', 'ws_zzzzzzzzzzzz']) {
      assert.throws(() => call(refused), (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND' && e.message === own.message && e.code === own.code, refused);
    }
  });
}
