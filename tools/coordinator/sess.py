import sys,json
for s in sorted(json.load(sys.stdin)['data'],key=lambda s:s['lastActivityAt']):
    if s['state']!='ended' or s['lastActivityAt']>'2026-10-14T00:00': print(s['id'][:8],s['state'],(s.get('mode') or '')[:6],s.get('claudeName'),'agents',s.get('agentsRunning'),'ctx',((s.get('context') or {}).get('usedTokens') or 0)//1000,'k',s['lastActivityAt'][11:19],(s['title'] or '')[:24],'|',(s.get('endedReason') or '')[:60])
