#!/usr/bin/env bash
# The release job (environment production: it starts only after a person approved it in the portal). Puts the new tags of the portal and
# workspace images into deploy/k3s/portal.yaml on top of the run's commit and pushes that commit to main, the branch Argo CD follows: that
# push IS the deploy. It goes to main and to the run's branch in one atomic push, fast-forward only, so nothing is forced. When the run's
# branch moved on while the release waited for its approval (more commits on top of the run's commit), the release commit is merged into
# the branch's new tip, so the branch keeps them and main still gets exactly the approved commit plus the tags; a branch that no longer has
# the run's commit, or a merge that conflicts, stops the release with nothing changed (run #4, 2026-10-13, was refused for a status commit
# pushed during the approval). Leaves .pilot/out/release.env (what was pushed, the tags before) for verify and rollback, whatever happens.
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
commit "deploy: $what" "Released by the deploy pipeline: pilot CI run #${PILOT_RUN_NUMBER:-?} of $(short "$sha") on $(src_branch), approved in the portal.

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
refs=("$bump:refs/heads/$DEPLOY_MAIN")
if [ -n "${PILOT_BRANCH:-}" ] && [ "$PILOT_BRANCH" != "$DEPLOY_MAIN" ]; then
  branch_to=$bump
  git fetch -q origin "$PILOT_BRANCH" 2>/dev/null || true
  tip=$(git rev-parse -q --verify "origin/$PILOT_BRANCH^{commit}" 2>/dev/null || true)
  if [ -n "$tip" ] && ! git merge-base --is-ancestor "$tip" "$bump"; then
    git merge-base --is-ancestor "$sha" "$tip" ||
      die "$PILOT_BRANCH no longer has $(short "$sha") (it was rewritten since this run started): nothing was deployed"
    log "release: $PILOT_BRANCH moved on to $(short "$tip") since this run started: the release is merged into it"
    git checkout -q -B pilot-release-branch "$tip"
    gname=$(git config user.name || true)
    gemail=$(git config user.email || true)
    if ! git -c user.name="${gname:-ClaudePilot CI}" -c user.email="${gemail:-ci@claudepilot.invalid}" -c commit.gpgsign=false \
      merge -q --no-ff --no-edit -m "merge release $(short "$bump") ($what) into $PILOT_BRANCH" "$bump"; then
      git merge --abort 2>/dev/null || true
      die "the release does not merge cleanly into $PILOT_BRANCH at $(short "$tip"): nothing was deployed"
    fi
    branch_to=$(git rev-parse HEAD)
    git checkout -q pilot-release
    echo "BRANCH_SHA=$branch_to" >>"$rel"
  fi
  refs+=("$branch_to:refs/heads/$PILOT_BRANCH")
fi
log "release: $(short "$bump") ($what) to ${refs[*]#*:refs/heads/}"
act git push -q --atomic origin "${refs[@]}" || die "the push was refused (a branch moved since this run started?): nothing was deployed"
if dry; then
  log "release: dry run, nothing pushed"
  exit 0
fi
sed -i 's/^PUSHED=0$/PUSHED=1/' "$rel"
log "release: pushed $(short "$bump") to $DEPLOY_MAIN: Argo CD deploys it"
