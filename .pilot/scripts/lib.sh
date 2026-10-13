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
