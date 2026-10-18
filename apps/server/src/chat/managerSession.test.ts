// The General Manager's session (T-968, D-80): made only through the manager option, never listed, launched with the pilot MCP alone (the
// person's manager token, not an agent token), every built-in tool off, its brief appended, and never bypass-capable.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MANAGER_RUNTIME_ID } from './controller.js';
import { liveSession, until } from './testkit.js';

const CONFIG = JSON.stringify({ mcpServers: { pilot: { type: 'http', url: '${PILOT_MCP_URL}', headers: { Authorization: 'Bearer ${PILOT_MCP_TOKEN}' } } } });

test('a manager session: not listed, the pilot MCP alone with the manager token, no built-in tools, its brief, not bypass-capable', async () => {
  const s = await liveSession();
  try {
    const asked: string[] = [];
    s.controller.agentAccess = { async mint() { asked.push('agent'); return { env: { PILOT_MCP_TOKEN: 'agent' }, mcpConfig: CONFIG, tokenId: 'agt_x' }; } };
    s.controller.managerAccess = {
      async mint(req) {
        asked.push(`manager ${req.ownerId}`);
        return { env: { PILOT_MCP_TOKEN: 'mgr', PILOT_MCP_URL: 'http://portal.invalid/mcp' }, mcpConfig: CONFIG, tokenId: 'mgt_x' };
      },
      brief: () => 'You are the general manager.',
    };
    const before = s.ws.tails.length;
    const m = await s.controller.create({ workspaceId: 'docker/ws1', title: 'General Manager' }, { manager: { ownerId: 'u_owner' } });
    await until(() => s.ws.tails.length === before + 1);
    assert.deepEqual(asked, ['manager u_owner'], 'the manager token, never an agent token');
    const args = s.ws.startArgs.at(-1)!;
    assert.ok(args.includes('--strict-mcp-config'), 'no other MCP server than the pilot');
    // Every built-in tool off (`--tools ""`), no project or user settings (so no hooks or plugins), no slash commands; measured on 2.1.296.
    assert.equal(args[args.indexOf('--tools') + 1], '', 'no built-in tools');
    assert.equal(args[args.indexOf('--setting-sources') + 1], '', 'no settings sources: no hooks');
    assert.ok(args.includes('--disable-slash-commands'));
    assert.ok(!args.includes('--settings') && !args.includes('--safe-mode'), 'no agent settings; safe mode would drop the MCP too');
    assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'You are the general manager.');
    assert.ok(s.ws.startExecs.at(-1)!.written.includes('PILOT_MCP_TOKEN=mgr'), 'the manager token on stdin');
    assert.equal(s.controller.get(m.id)!.bypassCapable, false);
    // Never in a list; found only as the person's manager.
    assert.ok(!s.controller.list().some((x) => x.id === m.id), 'not in the Sessions list');
    assert.equal(s.controller.managerOf('u_owner')?.id, m.id);
    assert.equal(s.controller.managerOf('u_other'), null);
    // A workspace session still gets its agent token and none of this.
    const w = await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.ws.tails.length === before + 2);
    assert.equal(asked.at(-1), 'agent');
    assert.ok(!s.ws.startArgs.at(-1)!.includes('--strict-mcp-config'));
    assert.ok(s.controller.list().some((x) => x.id === w.id));
  } finally {
    await s.done();
  }
});

test('the manager runtime takes only a manager session', async () => {
  const s = await liveSession();
  try {
    await assert.rejects(s.controller.create({ workspaceId: MANAGER_RUNTIME_ID }), (e: { code?: string }) => e.code === 'CHAT_INELIGIBLE');
  } finally {
    await s.done();
  }
});
