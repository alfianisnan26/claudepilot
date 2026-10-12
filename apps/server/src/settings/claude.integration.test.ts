import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { SETTING_KEYS, type McpCatalogEntry } from '@portal/contracts';
import Docker from 'dockerode';
import { config } from '../config.js';
import { Reconciler, type FragmentProvider } from '../delivery/reconciler.js';
import type { WorkspaceSteps } from '../delivery/steps.js';
import { McpSets } from '../mcp/index.js';
import { claudePrint, recorded, startStandIn, STANDIN_DIR } from '../pools/standin.js';
import { References } from '../pools/references.js';
import { PoolService } from '../pools/service.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { DockerRuntime } from '../workspaces/docker.js';
import { SettingsModule } from './index.js';

/**
 * The MCP lockdown on a real Claude Code (settings-policies PRD, "pool MCP only"; Account MCP off): the
 * delivery engine writes the settings drop-in into a throwaway container from the workspace image, and the
 * image's `claude` is asked what it loads. Two stand-ins, both inside the container, no network, no sign-in,
 * only fake credentials: one for the Messages API under an API key, and one for api.anthropic.com as a
 * claude.ai subscription account (a throwaway CA, a CONNECT proxy, a fake credentials file) that serves one
 * claude.ai connector, so "Account MCP off" can be seen working. Runs with CLAUDEPILOT_DOCKER_TESTS=1, like
 * skills/claude.integration.test.ts.
 */
const enabled = process.env.CLAUDEPILOT_DOCKER_TESTS === '1';
const opts = { skip: enabled ? false : 'set CLAUDEPILOT_DOCKER_TESTS=1 to run against Docker' };
const socket = '/var/run/docker.sock';
const docker = new Docker({ socketPath: socket });
const runtime = new DockerRuntime({ id: 'docker', label: 'Docker', socket }, config.workspaces.dockerImage, config.workspaces.imageContext);
const d = runtime.delivery!;
// Not labelled as a managed workspace: other portals on this daemon must not list a test container. One per test:
// a workspace remembers which portal delivered to it, and each test makes its own.
let name = '';
let WS = '';
const PROJECT = '/home/node/work/proj';
const DROP_IN = '/etc/claude-code/managed-settings.d/05-claudepilot-settings.json';
const POOL_TOOL = 'mcp__plugin_cpm-lab-set_lab__ping';

/** A tiny MCP server over stdio (newline-delimited JSON-RPC) with one tool, `ping`. */
const LAB_SERVER = String.raw`const rl=require('readline').createInterface({input:process.stdin});const name=process.argv[2]||'lab';
const send=(o)=>process.stdout.write(JSON.stringify(o)+'\n');
rl.on('line',(line)=>{let m;try{m=JSON.parse(line)}catch{return}
if(m.method==='initialize')return send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:(m.params&&m.params.protocolVersion)||'2025-06-18',capabilities:{tools:{}},serverInfo:{name,version:'1.0.0'}}});
if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'ping',description:'Pings '+name,inputSchema:{type:'object',properties:{}}}]}});
if(m.method==='tools/call')return send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'pong from '+name}]}});
if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result:{}})});`;

/**
 * api.anthropic.com for one real Claude Code, as a claude.ai subscription account: a CONNECT proxy (3198) that
 * lets only api.anthropic.com and mcp-proxy.anthropic.com through to a local TLS server (8443) with a throwaway
 * CA's certificate. It lists one claude.ai connector (/v1/mcp_servers) and serves it over the claude.ai proxy
 * (/v1/mcp/<id>, streamable HTTP with JSON replies, one tool). The model's first turn reads a file, so a second
 * request follows once every MCP server has had time to connect (and, while a `hold` file exists, only after it is
 * gone: a session held open); each request's text lands in last.json.
 */
const SUBSCRIPTION_STANDIN = String.raw`const https=require('https'),http=require('http'),net=require('net'),fs=require('fs');const dir=process.argv[2];
const log=(...a)=>fs.appendFileSync(dir+'/standin.log',a.join(' ')+'\n');process.on('uncaughtException',(e)=>log('uncaught',e.message));
const api=https.createServer({key:fs.readFileSync(dir+'/pki/leaf.key'),cert:fs.readFileSync(dir+'/pki/leaf.pem')},(req,res)=>{let body='';req.on('data',(c)=>(body+=c));req.on('end',()=>{
const path=req.url||'';log(req.method,path);const json=(o)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(o))};
if(req.method==='GET'&&path.startsWith('/v1/mcp_servers'))return json({data:[{type:'mcp_server',id:'mcpsrv_fake1',display_name:'Fake Mail',name:'fake-mail',url:'http://127.0.0.1:4777/mcp',created_at:'2026-01-01T00:00:00Z'}],has_more:false,first_id:'mcpsrv_fake1',last_id:'mcpsrv_fake1'});
if(path.startsWith('/v1/mcp/')){let m={};try{m=JSON.parse(body)}catch{}const reply=(result)=>json({jsonrpc:'2.0',id:m.id,result});
if(req.method!=='POST'){res.writeHead(405);return res.end()}
if(m.method==='initialize')return reply({protocolVersion:(m.params&&m.params.protocolVersion)||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake-mail',version:'1.0.0'}});
if(m.method==='tools/list')return reply({tools:[{name:'ping',description:'Pings the fake mail server',inputSchema:{type:'object',properties:{}}}]});
if(m.id===undefined){res.writeHead(202);return res.end()}return reply({})}
if(req.method==='POST'&&path.startsWith('/v1/messages')&&!path.includes('count_tokens')){let j={};try{j=JSON.parse(body)}catch{}
let idx=0;try{idx=fs.readFileSync(dir+'/count','utf8').length}catch{}fs.appendFileSync(dir+'/count','x');fs.writeFileSync(dir+'/last.json',JSON.stringify(j));
const tool=idx===0&&(j.tools||[]).some((t)=>t.name==='Read');
if(!j.stream)return json({id:'m',type:'message',role:'assistant',model:'mock',content:[{type:'text',text:'ok'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}});
const send=()=>{res.writeHead(200,{'content-type':'text/event-stream'});const e=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
e('message_start',{message:{id:'m',type:'message',role:'assistant',model:'mock',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}});
if(tool){e('content_block_start',{index:0,content_block:{type:'tool_use',id:'toolu_1',name:'Read',input:{}}});e('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({file_path:'/etc/hostname'})}})}
else{e('content_block_start',{index:0,content_block:{type:'text',text:''}});e('content_block_delta',{index:0,delta:{type:'text_delta',text:'ok'}})}
e('content_block_stop',{index:0});e('message_delta',{delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:1}});e('message_stop',{});
setTimeout(()=>res.end(),tool?4000:0)};
const waitHold=()=>fs.existsSync(dir+'/hold')?setTimeout(waitHold,200):send();
return tool?waitHold():send()}
if(path.includes('count_tokens'))return json({input_tokens:1});json({})})});
api.on('tlsClientError',()=>{});api.on('connection',(s)=>s.on('error',()=>{}));api.listen(8443,'127.0.0.1');
const proxy=http.createServer((req,res)=>{res.writeHead(502);res.end()});proxy.on('connection',(s)=>s.on('error',()=>{}));
proxy.on('connect',(req,socket,head)=>{const host=String(req.url).split(':')[0];if(host!=='api.anthropic.com'&&host!=='mcp-proxy.anthropic.com'){log('REFUSED',req.url);return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')}
const up=net.connect(8443,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head&&head.length)up.write(head);up.pipe(socket);socket.pipe(up)});up.on('error',()=>socket.destroy());socket.on('error',()=>up.destroy())});
proxy.listen(3198,'127.0.0.1',()=>log('up'));`;

const ACCT = '/tmp/acct';
const file = (path: string, content: string, mode = 0o644) => ({ path, type: 'file' as const, content, mode, uid: 1000, gid: 1000 });
const dir = (path: string) => ({ path, type: 'directory' as const, mode: 0o755, uid: 1000, gid: 1000 });
const sh = (script: string, timeoutMs = 150_000) => d.run(name, script, { user: 'node', timeoutMs });

beforeEach(async () => {
  if (!enabled) return;
  name = `pl-it-lk-${randomBytes(3).toString('hex')}`;
  WS = `docker/${name}`;
  const c = await docker.createContainer({ name: `claudepilot-${name}`, Image: config.workspaces.dockerImage, User: 'node', Labels: { 'claudepilot.test': 'true' } });
  await c.start();
});
afterEach(async () => {
  if (!enabled || !name) return;
  await docker.getContainer(`claudepilot-${name}`).remove({ force: true }).catch(() => undefined);
});

/** The store, the pools, the MCP sets, the settings and the reconciler on the real container, wired as index.ts does. */
async function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-lockdown-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const providers: FragmentProvider[] = [];
  const service = new PoolService(store, { providers });
  const references = new References();
  const steps = { enqueue: () => undefined, queued: () => [] } as unknown as WorkspaceSteps;
  const mcp = new McpSets(store, service, references, () => d, { resolveDns: false, steps });
  const settings = new SettingsModule(store, providers);
  settings.lockdown.addMatcherSource((ws) => mcp.matchers(ws));
  const reconciler = new Reconciler(store, () => runtime, () => [runtime], providers);
  service.reconciler = reconciler;
  // The settings module is not given the reconciler: a switch change would ask for a delivery by itself, which a test's
  // own `deliver` calls would then join (a request during a run queues one more), so a "started" delivery could never run
  // as one. The unit tests cover that a change asks for delivery.
  const deliver = async (why = 'test') => {
    await reconciler.request(WS, why);
    assert.equal(reconciler.row(WS)?.status, 'synced', reconciler.row(WS)?.reason ?? '');
  };
  const done = () => {
    reconciler.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, service, mcp, settings, reconciler, deliver, done };
}

const list = async () => (await sh(`cd ${PROJECT} && timeout 120 claude mcp list 2>&1`)).stdout;
const mcpTools = (tools: string[]) => tools.filter((t) => t.startsWith('mcp__')).sort();

test('pool MCP only on a real Claude Code: only the pool’s servers load; users, repositories, --mcp-config and `claude mcp add` are shut out; sessions that started before the change are Pending', { ...opts, timeout: 900_000 }, async () => {
  const h = await harness();
  try {
    // The workspace: a stdio MCP server, a repository whose .mcp.json names a server of its own, the user's
    // approval of project servers (so a blocked server is blocked by policy, not by waiting for an approval),
    // and the stand-in for the model API. The first step holds a session open until /tmp/standin/release exists.
    await sh(`mkdir -p ${PROJECT} /tmp/lab /home/node/.claude`);
    await d.put(name, [
      file('/tmp/lab/server.js', LAB_SERVER, 0o755),
      file(`${PROJECT}/.mcp.json`, JSON.stringify({ mcpServers: { repo: { command: '/usr/local/bin/node', args: ['/tmp/lab/server.js', 'repo'] } } })),
      file('/home/node/.claude/settings.json', JSON.stringify({ enableAllProjectMcpServers: true })),
      file('/tmp/extra.json', JSON.stringify({ mcpServers: { cfg: { command: '/usr/local/bin/node', args: ['/tmp/lab/server.js', 'cfg'] } } })),
    ]);
    await startStandIn(d, name, [{ text: 'finished', waitFor: `${STANDIN_DIR}/release` }]);

    // One approved catalog entry, in a set, assigned to the workspace.
    const entry: McpCatalogEntry = await h.mcp.catalog.create({ key: 'lab', displayName: 'Lab', kind: 'command', spec: { path: '/usr/local/bin/node', args: ['/tmp/lab/server.js', 'lab'] }, slots: [] });
    const approved = await h.mcp.catalog.approve(entry.id, entry.versions[0]!.id, { reviewed: true });
    const set = h.service.create('mcpset', {
      name: 'Lab set',
      content: { servers: [{ key: 'lab', entry: approved.id, version: approved.versions[0]!.version, enabled: true, config: {}, secrets: {} }] },
    });
    h.service.setAssignments(WS, 'mcpset', [{ poolId: set.id }]);
    await h.deliver();
    assert.equal(await d.read(name, DROP_IN), null, 'both switches off: no settings drop-in');

    // A session that starts now stays open (it waits for the release file): it started before the lockdown.
    await sh(`cd ${PROJECT} && (nohup env ANTHROPIC_BASE_URL=http://127.0.0.1:4599 ANTHROPIC_API_KEY=fake-mock-key CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 claude -p slow --model claude-sonnet-4-5 >/tmp/slow.out 2>&1 &); sleep 5`);

    // Baseline, both off: the pool's server and the repository's server both connect.
    const before = await list();
    assert.match(before, /plugin:cpm-lab-set:lab: .* ✔ Connected/);
    assert.match(before, /\nrepo: .* ✔ Connected/);

    // Turn it on: the drop-in carries exactly the pool's matcher, and the workspace is Pending because the
    // slow session started before the change.
    h.settings.settings.set(SETTING_KEYS.mcpPoolOnly, true, { actor: 'it' });
    await h.deliver('settings');
    const dropIn = JSON.parse((await d.read(name, DROP_IN)) ?? 'null') as { allowManagedMcpServersOnly: boolean; allowedMcpServers: { serverCommand: string[] }[] };
    assert.equal(dropIn.allowManagedMcpServersOnly, true);
    assert.deepEqual(dropIn.allowedMcpServers, h.mcp.matchers(WS));
    assert.equal(dropIn.allowedMcpServers[0]!.serverCommand[1], 'cpm-lab-set/lab');
    // The pass that wrote it read the sessions before writing, so it says it is checking; the next pass counts them.
    assert.equal(h.settings.lockdown.status(WS).reason, 'Checking the running sessions.');
    await h.deliver('check');
    const pending = h.settings.lockdown.status(WS);
    assert.deepEqual([pending.state, pending.restart], ['pending', 1]);
    assert.match(pending.reason!, /1 running session started before the change: restart it\./);

    // A session that starts after the change: `claude mcp list` shows the pool's server only, `claude mcp add`
    // is refused for every transport, and a session is offered the pool's tool only, with the portal-style
    // --mcp-config server and the repository's server blocked by policy.
    const locked = await list();
    assert.match(locked, /plugin:cpm-lab-set:lab: .* ✔ Connected/);
    assert.doesNotMatch(locked, /repo/);
    const addStdio = await sh('cd /tmp && timeout 60 claude mcp add --scope user userone -- /usr/local/bin/node /tmp/lab/server.js userone 2>&1');
    assert.match(addStdio.stdout, /Cannot add MCP server "userone": not allowed by enterprise policy/);
    const addHttp = await sh('cd /tmp && timeout 60 claude mcp add --transport http web https://example.com/mcp 2>&1');
    assert.match(addHttp.stdout, /Cannot add MCP server "web": not allowed by enterprise policy/);
    const run = await claudePrint(d, name, 'after the lockdown', { cwd: PROJECT, args: '--mcp-config /tmp/extra.json' });
    assert.equal(run.code, 0, run.stdout);
    assert.match(run.stdout, /MCP server blocked by enterprise policy: cfg/);
    // The slow session holds the stand-in's first scripted step; this session's request is the last one recorded with tools.
    const last = (await recorded(d, name)).reverse().find((r) => r.tools.length > 0)!;
    assert.deepEqual(mcpTools(last.tools), [POOL_TOOL], 'the pool’s tool only');

    // The slow session ends: nothing older than the change runs any more, so the workspace is Locked.
    await sh(`touch ${STANDIN_DIR}/release`);
    for (let i = 0; i < 40 && (await sh('pgrep -x claude')).code === 0; i++) await new Promise((r) => setTimeout(r, 1000));
    await h.deliver('timer');
    const locked2 = h.settings.lockdown.status(WS);
    assert.deepEqual([locked2.state, locked2.restart, locked2.reason], ['locked', 0, null]);

    // An empty pool means an empty allowlist: nothing loads at all, the repository's server and the (still
    // installed) pool plugin included.
    h.service.setAssignments(WS, 'mcpset', []);
    await h.deliver('unassigned');
    assert.deepEqual(JSON.parse((await d.read(name, DROP_IN)) ?? 'null'), { allowManagedMcpServersOnly: true, allowedMcpServers: [] });
    assert.match(await list(), /No MCP servers configured/);

    // Off again (the server asks for a confirmation first): the drop-in goes (the 30 s grace is skipped by
    // the "started" delivery), and what a user and a repository bring loads again.
    assert.throws(() => h.settings.settings.set(SETTING_KEYS.mcpPoolOnly, false, { actor: 'it' }), /confirm/i);
    h.settings.settings.set(SETTING_KEYS.mcpPoolOnly, false, { actor: 'it', confirm: true });
    await h.deliver('settings');
    assert.notEqual(await d.read(name, DROP_IN), null, 'kept through the 30 s grace');
    await h.deliver('started');
    assert.equal(await d.read(name, DROP_IN), null, 'the drop-in is gone');
    assert.equal(h.settings.lockdown.status(WS).state, 'off');
    assert.match(await list(), /\nrepo: .* ✔ Connected/);
  } finally {
    h.done();
  }
});

test('Account MCP off on a real Claude Code signed in as a claude.ai subscriber: the connector is listed and loads with it off, and neither is asked for with it on; Pool MCP only blocks the connector too', { ...opts, timeout: 900_000 }, async () => {
  const h = await harness();
  try {
    // A throwaway CA and leaf for the two api hosts, fake credentials (a scratch Claude directory), and the stand-in.
    await sh(`mkdir -p ${ACCT}/pki ${ACCT}/cfg ${ACCT}/home ${ACCT}/proj /tmp/lab`);
    await d.put(name, [
      file(`${ACCT}/standin.js`, SUBSCRIPTION_STANDIN),
      file('/tmp/lab/server.js', LAB_SERVER, 0o755),
      file(
        `${ACCT}/cfg/.credentials.json`,
        JSON.stringify({ claudeAiOauth: { accessToken: 'FAKE-it-access-token-0000000000000000', refreshToken: 'FAKE-it-refresh-token-000000000000000', expiresAt: 4102444800000, scopes: ['user:inference', 'user:profile', 'user:mcp_servers'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }),
        0o600,
      ),
    ]);
    const pki = await sh(
      `cd ${ACCT}/pki && openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 2 -subj /CN=pl-test-ca >/dev/null 2>&1 && ` +
        'openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -subj /CN=api.anthropic.com >/dev/null 2>&1 && ' +
        "printf 'subjectAltName=DNS:api.anthropic.com,DNS:mcp-proxy.anthropic.com\\n' > ext.cnf && " +
        'openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out leaf.pem -days 2 -extfile ext.cnf >/dev/null 2>&1 && ' +
        `cd ${ACCT} && (nohup node standin.js ${ACCT} >standin.out 2>&1 &); sleep 1; cat standin.log`,
    );
    assert.match(pki.stdout, /^up/);

    // The pool's server too, so "only the pool remains" can be seen next to the connector.
    const entry = await h.mcp.catalog.create({ key: 'lab', displayName: 'Lab', kind: 'command', spec: { path: '/usr/local/bin/node', args: ['/tmp/lab/server.js', 'lab'] }, slots: [] });
    const approved = await h.mcp.catalog.approve(entry.id, entry.versions[0]!.id, { reviewed: true });
    const set = h.service.create('mcpset', { name: 'Lab set', content: { servers: [{ key: 'lab', entry: approved.id, version: approved.versions[0]!.version, enabled: true, config: {}, secrets: {} }] } });
    h.service.setAssignments(WS, 'mcpset', [{ poolId: set.id }]);
    await h.deliver();

    /** One session as the subscriber: what it asked the API for and which MCP tools it was told about (deferred ones are listed in a system reminder). */
    const session = async (env = '') => {
      await sh(`rm -f ${ACCT}/count ${ACCT}/last.json ${ACCT}/dbg.log; : > ${ACCT}/standin.log`);
      const r = await sh(
        `cd ${ACCT}/proj && env -i PATH="$PATH" HOME=${ACCT}/home CLAUDE_CONFIG_DIR=${ACCT}/cfg HTTPS_PROXY=http://127.0.0.1:3198 NODE_EXTRA_CA_CERTS=${ACCT}/pki/ca.pem DISABLE_AUTOUPDATER=1 ${env} ` +
          `timeout 120 claude -p hi --model claude-sonnet-4-5 --allowedTools Read --debug --debug-file ${ACCT}/dbg.log 2>&1`,
      );
      const last = (await d.read(name, `${ACCT}/last.json`)) ?? '';
      const log = (await d.read(name, `${ACCT}/standin.log`)) ?? '';
      const debug = (await sh(`grep claudeai-mcp ${ACCT}/dbg.log`)).stdout;
      return { out: r.stdout, tools: [...new Set(last.match(/mcp__[A-Za-z0-9_-]+/g) ?? [])].sort(), asked: /GET \/v1\/mcp_servers/.test(log), debug };
    };
    const CONNECTOR = 'mcp__claude_ai_Fake_Mail__ping';
    const POOL = POOL_TOOL;

    // A first session installs the pool's plugin into this Claude directory; the second is the baseline.
    await session();
    const base = await session();
    assert.equal(base.asked, true, 'the connectors list is asked for');
    assert.match(base.debug, /Fetched 1 servers/);
    assert.deepEqual(base.tools, [CONNECTOR, POOL].sort(), 'the connector and the pool server both load');

    // A session that is already running when the switch is turned on (held open before its first request).
    await sh(`rm -f ${ACCT}/count ${ACCT}/last.json; touch ${ACCT}/hold`);
    await sh(
      `cd ${ACCT}/proj && (nohup env -i PATH="$PATH" HOME=${ACCT}/home CLAUDE_CONFIG_DIR=${ACCT}/cfg HTTPS_PROXY=http://127.0.0.1:3198 NODE_EXTRA_CA_CERTS=${ACCT}/pki/ca.pem DISABLE_AUTOUPDATER=1 ` +
        `timeout 120 claude -p hi --model claude-sonnet-4-5 --allowedTools Read >${ACCT}/held.out 2>&1 &); sleep 1`,
    );
    const requests = async () => ((await d.read(name, `${ACCT}/count`)) ?? '').length;
    for (let i = 0; i < 60 && (await requests()) < 1; i++) await new Promise((r) => setTimeout(r, 500));
    assert.equal(await requests(), 1, 'the held session has made its first request');

    // Account MCP off: delivered as the managed key; the CLI never asks for the list, the pool server stays.
    h.settings.settings.set(SETTING_KEYS.mcpAccountOff, true, { actor: 'it' });
    await h.deliver('settings');
    await h.deliver('check');
    const heldStatus = h.settings.lockdown.status(WS);
    assert.deepEqual([heldStatus.state, heldStatus.restart], ['pending', 1], 'the running session started before the change');
    // It keeps the connector it loaded when it started, even though the managed folder existed then: its next request still offers it.
    await new Promise((r) => setTimeout(r, 6000));
    await sh(`rm -f ${ACCT}/hold`);
    for (let i = 0; i < 60 && (await requests()) < 2; i++) await new Promise((r) => setTimeout(r, 500));
    const heldTools = [...new Set(((await d.read(name, `${ACCT}/last.json`)) ?? '').match(/mcp__[A-Za-z0-9_-]+/g) ?? [])].sort();
    assert.deepEqual(heldTools, [CONNECTOR, POOL].sort(), 'a running session keeps what it connected at start: Pending, not Locked');
    for (let i = 0; i < 40 && (await sh('pgrep -x claude')).code === 0; i++) await new Promise((r) => setTimeout(r, 1000));
    await h.deliver('timer');
    assert.equal(h.settings.lockdown.status(WS).state, 'locked', 'Locked once it has ended');
    assert.deepEqual(JSON.parse((await d.read(name, DROP_IN)) ?? 'null'), { disableClaudeAiConnectors: true });
    const off = await session();
    assert.match(off.debug, /Disabled via disableClaudeAiConnectors setting/);
    assert.equal(off.asked, false, 'the connectors list is not asked for');
    assert.deepEqual(off.tools, [POOL]);
    assert.equal(h.settings.lockdown.status(WS).state, 'locked');

    // Not the managed key but the variable the portal also sets for the processes it launches.
    h.settings.settings.set(SETTING_KEYS.mcpAccountOff, false, { actor: 'it', confirm: true });
    await h.deliver('settings');
    await h.deliver('started');
    assert.equal(await d.read(name, DROP_IN), null);
    const byEnv = await session('ENABLE_CLAUDEAI_MCP_SERVERS=false');
    assert.match(byEnv.debug, /Disabled via env var/);
    assert.equal(byEnv.asked, false);
    assert.deepEqual(byEnv.tools, [POOL]);

    // Pool MCP only alone also shuts the connector out: it is listed but blocked by the allowlist.
    h.settings.settings.set(SETTING_KEYS.mcpPoolOnly, true, { actor: 'it' });
    await h.deliver('settings');
    const pool = await session();
    assert.match(pool.out, /claude\.ai MCP server blocked by enterprise policy: claude\.ai Fake Mail/);
    assert.deepEqual(pool.tools, [POOL]);
  } finally {
    h.done();
  }
});

/** The same tool over streamable HTTP with JSON replies, on the port given: a remote pool server. */
const HTTP_SERVER = String.raw`const http=require('http');
http.createServer((req,res)=>{let b='';req.on('data',(c)=>(b+=c));req.on('end',()=>{
if(req.method!=='POST'){res.writeHead(405);return res.end()}
let m={};try{m=JSON.parse(b)}catch{}
const reply=(result)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}))};
if(m.method==='initialize')return reply({protocolVersion:(m.params&&m.params.protocolVersion)||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'remote-lab',version:'1.0.0'}});
if(m.method==='tools/list')return reply({tools:[{name:'ping',description:'Pings the remote lab',inputSchema:{type:'object',properties:{}}}]});
if(m.id===undefined){res.writeHead(202);return res.end()}reply({})})}).listen(Number(process.argv[2]),'127.0.0.1');`;

test('pool MCP only admits a remote pool server by its URL (settings-policies Q21): it connects, another URL passed with --mcp-config is blocked', { ...opts, timeout: 600_000 }, async () => {
  const h = await harness();
  try {
    await sh(`mkdir -p ${PROJECT} /tmp/lab`);
    await d.put(name, [
      file('/tmp/lab/http-server.js', HTTP_SERVER, 0o755),
      file('/tmp/extra.json', JSON.stringify({ mcpServers: { other: { type: 'http', url: 'http://127.0.0.1:4779/mcp' } } })),
    ]);
    await sh('cd /tmp/lab && (nohup node http-server.js 4778 >/tmp/lab/s1.out 2>&1 &); (nohup node http-server.js 4779 >/tmp/lab/s2.out 2>&1 &); sleep 1');
    await startStandIn(d, name);

    // A remote server on a private address, which only an entry that says so may use (the portal's SSRF guard).
    const entry = await h.mcp.catalog.create({ key: 'remote', displayName: 'Remote', kind: 'remote', spec: { url: 'http://127.0.0.1:4778/mcp', transport: 'http', auth: 'none', allowPrivateNetwork: true }, slots: [] });
    const approved = await h.mcp.catalog.approve(entry.id, entry.versions[0]!.id, { reviewed: true });
    const set = h.service.create('mcpset', { name: 'Remote set', content: { servers: [{ key: 'remote', entry: approved.id, version: approved.versions[0]!.version, enabled: true, config: {}, secrets: {} }] } });
    h.service.setAssignments(WS, 'mcpset', [{ poolId: set.id }]);
    await h.deliver();
    assert.deepEqual(h.mcp.matchers(WS), [{ serverUrl: 'http://127.0.0.1:4778/mcp' }]);

    // A first session registers the marketplace and installs the plugin.
    const first = await claudePrint(d, name, 'hello', { cwd: PROJECT });
    assert.equal(first.code, 0, first.stdout);
    assert.match(await list(), /plugin:cpm-remote-set:remote: http:\/\/127\.0\.0\.1:4778\/mcp .* ✔ Connected/);

    h.settings.settings.set(SETTING_KEYS.mcpPoolOnly, true, { actor: 'it' });
    await h.deliver('settings');
    assert.deepEqual(JSON.parse((await d.read(name, DROP_IN)) ?? 'null'), { allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverUrl: 'http://127.0.0.1:4778/mcp' }] });
    assert.match(await list(), /plugin:cpm-remote-set:remote: http:\/\/127\.0\.0\.1:4778\/mcp .* ✔ Connected/, 'the pool’s remote server still connects');
    const run = await claudePrint(d, name, 'after the lockdown', { cwd: PROJECT, args: '--mcp-config /tmp/extra.json' });
    assert.equal(run.code, 0, run.stdout);
    assert.match(run.stdout, /MCP server blocked by enterprise policy: other/);
    const last = (await recorded(d, name)).reverse().find((r) => r.tools.length > 0)!;
    assert.deepEqual(mcpTools(last.tools), ['mcp__plugin_cpm-remote-set_remote__ping']);
  } finally {
    h.done();
  }
});
