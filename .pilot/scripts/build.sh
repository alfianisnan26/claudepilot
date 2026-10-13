#!/usr/bin/env bash
# The build job: each image the run asks for (input images), built IN the cluster by scripts/k3s-build.sh (kaniko; pushing from outside
# fails) from this commit on GitHub, with a new date-based tag. Leaves the tags in .pilot/out/build.env for the release job.
# The GitHub token: k3s-build.sh keeps it in a Secret for the build only and checks the build log for it; every line here passes `mask`.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# shellcheck source=.pilot/scripts/lib.sh
. .pilot/scripts/lib.sh

sha=$(run_sha)
images=$(parse_images "${PILOT_INPUT_IMAGES:-portal}")
mkdir -p "$OUT"
: >"$OUT/build.env"
if [ -z "$images" ]; then
  log "build: no images asked for"
  exit 0
fi
ensure_origin
git merge-base --is-ancestor "$sha" "origin/$(src_branch)" 2>/dev/null ||
  die "$(short "$sha") is not on $(src_branch) at $DEPLOY_GIT_REMOTE: push it there first (kaniko builds from GitHub)"
for what in $images; do
  tag=$(next_tag "$what")
  log "build: $what:$tag from $(short "$sha")"
  if dry; then
    log "[dry-run] would run: BUILD_BRANCH=$(src_branch) scripts/k3s-build.sh $what $tag $sha"
  else
    BUILD_BRANCH=$(src_branch) bash scripts/k3s-build.sh "$what" "$tag" "$sha" 2>&1 | mask
  fi
  printf '%s=%s\n' "$(tag_var "$what")" "$tag" >>"$OUT/build.env"
done
log "build: done ($(tr '\n' ' ' <"$OUT/build.env"))"
