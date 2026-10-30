#!/usr/bin/env bash
# cf-logs.sh: read Cloudflare Workers Observability events for the Konfersi STG Workers (owner, 2026-10-19: agents and leads
# live-check stg on Cloudflare). Read-only; the token never leaves this process and is never printed.
#   scripts/cf-logs.sh [--script <stg worker name>] [--since 30m|2h|1d] [--level error|warn|log|info] [--search <text>] [--limit N]
# Only Worker names ending in -stg are allowed (uat and production stay out of reach, D-62/T-93). Messages are cut to 400 chars and
# anything shaped like a credential (Bearer, JWT, long hex or base64, key=value secrets) is replaced by [redacted].
# Token: CF_OBS_TOKEN_FILE (default the konfersi-stg pool file CF_OBS_STG_TOKEN), account CF_ACCOUNT_ID (default Konfersi).
set -euo pipefail
exec python3 -I - "$@" <<'PY'
import json, os, re, sys, time, urllib.request, urllib.error
args = sys.argv[1:]
opt = {"--script": None, "--since": "30m", "--level": None, "--search": None, "--limit": "50"}
i = 0
while i < len(args):
    a = args[i]
    if a in ("-h", "--help"):
        print("usage: cf-logs.sh [--script <name>-stg] [--since 30m|2h|1d] [--level error|warn|log|info] [--search text] [--limit N]"); sys.exit(0)
    if a not in opt or i + 1 >= len(args): sys.exit(f"cf-logs: unknown or incomplete option {a!r} (see --help)")
    opt[a] = args[i + 1]; i += 2
script = opt["--script"]
if script is not None and not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}-stg", script):
    sys.exit(f"cf-logs: refused {script!r}: only stg Workers (names ending in -stg)")
m = re.fullmatch(r"(\d{1,4})([mhd])", opt["--since"] or "")
if not m: sys.exit("cf-logs: --since is like 30m, 2h or 1d")
since_ms = int(m.group(1)) * {"m": 60, "h": 3600, "d": 86400}[m.group(2)] * 1000
if 7 * 86400000 < since_ms: sys.exit("cf-logs: --since is at most 7d")
level = opt["--level"]
if level is not None and level not in ("error", "warn", "log", "info", "debug"): sys.exit("cf-logs: --level is error, warn, log, info or debug")
try: limit = max(1, min(200, int(opt["--limit"])))
except ValueError: sys.exit("cf-logs: --limit is a number")
tf = os.environ.get("CF_OBS_TOKEN_FILE", "/etc/claudepilot/secrets/files/CF_OBS_STG_TOKEN")
try: tok = open(tf).read().strip()
except OSError: sys.exit(f"cf-logs: no token file {tf} (the konfersi-stg Secrets pool entry CF_OBS_STG_TOKEN)")
acct = os.environ.get("CF_ACCOUNT_ID", "c43d4afc2175723841934a1198042006")
base = os.environ.get("CF_API_BASE", "https://api.cloudflare.com/client/v4")
filters = [{"key": "$workers.scriptName", "operation": "eq" if script else "includes", "type": "string", "value": script or "-stg"}]
if level: filters.append({"key": "$metadata.level", "operation": "eq", "type": "string", "value": level})
if opt["--search"]: filters.append({"key": "$metadata.message", "operation": "includes", "type": "string", "value": opt["--search"][:200]})
now = int(time.time() * 1000)
body = {"queryId": "cf-logs", "timeframe": {"from": now - since_ms, "to": now}, "view": "events", "limit": limit,
        "parameters": {"filters": filters, "filterCombination": "and"}}
req = urllib.request.Request(f"{base}/accounts/{acct}/workers/observability/telemetry/query", data=json.dumps(body).encode(),
                             headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"}, method="POST")
try:
    d = json.load(urllib.request.urlopen(req, timeout=60))
except urllib.error.HTTPError as e:
    b = e.read().decode(errors="replace")
    try: msg = "; ".join(x.get("message", "") for x in json.loads(b).get("errors", []))
    except Exception: msg = b[:200]
    sys.exit(f"cf-logs: Cloudflare answered {e.code}: {msg}")
ev = (d.get("result") or {}).get("events") or {}
evs = ev.get("events") if isinstance(ev, dict) else ev
SECRET = [re.compile(p) for p in (r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{8,}", r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}",
          r"(?i)\b(token|secret|password|passwd|api[_-]?key|authorization|cookie|session)\b\s*[=:]\s*\S+", r"\b[A-Fa-f0-9]{32,}\b", r"\b[A-Za-z0-9+/]{40,}={0,2}")]
def clean(s):
    s = str(s)
    for p in SECRET: s = p.sub("[redacted]", s)
    return s.replace("\n", " ")[:400]
shown = 0
for e in evs or []:
    w = e.get("$workers") or {}; md = e.get("$metadata") or {}
    name = w.get("scriptName") or md.get("service") or "?"
    if not str(name).endswith("-stg"): continue  # belt and braces: never print a non-stg Worker's event
    ts = e.get("timestamp") or md.get("timestamp") or 0
    t = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(ts) / 1000)) if isinstance(ts, (int, float)) and ts else str(ts)
    req_ = (w.get("event") or {}).get("request") or {}
    path = clean(req_.get("path") or req_.get("url") or "")
    print(f"{t} {name} {md.get('level') or '-'} {w.get('outcome') or '-'} {req_.get('method') or ''} {path} :: {clean(md.get('message') or md.get('error') or '')}")
    shown += 1
print(f"cf-logs: {shown} event(s), last {opt['--since']}, {'script ' + script if script else 'all -stg Workers'}{', level ' + level if level else ''}", file=sys.stderr)
PY
