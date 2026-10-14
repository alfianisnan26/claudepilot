// `session_keepgoing_set` over the real Portal MCP endpoint (T-259 slice 2): an admin's token turns Keep going on after a confirmation and
// off without one; a token below admin and an agent's token never reach the tool; a chat the token's user may not operate, or an unknown one,
// answers NOT_FOUND; the fields are checked; the change is the engine's (one trail row, one audit row with the token as the actor).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOUNDING_USER_ID } from '@portal/contracts';
import { fakeOwner } from '../notify/testkit.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { KEEPGOING_TOOL_POLICIES } from './authz.js';
import { registerKeepGoingTools } from './portalTools.js';
import { rig } from './testkit.js';

async function build() {
  const owner = fakeOwner({ 'session:s_b': 'u_b' }, { fallback: FOUNDING_USER_ID });
  const r = await rig({ owner });
  r.chat.put('s_a');
  r.chat.put('s_b');
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  h.module.settings.update({ sessionControl: true });
  registerKeepGoingTools({ engine: r.engine, chat: r.chat, owner }, registry);
  return { r, h };
}

type Called = Awaited<ReturnType<Awaited<ReturnType<typeof portalMcpHarness>>['call']>>;
const code = (c: Called) => c.result?.structuredContent?.error?.code ?? c.error?.message ?? null;
/** A tool error (with or without a structured code: an input the schema refuses has only text) or a JSON-RPC error. */
const refused = (c: Called) => c.result?.isError === true || !!c.error;

test('an admin token turns Keep going on after a confirmation, off without one; audited with the token as the actor', async () => {
  const { r, h } = await build();
  try {
    const t = h.token('admin');
    const first = await h.call(t.secret, 'session_keepgoing_set', { session_id: 's_a', enabled: true, nudge_after_min: 6 });
    assert.equal(first.result?.structuredContent.status, 'confirmation_required', JSON.stringify(first.raw));
    assert.match(first.result!.structuredContent.preview.changes, /never answers a tool approval and never turns Bypass on/);
    assert.equal(r.engine.view('s_a'), null, 'nothing set before the confirmation');
    const token = first.result!.structuredContent.confirm_token as string;
    const on = await h.call(t.secret, 'session_keepgoing_set', { session_id: 's_a', enabled: true, nudge_after_min: 6, confirm_token: token });
    assert.equal(on.result?.isError, undefined, JSON.stringify(on.raw));
    assert.equal(on.result!.structuredContent.keep_going.enabled, true);
    assert.equal(r.engine.view('s_a')!.nudgeAfterMin, 6);
    const rows = r.auditRows('keepgoing.set');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.actor, `portal-mcp:${t.id}`);
    // A change of a number, and off: no confirmation.
    const more = await h.call(t.secret, 'session_keepgoing_set', { session_id: 's_a', max_nudges_per_day: 10 });
    assert.equal(more.result!.structuredContent.keep_going.max_nudges_per_day, 10);
    const off = await h.call(t.secret, 'session_keepgoing_set', { session_id: 's_a', enabled: false });
    assert.equal(off.result!.structuredContent.keep_going.enabled, false);
    assert.equal(r.engine.view('s_a')!.enabled, false);
  } finally {
    h.done();
  }
});

test('a token below admin and an agent never reach it; another user’s chat and an unknown one answer NOT_FOUND; the fields are checked', async () => {
  const { r, h } = await build();
  try {
    const operate = h.token('operate');
    const narrow = await h.call(operate.secret, 'session_keepgoing_set', { session_id: 's_a', enabled: true });
    assert.ok(refused(narrow), 'a token below admin is refused');
    const agent = await h.agentToken('docker/api-dev', 's_a');
    const self = await h.call(agent.secret, 'session_keepgoing_set', { session_id: 's_a', enabled: true });
    assert.ok(refused(self), 'a chat never keeps itself going');
    const admin = h.token('admin');
    assert.equal(code(await h.call(admin.secret, 'session_keepgoing_set', { session_id: 's_b', enabled: true })), 'NOT_FOUND');
    assert.equal(code(await h.call(admin.secret, 'session_keepgoing_set', { session_id: 'nope', enabled: true })), 'NOT_FOUND');
    assert.ok(refused(await h.call(admin.secret, 'session_keepgoing_set', { session_id: 's_a', status_file: '../etc/passwd' })));
    assert.ok(refused(await h.call(admin.secret, 'session_keepgoing_set', { session_id: 's_a', nudge_after_min: 0 })));
    assert.equal(code(await h.call(admin.secret, 'session_keepgoing_set', { session_id: 's_a' })), 'VALIDATION_FAILED');
    assert.equal(r.engine.view('s_a'), null, 'nothing was set');
    assert.equal(r.engine.view('s_b'), null);
  } finally {
    h.done();
  }
});

test('the tool is declared through the seam: operate on the session, confirmed, audited', () => {
  assert.deepEqual(KEEPGOING_TOOL_POLICIES.session_keepgoing_set, { kind: 'objects', checks: [{ type: 'session', verb: 'operate', arg: 'session_id' }], confirm: true, audit: 'keepgoing.set' });
});
