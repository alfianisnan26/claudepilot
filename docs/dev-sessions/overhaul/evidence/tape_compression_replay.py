#!/usr/bin/env python3
"""What would an output compressor (RTK-like on Bash results, Headroom-like on everything) save on OUR tapes? Counterfactual replay, read only, aggregates only.
Run in the pod: kubectl -n isnan-claudepilot-workspaces exec -i <pod> -c workspace -- python3 - < tape_compression_replay.py
Method: a tool result shrunk by factor f removes f*size/4 tokens from that thread's context from then on: the cache WRITE at the next request shrinks by those tokens
(weight 1.25 for the 5 minute cache, 2.0 for 1 hour) and every later cache READ shrinks by them (weight 0.1). Cost weights as in tape_counterfactual.py."""
import json,glob,os,collections,re,sys
base=os.path.expanduser('~/.claudepilot/sessions'); CR,CW5,CW1=0.1,1.25,2.0
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
threads=collections.defaultdict(list)
for d in glob.glob(base+'/*'):
    sid=os.path.basename(d)[:8]; names={}; last={}
    for f in sorted(glob.glob(d+'/out.*.jsonl')):
        for line in open(f,errors='ignore'):
            if '"type":"assistant"' not in line and '"type":"user"' not in line: continue
            try: o=json.loads(line)
            except Exception: continue
            t=o.get('type'); m=o.get('message') or {}; c=m.get('content'); par=o.get('parent_tool_use_id'); key=(sid,par)
            if t=='assistant':
                if not m.get('model') or m.get('model')=='<synthetic>': continue
                u=m.get('usage') or {}
                cw1=(u.get('cache_creation') or {}).get('ephemeral_1h_input_tokens',0); cw5=(u.get('cache_creation') or {}).get('ephemeral_5m_input_tokens',0); cwall=u.get('cache_creation_input_tokens',0)
                if cw1+cw5==0: cw5=cwall
                for b in (c or []):
                    if isinstance(b,dict) and b.get('type')=='tool_use':
                        names[b.get('id')]=(b.get('name'),cls((b.get('input') or {}).get('command','')) if b.get('name')=='Bash' else b.get('name'))
                rec=('A',m.get('id'),u.get('cache_read_input_tokens',0),cw5,cw1,cwall)
                mid=m.get('id')
                if mid in last: threads[key][last[mid]]=rec
                else: last[mid]=len(threads[key]); threads[key].append(rec)
            elif t=='user' and isinstance(c,list):
                for b in c:
                    if isinstance(b,dict) and b.get('type')=='tool_result':
                        cc=b.get('content'); n=len(cc) if isinstance(cc,str) else sum(len(x.get('text','')) for x in cc if isinstance(x,dict))
                        if n: threads[key].append(('R',n,names.get(b.get('tool_use_id'),('?','?'))))
def run(rule):
    total=0.0; sav=0.0
    for ev in threads.values():
        removed=0.0; pend=0.0
        for e in ev:
            if e[0]=='R':
                pend+=rule(e[1],e[2])/4.0; continue
            _,mid,cr,cw5,cw1,cwall=e
            total+=CR*cr+CW5*cw5+CW1*cw1
            sav+=CR*min(removed,cr)+(CW1 if cw1>=cw5 else CW5)*min(pend,cwall)
            removed+=pend; pend=0.0
    return 100*sav/total
bash_cls={'test','inspect','gitr','gitw','api','other'}
for f in (0.4,0.6,0.8):
    print('RTK-like: Bash results of test/inspect/git/api commands shrunk by %d%%: saves %.1f%% of input-side cost'%(f*100,run(lambda n,k,f=f: f*n if k[0]=='Bash' and k[1] in bash_cls else 0)))
for f in (0.4,0.6):
    print('Headroom-like: EVERY tool result shrunk by %d%%: saves %.1f%%'%(f*100,run(lambda n,k,f=f: f*n)))
print('Read tool results only, shrunk by 60%%: saves %.1f%%'%run(lambda n,k: 0.6*n if k[0]=='Read' else 0))
print('MCP (pilot) results only, shrunk by 60%%: saves %.1f%%'%run(lambda n,k: 0.6*n if str(k[0]).startswith('mcp__') else 0))
