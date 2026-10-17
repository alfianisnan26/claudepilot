#!/usr/bin/env bash
# The Bash commands a lead's workers really ran, one JSON line each ({"session","at","command"}), for rule_replay.py.
#   tools/coordinator/rule_corpus.sh <lead session id prefix> <since, ISO> > corpus.jsonl
# Needs PORTAL_SERVER_CODE (source ~/.claudepilot/portal.env first). Reads chat events only; prints no secret.
set -euo pipefail
lead=${1:?lead session id prefix}; since=${2:?since, e.g. 2026-10-15T17:00}
here=$(cd "$(dirname "$0")" && pwd)
"$here/ph.sh" GET '/api/chat/sessions?limit=100'| LEAD="$lead" SINCE="$since" python3 -c '
import json,os,sys
for s in json.load(sys.stdin)["data"]["items"]:
  if (s.get("parentId") or "").startswith(os.environ["LEAD"]) and (s.get("lastActivityAt") or "") >= os.environ["SINCE"]: print(s["id"])' |
while read -r id; do
  "$here/ph.sh" GET "/api/chat/sessions/$id/events?tail=5000" | SID="$id" python3 -c '
import json,os,sys
try: d=json.load(sys.stdin)["data"]
except Exception: sys.exit()
for e in (d if isinstance(d,list) else d.get("events",[])):
  c=(e.get("toolInput") or {}).get("command") if e.get("kind")=="tool_use" and e.get("toolName")=="Bash" else None
  if c: print(json.dumps({"session":os.environ["SID"],"at":e.get("at",""),"command":c}))'
done
