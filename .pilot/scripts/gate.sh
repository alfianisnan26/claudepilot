#!/usr/bin/env bash
# The gate job: scripts/gate.sh (npm ci, typecheck, web build, the server suite) on a clean copy of the run's commit, and a verdict from its
# summary (gate.sh itself always exits 0 after the build steps). Input gate=false skips it; a dry run only says what it would run.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# shellcheck source=.pilot/scripts/lib.sh
. .pilot/scripts/lib.sh

if [ "${PILOT_INPUT_GATE:-true}" != true ]; then
  log "gate: skipped (input gate=false)"
  exit 0
fi
sha=$(run_sha)
if dry; then
  log "[dry-run] would run: scripts/gate.sh $(short "$sha")"
  exit 0
fi

export GATE_DIR="${TMPDIR:-/tmp}/pilot-gate-${PILOT_RUN_ID:-local}"
logs="$GATE_DIR.logs"
trap 'rm -rf "$GATE_DIR" "$logs"' EXIT
# Heavy jobs one at a time in this workspace: the development sessions take the same lock (docs/dev-sessions/README.md).
flock /tmp/heavy.lock bash scripts/gate.sh "$sha" 2>&1 | mask
[ -f "$logs/SUMMARY.txt" ] || die "the gate left no summary"
for step in npm-ci typecheck web-build server-suite; do
  if ! grep -q "^$step rc=0 " "$logs/SUMMARY.txt"; then
    log "--- the end of $step's log:"
    tail -n 40 "$logs/$step.log" 2>/dev/null | mask || true
    die "gate: $step failed"
  fi
done
fails=$(grep -E '^# fail [0-9]+' "$logs/server-suite.log" | tail -n 1 | awk '{print $3}')
[ "${fails:-x}" = 0 ] || die "gate: the server suite has ${fails:-an unknown number of} failing tests"
log "gate: green at $(short "$sha")"
