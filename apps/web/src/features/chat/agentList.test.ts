// The Agents panel's list (ticket T-149): labels, one line per row, groups, counts, filters and search, as data.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatEvent, ChatTask } from '@portal/contracts';
import { callCommand, countTasks, exitCode, exitNote, firstLine, groupTasks, namedByCommand, NO_FILTER, taskLabel, taskLine, ticketOf, uniqueTasks } from './agentList';

let n = 0;
const at = (min: number) => new Date(Date.UTC(2026, 9, 14, 12, min)).toISOString();
function task(o: Partial<ChatTask> & { status: ChatTask['status'] }): ChatTask {
  n++;
  return {
    taskId: `t${n}`,
    toolUseId: `toolu_${n}`,
    description: `QA agent ${n}`,
    subagentType: null,
    model: null,
    tokens: null,
    toolUses: null,
    durationMs: null,
    summary: null,
    startedAt: at(n),
    endedAt: o.status === 'running' ? null : at(n + 1),
    ...o,
  };
}
const agent = (status: ChatTask['status'], o: Partial<ChatTask> = {}) => task({ status, subagentType: 'general-purpose', model: 'claude-sonnet-4-5', ...o });
const command = (status: ChatTask['status'], description: string, o: Partial<ChatTask> = {}) => task({ status, description, ...o });
const bash = (command: string, o: Partial<ChatEvent> = {}): ChatEvent => ({ seq: 1, at: at(0), kind: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_x', text: command, toolInput: { command, run_in_background: true }, ...o });

// The ticket's screenshot: a command named by its whole command line.
const LONG = 'cd /workspaces/claudepilot/apps/server && timeout 300 node --import tsx --test src/ci/imageBuild.test.ts 2>&1 | grep -E "^# (pass|fail)"';

describe('taskLabel: short, never the whole command line', () => {
  it('a sub-agent: its description', () => {
    assert.equal(taskLabel(agent('running', { description: 'T-149 slice 1: row anatomy' }), null), 'T-149 slice 1: row anatomy');
    assert.equal(taskLabel(agent('running', { description: '' }), null), 'general-purpose');
  });

  it('a command Claude described: its description', () => {
    assert.equal(taskLabel(command('running', 'QA sleeper'), 'sleep 4 && echo slept'), 'QA sleeper');
  });

  it('a command named by its command line: a label made from it, with or without its call', () => {
    assert.equal(taskLabel(command('failed', LONG), LONG), 'node test: imageBuild.test.ts');
    assert.equal(taskLabel(command('failed', LONG), null), 'node test: imageBuild.test.ts');
    // The portal keeps 200 characters of the description; the call has the whole command.
    const long = `${LONG} && ${'echo more && '.repeat(20)}true`;
    assert.equal(namedByCommand(`${long.slice(0, 199)}…`, long), true);
    assert.equal(taskLabel(command('running', `${long.slice(0, 199)}…`), long), 'node test: imageBuild.test.ts');
  });

  it('a short command line without a call reads as it is', () => {
    assert.equal(taskLabel(command('completed', 'sleep 30'), null), 'sleep 30');
    assert.equal(taskLabel(command('completed', 'sleep 30'), 'sleep 30'), 'sleep 30');
  });

  it('a credential in a command line never reaches the label', () => {
    const pw = ['Qw3', 'Er5', 'Ty7', 'Ui9', 'Op1', 'As2'].join('');
    const line = `cd /srv && PGPASSWORD=${pw} psql -h db -U app -c "select 1" && curl -u admin:${pw} https://x.example/api`;
    const label = taskLabel(command('running', line), line);
    assert.ok(!label.includes(pw), label);
    assert.equal(label, 'psql');
  });

  it('a disguising character in a description is shown, not obeyed', () => {
    assert.equal(taskLabel(agent('running', { description: 'fix ‮evil' }), null), 'fix ⟦U+202E⟧evil');
  });
});

describe('taskLine: one line, nothing printed twice', () => {
  it('a running agent: what it does now, else Starting', () => {
    const a = agent('running');
    assert.deepEqual(taskLine(a, 'QA', null, 'Read qa-notes.txt'), { lead: 'Read qa-notes.txt', tone: 'live', code: null });
    assert.deepEqual(taskLine(a, 'QA', null, null), { lead: 'Starting', tone: 'live', code: null });
  });

  it('a finished agent: the first line of its result; failed in the danger tone; stopped', () => {
    assert.equal(taskLine(agent('completed', { summary: '## Result\n\nAll 6 steps done.' }), 'QA', null, null).lead, 'Result');
    assert.deepEqual(taskLine(agent('failed', { summary: 'API Error: 529 overloaded' }), 'QA', null, null), { lead: 'API Error: 529 overloaded', tone: 'danger', code: null });
    assert.deepEqual(taskLine(agent('killed'), 'QA', null, null), { lead: 'Stopped', tone: 'warn', code: null });
  });

  it('the result that equals the label is not printed again', () => {
    assert.equal(taskLine(agent('completed', { summary: 'QA agent 1' }), 'QA agent 1', null, null).lead, 'Done');
    assert.equal(taskLine(command('running', 'sleep 30'), 'sleep 30', 'sleep 30', null).code, null);
  });

  it('a command: its exit code, then its command line on one line', () => {
    const failed = command('failed', LONG, { summary: `Background command "${LONG}" failed with exit code 1` });
    assert.deepEqual(taskLine(failed, 'node test: imageBuild.test.ts', LONG, null), { lead: 'exit 1', tone: 'danger', code: LONG });
    const done = command('completed', 'QA sleeper', { summary: 'Background command "QA sleeper" completed (exit code 0)' });
    assert.deepEqual(taskLine(done, 'QA sleeper', 'sleep 4 &&\n  echo slept', null), { lead: 'exit 0', tone: 'muted', code: 'sleep 4 && echo slept' });
    assert.deepEqual(taskLine(command('running', 'QA sleeper'), 'QA sleeper', 'sleep 4', null), { lead: null, tone: 'live', code: 'sleep 4' });
  });

  it('an exit code Claude Code does not count as a failure reads with its reason, not as an error', () => {
    // Observed with 2.1.296: a pipe ending in grep that matched nothing.
    const line = 'node --test x.test.ts | grep -E fail';
    const t = command('completed', line, { summary: `Background command "${line}" completed (exit code 1: No matches found)` });
    assert.deepEqual(taskLine(t, 'node test: x.test.ts', line, null), { lead: 'exit 1: No matches found', tone: 'muted', code: line });
  });

  it('exitCode and firstLine read what Claude Code reports', () => {
    assert.equal(exitCode('Background command "exit 3" failed with exit code 3'), 3);
    assert.equal(exitCode('Background command "x" completed (exit code 0)'), 0);
    assert.equal(exitCode(null), null);
    assert.equal(exitNote('Background command "x" completed (exit code 1: No matches found)'), 'No matches found');
    assert.equal(exitNote('Background command "x" failed with exit code 3'), null);
    assert.equal(firstLine('\n\n- **Done**: all good\nmore'), 'Done: all good');
  });
});

describe('groups and counts', () => {
  const tasks = [
    agent('running'),
    agent('running'),
    command('running', 'npm test'),
    command('failed', 'exit 3', { summary: 'Background command "exit 3" failed with exit code 3' }),
    agent('killed'),
    ...Array.from({ length: 80 }, (_, i) => (i % 2 ? agent('completed') : command('completed', `node test-${i}.mjs`))),
  ];

  it('counts equal the data: by status and by kind, each adding up to all', () => {
    const c = countTasks(tasks);
    assert.deepEqual(c, { running: 3, failed: 2, done: 80, agents: 43, commands: 42 });
    assert.equal(c.running + c.failed + c.done, tasks.length);
    assert.equal(c.agents + c.commands, tasks.length);
  });

  it('running agents, running commands, failed and done: each task in exactly one group', () => {
    const g = groupTasks(tasks, NO_FILTER, () => '');
    assert.equal(g.agents.length, 2);
    assert.equal(g.commands.length, 1);
    assert.equal(g.failed.length, 2);
    assert.equal(g.done.length, 80);
    const ids = [...g.agents, ...g.commands, ...g.failed, ...g.done].map((t) => t.taskId);
    assert.equal(new Set(ids).size, tasks.length);
  });

  it('a failed or stopped task is never inside the done group, whatever the filter', () => {
    for (const status of [null, 'done', 'failed', 'running'] as const)
      for (const kind of [null, 'agents', 'commands'] as const) {
        const g = groupTasks(tasks, { status, kind, query: '' }, () => '');
        assert.ok(g.done.every((t) => t.status === 'completed'), `${status} ${kind}`);
        assert.ok(g.failed.every((t) => t.status === 'failed' || t.status === 'killed'));
      }
  });

  it('running rows keep their place (oldest first); done and failed are newest first', () => {
    const g = groupTasks(tasks, NO_FILTER, () => '');
    assert.ok(Date.parse(g.agents[0]!.startedAt) < Date.parse(g.agents[1]!.startedAt));
    assert.ok(Date.parse(g.done[0]!.endedAt!) > Date.parse(g.done[1]!.endedAt!));
    const more = groupTasks([...tasks, agent('running')], NO_FILTER, () => '');
    assert.deepEqual(more.agents.slice(0, 2).map((t) => t.taskId), g.agents.map((t) => t.taskId));
  });

  it('filters: a status chip keeps its groups, a kind chip its kind; they combine', () => {
    const running = groupTasks(tasks, { ...NO_FILTER, status: 'running' }, () => '');
    assert.deepEqual([running.agents.length, running.commands.length, running.failed.length, running.done.length], [2, 1, 0, 0]);
    const doneCommands = groupTasks(tasks, { ...NO_FILTER, status: 'done', kind: 'commands' }, () => '');
    assert.deepEqual([doneCommands.agents.length, doneCommands.commands.length, doneCommands.failed.length, doneCommands.done.length], [0, 0, 0, 40]);
    assert.ok(doneCommands.done.every((t) => !t.subagentType));
  });

  it('search matches the text given, without regard to case', () => {
    const g = groupTasks(tasks, { ...NO_FILTER, query: 'TEST-1' }, (t) => t.description);
    assert.deepEqual(g.done.map((t) => t.description).sort(), ['node test-10.mjs', 'node test-12.mjs', 'node test-14.mjs', 'node test-16.mjs', 'node test-18.mjs']);
  });

  it('a task listed twice shows once (the last report wins)', () => {
    const a = agent('running');
    const ended = { ...a, status: 'completed' as const, endedAt: at(99) };
    assert.equal(uniqueTasks([a, ended]).length, 1);
    const g = groupTasks([a, ended], NO_FILTER, () => '');
    assert.deepEqual([g.agents.length, g.done.length], [0, 1]);
    assert.deepEqual(countTasks([a, ended]), { running: 0, failed: 0, done: 1, agents: 1, commands: 0 });
  });
});

describe('callCommand and ticketOf', () => {
  it('reads the command the portal kept of the call', () => {
    assert.deepEqual(callCommand(bash('npm test')), { text: 'npm test', cut: false });
    assert.deepEqual(callCommand(bash('npm test', { toolInputCut: true })), { text: 'npm test', cut: true });
    assert.deepEqual(callCommand(bash('ls', { toolInput: undefined })), { text: 'ls', cut: false });
    assert.equal(callCommand(undefined), null);
  });

  it('finds the ticket a description names', () => {
    assert.equal(ticketOf('T-149 slice 1: rows'), 'T-149');
    assert.equal(ticketOf('implementer for T-31 and T-5'), 'T-31');
    assert.equal(ticketOf('PT-12 is not a ticket'), null);
    assert.equal(ticketOf(null), null);
  });
});
