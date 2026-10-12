import assert from 'node:assert/strict';
import { test } from 'node:test';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { claude, HOUR, NOW, planResult, usageHarness, win } from './fixtures.js';
import { registerClaudeUsageTools } from './portalTools.js';

const reset5h = NOW + 4 * HOUR;
const resetWeek = NOW + 3 * 24 * HOUR;

async function rig() {
  const registry = new ToolRegistry();
  const mcp = await portalMcpHarness({ registry });
  const u = await usageHarness({
    probe: (async (c: { id: string }) =>
      c.id === 'own'
        ? planResult([win('session', 100, reset5h, 'Session'), win('week', 40, resetWeek, 'Week'), win('model:fable', 88, resetWeek, 'Fa​ble')])
        : planResult([win('session', 10, reset5h, 'Session')])) as never,
  });
  u.source.list = [claude({ id: 'own', name: 'Satria', workspaceId: 'docker/api', workspaceName: 'api' }), claude({ id: 'other', name: 'Rama', workspaceId: 'docker/web', workspaceName: 'web' }), claude({ id: 'key', name: 'Dewi', workspaceId: 'docker/web', workspaceName: 'web' })];
  u.source.sessions.set('sa', { workspaceId: 'docker/api', claudeId: 'own' });
  registerClaudeUsageTools(u.usage, registry);
  await u.usage.tick();
  await new Promise((r) => setTimeout(r, 10));
  return { mcp, u, done: () => (u.done(), mcp.done()) };
}

test('an admin token reads every Claude, or one; the windows carry percent used and left, reset times and the state', async () => {
  const r = await rig();
  try {
    const t = r.mcp.token('read');
    const { client, close } = await r.mcp.client(t.secret, 'modern');
    try {
      assert.ok((await client.listTools()).tools.some((x) => x.name === 'claude_usage'));
      const all = (await client.callTool({ name: 'claude_usage', arguments: {} })) as { structuredContent: any; content: { text: string }[]; isError?: boolean };
      assert.equal(all.isError, undefined);
      const ids = all.structuredContent.claudes.map((c: { claude_id: string }) => c.claude_id).sort();
      assert.deepEqual(ids, ['key', 'other', 'own']);
      const own = all.structuredContent.claudes.find((c: { claude_id: string }) => c.claude_id === 'own');
      assert.equal(own.state, 'exhausted');
      assert.equal(own.plan, 'max');
      assert.deepEqual(own.windows.slice(0, 2).map((w: { key: string; used_pct: number; left_pct: number }) => [w.key, w.used_pct, w.left_pct]), [['session', 100, 0], ['week', 40, 60]]);
      assert.equal(own.windows[0].label, 'Session', 'the portal’s own labels are plain');
      assert.deepEqual(own.windows[2].label, { untrusted_text: 'Fable', source: 'claude-usage' }, 'a model’s name comes from a third party: labelled, hidden characters removed');
      assert.match(all.content[0]!.text, /3 Claudes: 1 out of usage/);
      const one = (await client.callTool({ name: 'claude_usage', arguments: { claude_id: 'own' } })) as { structuredContent: any; content: { text: string }[] };
      assert.equal(one.structuredContent.claudes.length, 1);
      assert.match(one.content[0]!.text, /Satria: out of usage until /);
      const missing = (await client.callTool({ name: 'claude_usage', arguments: { claude_id: 'nobody' } })) as { isError?: boolean };
      assert.equal(missing.isError, true);
      // Nothing that names an account, a login or a workspace-side secret.
      assert.ok(!/email|organi[sz]ation|token|credential|orgName/i.test(JSON.stringify(all.structuredContent)));
    } finally {
      await close();
    }
  } finally {
    r.done();
  }
});

test('an agent reads only the Claude its own session runs in, and is refused another', async () => {
  const r = await rig();
  try {
    const agent = await r.mcp.agentToken('docker/api', 'sa');
    const { client, close } = await r.mcp.client(agent.secret, 'modern');
    try {
      const mine = (await client.callTool({ name: 'claude_usage', arguments: {} })) as { structuredContent: any; isError?: boolean };
      assert.equal(mine.isError, undefined);
      assert.deepEqual(mine.structuredContent.claudes.map((c: { claude_id: string }) => c.claude_id), ['own']);
      const other = (await client.callTool({ name: 'claude_usage', arguments: { claude_id: 'other' } })) as { isError?: boolean };
      assert.equal(other.isError, true, 'another Claude is not its to read');
      const itself = (await client.callTool({ name: 'claude_usage', arguments: { claude_id: 'own' } })) as { isError?: boolean };
      assert.equal(itself.isError, undefined);
    } finally {
      await close();
    }
  } finally {
    r.done();
  }
});
