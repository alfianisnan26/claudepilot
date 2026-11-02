// The flow's chat port over the real controller (flow/index.ts flowChatPort): the crew walks ask `continuationOf` each round, so it is
// one indexed read, never the workspace's decorated session list (2026-11-02: 15 calls took 2.9 s of a Konfersi round).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveSession } from '../chat/testkit.js';
import { flowChatPort } from './index.js';

test('2026-11-02: flowChatPort.continuationOf finds the newest continuation without reading any session list', async () => {
  const s = await liveSession();
  try {
    await s.controller.end(s.id);
    const next = await s.controller.create({ workspaceId: 'docker/ws1', title: 'Lead', continuedFrom: s.id });
    const port = flowChatPort(s.controller)!;
    const list = s.controller.list.bind(s.controller);
    let lists = 0;
    s.controller.list = ((f?: Parameters<typeof list>[0]) => (lists++, list(f))) as typeof s.controller.list;
    assert.equal(port.continuationOf(s.id), next.id);
    assert.equal(port.continuationOf(next.id), null, 'nothing continues the newest');
    assert.equal(lists, 0, 'no session list was read');
  } finally {
    await s.done();
  }
});
