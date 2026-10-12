import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { sessionRef, type BtwServerMessage } from '@portal/contracts';
import Docker from 'dockerode';
import { clearResolvers, ownerActor } from '../authz/seam.js';
import { config } from '../config.js';
import type { Workspaces } from '../workspaces/manager.js';
import { DockerRuntime } from '../workspaces/docker.js';
import type { ExecSession } from '../workspaces/runtime.js';
import { registerChatAuthz } from './authz.js';
import { ChatController } from './controller.js';
import { ChatStore } from './store.js';
import { freshStore, sleep } from './testkit.js';

/**
 * Side questions on a real Claude Code (chat-sessions PRD §20.9): the engine's run is started in a throwaway container from the workspace image, and the
 * image's `claude` talks to a scripted stand-in for the Anthropic API (a fake key, no network, no sign-in). It proves, on the real CLI: the run has no
 * tool and no MCP server, no configured hook runs, no file is written, a model that answers with a tool call cannot make one run, and a btw asked while a
 * real session is mid-request neither disturbs that session nor lands in its totals or its transcript. Docker-in-Docker with CLAUDEPILOT_DOCKER_TESTS=1.
 */
const enabled = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
const opts = { skip: enabled ? false : 'set CLAUDEPILOT_DOCKER_TESTS=1 to run against Docker' };
const socket = '/var/run/docker.sock';
const docker = new Docker({ socketPath: socket });
const runtime = new DockerRuntime({ id: 'docker', label: 'Docker', socket }, config.workspaces.dockerImage, config.workspaces.imageContext);
const d = runtime.delivery;
const name = `it-btw-${randomBytes(3).toString('hex')}`;
const WS = `docker/${name}`;

/**
 * The Messages API as Claude Code streams it. A request that offers tools is the MAIN session (it waits while /tmp/mock/hold exists, then answers
 * MAIN-ANSWER-n); one with the side-question instructions is a BTW (answers BTW-ANSWER: <the question>, or a Bash call when /tmp/mock/btw-mode says
 * "tool"); anything else gets "ok". Every request is logged on arrival to /tmp/mock/log.jsonl with how many tools it offered.
 */
const MOCK_API = String.raw`
const http=require('http'),fs=require('fs');let mainN=0,n=0;
const has=(f)=>fs.existsSync('/tmp/mock/'+f);
function sse(res,blocks,stop,usage){res.writeHead(200,{'content-type':'text/event-stream'});const s=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
s('message_start',{message:{id:'msg_'+Date.now()+'_'+n,type:'message',role:'assistant',model:'claude-sonnet-4-5',content:[],stop_reason:null,stop_sequence:null,usage:{...usage,output_tokens:1}}});
blocks.forEach((b,i)=>{if(b.text!==undefined){s('content_block_start',{index:i,content_block:{type:'text',text:''}});s('content_block_delta',{index:i,delta:{type:'text_delta',text:b.text}})}
else{s('content_block_start',{index:i,content_block:{type:'tool_use',id:'toolu_'+n+'_'+i,name:b.tool,input:{}}});s('content_block_delta',{index:i,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}})}s('content_block_stop',{index:i})});
s('message_delta',{delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:usage.output_tokens}});s('message_stop',{});res.end()}
http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',async()=>{let j={};try{j=JSON.parse(b||'{}')}catch{}
if(req.url.includes('count_tokens'))return res.end('{"input_tokens":1}');
const tools=(j.tools||[]).length,sys=typeof j.system==='string'?j.system:(j.system||[]).map(x=>x.text).join('\n');
const all=JSON.stringify(j.messages||[]);
const btw=/answer one side question about a coding session/.test(sys);
const kind=btw?'btw':tools>0?'main':'aux';const id=++n;
fs.appendFileSync('/tmp/mock/log.jsonl',JSON.stringify({id,kind,tools,nmsg:(j.messages||[]).length,sys:sys.slice(0,60),hasQ:/QUESTION-MARKER/.test(all)})+'\n');
if(kind==='main'){mainN++;while(has('hold'))await new Promise(r=>setTimeout(r,100));return sse(res,[{text:'MAIN-ANSWER-'+mainN}],'end_turn',{input_tokens:1200,cache_read_input_tokens:5000,cache_creation_input_tokens:0,output_tokens:40})}
if(kind==='btw'){const q=((all.match(/<side_question>\\n([\s\S]*?)\\n<\/side_question>/)||[])[1]||'').slice(0,80);
if(has('btw-mode')&&fs.readFileSync('/tmp/mock/btw-mode','utf8').trim()==='tool')return sse(res,[{tool:'Bash',input:{command:'echo ran > /tmp/btw-ran',description:'x'}}],'tool_use',{input_tokens:300,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:20});
return sse(res,[{text:'BTW-ANSWER: '+q}],'end_turn',{input_tokens:300,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:20})}
return sse(res,[{text:'ok'}],'end_turn',{input_tokens:5,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:2})})}).listen(4599,'127.0.0.1');`;

const sh = async (cmd: string) => (await d.run(name, cmd, { user: 'node' })).stdout;
const log = async () =>
  ((await d.read(name, '/tmp/mock/log.jsonl')) ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id: number; kind: 'btw' | 'main' | 'aux'; tools: number; nmsg: number; sys: string; hasQ: boolean });
/** The files under the home folder with their hashes: what a run left behind or changed. */
const homeFiles = () => sh(`find /home/node -type f -not -path '*/node_modules/*' -exec sha1sum {} + | sort -k2`);
const until = async (ok: () => Promise<boolean>, what: string, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await sleep(250);
  }
  assert.fail(`timed out waiting for ${what}`);
};

before(async () => {
  if (!enabled) return;
  const c = await docker.createContainer({
    name: `claudepilot-${name}`,
    Image: config.workspaces.dockerImage,
    User: 'node',
    // Not labelled as a managed workspace on purpose: a portal lists those and polls each one's Claudes, and that probe (a `claude -p` without
    // --safe-mode) runs the user's hooks, which would answer the "no hook ran" checks below for the wrong process.
    Labels: { 'claudepilot.test': 'true' },
  });
  await c.start();
  // Policy settings reach every claude in the container, even one run under `env -i` and --safe-mode: the base URL and a fake key.
  const policy = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4599', ANTHROPIC_API_KEY: 'fake-mock-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' } };
  await d.put(name, [
    { path: '/etc/claude-code', type: 'directory', mode: 0o755, uid: 0, gid: 0 },
    { path: '/etc/claude-code/managed-settings.d', type: 'directory', mode: 0o755, uid: 0, gid: 0 },
    { path: '/etc/claude-code/managed-settings.d/90-btw-test.json', type: 'file', content: JSON.stringify(policy), mode: 0o644, uid: 0, gid: 0 },
    { path: '/tmp/mock', type: 'directory', mode: 0o755, uid: 1000, gid: 1000 },
    { path: '/tmp/mock/api.js', type: 'file', content: MOCK_API, mode: 0o644, uid: 1000, gid: 1000 },
  ]);
  await d.run(name, 'cd /tmp/mock && (nohup node api.js >api.out 2>&1 &) && sleep 1', { user: 'node' });
});
after(async () => {
  if (!enabled) return;
  clearResolvers();
  await docker.getContainer(`claudepilot-${name}`).remove({ force: true }).catch(() => undefined);
});

/** The engine as the portal wires it, with the real exec into the container (the manager reduced to the one call btw makes). */
async function engine() {
  const { store, dataDir } = await freshStore();
  const workspaces = { exec: (_target: string, n: string, command: string[]) => runtime.exec(n, command) } as unknown as Workspaces;
  const controller = new ChatController(store, workspaces, {});
  const chat = new ChatStore(store);
  const sid = `it-${randomUUID().slice(0, 8)}`;
  chat.create({ id: sid, workspaceId: WS, cwd: '/home/node', title: 'IT', origin: 'ui' });
  chat.appendEvent(sid, { kind: 'user', text: 'We are renaming the QUESTION-MARKER module to core.' });
  chat.appendEvent(sid, { kind: 'assistant', text: 'Renamed it, and updated the three imports.' });
  // The container is no pool workspace and has no real sign-in to ask about: the check a start makes passes, as for a signed-in Claude.
  controller.pooled = () => false;
  controller.signedIn = async () => true;
  controller.btw.start();
  registerChatAuthz((id) => controller.sessionFacts(id));
  const msgs: BtwServerMessage[] = [];
  controller.btw.onMessage((_u, _s, m) => void msgs.push(m));
  const last = () => msgs.findLast((m): m is Extract<BtwServerMessage, { type: 'btw' }> => m.type === 'btw')!.item;
  const done = async () => {
    controller.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, controller, chat, sid, msgs, last, done };
}

test('btw on the real CLI: no tool, no MCP server, no hook, no file written; the answer is the stand-in\'s, from the transcript we sent', { ...opts, timeout: 180_000 }, async () => {
  const e = await engine();
  try {
    // A user hook that would run on any tool call or prompt (it must not: --safe-mode), and the files already there.
    await d.put(name, [
      { path: '/home/node/.claude', type: 'directory', mode: 0o755, uid: 1000, gid: 1000 },
      {
        path: '/home/node/.claude/settings.json',
        type: 'file',
        content: JSON.stringify({ hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'].map((h) => [h, [{ matcher: '*', hooks: [{ type: 'command', command: `echo ${h} >> /tmp/hook.log` }] }]])) }),
        mode: 0o644,
        uid: 1000,
        gid: 1000,
      },
    ]);
    await sh('rm -f /tmp/hook.log /tmp/btw-ran; rm -f /tmp/mock/btw-mode');
    // The first Claude Code run in a workspace writes its own first-start config (`.claude.json` and a backup of it); that is the CLI's, not a
    // session's, and it happens for every run of every kind. So one run goes first, and the next one is the one that must change nothing.
    await e.controller.btw.ask(ownerActor(), e.sid, randomUUID(), 'warm-up');
    await e.controller.btw.idle();
    assert.equal(e.last().status, 'answered');
    await sh('rm -f /tmp/hook.log');
    const before = await homeFiles();
    const requestsBefore = (await log()).length;

    await e.controller.btw.ask(ownerActor(), e.sid, randomUUID(), 'What was renamed QUESTION-MARKER?');
    await e.controller.btw.idle();

    const done = e.last();
    assert.equal(done.status, 'answered', JSON.stringify(done));
    assert.match(done.answer, /^BTW-ANSWER: What was renamed QUESTION-MARKER\?/);
    assert.equal(done.model, 'claude-opus-5-5', 'the model the CLI reported in its init');
    assert.equal(done.usage?.basis, 'reported');
    assert.equal(done.usage?.estimate, true);
    assert.equal(done.usage?.input, 300);
    assert.equal(done.usage?.output, 20);

    // What the API saw: ONE request, with no tools at all, the transcript as data and our instructions.
    const seen = (await log()).slice(requestsBefore);
    assert.equal(seen.length, 1, JSON.stringify(seen));
    assert.equal(seen[0]!.kind, 'btw');
    assert.equal(seen[0]!.tools, 0, 'the model was offered no tool');
    assert.ok(seen[0]!.hasQ);

    // No hook ran, no file was written anywhere in the home folder, and the session's own usage totals are not involved.
    assert.equal(await sh('cat /tmp/hook.log 2>/dev/null; true'), '', 'a configured hook ran in a run that is supposed to be tool-free');
    assert.equal(await homeFiles(), before, 'the run changed no file: no session, no transcript, no history');
    assert.equal(await sh('ls /home/node/.claude/projects 2>/dev/null | wc -l'), '0\n');
    assert.equal(e.store.db!.prepare("SELECT COUNT(*) AS n FROM chat_usage WHERE kind = 'side'").get()!.n, 2, 'the warm-up and this one');
  } finally {
    await e.done();
  }
});

test('btw on the real CLI: a model that answers with a tool call cannot make one run; the run is stopped and nothing is shown', { ...opts, timeout: 180_000 }, async () => {
  const e = await engine();
  try {
    await sh('rm -f /tmp/hook.log /tmp/btw-ran; echo tool > /tmp/mock/btw-mode');
    await e.controller.btw.ask(ownerActor(), e.sid, randomUUID(), 'Please run ls and show me');
    await e.controller.btw.idle();
    const done = e.last();
    assert.equal(done.status, 'failed');
    assert.equal(done.reason, 'unsafe');
    assert.equal(done.answer, '');
    assert.equal(await sh('cat /tmp/btw-ran 2>/dev/null; true'), '', 'the command did not run');
    assert.equal(await sh('cat /tmp/hook.log 2>/dev/null; true'), '', 'no hook ran for the attempt');
    // The process is gone: nothing of ours is left running in the container.
    await sleep(800);
    assert.equal((await sh(`ps -eo args | grep -c '[c]laude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --tools'`)).trim(), '0');
  } finally {
    await sh('rm -f /tmp/mock/btw-mode');
    await e.done();
  }
});

test('btw on the real CLI, while a real session is mid-request: the session is untouched (not its turn, its totals or its transcript) and the answer comes anyway', { ...opts, timeout: 240_000 }, async () => {
  const e = await engine();
  // The main session: a real long-lived claude in stream-json mode, with its own session file.
  const sessionId = randomUUID();
  const main: ExecSession = await runtime.exec(name, [
    'sh',
    '-c',
    `cd /home/node && exec claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-prompt-tool stdio --permission-mode default --session-id ${sessionId}`,
  ]);
  const lines: Record<string, unknown>[] = [];
  let pending = '';
  main.onData((b) => {
    pending += b.toString('utf8');
    let i: number;
    while ((i = pending.indexOf('\n')) >= 0) {
      const l = pending.slice(0, i);
      pending = pending.slice(i + 1);
      try {
        lines.push(JSON.parse(l) as Record<string, unknown>);
      } catch {
        // not a message
      }
    }
  });
  const results = () => lines.filter((l) => l.type === 'result');
  try {
    await sh('rm -f /tmp/mock/btw-mode; touch /tmp/mock/hold');
    const requestsBefore = (await log()).length;
    main.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'main turn, please think about it' } })}\n`);
    // The main request has reached the API and is held there.
    await until(async () => (await log()).slice(requestsBefore).some((r) => r.kind === 'main'), 'the main request to arrive');
    // The CLI's own first-start config (`.claude.json` and its backups) is not a session's: leave it out of the comparison.
    const paths = (list: string) => list.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[1]!).filter((p) => !/\.claude\.json|\/backups\//.test(p)).sort();
    const filesWhileHeld = paths(await homeFiles());

    // A side question now: it is answered while the main request is still held.
    const t0 = Date.now();
    await e.controller.btw.ask(ownerActor(), e.sid, randomUUID(), 'What was renamed QUESTION-MARKER?');
    await e.controller.btw.idle();
    const done = e.last();
    assert.equal(done.status, 'answered', JSON.stringify(done));
    assert.ok(Date.now() - t0 < 60_000);
    assert.deepEqual(paths(await homeFiles()), filesWhileHeld, 'the side question created no file next to the session\'s own');
    assert.equal(results().length, 0, 'the main turn is still waiting on its request: the side question did not end it or answer for it');

    // Release the main request: it finishes on its own, with ITS numbers only (the side question's 300 + 20 tokens are not in them).
    await sh('rm -f /tmp/mock/hold');
    await until(async () => results().length === 1, 'the main turn to finish');
    const r = results()[0]!;
    assert.equal(r.is_error, false);
    assert.equal(r.result, 'MAIN-ANSWER-1');
    const usage = r.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
    assert.deepEqual([usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens], [1200, 40, 5000]);
    const models = Object.values(r.modelUsage as Record<string, { inputTokens: number; outputTokens: number }>);
    assert.deepEqual(models.map((m) => [m.inputTokens, m.outputTokens]), [[1200, 40]], 'the running totals hold the main turn only');

    // The session's transcript never heard of the question; the only session file is the main one.
    assert.equal((await sh(`grep -rl QUESTION-MARKER /home/node/.claude 2>/dev/null | wc -l`)).trim(), '0');
    assert.equal((await sh(`find /home/node/.claude/projects -name '*.jsonl' | wc -l`)).trim(), '1');
    assert.equal((await sh(`find /home/node/.claude/projects -name '${sessionId}.jsonl' | wc -l`)).trim(), '1', 'and it is the one for the main session id');
    assert.equal(sessionRef(e.sid).type, 'session');
  } finally {
    try {
      main.close();
    } catch {
      // gone
    }
    // (The bracket keeps the pattern from matching this very command.)
    await sh(`rm -f /tmp/mock/hold; pkill -u node -f "[s]ession-id ${sessionId}"; true`);
    await e.done();
  }
});
