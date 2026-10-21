#!/usr/bin/env bash
# An image built in the cluster from any repository's Dockerfile and pushed (T-141): there is no Docker daemon in the workspace pod and by
# D-5 there will not be one, so the build is a kaniko Job (deploy/k3s-build/image-build-job.yaml) on a node without a workspace pod.
#   scripts/image-build.sh --repo claudepilot|<org>/<repo>|konfersi:<org>/<repo> --ref <branch, tag or full commit> --dockerfile <path>
#       --destination <registry/path:tag> [--context <dir>] [--build-arg K=V]... [--timeout <s>] [--credential-stdin] [--role <label>]
#     --repo           claudepilot and <org>/<repo> come from GitHub (public, no credential), konfersi:<org>/<repo> from Gitea (the token
#                      from git's credential helper, as scripts/job-run.sh)
#     --ref            must be on the remote (push it first); a commit is the full 40 characters
#     --dockerfile     the Dockerfile's path in the repository; --context the build folder in the repository (default the root)
#     --destination    <host>[:port]/<path>:<tag>; registry.int.isnan.me is pushed through the in-cluster service (no credential)
#     --build-arg      K=V, repeatable; NOT for secrets (they are in the Job's spec): letters, digits and _.,:/@+=- only
#     --timeout        the Job's deadline once it runs (default and most 3600)
#     --credential-stdin   the destination's credential is ONE JSON line on stdin: {"username":"...","password":"..."}
#   scripts/image-build.sh --check --destination <registry/path:tag> [--credential-stdin]
#                    does the tag exist (manifest HEAD, with the credential)? exit 0 yes (prints the digest), 3 no, 1 could not tell
#   scripts/image-build.sh --list | --stop [<job> | --chat <id>]
# One build at a time cluster-wide (IMAGE_BUILD_MAX, default 1): a Job over the cap is created suspended and waits its turn ("queued behind
# K"). The Job stops when this script is interrupted or killed (the next run removes one whose script is gone) and when the chat ends
# (CLAUDE_PID or IMAGE_BUILD_WATCH_PID exits). The credential reaches kubectl on stdin into a Secret that belongs to the Job and is deleted
# on exit; never on a command line; the streamed log is masked for it and the whole log searched for it before the script says clean.
# Exit 0 only when the image is pushed (the tag is read back), last line DIGEST=sha256:<hex>; 1 the build failed, 2 a usage error,
# 124 past the deadline. The whole log: IMAGE_BUILD_LOG (default /tmp/image-build-<job>.log).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
ns=${IMAGE_BUILD_NAMESPACE:-isnan-claudepilot}; registry=${DEPLOY_REGISTRY:-registry.int.isnan.me}
internal_push=${IMAGE_BUILD_INTERNAL_PUSH:-registry.isnan-registry.svc.cluster.local:5000}
max=${IMAGE_BUILD_MAX:-1}; poll=${IMAGE_BUILD_POLL_S:-5}
queue_wait=${IMAGE_BUILD_QUEUE_WAIT_S:-7200}; start_wait=${IMAGE_BUILD_START_WAIT_S:-900}
gitea=${IMAGE_BUILD_GITEA:-git.konfersi.com}; github_repo=alfianisnan26/claudepilot
gitea_base=${IMAGE_BUILD_GITEA_BASE:-https://$gitea}; github_base=${IMAGE_BUILD_GITHUB_BASE:-https://github.com}
die() { echo "image-build: $*" >&2; exit 2; }
[[ $max =~ ^[0-9]+$ ]] || die "IMAGE_BUILD_MAX is a number"
label() { local v; v=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9.-' '-' | cut -c1-63 | sed -E 's/^[^a-z0-9]+//; s/[^a-z0-9]+$//'); printf '%s' "${v:-none}"; }
jobs_json() { kubectl -n "$ns" get jobs -l app=claudepilot-image-build -o json 2>/dev/null; }
stop_one() {
  kubectl -n "$ns" delete job "$1" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl -n "$ns" delete secret "$1" --ignore-not-found >/dev/null 2>&1 || true
}
JQ_FIN='def fin: ([(.status.conditions // [])[] | select((.type == "Complete" or .type == "Failed") and .status == "True")] | length > 0) or ((.status.succeeded // 0) > 0) or ((.status.failed // 0) > 0);'

case "${1:-}" in
  --list)
    jobs_json | jq -r "$JQ_FIN"' .items[] | [.metadata.name, (.metadata.labels["image-build/chat"] // "-"), (.metadata.annotations["image-build/destination"] // "-"),
      (if fin then (if (.status.succeeded // 0) > 0 then "succeeded" else "failed" end) elif .spec.suspend then "queued" else "running" end),
      .metadata.creationTimestamp] | @tsv' | grep . || echo "no image-build jobs"
    exit 0 ;;
  --stop)
    sel=; chat=
    if [ "${2:-}" = --chat ]; then chat=$(label "${3:?usage: image-build.sh --stop --chat <id>}"); else sel=${2:-}; fi
    [ -z "$sel" ] || [[ $sel =~ ^claudepilot-image-build-[0-9a-f]{8}$ ]] || die "usage: image-build.sh --stop [claudepilot-image-build-<hex> | --chat <id>]"
    n=0
    for name in $(jobs_json | jq -r --arg c "$chat" '.items[] | select($c == "" or .metadata.labels["image-build/chat"] == $c) | .metadata.name' | grep -E '^claudepilot-image-build-[0-9a-f]{8}$' || true); do
      [ -z "$sel" ] || [ "$name" = "$sel" ] || continue
      stop_one "$name"; echo "stopped $name"; n=$((n + 1))
    done
    echo "$n job(s) stopped"; exit 0 ;;
esac

check=0; repo=; ref=; dockerfile=; context=.; dest=; timeout=3600; role=${PILOT_AGENT:-agent}; cred_stdin=0; bargs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --repo|--ref|--dockerfile|--context|--destination|--build-arg|--timeout|--role) [ $# -ge 2 ] || die "$1 needs a value" ;;&
    --check) check=1; shift ;;
    --credential-stdin) cred_stdin=1; shift ;;
    --repo) repo=$2; shift 2 ;;
    --ref) ref=$2; shift 2 ;;
    --dockerfile) dockerfile=$2; shift 2 ;;
    --context) context=$2; shift 2 ;;
    --destination) dest=$2; shift 2 ;;
    --build-arg) bargs+=("$2"); shift 2 ;;
    --timeout) timeout=$2; shift 2 ;;
    --role) role=$2; shift 2 ;;
    *) die "unknown option $1 (see the top of scripts/image-build.sh)" ;;
  esac
done

# The destination: <host>[:port]/<path>:<tag>, nothing a shell, sed or YAML could read as more than a name.
[ -n "$dest" ] || die "--destination <registry>/<path>:<tag> is required"
[[ $dest =~ ^([a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?)/([a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*):([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$ ]] \
  || die "--destination: <host>[:port]/<path>:<tag> in lower case, no spaces or shell characters (got $dest)"
dhost=${BASH_REMATCH[1]}; dpath=${BASH_REMATCH[4]}; dtag=${BASH_REMATCH[8]}
[[ $dhost == *.* || $dhost == *:* || $dhost == localhost ]] || die "--destination: name the registry host first (got $dhost)"

# The credential: one JSON line on stdin, read by the builtin (nothing on a command line), checked by jq reading stdin.
cred=; auth=; pass_mask=
if [ "$cred_stdin" = 1 ]; then
  IFS= read -r cred || [ -n "$cred" ] || die "--credential-stdin: no line on stdin"
  printf '%s' "$cred" | jq -e 'type == "object" and (.username | type == "string" and length > 0) and (.password | type == "string" and length > 0)
    and ((.username + .password) | test("[[:cntrl:]\"\\\\]") | not)' >/dev/null 2>&1 \
    || die "--credential-stdin: one JSON line {\"username\":\"...\",\"password\":\"...\"} (no quotes, backslashes or control characters in them)"
  pass_mask=$(printf '%s' "$cred" | jq -r .password); auth=$(printf '%s' "$cred" | jq -r '"\(.username):\(.password)" | @base64')
fi

# The registry's API: https, or http for a host named in IMAGE_BUILD_INSECURE_HOSTS (the tests' local registry). docker.io's API host differs.
api_host=$dhost; [ "$dhost" != docker.io ] || { api_host="registry-1.docker.io"; [[ $dpath == */* ]] || dpath=library/$dpath; }
scheme=https; for h in ${IMAGE_BUILD_INSECURE_HOSTS:-}; do [ "$h" != "$dhost" ] || scheme=http; done
ACCEPT='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'
# curl reads its options (the credential, a bearer token) from stdin: -K -; nothing secret is an argument.
curl_k() { curl -sS --max-time 30 -K - "$@"; }
# shellcheck disable=SC2329,SC2317 # used below
manifest_head() { # <bearer or ""> -> the response headers on stdout
  { [ -z "$auth" ] || [ -n "$1" ] || printf 'header = "Authorization: Basic %s"\n' "$auth"
    [ -z "$1" ] || printf 'header = "Authorization: Bearer %s"\n' "$1"
    printf 'header = "Accept: %s"\n' "$ACCEPT"; } | curl_k -o /dev/null -D - -I "$scheme://$api_host/v2/$dpath/manifests/$dtag" 2>/dev/null || true
}
tag_digest() { # prints the digest and returns 0 if the tag is there, 3 if not, 1 when it cannot tell
  local h code www realm service scope tok
  h=$(manifest_head ""); code=$(printf '%s\n' "$h" | awk 'toupper($1) ~ /^HTTP\// { c = $2 } END { print c }')
  if [ "$code" = 401 ]; then
    www=$(printf '%s\n' "$h" | tr -d '\r' | sed -n 's/^[Ww][Ww][Ww]-[Aa]uthenticate: *[Bb]earer //p' | head -n 1)
    realm=$(printf '%s' "$www" | sed -n 's/.*realm="\([^"]*\)".*/\1/p'); service=$(printf '%s' "$www" | sed -n 's/.*service="\([^"]*\)".*/\1/p')
    scope=$(printf '%s' "$www" | sed -n 's/.*scope="\([^"]*\)".*/\1/p'); [ -n "$scope" ] || scope="repository:$dpath:pull"
    [[ $realm =~ ^https?://[A-Za-z0-9.:/_-]+$ ]] || { echo "image-build: $dhost wants a login it does not describe (401)" >&2; return 1; }
    tok=$({ [ -z "$auth" ] || printf 'header = "Authorization: Basic %s"\n' "$auth"; } | curl_k -G --data-urlencode "service=$service" --data-urlencode "scope=$scope" "$realm" 2>/dev/null | jq -r '.token // .access_token // empty' 2>/dev/null || true)
    [ -n "$tok" ] || { echo "image-build: $dhost refused the credential (401)" >&2; return 1; }
    h=$(manifest_head "$tok"); unset tok
    code=$(printf '%s\n' "$h" | awk 'toupper($1) ~ /^HTTP\// { c = $2 } END { print c }')
  fi
  case "$code" in
    200) printf '%s\n' "$h" | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p' | head -n 1; return 0 ;;
    404) return 3 ;;
    *) echo "image-build: $dhost answered ${code:-nothing} for $dpath:$dtag" >&2; return 1 ;;
  esac
}

if [ "$check" = 1 ]; then
  rc=0; d=$(tag_digest) || rc=$?
  case "$rc" in
    0) echo "image-build: $dest exists${d:+ ($d)}"; [ -z "$d" ] || echo "DIGEST=$d" ;;
    3) echo "image-build: $dest does not exist" ;;
  esac
  exit "$rc"
fi

# The build's own arguments.
[ -n "$repo" ] || die "--repo: claudepilot, <org>/<repo> (GitHub) or konfersi:<org>/<repo> (Gitea)"
[ -n "$ref" ] || die "--ref: the pushed branch, tag or full commit to build"
[ -n "$dockerfile" ] || die "--dockerfile: the Dockerfile's path in the repository"
inrepo() { [[ $1 =~ ^[A-Za-z0-9_.][A-Za-z0-9_./-]*$ && ! $1 =~ (^|/)\.\.(/|$) && $1 != /* ]]; }
inrepo "$dockerfile" || die "--dockerfile: a path inside the repository (got $dockerfile)"
inrepo "$context" || die "--context: a folder inside the repository (got $context)"
{ [[ $timeout =~ ^[0-9]+$ ]] && [ "$timeout" -ge 60 ] && [ "$timeout" -le 3600 ]; } || die "--timeout: 60 to 3600 seconds"
extra=()
for a in ${bargs[@]+"${bargs[@]}"}; do
  [[ $a =~ ^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.,:/@+=-]*$ ]] || die "--build-arg K=V: letters, digits and _.,:/@+=- only, and never a secret (got ${a%%=*}=...)"
  extra+=("--build-arg=$a")
done
case "$repo" in
  claudepilot) kind=github; path=$github_repo ;;
  konfersi:*) kind=gitea; path=${repo#konfersi:} ;;
  *) kind=github; path=$repo ;;
esac
[[ $path =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && ! $path =~ \.\. ]] || die "--repo: claudepilot, <org>/<repo> or konfersi:<org>/<repo> (got $repo)"
if [ "$kind" = gitea ]; then url=$gitea_base/$path.git; else url=$github_base/$path.git; fi
repo_label=$(label "${path#*/}")
[[ $ref =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ && ! $ref =~ \.\. ]] || die "--ref: a branch, tag or commit name (got $ref)"
# The ref must be on the remote: a branch or tag is looked up there (git's own credential helper for Gitea); a commit must be the full sha.
if [[ ! $ref =~ ^[0-9a-f]{40}$ ]] && ! GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "$url" "$ref" >/dev/null 2>&1; then
  [[ ! $ref =~ ^[0-9a-f]{7,39}$ ]] || die "--ref: a commit is the full 40 characters (got $ref)"
  die "--ref: $ref is not on $repo's remote: push it first"
fi
# The push target: the internal registry through its in-cluster service (the ingress cuts a request at 60 s), anything else as named.
push=$dest; [ "$dhost" != "$registry" ] || { push=$internal_push/$dpath:$dtag; extra+=(--insecure); }
push_host=${push%%/*}
chat=$(label "${PILOT_SESSION_ID:-manual}"); role=$(label "$role")
image=${IMAGE_BUILD_CLONE_IMAGE:-}
if [ -z "$image" ]; then
  # T-1982: the registry directly (the pod, a host whose DNS knows it); when that fails (the coordinator's Mac devcontainer: "Could not resolve
  # host"), the cluster answers through kubectl's own route (its SOCKS tunnel there): the API server proxies the registry's in-cluster service,
  # so this host needs neither its DNS nor a route to it. The fallback is for the internal registry only (DEPLOY_REGISTRY unset or the same).
  tags=$(curl -fsS --connect-timeout 10 -m 30 "https://$registry/v2/claudepilot/workspace/tags/list" 2>/dev/null) || tags=
  if [ -z "$tags" ] && [ "$registry" = registry.int.isnan.me ]; then
    echo "image-build: $registry did not answer from here: asking the cluster for the workspace image" >&2
    tags=$(kubectl get --raw /api/v1/namespaces/isnan-registry/services/registry:5000/proxy/v2/claudepilot/workspace/tags/list 2>/dev/null) || tags=
  fi
  tag=$(printf '%s' "$tags" | jq -r '.tags[]? | select(test("-dev-"))' 2>/dev/null | sort -V | tail -n 1) || tag=
  [ -n "$tag" ] || { echo "image-build: no development workspace image in $registry: set IMAGE_BUILD_CLONE_IMAGE" >&2; exit 1; }
  image=$registry/claudepilot/workspace:$tag
fi
[[ $image =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || die "IMAGE_BUILD_CLONE_IMAGE: an image reference"

# Who owns a Job: this host, this script's PID and its start time. A Job whose script is gone (killed before its trap ran) is removed here.
starttime() { sed -E 's/.*\) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20; }
host=$(hostname)
reap() {
  local name owner pid start
  jobs_json | jq -r "$JQ_FIN"' .items[] | select(fin | not) | [.metadata.name, (.metadata.annotations["image-build/owner"] // "")] | @tsv' 2>/dev/null |
  while IFS=$'\t' read -r name owner; do
    [[ $name =~ ^claudepilot-image-build-[0-9a-f]{8}$ && $owner == "$host"/* ]] || continue
    pid=$(cut -d/ -f2 <<<"$owner"); start=$(cut -d/ -f3 <<<"$owner")
    [ -n "$pid" ] && [ "$(starttime "$pid")" = "$start" ] && continue
    stop_one "$name"; echo "image-build: removed $name (its image-build.sh is gone)" >&2
  done
}
reap || true

job=claudepilot-image-build-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
log=${IMAGE_BUILD_LOG:-/tmp/image-build-$job.log}
work=$(mktemp -d "${TMPDIR:-/tmp}/cp-image-build-XXXXXX")
phase=setup; wd=
# shellcheck disable=SC2317,SC2329 # called by the traps
on_exit() {
  [ -z "$wd" ] || kill "$wd" 2>/dev/null || true
  if [ "$phase" = finished ]; then kubectl -n "$ns" delete secret "$job" --ignore-not-found >/dev/null 2>&1 || true; else stop_one "$job"; fi
  rm -rf "$work"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

# The Secret, made by jq from stdin (the credential lines) and given to kubectl on stdin: the docker config.json for the push host and Gitea's token.
gu=; gt=
if [ "$kind" = gitea ]; then
  creds=$(printf 'protocol=https\nhost=%s\n\n' "$gitea" | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null || true)
  gu=$(printf '%s\n' "$creds" | sed -n 's/^username=//p'); gt=$(printf '%s\n' "$creds" | sed -n 's/^password=//p'); unset creds
  [ -n "$gt" ] || die "no credential for $gitea in git's credential helper"
fi
# shellcheck disable=SC2016 # jq's own variables
printf '%s\n%s\n%s\n' "$auth" "${gu:-git}" "$gt" | jq -nRc --arg name "$job" --arg ns "$ns" --arg host "$push_host" --arg chat "$chat" '
  input as $auth | input as $gu | input as $gt
  | {apiVersion: "v1", kind: "Secret", metadata: {name: $name, namespace: $ns, labels: {app: "claudepilot-image-build", "image-build/chat": $chat}}, type: "Opaque",
     stringData: ({"config.json": ({auths: (if $auth == "" then {} else {($host): {auth: $auth}} end)} | tojson)}
       + (if $gt == "" then {} else {"git-user": $gu, "git-token": $gt} end))}' | kubectl -n "$ns" create -f - >/dev/null
mask_git=$gt; unset gt gu cred
# The manifest: every placeholder validated above; kaniko's extra arguments (build args, --insecure) are one quoted list item each.
extra_yaml=$(for e in ${extra[@]+"${extra[@]}"}; do printf '            - "%s"\\n' "$e"; done)
sed -e "s#__NAME__#$job#g" -e "s#__CHAT__#$chat#g" -e "s#__ROLE__#$role#g" -e "s#__REPO__#$repo_label#g" -e "s#__OWNER__#$host/$$/$(starttime $$)#" \
    -e "s#__DEST__#$dest#g" -e "s#__PUSH__#$push#" -e "s#__DEADLINE__#$timeout#" -e "s#__IMAGE__#$image#" -e "s#__REPO_URL__#$url#" -e "s#__REF__#$ref#" \
    -e "s#__DOCKERFILE__#$dockerfile#g" -e "s#__CONTEXT__#$context#g" -e "s#^            - __KANIKO_EXTRA__\$#${extra_yaml%\\n}#" \
    "$here/deploy/k3s-build/image-build-job.yaml" | sed '/^$/d' | kubectl apply -f - >/dev/null
# The Secret belongs to the Job: whoever deletes the Job (its TTL, --stop, a person) deletes the credential with it.
uid=$(kubectl -n "$ns" get job "$job" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
if [ -n "$uid" ]; then
  kubectl -n "$ns" patch secret "$job" --type merge -p "{\"metadata\":{\"ownerReferences\":[{\"apiVersion\":\"batch/v1\",\"kind\":\"Job\",\"name\":\"$job\",\"uid\":\"$uid\"}]}}" >/dev/null || true
fi
watch=${IMAGE_BUILD_WATCH_PID:-${CLAUDE_PID:-}}
if [ -n "$watch" ] && [ "$watch" != none ] && kill -0 "$watch" 2>/dev/null; then
  ( while kill -0 "$watch" 2>/dev/null; do sleep "$poll"; done
    echo "image-build: the chat ended (process $watch): stopping $job" >&2; stop_one "$job"; kill -TERM $$ 2>/dev/null ) &
  wd=$!
fi
t0=$(date +%s)
shown=$ref; [[ ! $ref =~ ^[0-9a-f]{40}$ ]] || shown=${ref:0:12}
echo "image-build: $job: $repo@$shown $dockerfile (context $context) -> $dest"

# The queue: unfinished Jobs in creation order; mine goes when fewer than max run and none queued before it.
# shellcheck disable=SC2016 # jq's own variables
QUEUE_JQ="$JQ_FIN"'
def key: [.metadata.creationTimestamp, .metadata.name];
([.items[] | select(.metadata.deletionTimestamp == null and (fin | not))] | sort_by(key)) as $q
| ([$q[] | select(.metadata.name == $me)] | first) as $mine
| if $mine == null then "gone"
  elif $mine.spec.suspend != true then "go"
  else ([$q[] | select(.spec.suspend != true)] | length) as $run
    | ([$q[] | select(.spec.suspend == true and (key < ($mine | key)))] | length) as $ahead
    | if $run + $ahead < $max then "go" else "wait \($run + $ahead)" end
  end'
last=
while :; do
  d=$(jobs_json | jq -r --arg me "$job" --argjson max "$max" "$QUEUE_JQ" 2>/dev/null || true)
  case "$d" in
    go) break ;;
    gone) echo "image-build: $job was stopped while queued" >&2; exit 1 ;;
    wait\ *) [ "$d" = "$last" ] || echo "image-build: queued behind ${d#wait } (at most $max build(s) at once)"; last=$d ;;
  esac
  [ $(( $(date +%s) - t0 )) -lt "$queue_wait" ] || { echo "image-build: still queued after ${queue_wait}s: giving up" >&2; exit 1; }
  sleep "$poll"
done
kubectl -n "$ns" patch job "$job" --type merge -p '{"spec":{"suspend":false}}' >/dev/null
t1=$(date +%s); phase=running
job_state() { # Complete, Failed:<reason>, gone, or nothing while it runs
  kubectl -n "$ns" get job "$job" -o json 2>/dev/null | jq -r '[(.status.conditions // [])[] | select((.type == "Complete" or .type == "Failed") and .status == "True") | if .type == "Failed" then "Failed:\(.reason // "")" else .type end] | first // ""' 2>/dev/null || echo gone
}
# A container's state: waiting, running, terminated, or nothing before the pod is there.
cstate() { kubectl -n "$ns" get pods -l "job-name=$job" -o json 2>/dev/null | jq -r --arg c "$1" '[.items[0].status | ((.initContainerStatuses // []) + (.containerStatuses // []))[] | select(.name == $c) | .state | keys[0]] | first // ""' 2>/dev/null || true; }
wait_for() { # <container>: until it runs or ended, or the Job ended
  while :; do
    case "$(cstate "$1")" in running|terminated) return 0 ;; esac
    [ -z "$(job_state)" ] || return 1
    [ $(( $(date +%s) - t1 )) -lt "$start_wait" ] || { echo "image-build: $1 did not start in ${start_wait}s" >&2; return 1; }
    sleep "$poll"
  done
}

# The log: streamed, masked for the credentials (the password, the base64 auth, Gitea's token); a leak is noted, never shown.
# shellcheck disable=SC2016 # awk's own variables
FILTER='BEGIN { n = split(ENVIRON["IB_MASKS"], m, "\n"); lf = ENVIRON["IB_LOG"] }
{ line = $0
  for (k = 1; k <= n; k++) if (length(m[k]) >= 6) while ((i = index(line, m[k])) > 0) { line = substr(line, 1, i - 1) "[redacted]" substr(line, i + length(m[k])); leak = 1 }
  if (lf != "") { print line; print line >> lf; fflush() } }
END { if (leak) print "leak" >> ENVIRON["IB_N"] }'
masks=$(printf '%s\n%s\n%s' "$pass_mask" "$auth" "$mask_git")
filter() { IB_MASKS=$masks IB_LOG=${1-$log} IB_N=$work/n awk "$FILTER"; }
: > "$log"
if wait_for clone; then
  kubectl -n "$ns" logs -f "job/$job" -c clone 2>&1 | filter || true
  if wait_for kaniko; then kubectl -n "$ns" logs -f "job/$job" -c kaniko 2>&1 | filter || true; fi
fi
st=
while :; do st=$(job_state); if [ -n "$st" ] || [ $(( $(date +%s) - t1 )) -ge $(( timeout + start_wait )) ]; then break; fi; sleep "$poll"; done
phase=finished
# The whole log once more, searched (not shown) for the credentials before the script says it is clean.
for c in clone kaniko; do kubectl -n "$ns" logs "job/$job" -c "$c" 2>/dev/null | filter "" || true; done
if grep -qx leak "$work/n" 2>/dev/null; then clean="WARNING: a credential was in the build log (masked in the output and in $log)"; else clean="credential in the build log: none"; fi
node=$(kubectl -n "$ns" get pods -l "job-name=$job" -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null || true)
digest=$(kubectl -n "$ns" get pods -l "job-name=$job" -o json 2>/dev/null | jq -r '[.items[0].status.containerStatuses[]? | select(.name == "kaniko") | .state.terminated.message // empty] | first // ""' 2>/dev/null | tr -d '[:space:]' || true)
t2=$(date +%s)
echo "image-build: $clean"
rc=1
case "$st" in
  Complete)
    if [[ ! $digest =~ ^sha256:[0-9a-f]{64}$ ]]; then echo "image-build: the build ended without a digest" >&2
    else
      crc=0; got=$(tag_digest) || crc=$?
      if [ "$crc" = 0 ]; then rc=0; [ -z "$got" ] || [ "$got" = "$digest" ] || echo "image-build: note: $dest now reads $got (kaniko pushed $digest)" >&2
      else echo "image-build: kaniko says pushed, but $dest is not readable (rc=$crc)" >&2; fi
    fi ;;
  Failed:DeadlineExceeded) rc=124; echo "image-build: past the deadline (${timeout}s)" >&2 ;;
  '') echo "image-build: the Job did not finish" >&2; phase=setup ;;
  *) echo "image-build: the build failed ($st)" >&2 ;;
esac
echo "image-build: $job rc=$rc in $((t2 - t1))s (queued $((t1 - t0))s) on ${node:-?}; log: $log"
[ "$rc" != 0 ] || echo "DIGEST=$digest"
exit "$rc"
