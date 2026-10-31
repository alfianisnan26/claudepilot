#!/usr/bin/env bash
# One portal API call with the cookie jar of tools/coordinator/portal-login.sh (owner request 2026-10-31, harness).
#   tools/coordinator/portal-api.sh METHOD /api/path [json | @file]
# Sends the origin header the portal requires for a cookie session, prints the response body; on HTTP 400 and up prints the status to
# stderr and exits 1 (401: sign in again with portal-login.sh). PILOT_URL (default https://pilot.ai.isnan.me), PORTAL_JAR (default
# ~/.cache/claudepilot/portal.jar).
set -uo pipefail
url=${PILOT_URL:-https://pilot.ai.isnan.me}
jar=${PORTAL_JAR:-$HOME/.cache/claudepilot/portal.jar}
method=${1:-} path=${2:-} body=${3-}
[[ $method =~ ^(GET|POST|PUT|PATCH|DELETE|HEAD)$ ]] && [[ $path == /* ]] || { echo "usage: portal-api.sh METHOD /api/path [json|@file]" >&2; exit 2; }
[ -s "$jar" ] || { echo "portal-api: no session in $jar; run tools/coordinator/portal-login.sh first" >&2; exit 2; }
args=(-sS -X "$method" -b "$jar" -c "$jar" -H "origin: $url" -H 'accept: application/json' -w '\n%{http_code}')
if [ $# -ge 3 ]; then
  if [[ $body == @* ]]; then [ -r "${body#@}" ] || { echo "portal-api: cannot read ${body#@}" >&2; exit 2; }; args+=(-H 'content-type: application/json' --data-binary "$body")
  else args+=(-H 'content-type: application/json' --data-binary @-); fi
fi
out=$(if [ $# -ge 3 ] && [[ $body != @* ]]; then printf '%s' "$body"; fi | curl "${args[@]}" "$url$path") || { echo "portal-api: curl failed" >&2; exit 1; }
status=${out##*$'\n'}
printf '%s\n' "${out%$'\n'*}"
case $status in
  [23]??) exit 0 ;;
  401) echo "portal-api: HTTP 401 (signed out? run tools/coordinator/portal-login.sh)" >&2; exit 1 ;;
  *) echo "portal-api: HTTP $status" >&2; exit 1 ;;
esac
