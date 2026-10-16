// `session_rename_self` (I11, owner: "the claude inside can adjust itself, including names"): a session renames only itself,
// through its own token, rate limited; what it writes is a workspace's text, so hidden characters and credentials go and the
// transcript says the chat did it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { registerChatTools } from './portalTools.js';
import { liveSession, until } from './testkit.js';

async function rig() {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const s = await liveSession();
  registerChatTools(s.controller, registry);
  const other = await s.controller.create({ workspaceId: 'docker/ws1', title: 'Other' });
  h.alive.add(s.id);
  h.alive.add(other.id);
  return { h, s, other, done: async () => (h.done(), s.done()) };
}

test('an agent renames its own chat over MCP: the title changes, the transcript says who, and nothing else is touched', async () => {
  const r = await rig();
  try {
    const a = await r.h.agentToken('docker/ws1', r.s.id);
    const done = await r.h.call(a.secret, 'session_rename_self', { title: '  Fix the\nlogin redirect  ' });
    assert.equal(done.result?.isError, undefined, JSON.stringify(done.raw));
    assert.equal(done.result?.structuredContent.title, 'Fix the login redirect');
    assert.equal(r.s.controller.get(r.s.id)!.title, 'Fix the login redirect');
    assert.ok(r.s.controller.history(r.s.id).some((e) => e.kind === 'system' && e.text === 'Claude named this chat “Fix the login redirect”.'));
    assert.equal(r.s.controller.get(r.other.id)!.title, 'Other', 'no other chat changed');
    // The same title again changes and says nothing more.
    const before = r.s.controller.history(r.s.id).length;
    await r.h.call(a.secret, 'session_rename_self', { title: 'Fix the login redirect' });
    assert.equal(r.s.controller.history(r.s.id).length, before);
  } finally {
    await r.done();
  }
});

test('an agent can only rename itself; an admin’s token names the chat it means', async () => {
  const r = await rig();
  try {
    const a = await r.h.agentToken('docker/ws1', r.s.id);
    const refused = await r.h.call(a.secret, 'session_rename_self', { title: 'Mine now', session_id: r.other.id });
    assert.equal(refused.result?.isError, true, 'another session is not its own');
    assert.equal(r.s.controller.get(r.other.id)!.title, 'Other');

    const admin = r.h.token('operate');
    const noId = await r.h.call(admin.secret, 'session_rename_self', { title: 'x' });
    assert.equal(noId.result?.isError, true, 'an admin’s token has to say which chat');
    const named = await r.h.call(admin.secret, 'session_rename_self', { title: 'Named by an admin token', session_id: r.other.id });
    assert.equal(named.result?.isError, undefined);
    assert.equal(r.s.controller.get(r.other.id)!.title, 'Named by an admin token');
  } finally {
    await r.done();
  }
});

test('what the chat writes is workspace text: hidden characters and credentials go, length and emptiness are refused, and it is rate limited', async () => {
  const r = await rig();
  try {
    const a = await r.h.agentToken('docker/ws1', r.s.id);
    const title = (t: string) => r.h.call(a.secret, 'session_rename_self', { title: t });
    const tags = String.fromCodePoint(0xe0049, 0xe0067);
    await title(`Deploy‮​${tags} plan\u0007`);
    assert.equal(r.s.controller.get(r.s.id)!.title, 'Deploy plan');
    // A credential-shaped title is refused by the portal before the tool runs; a secret the workspace holds is taken out here.
    const shaped = await title(`Token ghp_${'a1B2'.repeat(6)} rotation`);
    assert.equal(shaped.result?.structuredContent.error.code, 'SECRET_IN_ARGUMENT');
    r.s.controller.valuesCacheMs = 0;
    r.s.controller.secretValues = () => ['Tr0ub4dor&3-internal'];
    await title('Rotate Tr0ub4dor&3-internal today');
    assert.equal(r.s.controller.get(r.s.id)!.title, 'Rotate [redacted] today');
    for (const bad of ['', '   ', '​​', 'x'.repeat(81)]) {
      const refused = await title(bad);
      assert.equal(refused.result?.isError === true || refused.error !== undefined, true, JSON.stringify(bad));
    }
    assert.equal(r.s.controller.get(r.s.id)!.title, 'Rotate [redacted] today', 'a refused title changes nothing');
    // Emoji with a joiner survive for a person; only the chat's own text is cleaned.
    r.s.controller.rename(r.s.id, '👨‍👩‍👧 family');
    assert.equal(r.s.controller.get(r.s.id)!.title, '👨‍👩‍👧 family');
    // Six a minute.
    let limited = 0;
    for (let i = 0; i < 8; i++) {
      const res = await title(`Name ${i}`);
      if (res.result?.isError || res.error) limited++;
    }
    assert.ok(limited >= 2, `the rate limit held (${limited} refused)`);
  } finally {
    await r.done();
  }
});

test('T-723 S3b (G4): session_spawn sets the worker’s mode, model and effort as the session that spawned it, not as `portal`', async () => {
  const r = await rig();
  try {
    r.s.controller.agentCaps = () => ({ maxDepth: 1, maxChildren: 5, spawnsPerHour: 20, messagesPerHour: 40 });
    const seen: { id: string; op: string; actor: string | undefined }[] = [];
    r.s.controller.control = async (id, op, _args, opts) => {
      seen.push({ id, op, actor: opts?.actor });
    };
    const a = await r.h.agentToken('docker/ws1', r.s.id);
    const spawned = await r.h.call(a.secret, 'session_spawn', { prompt: 'Look around.', title: 'Scout', mode: 'plan', model: 'sonnet', effort: 'high' });
    assert.equal(spawned.result?.isError, undefined, JSON.stringify(spawned.raw));
    const id = spawned.result!.structuredContent.session.id as string;
    await until(() => seen.length >= 3, 4000);
    assert.deepEqual(seen.map((c) => c.op), ['mode', 'model', 'effort']);
    assert.deepEqual(seen.map((c) => c.actor), Array(3).fill(`session:${r.s.id}`));
    assert.deepEqual(new Set(seen.map((c) => c.id)), new Set([id]));
  } finally {
    await r.done();
  }
});
