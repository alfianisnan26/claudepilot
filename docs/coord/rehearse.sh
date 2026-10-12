#!/usr/bin/env bash
# Rehearses the migration of the deployed portal's data (a COPY from the backup) with the new code from the clean copy. Usage: rehearse.sh <sha> <backup-ts>
# Prints counts and statuses only (never row contents, secrets or cookies). Cleans up the copy's secrets afterwards (keeps the logs).
set -u
SHA=$1; TS=$2; B=/tmp/pre-deploy-backup-$TS; R=/tmp/release-$SHA; C=/tmp/claude-1000/-workspaces-claudepilot/cad07383-74ea-4f0a-88e5-fc51c5b7a125/scratchpad/coord
umask 077; rm -rf "$B/pre" "$B/rehearsal"; mkdir -p "$B/pre" "$B/rehearsal/home"
tar xzf "$B/portal-volumes.tgz" -C "$B/pre"; tar xzf "$B/portal-volumes.tgz" -C "$B/rehearsal"; rm -f "$B/rehearsal/data/portal.lock"
echo "old schema (user_version of the backup): $(cd $R/apps/server && node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$B/pre/data/portal.db');console.log(d.prepare('PRAGMA user_version').get().user_version)" 2>/dev/null)"
cd $R/apps/server
env -i PATH=$PATH HOME=$B/rehearsal/home LANG=C.UTF-8 PORTAL_K8S_ENABLED=false PORTAL_CONNECT_ENABLED=false PORTAL_PORT=3399 PORTAL_DATA_DIR=$B/rehearsal/data PORTAL_SECRET_KEY_FILE=$B/rehearsal/secrets/portal_secret_key PORTAL_SERVER_CODE=12345678 NODE_OPTIONS=--disable-warning=ExperimentalWarning npx tsx src/index.ts > "$B/rehearsal.log" 2>&1 &
PID=$!
up=0; for i in $(seq 1 60); do curl -s -m 2 -o /dev/null http://127.0.0.1:3399/healthz && { up=1; break; }; sleep 1; done
echo "booted on the migrated copy: $([ $up = 1 ] && echo YES || echo NO)"
if [ $up = 1 ]; then
  J=$B/jar; curl -s -m 5 -o /dev/null -w 'GET /login: %{http_code}\n' http://127.0.0.1:3399/login
  curl -s -m 5 -c $J -o /dev/null -w 'POST /api/login: %{http_code}\n' -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:3399' -d '{"code":"12345678"}' http://127.0.0.1:3399/api/login
  for p in /api/session /api/workspaces /api/settings /api/tickets /api/chat/sessions /api/connect/targets /api/claudeusage /api/notify /api/glance /api/repos; do curl -s -m 8 -b $J -o /dev/null -w "GET $p: %{http_code}\n" http://127.0.0.1:3399$p; done
fi
kill -TERM $PID 2>/dev/null; sleep 3; kill -9 $PID 2>/dev/null; pkill -P $PID 2>/dev/null
echo "--- row counts old vs migrated:"; node $C/counts-compare.mjs "$B/pre/data/portal.db" "$B/rehearsal/data/portal.db"; echo "counts rc=$?"
echo "--- log lines with error/fatal (first 8):"; grep -i -E 'error|fatal|exception' "$B/rehearsal.log" | cut -c1-200 | head -8
rm -rf "$B/rehearsal/secrets" "$B/rehearsal/data" "$B/pre"
