// Organizations slice 0 (docs/prd/organizations.md §13 P2): a reporter token acts as the person who approved it; a token whose stored user is
// not a user id acts for nobody (it used to fall back to the founding user), so it no longer verifies.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reporterHarness, STG } from './testkit.js';

test('a reporter token is its approver’s; one whose stored user is not a user id is refused, not the founding user', async () => {
  const h = await reporterHarness();
  try {
    const t = h.mint();
    const ctx = h.service.verify(t.token);
    assert.equal(ctx?.actorUser, 'u_owner', 'minted by the founding user, bound to them');
    assert.equal(h.service.verifyId(t.id), true);
    for (const bad of ['ui', 'Admin', 'user:u_owner', '']) {
      h.store.db!.prepare('UPDATE reporter_tokens SET actor_user = ? WHERE id = ?').run(bad, t.id);
      assert.equal(h.service.verify(t.token, { origin: STG }), null, `actor_user ${JSON.stringify(bad)}`);
      assert.equal(h.service.verifyId(t.id), false);
    }
  } finally {
    h.done();
  }
});
