#!/usr/bin/env bash
# Deploys the portal image built from the clean copy /tmp/release-<sha> to the Mac Docker (context host) behind the existing Caddy.
# Usage: deploy.sh <sha> <backup-ts>   Steps: keep the running image as :previous, build, recreate ONLY the portal, wait healthy, read-only smoke test.
# Never prints secrets (NODE_AUTH_TOKEN comes from `gh auth token`; deploy/.env is only passed to compose as --env-file).
set -u
SHA=$1; BTS=$2; R=/tmp/release-$SHA; H="docker --context host"
COMPOSE="docker --context host compose -p claudepilot -f $R/deploy/compose.yaml --env-file /workspaces/claudepilot/deploy/.env"
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
RUNNING_IMG=$($H inspect -f '{{.Image}}' claudepilot-portal-1 | cut -c8-19); log "running image before: $RUNNING_IMG"
$H tag claudepilot-portal:previous claudepilot-portal:prev2 2>/dev/null || true
$H tag claudepilot-portal:latest claudepilot-portal:previous && log "tagged the running image as claudepilot-portal:previous"
log "building (portal only)"
NODE_AUTH_TOKEN=$(gh auth token) $COMPOSE build portal > /tmp/deploy-$SHA-build.log 2>&1 || { log "BUILD FAILED (nothing changed on the host)"; tail -5 /tmp/deploy-$SHA-build.log | cut -c1-200; exit 10; }
NEW_IMG=$($H images --format '{{.ID}}' claudepilot-portal:latest | head -1); $H tag claudepilot-portal:latest claudepilot-portal:$SHA; log "built image $NEW_IMG tagged claudepilot-portal:$SHA"
log "recreating the portal container only"
NODE_AUTH_TOKEN=$(gh auth token) $COMPOSE up -d --no-build --no-deps portal > /tmp/deploy-$SHA-up.log 2>&1 || { log "UP FAILED"; tail -5 /tmp/deploy-$SHA-up.log | cut -c1-200; exit 11; }
for i in $(seq 1 60); do st=$($H inspect -f '{{.State.Health.Status}}' claudepilot-portal-1 2>/dev/null || echo none); [ "$st" = healthy ] && break; sleep 3; done
log "health: $st"
[ "$st" = healthy ] || { log "NOT HEALTHY: run rollback"; $H logs --tail 25 claudepilot-portal-1 2>&1 | cut -c1-220; exit 12; }
smoke() { $H exec claudepilot-portal-1 node -e "fetch('http://127.0.0.1:3000$1').then(async r=>{const t=await r.text();console.log('$1',r.status,t.length+' bytes');process.exit(r.status===$2?0:1)}).catch(e=>{console.log('$1 ERR',e.message);process.exit(1)})"; }
smoke /healthz 200 && smoke /login 200 && smoke / 200 || { log "SMOKE FAILED: run rollback"; exit 13; }
log "recent portal log (errors only):"; $H logs --tail 200 claudepilot-portal-1 2>&1 | grep -i -E 'error|fatal|migrat|fail' | cut -c1-200 | tail -8
log "DEPLOY OK image=$NEW_IMG previous=$RUNNING_IMG"
