#!/usr/bin/env python3
"""Evidence for docs/dev-sessions/overhaul/token-economy-design.md. Run INSIDE the workspace pod (read only):
   kubectl -n isnan-claudepilot-workspaces exec -i <pod> -c workspace -- python3 - < tape_counterfactual.py
Reads ~/.claudepilot/sessions/*/out.*.jsonl (the raw Claude Code stream of every portal session) and prints AGGREGATES only (no content).
Cost weights relative to one uncached input token: cache read 0.1, cache write 1.25 (5 min) or 2.0 (1 h), output 5. The assistant events of the stream carry an
early snapshot of output_tokens, so output is undercounted here; shares below are of the INPUT-SIDE cost (cache read + write), which is about 87 percent of the bill."""
import json,glob,os,collections,re,sys,statistics
base=os.path.expanduser('~/.claudepilot/sessions')
CR,CW5,CW1=0.1,1.25,2.0
def cls(cmd):
    l=cmd.lower()
    if re.search(r'git (commit|push|add|merge|checkout|rebase|stash|worktree add)',l): return 'gitw'
    if re.search(r'git (status|log|diff|show|fetch|branch|rev-parse|worktree list|ls-remote)',l): return 'gitr'
    if re.search(r'vitest|node .*--test|npm (run )?test|playwright|tsc|typecheck|jest|job-run|gate|scratch-portal|lighthouse|npm run (build|check)|wrangler|npm ci|npm install',l): return 'test'
    if re.search(r'kubectl|curl|\bgh\b|ph\.sh|tell\.mjs|/api/',l): return 'api'
    if re.search(r'sleep|until |watch',l): return 'wait'
    if re.search(r'<<|cat >|python3? -|sed -i|tee |perl -pi|node -e|patch ',l): return 'edit'
    if re.search(r'^\s*(cat|ls|head|tail|grep|rg|find|wc|sed -n|awk|stat|du|diff|echo|pwd)',l): return 'inspect'
    return 'other'
threads=collections.defaultdict(list)   # (sid, parent) -> events in order
for d in glob.glob(base+'/*'):
    sid=os.path.basename(d)[:8]
    last={}  # message id -> index in the thread list (keep the final snapshot)
    for f in sorted(glob.glob(d+'/out.*.jsonl')):
        for line in open(f,errors='ignore'):
            if '"type":"assistant"' not in line and '"type":"user"' not in line: continue
            try: o=json.loads(line)
            except Exception: continue
            t=o.get('type'); m=o.get('message') or {}; c=m.get('content'); par=o.get('parent_tool_use_id')
            key=(sid,par)
            if t=='assistant':
                u=m.get('usage') or {}
                if not m.get('model') or m.get('model')=='<synthetic>': continue
                cw1=(u.get('cache_creation') or {}).get('ephemeral_1h_input_tokens',0); cw5=(u.get('cache_creation') or {}).get('ephemeral_5m_input_tokens',0)
                cwall=u.get('cache_creation_input_tokens',0)
                if cw1+cw5==0: cw5=cwall
                cmds=[(b.get('input') or {}).get('command','') for b in (c or []) if isinstance(b,dict) and b.get('type')=='tool_use' and b.get('name')=='Bash']
                rec=('A',m.get('id'),u.get('cache_read_input_tokens',0),cw5,cw1,cwall,cls(' '.join(cmds)) if cmds else ('text' if not any(isinstance(b,dict) and b.get('type')=='tool_use' for b in (c or [])) else 'tool'))
                mid=m.get('id')
                if mid in last: threads[key][last[mid]]=rec
                else: last[mid]=len(threads[key]); threads[key].append(rec)
            elif t=='user' and isinstance(c,list):
                n=0
                for b in c:
                    if isinstance(b,dict) and b.get('type')=='tool_result':
                        cc=b.get('content'); n+=len(cc) if isinstance(cc,str) else sum(len(x.get('text','')) for x in cc if isinstance(x,dict))
                if n: threads[key].append(('R',n))
total=0.0; sav_cap={}; 
for CAP in (5000,8000,15000): sav_cap[CAP]=0.0
sav_batch=0.0; subthreads=[]; nmsgs=0
for (sid,par),ev in threads.items():
    removed={CAP:0.0 for CAP in sav_cap}; pend={CAP:0.0 for CAP in sav_cap}
    msgs=[e for e in ev if e[0]=='A']
    if not msgs: continue
    first=msgs[0]
    if par is not None: subthreads.append((len(msgs),sum(CR*e[2]+CW5*e[3]+CW1*e[4] for e in msgs),CW5*first[3]+CW1*first[4]+CR*first[2]))
    prevcls=None
    for e in ev:
        if e[0]=='R':
            for CAP in sav_cap:
                if e[1]>CAP: pend[CAP]+=(e[1]-CAP)/4.0
            continue
        _,mid,cr,cw5,cw1,cwall,kind=e; nmsgs+=1
        u=CR*cr+CW5*cw5+CW1*cw1; total+=u
        for CAP in sav_cap:
            rm=removed[CAP]; nw=pend[CAP]
            sav_cap[CAP]+=CR*min(rm,cr)+ (CW1 if cw1>=cw5 else CW5)*min(nw,cwall)
            removed[CAP]+=nw; pend[CAP]=0.0
        if kind in('inspect','gitr','api') and prevcls in('inspect','gitr','api'): sav_batch+=CR*cr   # a request that one batched call would not have made: only its context re-read is counted
        prevcls=kind
print('threads',len(threads),'assistant messages',nmsgs,'input-side units %.1f M'%(total/1e6))
for CAP in sorted(sav_cap): print('cap tool results at %5d chars: saves %.1f%% of input-side cost'%(CAP,100*sav_cap[CAP]/total))
print('batch consecutive inspect/git-read/api calls (only the re-read of their context): saves %.1f%%'%(100*sav_batch/total))
st=sorted(subthreads)
if st:
    n=len(st); short=[x for x in st if x[0]<=8]
    tot_sub=sum(x[1] for x in st)
    print('sub-agent runs',n,'median requests',st[n//2][0],'| runs with <=8 requests:',len(short),'(%.0f%% of runs) costing %.1f%% of sub-agent input-side cost'%(100*len(short)/n,100*sum(x[1] for x in short)/tot_sub))
    print('first request of a sub-agent (startup, units): median %.0f k, share of a <=8-request run: %.0f%%'%(statistics.median(x[2] for x in st)/1e3,100*sum(x[2] for x in short)/max(1,sum(x[1] for x in short))))
