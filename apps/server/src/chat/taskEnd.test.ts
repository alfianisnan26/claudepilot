// A task never outlives its process (ticket T-39): after a Move, a restart, a wake or a portal start, the sub-agents and background commands
// of a process that is gone read `killed` with the time they ended, instead of "running" for ever (the owner saw 32 "running" where 3
// sub-agents and a few commands really ran). A Move ends only the old run's tasks; the new run's own keep running.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ChatStore } from './store.js';
import { firstTurn, init, line, liveSession, ok, until, USAGE_API_KEY, type Live } from './testkit.js';

const taskStarted = (taskId: string, type = 'local_agent') =>
  line({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: `toolu_${taskId}`, description: `task ${taskId}`, task_type: type, is_backgrounded: true });
const assistantText = (text: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid: randomUUID() });
const resultLine = (sessionId: string) =>
  line({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false, session_id: sessionId });
const status = (s: Live) => Object.fromEntries(s.controller.tasks(s.id).map((t) => [t.taskId, t.status]));

test('a Move ends the old run’s running tasks (killed, with an end time) and leaves the new run’s own running', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    s.tail.push(taskStarted('agent1'));
    s.tail.push(taskStarted('cmd1', 'local_bash'));
    await until(() => s.controller.tasks(s.id).filter((t) => t.status === 'running').length === 2);
    const work = await s.controller.createClaude('docker/ws1', 'Work');

    const moving = s.controller.switchClaude(s.id, work.id, { handoff: 'skip' });
    await until(() => s.ws.tails.length >= 2 && s.controller.get(s.id)!.claudeSessionId !== s.id);
    const newId = s.controller.get(s.id)!.claudeSessionId;
    const tail = s.ws.tails.at(-1)!;
    await until(() => s.ws.sends.some((x) => x.args[1] === newId && x.line.includes('transferred_context')));
    tail.push(init(newId));
    tail.push(taskStarted('agent2')); // the new run starts one of its own before the move finishes
    tail.push(assistantText('Got it.'));
    tail.push(resultLine(newId));
    tail.push(ok((await s.take('get_usage')).id, USAGE_API_KEY));
    await moving;

    assert.deepEqual(status(s), { agent1: 'killed', cmd1: 'killed', agent2: 'running' });
    assert.ok(s.controller.tasks(s.id).filter((t) => t.status === 'killed').every((t) => t.endedAt), 'each one ended at a time');
    assert.equal(s.controller.get(s.id)!.agentsRunning, 1);
    assert.deepEqual(Object.fromEntries(s.lastTasks()!.map((t) => [t.taskId, t.status])), status(s), 'tabs were told');
  } finally {
    await s.done();
  }
});

test('a move that is undone ends nothing: the old run kept running, and so did its tasks', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    s.controller.ackWaitMs = 250;
    s.tail.push(taskStarted('agent1'));
    await until(() => status(s).agent1 === 'running');
    const work = await s.controller.createClaude('docker/ws1', 'Work');
    await s.controller.switchClaude(s.id, work.id, { handoff: 'skip' }).catch(() => undefined);
    assert.equal(s.controller.get(s.id)!.claudeName, 'Default');
    assert.deepEqual(status(s), { agent1: 'running' });
  } finally {
    await s.done();
  }
});

test('a restart ends the running tasks of the process it stops', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    await firstTurn(s);
    s.tail.push(taskStarted('agent1'));
    s.tail.push(taskStarted('cmd1', 'local_bash'));
    await until(() => Object.keys(status(s)).length === 2);
    await s.answering(s.controller.restart(s.id));
    assert.deepEqual(status(s), { agent1: 'killed', cmd1: 'killed' });
  } finally {
    await s.done();
  }
});

test('a new process starts with nothing of the old one running, whatever the rows said (a wake after a stale sleep)', async () => {
  const s = await liveSession();
  try {
    s.tail.push(taskStarted('agent1'));
    await until(() => status(s).agent1 === 'running');
    // As a portal that died mid-way would have left it: asleep, its task still "running".
    new ChatStore(s.store).patchSession(s.id, { process: 'asleep' });
    await s.controller.send(s.id, 'm1', 'wake up');
    await until(() => s.ws.tails.length >= 2);
    await until(() => status(s).agent1 === 'killed');
    assert.equal(s.controller.get(s.id)!.agentsRunning, 0);
  } finally {
    await s.done();
  }
});

test('at a portal start, tasks of a session whose process isn’t live are closed; a live one’s are left to its liveness round', async () => {
  const s = await liveSession();
  const other = await s.controller.create({ workspaceId: 'docker/ws1' });
  try {
    await until(() => s.ws.tails.length === 2 && s.controller.get(other.id)?.state === 'idle');
    s.tail.push(taskStarted('agent1'));
    s.ws.tails[1]!.push(taskStarted('agent2'));
    await until(() => status(s).agent1 === 'running' && s.controller.tasks(other.id)[0]?.status === 'running');
    new ChatStore(s.store).patchSession(s.id, { process: 'gone', state: 'interrupted' });
    s.controller.start();
    await until(() => status(s).agent1 === 'killed');
    assert.ok(s.controller.tasks(s.id)[0]!.endedAt);
    assert.equal(s.lastTasks()?.[0]?.status, 'killed', 'tabs were told');
    assert.equal(s.controller.tasks(other.id)[0]!.status, 'running', 'a live process keeps its tasks');
  } finally {
    await s.controller.end(other.id).catch(() => undefined);
    await s.done();
  }
});
