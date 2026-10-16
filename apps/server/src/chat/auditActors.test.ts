// T-723 S3b: the callers that must name their own actor when they ask the controller for a control. Each test goes red when its call
// drops the actor (the control then lands as `portal`, the default), so none of these is covered only by a test that fakes the whole path.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { HANDOFF_ACTOR } from './handoff.js';
import { line, liveSession, sleep, until, type Live } from './testkit.js';

const resultLine = (sessionId: string) =>
  line({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false, session_id: sessionId });

/** Replaces the controller's control with a recorder that answers at once: what was asked, of whom, and by which actor. */
function recordControls(s: Live) {
  const seen: { id: string; op: string; actor: string | undefined }[] = [];
  s.controller.control = async (id, op, _args, opts) => {
    seen.push({ id, op, actor: opts?.actor });
  };
  return seen;
}

test('T-723 S3b (G2): the auto hand-off sets the QA worker’s mode and model as `portal:handoff`, not as `portal`', async () => {
  const s = await liveSession();
  try {
    s.controller.setAutoHandoff(s.id, true);
    const before = s.ws.tails.length;
    const impl = await s.controller.create({ workspaceId: 'docker/ws1', title: 'Impl', agent: 'implementer', ticketId: 'T-12' }, { actor: `session:${s.id}`, parentId: s.id });
    await until(() => s.ws.tails.length === before + 1);
    await until(() => s.controller.get(impl.id)?.state === 'idle');
    await sleep(20); // let the tail attach its data handler
    const tail = s.ws.tails.at(-1)!;
    const seen = recordControls(s);

    // The worker's turn ends with `DONE <40 hex>` on line 1: the portal starts QA for that commit.
    const csid = s.controller.get(impl.id)!.claudeSessionId;
    await s.controller.send(impl.id, randomUUID(), 'Do T-12.', { actor: `session:${s.id}` });
    const msg = s.controller.history(impl.id).findLast((e) => e.kind === 'user')!;
    tail.push(line({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'started', uuid: randomUUID(), session_id: csid }));
    tail.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: `DONE ${'a'.repeat(40)}` }] }, parent_tool_use_id: null, uuid: randomUUID() }));
    tail.push(resultLine(csid));

    await until(() => seen.length >= 2, 6000);
    assert.deepEqual(seen.map((c) => c.op), ['mode', 'model']);
    assert.deepEqual(seen.map((c) => c.actor), [HANDOFF_ACTOR, HANDOFF_ACTOR]);
    const qa = s.controller.list({ parentId: s.id }).find((c) => c.agent === 'qa-verifier');
    assert.ok(qa, 'the QA worker was started');
    assert.deepEqual(new Set(seen.map((c) => c.id)), new Set([qa.id]), 'both controls went to the QA worker');
  } finally {
    await s.done();
  }
});
