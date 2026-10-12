#!/usr/bin/env bash
# Consistent backup of the deployed portal's data and secrets volumes (container paused for the seconds the tar takes), kept in the sandbox (0600) AND in a host volume.
# Usage: pre-deploy-backup.sh <ts>   Output dir: /tmp/pre-deploy-backup-<ts>
set -eu
TS=$1; B=/tmp/pre-deploy-backup-$TS; H="docker --context host"; IMG=claudepilot-portal:latest
umask 077; mkdir -p "$B"
$H pause claudepilot-portal-1 >/dev/null
trap '$H unpause claudepilot-portal-1 >/dev/null 2>&1 || true' EXIT
$H run --rm --entrypoint tar -v claudepilot_portal-data:/data:ro -v claudepilot_portal-secrets:/secrets:ro $IMG czf - -C / data secrets > "$B/portal-volumes.tgz"
$H unpause claudepilot-portal-1 >/dev/null; trap - EXIT
sha256sum "$B/portal-volumes.tgz" | cut -d' ' -f1 > "$B/portal-volumes.tgz.sha256"
tar tzf "$B/portal-volumes.tgz" | grep -c . | sed 's/^/entries in backup: /'
$H volume create claudepilot-backup-$TS >/dev/null
$H run --rm -i --entrypoint sh -v claudepilot-backup-$TS:/backup $IMG -c 'cat > /backup/portal-volumes.tgz && chmod 600 /backup/portal-volumes.tgz' < "$B/portal-volumes.tgz"
echo "backup ok: $B and host volume claudepilot-backup-$TS (restore: extract the tgz into the data and secrets volumes with the portal stopped)"
