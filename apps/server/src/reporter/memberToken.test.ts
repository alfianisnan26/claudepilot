// 2026-11-02 (Konfersi): a reporter token minted by a MEMBER account (an org admin is a portal member) worked at Connect and was refused on
// every call after (404, the panel signed out): its use asked for a portal admin. It now asks only that the account is active; the person's
// rights on the bucket are still asked on every call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Actor } from '@portal/contracts';
import { ownerActor } from '../authz/seam.js';
import { accountActive } from '../identity/accountGate.js';
import { STG, reporterHarness } from './testkit.js';

test('2026-11-02: a reporter token minted by an active member account is accepted; disabled or gone, it is refused', async () => {
  const h = await reporterHarness();
  try {
    const db = h.store.db!;
    db.prepare(
      "INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by, founder) VALUES (?, ?, ?, ?, 'member', 'active', 'x', 'now', 'now', 'ui', 0)",
    ).run('u_Member_00001', 'm@example.com', 'm@example.com', 'Member');
    const actor = { ...(ownerActor() as Extract<Actor, { kind: 'user' }>), accountId: 'u_Member_00001' } as Actor & { userId: string };
    const t = h.service.mint('KONF', STG, actor, 'Member');
    assert.ok(h.service.verify(t.token, { bucket: 'KONF', origin: STG }), 'the member’s token is accepted (before: refused, every call 404)');
    assert.equal(h.service.verifyId(t.id), true);
    const me = await h.call('/reporter/v1/me', { headers: { authorization: `Bearer ${t.token}`, 'x-reporter-bucket': 'KONF', 'x-reporter-origin': STG } });
    assert.equal(me.status, 200, 'GET /me answers with the member’s token');

    db.prepare("UPDATE users SET state = 'disabled' WHERE id = 'u_Member_00001'").run();
    assert.equal(h.service.verify(t.token, { bucket: 'KONF', origin: STG }), null, 'a disabled account’s token is refused');
    assert.equal(h.service.verifyId(t.id), false);
    db.prepare("DELETE FROM users WHERE id = 'u_Member_00001'").run();
    assert.equal(h.service.verify(t.token), null, 'a removed account’s token is refused');

    assert.equal(accountActive(db, null), true, 'no account (the server code) passes, as before');
    assert.equal(accountActive(null, 'u_Member_00001'), false, 'no database: refused (fail closed)');
  } finally {
    h.done();
  }
});
