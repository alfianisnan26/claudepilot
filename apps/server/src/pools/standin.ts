// A scripted stand-in for the Anthropic Messages API, for the Docker-only tests that run a real Claude Code
// in a throwaway workspace container (no network, a fake key, no sign-in). It records every model request
// (tools, system and messages) so a test can read exactly what Claude Code was told: the delivered
// instructions, the skill listing, the subagents. Used with CLAUDEPILOT_DOCKER_TESTS=1, like
// secrets/claude.integration.test.ts (whose own copy also scripts tool calls).
import type { DeliveryAccess } from '../workspaces/runtime.js';

export const STANDIN_PORT = 4599;
export const STANDIN_DIR = '/tmp/standin';

/**
 * A request that offers tools gets the next scripted step from `steps.json` (a tool call, or text) and any
 * other request gets "ok"; every tool result Claude Code sends back lands in `log.jsonl`, and every request
 * in `requests.jsonl`.
 */
export const STANDIN_API = String.raw`
const http=require('http'),fs=require('fs'),dir=process.argv[2];
let steps=[];try{steps=JSON.parse(fs.readFileSync(dir+'/steps.json','utf8'))}catch{}
let next=0;
function sse(res,block,stop){res.writeHead(200,{'content-type':'text/event-stream'});const s=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
s('message_start',{message:{id:'msg_'+Date.now(),type:'message',role:'assistant',model:'mock',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}});
if(block.text!==undefined){s('content_block_start',{index:0,content_block:{type:'text',text:''}});s('content_block_delta',{index:0,delta:{type:'text_delta',text:block.text}})}
else{s('content_block_start',{index:0,content_block:{type:'tool_use',id:'toolu_'+next,name:block.tool,input:{}}});s('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}})}
s('content_block_stop',{index:0});s('message_delta',{delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:1}});s('message_stop',{});res.end()}
http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',async()=>{let j={};try{j=JSON.parse(b||'{}')}catch{}
if(req.url.includes('count_tokens'))return res.end('{"input_tokens":1}');
const extra=Object.fromEntries(Object.entries(j).filter(([k])=>!['messages','system','tools'].includes(k)));
fs.appendFileSync(dir+'/requests.jsonl',JSON.stringify({url:req.url,model:j.model,tools:(j.tools||[]).map(t=>t.name),extra,system:j.system,messages:j.messages})+'\n');
for(const c of [].concat((j.messages||[]).at(-1)?.content||[]))if(c&&c.type==='tool_result')fs.appendFileSync(dir+'/log.jsonl',JSON.stringify({error:!!c.is_error,content:JSON.stringify(c.content)})+'\n');
const step=steps[next]&&(j.tools||[]).length?steps[next++]:{text:'ok'};if(step.waitFor)while(!fs.existsSync(step.waitFor))await new Promise(r=>setTimeout(r,200));
if(!j.stream)return res.end(JSON.stringify({id:'m',type:'message',role:'assistant',model:'mock',content:[{type:'text',text:'ok'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}));
sse(res,step,step.text!==undefined?'end_turn':'tool_use')})}).listen(${STANDIN_PORT},'127.0.0.1');`;

/** What one model request carried, as the stand-in recorded it. */
export interface RecordedRequest {
  url: string;
  model: string;
  tools: string[];
  /** Every other top-level key of the request: `output_config` (the effort), `thinking`, `max_tokens`, … */
  extra: { output_config?: { effort?: string }; [key: string]: unknown };
  system: unknown;
  messages: { role: string; content: unknown }[];
}

/** Starts the stand-in inside the container (as the workspace user), with optional scripted steps. */
export async function startStandIn(d: DeliveryAccess, name: string, steps: unknown[] = []): Promise<void> {
  await d.put(name, [
    { path: STANDIN_DIR, type: 'directory', mode: 0o755, uid: 1000, gid: 1000 },
    { path: `${STANDIN_DIR}/api.js`, type: 'file', content: STANDIN_API, mode: 0o644, uid: 1000, gid: 1000 },
    { path: `${STANDIN_DIR}/steps.json`, type: 'file', content: JSON.stringify(steps), mode: 0o644, uid: 1000, gid: 1000 },
  ]);
  await d.run(name, `cd ${STANDIN_DIR} && (nohup node api.js ${STANDIN_DIR} >api.out 2>&1 &) && sleep 1`, { user: 'node' });
}

/** Claude Code's environment for talking to the stand-in: a fake key, nothing else on the wire. */
export const STANDIN_ENV = `ANTHROPIC_BASE_URL=http://127.0.0.1:${STANDIN_PORT} ANTHROPIC_API_KEY=fake-mock-key CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1`;

/** `claude -p <prompt>` in `cwd` as the workspace user, against the stand-in. */
export async function claudePrint(d: DeliveryAccess, name: string, prompt: string, opts: { cwd?: string; args?: string; env?: string } = {}) {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return d.run(name, `cd ${opts.cwd ?? '/home/node'} && env ${STANDIN_ENV} ${opts.env ?? ''} timeout 150 claude -p ${q(prompt)} --model claude-sonnet-4-5 ${opts.args ?? ''} 2>&1`, { user: 'node' });
}

/** Every model request the stand-in recorded, oldest first. */
export async function recorded(d: DeliveryAccess, name: string): Promise<RecordedRequest[]> {
  const raw = (await d.read(name, `${STANDIN_DIR}/requests.jsonl`)) ?? '';
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RecordedRequest);
}

/** All text of one request, system and messages, flattened: what to search for what Claude Code was told. */
export function textOf(req: RecordedRequest): string {
  const flat = (c: unknown): string =>
    typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n') : '';
  return [flat(req.system), ...req.messages.map((m) => flat(m.content))].join('\n=====\n');
}
