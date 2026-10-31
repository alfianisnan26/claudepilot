#!/usr/bin/env bash
# The nightly whole gate (.pilot/nightly.yml, D-106): scripts/gate-job.sh on the run's commit with every step and every test, recorded as a
# full result when green. Skipped when a green full result already covers the tree (scripts/gate-select.mjs --reuse-only --kinds full).
# Waits (NIGHTLY_WAIT_S, default 3600) while another claudepilot gate Job is active, then runs anyway. Red: one loud line and exit 1.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# shellcheck source=.pilot/scripts/lib.sh
. .pilot/scripts/lib.sh
sha=$(run_sha)
ns=${GATE_NAMESPACE:-$DEPLOY_NAMESPACE}
records="${TMPDIR:-/tmp}/pilot-nightly-records-${PILOT_RUN_ID:-local}"
trap 'rm -f "$records"' EXIT
bash scripts/gate-record.sh list >"$records" 2>/dev/null || : >"$records"
plan=$(node scripts/gate-select.mjs --head "$sha" --records "$records" --kinds full --reuse-only 2>/dev/null || true)
if [ "$(printf '%s\n' "$plan" | sed -n 's/^MODE=//p')" = reuse ]; then
  log "nightly: already green in full: $(printf '%s\n' "$plan" | sed -n 's/^REASON=//p')"
  exit 0
fi
if dry; then
  log "[dry-run] would run: scripts/gate-job.sh $(short "$sha") (the whole gate)"
  exit 0
fi
# Two gates at once slow each other on the same node: wait for the one that runs.
deadline=$((SECONDS + ${NIGHTLY_WAIT_S:-3600}))
while :; do
  active=$(kubectl -n "$ns" get jobs -l app=claudepilot-gate -o jsonpath='{range .items[?(@.status.active)]}{.metadata.name}{"\n"}{end}' 2>/dev/null | grep -c . || true)
  [ "${active:-0}" = 0 ] && break
  if [ "$SECONDS" -ge "$deadline" ]; then log "nightly: $active gate Job(s) still active after ${NIGHTLY_WAIT_S:-3600}s: starting anyway"; break; fi
  log "nightly: $active other gate Job(s) active: waiting"
  sleep "${NIGHTLY_POLL_S:-60}"
done
export GATE_JOB_LOG="${TMPDIR:-/tmp}/pilot-nightly-${PILOT_RUN_ID:-local}.log" GATE_JOB_BY=nightly
trap 'rm -f "$records" "$GATE_JOB_LOG"' EXIT
rc=0
bash scripts/gate-job.sh "$sha" 2>&1 | mask || rc=$?
if [ "$rc" != 0 ]; then
  log "=================================================================="
  log "NIGHTLY FULL GATE RED at $(short "$sha") on $(src_branch): the change-scoped deploy gates since the last green full gate missed it."
  log "Fix integration before the next deploy; a deploy can run the whole gate with input full_gate=true."
  log "=================================================================="
  die "nightly: red at $(short "$sha") (the job's verdict above)"
fi
log "nightly: green at $(short "$sha") (the whole gate)"
