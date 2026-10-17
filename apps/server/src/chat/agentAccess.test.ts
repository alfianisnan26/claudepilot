// Portal tools for a session's Claude (I8): a per-session token minted at every launch, handed to the process on the
// exec's stdin (never a command line or a file), named by `--mcp-config` (which holds no secret); the rest of what a
// launch adds to the environment travels the same way; and a failure of any of it never stops a session from starting.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { HOST_ENV_NAMES } from './host.js';
import { init, line, liveSession, ok, until, USAGE_API_KEY, type Live } from './testkit.js';

const TOKEN = 'cpst_Zk3pQ7vR1mT8xN4bC6yL0wH2dF5gJ9aSuEiO';
const CONFIG = JSON.stringify({ mcpServers: { pilot: { type: 'http', url: '${PILOT_MCP_URL}', headers: { Authorization: 'Bearer ${PILOT_MCP_TOKEN}' } } } });
const assistantText = (text: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid: randomUUID() });
const resultLine = (sessionId: string) => line({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 100, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false, session_id: sessionId });

/** A minter that hands out one token per session id and remembers every request. */
function minter(s: Live, enabled = true) {
  const asked: { workspaceId: string; sessionId: string }[] = [];
  s.controller.agentAccess = {
    async mint(req) {
      asked.push(req);
      if (!enabled) return null;
      return { env: { PILOT_MCP_TOKEN: TOKEN, PILOT_SESSION_ID: req.sessionId, PILOT_WORKSPACE_ID: req.workspaceId, PILOT_MCP_URL: 'http://172.18.0.1:3105/mcp' }, mcpConfig: CONFIG };
    },
  };
  return asked;
}

/** The arguments and stdin of the newest `start`. */
const lastStart = (s: Live) => ({ args: s.ws.startArgs.at(-1)!, stdin: s.ws.startExecs.at(-1)!.written });

test('a new session mints a token: its environment goes on stdin, --mcp-config names it, and nothing secret is on a command line', async () => {
  const s = await liveSession();
  try {
    const asked = minter(s);
    const before = s.ws.tails.length;
    const b = await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.ws.tails.length === before + 1);
    assert.deepEqual(asked, [{ workspaceId: 'docker/ws1', sessionId: b.id }]);
    const { args, stdin } = lastStart(s);
    assert.ok(args.includes('--env') && args[args.indexOf('--env') + 1] === '4', 'four lines of environment');
    assert.equal(args[args.indexOf('--mcp-config') + 1], CONFIG);
    assert.ok(args.indexOf('--mcp-config') < args.indexOf('--session-id'), 'a flag follows its value, so the variadic list ends');
    assert.equal(stdin, `PILOT_MCP_TOKEN=${TOKEN}\nPILOT_SESSION_ID=${b.id}\nPILOT_WORKSPACE_ID=docker/ws1\nPILOT_MCP_URL=http://172.18.0.1:3105/mcp\n`);
    assert.ok(!JSON.stringify(s.ws.startArgs).includes('cpst_'), 'no token in any command line');
    assert.ok(!JSON.stringify(s.ws.ops).includes('cpst_'));
    // Not in the portal's records either.
    const rows = JSON.stringify(['chat_events', 'chat_sessions'].map((t) => s.store.db!.prepare(`SELECT * FROM ${t}`).all()));
    assert.ok(!rows.includes('cpst_'));
  } finally {
    await s.done();
  }
});

test('a session with an agent token has the portal’s tools pre-allowed, and the transcript says so once, quietly, at their first use', async () => {
  const s = await liveSession();
  try {
    minter(s);
    const before = s.ws.tails.length;
    const b = await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.ws.tails.length === before + 1);
    const { args } = lastStart(s);
    assert.deepEqual(args.slice(args.indexOf('--allowedTools'), args.indexOf('--allowedTools') + 2), ['--allowedTools', 'mcp__pilot__*']);
    assert.ok(args.indexOf('--allowedTools') < args.indexOf('--session-id'), 'a flag follows its value');
    const tail = s.ws.tails.at(-1)!;
    const call = (id: string, name: string) => tail.push(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] }, parent_tool_use_id: null, uuid: randomUUID() }));
    call('toolu_a', 'Bash'); // not a portal tool: nothing
    call('toolu_b', 'mcp__pilot__portal_status');
    call('toolu_c', 'mcp__pilot__ticket_list');
    await until(() => s.controller.history(b.id).filter((e) => e.kind === 'tool_use').length === 3);
    const notes = s.controller.history(b.id).filter((e) => e.kind === 'system' && /portal’s tools without asking/.test(e.text ?? ''));
    assert.equal(notes.length, 1, 'once');
    const order = s.controller.history(b.id).map((e) => e.kind === 'tool_use' ? e.toolName : e.text);
    assert.ok(order.indexOf(notes[0]!.text) > order.indexOf('Bash'), 'at the first portal tool, not before');
    // Without a grant there is no such flag and no note.
    s.controller.agentAccess = undefined;
    const c = await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.ws.tails.length === before + 2);
    assert.ok(!lastStart(s).args.includes('--allowedTools'));
    s.ws.tails.at(-1)!.push(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_d', name: 'mcp__pilot__portal_status', input: {} }] }, parent_tool_use_id: null, uuid: randomUUID() }));
    await until(() => s.controller.history(c.id).some((e) => e.kind === 'tool_use'));
    assert.ok(!s.controller.history(c.id).some((e) => e.kind === 'system' && /without asking/.test(e.text ?? '')));
  } finally {
    await s.done();
  }
});

test('every launch mints again: a resume and a wake get their own token, under the session’s portal id', async () => {
  const s = await liveSession({ idleSleepMs: 150 }, true);
  try {
    s.controller.controlTimeoutMs = 150;
    const asked = minter(s);
    const before = s.ws.tails.length;
    const b = await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.ws.tails.length === before + 1);
    await until(() => s.controller.get(b.id)?.state === 'idle');
    assert.equal(asked.length, 1);
    // A first turn, so there is a transcript to resume.
    const tail = s.ws.tails.at(-1)!;
    tail.push(init(b.id));
    tail.push(ok((await s.take('get_settings')).id, { applied: { model: 'claude-opus-5-5', effort: 'medium', ultracode: false, ultracodeAvailable: true } }));
    tail.push(assistantText('hello'));
    tail.push(resultLine(b.id));
    tail.push(ok((await s.take('get_usage')).id, USAGE_API_KEY));
    // Sleep, then a wake.
    await until(() => s.controller.get(b.id)!.process === 'asleep', 4000);
    const waking = s.controller.control(b.id, 'resume');
    await until(() => s.controller.get(b.id)!.process === 'live');
    await waking.catch(() => undefined);
    assert.equal(asked.length, 2);
    assert.ok(asked.every((a) => a.sessionId === b.id), 'the portal id, not Claude Code’s');
    assert.ok(lastStart(s).args.includes('--resume') && lastStart(s).args.includes('--mcp-config'));
    assert.ok(lastStart(s).stdin.includes(`PILOT_SESSION_ID=${b.id}`));
  } finally {
    await s.done();
  }
});

test('no opt-in (no grant): the session starts with no environment lines and no --mcp-config; a minter that fails or answers badly changes nothing', async () => {
  const s = await liveSession();
  try {
    const asked = minter(s, false);
    let before = s.ws.tails.length;
    await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.ws.tails.length === before + 1);
    assert.equal(asked.length, 1);
    assert.ok(!lastStart(s).args.includes('--env') && !lastStart(s).args.includes('--mcp-config'));
    assert.equal(lastStart(s).stdin, '');

    s.controller.agentAccess = { mint: () => Promise.reject(new Error('portal MCP is down')) };
    before = s.ws.tails.length;
    await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.ws.tails.length === before + 1);
    assert.ok(!lastStart(s).args.includes('--mcp-config'), 'a failing mint never stops a session from starting');

    s.controller.agentAccess = { mint: async () => ({ env: { PILOT_MCP_TOKEN: TOKEN }, mcpConfig: '' }) };
    before = s.ws.tails.length;
    await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.ws.tails.length === before + 1);
    assert.ok(!lastStart(s).args.includes('--mcp-config') && lastStart(s).stdin === '', 'a grant without its config is no grant');
  } finally {
    await s.done();
  }
});

test('launchEnv adds what is not secret (account MCP off) to every process of the workspace; names the host does not take, and values with a newline, never go', async () => {
  const s = await liveSession();
  try {
    s.controller.launchEnv = (ws) => (ws === 'docker/ws1' ? { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', LD_PRELOAD: '/tmp/evil.so', PILOT_SESSION_ID: 'a\nb' } : {});
    const before = s.ws.tails.length;
    await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.ws.tails.length === before + 1);
    assert.equal(lastStart(s).stdin, 'ENABLE_CLAUDEAI_MCP_SERVERS=false\n');
    assert.deepEqual(lastStart(s).args.slice(lastStart(s).args.indexOf('--env'), lastStart(s).args.indexOf('--env') + 2), ['--env', '1']);
    for (const name of HOST_ENV_NAMES) assert.ok(typeof name === 'string');

    // Both together: the grant's lines follow the common ones; a throwing launchEnv adds nothing.
    s.controller.launchEnv = () => ({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
    minter(s);
    const b = await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.ws.tails.length === before + 2);
    assert.ok(lastStart(s).stdin.startsWith('ENABLE_CLAUDEAI_MCP_SERVERS=false\nPILOT_MCP_TOKEN='));
    assert.ok(lastStart(s).stdin.includes(`PILOT_SESSION_ID=${b.id}`));
    s.controller.launchEnv = () => {
      throw new Error('settings unreadable');
    };
    await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.ws.tails.length === before + 3);
    assert.ok(!lastStart(s).stdin.includes('ENABLE_CLAUDEAI'));
  } finally {
    await s.done();
  }
});

test('a token a tool prints (env, a curl with the header) never reaches the transcript or a tab', async () => {
  const s = await liveSession();
  try {
    s.tail.push(init(s.id));
    s.tail.push(line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_env', content: `PILOT_MCP_TOKEN=${TOKEN}\nPILOT_SESSION_ID=${s.id}` }] }, parent_tool_use_id: null }));
    s.tail.push(
      line({ type: 'control_request', request_id: 'R-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${TOKEN}" http://172.18.0.1:3105/mcp` }, tool_use_id: 'toolu_c' } }),
    );
    s.tail.push(assistantText(`The token is ${TOKEN}.`));
    s.tail.push(resultLine(s.id));
    s.tail.push(ok((await s.take('get_settings')).id, { applied: {} }));
    await until(() => s.controller.history(s.id).some((e) => e.kind === 'assistant'));
    const everything = JSON.stringify([s.controller.history(s.id), s.messages, ['chat_events', 'chat_requests', 'chat_sessions'].map((t) => s.store.db!.prepare(`SELECT * FROM ${t}`).all())]);
    assert.ok(!everything.includes('cpst_'), 'no cpst_ anywhere');
    assert.equal(s.controller.history(s.id).find((e) => e.kind === 'tool_result')!.text, `PILOT_MCP_TOKEN=[redacted]\nPILOT_SESSION_ID=${s.id}`);
  } finally {
    await s.done();
  }
});

test('a move to another Claude mints for the new process under the same portal id, so its token replaces the old run’s', async () => {
  const s = await liveSession();
  try {
    s.controller.controlTimeoutMs = 150;
    const asked = minter(s);
    const work = await s.controller.createClaude('docker/ws1', 'Work');
    const moving = s.controller.switchClaude(s.id, work.id, { handoff: 'skip' });
    await until(() => s.ws.tails.length >= 2 && s.controller.get(s.id)!.claudeSessionId !== s.id);
    const newId = s.controller.get(s.id)!.claudeSessionId;
    await until(() => s.ws.sends.some((x) => x.args[1] === newId && x.line.includes('transferred_context')));
    const tail = s.ws.tails.at(-1)!;
    tail.push(init(newId));
    tail.push(assistantText('Got it.'));
    tail.push(resultLine(newId));
    tail.push(ok((await s.take('get_usage')).id, USAGE_API_KEY));
    await moving;
    assert.deepEqual(asked, [{ workspaceId: 'docker/ws1', sessionId: s.id }], 'the chat’s own id, not the new Claude Code session’s');
    const start = s.ws.startExecs.at(-1)!;
    assert.ok(start.written.includes(`PILOT_SESSION_ID=${s.id}`) && start.written.includes('PILOT_MCP_TOKEN='));
    assert.ok(s.ws.startArgs.at(-1)!.includes('--mcp-config'));
  } finally {
    await s.done();
  }
});

test('a launch settles its token: a new process starts (the old ones go), or the host says one is already running (the new one goes, the live process keeps its own)', async () => {
  // Konfersi lead, 2026-10-17 19:17: a start the host answered "already running" attached to the old process, but minting had already
  // revoked that process's token, so every portal tool was refused until a person reconnected it.
  const s = await liveSession();
  try {
    const settled: string[] = [];
    let n = 0;
    s.controller.agentAccess = {
      async mint(req, opts) {
        n++;
        settled.push(`mint ${n} keepOthers=${opts?.keepOthers === true}`);
        return { env: { PILOT_MCP_TOKEN: TOKEN, PILOT_SESSION_ID: req.sessionId, PILOT_WORKSPACE_ID: req.workspaceId, PILOT_MCP_URL: 'http://172.18.0.1:3105/mcp' }, mcpConfig: CONFIG, tokenId: `agt_${n}` };
      },
      settle(_sessionId, tokenId, started) {
        settled.push(`settle ${tokenId} ${started ? 'started' : 'not started'}`);
      },
    };
    const before = s.ws.tails.length;
    const b = await s.controller.create({ workspaceId: 'docker/ws1' });
    await until(() => s.ws.tails.length === before + 1);
    await until(() => s.controller.get(b.id)?.state === 'idle');
    assert.deepEqual(settled, ['mint 1 keepOthers=true', 'settle agt_1 started']);
    // The host now answers "already running" (3): the portal attaches, and the token it minted for nothing is the one that goes.
    s.ws.startCode = 3;
    await s.controller.restart(b.id).catch(() => undefined);
    await until(() => settled.length >= 4);
    assert.deepEqual(settled.slice(2), ['mint 2 keepOthers=true', 'settle agt_2 not started']);
  } finally {
    await s.done();
  }
});
