#!/usr/bin/env bash
# The release job (environment production: it waits for a decision in the portal while production is protected; an agent-started run to an
# unprotected production is refused by the portal, T-3004). Puts the new tags of the portal and
# workspace images into deploy/k3s/portal.yaml on top of the run's commit and pushes that commit to main, the branch Argo CD follows: that
# push IS the deploy, and it goes to main alone (fast-forward, never forced). The run's branch then catches up as a separate step: the
# release commit, or, when the branch moved on while the release waited for its approval, the release merged into its new tip, fetched
# again if it moves during the push (T-95: run #4 was refused because one atomic push to both branches failed on a status commit). A branch
# that no longer has the run's commit stops the release before anything is pushed; a conflict on the branch only warns (the deploy is done). Leaves .pilot/out/release.env (what was pushed, the tags before) for verify and rollback, whatever happens,
# and .pilot/out/chats.env (the chats attached at release, T-277 layer 4) for the chats job.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# shellcheck source=.pilot/scripts/lib.sh
. .pilot/scripts/lib.sh

sha=$(run_sha)
mkdir -p "$OUT"
rel="$OUT/release.env"
echo PUSHED=0 >"$rel"
PORTAL_TAG='' WORKSPACE_TAG=''
# shellcheck source=/dev/null
[ -f "$OUT/build.env" ] && . "$OUT/build.env"
if [ -z "$PORTAL_TAG$WORKSPACE_TAG" ]; then
  log "release: nothing to release (no portal or workspace image was built in this run)"
  exit 0
fi

ensure_origin
git merge-base --is-ancestor "origin/$DEPLOY_MAIN" "$sha" ||
  die "$DEPLOY_MAIN has commits that $(short "$sha") does not: merge $DEPLOY_MAIN into $(src_branch) and run again"
git checkout -q -B pilot-release "$sha"
prev_portal=$(current_tag portal)
prev_workspace=$(current_tag workspace)
[ -n "$PORTAL_TAG" ] && set_tag portal "$PORTAL_TAG"
[ -n "$WORKSPACE_TAG" ] && set_tag workspace "$WORKSPACE_TAG"
if git diff --quiet -- "$DEPLOY_MANIFEST"; then
  log "release: $DEPLOY_MANIFEST already has these tags"
  exit 0
fi
what=$( (
  [ -n "$PORTAL_TAG" ] && printf 'portal %s' "$PORTAL_TAG"
  [ -n "$PORTAL_TAG" ] && [ -n "$WORKSPACE_TAG" ] && printf ', '
  [ -n "$WORKSPACE_TAG" ] && printf 'workspace %s' "$WORKSPACE_TAG"
) || true)
# T-3004: say how the release was let through, never more. The portal sets PILOT_APPROVAL on the deploying job: `held` (it waited for a
# decision in the portal: a person's, or the environment's own auto-approve rule; the run shows who) or `auto` (the environment does not
# hold, so nobody decided). Anything else (an older portal, a run by hand) claims nothing.
case "${PILOT_APPROVAL:-}" in
  held) approval="approved in the portal (the run records who decided)" ;;
  auto) approval="auto-approved (no person decided)" ;;
  *) approval="approval not recorded" ;;
esac
commit "deploy: $what" "Released by the deploy pipeline: pilot CI run #${PILOT_RUN_NUMBER:-?} of $(short "$sha") on $(src_branch), $approval.

Pilot-Run: ${PILOT_RUN_ID:-local}"
bump=$(git rev-parse HEAD)
{
  echo "PREV_PORTAL=$prev_portal"
  echo "PREV_WORKSPACE=$prev_workspace"
  echo "NEW_PORTAL=$PORTAL_TAG"
  echo "NEW_WORKSPACE=$WORKSPACE_TAG"
  echo "BUMP_SHA=$bump"
  echo "BASE_SHA=$sha"
  echo "PUSHED=0"
} >"$rel"
# 0. The chats this restarts (T-277 layer 4): which are attached to a live process, into chats.env and this log, and a bounded wait while one is
#    answering a control request the portal asked (any change to the manifest restarts the portal: the workspace tag is its env too).
record_chats
# 0b. The new portal image is on the portal's node before anything restarts (pre-pull, lib.sh).
[ -n "$PORTAL_TAG" ] && prepull "$DEPLOY_REGISTRY/$(registry_repo portal):$PORTAL_TAG"
# 1. The deploy: the release commit to main alone (it fast-forwards main: main is an ancestor of the run's commit). Nothing else can make it
#    fail: a push to the run's branch during the approval no longer matters here (T-95).
if [ -n "${PILOT_BRANCH:-}" ] && [ "$PILOT_BRANCH" != "$DEPLOY_MAIN" ]; then
  git fetch -q origin "$PILOT_BRANCH" 2>/dev/null || true
  tip=$(git rev-parse -q --verify "origin/$PILOT_BRANCH^{commit}" 2>/dev/null || true)
  [ -z "$tip" ] || git merge-base --is-ancestor "$sha" "$tip" ||
    die "$PILOT_BRANCH no longer has $(short "$sha") (it was rewritten since this run started): nothing was deployed"
fi
log "release: $(short "$bump") ($what) to $DEPLOY_MAIN"
act git push -q origin "$bump:refs/heads/$DEPLOY_MAIN" || die "the push to $DEPLOY_MAIN was refused: nothing was deployed"
dry || sed -i 's/^PUSHED=0$/PUSHED=1/' "$rel"
dry || log "release: pushed $(short "$bump") to $DEPLOY_MAIN: Argo CD deploys it"

# 2. The run's branch catches up, as its own step: the release commit itself when the branch is still where the run started, else the
#    release merged into its current tip; a branch that moves between the fetch and the push is fetched again (three tries). A conflict or
#    a branch that keeps moving leaves a warning (the deploy is done; merge main into the branch by hand), never a failed release.
if [ -n "${PILOT_BRANCH:-}" ] && [ "$PILOT_BRANCH" != "$DEPLOY_MAIN" ]; then
  synced=
  for try in 1 2 3; do
    git fetch -q origin "$PILOT_BRANCH" 2>/dev/null || true
    tip=$(git rev-parse -q --verify "origin/$PILOT_BRANCH^{commit}" 2>/dev/null || true)
    branch_to=$bump
    if [ -n "$tip" ] && ! git merge-base --is-ancestor "$tip" "$bump"; then
      log "release: $PILOT_BRANCH moved on to $(short "$tip") since this run started: the release is merged into it"
      git checkout -q -B pilot-release-branch "$tip"
      gname=$(git config user.name || true)
      gemail=$(git config user.email || true)
      if ! git -c user.name="${gname:-ClaudePilot CI}" -c user.email="${gemail:-ci@claudepilot.invalid}" -c commit.gpgsign=false \
        merge -q --no-ff --no-edit -m "merge release $(short "$bump") ($what) into $PILOT_BRANCH" "$bump"; then
        git merge --abort 2>/dev/null || true
        git checkout -q pilot-release
        log "WARNING: the release does not merge cleanly into $PILOT_BRANCH at $(short "$tip"): merge $DEPLOY_MAIN into $PILOT_BRANCH by hand (the deploy is done)"
        break
      fi
      branch_to=$(git rev-parse HEAD)
      git checkout -q pilot-release
    fi
    if act git push -q origin "$branch_to:refs/heads/$PILOT_BRANCH"; then
      synced=$branch_to
      break
    fi
    log "release: $PILOT_BRANCH moved during the push (try $try of 3)"
  done
  if [ -n "$synced" ]; then
    echo "BRANCH_SHA=$synced" >>"$rel"
    dry || log "release: $PILOT_BRANCH is at $(short "$synced")"
  else
    echo "BRANCH_SYNC=failed" >>"$rel"
    log "WARNING: $PILOT_BRANCH was not brought up to date: merge $DEPLOY_MAIN into it by hand (the deploy is done)"
  fi
fi
dry && log "release: dry run, nothing pushed"
exit 0
