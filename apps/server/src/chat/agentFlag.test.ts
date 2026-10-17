// T-294 (chat-sessions PRD FR51): a session runs as an agent. Its process starts as `claude --agent <name>` at EVERY start (new, resume, wake,
// restart, recover, a Move), the session shows the name, and a name that is not a plain agent name is refused before anything runs.
// What the real CLI does with the flag (2.1.296): docs/prd/evidence/t294-agent-flag.md.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { Hono } from 'hono';
import { clearResolvers } from '../authz/seam.js';
import { registerChatAuthz } from './authz.js';
import { createChatRoutes } from './routes.js';
import { firstTurn, init, line, liveSession, until, type Live } from './testkit.js';

afterEach(() => clearResolvers());

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (isAppError(e) ? e.code : String(e)));
/** The `--agent` value of a start's command line, or null without one. */
const agentOf = (args: string[]) => (args.includes('--agent') ? (args[args.indexOf('--agent') + 1] ?? '') : null);
const lastStart = (s: Live) => s.ws.startArgs.at(-1)!;
const csidOf = (s: Live, id = s.id) => s.controller.get(id)!.claudeSessionId;
const resultLine = (sessionId: string) =>
  line({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false, session_id: sessionId });

/** T-1049: the fake host answers each control request in the tick it is written (no polling), and a generous timeout never fires under load. */
function answering(s: Live) {
  s.ws.autoRespond = true;
  s.controller.controlTimeoutMs = 5000;
}

test('T-294: a session with an agent starts Claude Code with --agent <name> and shows it; one without has no --agent', async () => {
  const s = await liveSession({}, false, { agent: 'implementer' });
  try {
    assert.equal(s.controller.get(s.id)!.agent, 'implementer');
    const args = lastStart(s);
    assert.equal(agentOf(args), 'implementer');
    assert.ok(args.indexOf('--agent') > args.indexOf('--'), 'a flag of claude, after the host’s own arguments');
    assert.ok(args.includes('--session-id') && args.includes(s.id));

    const plain = await s.controller.create({ workspaceId: 'docker/ws1', title: 'Plain', agent: '' });
    await until(() => s.ws.startArgs.some((a) => a.includes(plain.id)));
    assert.equal(s.controller.get(plain.id)!.agent, null, 'an empty name is none');
    assert.equal(agentOf(s.ws.startArgs.find((a) => a.includes(plain.id))!), null);
  } finally {
    await s.done();
  }
});

test('T-294: an agent name that is not a plain name is refused before anything runs or is made', async () => {
  const s = await liveSession();
  try {
    const ops = s.ws.ops.length;
    const rows = s.controller.list().length;
    for (const bad of ['../etc', '.claude/agents/implementer', '/home/node/x', 'Implementer', '-p', '--resume', 'a', 'x'.repeat(42), 'two words', 'réviewer', 'qa_verifier', 7, true, ['implementer']]) {
      assert.equal(await code(s.controller.create({ workspaceId: 'docker/ws1', agent: bad as string })), 'VALIDATION_FAILED', JSON.stringify(bad));
    }
    assert.equal(s.ws.ops.length, ops, 'nothing ran in the workspace');
    assert.equal(s.controller.list().length, rows, 'no session was made');
    // The longest name that is allowed.
    const long = await s.controller.create({ workspaceId: 'docker/ws1', agent: `a${'b'.repeat(40)}` });
    assert.equal(long.agent?.length, 41);
  } finally {
    await s.done();
  }
});

test('T-294: the agent comes back at every relaunch: a resume after the process went away, a restart, and a recovery', async () => {
  const s = await liveSession({}, false, { agent: 'qa-verifier' });
  try {
    answering(s);
    await firstTurn(s);

    // The process goes away; the next resume relaunches it.
    s.ws.alive = false;
    s.tail.exit(0);
    await until(() => s.controller.get(s.id)!.state === 'interrupted');
    s.ws.alive = true;
    const starts = s.ws.startArgs.length;
    const resuming = s.controller.control(s.id, 'resume');
    await until(() => s.controller.get(s.id)!.process === 'live' && s.ws.startArgs.length === starts + 1);
    await resuming;
    assert.ok(lastStart(s).includes('--resume'), 'resumed');
    assert.equal(agentOf(lastStart(s)), 'qa-verifier', 'resume');
    await until(() => s.controller.get(s.id)!.state === 'idle');

    // A restart (a person's, or one that applies new tools).
    await s.controller.restart(s.id, { why: 'mcp' });
    assert.equal(s.ws.startArgs.length, starts + 2);
    assert.equal(agentOf(lastStart(s)), 'qa-verifier', 'restart');

    // A harmless integrity ending, recovered in place.
    const tail = s.ws.tails.at(-1)!;
    const task = `t${randomUUID().slice(0, 6)}`;
    tail.push(
      line({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: `toolu_${task}`, description: 'a slice', subagent_type: 'general-purpose', is_backgrounded: true, task_type: 'local_agent', uuid: randomUUID(), session_id: csidOf(s) }),
    );
    await until(() => s.controller.get(s.id)!.agentsRunning === 1 || s.controller.get(s.id)!.state === 'ended');
    tail.push(
      line({ type: 'user', message: { role: 'user', content: 'text the portal never sent' }, session_id: csidOf(s), parent_tool_use_id: null, uuid: randomUUID(), isReplay: true, isSynthetic: true, origin: { kind: 'peer', from: task, senderTaskId: task, name: 'general-purpose', body: 'hello' } }),
    );
    await until(() => s.controller.get(s.id)!.state === 'ended');
    const back = await s.controller.recover(s.id);
    assert.notEqual(back.state, 'ended');
    assert.equal(s.ws.startArgs.length, starts + 3);
    assert.equal(agentOf(lastStart(s)), 'qa-verifier', 'recover');
    assert.equal(back.agent, 'qa-verifier');
  } finally {
    await s.done();
  }
});

test('T-294: a session woken from sleep starts as its agent again', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true, { agent: 'scribe' });
  try {
    answering(s);
    s.tail.push(init(s.id));
    await until(() => s.controller.get(s.id)!.process === 'asleep', 4000);
    const starts = s.ws.startArgs.length;
    const waking = s.controller.control(s.id, 'resume');
    await until(() => s.controller.get(s.id)!.process === 'live' && s.ws.startArgs.length === starts + 1);
    await waking;
    assert.equal(agentOf(lastStart(s)), 'scribe');
  } finally {
    await s.done();
  }
});

test('T-294: a Move keeps the agent: the new Claude Code session on the other Claude starts as the same agent', async () => {
  const s = await liveSession({}, false, { agent: 'implementer' });
  try {
    answering(s);
    const work = await s.controller.createClaude('docker/ws1', 'Work');
    const moving = s.controller.switchClaude(s.id, work.id, { handoff: 'skip' });
    // The new Claude answers the opening (as switch.test.ts does).
    await until(() => s.ws.tails.length >= 2 && csidOf(s) !== s.id);
    const newId = csidOf(s);
    const tail = s.ws.tails.at(-1)!;
    await until(() => s.ws.sends.some((x) => x.args[1] === newId && x.line.includes('transferred_context')));
    tail.push(init(newId));
    tail.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Got it.' }] }, parent_tool_use_id: null, uuid: randomUUID() }));
    tail.push(resultLine(newId));
    const moved = await moving;
    assert.equal(moved.claudeName, 'Work');
    assert.equal(moved.agent, 'implementer', 'the session keeps its agent');
    const started = s.ws.startArgs.find((a) => a.includes(newId))!;
    assert.ok(started.includes('--session-id'), 'a new Claude Code session there');
    assert.equal(agentOf(started), 'implementer');
  } finally {
    await s.done();
  }
});

test('T-294: the app’s create (POST /api/chat/sessions) takes an agent; a bad name is a 422 and nothing is made', async () => {
  const s = await liveSession();
  try {
    registerChatAuthz((id) => s.controller.sessionFacts(id));
    const app = new Hono();
    app.onError((e, c) => {
      const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
      return c.json(err.toJSON(), err.status as 422);
    });
    app.use(async (c, next) => {
      (c as unknown as { set(k: string, v: unknown): void }).set('token', 'signed-in');
      await next();
    });
    app.route('/', createChatRoutes(s.controller));
    const post = (body: unknown) => app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const rows = s.controller.list().length;
    assert.equal((await post({ workspaceId: 'docker/ws1', agent: '../agents/x' })).status, 422);
    assert.equal(s.controller.list().length, rows);
    const made = await post({ workspaceId: 'docker/ws1', agent: 'reviewer' });
    assert.equal(made.status, 201);
    const id = ((await made.json()) as { data: { id: string; agent: string } }).data.id;
    assert.equal(s.controller.get(id)!.agent, 'reviewer');
    await until(() => s.ws.startArgs.some((a) => a.includes(id)));
    assert.equal(agentOf(s.ws.startArgs.find((a) => a.includes(id))!), 'reviewer');
  } finally {
    await s.done();
  }
});
