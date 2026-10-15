#!/usr/bin/env bash
# Heavy agent work as a Job in the cluster, not in the development pod (T-107): a test file, the suite, tsc, a build, playwright, lighthouse,
# a wrangler dry run. The code is a PUSHED branch or commit (ClaudePilot from GitHub, a Konfersi repository from Gitea), cloned into memory on
# a node without a workspace pod (deploy/k3s-build/job-run.yaml), `npm ci`, then the command. The log streams back, the exit code is the
# command's, artifacts come back to a folder you name.
#   scripts/job-run.sh [options] -- <command>          one argument: a shell command line; several: the words of one command
#     --repo claudepilot | event | konfersi[:<org>/<repo>]
#                                                       default: from the current folder's origin (konfersi alone: the folder's Gitea repo).
#                                                       event (T-491) is exactly GitHub isnanme/event, nothing else: no event:<org>/<repo>;
#                                                       it gets the same GitHub token as claudepilot (npm for @isnanme, and the clone). Git offers it
#                                                       for that one URL only, but the token is also in the command's environment as
#                                                       NODE_AUTH_TOKEN (the command and npm install scripts can read it), as in every claudepilot
#                                                       Job; --also is refused with it
#     --ref <branch or commit>                          default: HEAD of the current folder, which must be on the remote (push it first:
#                                                       git push origin HEAD:wip/<name>); uncommitted changes are NOT in the Job
#     --against <ref>                                   PROOF (T-333): run the command on --ref, then on <ref> in the same Job (a full commit hash or
#                                                       branch; the parent of a fix: git rev-parse <fix>~1). npm ci again only when the lockfile
#                                                       differs. Prints "PROOF: passes on <ref>, fails on <against>" (exit 0) or "NO PROOF: <why>"
#                                                       (exit 1; 2 when <ref> or a kept path is missing). Without it nothing changes.
#     --keep-tests <paths>                              with --against: these files (comma separated) are taken from --ref onto the other ref
#     --also <org>/<repo>[@<ref>]                     one more repository cloned next to it (Konfersi's file:../konfersi-shared), ref stg
#     --steps npm-ci|none                               before the command (default npm-ci, at the root of the repository and of each --also clone that has a package-lock.json)
#     --artifacts <paths>  --out <dir>                  files in the repository (comma separated) copied back into <dir> (default
#                                                       ./job-run-artifacts/<job>); at most JOB_RUN_ARTIFACT_MAX bytes compressed (4 MiB)
#     --timeout <s>                                     the Job's deadline once it runs (default 3600, at most 5400)
#     --role <label>                                    shown on the Job (default PILOT_AGENT or "agent"); the chat is PILOT_SESSION_ID
#     --big                                             8Gi of memory instead of 4Gi (T-524; /tmp 4Gi instead of 2Gi), for a run that was OOMKilled;
#                                                       only k3s-node2 has room for it. Memory is requested = limited: the scheduler places a Job
#                                                       only where it fits, says why it is Pending, and an OOMKilled Job says so with its limit.
#   scripts/job-run.sh --list                           the Jobs, their chat, role and state
#   scripts/job-run.sh --stop [<job> | --chat <id>]     stop Jobs (all, one, or a chat's) and delete their Secrets
# Caps: JOB_RUN_MAX Jobs at once cluster-wide (default 3), JOB_RUN_MAX_PER_CHAT per chat (2) and JOB_RUN_MAX_PER_PROGRAM per program (2;
# claudepilot, event, konfersi: T-524). A Job over a cap is created suspended and waits its turn (creation order), with "queued behind K". The Job stops when this script is interrupted or killed (the next run removes a Job whose
# script is gone), and when the chat ends (the Claude process, CLAUDE_PID or JOB_RUN_WATCH_PID, exits).
# A failed `npm ci` in the Job is tried once more (it says so in the log). Exit 0 of a proof means the proof held, not only the command.
# Credentials (the npm token for GitHub Packages, Gitea's from git's credential helper) go to kubectl on stdin into a Secret that belongs to
# the Job and is deleted on exit; they are never on a command line, and the streamed log is masked for them. The whole log: JOB_RUN_LOG
# (default /tmp/job-run-<job>.log). Exit: the command's code; 1 when the Job did not finish, 2 for a usage error, 124 past the deadline.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
ns=${JOB_RUN_NAMESPACE:-isnan-claudepilot}; registry=${DEPLOY_REGISTRY:-registry.int.isnan.me}
max=${JOB_RUN_MAX:-3}; per=${JOB_RUN_MAX_PER_CHAT:-2}; pprog=${JOB_RUN_MAX_PER_PROGRAM:-2}; poll=${JOB_RUN_POLL_S:-5}
queue_wait=${JOB_RUN_QUEUE_WAIT_S:-3600}; start_wait=${JOB_RUN_START_WAIT_S:-900}; art_max=${JOB_RUN_ARTIFACT_MAX:-4194304}
gitea=${JOB_RUN_GITEA:-git.konfersi.com}; github_repo=${JOB_RUN_GITHUB_REPO:-alfianisnan26/claudepilot}
event_repo=isnanme/event # fixed on purpose (T-491): the door names one repository, no override
# Memory per Job (T-524), request = limit, sized from measured cgroup peaks (docs/dev-session.md, "Heavy agent work in the cluster"); fixed here,
# no environment override: the size is a cluster decision, not a caller's.
mem_std=4Gi; tmp_std=2Gi; mem_big=8Gi; tmp_big=4Gi
die() { echo "job-run: $*" >&2; exit 2; }
for n in "$max" "$per" "$pprog" "$art_max"; do [[ $n =~ ^[0-9]+$ ]] || die "the caps are numbers"; done
label() { local v; v=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9.-' '-' | cut -c1-63 | sed -E 's/^[^a-z0-9]+//; s/[^a-z0-9]+$//'); printf '%s' "${v:-none}"; }
jobs_json() { kubectl -n "$ns" get jobs -l app=claudepilot-job-run -o json 2>/dev/null; }
stop_one() {
  kubectl -n "$ns" delete job "$1" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl -n "$ns" delete secret "$1" --ignore-not-found >/dev/null 2>&1 || true
}
JQ_FIN='def fin: ([(.status.conditions // [])[] | select((.type == "Complete" or .type == "Failed") and .status == "True")] | length > 0) or ((.status.succeeded // 0) > 0) or ((.status.failed // 0) > 0);'

case "${1:-}" in
  --list)
    jobs_json | jq -r "$JQ_FIN"' .items[] | [.metadata.name, (.metadata.labels["job-run/chat"] // "-"), (.metadata.labels["job-run/role"] // "-"),
      (if fin then (if (.status.succeeded // 0) > 0 then "succeeded" else "failed" end) elif .spec.suspend then "queued" else "running" end),
      .metadata.creationTimestamp] | @tsv' | grep . || echo "no job-run jobs"
    exit 0 ;;
  --stop)
    sel=; chat=
    if [ "${2:-}" = --chat ]; then chat=$(label "${3:?usage: job-run.sh --stop --chat <id>}"); else sel=${2:-}; fi
    [ -z "$sel" ] || [[ $sel =~ ^claudepilot-job-[0-9a-f]{8}$ ]] || die "usage: job-run.sh --stop [claudepilot-job-<hex> | --chat <id>]"
    n=0
    for name in $(jobs_json | jq -r --arg c "$chat" '.items[] | select($c == "" or .metadata.labels["job-run/chat"] == $c) | .metadata.name' | grep -E '^claudepilot-job-[0-9a-f]{8}$' || true); do
      [ -z "$sel" ] || [ "$name" = "$sel" ] || continue
      stop_one "$name"; echo "stopped $name"; n=$((n + 1))
    done
    echo "$n job(s) stopped"; exit 0 ;;
esac

repo=; ref=; against=; keep=; steps=npm-ci; artifacts=; out=; timeout=3600; role=${PILOT_AGENT:-agent}; also=(); big=
while [ $# -gt 0 ]; do
  case "$1" in
    --repo|--ref|--against|--keep-tests|--also|--steps|--artifacts|--out|--timeout|--role) [ $# -ge 2 ] || die "$1 needs a value" ;;&
    --big) big=1; shift ;;
    --repo) repo=$2; shift 2 ;;
    --ref) ref=$2; shift 2 ;;
    --against) against=$2; shift 2 ;;
    --keep-tests) keep=${2//,/ }; shift 2 ;;
    --also) also+=("$2"); shift 2 ;;
    --steps) steps=$2; shift 2 ;;
    --artifacts) artifacts=${2//,/ }; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --timeout) timeout=$2; shift 2 ;;
    --role) role=$2; shift 2 ;;
    --) shift; break ;;
    *) die "unknown option $1 (see the top of scripts/job-run.sh)" ;;
  esac
done
[ $# -gt 0 ] || die "usage: scripts/job-run.sh [--repo ...] [--ref ...] -- <command>"
if [ $# -eq 1 ]; then cmd=$1; else cmd=$(printf '%q ' "$@"); fi
[[ $steps =~ ^(npm-ci|none)$ ]] || die "--steps: npm-ci or none"
{ [[ $timeout =~ ^[0-9]+$ ]] && [ "$timeout" -ge 60 ] && [ "$timeout" -le 5400 ]; } || die "--timeout: 60 to 5400 seconds"
for a in $artifacts; do [[ $a =~ ^[A-Za-z0-9_.][A-Za-z0-9_./*-]*$ && ! $a =~ (^|/)\.\.(/|$) ]] || die "--artifacts: paths inside the repository (got $a)"; done
[[ -z $against || ( $against =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ && ! $against =~ \.\. ) ]] || die "--against: a branch or commit name (got $against)"
[ -z "$keep" ] || [ -n "$against" ] || die "--keep-tests needs --against"
for a in $keep; do [[ $a =~ ^[A-Za-z0-9_][A-Za-z0-9_./-]*$ && ! $a =~ (^|/)\.\.(/|$) ]] || die "--keep-tests: file paths inside the repository (got $a)"; done

# The repository: named, or the current folder's origin (its user and password part never kept or shown).
origin=$(git remote get-url origin 2>/dev/null | sed -E 's#^(https?://)[^@/]*@#\1#' || true)
from_origin() {
  case "$origin" in
    *github.com[:/]"$github_repo"|*github.com[:/]"$github_repo".git) echo claudepilot ;;
    *github.com[:/]"$event_repo"|*github.com[:/]"$event_repo".git) echo event ;;
    *"$gitea"/*) echo "konfersi:$(printf '%s' "${origin#*"$gitea"/}" | sed 's/\.git$//')" ;;
  esac
}
[ -n "$repo" ] || repo=$(from_origin)
[ -n "$repo" ] || die "--repo: claudepilot, event or konfersi:<org>/<repo> (the current folder's origin is none of them)"
if [ "$repo" = konfersi ]; then repo=$(from_origin); [[ $repo == konfersi:* ]] || die "--repo konfersi: the current folder is not a Gitea checkout; name it, konfersi:<org>/<repo>"; fi
case "$repo" in
  claudepilot) kind=github; url=https://github.com/$github_repo.git; repo_label=claudepilot ;;
  event) kind=github; url=https://github.com/$event_repo.git; repo_label=event ;;
  konfersi:*)
    path=${repo#konfersi:}
    [[ $path =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo konfersi:<org>/<repo> (got $repo)"
    kind=gitea; url=https://$gitea/$path.git; repo_label=$(label "${path#*/}") ;;
  *) die "--repo: claudepilot, event or konfersi:<org>/<repo>" ;;
esac
# The program a Job counts against (T-524): ClaudePilot, Event, or Konfersi (every konfersi:<org>/<repo>).
case "$repo" in claudepilot|event) program=$repo ;; *) program=konfersi ;; esac
# Memory (T-524): request = limit, so the scheduler places only what the node can hold; /tmp's in-memory sizeLimit fits inside it.
if [ -n "$big" ]; then memory=$mem_big; tmp_size=$tmp_big; else memory=$mem_std; tmp_size=$tmp_std; fi
[ "$repo" != event ] || [ ${#also[@]} -eq 0 ] || die "--also cannot be used with --repo event (T-491: the Event Job's token is for isnanme/event alone)"
alsos=
for a in ${also[@]+"${also[@]}"}; do
  [[ ! $a =~ \.\. && $a =~ ^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(@([A-Za-z0-9][A-Za-z0-9._/-]{0,199}))?$ ]] || die "--also <org>/<repo>[@<ref>] (got $a)"
  p=${BASH_REMATCH[1]}; r=${BASH_REMATCH[3]:-stg}
  if [ "$kind" = gitea ]; then base=https://$gitea; else base=https://github.com; fi
  alsos="$alsos ${p#*/}=$base/$p.git@$r"
done
alsos=${alsos# }
# The ref: given, or HEAD of the current folder, which must be on the remote.
if [ -z "$ref" ]; then
  { [ -n "$origin" ] && [ "$(from_origin)" = "$repo" ]; } || die "--ref: the current folder is not a checkout of $repo; name the branch or commit"
  ref=$(git rev-parse HEAD)
  git branch -r --contains "$ref" 2>/dev/null | grep -q . || die "HEAD (${ref:0:7}) is not on the remote: push it first (git push origin HEAD:wip/<name>)"
  [ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] || echo "job-run: note: uncommitted changes are not in the Job (it runs ${ref:0:7})" >&2
fi
[[ $ref =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ && ! $ref =~ \.\. ]] || die "--ref: a branch or commit name (got $ref)"
chat=$(label "${PILOT_SESSION_ID:-manual}"); role=$(label "$role")
image=${JOB_RUN_IMAGE:-}
if [ -z "$image" ]; then
  tag=$(curl -fsS "https://$registry/v2/claudepilot/workspace/tags/list" | jq -r '.tags[]? | select(test("-dev-"))' | sort -V | tail -n 1)
  [ -n "$tag" ] || { echo "job-run: no development workspace image in $registry: set JOB_RUN_IMAGE" >&2; exit 1; }
  image=$registry/claudepilot/workspace:$tag
fi
[[ $image =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || die "JOB_RUN_IMAGE: an image reference"

# Who owns a Job: this host, this script's PID and its start time. A Job whose script is gone (killed before its trap ran) is removed here.
starttime() { sed -E 's/.*\) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20; }
host=$(hostname)
reap() {
  local name owner pid start
  jobs_json | jq -r "$JQ_FIN"' .items[] | select(fin | not) | [.metadata.name, (.metadata.annotations["job-run/owner"] // "")] | @tsv' 2>/dev/null |
  while IFS=$'\t' read -r name owner; do
    [[ $name =~ ^claudepilot-job-[0-9a-f]{8}$ && $owner == "$host"/* ]] || continue
    pid=$(cut -d/ -f2 <<<"$owner"); start=$(cut -d/ -f3 <<<"$owner")
    [ -n "$pid" ] && [ "$(starttime "$pid")" = "$start" ] && continue
    stop_one "$name"; echo "job-run: removed $name (its job-run.sh is gone)" >&2
  done
}
reap || true

job=claudepilot-job-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
log=${JOB_RUN_LOG:-/tmp/job-run-$job.log}; [ -n "$out" ] || out=./job-run-artifacts/$job
work=$(mktemp -d "${TMPDIR:-/tmp}/cp-job-run-XXXXXX")
phase=setup; wd=
# shellcheck disable=SC2317 # called by the traps
on_exit() {
  [ -z "$wd" ] || kill "$wd" 2>/dev/null || true
  if [ "$phase" = finished ]; then kubectl -n "$ns" delete secret "$job" --ignore-not-found >/dev/null 2>&1 || true; else stop_one "$job"; fi
  rm -rf "$work"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

# The credentials, into the Secret on stdin (printf is a builtin: no argument a process list would show).
secret="job=$job"; mask=
if [ "$kind" = github ]; then
  t=${NODE_AUTH_TOKEN:-}; [ -n "$t" ] || t=$(gh auth token 2>/dev/null || true)
  if [ -n "$t" ]; then secret="$secret"$'\n'"node-auth-token=$t"; mask=$t; else echo "job-run: no npm token (NODE_AUTH_TOKEN, gh): private packages will not install" >&2; fi
  # Event's repository is private (T-491): the same token is the Job's git credential, through its helper, never in a URL.
  if [ "$repo" = event ]; then
    [ -n "$t" ] || die "--repo event: no GitHub token (NODE_AUTH_TOKEN, gh) to clone the private $event_repo"
    secret="$secret"$'\n'"git-user=x-access-token"$'\n'"git-token=$t"
  fi
else
  creds=$(printf 'protocol=https\nhost=%s\n\n' "$gitea" | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null || true)
  u=$(printf '%s\n' "$creds" | sed -n 's/^username=//p'); t=$(printf '%s\n' "$creds" | sed -n 's/^password=//p'); unset creds
  [ -n "$t" ] || die "no credential for $gitea in git's credential helper"
  secret="$secret"$'\n'"git-user=${u:-git}"$'\n'"git-token=$t"; mask=$t
fi
unset t
printf '%s\n' "$secret" | kubectl -n "$ns" create secret generic "$job" --from-env-file=/dev/stdin >/dev/null
unset secret
sed -e "s#__NAME__#$job#g" -e "s#__CHAT__#$chat#g" -e "s#__ROLE__#$role#g" -e "s#__REPO__#$repo_label#g" -e "s#__PROGRAM__#$program#g" \
    -e "s#__MEMORY__#$memory#g" -e "s#__TMP_SIZE__#$tmp_size#" -e "s#__OWNER__#$host/$$/$(starttime $$)#" \
    -e "s#__DEADLINE__#$timeout#" -e "s#__IMAGE__#$image#" -e "s#__REPO_URL__#$url#" -e "s#__REF__#$ref#" -e "s#__ALSO__#$alsos#" \
    -e "s#__AGAINST__#$against#" -e "s#__KEEP__#$keep#" -e "s#__STEPS__#$steps#" -e "s#__ARTIFACTS__#$artifacts#" -e "s#__ARTMAX__#$art_max#" -e "s#__CMD__#$(printf '%s' "$cmd" | base64 -w0)#" \
    "$here/deploy/k3s-build/job-run.yaml" | kubectl apply -f - >/dev/null
# The Secret belongs to the Job: whoever deletes the Job (its TTL, --stop, a person) deletes the token with it.
uid=$(kubectl -n "$ns" get job "$job" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
if [ -n "$uid" ]; then
  kubectl -n "$ns" patch secret "$job" --type merge -p "{\"metadata\":{\"ownerReferences\":[{\"apiVersion\":\"batch/v1\",\"kind\":\"Job\",\"name\":\"$job\",\"uid\":\"$uid\"}],\"labels\":{\"app\":\"claudepilot-job-run\",\"job-run/chat\":\"$chat\"}}}" >/dev/null || true
fi
# The chat ends: the Claude process this script runs under exits. Then the Job goes, and so does this script.
watch=${JOB_RUN_WATCH_PID:-${CLAUDE_PID:-}}
if [ -n "$watch" ] && [ "$watch" != none ] && kill -0 "$watch" 2>/dev/null; then
  ( while kill -0 "$watch" 2>/dev/null; do sleep "$poll"; done
    echo "job-run: the chat ended (process $watch): stopping $job" >&2; stop_one "$job"; kill -TERM $$ 2>/dev/null ) &
  wd=$!
fi
t0=$(date +%s)
echo "job-run: $job: $repo@${ref:0:12} ($steps) on $image"

# The queue: unfinished Jobs in creation order; the running ones count, then each suspended one is let in while the caps allow.
# shellcheck disable=SC2016 # jq's own variables
QUEUE_JQ="$JQ_FIN"'
def chat: (.metadata.labels["job-run/chat"] // "manual");
def prog: (.metadata.labels["job-run/program"] // (.metadata.labels["job-run/repo"] // "" | if . == "claudepilot" or . == "event" then . else "konfersi" end));
def key: [.metadata.creationTimestamp, .metadata.name];
([.items[] | select(.metadata.deletionTimestamp == null and (fin | not))] | sort_by(key)) as $q
| ([$q[] | select(.metadata.name == $me)] | first) as $mine
| if $mine == null then "gone"
  elif $mine.spec.suspend != true then "go"
  else
    [$q[] | select(.spec.suspend != true)] as $run
    | (reduce $q[] as $j ({total: ($run | length), per: (reduce $run[] as $r ({}; .[$r | chat] += 1)),
          prog: (reduce $run[] as $r ({}; .[$r | prog] += 1)), done: false, go: false};
        if .done or $j.spec.suspend != true then .
        elif .total < $max and ((.per[$j | chat] // 0) < $per) and ((.prog[$j | prog] // 0) < $pprog) then
          .total += 1 | .per[$j | chat] += 1 | .prog[$j | prog] += 1 | (if $j.metadata.name == $me then .go = true | .done = true else . end)
        elif $j.metadata.name == $me then .done = true
        else . end)) as $s
    | if $s.go then "go"
      else "wait \([$q[] | select(.metadata.name != $me and (.spec.suspend != true or (key < ($mine | key))))] | length)" end
  end'
last=
while :; do
  d=$(jobs_json | jq -r --arg me "$job" --argjson max "$max" --argjson per "$per" --argjson pprog "$pprog" "$QUEUE_JQ" 2>/dev/null || true)
  case "$d" in
    go) break ;;
    gone) echo "job-run: $job was stopped while queued" >&2; exit 1 ;;
    wait\ *) [ "$d" = "$last" ] || echo "job-run: queued behind ${d#wait } (at most $max at once, $per per chat, $pprog per program)"; last=$d ;;
  esac
  [ $(( $(date +%s) - t0 )) -lt "$queue_wait" ] || { echo "job-run: still queued after ${queue_wait}s: giving up" >&2; exit 1; }
  sleep "$poll"
done
kubectl -n "$ns" patch job "$job" --type merge -p '{"spec":{"suspend":false}}' >/dev/null
t1=$(date +%s); phase=running
job_state() { # Complete, Failed:<reason>, gone, or nothing while it runs
  kubectl -n "$ns" get job "$job" -o json 2>/dev/null | jq -r '[(.status.conditions // [])[] | select((.type == "Complete" or .type == "Failed") and .status == "True") | if .type == "Failed" then "Failed:\(.reason // "")" else .type end] | first // ""' 2>/dev/null || echo gone
}
pod_json() { kubectl -n "$ns" get pods -l "job-name=$job" -o json 2>/dev/null || true; }
pod_get() { jq -r "$1"' // ""' <<<"$2" 2>/dev/null || true; }
said=; why=
while :; do
  pj=$(pod_json); ph=$(pod_get '.items[0].status.phase' "$pj")
  case "$ph" in Running|Succeeded|Failed) break ;; esac
  [ -z "$(job_state)" ] || break
  # Pending because no node can hold it (T-524): say so once, instead of a silent wait.
  why=$(pod_get '[.items[0].status.conditions[]? | select(.type == "PodScheduled" and .status == "False" and .reason == "Unschedulable") | .message] | first' "$pj")
  case "$why" in
    '') ;;
    *'Insufficient memory'*)
      [ "$said" = memory ] || { said=memory
        if [ -n "$big" ]; then hint="drop --big if the command fits in $mem_std"; else hint="it starts when a Job ends and frees memory"; fi
        echo "job-run: $job is Pending: no node has $memory of memory free to request ($why); $hint (waits up to ${start_wait}s)" >&2; } ;;
    *) [ "$said" = other ] || { said=other; echo "job-run: $job is Pending: $why (waits up to ${start_wait}s)" >&2; } ;;
  esac
  [ $(( $(date +%s) - t1 )) -lt "$start_wait" ] || { echo "job-run: the Job did not start in ${start_wait}s (pod: ${ph:-none}${why:+: $why})" >&2; exit 1; }
  sleep "$poll"
done

# The log: streamed, masked for the credentials, the artifacts block set aside; NR is kept so a broken stream can be resumed.
# shellcheck disable=SC2016 # awk's own variables
FILTER='BEGIN { tok = ENVIRON["JR_MASK"]; art = ENVIRON["JR_ART"]; lf = ENVIRON["JR_LOG"] }
{ line = $0
  if (length(tok) >= 8) while ((i = index(line, tok)) > 0) { line = substr(line, 1, i - 1) "[redacted]" substr(line, i + length(tok)); leak = 1 }
  if (line == "=== JOB-RUN ARTIFACTS BEGIN") { inart = 1; next }
  if (line == "=== JOB-RUN ARTIFACTS END") { inart = 0; next }
  if (inart) { print line >> art; next }
  print line; print line >> lf; fflush() }
END { print NR >> ENVIRON["JR_N"]; if (leak) print "leak" >> ENVIRON["JR_N"] }'
filter() { JR_MASK=$mask JR_ART=$work/art.b64 JR_LOG=$log JR_N=$work/n awk "$FILTER"; }
: > "$log"
kubectl -n "$ns" logs -f "job/$job" 2>&1 | filter || true
st=
while :; do st=$(job_state); if [ -n "$st" ] || [ $(( $(date +%s) - t1 )) -ge $(( timeout + start_wait )) ]; then break; fi; sleep "$poll"; done
if ! grep -q '^=== JOB-RUN EXIT ' "$log"; then
  seen=$(awk '/^[0-9]+$/ { n += $1 } END { print n + 0 }' "$work/n" 2>/dev/null || echo 0)
  rm -f "$work/art.b64"
  kubectl -n "$ns" logs "job/$job" 2>/dev/null | tail -n +"$(( ${seen:-0} + 1 ))" | filter || true
fi
phase=finished
rc=$(sed -n 's/^=== JOB-RUN EXIT \([0-9]\{1,3\}\)$/\1/p' "$log" | tail -n 1)
# Out of memory (T-524): the container killed at its limit (no exit line), or one process in it (the memory line counts the kills).
pj=$(pod_json)
if [ -n "$big" ]; then more="$mem_big is the most a Job gets: split the command"; else more="rerun with --big ($mem_big, prefers k3s-node2)"; fi
if [ "$(pod_get '.items[0].status.containerStatuses[0].state.terminated.reason' "$pj")" = OOMKilled ]; then
  echo "job-run: $job was OOMKilled: it reached its memory limit of $memory (the in-memory /tmp counts too); $more" >&2
  [ -n "$rc" ] || rc=137
elif ooms=$(sed -n 's/^=== JOB-RUN MEMORY .* oom_kills=\([0-9]\{1,9\}\)$/\1/p' "$log" | tail -n 1) && [ "${ooms:-0}" -gt 0 ]; then
  echo "job-run: $job: $ooms process(es) were OOM-killed at the memory limit of $memory; $more" >&2
fi
if [ "$(pod_get '.items[0].status.reason' "$pj")" = Evicted ]; then
  echo "job-run: $job was evicted: $(pod_get '.items[0].status.message' "$pj") (/tmp holds at most $tmp_size in memory; --big gives $tmp_big)" >&2
elif { [ -n "$rc" ] && [ "$rc" != 0 ]; } || [ "${st%%:*}" = Failed ]; then
  # A memory-backed /tmp is a tmpfs of its sizeLimit: when it fills, the command gets ENOSPC (no eviction), so the log is the only sign.
  if grep -q 'No space left on device' "$log" 2>/dev/null; then
    if [ -n "$big" ]; then hint="$tmp_big is the most /tmp gets: write less there or split the command"; else hint="rerun with --big (/tmp $tmp_big)"; fi
    echo "job-run: $job: No space left on device: /tmp holds at most $tmp_size in memory (it and /dev/shm count against the $memory limit); $hint" >&2
  fi
fi
if [ -z "$rc" ]; then
  case "$st" in
    Failed:DeadlineExceeded) rc=124; echo "job-run: past the deadline (${timeout}s)" >&2 ;;
    '') rc=1; echo "job-run: the Job did not finish" >&2; phase=setup ;;
    *) rc=1; echo "job-run: the Job ended without an exit code ($st)" >&2 ;;
  esac
fi
grep -qx leak "$work/n" 2>/dev/null && echo "job-run: WARNING: a credential was in the Job's log (masked in the output and in $log)" >&2
if [ -n "$artifacts" ] && [ -s "$work/art.b64" ]; then
  mkdir -p "$out"
  if base64 -d "$work/art.b64" 2>/dev/null | tar -xzf - -C "$out" --no-same-owner --no-same-permissions 2>/dev/null; then echo "job-run: artifacts in $out"
  else echo "job-run: the artifacts did not unpack" >&2; fi
fi
node=$(pod_get '.items[0].spec.nodeName' "$pj")
t2=$(date +%s)
echo "job-run: $job rc=$rc in $((t2 - t1))s (queued $((t1 - t0))s) on ${node:-?} with $memory; log: $log"
exit "$rc"
