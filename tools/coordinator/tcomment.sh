#!/usr/bin/env bash
# Posts a ticket comment whose text comes from STDIN, never from a shell argument: backticks, $ and quotes in the text
# stay text (2026-10-15, twice: `python3 -c "..."` ran the text's backticks as commands). Usage:
#   tools/coordinator/tcomment.sh T-123 <<'TXT'
#   any text, `code`, $vars and "quotes" are kept as written
#   TXT
# Needs PORTAL_SERVER_CODE (source ~/.claudepilot/portal.env first). Prints the new comment's id.
set -euo pipefail
ticket="${1:?usage: tcomment.sh T-<n> < text}"
[[ "$ticket" =~ ^T-[0-9]+$ ]] || { echo "tcomment: $ticket is not a ticket id" >&2; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
body="$(mktemp)"
trap 'rm -f "$body"' EXIT
python3 -c 'import json,sys; t=sys.stdin.read().rstrip("\n"); assert t.strip(), "empty comment"; json.dump({"text": t}, open(sys.argv[1], "w"))' "$body"
"$here/ph.sh" POST "/api/tickets/$ticket/comments" "@$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("error") or "comment %s on %s" % (d["data"]["id"], d["data"]["ticketId"]))'
