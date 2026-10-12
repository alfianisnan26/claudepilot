import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { SecretsContent as View } from '@portal/contracts';
import Docker from 'dockerode';
import { config } from '../config.js';
import { Reconciler } from '../delivery/reconciler.js';
import { DockerRuntime } from '../workspaces/docker.js';
import { LABEL } from '../workspaces/runtime.js';
import { secretsHarness } from './testkit.js';

/**
 * Secrets & env against a real Claude Code (PRD §15 S1): the delivery engine writes a set into a
 * throwaway container from the workspace image, and the image's `claude` runs against a scripted stand-in
 * for the Anthropic API (a fake key, no network, no sign-in). Runs on the Docker-in-Docker daemon with
 * CLAUDEPILOT_DOCKER_TESTS=1, like delivery/docker.integration.test.ts.
 */
const enabled = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
const opts = { skip: enabled ? false : 'set CLAUDEPILOT_DOCKER_TESTS=1 to run against Docker' };
const socket = '/var/run/docker.sock';
const docker = new Docker({ socketPath: socket });
const runtime = new DockerRuntime({ id: 'docker', label: 'Docker', socket }, config.workspaces.dockerImage, config.workspaces.imageContext);
const d = runtime.delivery;
const name = `it-sec-${randomBytes(3).toString('hex')}`;
const WS = `docker/${name}`;
const FILE_ONLY = `fileonly${randomBytes(8).toString('hex')}`;
const ROTATED = `rotated${randomBytes(8).toString('hex')}`;
const EXPOSED = `exposed${randomBytes(8).toString('hex')}`;

/**
 * The Messages API as Claude Code streams it: a request that offers tools gets the next scripted step (a
 * tool call or text; `waitFor` holds it until a file exists), and every tool result it sends back is
 * appended to log.jsonl. Requests without tools (titles and the like) get "ok".
 */
const MOCK_API = String.raw`
const http=require('http'),fs=require('fs'),dir=process.argv[2],steps=JSON.parse(fs.readFileSync(dir+'/steps.json','utf8'));let next=0;
function sse(res,block,stop){res.writeHead(200,{'content-type':'text/event-stream'});const s=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
s('message_start',{message:{id:'msg_'+Date.now(),type:'message',role:'assistant',model:'mock',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}});
if(block.text!==undefined){s('content_block_start',{index:0,content_block:{type:'text',text:''}});s('content_block_delta',{index:0,delta:{type:'text_delta',text:block.text}})}
else{s('content_block_start',{index:0,content_block:{type:'tool_use',id:'toolu_'+next,name:block.tool,input:{}}});s('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}})}
s('content_block_stop',{index:0});s('message_delta',{delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:1}});s('message_stop',{});res.end()}
http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',async()=>{let j={};try{j=JSON.parse(b||'{}')}catch{}
if(req.url.includes('count_tokens'))return res.end('{"input_tokens":1}');
for(const c of [].concat((j.messages||[]).at(-1)?.content||[]))if(c&&c.type==='tool_result')fs.appendFileSync(dir+'/log.jsonl',JSON.stringify({error:!!c.is_error,content:JSON.stringify(c.content)})+'\n');
if(!(j.tools||[]).some(t=>t.name==='Bash')){if(!j.stream)return res.end(JSON.stringify({id:'m',type:'message',role:'assistant',model:'mock',content:[{type:'text',text:'ok'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}));return sse(res,{text:'ok'},'end_turn')}
const step=steps[next++]||{text:'done'};if(step.waitFor)while(!fs.existsSync(step.waitFor))await new Promise(r=>setTimeout(r,200));
sse(res,step,step.text!==undefined?'end_turn':'tool_use')})}).listen(4599,'127.0.0.1');`;

/** What Claude's Bash prints: the variables and a hash of the path variable's file. */
const PROBE = 'printf "plain=[%s] gone=[%s] exposed=%s file=%s\\n" "$SC_PLAIN" "${SC_GONE-unset}" "$(printf %s "$SC_EXPOSED" | sha256sum | cut -c1-8)" "$(sha256sum < "$SC_TOKEN_FILE" | cut -c1-8)"';
const hash8 = async (s: string) => (await import('node:crypto')).createHash('sha256').update(s).digest('hex').slice(0, 8);

before(async () => {
  if (!enabled) return;
  const c = await docker.createContainer({
    name: `claudepilot-${name}`,
    Image: config.workspaces.dockerImage,
    User: 'node',
    Labels: { [LABEL.managed]: 'true', [LABEL.name]: name, 'claudepilot.test': 'true' },
  });
  await c.start();
});
after(async () => {
  if (!enabled) return;
  await docker.getContainer(`claudepilot-${name}`).remove({ force: true }).catch(() => undefined);
});

test('S1 on a real Claude Code: shells and Claude get the set, Claude’s Read is denied its files, and a change reaches a running session', { ...opts, timeout: 240_000 }, async () => {
  const h = await secretsHarness();
  const reconciler = new Reconciler(h.store, () => runtime, () => [runtime], h.providers);
  try {
    const p = h.service.create('secrets', {
      name: 'team',
      content: {
        entries: [
          { kind: 'variable', name: 'SC_PLAIN', value: `it's $HOME \`x\`` },
          { kind: 'variable', name: 'SC_GONE', value: 'going' },
          { kind: 'secret', name: 'sc-token', newValue: FILE_ONLY, options: { pathVariable: 'SC_TOKEN_FILE' } },
          { kind: 'secret', name: 'SC_EXPOSED', newValue: EXPOSED, options: { expose: true, terminals: true } },
        ],
      },
    });
    h.service.setAssignments(WS, 'secrets', [{ poolId: p.id }]);
    await reconciler.request(WS, 'test');
    assert.equal(reconciler.row(WS)?.status, 'synced', reconciler.row(WS)?.reason ?? '');

    // Shells (§10.3): login and interactive bash source env.sh through the hooks; a plain `bash -c` doesn't.
    const shell = async (flags: string) => (await d.run(name, `bash ${flags} 'printf "[%s] %s" "$SC_PLAIN" "\${#SC_EXPOSED}"' 2>/dev/null`, { user: 'node' })).stdout;
    assert.equal(await shell('-lc'), `[it's $HOME \`x\`] ${EXPOSED.length}`);
    assert.equal(await shell('-ic'), `[it's $HOME \`x\`] ${EXPOSED.length}`);
    assert.equal(await shell('-c'), '[] 0');

    // Claude Code, scripted: what its Bash sees, three reads its deny rules must stop (A1), then the same
    // probe once the set has changed underneath the running session.
    const steps = [
      { tool: 'Bash', input: { command: PROBE, description: 'probe' } },
      { tool: 'Read', input: { file_path: '/etc/claudepilot/secrets/files/sc-token' } },
      { tool: 'Read', input: { file_path: '/etc/claude-code/managed-settings.d/20-claudepilot-env.json' } },
      { tool: 'Read', input: { file_path: '/proc/1/environ' } },
      { waitFor: '/tmp/mock/go', tool: 'Bash', input: { command: PROBE, description: 'probe' } },
      { text: 'done' },
    ];
    await d.put(name, [
      { path: '/tmp/mock', type: 'directory', mode: 0o755, uid: 1000, gid: 1000 },
      { path: '/tmp/mock/api.js', type: 'file', content: MOCK_API, mode: 0o644, uid: 1000, gid: 1000 },
      { path: '/tmp/mock/steps.json', type: 'file', content: JSON.stringify(steps), mode: 0o644, uid: 1000, gid: 1000 },
    ]);
    const env = 'ANTHROPIC_BASE_URL=http://127.0.0.1:4599 ANTHROPIC_API_KEY=fake-mock-key CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1';
    await d.run(name, `cd /tmp/mock && (nohup node api.js /tmp/mock >api.out 2>&1 &) && sleep 1 && (cd /home/node && nohup env ${env} timeout 180 claude -p go --allowedTools Bash Read --model claude-sonnet-4-5 >claude.out 2>&1; echo "exit $?" >>/tmp/mock/claude.out) >/dev/null 2>&1 &`, { user: 'node' });
    const log = async () => ((await d.read(name, '/tmp/mock/log.jsonl')) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { error: boolean; content: string });
    const until = async (ok: () => Promise<boolean>, what: string) => {
      for (let i = 0; i < 300; i++) if (await ok()) return;
      else await new Promise((r) => setTimeout(r, 300));
      assert.fail(`timed out waiting for ${what}: ${await d.read(name, '/tmp/mock/claude.out')}`);
    };
    await until(async () => (await log()).length >= 4, 'the first four tool results');
    const first = await log();
    assert.match(first[0]!.content, new RegExp(`plain=\\[it's \\$HOME \`x\`\\] gone=\\[going\\] exposed=${await hash8(EXPOSED)} file=${await hash8(FILE_ONLY)}`));
    for (const r of first.slice(1, 4)) assert.ok(r.error && /denied/.test(r.content), r.content);

    // Change the set while the session runs: a new value, a removed name, a rotated file.
    const entries = (h.service.get(p.id).content as View).entries
      .filter((e) => e.name !== 'SC_GONE')
      .map((e) => (e.name === 'SC_PLAIN' ? { ...e, value: 'changed' } : e.name === 'sc-token' ? { ...e, newValue: ROTATED } : e));
    h.service.update(p.id, { content: { entries } });
    await reconciler.request(WS, 'test');
    assert.equal(reconciler.row(WS)?.status, 'synced', reconciler.row(WS)?.reason ?? '');
    // Claude Code re-reads the drop-in about a second after it changes (a command sooner still sees the old `env`).
    await new Promise((r) => setTimeout(r, 3000));
    await d.run(name, 'touch /tmp/mock/go', { user: 'node' });
    await until(async () => (await log()).length >= 5, 'the probe after the change');
    assert.match((await log())[4]!.content, new RegExp(`plain=\\[changed\\] gone=\\[\\] exposed=${await hash8(EXPOSED)} file=${await hash8(ROTATED)}`), 'live value, "" tombstone, rotated file');
    await until(async () => /exit 0/.test((await d.read(name, '/tmp/mock/claude.out')) ?? ''), 'claude to finish');

    // T5: nothing delivered was written under the home folder by the session.
    const home = await d.run(name, `grep -rlF -e ${FILE_ONLY} -e ${ROTATED} -e ${EXPOSED} /home/node; true`, { user: 'node' });
    assert.equal(home.stdout, '');
  } finally {
    reconciler.stop();
    h.done();
  }
});
