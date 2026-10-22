#!/usr/bin/env bash
# The gate job: scripts/gate.sh (npm ci, typecheck, web build, web tests, the server suite) on a clean copy of the run's commit, and its verdict
# (scripts/gate-verdict.sh). By default it runs as a Job in the cluster (scripts/gate-job.sh, T-37), on CPUs other than the workspace's;
# DEPLOY_GATE_IN_CLUSTER=false runs it here instead. Input gate=false skips it; a dry run only says what it would run.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# shellcheck source=.pilot/scripts/lib.sh
. .pilot/scripts/lib.sh

if [ "${PILOT_INPUT_GATE:-true}" != true ]; then
  log "gate: skipped (input gate=false)"
  exit 0
fi
sha=$(run_sha)

if [ "${DEPLOY_GATE_IN_CLUSTER:-true}" = true ]; then
  if dry; then
    log "[dry-run] would run: scripts/gate-job.sh $(short "$sha")"
    exit 0
  fi
  export GATE_JOB_LOG="${TMPDIR:-/tmp}/pilot-gate-${PILOT_RUN_ID:-local}.log" GATE_JOB_BY=pipeline
  # A cancelled run's runner kills gate-job.sh before its trap: its Job (and the token Secret it owns) would run on. Deploy runs never overlap
  # (concurrency group), so at the start every pipeline gate Job is a leftover; at the end, ours goes too.
  bash scripts/gate-job-stop.sh --by pipeline | grep '^stopped ' | sed 's/^/gate: leftover /' || true
  trap 'bash scripts/gate-job-stop.sh --by pipeline >/dev/null 2>&1 || true; rm -f "$GATE_JOB_LOG"' EXIT
  trap 'exit 143' TERM INT
  rc=0
  bash scripts/gate-job.sh "$sha" 2>&1 | mask || rc=$?
  [ "$rc" = 0 ] || die "gate: red at $(short "$sha") (the job's verdict above)"
  log "gate: green at $(short "$sha")"
  exit 0
fi

if dry; then
  log "[dry-run] would run: scripts/gate.sh $(short "$sha")"
  exit 0
fi
export GATE_DIR="${TMPDIR:-/tmp}/pilot-gate-${PILOT_RUN_ID:-local}"
logs="$GATE_DIR.logs"
trap 'rm -rf "$GATE_DIR" "$logs"' EXIT
bash scripts/gate.sh "$sha" 2>&1 | mask
for step in npm-ci typecheck web-build web-tests server-suite; do
  if ! grep -q "^$step rc=0 " "$logs/SUMMARY.txt" 2>/dev/null; then
    log "--- the end of $step's log:"
    tail -n 40 "$logs/$step.log" 2>/dev/null | mask || true
    break
  fi
done
if [ -s "$logs/failures.txt" ]; then log "--- every failing test's own report:"; mask < "$logs/failures.txt"; fi
verdict=$(bash scripts/gate-verdict.sh logs "$logs") || die "gate: ${verdict#GATE-VERDICT: red: }"
printf '%s\n' "$verdict" | grep '^note: ' | sed 's/^note: /gate: /' || true
log "gate: green at $(short "$sha")"
