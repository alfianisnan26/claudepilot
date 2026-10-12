#!/usr/bin/env bash
# Rolls the portal back to claudepilot-portal:previous. With "restore" as the 2nd argument also restores the data and secrets volumes from /tmp/pre-deploy-backup-<ts> (use when a migration already ran and the old image cannot read the data).
# Usage: rollback.sh <sha> [restore <backup-ts>]
set -u
SHA=$1; H="docker --context host"; R=/tmp/release-$SHA
COMPOSE="docker --context host compose -p claudepilot -f $R/deploy/compose.yaml --env-file /workspaces/claudepilot/deploy/.env"
$H tag claudepilot-portal:previous claudepilot-portal:latest
if [ "${2:-}" = restore ]; then
  B=/tmp/pre-deploy-backup-${3:?backup ts}/portal-volumes.tgz; [ -f "$B" ] || { echo "no backup file $B"; exit 2; }
  $H stop claudepilot-portal-1 >/dev/null 2>&1 || true
  $H run --rm -i --entrypoint sh -v claudepilot_portal-data:/data -v claudepilot_portal-secrets:/secrets claudepilot-portal:previous -c 'rm -rf /data/* /data/.[!.]* /secrets/* 2>/dev/null; tar xzf - -C /' < "$B"
fi
NODE_AUTH_TOKEN=x $COMPOSE up -d --no-build --no-deps --force-recreate portal
for i in $(seq 1 40); do st=$($H inspect -f '{{.State.Health.Status}}' claudepilot-portal-1 2>/dev/null || echo none); [ "$st" = healthy ] && break; sleep 3; done; echo "health after rollback: $st"
