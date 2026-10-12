// The stub agent (connect/qa/stubAgent.ts) against the real portal module: what a test of the portal gets from it.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { openModule, serveModule } from '../testkit.js';
import { startStubAgent } from './stubAgent.js';

test('a stub agent enrolls through the real route, connects, echoes the portal’s streams, answers a rotation, and is stopped by a revoke', async () => {
  const m = await openModule();
  const srv = await serveModule(m);
  try {
    const made = await m.admin('POST', '/targets', { kind: 'docker', platform: 'linux', id: 'lab', portalUrl: srv.origin });
    const agent = await startStubAgent({ origin: srv.origin, token: made.json.data.token, kind: 'docker', statusEveryMs: 50 });
    await agent.connected();
    const link = m.connect.hub.link({ id: agent.node!, targetId: 'lab' });
    const stream = await link.open('docker');
    stream.write('ping');
    assert.equal((await once(stream, 'data'))[0].toString(), 'ping');
    stream.destroy();
    for (let i = 0; i < 100 && !m.connect.hub.state(agent.node!)?.status; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(m.connect.hub.state(agent.node!)!.status!.services[0]!.name, 'docker');
    const before = m.connect.registry.requireNode(agent.node!).keyFingerprint;
    assert.equal((await m.admin('POST', `/nodes/${agent.node}/rotate`)).status, 202);
    for (let i = 0; i < 200 && m.connect.registry.requireNode(agent.node!).keyFingerprint === before; i++) await new Promise((r) => setTimeout(r, 10));
    assert.notEqual(m.connect.registry.requireNode(agent.node!).keyFingerprint, before);
    await m.admin('DELETE', `/nodes/${agent.node}`);
    for (let i = 0; i < 200 && agent.isConnected(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(agent.isConnected(), false);
    assert.equal(agent.told.revoked, 'This node was revoked.');
    await agent.stop();
  } finally {
    await srv.close();
  }
});
