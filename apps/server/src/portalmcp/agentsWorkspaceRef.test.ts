// T-42 slice 3 (docs/prd/targets-connect.md §24.4): agent access stores the workspace's stable id (the opt-in and each token) and reads it as
// the key; rows written before (the key) still count; the background rewrite moves them; and, the point of it, a REMOVED workspace's opt-in
// and tokens never pass for a new workspace that took the name.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { WorkspaceIdentities } from '../workspaces/identity.js';
import { rewriteWorkspaceRefs } from '../workspaces/refRewrite.js';
import { AgentAccess } from './agents.js';

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-agentref-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const ids = new WorkspaceIdentities(store);
  const agents = new AgentAccess(store, { alive: () => true, url: () => 'http://portal.invalid/mcp' });
  agents.workspaceRefs = ids;
  const q = (sql: string, ...args: string[]) => store.db!.prepare(sql).all(...args) as Record<string, unknown>[];
  const done = () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, ids, agents, q, done };
}

test('agent access: the opt-in and the token store the id; the token’s principal carries the key; old key rows still count and still revoke', async () => {
  const w = await world();
  try {
    const api = w.ids.allocate('docker', 'api');
    w.agents.setEnabled('docker/api', true);
    assert.deepEqual(w.q('SELECT workspace_id FROM pmcp_agent_access').map((r) => r.workspace_id), [api.id]);
    assert.deepEqual(w.agents.enabledWorkspaces(), ['docker/api']);
    const grant = (await w.agents.mint({ workspaceId: 'docker/api', sessionId: 's1' }))!;
    assert.equal(grant.env.PILOT_WORKSPACE_ID, 'docker/api', 'the session is told the key, as before');
    assert.deepEqual(w.q('SELECT workspace_id FROM pmcp_agent_tokens').map((r) => r.workspace_id), [api.id]);
    const v = w.agents.verify(grant.env.PILOT_MCP_TOKEN);
    assert.ok(v.ok && v.principal.workspaceId === 'docker/api');
    assert.deepEqual([...w.agents.liveCounts()], [['docker/api', 1]]);
    // A token written before slice 3 (the key) still counts, and turning access off revokes it too.
    const old = (await w.agents.mint({ workspaceId: 'docker/api', sessionId: 's2' }))!;
    w.store.db!.prepare('UPDATE pmcp_agent_tokens SET workspace_id = ? WHERE id = ?').run('docker/api', old.tokenId);
    assert.ok(w.agents.verify(old.env.PILOT_MCP_TOKEN).ok);
    assert.deepEqual([...w.agents.liveCounts()], [['docker/api', 2]]);
    assert.equal(w.agents.setEnabled('docker/api', false).revoked, 2);
    assert.equal(w.q('SELECT count(*) AS n FROM pmcp_agent_access')[0]!.n, 0);
    // An opt-in written before (the key) is honoured, and is not doubled by turning it on again.
    w.store.db!.prepare('INSERT INTO pmcp_agent_access (workspace_id, enabled_at) VALUES (?, ?)').run('docker/api', new Date().toISOString());
    assert.ok(w.agents.enabled('docker/api'));
    w.agents.setEnabled('docker/api', true);
    assert.equal(w.q('SELECT count(*) AS n FROM pmcp_agent_access')[0]!.n, 1);
    // After a rename (slice 2) it is the same workspace by every form.
    w.ids.relabel(api.id, 'isnan-pod');
    assert.ok(w.agents.enabled('docker/isnan-pod'));
  } finally {
    w.done();
  }
});

test('agent access: a removed workspace’s opt-in and tokens never pass for a new workspace of that name, whichever form they were stored in', async () => {
  const w = await world();
  try {
    w.ids.allocate('docker', 'api');
    w.agents.setEnabled('docker/api', true);
    const byId = (await w.agents.mint({ workspaceId: 'docker/api', sessionId: 's1' }))!;
    const byKey = (await w.agents.mint({ workspaceId: 'docker/api', sessionId: 's2' }))!;
    w.store.db!.prepare('UPDATE pmcp_agent_tokens SET workspace_id = ? WHERE id = ?').run('docker/api', byKey.tokenId);
    w.ids.retire('docker', 'api');
    w.ids.allocate('docker', 'api');
    assert.equal(w.agents.enabled('docker/api'), false, 'the new workspace has not opted in');
    assert.deepEqual(w.agents.enabledWorkspaces(), []);
    for (const g of [byId, byKey]) {
      const v = w.agents.verify(g.env.PILOT_MCP_TOKEN);
      assert.equal(v.ok, false, 'the old token does not pass');
    }
    assert.equal(await w.agents.mint({ workspaceId: 'docker/api', sessionId: 's3' }), null, 'and nothing is minted for the new one');
  } finally {
    w.done();
  }
});

test('agent access: the rewrite moves old rows, and a key row whose id row exists is dropped, not doubled', async () => {
  const w = await world();
  try {
    const api = w.ids.allocate('docker', 'api');
    const web = w.ids.allocate('docker', 'web');
    const at = new Date().toISOString();
    w.store.db!.prepare('INSERT INTO pmcp_agent_access (workspace_id, enabled_at) VALUES (?, ?), (?, ?), (?, ?)').run('docker/api', at, api.id, at, 'docker/web', at);
    const results = await rewriteWorkspaceRefs(w.store, w.ids, { pauseMs: 0 });
    const r = results.find((x) => x.table === 'pmcp_agent_access')!;
    assert.deepEqual([r.rewritten, r.done], [2, true]);
    assert.deepEqual(w.q('SELECT workspace_id FROM pmcp_agent_access ORDER BY workspace_id').map((x) => x.workspace_id), [api.id, web.id].sort());
    assert.deepEqual(w.agents.enabledWorkspaces(), ['docker/api', 'docker/web']);
  } finally {
    w.done();
  }
});
