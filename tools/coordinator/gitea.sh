#!/usr/bin/env bash
set +x # first: nothing below may trace the token
# One Konfersi Gitea API call with the konfersi-orch token, run INSIDE the Konfersi workspace pod so the token never leaves it (owner
# request 2026-10-31, harness: wrong token-path guesses broke a PR call).
#   tools/coordinator/gitea.sh METHOD PATH [json | @file]
# PATH: /repos/<owner>/<repo>/pulls ... (/api/v1 is added when missing). Prints the JSON response; on HTTP 400 and up the status goes to
# stderr and the exit is 1. The token is read in the pod from the first readable of /home/node/.konfersi-orch/gitea-tokens.txt and
# /etc/claudepilot/secrets/files/h__.konfersi-orch__gitea-tokens.txt (last field of the first non-empty line), written to a 0600 temp
# file for curl -K and deleted after; it is never printed, never in argv. The body goes over stdin (an @file is read here, on this side).
# Overrides: GITEA_POD (else the Running pod with label GITEA_POD_SELECTOR=claudepilot.workspace=kohi-event, else the first pod named
# GITEA_POD_PREFIX=ws-kohi-event-*), GITEA_NAMESPACE (isnan-claudepilot-workspaces), GITEA_CONTAINER (workspace), GITEA_URL
# (https://git.konfersi.com), GITEA_TOKEN_FILES (colon list), GITEA_LOCAL=1 (run here, without kubectl: when this already is the pod).
set -uo pipefail
ns=${GITEA_NAMESPACE:-isnan-claudepilot-workspaces}
gitea=${GITEA_URL:-https://git.konfersi.com}
files=${GITEA_TOKEN_FILES:-/home/node/.konfersi-orch/gitea-tokens.txt:/etc/claudepilot/secrets/files/h__.konfersi-orch__gitea-tokens.txt}
method=${1:-} path=${2:-} body=${3-}
[[ $method =~ ^(GET|POST|PUT|PATCH|DELETE)$ ]] && [[ $path == /* ]] || { echo "usage: gitea.sh METHOD /repos/... [json|@file]" >&2; exit 2; }
[[ $path == /api/v1/* ]] || path=/api/v1$path
hasbody=0
if [ $# -ge 3 ]; then
  hasbody=1
  if [[ $body == @* ]]; then body=$(cat -- "${body#@}") || { echo "gitea: cannot read ${body#@}" >&2; exit 2; }; fi
fi

# What runs in the pod: $1 method, $2 url, $3 has a body (stdin), then the token files.
remote='set +x; set -uo pipefail
m=$1 u=$2 hb=$3; shift 3
tok=""
for f in "$@"; do [ -r "$f" ] || continue; tok=$(awk "NF { print \$NF; exit }" "$f" 2>/dev/null); [ -n "$tok" ] && break; done
[ -n "$tok" ] || { echo "gitea: no readable token file in the pod ($*)" >&2; exit 3; }
umask 077; cfg=$(mktemp) || exit 3; trap "rm -f \"\$cfg\"" EXIT
printf "header = \"Authorization: token %s\"\n" "$tok" > "$cfg"; tok=""
a=(-sS -K "$cfg" -X "$m" -H "accept: application/json" -w "\n%{http_code}")
[ "$hb" = 1 ] && a+=(-H "content-type: application/json" --data-binary @-)
curl "${a[@]}" "$u"'
IFS=: read -r -a tokfiles <<< "$files"

if [ "${GITEA_LOCAL:-0}" = 1 ]; then
  run() { bash -c "$remote" gitea-remote "$method" "$gitea$path" "$hasbody" "${tokfiles[@]}"; }
else
  pod=${GITEA_POD:-}
  if [ -z "$pod" ]; then
    pod=$(kubectl -n "$ns" get pods -l "${GITEA_POD_SELECTOR:-claudepilot.workspace=kohi-event}" --field-selector=status.phase=Running -o name 2>/dev/null | head -n 1)
    [ -n "$pod" ] || pod=$(kubectl -n "$ns" get pods -o name 2>/dev/null | grep -m1 "^pod/${GITEA_POD_PREFIX:-ws-kohi-event}-" || true)
  fi
  pod=${pod#pod/}
  [ -n "$pod" ] || { echo "gitea: no Konfersi workspace pod in $ns (set GITEA_POD)" >&2; exit 2; }
  run() { kubectl -n "$ns" exec -i "$pod" -c "${GITEA_CONTAINER:-workspace}" -- bash -c "$remote" gitea-remote "$method" "$gitea$path" "$hasbody" "${tokfiles[@]}"; }
fi
out=$(if [ "$hasbody" = 1 ]; then printf '%s' "$body"; fi | run) || { rc=$?; [ "$rc" = 3 ] && exit 2; echo "gitea: the call failed (exit $rc)" >&2; exit 1; }
status=${out##*$'\n'}
printf '%s\n' "${out%$'\n'*}"
case $status in
  [23]??) exit 0 ;;
  *) echo "gitea: HTTP $status" >&2; exit 1 ;;
esac
