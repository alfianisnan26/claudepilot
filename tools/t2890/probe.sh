#!/usr/bin/env bash
# T-2890 probe (temporary, wip branch only): run one server test file ROUNDS x PAR times (PAR at once), the gate's way, and print each run's counts.
#   tools/t2890/probe.sh <file relative to apps/server> [rounds] [par] [extra node flags...]
set -u
file=$1; rounds=${2:-5}; par=${3:-4}; shift 3 || true
root=$(cd "$(dirname "$0")/../.." && pwd); out=${PROBE_OUT:-/tmp/t2890}; mkdir -p "$out"
registered=$(grep -cE '^(test|it|describe)\(' "$root/apps/server/$file")
echo "file=$file registered_top_level=$registered flags=${*:-none} cpus=$(nproc) load=$(cut -d' ' -f1-3 /proc/loadavg)"
one() {
  local i=$1; shift
  ( cd "$root/apps/server" && env -i "PATH=$PATH" "HOME=$out/home" LANG=C.UTF-8 PORTAL_K8S_ENABLED=false NODE_OPTIONS=--disable-warning=ExperimentalWarning \
      node --import tsx --test "$@" --test-reporter=tap --test-reporter-destination=stdout \
      --test-reporter="$root/tools/t2890/probe-reporter.mjs" --test-reporter-destination="$out/ev.$i.jsonl" "$file" ) > "$out/tap.$i" 2>&1
  local rc=$?
  local top; top=$(grep -cE '"t":"test:(pass|fail)","n":0' "$out/ev.$i.jsonl")
  echo "run $i rc=$rc $(grep -E '^# (tests|pass|fail|cancelled)' "$out/tap.$i" | tr '\n' ' ') top_level_events=$top plans=$(grep -c '"t":"test:plan","n":0' "$out/ev.$i.jsonl")"
}
mkdir -p "$out/home"
n=0
for ((r = 0; r < rounds; r++)); do
  for ((p = 0; p < par; p++)); do n=$((n + 1)); one "$n" "$@" & done
  wait
done
