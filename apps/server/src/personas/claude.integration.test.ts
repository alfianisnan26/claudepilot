import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ContextContent, PersonaContent } from '@portal/contracts';
import { emptyPersona } from '@portal/contracts';
import Docker from 'dockerode';
import { config } from '../config.js';
import { Reconciler, type FragmentProvider } from '../delivery/reconciler.js';
import { PoolService } from '../pools/service.js';
import { claudePrint, recorded, startStandIn, STANDIN_ENV, textOf, type RecordedRequest } from '../pools/standin.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { DockerRuntime } from '../workspaces/docker.js';
import { Personas } from './index.js';

/**
 * Personas and instruction contexts against a real Claude Code (Persona PRD P1, P2, A9, §11): the delivery
 * engine writes into a throwaway container from the workspace image, and the image's `claude` runs against a
 * recording stand-in for the Anthropic API (a fake key, no network, no sign-in). What the stand-in receives is
 * what Claude Code was told. Runs with CLAUDEPILOT_DOCKER_TESTS=1.
 */
const enabled = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
const opts = { skip: enabled ? false : 'set CLAUDEPILOT_DOCKER_TESTS=1 to run against Docker' };
const socket = '/var/run/docker.sock';
const docker = new Docker({ socketPath: socket });
const runtime = new DockerRuntime({ id: 'docker', label: 'Docker', socket }, config.workspaces.dockerImage, config.workspaces.imageContext);
const d = runtime.delivery;
const name = `pe-it-${randomBytes(3).toString('hex')}`;
const WS = `docker/${name}`;
const PROJECT = '/home/node/work/proj';
const MARK = `m${randomBytes(4).toString('hex')}`;
const MODEL = 'claude-sonnet-4-6';

/** One portal for the whole file: the container's manifest names the portal that set it up, a second store would be "another portal". */
let p: Awaited<ReturnType<typeof portal>>;

before(async () => {
  if (!enabled) return;
  p = await portal();
  const c = await docker.createContainer({ name: `claudepilot-${name}`, Image: config.workspaces.dockerImage, User: 'node', Labels: { 'claudepilot.test': 'true' }, HostConfig: { Memory: 1536 * 1024 * 1024 } });
  await c.start();
  await startStandIn(d, name);
  await d.run(name, `mkdir -p ${PROJECT} /home/node/.claude && printf '# Repository rules\\nREPO-${MARK}: run npm test before committing.\\n' > ${PROJECT}/CLAUDE.md && printf '# My preferences\\nUSER-${MARK}: I prefer tabs.\\n' > /home/node/.claude/CLAUDE.md`, { user: 'node' });
});
after(async () => {
  if (!enabled) return;
  p?.done();
  await docker.getContainer(`claudepilot-${name}`).remove({ force: true }).catch(() => undefined);
  // The docker client keeps sockets open (an archive read among them) after its last call: once the results are written, end the process instead of waiting for them to time out.
  setTimeout(() => process.exit(0), 1500).unref();
});

/** The portal's side: a store, the pool service with both kinds registered, and the reconciler writing into the container. */
async function portal() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-personas-it-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const providers: FragmentProvider[] = [];
  const pools = new PoolService(store, { providers });
  const personas = new Personas(store, pools);
  const reconciler = new Reconciler(store, () => runtime, () => [runtime], providers);
  pools.reconciler = reconciler;
  /** Everything asked for has been written: the request in flight, and the one queued behind it. */
  const settle = async () => {
    await reconciler.request(WS, 'settle');
    await reconciler.request(WS, 'settle');
    assert.equal(reconciler.row(WS)?.status, 'synced', reconciler.row(WS)?.reason ?? '');
  };
  /** The unassign's 30 s grace, over. */
  const graceOver = async () => {
    store.db!.prepare("UPDATE workspace_delivery SET pending_deletes = REPLACE(pending_deletes, '\"since\":', '\"since\":0,\"was\":') WHERE workspace_id = ?").run(WS);
    await settle();
  };
  const done = () => (reconciler.stop(), store.close(), rmSync(dataDir, { recursive: true, force: true }));
  return { store, pools, personas, reconciler, settle, graceOver, done };
}

const count = (text: string, marker: string) => text.split(marker).length - 1;
/** The model requests Claude Code made for the user's own messages (the ones that carry tools). */
const mainRequests = async () => (await recorded(d, name)).filter((r) => r.tools.length > 0);
const lastText = async () => textOf((await mainRequests()).at(-1)!);
const clearRequests = () => d.run(name, 'rm -f /tmp/standin/requests.jsonl', { user: 'node' });

/**
 * A long-lived `claude -p --input-format stream-json` process: what a portal chat session is. Messages go in
 * through a FIFO a holder process keeps open, so Claude Code never sees the end of its input between them.
 */
const SESSION = String.raw`
S=/tmp/pe-session
start() {
  rm -rf $S; mkdir -p $S; mkfifo $S/in
  # The processes record their own PIDs (and exec, so the PID stays), because a pkill by pattern would match this very script.
  setsid nohup bash -c "echo \$\$ > $S/holder.pid; exec 3>$S/in; exec sleep infinity" >/dev/null 2>&1 &
  setsid nohup bash -c "echo \$\$ > $S/claude.pid; cd ${PROJECT}; exec env ${STANDIN_ENV} claude -p --input-format stream-json --output-format stream-json --verbose $*" < $S/in > $S/out.jsonl 2> $S/err.txt &
  sleep 1
}
turns() { c=$(grep -c '"type":"result"' $S/out.jsonl 2>/dev/null); [ -n "$c" ] || c=0; echo $c; }
send() {
  n=$(turns)
  printf '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"%s"}]}}\n' "$1" > $S/in
  for i in $(seq 1 90); do [ "$(turns)" -gt "$n" ] && return 0; sleep 0.5; done
  echo "no answer to: $1"; cat $S/err.txt; return 1
}
stop() { kill $(cat $S/claude.pid $S/holder.pid 2>/dev/null) 2>/dev/null || true; }
`;
const session = (script: string) => d.run(name, `${SESSION}\n${script}`, { user: 'node', timeoutMs: 120_000 });

test('P1, P2, A9 on a real Claude Code: the persona’s instructions, style, subagents, model and effort reach the model next to the repository’s and the user’s own instructions', { ...opts, timeout: 300_000 }, async () => {
  try {
    const standards = p.pools.create('context', { name: 'Coding standards', content: { body: `CONTEXT-${MARK}: use two spaces and small functions.` } satisfies ContextContent });
    const content: PersonaContent = {
      ...emptyPersona(),
      instructions: `# Role\nPERSONA-${MARK}: review security first, then correctness.`,
      styles: [{ name: 'Terse', description: 'Short answers', keepCodingInstructions: true, body: `STYLE-${MARK}: answer in at most two sentences.` }],
      defaultStyle: 'Terse',
      agents: [{ name: 'security-reviewer', description: `AGENT-${MARK} reviews a diff for security problems`, prompt: 'You review diffs for security problems.', tools: ['Read', 'Grep'], disallowedTools: [], model: 'inherit', effort: null, maxTurns: 6 }],
      model: MODEL,
      effort: 'low',
      contexts: [standards.id],
    };
    const persona = p.pools.create('persona', { name: 'Reviewer', content, draft: true });
    // FR10: a draft can't be assigned; publishing is a separate step.
    assert.throws(() => p.pools.setAssignments(WS, 'persona', [{ poolId: persona.id }]), /hasn’t been published yet/);
    p.pools.approve(persona.id, 1);
    p.pools.setAssignments(WS, 'persona', [{ poolId: persona.id }]);
    await p.settle();

    // What the workspace has: the user's and the repository's instructions are untouched, the persona's are managed files.
    const files = await d.run(name, 'ls /etc/claude-code /etc/claude-code/.claude/rules /etc/claude-code/.claude/agents /etc/claude-code/.claude/output-styles /etc/claude-code/managed-settings.d', { user: 'node' });
    for (const f of ['CLAUDE.md', 'cpx-coding-standards.md', 'security-reviewer.md', 'Terse.md', '50-claudepilot-persona.json', '55-claudepilot-context.json']) assert.match(files.stdout, new RegExp(f.replace('.', '\\.')), f);

    // A real session, with no `--model`: the persona's default decides.
    await clearRequests();
    const run = await d.run(name, `cd ${PROJECT} && env ${STANDIN_ENV} timeout 150 claude -p 'persona probe' 2>&1`, { user: 'node' });
    assert.equal(run.code, 0, run.stdout);
    const req = (await mainRequests()).at(-1)!;
    const text = textOf(req);
    // Every layer, each once, in the order Claude Code loads them: the persona's, its context, then the user's and the repository's own.
    for (const marker of [`PERSONA-${MARK}`, `CONTEXT-${MARK}`, `USER-${MARK}`, `REPO-${MARK}`, `STYLE-${MARK}`, `AGENT-${MARK}`]) assert.equal(count(text, marker), 1, `${marker} appears exactly once`);
    const at = (m: string) => text.indexOf(`${m}-${MARK}`);
    assert.ok(at('PERSONA') < at('CONTEXT') && at('CONTEXT') < at('USER') && at('USER') < at('REPO'), 'managed instructions, managed rules, user, then project');
    assert.match(text, /Contents of \/etc\/claude-code\/CLAUDE\.md \(organization-managed policy instructions\)/);
    assert.match(text, /Contents of \/etc\/claude-code\/\.claude\/rules\/cpx-coding-standards\.md \(organization-managed policy instructions\)/);
    assert.ok(!text.includes('delivered by the portal'), 'the rule file’s leading HTML comment (where it came from) is stripped before Claude reads it');
    assert.match(text, /Contents of \/home\/node\/\.claude\/CLAUDE\.md \(user's private global instructions/);
    assert.match(text, /Contents of \/home\/node\/work\/proj\/CLAUDE\.md \(project instructions/);
    // The style arrives as a reminder in the first message, and the subagent in the agent list.
    assert.match(text, new RegExp(`# Output Style: Terse\\s+STYLE-${MARK}`));
    assert.match(text, /- security-reviewer: AGENT-\w+ reviews a diff for security problems \(Tools: Read, Grep\)/);
    assert.equal(req.model, MODEL, 'the persona’s default model');
    assert.equal(req.extra.output_config?.effort, 'low', 'the persona’s default effort');

    // Q5: a flag still wins, since the persona only sets where sessions start.
    const flagged = await claudePrint(d, name, 'flag probe', { cwd: PROJECT, args: '--model claude-opus-4-6 --effort high' });
    assert.equal(flagged.code, 0, flagged.stdout);
    const second = (await mainRequests()).at(-1)!;
    assert.equal(second.model, 'claude-opus-4-6');
    assert.equal(second.extra.output_config?.effort, 'high');

    // Unassigned and reconciled: none of the persona's files are left, and the model is Claude Code's own again.
    p.pools.setAssignments(WS, 'persona', []);
    await p.settle();
    await p.graceOver();
    const gone = await d.run(name, 'ls /etc/claude-code/CLAUDE.md /etc/claude-code/managed-settings.d/50-claudepilot-persona.json 2>&1', { user: 'node' });
    assert.match(gone.stdout, /No such file/);
    await clearRequests();
    await claudePrint(d, name, 'after unassign', { cwd: PROJECT });
    const after = await lastText();
    assert.ok(!after.includes(`PERSONA-${MARK}`) && !after.includes(`STYLE-${MARK}`) && !after.includes(`AGENT-${MARK}`));
    assert.ok(after.includes(`CONTEXT-${MARK}`) === false, 'the persona’s context went with it');
    assert.ok(after.includes(`REPO-${MARK}`) && after.includes(`USER-${MARK}`), 'the repository’s and the user’s own instructions never went anywhere');
  } finally {
    p.pools.setAssignments(WS, 'persona', []);
  }
});

test('§11 in a running session: an instruction edit reaches the next message, a removal is announced, the style follows its key; model, effort, style text and subagents wait for a new session', { ...opts, timeout: 600_000 }, async () => {
  try {
    const standards = p.pools.create('context', { name: 'Standards for the running session', content: { body: `CONTEXT1-${MARK}: use two spaces.` } satisfies ContextContent });
    const base: PersonaContent = {
      ...emptyPersona(),
      instructions: `PERSONA1-${MARK}: review security first.`,
      styles: [
        { name: 'Terse', description: 'Short answers', keepCodingInstructions: true, body: `TERSE1-${MARK}: two sentences.` },
        { name: 'Verbose', description: 'Long answers', keepCodingInstructions: true, body: `VERBOSE1-${MARK}: explain everything.` },
      ],
      defaultStyle: 'Terse',
      agents: [{ name: 'security-reviewer', description: `AGENT1-${MARK} reviews diffs`, prompt: 'You review diffs.', tools: [], disallowedTools: [], model: '', effort: null, maxTurns: null }],
      model: MODEL,
      effort: 'low',
      contexts: [standards.id],
    };
    const persona = p.pools.create('persona', { name: 'Session reviewer', content: base });
    p.pools.setAssignments(WS, 'persona', [{ poolId: persona.id }]);
    await p.settle();

    await clearRequests();
    assert.equal((await session('start; send "T1 baseline"; echo started')).code, 0);
    let text = await lastText();
    for (const m of [`PERSONA1-${MARK}`, `CONTEXT1-${MARK}`, `TERSE1-${MARK}`, `AGENT1-${MARK}`]) assert.equal(count(text, m), 1, m);

    /** The next message after a change: sent until Claude Code has re-read (2 to 4 s in practice), at most 10 s. */
    const until = async (marker: string) => {
      for (let i = 0; i < 6; i++) {
        const r = await session(`send "poll ${i}"`);
        assert.equal(r.code, 0, r.stdout);
        if ((await lastText()).includes(marker)) return i;
        await new Promise((ok) => setTimeout(ok, 1500));
      }
      assert.fail(`${marker} never reached the running session`);
    };

    // 1. The persona's instructions change: published, delivered, and seen by the session that was already running.
    p.pools.update(persona.id, { content: { ...base, instructions: `PERSONA2-${MARK}: review correctness first.` } });
    await p.settle();
    await until(`PERSONA2-${MARK}`);
    text = await lastText();
    assert.match(text, /Instruction files were re-read after the organization's managed settings changed/);
    // 2. A context the persona holds changes: held, not assigned, and it still arrives.
    p.pools.update(standards.id, { content: { body: `CONTEXT2-${MARK}: use four spaces.` } });
    await new Promise((ok) => setImmediate(ok));
    await p.settle();
    await until(`CONTEXT2-${MARK}`);
    // 3. The default style's key changes to another style that was delivered before the session started: from the next message.
    p.pools.update(persona.id, { content: { ...base, instructions: `PERSONA2-${MARK}: review correctness first.`, defaultStyle: 'Verbose' } });
    await p.settle();
    await until(`# Output Style: Verbose`);
    // 4. What waits for the next session: the default model and effort, a new subagent, a style's text.
    const before = (await mainRequests()).length;
    p.pools.update(persona.id, {
      content: {
        ...base,
        instructions: `PERSONA2-${MARK}: review correctness first.`,
        defaultStyle: 'Verbose',
        model: 'claude-opus-4-6',
        effort: 'high',
        styles: [base.styles[0]!, { ...base.styles[1]!, body: `VERBOSE2-${MARK}: explain even more.` }],
        agents: [...base.agents, { name: 'test-writer', description: `AGENT2-${MARK} writes tests`, prompt: 'You write tests.', tools: [], disallowedTools: [], model: '', effort: null, maxTurns: null }],
      },
    });
    await p.settle();
    await new Promise((ok) => setTimeout(ok, 6000));
    assert.equal((await session('send "after the defaults changed"')).code, 0);
    const running = (await mainRequests()).at(-1)!;
    assert.ok((await mainRequests()).length > before);
    assert.equal(running.model, MODEL, 'a running session keeps the model it started with');
    assert.equal(running.extra.output_config?.effort, 'low', 'and its effort');
    text = textOf(running);
    assert.ok(!text.includes(`AGENT2-${MARK}`) && !text.includes(`VERBOSE2-${MARK}`), 'a new subagent and a changed style text wait for a new session');

    // 5. Unassigned: the next message says the instructions are gone and the style is back to the default.
    p.pools.setAssignments(WS, 'persona', []);
    await p.settle();
    await p.graceOver();
    await new Promise((ok) => setTimeout(ok, 6000));
    assert.equal((await session('send "after the persona is gone"')).code, 0);
    text = textOf((await mainRequests()).at(-1)!);
    assert.match(text, /Instructions no longer present: \/etc\/claude-code\/CLAUDE\.md/);
    assert.match(text, /The output style was reset to the default/);
    await session('stop');

    // 6. A new session starts from what's delivered now: nothing of the persona, the repository's and the user's own as ever.
    await clearRequests();
    assert.equal((await session('start; send "T-new fresh session"; stop')).code, 0);
    text = await lastText();
    assert.ok(!text.includes(`PERSONA2-${MARK}`) && !text.includes('# Output Style'));
    assert.ok(text.includes(`REPO-${MARK}`) && text.includes(`USER-${MARK}`));
  } finally {
    await session('stop').catch(() => undefined);
    p.pools.setAssignments(WS, 'persona', []);
  }
});

test('Q15: a resumed conversation gets the persona as it is now: new instructions, style, subagents, model and effort', { ...opts, timeout: 300_000 }, async () => {
  try {
    const first: PersonaContent = { ...emptyPersona(), instructions: `PERSONA1-${MARK}: v1.`, styles: [{ name: 'Terse', description: 'Short', keepCodingInstructions: true, body: `TERSE1-${MARK}: short.` }], defaultStyle: 'Terse', model: MODEL, effort: 'low' };
    const persona = p.pools.create('persona', { name: 'Resumer', content: first });
    p.pools.setAssignments(WS, 'persona', [{ poolId: persona.id }]);
    await p.settle();
    await clearRequests();
    const sid = '11111111-2222-4333-8444-555555555555';
    const one = await d.run(name, `cd ${PROJECT} && env ${STANDIN_ENV} timeout 150 claude -p 'first turn' --session-id ${sid} 2>&1`, { user: 'node' });
    assert.equal(one.code, 0, one.stdout);
    assert.equal((await mainRequests()).at(-1)!.model, MODEL);

    p.pools.update(persona.id, {
      content: {
        ...first,
        instructions: `PERSONA2-${MARK}: v2.`,
        styles: [...first.styles, { name: 'Verbose', description: 'Long', keepCodingInstructions: true, body: `VERBOSE1-${MARK}: long.` }],
        defaultStyle: 'Verbose',
        agents: [{ name: 'test-writer', description: `AGENT2-${MARK} writes tests`, prompt: 'You write tests.', tools: [], disallowedTools: [], model: '', effort: null, maxTurns: null }],
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    });
    await p.settle();
    const two = await d.run(name, `cd ${PROJECT} && env ${STANDIN_ENV} timeout 150 claude -p 'second turn' --resume ${sid} 2>&1`, { user: 'node' });
    assert.equal(two.code, 0, two.stdout);
    const resumed = (await mainRequests()).at(-1)!;
    const text = textOf(resumed);
    for (const m of [`PERSONA2-${MARK}`, `# Output Style: Verbose`, `AGENT2-${MARK}`]) assert.ok(text.includes(m), m);
    assert.equal(resumed.model, 'claude-opus-4-6', 'the resumed process starts on the persona’s current default');
    assert.equal(resumed.extra.output_config?.effort, 'high');
    p.pools.setAssignments(WS, 'persona', []);
    await p.settle();
    await p.graceOver();
  } finally {
    p.pools.setAssignments(WS, 'persona', []);
  }
});

/** Kept for readers: the request shape the assertions rely on. */
export type { RecordedRequest };
