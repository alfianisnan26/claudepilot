// Sub-agents in a chat (chat-sessions PRD, the Agents panel; tickets T-5 and T-31): the model each runs on, taken only from what Claude Code
// reports (the launch result's resolvedModel, then its own lines' message.model; never the call's `model` argument), and one sub-agent's own
// transcript (GET /api/chat/sessions/:id/tasks/:taskId/events): its lines only, redacted as stored, bounded, and 404 for whoever may not view
// the session. Stored events and live deltas name the Task call a sub-agent line belongs to (`parentToolUseId`).
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { TASK_EVENTS_MAX, type ChatServerMessage, type ChatTaskTranscript } from '@portal/contracts';
import { Hono } from 'hono';
import { clearResolvers, declaredPolicies } from '../authz/seam.js';
import { registerChatAuthz } from './authz.js';
import { parseLine } from './protocol.js';
import { createChatRoutes } from './routes.js';
import { line, liveSession, until } from './testkit.js';

afterEach(() => clearResolvers());

const agentLine = (parent: string, content: unknown[], model: unknown = 'claude-haiku-5-5', uuid = `u-${Math.random()}`) =>
  line({ type: 'assistant', message: { model, content }, parent_tool_use_id: parent, agent_id: 'a1', uuid });
const launchCall = (id: string, description: string, input: Record<string, unknown> = {}) =>
  line({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id, name: 'Agent', input: { description, prompt: 'SECRET PROMPT', ...input } }] }, parent_tool_use_id: null, uuid: `c-${id}` });
const started = (taskId: string, toolUseId: string, description: string) =>
  line({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, description, subagent_type: 'general-purpose', is_backgrounded: true, task_type: 'local_agent' });
const launched = (toolUseId: string, resolvedModel: unknown) =>
  line({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] },
    parent_tool_use_id: null,
    tool_use_result: { isAsync: true, status: 'async_launched', agentId: 'a1', resolvedModel },
  });

test('parseLine: a sub-agent line names the model that answered; the launch result names the one it started on; nothing else does', () => {
  assert.deepEqual(parseLine(agentLine('toolu_a', [{ type: 'text', text: 'hi' }])).agentModels, [{ toolUseId: 'toolu_a', model: 'claude-haiku-5-5', source: 'observed' }]);
  assert.deepEqual(parseLine(launched('toolu_a', 'claude-fable-5-1')).agentModels, [{ toolUseId: 'toolu_a', model: 'claude-fable-5-1', source: 'launched' }]);
  // The main agent's own lines speak for the session, not for a sub-agent; a synthetic line or a malformed id is no model.
  assert.equal(parseLine(launchCall('toolu_a', 'Scan', { model: 'opus' })).agentModels, undefined, 'the call’s model argument is only a request');
  assert.equal(parseLine(agentLine('toolu_a', [{ type: 'text', text: 'x' }], '<synthetic>')).agentModels, undefined);
  assert.equal(parseLine(agentLine('toolu_a', [{ type: 'text', text: 'x' }], 'claude opus; rm -rf')).agentModels, undefined);
  assert.equal(parseLine(agentLine('toolu_a', [{ type: 'text', text: 'x' }], 42)).agentModels, undefined);
  assert.equal(parseLine(launched('toolu_a', null)).agentModels, undefined);
  assert.deepEqual(parseLine(agentLine('toolu_a', [{ type: 'text', text: 'x' }], 'claude-opus-4-6[1m]')).agentModels?.[0]?.model, 'claude-opus-4-6[1m]');
});

test('controller: the model fills in at launch, what the agent’s lines report wins, and a task without one stays unavailable (null)', async () => {
  const s = await liveSession();
  try {
    s.tail.push(launchCall('toolu_a', 'Scan the repo', { model: 'opus' }));
    s.tail.push(started('t1', 'toolu_a', 'Scan the repo'));
    s.tail.push(line({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_bash', description: 'watch logs', task_type: 'local_bash' }));
    await until(() => s.lastTasks()?.length === 2);
    assert.deepEqual(s.lastTasks()!.map((t) => t.model), [null, null], 'nothing reported yet: unavailable, not the call’s "opus"');

    s.tail.push(launched('toolu_a', 'claude-sonnet-5-5'));
    await until(() => s.lastTasks()?.find((t) => t.taskId === 't1')?.model === 'claude-sonnet-5-5');
    s.tail.push(agentLine('toolu_a', [{ type: 'text', text: 'scanning' }], 'claude-haiku-5-5'));
    await until(() => s.lastTasks()?.find((t) => t.taskId === 't1')?.model === 'claude-haiku-5-5');
    // A later launch report doesn't undo what was observed; the same model again emits nothing new.
    const before = s.messages.filter((m) => m.type === 'tasks').length;
    s.tail.push(launched('toolu_a', 'claude-sonnet-5-5'));
    s.tail.push(agentLine('toolu_a', [{ type: 'text', text: 'still scanning' }], 'claude-haiku-5-5'));
    await until(() => s.controller.history(s.id).some((e) => e.text === 'still scanning'));
    assert.equal(s.controller.tasks(s.id).find((t) => t.taskId === 't1')!.model, 'claude-haiku-5-5');
    assert.equal(s.messages.filter((m) => m.type === 'tasks').length, before);
    assert.equal(s.controller.tasks(s.id).find((t) => t.taskId === 'b1')!.model, null, 'a background command has no model');

    // A model seen before its task row lands when the row arrives.
    s.tail.push(agentLine('toolu_late', [{ type: 'text', text: 'early' }], 'claude-fable-5-1'));
    s.tail.push(started('t2', 'toolu_late', 'Late one'));
    await until(() => s.lastTasks()?.find((t) => t.taskId === 't2')?.model === 'claude-fable-5-1');
    // The session counts what still runs.
    assert.equal(s.controller.get(s.id)!.agentsRunning, 3);
  } finally {
    await s.done();
  }
});

test('controller: a sub-agent’s own transcript is its lines only, redacted, newest kept, and resumable after a seq', async () => {
  const s = await liveSession();
  try {
    const secret = ['gh', 'p_'].join('') + 'CANARY' + 'x'.repeat(36);
    s.tail.push(launchCall('toolu_a', 'Agent A'));
    s.tail.push(launchCall('toolu_b', 'Agent B'));
    s.tail.push(started('ta', 'toolu_a', 'Agent A'));
    s.tail.push(started('tb', 'toolu_b', 'Agent B'));
    s.tail.push(agentLine('toolu_a', [{ type: 'tool_use', id: 'toolu_a1', name: 'Read', input: { file_path: '/etc/hostname' } }]));
    s.tail.push(agentLine('toolu_b', [{ type: 'text', text: 'B says hi' }]));
    s.tail.push(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: `token ${secret}` }] }, parent_tool_use_id: 'toolu_a' }));
    s.tail.push(agentLine('toolu_a', [{ type: 'text', text: 'A is done' }]));
    s.tail.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'main reply' }] }, parent_tool_use_id: null, uuid: 'm1' }));
    await until(() => s.controller.history(s.id).some((e) => e.text === 'main reply'));

    const a = s.controller.taskTranscript(s.id, 'ta');
    assert.equal(a.task.taskId, 'ta');
    assert.deepEqual(a.events.map((e) => [e.kind, e.text]), [
      ['tool_use', '/etc/hostname'],
      ['tool_result', 'token [redacted]'],
      ['assistant', 'A is done'],
    ]);
    assert.ok(a.events.every((e) => e.parentToolUseId === 'toolu_a' && e.agentLabel === 'Agent A'));
    assert.equal(a.truncated, false);
    assert.ok(!JSON.stringify(a).includes('CANARY') && !JSON.stringify(a).includes('SECRET PROMPT'));
    assert.deepEqual(s.controller.taskTranscript(s.id, 'tb').events.map((e) => e.text), ['B says hi']);
    // After a seq: only what is newer (the detail view polls this while the agent runs).
    assert.deepEqual(s.controller.taskTranscript(s.id, 'ta', a.events[1]!.seq).events.map((e) => e.text), ['A is done']);
    // The main transcript's events say whose they are.
    assert.equal(s.controller.history(s.id).find((e) => e.text === 'main reply')!.parentToolUseId, undefined);
    assert.equal(s.controller.history(s.id).find((e) => e.text === 'B says hi')!.parentToolUseId, 'toolu_b');
    assert.throws(() => s.controller.taskTranscript(s.id, 'nope'), (e: unknown) => isAppError(e) && e.status === 404);
    assert.throws(() => s.controller.taskTranscript('no-session', 'ta'), (e: unknown) => isAppError(e) && e.status === 404);
  } finally {
    await s.done();
  }
});

test('controller: the transcript is bounded: the newest TASK_EVENTS_MAX, and it says older ones were left out', async () => {
  const s = await liveSession();
  try {
    s.tail.push(started('ta', 'toolu_a', 'Chatty'));
    const n = TASK_EVENTS_MAX + 5;
    for (let i = 1; i <= n; i++) s.tail.push(agentLine('toolu_a', [{ type: 'text', text: `line ${i}` }]));
    await until(() => s.controller.history(s.id).some((e) => e.text === `line ${n}`), 10_000);
    const t = s.controller.taskTranscript(s.id, 'ta');
    assert.equal(t.events.length, TASK_EVENTS_MAX);
    assert.equal(t.truncated, true);
    assert.equal(t.events[0]!.text, 'line 6');
    assert.equal(t.events.at(-1)!.text, `line ${n}`);
  } finally {
    await s.done();
  }
});

test('deltas: a sub-agent’s live text names its Task call; the main agent’s does not', async () => {
  const s = await liveSession();
  try {
    s.tail.push(started('ta', 'toolu_a', 'Agent A'));
    s.tail.push(line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub' } }, parent_tool_use_id: 'toolu_a' }));
    s.tail.push(line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'main' } }, parent_tool_use_id: null }));
    const deltas = () => s.messages.filter((m): m is Extract<ChatServerMessage, { type: 'delta' }> => m.type === 'delta');
    await until(() => deltas().some((d) => d.text.includes('sub')) && deltas().some((d) => d.text.includes('main')), 5_000);
    const sub = deltas().find((d) => d.text.includes('sub'))!;
    assert.equal(sub.parentToolUseId, 'toolu_a');
    assert.equal(sub.agentLabel, 'Agent A');
    assert.equal(deltas().find((d) => d.text.includes('main'))!.parentToolUseId, undefined);
  } finally {
    await s.done();
  }
});

test('route: GET …/tasks/:taskId/events goes through the seam: declared, the owner reads it, another user gets the same 404', async () => {
  const s = await liveSession();
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    assert.deepEqual(declaredPolicies().get('GET /api/chat/sessions/:id/tasks/:taskId/events'), {
      kind: 'objects',
      checks: [{ type: 'session', verb: 'view', from: 'path', param: 'id' }],
    });
    s.tail.push(started('ta', 'toolu_a', 'Agent A'));
    s.tail.push(agentLine('toolu_a', [{ type: 'text', text: 'hello from A' }]));
    await until(() => s.controller.history(s.id).some((e) => e.text === 'hello from A'));

    const app = (actor: unknown) => {
      const a = new Hono();
      a.onError((e, c) => {
        const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
        return c.json(err.toJSON(), err.status as 404);
      });
      a.use(async (c, next) => {
        if (actor === 'owner') (c as unknown as { set(k: string, v: unknown): void }).set('token', 'signed-in');
        else if (actor) (c as unknown as { set(k: string, v: unknown): void }).set('actor', actor);
        await next();
      });
      a.route('/', createChatRoutes(s.controller));
      return a;
    };
    const owner = app('owner');
    const res = await owner.request(`/${s.id}/tasks/ta/events`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: ChatTaskTranscript };
    assert.deepEqual(body.data.events.map((e) => e.text), ['hello from A']);
    assert.equal(body.data.task.description, 'Agent A');
    const after = (await (await owner.request(`/${s.id}/tasks/ta/events?after=${body.data.events[0]!.seq}`)).json()) as { data: ChatTaskTranscript };
    assert.deepEqual(after.data.events, []);
    assert.equal((await owner.request(`/${s.id}/tasks/nope/events`)).status, 404);
    assert.equal((await owner.request('/nope/tasks/ta/events')).status, 404);

    const other = app({ kind: 'user', userId: 'u_a', loginSessionId: 'l1', via: 'ui' });
    const denied = await other.request(`/${s.id}/tasks/ta/events`);
    assert.equal(denied.status, 404, 'what you may not see is the same 404');
    assert.ok(!(await denied.text()).includes('hello from A'));
    assert.equal((await app(null).request(`/${s.id}/tasks/ta/events`)).status === 200, false, 'not signed in: refused');
  } finally {
    await s.done();
  }
});
