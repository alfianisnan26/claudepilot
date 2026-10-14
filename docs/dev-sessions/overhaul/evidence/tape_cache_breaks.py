#!/usr/bin/env python3
"""Cache breaks: how many cache-WRITE tokens re-write context that was already cached (a miss after the cache expired, or a changed prefix) versus new content.
Run inside the workspace pod (read only), prints aggregates only:  kubectl -n isnan-claudepilot-workspaces exec -i <pod> -c workspace -- python3 - < tape_cache_breaks.py"""
import json,glob,os,collections,statistics,datetime
base=os.path.expanduser('~/.claudepilot/sessions')
def ts(s):
    try: return datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
    except Exception: return None
threads=collections.defaultdict(dict)
for d in glob.glob(base+'/*'):
    sid=os.path.basename(d)[:8]
    for f in sorted(glob.glob(d+'/out.*.jsonl')):
        for line in open(f,errors='ignore'):
            if '"type":"assistant"' not in line: continue
            try: o=json.loads(line)
            except Exception: continue
            m=o.get('message') or {}; u=m.get('usage') or {}
            if not m.get('model') or m.get('model')=='<synthetic>': continue
            key=(sid,o.get('parent_tool_use_id'))
            threads[key][m.get('id')]=(ts(o.get('timestamp') or ''),u.get('cache_read_input_tokens',0),u.get('cache_creation_input_tokens',0),(u.get('cache_creation') or {}).get('ephemeral_1h_input_tokens',0))
tot_cw=0; rew_cw=0; n_rew=0; n_msgs=0; gaps=[]; rew_gap_buckets=collections.Counter(); main_rew=0; sub_rew=0
for (sid,par),dm in threads.items():
    L=sorted(dm.values(),key=lambda x:(x[0] is None,x[0]))
    prev=None
    for t,cr,cw,cw1 in L:
        n_msgs+=1; tot_cw+=cw
        ctx=cr+cw
        if prev is not None:
            pctx,pt=prev
            # a miss: less than half of the previous context was read from the cache although the context did not shrink
            if pctx>20000 and cr<0.5*pctx and ctx>=0.7*pctx:
                lost=pctx-cr
                rew_cw+=min(lost,cw); n_rew+=1
                if par is None: main_rew+=min(lost,cw)
                else: sub_rew+=min(lost,cw)
                if t and pt:
                    g=(t-pt).total_seconds()/60; gaps.append(g)
                    rew_gap_buckets['<5 min' if g<5 else '5-60 min' if g<60 else '>60 min']+=min(lost,cw)
        prev=(ctx,t)
print('assistant messages %d, cache-write tokens %.1f M'%(n_msgs,tot_cw/1e6))
print('re-written context after a cache miss: %.1f M tokens = %.0f%% of all cache writes, %d events'%(rew_cw/1e6,100*rew_cw/tot_cw,n_rew))
print('  main chats %.1f M, sub-agents %.1f M'%(main_rew/1e6,sub_rew/1e6))
if gaps: print('  gap before the miss: median %.1f min; tokens by gap:'%statistics.median(gaps),{k:round(v/1e6,1) for k,v in rew_gap_buckets.items()})
