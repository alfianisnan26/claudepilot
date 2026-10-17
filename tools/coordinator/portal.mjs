// node portal.mjs tell <session id prefix> <text> | respond <prefix> <request id> <deny|allow> <message> | interrupt <prefix> | end <prefix> [reason] | configure <prefix> <model> [effort]
// Messages a chat, answers or interrupts through the Portal MCP as the owner's delegate. Needs PORTAL_SERVER_CODE; with the tunnel up run it as
//   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:3128 node portal.mjs ...
// One admin token per run, 1 hour, replacing this label's leftovers, revoked at the end even when the call fails (tokenLease.mjs, T-258).
import { tokenLease } from './tokenLease.mjs';
const PORTAL='https://pilot.ai.isnan.me', CODE=process.env.PORTAL_SERVER_CODE, [cmd, prefix, ...rest] = process.argv.slice(2);
let cookie='';
async function api(m,p,b){ if(!cookie){const l=await fetch(`${PORTAL}/api/login`,{method:'POST',headers:{'content-type':'application/json',origin:PORTAL},body:JSON.stringify({code:CODE})});cookie=(l.headers.getSetCookie?.()??[]).map(c=>c.split(';')[0]).join('; ');}
 const r=await fetch(`${PORTAL}${p}`,{method:m,headers:{'content-type':'application/json',origin:PORTAL,cookie},...(b===undefined?{}:{body:JSON.stringify(b)})}); const j=await r.json().catch(()=>null); return {data:j?.data,error:j?.error}; }
const s=((await api('GET','/api/chat/sessions?limit=100')).data?.items??[]).find((x)=>x.id.startsWith(prefix)); if(!s){console.log('no session',prefix);process.exit(1);}
const lease=tokenLease({api,label:'coordinator'}); let secret; try{secret=await lease.get();}catch(e){console.log(e.message);process.exit(1);}
try {
const h={authorization:`Bearer ${secret}`,'content-type':'application/json',accept:'application/json, text/event-stream'};
const init=await fetch(`${PORTAL}/mcp`,{method:'POST',headers:h,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'coordinator',version:'1'}}})});
const sid=init.headers.get('mcp-session-id'); await init.text();
const call=(name,args)=>fetch(`${PORTAL}/mcp`,{method:'POST',headers:{...h,...(sid?{'mcp-session-id':sid}:{})},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}})});
let res;
if(cmd==='tell') res=await call('session_send',{id:s.id,text:rest.join(' ')});
else if(cmd==='respond') res=await call('session_respond',{id:s.id,request_id:rest[0],decision:rest[1],message:rest.slice(2).join(' ')});
else if(cmd==='interrupt') res=await call('session_interrupt',{id:s.id});
else if(cmd==='end') res=await call('session_end',{id:s.id,reason:rest.join(' ')||'ended by the coordinator'});
else if(cmd==='configure') res=await call('session_configure',{id:s.id,...(rest[0]?{model:rest[0]}:{}),...(rest[1]?{effort:rest[1]}:{})});
else {console.log('unknown command');process.exitCode=2;}
if(res){const text=await res.text();
console.log(`${res.status} ${cmd} -> ${s.id.slice(0,8)} "${s.title}" ${/Denied|Allowed|Interrupted|confirmation|error/i.exec(text)?.[0]??''}`);}
} finally { await lease.revoke(); }
