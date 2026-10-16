# Moves tickets assigned to ENDED sessions to the live session of the same track (same title prefix before ':'); prints what it moved. Interim for T-270.
import json,subprocess,os
here=os.path.dirname(os.path.abspath(__file__))
def ph(m,p,b=None):
    a=[os.path.join(here,'ph.sh'),m,p]+([json.dumps(b)] if b is not None else [])
    return json.loads(subprocess.run(a,capture_output=True,text=True).stdout)
ss=ph('GET','/api/chat/sessions?limit=100')['data']['items']
track=lambda s:(s.get('title') or '').split(':')[0]
live={}
for s in sorted(ss,key=lambda s:s['createdAt']):
    if s['state']!='ended' and not s.get('archivedAt') and track(s) in ('Orchestrator','Konfersi','Event'): live[track(s)]=s['id']
dead={s['id']:track(s) for s in ss if s['state']=='ended' and track(s) in live}
moved=[]
for st in ('open','in_progress','blocked','in_review'):
    for t in ph('GET','/api/tickets?status=%s&limit=400'%st)['data']['items']:
        a=t.get('assignee') or {}
        if a.get('kind')=='session' and a['sessionId'] in dead:
            to=live[dead[a['sessionId']]]
            r=ph('PATCH','/api/tickets/'+t['id'],{'assignee':{'kind':'session','sessionId':to}})
            moved.append((t['id'],to[:8]) if 'data' in r else (t['id']+'!',to[:8]))
print('moved',len(moved),moved)
