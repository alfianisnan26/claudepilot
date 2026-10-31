#!/usr/bin/env bash
set +x # first: the sign-in code must never reach a trace, even under bash -x
# Sign in to the portal with the lab code from the Sign-in row of docs/dev-context.md, without ever printing it (owner request 2026-10-31,
# harness: an agent once printed the code by grepping that file).
#   tools/coordinator/portal-login.sh [<cookie jar>]
# Writes the session cookie to the jar (default $PORTAL_JAR, else ~/.cache/claudepilot/portal.jar; mode 0600) and prints only "signed in" or
# the HTTP status. The code goes to curl on stdin (never argv, so not in ps) and is read with awk into a variable (nothing on stdout).
# PILOT_URL (default https://pilot.ai.isnan.me); PORTAL_DEV_CONTEXT (default docs/dev-context.md of this checkout). Then use
# tools/coordinator/portal-api.sh. Through the relay: HTTPS_PROXY=http://127.0.0.1:3128 (curl reads it).
set -uo pipefail
here=$(cd "$(dirname "$0")/../.." && pwd -P)
url=${PILOT_URL:-https://pilot.ai.isnan.me}
ctx=${PORTAL_DEV_CONTEXT:-$here/docs/dev-context.md}
jar=${1:-${PORTAL_JAR:-$HOME/.cache/claudepilot/portal.jar}}
[ -r "$ctx" ] || { echo "portal-login: cannot read $ctx" >&2; exit 2; }
code=$(awk -F'|' '{ c = $2; gsub(/^ +| +$/, "", c) } c == "Sign-in" { s = $4; if (match(s, /`[^`]+`/)) print substr(s, RSTART + 1, RLENGTH - 2); exit }' "$ctx")
[ -n "$code" ] || { echo "portal-login: no code in the Sign-in row of $ctx" >&2; exit 2; }
code=${code//\\/\\\\}; code=${code//\"/\\\"}
umask 077
mkdir -p "$(dirname "$jar")" && : > "$jar" && chmod 600 "$jar" || { echo "portal-login: cannot write $jar" >&2; exit 2; }
status=$(printf '{"code":"%s"}' "$code" | curl -sS -o /dev/null -w '%{http_code}' -c "$jar" -H 'content-type: application/json' -H "origin: $url" \
  --data-binary @- "$url/api/login" 2>/dev/null) || status=${status:-000}
unset code
case $status in
  2??) echo "signed in"; exit 0 ;;
  000) echo "sign-in failed: no answer from $url"; exit 1 ;;
  *) echo "sign-in failed: HTTP $status"; exit 1 ;;
esac
