// One definition of working (ticket T-41): a session is working while its main turn runs OR any task of its current process runs, and
// idle only when neither does. The controller presents it (state `working`, `tasksOnly` when only tasks keep it so) to tabs, the list
// and the notifier; the stored state stays the turn's, which sends, restarts and moves go by.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ChatServerMessage } from '@portal/contracts';
import { line, liveSession, ok, until, USAGE_API_KEY } from './testkit.js';

const taskStarted = (taskId: string, type = 'local_agent') =>
  line({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: `toolu_${taskId}`, description: `task ${taskId}`, task_type: type, is_backgrounded: true });
const taskDone = (taskId: string) => line({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: `toolu_${taskId}`, status: 'completed', summary: 'ok' });
const assistantText = (text: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid: randomUUID() });
const resultLine = (sessionId: string) =>
  line({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false, session_id: sessionId });

test('a turn that ends while its tasks run reads working (tasksOnly) until the last one ends; tabs hear each change of the count', async () => {
  const s = await liveSession();
  try {
    await s.controller.send(s.id, 'm1', 'start two agents and a watcher');
    s.tail.push(taskStarted('a1'));
    s.tail.push(taskStarted('a2'));
    s.tail.push(taskStarted('w1', 'local_bash'));
    s.tail.push(assistantText('Started them.'));
    s.tail.push(resultLine(s.id));
    s.tail.push(ok((await s.take('get_usage')).id, USAGE_API_KEY));
    await until(() => s.controller.history(s.id).some((e) => e.kind === 'result') && s.controller.get(s.id)!.agentsRunning === 3);

    const shown = s.controller.get(s.id)!;
    assert.deepEqual([shown.state, shown.tasksOnly, shown.agentsRunning], ['working', true, 3], 'the turn is over, its tasks are not');
    assert.equal(s.controller.list()[0]!.state, 'working', 'the list says the same');
    const lastSession = () => s.messages.findLast((m): m is Extract<ChatServerMessage, { type: 'session' }> => m.type === 'session')!.session;
    await until(() => lastSession().state === 'working' && lastSession().agentsRunning === 3);

    s.tail.push(taskDone('a1'));
    await until(() => lastSession().agentsRunning === 2);
    assert.equal(lastSession().state, 'working');
    s.tail.push(taskDone('a2'));
    s.tail.push(taskDone('w1'));
    await until(() => lastSession().agentsRunning === 0);
    assert.equal(lastSession().state, 'idle', 'idle only when the turn is over and nothing runs');
    assert.equal(lastSession().tasksOnly, undefined);
    assert.equal(s.controller.get(s.id)!.state, 'idle');
  } finally {
    await s.done();
  }
});

test('a session working only through its tasks still takes a message at once (the stored state is the turn’s)', async () => {
  const s = await liveSession();
  try {
    s.tail.push(taskStarted('a1'));
    await until(() => s.controller.get(s.id)!.tasksOnly === true);
    await s.controller.send(s.id, 'm2', 'how is it going?');
    await until(() => s.ws.sends.some((x) => x.line.includes('how is it going?')));
  } finally {
    await s.done();
  }
});
