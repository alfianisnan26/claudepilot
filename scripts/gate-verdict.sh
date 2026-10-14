#!/usr/bin/env bash
# The verdict of a gate run, in one place (the pipeline's gate job, the in-cluster gate Job and scripts/gate-job.sh read it the same way).
#   scripts/gate-verdict.sh logs <logs dir> [steps]   the logs of scripts/gate.sh: every step ran with rc=0, and the server suite's LAST summary
#                                                     (the rerun of the failing files alone, when there was one) has 0 failing and 0 timed-out
#                                                     tests (node counts a timed-out file as "cancelled", not "fail"). steps: as GATE_STEPS.
#                                                     A `context-pack` line (any steps) must be rc=0 too.
#   scripts/gate-verdict.sh joblog <file>             the log of a gate Job: its last `GATE-VERDICT:` line.
#   scripts/gate-verdict.sh failures <suite log>      every failing test with its own report (TAP's YAML block: error, expected, actual,
#                                                     location, stack), at most 80 lines each and 600 in all; prints, no verdict.
#   scripts/gate-verdict.sh flaky <suite log>         every failing test (not a whole file) as `<file>;<test name>`, the file from its report's
#                                                     location, at most 10, one per line; prints, no verdict. scripts/gate.sh writes them to the
#                                                     summary as `server-suite-flaky:` when the rerun passed, and the portal opens a ticket per test.
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
    # The context pack check (T-292) runs whatever the steps; a gate from before it left no line.
    if grep -q '^context-pack rc=' "$logs/SUMMARY.txt" && ! grep -q '^context-pack rc=0 ' "$logs/SUMMARY.txt"; then
      red "docs/context-pack.md is stale (run scripts/context-pack.sh and commit it)"
    fi
    case ",$steps," in
      *,server-suite,*)
        fails=$(grep -E '^# fail [0-9]+' "$logs/server-suite.log" 2>/dev/null | tail -n 1 | awk '{print $3}')
        cancelled=$(grep -E '^# cancelled [0-9]+' "$logs/server-suite.log" 2>/dev/null | tail -n 1 | awk '{print $3}')
        if [ "${fails:-x}" != 0 ] || [ "${cancelled:-0}" != 0 ]; then red "the server suite has ${fails:-an unknown number of} failing and ${cancelled:-0} timed-out tests"; fi
        grep '^server-suite-rerun:' "$logs/SUMMARY.txt" | sed 's/^/note: /'
        grep '^server-suite-flaky: .' "$logs/SUMMARY.txt" | sed 's/^server-suite-flaky: /note: flaky, passed on rerun: /'
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
  failures)
    awk '
      match($0, /^ *not ok /) { ind = RLENGTH - 7; on = 1; n = 0; print ""; print; next }
      on { n++; if (n <= 80) print; if ($0 ~ /^ *\.\.\.$/ && match($0, /^ */) && RLENGTH == ind + 2) on = 0 }
    ' "${2:?suite log}" 2>/dev/null | head -n 600
    exit 0
    ;;
  flaky)
    awk -v q="'" '
      match($0, /^ *not ok [0-9]+ - /) { n = substr($0, RLENGTH + 1); if (n ~ /\.test\.ts$/) n = ""; next }
      /^ *ok [0-9]+ - / { n = ""; next }
      n != "" && /location: / { l = $0; sub(".*location: " q, "", l); sub(":[0-9]+:[0-9]+" q ".*$", "", l); sub(".*/apps/server/", "", l); print l ";" n; n = "" }
    ' "${2:?suite log}" 2>/dev/null | grep -E '^src/[^;]*\.test\.ts;.' | sort -u | head -n 10
    exit 0
    ;;
  *) echo "usage: scripts/gate-verdict.sh logs <dir> [steps] | joblog <file> | failures <suite log> | flaky <suite log>" >&2; exit 2 ;;
esac
