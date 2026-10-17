// Agent tokens heal by themselves (owner, 2026-10-17: "harusnya bisa otomatis auto heal apapun caranya"): a new token keeps the old one good
// until a new process really started; a start that started nothing revokes only the unused new one; and a live session that still calls with
// a token that was replaced or ran out asks for a restart (at most once in ten minutes), while one revoked on purpose never does.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { AgentAccess, STALE_HEAL_EVERY_MS } from './agents.js';

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-tokenheal-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  let now = Date.parse('2030-01-01T00:00:00Z');
  const alive = new Set(['s1']);
  const agents = new AgentAccess(store, { alive: (id) => alive.has(id), url: () => 'http://portal.invalid/mcp', now: () => new Date(now) });
  agents.setEnabled('docker/api', true);
  const heals: string[] = [];
  agents.onStaleToken = (sid, reason) => heals.push(`${sid} ${reason}`);
  return {
    agents,
    heals,
    alive,
    tick: (ms: number) => (now += ms),
    done: () => (store.close(), rmSync(dataDir, { recursive: true, force: true })),
  };
}

test('keepOthers: the old token stays good until settle; started revokes the others, not started revokes only the new one', async () => {
  const w = await world();
  try {
    const a = (await w.agents.mint({ workspaceId: 'docker/api', sessionId: 's1' }))!;
    const b = (await w.agents.mint({ workspaceId: 'docker/api', sessionId: 's1' }, { keepOthers: true }))!;
    assert.ok(w.agents.verify(a.env.PILOT_MCP_TOKEN!).ok && w.agents.verify(b.env.PILOT_MCP_TOKEN!).ok, 'both good while the start is in flight');
    w.agents.settle('s1', b.tokenId, false);
    assert.equal(w.agents.verify(a.env.PILOT_MCP_TOKEN!).ok, true, 'the live process keeps its token');
    assert.equal(w.agents.verify(b.env.PILOT_MCP_TOKEN!).ok, false);
    const c = (await w.agents.mint({ workspaceId: 'docker/api', sessionId: 's1' }, { keepOthers: true }))!;
    w.agents.settle('s1', c.tokenId, true);
    assert.equal(w.agents.verify(a.env.PILOT_MCP_TOKEN!).ok, false, 'a new process started: the old token goes');
    assert.equal(w.agents.verify(c.env.PILOT_MCP_TOKEN!).ok, true);
  } finally {
    w.done();
  }
});

test('a live session calling with a replaced token asks for a restart, once in ten minutes; an ended session or a token revoked on purpose never does', async () => {
  const w = await world();
  try {
    const a = (await w.agents.mint({ workspaceId: 'docker/api', sessionId: 's1' }))!;
    await w.agents.mint({ workspaceId: 'docker/api', sessionId: 's1' }); // replaces a
    assert.equal(w.agents.verify(a.env.PILOT_MCP_TOKEN!).ok, false);
    assert.equal(w.agents.verify(a.env.PILOT_MCP_TOKEN!).ok, false);
    assert.deepEqual(w.heals, ['s1 revoked'], 'once, not per call');
    w.tick(STALE_HEAL_EVERY_MS + 1);
    w.agents.verify(a.env.PILOT_MCP_TOKEN!);
    assert.equal(w.heals.length, 2, 'again after the pause');
    // Turned off on purpose: refused, no heal.
    const live = (await w.agents.mint({ workspaceId: 'docker/api', sessionId: 's1' }))!;
    w.agents.setEnabled('docker/api', false);
    w.tick(STALE_HEAL_EVERY_MS + 1);
    assert.equal(w.agents.verify(live.env.PILOT_MCP_TOKEN!).ok, false);
    assert.equal(w.heals.length, 2);
    // A session that is gone never heals.
    w.agents.setEnabled('docker/api', true);
    const x = (await w.agents.mint({ workspaceId: 'docker/api', sessionId: 's1' }))!;
    await w.agents.mint({ workspaceId: 'docker/api', sessionId: 's1' });
    w.alive.delete('s1');
    w.tick(STALE_HEAL_EVERY_MS + 1);
    w.agents.verify(x.env.PILOT_MCP_TOKEN!);
    assert.equal(w.heals.length, 2);
  } finally {
    w.done();
  }
});
