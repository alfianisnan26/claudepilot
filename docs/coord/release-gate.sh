#!/usr/bin/env bash
# Release gate on a CLEAN COPY of a commit (COMMIT-DEPLOY.md section 3). Usage: release-gate.sh <sha>
# Logs: /tmp/release-<sha>.logs/*.log, summary in /tmp/release-<sha>.logs/SUMMARY.txt. NODE_AUTH_TOKEN comes from `gh auth token` and is never printed.
set -u
SHA=$1; R=/tmp/release-$SHA; L=/tmp/release-$SHA.logs
rm -rf "$R" "$L"; mkdir -p "$R" "$L"
cd /workspaces/claudepilot && git archive "$SHA" | tar -x -C "$R"
cd "$R" || exit 1
step() { local name=$1; shift; local t0=$(date +%s); "$@" > "$L/$name.log" 2>&1; local rc=$?; echo "$name rc=$rc $(( $(date +%s) - t0 ))s" >> "$L/SUMMARY.txt"; return $rc; }
CLEAN="env -i PATH=$PATH HOME=/tmp/relhome-$SHA LANG=C.UTF-8 PORTAL_K8S_ENABLED=false NODE_OPTIONS=--disable-warning=ExperimentalWarning"
mkdir -p /tmp/relhome-$SHA
NODE_AUTH_TOKEN=$(gh auth token) step npm-ci npm ci --no-audit --no-fund || { echo "ABORT: npm ci failed" >> "$L/SUMMARY.txt"; exit 1; }
step typecheck $CLEAN nice -n 10 npm run typecheck
step web-build $CLEAN nice -n 10 npm run build -w @portal/web
step server-suite bash -c "cd apps/server && $CLEAN nice -n 10 node --import tsx --test --test-concurrency=3 'src/**/*.test.ts'"
echo "DONE $(date -u +%H:%M:%SZ)" >> "$L/SUMMARY.txt"
