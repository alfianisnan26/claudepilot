// KONF-3073: the controller says whether a session's workspace is stopped, as its runtime lists it now. Keep going reads it to hold a chat
// in a stopped workspace instead of waking it every few minutes; anything unknown is false (today's behaviour).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveSession } from './testkit.js';

type Listed = { id: string; stableId?: string; target: string; name: string; status: string };

function listing(s: Awaited<ReturnType<typeof liveSession>>, rows: Listed[] | Error) {
  const ws = s.ws as unknown as { list: () => Promise<Listed[]>; resolve: (ref: string) => null };
  ws.resolve = () => null;
  ws.list = async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  };
}

test('KONF-3073: workspaceStopped is true for a stopped or stopping workspace, false when it runs, is not listed, or the list fails', async () => {
  const s = await liveSession({}, true);
  try {
    const row = (status: string): Listed[] => [{ id: 'docker/ws1', target: 'docker', name: 'ws1', status }];
    listing(s, row('stopped'));
    assert.equal(await s.controller.workspaceStopped(s.id), true);
    listing(s, row('stopping'));
    assert.equal(await s.controller.workspaceStopped(s.id), true);
    listing(s, row('running'));
    assert.equal(await s.controller.workspaceStopped(s.id), false);
    listing(s, [{ id: 'docker/other', target: 'docker', name: 'other', status: 'stopped' }]);
    assert.equal(await s.controller.workspaceStopped(s.id), false, 'another workspace stopped: not this one');
    listing(s, new Error('the runtime could not be reached'));
    assert.equal(await s.controller.workspaceStopped(s.id), false, 'unknown: false');
    assert.equal(await s.controller.workspaceStopped('no-such-session'), false);
  } finally {
    await s.done();
  }
});
