// T-1650: a live process is never marked gone on one reading. On 2026-10-19 one liveness round read all 13 live sessions of a workspace
// as gone (their processes ran on) and Interrupted them, Bypass off. Now `gone` takes two readings at least `goneConfirmMs` apart, and a
// round in which every live session of a workspace reads gone is a workspace fault (nothing marked) until it has lasted `workspaceGoneMs`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveSession, sleep, until, type Live } from './testkit.js';

const goneReadings = (s: Live, from: number, csid?: string) => s.ws.statusLog.slice(from).filter((r) => !r.alive && (!csid || r.csid === csid));
const csidOf = (s: Live, id: string) => s.controller.get(id)!.claudeSessionId;

/** A second live session in the same workspace. */
async function sibling(s: Live): Promise<string> {
  const before = s.ws.tails.length;
  const { id } = await s.controller.create({ workspaceId: 'docker/ws1' });
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(id)?.state === 'idle');
  return id;
}

test('T-1650: one gone reading does not mark a live session; the next reading finds it live', async () => {
  const s = await liveSession({ livenessMs: 100, goneConfirmMs: 300 }, true);
  try {
    const from = s.ws.statusLog.length;
    s.ws.alive = false;
    await until(() => goneReadings(s, from).length === 1);
    s.ws.alive = true; // the reading lied: the process runs on
    await sleep(700); // the second reading, 300 ms later, and the rounds after it
    assert.equal(goneReadings(s, from).length, 1);
    assert.equal(s.controller.get(s.id)!.process, 'live');
    assert.equal(s.state(), 'idle');
  } finally {
    await s.done();
  }
});

test('T-1650: a dropped reader whose one reading says gone follows again instead', async () => {
  const s = await liveSession({ goneConfirmMs: 300 });
  try {
    const from = s.ws.statusLog.length;
    const tails = s.ws.tails.length;
    s.ws.alive = false;
    s.tail.exit(0);
    await until(() => goneReadings(s, from).length === 1);
    s.ws.alive = true;
    await until(() => s.ws.tails.length > tails, 3000); // re-followed
    assert.equal(s.controller.get(s.id)!.process, 'live');
  } finally {
    await s.done();
  }
});

test('T-1650: two gone readings, at least the confirm time apart, mark a stopped process gone', async () => {
  const s = await liveSession({ livenessMs: 100, goneConfirmMs: 300 }, true);
  try {
    const from = s.ws.statusLog.length;
    s.ws.alive = false;
    await until(() => s.state() === 'interrupted', 3000);
    const gone = goneReadings(s, from);
    assert.ok(gone.length >= 2, 'two readings');
    assert.ok(gone[1]!.at - gone[0]!.at >= 290, `apart: ${gone[1]!.at - gone[0]!.at} ms`);
    assert.equal(s.controller.get(s.id)!.process, 'gone');
  } finally {
    s.ws.alive = true;
    await s.done();
  }
});

test('T-1650: every live session of a workspace reading gone at once is a workspace fault: nothing is marked', async () => {
  const s = await liveSession({ livenessMs: 100, goneConfirmMs: 50, workspaceGoneMs: 60_000 }, true);
  try {
    const other = await sibling(s);
    const from = s.ws.statusLog.length;
    s.ws.alive = false;
    await until(() => goneReadings(s, from, csidOf(s, s.id)).length >= 6 && goneReadings(s, from, csidOf(s, other)).length >= 6, 5000);
    for (const id of [s.id, other]) {
      assert.equal(s.controller.get(id)!.process, 'live', id);
      assert.equal(s.controller.get(id)!.state, 'idle', id);
    }
  } finally {
    s.ws.alive = true;
    await s.done();
  }
});

test('T-1650: a whole workspace that stays gone (a pod restart) is marked gone once that has lasted', async () => {
  const s = await liveSession({ livenessMs: 100, goneConfirmMs: 50, workspaceGoneMs: 500 }, true);
  try {
    const other = await sibling(s);
    const from = s.ws.statusLog.length;
    s.ws.alive = false;
    await until(() => s.controller.get(s.id)!.state === 'interrupted' && s.controller.get(other)!.state === 'interrupted', 5000);
    const lasted = Date.now() - goneReadings(s, from)[0]!.at;
    assert.ok(lasted >= 500, `marked only once it lasted: ${lasted} ms`);
  } finally {
    s.ws.alive = true;
    await s.done();
  }
});

test('T-1650: one session that stops while its neighbour runs is marked gone; the neighbour is not', async () => {
  const s = await liveSession({ livenessMs: 100, goneConfirmMs: 100, workspaceGoneMs: 60_000 }, true);
  try {
    const other = await sibling(s);
    s.ws.status.set(csidOf(s, s.id), false);
    await until(() => s.state() === 'interrupted', 3000);
    assert.equal(s.controller.get(s.id)!.process, 'gone');
    assert.equal(s.controller.get(other)!.process, 'live');
    assert.equal(s.controller.get(other)!.state, 'idle');
  } finally {
    s.ws.status.clear();
    await s.done();
  }
});
