# Read-only transcript preview, as pilot would show it: per session the turns and the last prompt and reply, clipped and redacted.
# Input on stdin: lines "<agent>\t<path>\t<json line>" produced by poc.sh view (root reads the person's own session files).
import json, re, sys, collections
RED = re.compile(r'(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_\w+|AIza[0-9A-Za-z_-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)')
clip = lambda t: RED.sub('[redacted]', ' '.join((t or '').split()))[:70]
S = collections.OrderedDict()
def texts(content, kinds):
    if isinstance(content, str): return content
    return ' '.join(c.get('text', '') for c in (content or []) if isinstance(c, dict) and c.get('type') in kinds)
for line in sys.stdin:
    try: agent, path, raw = line.rstrip('\n').split('\t', 2); o = json.loads(raw)
    except Exception: continue
    s = S.setdefault(path, {'agent': agent, 'user': 0, 'asst': 0, 'lu': '', 'la': ''})
    if agent == 'claude':
        m = o.get('message') or {}
        if o.get('type') == 'user' and not o.get('isMeta'):
            t = texts(m.get('content'), ('text',))
            if t and not t.startswith('<'): s['user'] += 1; s['lu'] = t
        elif o.get('type') == 'assistant':
            t = texts(m.get('content'), ('text',))
            if t: s['asst'] += 1; s['la'] = t
    elif agent == 'codex':
        p = o.get('payload') or {}
        if o.get('type') == 'response_item' and p.get('type') == 'message':
            if p.get('role') == 'user':
                t = texts(p.get('content'), ('input_text',))
                if t and not t.lstrip().startswith('<'): s['user'] += 1; s['lu'] = t
            elif p.get('role') == 'assistant':
                t = texts(p.get('content'), ('output_text',))
                if t: s['asst'] += 1; s['la'] = t
for path, s in S.items():
    print(f"{s['agent']:7} {path.split('/')[-1][:44]:44} prompts {s['user']}  replies {s['asst']}")
    if s['lu']: print(f"        last prompt: {clip(s['lu'])}")
    if s['la']: print(f"        last reply : {clip(s['la'])}")
if not S: print('(no Claude or Codex session yet)')
