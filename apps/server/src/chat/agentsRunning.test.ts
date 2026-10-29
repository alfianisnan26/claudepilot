// T-3017: a session's agentsRunning (the UI, the flow watchdog, pilot-health's agent-cap advice and the lead's "over your limit" warning)
// counted sub-agents that had ended: a lead showed 10 running where 1 ran. Claude Code's `background_tasks_changed` is its whole set of
// background tasks still running (an empty set included); a background task that left it has ended even when no end line of its own came.
// And a chat whose process is over (asleep, gone, ended) runs nothing, whatever rows it left behind.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { parseLine } from './protocol.js';
import { ChatStore } from './store.js';
import { line, liveSession, until } from './testkit.js';

const started = (taskId: string, background: boolean) =>
  line({
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    description: `task ${taskId}`,
    task_type: 'local_agent',
    is_backgrounded: background,
  });
const runningSet = (ids: string[], parent?: string) =>
  line({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: ids.map((id) => ({ task_id: id, task_type: 'local_agent', description: `task ${id}` })),
    ...(parent ? { parent_tool_use_id: parent } : {}),
  });

test('parseLine: background_tasks_changed is the whole running set, an empty one included; a sub-agent’s own set is not the session’s', () => {
  assert.deepEqual(parseLine(runningSet(['a', 'b'])).taskSet, ['a', 'b']);
  assert.deepEqual(parseLine(runningSet([])).taskSet, [], 'an empty set says every background task ended');
  assert.equal(parseLine(runningSet([])).tasks, undefined);
  assert.equal(parseLine(runningSet(['a'], 'toolu_sub')).taskSet, undefined);
  assert.equal(parseLine(line({ type: 'system', subtype: 'background_tasks_changed' })).taskSet, undefined, 'no set says nothing');
});

test('agentsRunning: a background sub-agent that left the running set is not counted; one still in it and a foreground one are', async () => {
  const s = await liveSession();
  try {
    s.tail.push(started('bg1', true));
    s.tail.push(started('bg2', true));
    s.tail.push(started('bg3', true));
    s.tail.push(started('fg1', false));
    await until(() => s.controller.get(s.id)!.agentsRunning === 4);

    // bg1 and bg3 ended without an end line of their own: only the set says so.
    s.tail.push(runningSet(['bg2']));
    await until(() => s.controller.get(s.id)!.agentsRunning === 2);
    const status = () => Object.fromEntries(s.controller.tasks(s.id).map((t) => [t.taskId, t.status]));
    assert.deepEqual(status(), { bg1: 'completed', bg2: 'running', bg3: 'completed', fg1: 'running' });
    assert.ok(s.controller.tasks(s.id).filter((t) => t.status === 'completed').every((t) => t.endedAt), 'each one ended at a time');
    assert.deepEqual(Object.fromEntries(s.lastTasks()!.map((t) => [t.taskId, t.status])), status(), 'tabs were told');

    // The last background one ends: the set is empty. The foreground one still runs and still counts.
    s.tail.push(runningSet([]));
    await until(() => s.controller.get(s.id)!.agentsRunning === 1);
    assert.equal(status().bg2, 'completed');
    assert.equal(status().fg1, 'running');

    // Its own end line, coming later, still says how it really ended.
    s.tail.push(line({ type: 'system', subtype: 'task_notification', task_id: 'bg1', tool_use_id: 'toolu_bg1', status: 'failed', summary: 'x' }));
    await until(() => status().bg1 === 'failed');
    assert.equal(s.controller.get(s.id)!.agentsRunning, 1);
  } finally {
    await s.done();
  }
});

test('agentsRunning: a chat whose process is over (gone, asleep, ended) counts none of the rows it left running', async () => {
  const store = await Store.open({ dataDir: tempDirectory('cp-t3017-'), secretKey: parseSecretKey(generateSecretKey()) });
  try {
    const chat = new ChatStore(store);
    for (const id of ['L', 'G', 'A', 'E']) {
      chat.create({ id, workspaceId: 'docker/ws1', cwd: '/home/node', title: id, origin: 'ui' });
      chat.upsertTask(id, { taskId: `${id}1`, started: true, status: 'running', description: 'one' });
      chat.upsertTask(id, { taskId: `${id}2`, started: true, status: 'running', description: 'two' });
    }
    chat.patchSession('G', { process: 'gone', state: 'interrupted' }); // its process restarted or died
    chat.patchSession('A', { process: 'asleep' });
    chat.patchSession('E', { state: 'ended' }); // a chat that ended (its successor runs on)
    const want = { L: 2, G: 0, A: 0, E: 0 };
    assert.deepEqual(Object.fromEntries(['L', 'G', 'A', 'E'].map((id) => [id, chat.get(id)!.agentsRunning])), want);
    assert.deepEqual(Object.fromEntries(chat.list().map((x) => [x.id, x.agentsRunning])), want, 'the list counts the same');
  } finally {
    store.close();
  }
});
