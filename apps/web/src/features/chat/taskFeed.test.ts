// What the transcript hands the Agents panel (ticket T-149): the calls behind the tasks, per session, and a change only when there is one.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatEvent, ChatTask } from '@portal/contracts';
import { publishTaskFeed, readTaskFeed, subscribeTaskFeed, taskCalls, type TaskFeed } from './taskFeed';

const ev = (seq: number, e: Partial<ChatEvent>): ChatEvent => ({ seq, at: '2026-10-14T12:00:00.000Z', kind: 'tool_use', ...e });
const task = (toolUseId: string | null): ChatTask => ({
  taskId: `t-${toolUseId}`,
  toolUseId,
  description: 'x',
  subagentType: null,
  model: null,
  status: 'running',
  tokens: null,
  toolUses: null,
  durationMs: null,
  summary: null,
  startedAt: '2026-10-14T12:00:00.000Z',
  endedAt: null,
});

describe('taskCalls', () => {
  it('keeps the calls that started a task, and nothing else', () => {
    const events = [
      ev(1, { toolName: 'Bash', toolUseId: 'toolu_a', toolInput: { command: 'npm test' } }),
      ev(2, { toolName: 'Read', toolUseId: 'toolu_b' }),
      ev(3, { kind: 'tool_result', toolUseId: 'toolu_a', text: 'Command running in background' }),
      ev(4, { toolName: 'Bash', toolUseId: 'toolu_c', toolInput: { command: 'sleep 9' } }),
    ];
    const calls = taskCalls(events, [task('toolu_a'), task('toolu_c'), task(null)]);
    assert.deepEqual([...calls.keys()], ['toolu_a', 'toolu_c']);
    assert.equal(calls.get('toolu_a')?.seq, 1);
    assert.equal(taskCalls(events, []).size, 0);
  });
});

describe('publishTaskFeed', () => {
  it('tells the readers of that session only, and only when the feed changed', () => {
    const seen: string[] = [];
    const offA = subscribeTaskFeed('qa-a', () => seen.push('a'));
    const offB = subscribeTaskFeed('qa-b', () => seen.push('b'));
    const feed: TaskFeed = { calls: new Map(), rows: new Map() };
    publishTaskFeed('qa-a', feed);
    publishTaskFeed('qa-a', feed); // the same feed: no news
    assert.deepEqual(seen, ['a']);
    assert.equal(readTaskFeed('qa-a'), feed);
    publishTaskFeed('qa-a', null); // its transcript went away
    assert.deepEqual(seen, ['a', 'a']);
    assert.equal(readTaskFeed('qa-a').calls.size, 0);
    offA();
    offB();
    publishTaskFeed('qa-a', { calls: new Map(), rows: new Map() });
    assert.deepEqual(seen, ['a', 'a']);
    publishTaskFeed('qa-a', null);
  });
});
