#!/usr/bin/env bash
# Shared by the steps of the deploy pipeline (.pilot/deploy.yml); sourced, never run. The runner gives every step the PILOT_* variables
# (docs/prd/local-git-ci.md §9.5) and the inputs as PILOT_INPUT_<NAME>. The DEPLOY_* defaults are the isnan cluster's; a test (or another
# cluster) sets them in the workspace's ~/.profile, which the steps' login shell reads.
# Rules: no `set -x` anywhere (a token must never reach a log); every command that changes something outside this checkout goes through
# `act`, so a dry run (input dry_run) prints it instead; everything printed from a command that holds the GitHub token passes `mask`.

DEPLOY_GIT_REMOTE=${DEPLOY_GIT_REMOTE:-https://github.com/alfianisnan26/claudepilot.git}
DEPLOY_MAIN=${DEPLOY_MAIN:-main}
DEPLOY_NAMESPACE=${DEPLOY_NAMESPACE:-isnan-claudepilot}
DEPLOY_ARGO_NAMESPACE=${DEPLOY_ARGO_NAMESPACE:-isnan-argocd}
DEPLOY_ARGO_APP=${DEPLOY_ARGO_APP:-isnan-claudepilot}
DEPLOY_DEPLOYMENT=${DEPLOY_DEPLOYMENT:-claudepilot-portal}
DEPLOY_URL=${DEPLOY_URL:-http://claudepilot-portal.isnan-claudepilot.svc.cluster.local:3000}
DEPLOY_REGISTRY=${DEPLOY_REGISTRY:-registry.int.isnan.me}
DEPLOY_MANIFEST=${DEPLOY_MANIFEST:-deploy/k3s/portal.yaml}
# How long verify waits for Argo CD, and how often it looks (seconds).
DEPLOY_WAIT_S=${DEPLOY_WAIT_S:-900}
DEPLOY_POLL_S=${DEPLOY_POLL_S:-10}
# The chats a release restarts (T-277 layer 4): how long the release step waits for the portal to say which chats are attached, how long it
# then waits while one of them is answering a control request, how long after the restart the chats job watches them, and how often (s).
DEPLOY_CHATS_SEEN_S=${DEPLOY_CHATS_SEEN_S:-30}
DEPLOY_CHATS_WAIT_S=${DEPLOY_CHATS_WAIT_S:-120}
DEPLOY_CHATS_WINDOW_S=${DEPLOY_CHATS_WINDOW_S:-600}
DEPLOY_CHATS_POLL_S=${DEPLOY_CHATS_POLL_S:-5}
# Where the jobs leave what the next job needs (the pipeline's artifacts).
# shellcheck disable=SC2034 # used by the scripts that source this
OUT=.pilot/out
# Lines in the portal's log that fail a deploy (anything else that says "error" is counted and shown, not fatal). `[store] LOCKED: ...` and the
# other states that are not `ready` come from apps/server/src/index.ts at start-up.
FATAL_LOG='Unhandled|uncaught|FATAL|SyntaxError|TypeError|ReferenceError|Cannot find module|EADDRINUSE|out of memory|[Mm]igration.*fail|\[store\] [A-Z][A-Z_-]+:'

log() { printf '%s\n' "$*"; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

dry() { [ "${PILOT_INPUT_DRY_RUN:-false}" = true ]; }

# Runs a command that changes something outside this checkout (the cluster, a remote); in a dry run it only says so.
act() {
  if dry; then
    log "[dry-run] would run: $*"
  else
    "$@"
  fi
}

run_sha() { printf '%s' "${PILOT_SHA:?PILOT_SHA is not set: run this from the deploy pipeline}"; }
short() { printf '%s' "${1:0:7}"; }
# The branch the commit came from on GitHub: the run's branch, or integration for a run on a tag.
src_branch() { printf '%s' "${PILOT_BRANCH:-integration}"; }

# Takes the GitHub token out of a stream. The token travels in awk's environment, never in an argument a process list would show.
mask() {
  local t
  t=$(gh auth token 2>/dev/null || true)
  if [ -z "$t" ]; then
    cat
    return
  fi
  T="$t" awk 'BEGIN { t = ENVIRON["T"] } { while ((i = index($0, t)) > 0) $0 = substr($0, 1, i - 1) "[redacted]" substr($0, i + length(t)); print; fflush() }'
}

# The checkout's origin is the workspace's pilot remote; releases and builds talk to GitHub, which Argo CD and kaniko read.
ensure_origin() {
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$DEPLOY_GIT_REMOTE"
  else
    git remote add origin "$DEPLOY_GIT_REMOTE"
  fi
  git fetch -q origin "$DEPLOY_MAIN" || die "can not fetch $DEPLOY_MAIN from $DEPLOY_GIT_REMOTE"
  git fetch -q origin "$(src_branch)" 2>/dev/null || true
}

# The images input: a comma list of portal, workspace, workspace-dev (or none), in build order, each once.
parse_images() {
  local raw=${1// /} items=() item
  [ "$raw" = none ] || [ -z "$raw" ] && return 0
  IFS=, read -r -a items <<<"$raw"
  for item in "${items[@]}"; do
    case $item in
      portal | workspace | workspace-dev) ;;
      *) die "unknown image \"$item\": use portal, workspace, workspace-dev or none" ;;
    esac
  done
  for item in portal workspace workspace-dev; do
    case ",$raw," in *",$item,"*) printf '%s\n' "$item" ;; esac
  done
}

# The variable in build.env that carries an image's new tag.
tag_var() {
  case $1 in
    portal) printf PORTAL_TAG ;;
    workspace) printf WORKSPACE_TAG ;;
    workspace-dev) printf WORKSPACE_DEV_TAG ;;
  esac
}

# Where an image lives in the registry.
registry_repo() { if [ "$1" = portal ]; then printf claudepilot/portal; else printf claudepilot/workspace; fi; }

claude_version() { grep -oE '^ARG CLAUDE_CODE_VERSION=[0-9]+\.[0-9]+\.[0-9]+' images/workspace/Dockerfile | cut -d= -f2; }

# A new date-based tag: <prefix><yyyy.mm.dd>-<n>, n one more than the highest of today's in the registry (portal: 2026.10.13-2; workspace:
# 2.1.296-2026.10.13-1; workspace-dev: 2.1.296-dev-2026.10.13-1). A registry that can not be listed stops the build: a guessed number could
# overwrite an image that is running.
next_tag() {
  local what=$1 prefix='' day tags n max=0 cc
  day=$(date -u +%Y.%m.%d)
  if [ "$what" != portal ]; then
    cc=$(claude_version)
    [ -n "$cc" ] || die "no CLAUDE_CODE_VERSION in images/workspace/Dockerfile"
    prefix="$cc-"
    [ "$what" = workspace-dev ] && prefix="$cc-dev-"
  fi
  if ! tags=$(curl -fsS --max-time 20 "https://$DEPLOY_REGISTRY/v2/$(registry_repo "$what")/tags/list"); then
    dry || die "can not list the tags of $(registry_repo "$what") in $DEPLOY_REGISTRY"
    tags=''
  fi
  for n in $(printf '%s' "$tags" | grep -oE "\"${prefix//./\\.}${day//./\\.}-[0-9]+\"" | grep -oE '[0-9]+"$' | tr -d '"'); do
    [ "$n" -gt "$max" ] && max=$n
  done
  printf '%s%s-%s' "$prefix" "$day" $((max + 1))
}

# The manifest line that carries an image's tag.
tag_line() {
  case $1 in
    portal) printf 'image: %s/claudepilot/portal:' "$DEPLOY_REGISTRY" ;;
    workspace) printf 'value: %s/claudepilot/workspace:' "$DEPLOY_REGISTRY" ;;
    *) die "no manifest line for $1" ;;
  esac
}

current_tag() {
  local line
  line=$(tag_line "$1")
  [ "$(grep -cF "$line" "$DEPLOY_MANIFEST")" = 1 ] || die "expected exactly one \"$line\" line in $DEPLOY_MANIFEST"
  grep -F "$line" "$DEPLOY_MANIFEST" | sed -E 's#.*:([A-Za-z0-9._-]+)[[:space:]]*$#\1#'
}

# Puts a tag on an image's line; exactly that one line changes.
set_tag() {
  local what=$1 tag=$2 line
  [[ $tag =~ ^[A-Za-z0-9._-]{1,128}$ ]] || die "\"$tag\" is not an image tag"
  line=$(tag_line "$what")
  current_tag "$what" >/dev/null
  awk -v line="$line" -v tag="$tag" '{ i = index($0, line); if (i > 0) $0 = substr($0, 1, i + length(line) - 1) tag; print }' "$DEPLOY_MANIFEST" >"$DEPLOY_MANIFEST.new"
  mv "$DEPLOY_MANIFEST.new" "$DEPLOY_MANIFEST"
}

# Commits with the workspace's git identity, or a neutral one when it has none.
commit() {
  local name email
  name=$(git config user.name || true)
  email=$(git config user.email || true)
  git -c user.name="${name:-ClaudePilot CI}" -c user.email="${email:-ci@claudepilot.invalid}" -c commit.gpgsign=false commit -q -m "$1" -m "$2" -- "$DEPLOY_MANIFEST"
}

# Waits until Argo CD has the app Synced and Healthy (at a revision, when one is given).
wait_synced() {
  local want=$1 deadline=$((SECONDS + DEPLOY_WAIT_S)) state rev sync health last=''
  act kubectl -n "$DEPLOY_ARGO_NAMESPACE" annotate application "$DEPLOY_ARGO_APP" argocd.argoproj.io/refresh=hard --overwrite >/dev/null
  while :; do
    state=$(kubectl -n "$DEPLOY_ARGO_NAMESPACE" get application "$DEPLOY_ARGO_APP" -o jsonpath='{.status.sync.revision} {.status.sync.status} {.status.health.status}' 2>/dev/null || true)
    read -r rev sync health <<<"$state" || true
    if [ "$state" != "$last" ]; then
      log "argo cd: $(short "${rev:-?}") ${sync:-?} ${health:-?}"
      last=$state
    fi
    if [ "${sync:-}" = Synced ] && [ "${health:-}" = Healthy ] && { [ -z "$want" ] || [ "${rev:-}" = "$want" ]; }; then return 0; fi
    [ "$SECONDS" -ge "$deadline" ] && die "Argo CD is not Synced and Healthy${want:+ at $(short "$want")} after ${DEPLOY_WAIT_S}s"
    sleep "$DEPLOY_POLL_S"
  done
}

# T-961: before the push to main (which stops the old portal: Recreate), prove the NEW pod can start, so a failure leaves the old portal up.
# The outage: node2 was full, the new pod stayed Pending and then hit ImagePullBackOff, with the old portal already gone.
#  1. it fits: the new pod's requests (the same as portal.yaml: DEPLOY_PORTAL_CPU_M and DEPLOY_PORTAL_MEM_MI, a test holds them equal) are free on
#     the portal's node with the old portal's pod gone, or become free when the pods of the class claudepilot-jobs are preempted (sched_fit);
#  2. the image is pullable ON THAT NODE: a short-lived pod pinned to it runs the new portal image (imagePullPolicy IfNotPresent, like the
#     portal), deleted at the end whatever happens.
# A list the pipeline can not read (no rights) is a warning, not an abort: the pre-pull still decides. Either check failing dies.
DEPLOY_PORTAL_CPU_M=${DEPLOY_PORTAL_CPU_M:-100}
DEPLOY_PORTAL_MEM_MI=${DEPLOY_PORTAL_MEM_MI:-384}
DEPLOY_PREPULL_S=${DEPLOY_PREPULL_S:-180}
# shellcheck source=scripts/sched-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/../../scripts/sched-lib.sh"
precheck_schedule() {
  local tag=$1 node nodes pods fit name image deadline st waiting phase
  node=$(awk '/^[[:space:]]*kubernetes\.io\/hostname:/ { print $2; exit }' "$DEPLOY_MANIFEST")
  [ -n "$node" ] || die "pre-check: no nodeSelector (kubernetes.io/hostname) in $DEPLOY_MANIFEST: nothing was deployed"
  nodes=$(kubectl get nodes -o json 2>/dev/null || true)
  pods=$(kubectl get pods -A -o json 2>/dev/null || true)
  if [ -z "$nodes" ] || [ -z "$pods" ]; then
    log "WARNING: pre-check: the nodes or pods can not be read: whether the new portal pod fits on $node is NOT verified (the pre-pull still runs)"
  else
    fit=$(sched_fit "$nodes" "$pods" "$node" "$DEPLOY_PORTAL_CPU_M" "$DEPLOY_PORTAL_MEM_MI" "$DEPLOY_DEPLOYMENT")
    case "$fit" in
      fits) log "pre-check: the new portal pod fits on $node (${DEPLOY_PORTAL_CPU_M}m CPU, ${DEPLOY_PORTAL_MEM_MI}Mi requested)" ;;
      preempt) log "pre-check: $node is full, but the new portal pod fits once cluster Jobs (class claudepilot-jobs) are preempted: it will preempt them" ;;
      *) die "pre-check: the new portal pod (${DEPLOY_PORTAL_CPU_M}m CPU, ${DEPLOY_PORTAL_MEM_MI}Mi) does not fit on $node, not even by preempting Jobs: the old portal is still up, nothing was deployed" ;;
    esac
  fi
  image="$DEPLOY_REGISTRY/claudepilot/portal:$tag"
  name="pilot-prepull-$(printf '%s' "${PILOT_RUN_ID:-local}" | tr -c 'a-z0-9' '-' | cut -c1-12)-$$"
  name=${name//--/-}
  if dry; then
    log "[dry-run] would run: kubectl -n $DEPLOY_NAMESPACE run $name --image=$image --restart=Never (pinned to $node), wait up to ${DEPLOY_PREPULL_S}s, delete it"
    return 0
  fi
  log "pre-check: pulling $image on $node (pod $name)"
  kubectl -n "$DEPLOY_NAMESPACE" run "$name" --image="$image" --restart=Never --labels=app=claudepilot-prepull \
    --overrides="{\"spec\":{\"nodeSelector\":{\"kubernetes.io/hostname\":\"$node\"},\"priorityClassName\":\"claudepilot-jobs\"}}" \
    --command -- node -e 0 >/dev/null || die "pre-check: the pre-pull pod could not be created: the old portal is still up, nothing was deployed"
  deadline=$((SECONDS + DEPLOY_PREPULL_S)); st=timeout
  while [ "$SECONDS" -lt "$deadline" ]; do
    read -r phase waiting <<<"$(kubectl -n "$DEPLOY_NAMESPACE" get pod "$name" -o jsonpath='{.status.phase} {.status.containerStatuses[0].state.waiting.reason}' 2>/dev/null || true)" || true
    case "${waiting:-}" in ErrImagePull | ImagePullBackOff | InvalidImageName) st=$waiting; break ;; esac
    case "${phase:-}" in Running | Succeeded | Failed) st=pulled; break ;; esac
    sleep "$DEPLOY_POLL_S"
  done
  kubectl -n "$DEPLOY_NAMESPACE" delete pod "$name" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  [ "$st" = pulled ] || die "pre-check: $image is not pullable on $node ($st within ${DEPLOY_PREPULL_S}s): the old portal is still up, nothing was deployed"
  log "pre-check: $image pulled on $node"
}

rollout() {
  kubectl -n "$DEPLOY_NAMESPACE" rollout status "deploy/$DEPLOY_DEPLOYMENT" --timeout=300s
}

# /healthz and /login through the in-cluster service, a few tries while the new pod settles.
smoke() {
  local path code i
  for path in /healthz /login; do
    for i in 1 2 3 4 5 6; do
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$DEPLOY_URL$path" || true)
      [ "$code" = 200 ] && break
      [ "$i" = 6 ] || sleep 5
    done
    [ "$code" = 200 ] || die "$path answered ${code:-nothing}"
    log "$path 200"
  done
}

# The portal's log since the rollout: fatal lines fail the deploy; a pod that restarted does too.
scan_logs() {
  local text fatal errors restarts
  text=$(kubectl -n "$DEPLOY_NAMESPACE" logs "deploy/$DEPLOY_DEPLOYMENT" --since=15m 2>&1 || true)
  errors=$(printf '%s\n' "$text" | grep -ciE '\berror\b' || true)
  log "portal log: $(printf '%s\n' "$text" | grep -c . || true) lines in 15 min, $errors mention an error"
  fatal=$(printf '%s\n' "$text" | grep -E "$FATAL_LOG" || true)
  if [ -n "$fatal" ]; then
    printf '%s\n' "$fatal" | head -20 | cut -c1-200
    die "the portal's log has fatal lines"
  fi
  restarts=$(kubectl -n "$DEPLOY_NAMESPACE" get pods -l "app=$DEPLOY_DEPLOYMENT" -o jsonpath='{range .items[*]}{.status.containerStatuses[0].restartCount}{" "}{end}' 2>/dev/null || true)
  for n in $restarts; do [ "$n" = 0 ] || die "a portal pod restarted ($n times)"; done
}

# ---------- The chats a release restarts (T-277 layer 4) ----------
# Steps hold no portal credential (PRD FR20), so the portal says it in its own log, which verify already reads: while a deploying job runs,
# apps/server/src/ci/deployChats.ts writes `[deploy-chats] run=<id> job=<job> attached=<n> pending=<n|?> chats=<id8>:<claude>:<mode>:<tail8>:<open>:<workspace>,...`
# (ids and facts only, every field cut to [A-Za-z0-9._/-]), and the controller writes `[chat] <id>: ended for integrity: <why>` when it ends one.

# The portal's latest line about this run's job, from the tag on (empty when it has said nothing yet).
chats_line() {
  local key="[deploy-chats] run=${PILOT_RUN_ID:-} job=${PILOT_JOB:-release} "
  kubectl -n "$DEPLOY_NAMESPACE" logs "deploy/$DEPLOY_DEPLOYMENT" --since=30m 2>/dev/null | grep -F -- "$key" | grep -E '^\[deploy-chats\] ' | tail -1 || true
}

# One word of a chats line: `pending` of `... pending=2 ...`.
chats_word() { printf '%s\n' "$1" | tr ' ' '\n' | sed -n "s/^$2=//p" | head -1; }

# The release step, before the push: records the chats attached to a live process into $OUT/chats.env (for the chats job) and the step's log,
# and waits (at most DEPLOY_CHATS_WAIT_S) while one is answering a control request the portal asked. Never fails the release: a portal that
# says nothing (one from before this, or a log that can not be read) leaves CHATS_STATE=unavailable, and the wait ends at its bound.
record_chats() {
  local out="$OUT/chats.env" line='' deadline start pending chats n entry id claude mode open ws entries=()
  printf 'CHATS_STATE=unavailable\n' >"$out"
  deadline=$((SECONDS + DEPLOY_CHATS_SEEN_S))
  while :; do
    line=$(chats_line)
    [ -n "$line" ] && break
    if [ "$SECONDS" -ge "$deadline" ]; then
      log "chats: unavailable: the portal did not say which chats are attached within ${DEPLOY_CHATS_SEEN_S}s (a portal from before T-277 layer 4, or its log can not be read); the chats job will not check them"
      return 0
    fi
    sleep "$DEPLOY_CHATS_POLL_S"
  done
  pending=$(chats_word "$line" pending)
  if [ "$pending" = '?' ]; then
    log "chats: the portal can not tell whether a control request is open: not waiting"
  elif [ "${pending:-0}" != 0 ]; then
    log "chats: $pending control request(s) of attached chats not answered yet: waiting up to ${DEPLOY_CHATS_WAIT_S}s"
    start=$SECONDS
    deadline=$((SECONDS + DEPLOY_CHATS_WAIT_S))
    while :; do
      if [ "$SECONDS" -ge "$deadline" ]; then
        log "WARNING: chats: $pending control request(s) still open after ${DEPLOY_CHATS_WAIT_S}s: releasing anyway"
        break
      fi
      sleep "$DEPLOY_CHATS_POLL_S"
      line=$(chats_line)
      pending=$(chats_word "$line" pending)
      if [ "$pending" = 0 ]; then
        log "chats: answered after $((SECONDS - start))s"
        break
      fi
      [ "$pending" = '?' ] && break
    done
  fi
  n=$(chats_word "$line" attached)
  chats=$(chats_word "$line" chats)
  if ! [[ $n =~ ^[0-9]+$ ]] || ! [[ $chats =~ ^[A-Za-z0-9._/:,?-]*$ ]]; then
    log "chats: unavailable: the portal's line is not one this script reads"
    return 0
  fi
  {
    echo "CHATS_STATE=recorded"
    echo "CHATS_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "CHATS_ATTACHED=$n"
    echo "CHATS_PENDING=${pending:-?}"
    echo "CHATS=$chats"
  } >"$out"
  log "chats: $n attached to a live process at release (the portal's line: attached=$n pending=${pending:-?})"
  [ "$chats" = - ] && return 0
  IFS=, read -r -a entries <<<"$chats"
  for entry in "${entries[@]}"; do
    IFS=: read -r id claude mode _ open ws <<<"$entry"
    log "  $id  claude $claude  mode $mode  open $open  workspace $ws"
  done
}

# When the newest portal pod started (RFC 3339), or empty.
portal_started() {
  kubectl -n "$DEPLOY_NAMESPACE" get pods -l "app=$DEPLOY_DEPLOYMENT" -o jsonpath='{range .items[*]}{.status.startTime}{"\n"}{end}' 2>/dev/null | grep -E '^[0-9]{4}-' | sort | tail -1 || true
}
