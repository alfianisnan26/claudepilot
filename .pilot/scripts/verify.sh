#!/usr/bin/env bash
# The verify job: the release is live and well. Argo CD has the app Synced and Healthy at the pushed commit, the portal's rollout finished
# with the new image, /healthz and /login answer through the in-cluster service, and the portal's log has no fatal line. A failure here
# starts the rollback job.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# shellcheck source=.pilot/scripts/lib.sh
. .pilot/scripts/lib.sh

PUSHED=0 BUMP_SHA='' NEW_PORTAL=''
# shellcheck source=/dev/null
[ -f "$OUT/release.env" ] && . "$OUT/release.env"
if dry; then
  log "[dry-run] would wait for Argo CD ($DEPLOY_ARGO_NAMESPACE/$DEPLOY_ARGO_APP) to be Synced and Healthy${BUMP_SHA:+ at $(short "$BUMP_SHA")}, then: rollout status, $DEPLOY_URL/healthz and /login, the portal's log"
  log "now: $(kubectl -n "$DEPLOY_ARGO_NAMESPACE" get application "$DEPLOY_ARGO_APP" -o jsonpath='{.status.sync.revision} {.status.sync.status} {.status.health.status}' 2>&1 | cut -c1-120 || true)"
  exit 0
fi
want=''
if [ "$PUSHED" = 1 ]; then want=$BUMP_SHA; else log "verify: nothing was released; checking the cluster as it is"; fi
wait_synced "$want"
rollout
if [ -n "$NEW_PORTAL" ]; then
  image=$(kubectl -n "$DEPLOY_NAMESPACE" get "deploy/$DEPLOY_DEPLOYMENT" -o jsonpath='{.spec.template.spec.containers[0].image}')
  [ "${image##*:}" = "$NEW_PORTAL" ] || die "the portal runs $image, not $NEW_PORTAL"
  log "image: $image"
fi
smoke
scan_logs
log "verify: live and well${want:+ at $(short "$want")}"
