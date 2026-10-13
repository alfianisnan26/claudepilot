#!/usr/bin/env bash
# The release gate on a CLEAN COPY of a commit (not the working tree): npm ci, typecheck, web build, the server suite.
#   scripts/gate.sh [commit]        default HEAD; logs in /tmp/gate-<sha>.logs, one summary line per step
# GATE_CONCURRENCY (default 2): test files run at once; this workspace has 4 CPUs and 8 GiB, so keep it low. The tests that need a
# Docker daemon are skipped here (CLAUDEPILOT_DOCKER_TESTS unset): they run on a machine with Docker. The suite runs from `env -i`:
# no credentials, no kubeconfig, no Claude profile reach a test.
set -u
sha=$(git rev-parse --short "${1:-HEAD}")
dir=${GATE_DIR:-/tmp/gate-$sha}; logs=$dir.logs
rm -rf "$dir" "$logs"; mkdir -p "$dir" "$logs" "$dir/.home"
git archive "$sha" | tar -x -C "$dir"
cd "$dir" || exit 1
step() { local name=$1; shift; local t0; t0=$(date +%s); "$@" > "$logs/$name.log" 2>&1; local rc=$?; echo "$name rc=$rc $(( $(date +%s) - t0 ))s" | tee -a "$logs/SUMMARY.txt"; return $rc; }
export NODE_AUTH_TOKEN=${NODE_AUTH_TOKEN:-$(gh auth token 2>/dev/null || true)}
step npm-ci npm ci --no-audit --no-fund || { echo "npm ci failed: see $logs/npm-ci.log"; exit 1; }
clean=(env -i "PATH=$PATH" "HOME=$dir/.home" LANG=C.UTF-8 PORTAL_K8S_ENABLED=false NODE_OPTIONS=--disable-warning=ExperimentalWarning)
step typecheck "${clean[@]}" nice -n 10 npm run typecheck
step web-build "${clean[@]}" nice -n 10 npm run build -w @portal/web
step server-suite bash -c "cd apps/server && ${clean[*]} nice -n 10 node --import tsx --test --test-concurrency=${GATE_CONCURRENCY:-2} 'src/**/*.test.ts'"
grep -E '^# (tests|pass|fail|skipped)' "$logs/server-suite.log" | tr '\n' ' '; echo
grep '^not ok' "$logs/server-suite.log" | head -5 || true
