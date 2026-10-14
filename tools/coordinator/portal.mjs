// node portal.mjs tell <session id prefix> <text> | respond <prefix> <request id> <deny|allow> <message> | interrupt <prefix> | end <prefix> [reason]
// Messages a chat, answers or interrupts through the Portal MCP as the owner's delegate. Needs PORTAL_SERVER_CODE; with the tunnel up run it as
//   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:3128 node portal.mjs ...
// One admin token per call (the portal caps tokens per label, T-258): live tokens of this label are replaced first and the new one is revoked at the end.
const PORTAL='https://pilot.ai.isnan.me', CODE=process.env.PORTAL_SERVER_CODE, [cmd, prefix, ...rest] = process.argv.slice(2);
let cookie='';
async function api(m,p,b){ if(!cookie){const l=await fetch(`${PORTAL}/api/login`,{method:'POST',headers:{'content-type':'application/json',origin:PORTAL},body:JSON.stringify({code:CODE})});cookie=(l.headers.getSetCookie?.()??[]).map(c=>c.split(';')[0]).join('; ');}
 const r=await fetch(`${PORTAL}${p}`,{method:m,headers:{'content-type':'application/json',origin:PORTAL,cookie},...(b===undefined?{}:{body:JSON.stringify(b)})}); const j=await r.json().catch(()=>null); return {data:j?.data,error:j?.error}; }
const s=((await api('GET','/api/chat/sessions')).data??[]).find((x)=>x.id.startsWith(prefix)); if(!s){console.log('no session',prefix);process.exit(1);}
const st=(await api('GET','/api/portal-mcp')).data; for (const t of (st?.tokens??[])) if(!t.revokedAt && t.label==='coordinator') await api('DELETE',`/api/portal-mcp/tokens/${t.id}`);
const tk=(await api('POST','/api/portal-mcp/tokens',{label:'coordinator',scope:'admin',expiresInDays:7})).data; if(!tk){console.log('token refused');process.exit(1);}
const h={authorization:`Bearer ${tk.secret}`,'content-type':'application/json',accept:'application/json, text/event-stream'};
const init=await fetch(`${PORTAL}/mcp`,{method:'POST',headers:h,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'coordinator',version:'1'}}})});
const sid=init.headers.get('mcp-session-id'); await init.text();
const call=(name,args)=>fetch(`${PORTAL}/mcp`,{method:'POST',headers:{...h,...(sid?{'mcp-session-id':sid}:{})},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}})});
let res;
if(cmd==='tell') res=await call('session_send',{id:s.id,text:rest.join(' ')});
else if(cmd==='respond') res=await call('session_respond',{id:s.id,request_id:rest[0],decision:rest[1],message:rest.slice(2).join(' ')});
else if(cmd==='interrupt') res=await call('session_interrupt',{id:s.id});
else if(cmd==='end') res=await call('session_end',{id:s.id,reason:rest.join(' ')||'ended by the coordinator'});
else {console.log('unknown command');process.exit(2);}
const text=await res.text(); await api('DELETE',`/api/portal-mcp/tokens/${tk.id}`);
console.log(`${res.status} ${cmd} -> ${s.id.slice(0,8)} "${s.title}" ${/Denied|Allowed|Interrupted|confirmation|error/i.exec(text)?.[0]??''}`);
