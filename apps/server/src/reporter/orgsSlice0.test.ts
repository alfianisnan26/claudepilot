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

test('review M1: a reporter token stops with the account that approved it, the founder account’s too; the server code’s lives on', async () => {
  const h = await reporterHarness();
  try {
    h.store
      .db!.prepare(
        "INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by, founder) VALUES ('u_Founder_0001', 'f@example.com', 'f@example.com', 'F', 'admin', 'active', 'x', 'now', 'now', 'ui', 1)",
      )
      .run();
    const founder = h.service.mint('KONF', STG, { kind: 'user', userId: 'u_owner', loginSessionId: 'legacy', via: 'ui', accountId: 'u_Founder_0001' }, 'Owner');
    const code = h.mint();
    assert.ok(h.service.verify(founder.token) && h.service.verify(code.token));
    h.store.db!.prepare("UPDATE users SET state = 'disabled' WHERE id = 'u_Founder_0001'").run();
    assert.equal(h.service.verify(founder.token), null, 'the founder account was disabled: its token is refused, though it acts as u_owner');
    assert.equal(h.service.verifyId(founder.id), false);
    assert.ok(h.service.verify(code.token), 'the server code’s token is untouched');
  } finally {
    h.done();
  }
});
