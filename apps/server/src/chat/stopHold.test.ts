// T-1966 (QA D1): a person's Stop is held on record, so it survives a portal restart (deploys are frequent), and only a person lifts it:
// their message or their Resume. The flow watchdog reads it through `stoppedByPerson` and never messages such a lead.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { liveSession, ok, restartPortal } from './testkit.js';

async function stopped() {
  const s = await liveSession({}, true);
  const stop = s.controller.control(s.id, 'stop');
  s.tail.push(ok((await s.take('interrupt')).id));
  await stop;
  return s;
}

test('a person’s Stop holds across a portal restart; a portal message does not lift it', async () => {
  const s = await stopped();
  try {
    assert.equal(s.controller.stoppedByPerson(s.id), true);
    await restartPortal(s);
    assert.equal(s.controller.stoppedByPerson(s.id), true, 'the hold is on record, not only in memory');
    await s.controller.send(s.id, randomUUID(), 'continue', { actor: 'portal:keepgoing', actorLabel: 'Keep going', priority: 'later' });
    assert.equal(s.controller.stoppedByPerson(s.id), true, 'only a person lifts it');
    assert.equal(s.controller.audit({ kind: 'crewhold', sessionId: s.id }).length, 1, 'one row per change');
  } finally {
    await s.done();
  }
});

test('a person’s own message lifts the hold, on record too', async () => {
  const s = await stopped();
  try {
    await s.controller.send(s.id, randomUUID(), 'go on');
    assert.equal(s.controller.stoppedByPerson(s.id), false);
    await restartPortal(s);
    assert.equal(s.controller.stoppedByPerson(s.id), false);
    assert.deepEqual(
      s.controller.audit({ kind: 'crewhold', sessionId: s.id }).map((a) => a.kind),
      ['crewhold.lifted', 'crewhold.set'],
    );
  } finally {
    await s.done();
  }
});
