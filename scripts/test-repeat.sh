#!/usr/bin/env bash
# test-repeat.sh [-n RUNS] [--hogs N|cpus] [--grep REGEX] -- <command...>: a flaky test proved fixed (T-324, T-297). Runs the command RUNS times
# (default 30), optionally beside N busy loops (`cpus`: one per CPU), and prints one line per failed run (the command's last failing lines),
# the --grep matches of each run (e.g. a measured number) and one result line:
#   repeat runs=30 pass=30 fail=0 skipped=0 hogs=4 cpus=4 load=5.12
# `skipped`: runs whose node:test summary counted a skipped test (a skip is not a pass of the thing measured). Exit 0 when every run passed,
# 1 when one failed, 2 for a usage error. The hogs are stopped on exit. Run it through scripts/job-run.sh: it is a heavy job by design.
set -u
runs=30; hogs=0; grep_re=
while [ $# -gt 0 ]; do
  case "$1" in
    -n) runs=${2:-}; shift 2 ;;
    --hogs) hogs=${2:-}; shift 2 ;;
    --grep) grep_re=${2:-}; shift 2 ;;
    --) shift; break ;;
    *) echo "test-repeat.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$#" -gt 0 ] || { echo "usage: test-repeat.sh [-n RUNS] [--hogs N|cpus] [--grep REGEX] -- <command...>" >&2; exit 2; }
cpus=$(nproc 2>/dev/null || echo 1)
[ "$hogs" = cpus ] && hogs=$cpus
case "$runs$hogs" in ''|*[!0-9]*) echo "test-repeat.sh: RUNS and N are numbers" >&2; exit 2 ;; esac

pids=()
stop_hogs() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; pids=(); }
trap stop_hogs EXIT
for ((i = 0; i < hogs; i++)); do
  sh -c 'while :; do :; done' &
  pids+=($!)
done
[ "$hogs" -gt 0 ] && sleep 3 # let the hogs take the CPUs before the first run

log=$(mktemp /tmp/test-repeat-XXXXXX.log)
pass=0; fail=0; skipped=0
for ((r = 1; r <= runs; r++)); do
  if "$@" >"$log" 2>&1; then pass=$((pass + 1)); else
    fail=$((fail + 1))
    echo "run $r failed: $(grep -E '^not ok|^ *not ok|Error|timed out' "$log" | head -4 | tr '\n' ' ' | cut -c1-400)"
  fi
  grep -qE '^# skipped [1-9]' "$log" && skipped=$((skipped + 1))
  [ -n "$grep_re" ] && grep -oE "$grep_re" "$log" | head -3 | sed "s/^/run $r: /"
done
rm -f "$log"
load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo '?')
stop_hogs
echo "repeat runs=$runs pass=$pass fail=$fail skipped=$skipped hogs=$hogs cpus=$cpus load=$load"
[ "$fail" -eq 0 ]
