#!/usr/bin/env bash
# The release gate on a CLEAN COPY of a commit (not the working tree): npm ci, typecheck, web build, the server suite.
#   scripts/gate.sh [commit]        default HEAD; logs in /tmp/gate-<sha>.logs, one summary line per step
# GATE_CONCURRENCY (default 2): test files run at once; this workspace has 4 CPUs and 8 GiB, so keep it low. The tests that need a
# Docker daemon are skipped here (CLAUDEPILOT_DOCKER_TESTS unset): they run on a machine with Docker. The suite runs from `env -i`:
# no credentials, no kubeconfig, no Claude profile reach a test. GATE_TEST_TIMEOUT_MS (default 600000): a test or file that takes longer fails.
# GATE_FILES (default every src/**/*.test.ts): the server test files to run, space separated, relative to apps/server (one file in a Job, say).
# Every failing test's own report (its error, expected and actual, the stack) goes to <logs>/failures.txt; a file that passes when rerun
# alone is written to the summary as flaky, one line per test that failed in the full run (`<file>;<test name>`: the portal opens a ticket per test).
# GATE_STEPS (default typecheck,web-build,server-suite): which steps run after npm ci (scripts/gate-job.sh runs only typecheck,web-build, say).
# The verdict: scripts/gate-verdict.sh logs <logs dir>.
set -u
sha=$(git rev-parse --short "${1:-HEAD}")
dir=${GATE_DIR:-/tmp/gate-$sha}; logs=$dir.logs
rm -rf "$dir" "$logs"; mkdir -p "$dir" "$logs" "$dir/.home"
git archive "$sha" | tar -x -C "$dir"
cd "$dir" || exit 1
step() { local name=$1; shift; local t0; t0=$(date +%s); "$@" > "$logs/$name.log" 2>&1; local rc=$?; echo "$name rc=$rc $(( $(date +%s) - t0 ))s" | tee -a "$logs/SUMMARY.txt"; return $rc; }
export NODE_AUTH_TOKEN=${NODE_AUTH_TOKEN:-$(gh auth token 2>/dev/null || true)}
step npm-ci npm ci --no-audit --no-fund || { echo "npm ci failed: see $logs/npm-ci.log"; exit 1; }
# Timing tests wait CP_TEST_TIME_SCALE times longer when the machine is busier than it has CPUs (load average above the CPU count): 1 to 6, rounded up.
scale=$(awk -v l="$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)" -v c="$(nproc 2>/dev/null || echo 1)" 'BEGIN { s = (l > c) ? int(l / c) + 1 : 1; if (s > 6) s = 6; print s }')
clean=(env -i "PATH=$PATH" "HOME=$dir/.home" LANG=C.UTF-8 PORTAL_K8S_ENABLED=false "CP_TEST_TIME_SCALE=$scale" NODE_OPTIONS=--disable-warning=ExperimentalWarning)
steps=",${GATE_STEPS:-typecheck,web-build,server-suite},"
wants() { [[ $steps == *",$1,"* ]]; }
if wants typecheck; then step typecheck "${clean[@]}" nice -n 10 npm run typecheck; fi
if wants web-build; then step web-build "${clean[@]}" nice -n 10 npm run build -w @portal/web; fi
# The server suite. A test, or a whole test file, that runs longer than GATE_TEST_TIMEOUT_MS (default 10 minutes) FAILS instead of blocking the run
# for ever (connect/agent/rekey.test.ts hung 9 to 26 minutes inside the full suite, twice, and passes alone in seconds), and the files with a failing
# or timed-out test run once more, alone: a test that hangs or races under load passes alone (the known ones are in docs/open-items.md). The verdict
# is the LAST summary in the log, the rerun's when there was one; node counts a timed-out file as "cancelled", not "fail", so read both.
run_suite() {
  local timeout=${GATE_TEST_TIMEOUT_MS:-600000} first="$logs/server-suite.first" files rc tests=('src/**/*.test.ts')
  # node expands the glob itself (bash would not descend with **); GATE_FILES are plain paths.
  [ -z "${GATE_FILES:-}" ] || read -ra tests <<< "$GATE_FILES"
  ( cd apps/server && "${clean[@]}" nice -n 10 node --import tsx --test --test-force-exit --test-timeout="$timeout" --test-concurrency="${GATE_CONCURRENCY:-2}" "${tests[@]}" ) > "$first" 2>&1
  rc=$?
  cat "$first"
  [ "$rc" = 0 ] && return 0
  files=$( { awk '/^not ok /{f=1; next} f && /location:/{print; f=0} /^ok /{f=0}' "$first" | sed -E "s#.*location: '(/[^']*/apps/server/)?([^:']+\.ts):.*#\2#"; sed -nE 's/^not ok [0-9]+ - (src\/.*\.test\.ts)$/\1/p' "$first"; } | grep -E '^src/.*\.test\.ts$' | sort -u )
  [ -n "$files" ] || return "$rc"
  printf '\n=== the files with a failing or timed-out test, once more and alone:\n%s\n' "$files"
  ( cd apps/server && "${clean[@]}" nice -n 10 node --import tsx --test --test-force-exit --test-timeout="$timeout" --test-concurrency=1 $files )
  rc=$?
  if [ "$rc" = 0 ]; then
    echo "server-suite-rerun: passed alone: $(echo $files)" >> "$logs/SUMMARY.txt"
    bash "$dir/scripts/gate-verdict.sh" flaky "$first" | sed 's/^/server-suite-flaky: /' >> "$logs/SUMMARY.txt"
  fi
  return "$rc"
}

wants server-suite || exit 0
step server-suite run_suite
grep -E '^# (tests|pass|fail|cancelled|skipped)' "$logs/server-suite.log" | tr '\n' ' '; echo
bash "$(dirname "$0")/gate-verdict.sh" failures "$logs/server-suite.log" > "$logs/failures.txt"
grep '^not ok' "$logs/server-suite.log" | head -5 || true
