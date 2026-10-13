#!/usr/bin/env bash
# The rollback job: runs only when release or verify failed. When a release was pushed, puts the tags from before it back on top of main
# (a new commit, fast-forward, never a force), pushes it, and waits for Argo CD, the rollout and /healthz again. It is not held for an
# approval: it returns to the state a person approved before. Nothing pushed: nothing to undo.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# shellcheck source=.pilot/scripts/lib.sh
. .pilot/scripts/lib.sh

PUSHED=0 BUMP_SHA='' PREV_PORTAL='' PREV_WORKSPACE='' NEW_PORTAL='' NEW_WORKSPACE=''
# shellcheck source=/dev/null
[ -f "$OUT/release.env" ] && . "$OUT/release.env"
if [ "$PUSHED" != 1 ]; then
  log "rollback: nothing was pushed, nothing to roll back"
  exit 0
fi
ensure_origin
git checkout -q -B pilot-rollback "origin/$DEPLOY_MAIN"
[ -n "$NEW_PORTAL" ] && set_tag portal "$PREV_PORTAL"
[ -n "$NEW_WORKSPACE" ] && set_tag workspace "$PREV_WORKSPACE"
if git diff --quiet -- "$DEPLOY_MANIFEST"; then
  log "rollback: $DEPLOY_MANIFEST on $DEPLOY_MAIN already has the tags from before"
else
  commit "deploy: roll back to portal $PREV_PORTAL, workspace $PREV_WORKSPACE" "The deploy pipeline (pilot CI run #${PILOT_RUN_NUMBER:-?}) released $(short "$BUMP_SHA") and its checks failed; this puts the tags from before it back.

Pilot-Run: ${PILOT_RUN_ID:-local}"
fi
back=$(git rev-parse HEAD)
# main first and alone (T-95); the run's branch follows only when it is still exactly the release, else it is told to merge main.
[ "$back" = "$(git rev-parse "origin/$DEPLOY_MAIN")" ] || act git push -q origin "$back:refs/heads/$DEPLOY_MAIN" || die "the rollback push was refused"
if [ -n "${PILOT_BRANCH:-}" ] && [ "$PILOT_BRANCH" != "$DEPLOY_MAIN" ] && [ "$back" != "$BUMP_SHA" ]; then
  if [ "$(git rev-parse -q --verify "origin/$PILOT_BRANCH" || true)" = "$BUMP_SHA" ]; then
    act git push -q origin "$back:refs/heads/$PILOT_BRANCH" || log "WARNING: $PILOT_BRANCH moved during the rollback: merge $DEPLOY_MAIN into it by hand"
  else
    log "rollback: $PILOT_BRANCH moved since the release; only $DEPLOY_MAIN is rolled back (merge $DEPLOY_MAIN into $PILOT_BRANCH)"
  fi
fi
dry && exit 0
wait_synced "$back"
rollout
smoke
log "rollback: back at portal $PREV_PORTAL, workspace $PREV_WORKSPACE ($(short "$back"))"
