#!/usr/bin/env bash
# T-1079 S4: one CI remote per Konfersi module, each following its Gitea repository, with a Release report of kind Branch (local-git-ci PRD
# FR41c). Idempotent: a second run changes nothing. A DRY RUN unless --apply: it only reads the portal and prints what it would do.
#
#   scripts/konfersi-release-remotes.sh --portal https://<portal> --manifest <konfersi-universe>/manifest.json [--apply]
#
# The person's portal session is the FIRST LINE OF STDIN (every route it calls is a person's: an agent or a Portal MCP token is refused there).
# It goes to curl through its config on stdin (-K -): never an argument, a file, a log or this script's output.
#
# What it does, in this order (each step only when it is not so already):
#   1. Checks that the workspace has the secret --secret (default KONFERSI_GITEA_READ) delivered as a file (Secrets & env): the upstream sync
#      reads it there. It never reads, writes or prints the value; when the name is missing it stops before any change (the coordinator
#      puts it in a set assigned to the workspace).
#   2. Adds --host to `ci.upstreamHosts` when that list is not empty. An empty list already allows any public host: adding one name would
#      narrow it for every other remote, so an empty list is left as it is.
#   3. For each module in the manifest (every string in it that is a URL of a repository under https://<host>/<org>/, or git@<host>:<org>/...):
#      creates the remote <module> in --workspace, makes it follow the module's https URL with the secret, syncs it (the first sight of a
#      branch is the baseline: it writes no note), checks --branch is in the mirror, then sets its Release report (Branch, --branch, --vault,
#      --folder). The report is set only after the sync, so day one writes no flood of notes.
#
# Exit: 0 all done (or, in a dry run, all planned); 1 a module failed (the others still ran); 2 bad arguments or no session; 3 the secret is
# missing (nothing changed).
set -euo pipefail

PORTAL=""
MANIFEST=""
WS="kubernetes/kohi-event"
VAULT="98af7d16def1"
BRANCH="stg"
FOLDER="Releases"
SECRET="KONFERSI_GITEA_READ"
HOST="git.konfersi.com"
ORG="platform"
COOKIE="portal_session"
APPLY=0

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "konfersi-release-remotes: $*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --portal) PORTAL=${2-}; shift 2 || die "--portal needs a value" ;;
    --manifest) MANIFEST=${2-}; shift 2 || die "--manifest needs a value" ;;
    --workspace) WS=${2-}; shift 2 || die "--workspace needs a value" ;;
    --vault) VAULT=${2-}; shift 2 || die "--vault needs a value" ;;
    --branch) BRANCH=${2-}; shift 2 || die "--branch needs a value" ;;
    --folder) FOLDER=${2-}; shift 2 || die "--folder needs a value" ;;
    --secret) SECRET=${2-}; shift 2 || die "--secret needs a value" ;;
    --host) HOST=${2-}; shift 2 || die "--host needs a value" ;;
    --org) ORG=${2-}; shift 2 || die "--org needs a value" ;;
    --cookie-name) COOKIE=${2-}; shift 2 || die "--cookie-name needs a value" ;;
    --apply) APPLY=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[[ $PORTAL =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "--portal must be http(s)://host[:port], nothing after it"
[ -n "$MANIFEST" ] && [ -r "$MANIFEST" ] || die "--manifest must name a readable file"
[[ $WS =~ ^[a-z]+/[A-Za-z0-9._-]+$ ]] || die "--workspace must be <target>/<name>"
[[ $VAULT =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die "--vault is not a vault id"
[[ $BRANCH =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || die "--branch is not a branch name"
[[ $FOLDER =~ ^[A-Za-z0-9._\ -]+(/[A-Za-z0-9._\ -]+)*$ ]] || die "--folder must be a folder without leading or trailing slash"
[[ $SECRET =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "--secret is not a Secrets & env name"
[[ $HOST =~ ^[a-z0-9.-]+$ ]] || die "--host is not a host name"
[[ $ORG =~ ^[A-Za-z0-9._-]+$ ]] || die "--org is not an organisation name"
[[ $COOKIE =~ ^[A-Za-z0-9_-]+$ ]] || die "--cookie-name is not a cookie name"
command -v jq >/dev/null && command -v curl >/dev/null || die "needs jq and curl"

SESSION=""
IFS= read -r SESSION || true
# Only the characters a session token has: nothing that could end the quoted curl config line or start another one.
[[ $SESSION =~ ^[A-Za-z0-9._~+/=-]{16,512}$ ]] || die "the first line of stdin must be the portal session (the $COOKIE cookie)"

enc() { jq -rn --arg v "$1" '$v|@uri'; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# api METHOD PATH [BODY]: the answer's `data` as one line of JSON; on an error a line on stderr (the status and the portal's message) and 1.
api() {
  local method=$1 path=$2 body=${3-} code
  local args=(-sS --max-time 120 -K - -o "$TMP/out" -w '%{http_code}' -X "$method" -H 'Accept: application/json')
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data-raw "$body")
  : >"$TMP/out"
  if ! code=$(printf 'header = "Cookie: %s=%s"\n' "$COOKIE" "$SESSION" | curl "${args[@]}" "$PORTAL$path" 2>"$TMP/err"); then
    echo "  $method $path: no answer ($(head -c 200 "$TMP/err"))" >&2
    return 1
  fi
  if [ "${code:0:1}" != 2 ]; then
    echo "  $method $path: HTTP $code: $(jq -r '.error.message // "no message"' "$TMP/out" 2>/dev/null | head -c 300)" >&2
    return 1
  fi
  jq -c '.data' "$TMP/out"
}

if [ "$APPLY" = 1 ]; then echo "mode: apply"; else echo "mode: dry run (nothing changes; --apply to apply)"; fi
echo "portal: $PORTAL  workspace: $WS  report: $BRANCH -> vault $VAULT, folder $FOLDER"

# --- The modules: every https://<host>/<org>/<repo> (or git@<host>:<org>/<repo>) string anywhere in the manifest, whatever its layout. ---
jq -r '.. | strings' "$MANIFEST" >"$TMP/strings" || die "--manifest is not JSON"
declare -A URL_OF=()
NAMES=()
while IFS= read -r s; do
  u=$s
  [[ $u == "git@$HOST:$ORG/"* ]] && u="https://$HOST/$ORG/${u#"git@$HOST:$ORG/"}"
  [[ $u == "https://$HOST/$ORG/"* ]] || continue
  u=${u%/}
  u=${u%.git}
  repo=${u#"https://$HOST/$ORG/"}
  [[ $repo =~ ^[A-Za-z0-9._-]+$ ]] || continue
  name=$(printf '%s' "$repo" | tr 'A-Z' 'a-z')
  [[ $name =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || { echo "skipped: $repo (not a remote name)"; continue; }
  [ -z "${URL_OF[$name]-}" ] || continue
  URL_OF[$name]=$u
  NAMES+=("$name")
done <"$TMP/strings"
[ "${#NAMES[@]}" -gt 0 ] || { echo "konfersi-release-remotes: no https://$HOST/$ORG/<repo> URL in $MANIFEST" >&2; exit 2; }
echo "modules: ${#NAMES[@]} (${NAMES[*]})"

# --- 1. The secret, by name only. ---
secrets=$(api GET "/api/workspaces/$WS/secrets") || exit 1
if ! jq -e --arg n "$SECRET" 'any(.sets[]; any(.files[]; . == $n) and (any((.needsValue // [])[]; . == $n) | not))' <<<"$secrets" >/dev/null; then
  echo "secret: $SECRET is not delivered to $WS as a file."
  echo "FOR THE COORDINATOR: put the read-only Gitea token in a Secrets & env set assigned to $WS as the secret $SECRET, then run this again."
  exit 3
fi
echo "secret: $SECRET is delivered (name only)"

# --- 2. The upstream hosts. ---
settings=$(api GET /api/settings) || exit 1
hosts=$(jq -r '.settings[] | select(.key == "ci.upstreamHosts") | .value // ""' <<<"$settings")
if [ -z "$(printf '%s' "$hosts" | tr -d ' ,')" ]; then
  echo "hosts: ci.upstreamHosts is empty (any public host): left as it is"
elif printf '%s' "$hosts" | tr ', ' '\n\n' | grep -qxF "$HOST"; then
  echo "hosts: $HOST is listed"
elif [ "$APPLY" = 1 ]; then
  api PUT /api/settings/ci.upstreamHosts "$(jq -cn --arg v "$hosts, $HOST" '{value: $v}')" >/dev/null || exit 1
  echo "hosts: added $HOST"
else
  echo "hosts: would add $HOST"
fi

# --- 3. The remotes. ---
repos=$(api GET "/api/ci/repos?workspace=$(enc "$WS")") || exit 1
want=$(jq -cn --arg b "$BRANCH" --arg v "$VAULT" --arg f "$FOLDER" '{kind: "branch", branch: $b, vaultId: $v, folder: $f}')
failed=0
for name in "${NAMES[@]}"; do
  url=${URL_OF[$name]}
  did=()
  repo=$(jq -c --arg n "$name" --arg w "$WS" '[.[] | select(.name == $n and .workspaceId == $w)][0] // null' <<<"$repos")
  if [ "$repo" = null ]; then
    if [ "$APPLY" = 0 ]; then
      echo "module $name remote (new): would create, follow $url, sync, set the report"
      continue
    fi
    repo=$(api POST /api/ci/repos "$(jq -cn --arg w "$WS" --arg n "$name" --arg b "$BRANCH" '{workspaceId: $w, name: $n, defaultBranch: $b}')") || { failed=1; continue; }
    did+=(created)
  fi
  id=$(jq -r '.id' <<<"$repo")
  rid=$(enc "$id")
  follows=$(jq -r --arg u "$url" --arg s "$SECRET" 'if .upstream != null and .upstream.url == $u and .upstream.secret == $s then "yes" else "no" end' <<<"$repo")
  synced=no
  if [ "$follows" = no ]; then
    if [ "$APPLY" = 1 ]; then
      api PATCH "/api/ci/repos/$rid" "$(jq -cn --arg u "$url" --arg s "$SECRET" '{upstream: {url: $u, secret: $s}}')" >/dev/null || { failed=1; echo "module $name remote $id: FAILED to follow $url"; continue; }
      did+=(follows)
    else
      did+=("would follow $url")
    fi
  fi
  tip=""
  if [ "$APPLY" = 1 ]; then
    branches=$(api GET "/api/ci/repos/$rid/branches") || { failed=1; continue; }
    tip=$(jq -r --arg b "$BRANCH" '[.[] | select(.name == $b)][0].sha // ""' <<<"$branches")
    if [ "$follows" = no ] || [ -z "$tip" ]; then
      sync=$(api POST "/api/ci/repos/$rid/sync") || { failed=1; echo "module $name remote $id: FAILED to sync"; continue; }
      err=$(jq -r '.repo.upstream.error // ""' <<<"$sync")
      [ -z "$err" ] || echo "  sync of $name: $(printf '%s' "$err" | head -c 200)"
      synced=yes
      did+=(synced)
      branches=$(api GET "/api/ci/repos/$rid/branches") || { failed=1; continue; }
      tip=$(jq -r --arg b "$BRANCH" '[.[] | select(.name == $b)][0].sha // ""' <<<"$branches")
    fi
    if [ -z "$tip" ]; then
      failed=1
      echo "module $name remote $id: ${did[*]:-as it is}; FAILED: $BRANCH is not in the mirror, so its report is not set"
      continue
    fi
  fi
  cur=$(api GET "/api/ci/repos/$rid/release-report") || { failed=1; continue; }
  if ! jq -e --argjson w "$want" '. == $w' <<<"$cur" >/dev/null; then
    if [ "$APPLY" = 1 ]; then
      api PUT "/api/ci/repos/$rid/release-report" "$(jq -cn --argjson s "$want" '{setting: $s}')" >/dev/null || { failed=1; echo "module $name remote $id: FAILED to set the report"; continue; }
      did+=(report)
    else
      did+=("would set the report")
    fi
  fi
  line="module $name remote $id: ${did[*]:-as it is}"
  [ -z "$tip" ] || line+="; $BRANCH ${tip:0:7}"
  [ "$synced" = no ] || line+=" (baseline)"
  echo "$line"
done

if [ "$failed" = 1 ]; then echo "done, with failures (above)"; exit 1; fi
echo "done"
