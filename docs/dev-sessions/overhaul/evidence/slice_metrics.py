#!/usr/bin/env python3
"""Per-SLICE (sub-agent run) metrics from the raw session tapes: the baseline and the observational arm of an experiment (RTK on or off).
Run inside the workspace pod (read only); prints one JSON line per slice, NO content:
  kubectl -n isnan-claudepilot-workspaces exec -i <pod> -c workspace -- python3 - < slice_metrics.py > slices.jsonl
A slice is one sub-agent thread (parent_tool_use_id); its ticket is the first T-n in the prompt of the Agent call that started it (else null).
Fields: ticket, model, requests, ctx_p50, ctx_p90, units (read, write, out), result_chars, result_tokens_est, rewrite_tokens (cache re-written after a miss),
bash_calls, rtk_calls (Bash commands that start with `rtk`), inspect_calls, t0, t1, minutes. Units: cache read 0.1, write 1.25 (5 min) or 2.0 (1 h), output 5 (undercounted in the stream)."""
import json,glob,os,re,sys,statistics,collections,datetime
base=os.path.expanduser('~/.claudepilot/sessions')
def ts(s):
    try: return datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
    except Exception: return None
INSPECT=re.compile(r'^\s*(cat|ls|head|tail|grep|rg|find|wc|sed -n|awk|stat|du|diff|echo|pwd)\b',re.I)
for d in glob.glob(base+'/*'):
    sid=os.path.basename(d)[:8]
    agent_ticket={}              # tool_use id of an Agent call -> ticket
    th=collections.defaultdict(lambda: dict(msgs={},res=0,rch=0,bash=0,rtk=0,insp=0,model=None))
    for f in sorted(glob.glob(d+'/out.*.jsonl')):
        for line in open(f,errors='ignore'):
            if '"type":"assistant"' not in line and '"type":"user"' not in line: continue
            try: o=json.loads(line)
            except Exception: continue
            t=o.get('type'); m=o.get('message') or {}; c=m.get('content'); par=o.get('parent_tool_use_id')
            if t=='assistant':
                u=m.get('usage') or {}
                if not m.get('model') or m.get('model')=='<synthetic>': continue
                for b in (c or []):
                    if isinstance(b,dict) and b.get('type')=='tool_use':
                        inp=b.get('input') or {}
                        if b.get('name') in('Agent','Task'):
                            mt=re.search(r'\bT-\d+\b',str(inp.get('prompt',''))[:2500]+' '+str(inp.get('description','')))
                            agent_ticket[b.get('id')]=mt.group(0) if mt else None
                        if par is not None and b.get('name')=='Bash':
                            cmd=str(inp.get('command',''))
                            th[par]['bash']+=1
                            if re.match(r'^\s*(?:\w+=\S+\s+)*rtk\b',cmd): th[par]['rtk']+=1
                            if INSPECT.match(cmd): th[par]['insp']+=1
                if par is None: continue
                cc=u.get('cache_creation') or {}
                cw1=cc.get('ephemeral_1h_input_tokens',0); cw5=cc.get('ephemeral_5m_input_tokens',0); cwall=u.get('cache_creation_input_tokens',0)
                if cw1+cw5==0: cw5=cwall
                th[par]['model']=m.get('model')
                th[par]['msgs'][m.get('id')]=(ts(o.get('timestamp') or ''),u.get('cache_read_input_tokens',0),cw5,cw1,cwall,u.get('output_tokens',0))
            elif t=='user' and par is not None and isinstance(c,list):
                for b in c:
                    if isinstance(b,dict) and b.get('type')=='tool_result':
                        cc=b.get('content'); n=len(cc) if isinstance(cc,str) else sum(len(x.get('text','')) for x in cc if isinstance(x,dict))
                        th[par]['res']+=1; th[par]['rch']+=n
    for par,x in th.items():
        L=sorted(x['msgs'].values(),key=lambda r:(r[0] is None,r[0]))
        if not L: continue
        ctx=[r[1]+r[4] for r in L]; rew=0; prev=None
        for r in L:
            if prev and prev>20000 and r[1]<0.5*prev and (r[1]+r[4])>=0.7*prev: rew+=min(prev-r[1],r[4])
            prev=r[1]+r[4]
        ts_=[r[0] for r in L if r[0]]
        print(json.dumps(dict(session=sid,ticket=agent_ticket.get(par),model=x['model'],requests=len(L),ctx_p50=int(statistics.median(ctx)),ctx_p90=sorted(ctx)[int(len(ctx)*.9)],
            read=sum(0.1*r[1] for r in L),write=sum(1.25*r[2]+2.0*r[3] for r in L),out=sum(5.0*r[5] for r in L),result_chars=x['rch'],results=x['res'],
            rewrite_tokens=rew,bash_calls=x['bash'],rtk_calls=x['rtk'],inspect_calls=x['insp'],t0=min(ts_).isoformat() if ts_ else None,
            minutes=round((max(ts_)-min(ts_)).total_seconds()/60,1) if len(ts_)>1 else 0)))
