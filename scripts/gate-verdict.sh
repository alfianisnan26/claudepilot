#!/usr/bin/env bash
# The verdict of a gate run, in one place (the pipeline's gate job, the in-cluster gate Job and scripts/gate-job.sh read it the same way).
#   scripts/gate-verdict.sh logs <logs dir> [steps]   the logs of scripts/gate.sh: every step ran with rc=0, and the server suite's LAST summary
#                                                     (the rerun of the failing files alone, when there was one) has 0 failing and 0 timed-out
#                                                     tests (node counts a timed-out file as "cancelled", not "fail"). steps: as GATE_STEPS.
#   scripts/gate-verdict.sh joblog <file>             the log of a gate Job: its last `GATE-VERDICT:` line.
# Prints one line, `GATE-VERDICT: green` or `GATE-VERDICT: red: <why>` (plus a note when a file passed only alone), and exits 0 or 1.
set -u
green() { echo "GATE-VERDICT: green"; exit 0; }
red() { echo "GATE-VERDICT: red: $*"; exit 1; }
case ${1:-} in
  logs)
    logs=${2:?logs dir}; steps=${3:-${GATE_STEPS:-typecheck,web-build,server-suite}}
    [ -f "$logs/SUMMARY.txt" ] || red "the gate left no summary"
    for step in npm-ci ${steps//,/ }; do
      grep -q "^$step rc=0 " "$logs/SUMMARY.txt" || red "$step failed"
    done
    case ",$steps," in
      *,server-suite,*)
        fails=$(grep -E '^# fail [0-9]+' "$logs/server-suite.log" 2>/dev/null | tail -n 1 | awk '{print $3}')
        cancelled=$(grep -E '^# cancelled [0-9]+' "$logs/server-suite.log" 2>/dev/null | tail -n 1 | awk '{print $3}')
        if [ "${fails:-x}" != 0 ] || [ "${cancelled:-0}" != 0 ]; then red "the server suite has ${fails:-an unknown number of} failing and ${cancelled:-0} timed-out tests"; fi
        grep '^server-suite-rerun:' "$logs/SUMMARY.txt" | sed 's/^/note: /'
        ;;
    esac
    green
    ;;
  joblog)
    line=$(grep -E '^GATE-VERDICT: ' "${2:?job log}" 2>/dev/null | tail -n 1)
    case $line in
      'GATE-VERDICT: green') green ;;
      'GATE-VERDICT: red'*) red "${line#GATE-VERDICT: red: }" ;;
      *) red "the job gave no verdict" ;;
    esac
    ;;
  *) echo "usage: scripts/gate-verdict.sh logs <dir> [steps] | joblog <file>" >&2; exit 2 ;;
esac
