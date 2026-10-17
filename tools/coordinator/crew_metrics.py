#!/usr/bin/env python3
"""Crew monitor (T-294, D-47, D-48): one snapshot of how the ClaudePilot crew works, appended as a JSON line, and a short summary.
Reads the portal as the owner through tools/coordinator/ph.sh (PORTAL_SERVER_CODE in the environment); aggregates only, no transcript text.
  PORTAL_SERVER_CODE=... python3 tools/coordinator/crew_metrics.py [--since ISO] [--log PATH]
"""
import collections, datetime, json, os, subprocess, sys, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.expanduser('~/.claudepilot/dev-sessions/crew-monitor.jsonl')
LEAD_TITLE = 'Orchestrator: ClaudePilot dev'

def api(path):
    out = subprocess.run([os.path.join(HERE, 'ph.sh'), 'GET', path], capture_output=True, text=True, timeout=60).stdout
    try:
        return json.loads(out).get('data')
    except Exception:
        return None

def audit_pages(kind, since=None, max_pages=20):
    """D-58: the audit trail comes in pages of at most 100, newest first; follow `next` until an entry older than `since` (or the end)."""
    out, cursor = [], ''
    for _ in range(max_pages):
        d = api(f'/api/chat/audit?kind={kind}&limit=100' + (f'&cursor={urllib.parse.quote(cursor)}' if cursor else '')) or {}
        items = d.get('items', []) if isinstance(d, dict) else d
        out.extend(items)
        cursor = d.get('next') or '' if isinstance(d, dict) else ''
        if not cursor or (since and items and items[-1]['at'] < since):
            break
    return out

def main():
    args = sys.argv[1:]
    since = args[args.index('--since') + 1] if '--since' in args else None
    log = args[args.index('--log') + 1] if '--log' in args else LOG
    now = datetime.datetime.now(datetime.timezone.utc)
    snap = {'at': now.isoformat(timespec='seconds')}
    sessions = (api('/api/chat/sessions?limit=100') or {}).get('items', [])  # D-58: a page, the newest 100
    leads = [s for s in sessions if s.get('title') == LEAD_TITLE and s.get('state') != 'ended']
    lead = leads[0] if leads else None
    if lead:
        snap['lead'] = {'id': lead['id'][:8], 'state': lead['state'], 'claude': lead.get('claudeName'), 'model': lead.get('model'),
                        'ctx_k': ((lead.get('context') or {}).get('usedTokens') or 0) // 1000, 'agents': lead.get('agentsRunning'),
                        'cost': round(lead.get('costUsd') or 0, 2), 'mode': lead.get('mode')}
    kids = [s for s in sessions if lead and s.get('parentId') == lead['id']]
    if since: kids = [s for s in kids if (s.get('createdAt') or '') >= since]
    snap['workers'] = {
        'total': len(kids),
        'by_state': dict(collections.Counter(s['state'] for s in kids)),
        'by_claude': dict(collections.Counter(s.get('claudeName') for s in kids)),
        'by_role': dict(collections.Counter(s.get('agent') or '-' for s in kids)),
        'by_mode': dict(collections.Counter(s.get('mode') for s in kids)),
        'waiting': sum(1 for s in kids if s.get('waiting')),
        'cost': round(sum(s.get('costUsd') or 0 for s in kids), 2),
        'ended_reasons': dict(collections.Counter((s.get('endedReason') or '')[:40] for s in kids if s['state'] == 'ended')),
    }
    spawned = audit_pages('agent.spawned', since)
    refused = audit_pages('agent.refused', since)
    if since:
        spawned = [a for a in spawned if a['at'] >= since]
        refused = [a for a in refused if a['at'] >= since]
    snap['spawns'] = {'n': len(spawned), 'why': dict(collections.Counter(((a.get('detail') or {}).get('spawn') or {}).get('why') for a in spawned)),
                      'refused': dict(collections.Counter((a.get('detail') or {}).get('scope') for a in refused))}
    usage = api('/api/claude-usage/summary') or {}
    quota = {}
    for c in usage.get('claudes') or []:
        lim = c.get('limit') or {}
        quota[c['name']] = [((lim.get('window') or {}).get('usedPct')), (lim.get('projectedPct') or {}).get('value'), (lim.get('status') or {}).get('value')]
    snap['quota'] = quota
    used = [v[0] for v in quota.values() if isinstance(v[0], (int, float))]
    snap['quota_spread'] = {'max': max(used) if used else None, 'mean': round(sum(used) / len(used), 1) if used else None}
    runs = (api('/api/ci/runs?limit=3') or {}).get('items') or []
    snap['ci'] = [[r['number'], r['status'], r['pipeline'], (r.get('sha') or '')[:7]] for r in runs]
    t = api('/api/tickets?limit=1') or {}
    snap['tickets'] = ((t.get('counts') or {}).get('byStatus'))
    if lead:
        ev = api(f"/api/chat/sessions/{lead['id']}/events?limit=400") or []
        if isinstance(ev, dict): ev = ev.get('events') or []  # T-376: with ?limit the route answers a page {events, more, before}
        reports = [e for e in ev if e.get('actor') == 'portal:crew' and (not since or (e.get('at') or '') >= since)]
        snap['lead_reports'] = len(reports)
    try:
        c = subprocess.run(['git', '-C', os.path.dirname(os.path.dirname(HERE)), 'log', 'origin/integration', '--since=1 hour ago', '--oneline'], capture_output=True, text=True, timeout=30).stdout
        snap['integration_commits_1h'] = len([l for l in c.splitlines() if l.strip()])
    except Exception:
        pass
    os.makedirs(os.path.dirname(log), exist_ok=True)
    with open(log, 'a') as f:
        f.write(json.dumps(snap) + '\n')
    w = snap['workers']
    print(f"{snap['at'][11:16]} lead {snap.get('lead', {}).get('claude')} ctx {snap.get('lead', {}).get('ctx_k')}k agents {snap.get('lead', {}).get('agents')} | "
          f"workers {w['total']} {w['by_state']} on {w['by_claude']} roles {w['by_role']} waiting {w['waiting']} cost ${w['cost']} | "
          f"spawns {snap['spawns']} | reports {snap.get('lead_reports')} | quota max {snap['quota_spread']['max']} mean {snap['quota_spread']['mean']} | "
          f"ci {snap['ci'][:1]} | commits/1h {snap.get('integration_commits_1h')}")

if __name__ == '__main__':
    main()
