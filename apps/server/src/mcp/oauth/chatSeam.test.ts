import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLine } from '../../chat/protocol.js';
import { APPLIED, line, liveSession, ok, sleep, until } from '../../chat/testkit.js';

// MCP set PRD §13.3: a chat session's `system/init` lists each server's status (✅ `needs-auth`); the portal's own
// OAuth servers that need a sign-in get one note in the transcript, and the MCP module learns their state.

const initLine = (sessionId: string, mcpServers: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5-5', permissionMode: 'default', apiKeySource: 'apiKeyHelper', mcp_servers: mcpServers, ...extra });

test('parseLine: a main-thread system/init carries only the portal’s own MCP servers, with their status', () => {
  const servers = [
    { name: 'plugin:cpm-lab:gitea', status: 'needs-auth' },
    { name: 'plugin:cpm-lab:cf', status: 'connected' },
    { name: 'plugin:other:thing', status: 'connected' }, // not the portal's
    { name: 'github', status: 'connected' }, // the user's own
    { name: 'plugin:cpm-lab:ok', status: 'CONNECTED!!' }, // a status that isn't a word
    { name: 'plugin:cpm-lab:x', status: 42 },
    'junk',
  ];
  const p = parseLine(initLine('S', servers));
  assert.deepEqual(p.mcpServers, [
    { name: 'plugin:cpm-lab:gitea', status: 'needs-auth' },
    { name: 'plugin:cpm-lab:cf', status: 'connected' },
  ]);
  assert.equal(parseLine(initLine('S', [], {})).mcpServers, undefined);
  assert.equal(parseLine(line({ type: 'system', subtype: 'init', session_id: 'S' })).mcpServers, undefined);
  assert.equal(parseLine(initLine('S', servers, { parent_tool_use_id: 'toolu_1' })).mcpServers, undefined, 'a sub-agent’s init is not the session’s');
  assert.equal(parseLine(initLine('S', 'not a list')).mcpServers, undefined);
});

test('controller: an OAuth server that needs a sign-in gets one note per process; the module hears every init', async () => {
  const s = await liveSession();
  try {
    const heard: { ws: string; dir: string; servers: { name: string; status: string }[] }[] = [];
    s.controller.mcpServersSeen = (ws, dir, servers) => {
      heard.push({ ws, dir, servers });
      return servers.filter((x) => x.status === 'needs-auth').map(() => 'Gitea');
    };
    const servers = [
      { name: 'plugin:cpm-lab:gitea', status: 'needs-auth' },
      { name: 'plugin:cpm-lab:cf', status: 'connected' },
    ];
    s.tail.push(initLine(s.id, servers));
    s.tail.push(ok((await s.take('get_settings')).id, APPLIED));
    await until(() => s.controller.history(s.id).some((e) => /Sign in to Gitea/.test(e.text ?? '')));
    s.tail.push(initLine(s.id, servers)); // the next turn's init
    await until(() => heard.length === 2);
    await sleep(30);
    const notes = s.controller.history(s.id).filter((e) => /Sign in to/.test(e.text ?? ''));
    assert.equal(notes.length, 1, 'once per process');
    assert.match(notes[0]!.text!, /^Sign in to Gitea: .*MCP servers/);
    assert.deepEqual(heard[0], { ws: 'docker/ws1', dir: '', servers });
    // The servers that are fine say nothing, and a hook that throws changes nothing.
    s.controller.mcpServersSeen = () => {
      throw new Error('boom');
    };
    s.tail.push(initLine(s.id, servers));
    await sleep(50);
    assert.equal(s.state(), 'idle');
  } finally {
    await s.done();
  }
});
