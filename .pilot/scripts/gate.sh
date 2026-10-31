#!/usr/bin/env bash
# The gate job: scripts/gate.sh (npm ci, typecheck, web build, web tests, the server suite) on a clean copy of the run's commit, and its verdict
# (scripts/gate-verdict.sh). By default it runs as a Job in the cluster (scripts/gate-job.sh, T-37), on CPUs other than the workspace's;
# DEPLOY_GATE_IN_CLUSTER=false runs it here instead (always the whole gate). Input gate=false skips it; a dry run only says what it would run.
# In the cluster it is change-scoped (D-106): see below; input full_gate=true runs the whole gate.
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
  # D-106: change-scoped. scripts/gate-select.mjs decides from the green results recorded in the cluster (scripts/gate-record.sh): reuse a
  # green result whose tree differs only in documents nothing reads; else typecheck always, plus what the change since the last green gated
  # commit on main reaches (web build and tests, the server test files through the import graph); the whole gate for shared core, an
  # unknown base or graph, or input full_gate. The plan and its reasons are in the log.
  ensure_origin
  records="${TMPDIR:-/tmp}/pilot-gate-records-${PILOT_RUN_ID:-local}"
  bash scripts/gate-record.sh list >"$records" 2>/dev/null || : >"$records"
  full=()
  [ "${PILOT_INPUT_FULL_GATE:-false}" = true ] && full=(--full)
  plan=$(node scripts/gate-select.mjs --head "$sha" --base-ref "origin/$DEPLOY_MAIN" --records "$records" "${full[@]}" 2>"$records.why") || plan="MODE=full
REASON=the selection could not run"
  rm -f "$records"
  val() { printf '%s\n' "$plan" | sed -n "s/^$1=//p" | head -n 1; }
  mode=$(val MODE) reason=$(val REASON) base=$(val BASE) reused=$(val REUSED) steps=$(val STEPS) files=$(val FILES) changed=$(val CHANGED)
  case $mode in full | scoped | reuse) ;; *) mode=full reason="the selection said nothing usable" ;; esac
  log "gate: scope $mode: $reason"
  [ -z "$base" ] || log "gate: base $(short "$base"), the last green gated commit on $DEPLOY_MAIN; changed: $(wc -w <<<"$changed" | tr -d ' ') file(s): $(cut -c1-600 <<<"$changed")"
  if [ "$mode" = scoped ]; then
    log "gate: steps $steps; server test files ($(val SERVER_TESTS) of $(val SERVER_TOTAL)): $(cut -c1-1500 <<<"$files")"
    grep -v ': changed$' "$records.why" 2>/dev/null | head -n 60 | sed 's/^gate-select: /gate: why /' || true
  fi
  rm -f "$records.why"
  if [ "$mode" = reuse ]; then
    log "gate: reused the green result of $(short "$reused"); the trees differ only in: ${changed:-nothing}"
    if dry; then
      log "[dry-run] would run: scripts/context-pack.sh --check $(short "$sha") and record a reuse"
      exit 0
    fi
    # The context pack's freshness is checked in every gate: here in the workspace (a git read, nothing heavy).
    [ ! -f scripts/context-pack.sh ] || bash scripts/context-pack.sh --repo . --check "$sha" || die "gate: docs/context-pack.md is stale at $(short "$sha") (run scripts/context-pack.sh and commit it)"
    GATE_JOB_BY=pipeline bash scripts/gate-record.sh write "$sha" reuse "$reused" || true
    log "gate: green at $(short "$sha") (reused $(short "$reused"))"
    exit 0
  fi
  args=("$sha")
  if [ "$mode" = scoped ]; then
    args+=("$steps" "$files")
    export GATE_RECORD_KIND=scoped GATE_RECORD_BASE="$base"
  fi
  if dry; then
    log "[dry-run] would run: scripts/gate-job.sh $(short "$sha")${steps:+ $steps}${files:+ ($(wc -w <<<"$files" | tr -d ' ') server test files)}"
    exit 0
  fi
  export GATE_JOB_LOG="${TMPDIR:-/tmp}/pilot-gate-${PILOT_RUN_ID:-local}.log" GATE_JOB_BY=pipeline
  # A cancelled run's runner kills gate-job.sh before its trap: its Job (and the token Secret it owns) would run on. Deploy runs never overlap
  # (concurrency group), so at the start every pipeline gate Job is a leftover; at the end, ours goes too.
  bash scripts/gate-job-stop.sh --by pipeline | grep '^stopped ' | sed 's/^/gate: leftover /' || true
  trap 'bash scripts/gate-job-stop.sh --by pipeline >/dev/null 2>&1 || true; rm -f "$GATE_JOB_LOG"' EXIT
  trap 'exit 143' TERM INT
  rc=0
  bash scripts/gate-job.sh "${args[@]}" 2>&1 | mask || rc=$?
  [ "$rc" = 0 ] || die "gate: red at $(short "$sha") (the job's verdict above)"
  log "gate: green at $(short "$sha") ($mode)"
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
