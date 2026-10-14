#!/usr/bin/env bash
# The slice check (T-293, design v2 layer 3 "CHECK"): the typecheck plus the server test FILES a slice touched, no model, at most 20 lines out.
# The test files come from the git diff against a base (apps/server/src/qa/sliceCheck.ts maps the changed paths to test files); test files
# named on the command line are added (the fallback when the derivation finds none). The exit code is the first failing check's own rc.
#   flock /tmp/heavy.lock scripts/slice-check.sh [--base REF] [test-file ...]      base default origin/integration; files relative to
#   apps/server or to the repository root (src/qa/gateQuick.test.ts or apps/server/src/qa/gateQuick.test.ts)
# Wider checks are not its job: scripts/gate-quick.sh (whole areas) before integration is pushed, scripts/gate.sh before a deploy.
set -uo pipefail
root=$(git rev-parse --show-toplevel) || exit 2
cd "$root" || exit 2
base=origin/integration
if [ "${1:-}" = "--base" ]; then base=${2:?--base <ref>}; shift 2; fi
out=$(mktemp /tmp/slice-check-XXXXXX.out)
trap 'rm -f "$out"' EXIT
say() { printf '%s\n' "$*" >>"$out"; }
changed=''
if git rev-parse -q --verify "$base^{commit}" >/dev/null; then
  changed=$( { git diff --name-only "$base"...HEAD; git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u)
else
  say "slice-check: unknown base $base: named tests only"
fi
derived=$(printf '%s\n' "$changed" | node --import tsx --disable-warning=ExperimentalWarning apps/server/src/qa/sliceCheck.ts) || { echo "slice-check: could not derive the tests" >&2; exit 2; }
tests=$( { printf '%s\n' "$derived"; for f in "$@"; do printf '%s\n' "${f#apps/server/}"; done; } | grep . | sort -u)
# node --test passes silently over a missing file when another one exists: a named file that is not there is a usage error, before any work.
missing=$(printf '%s\n' "$tests" | while read -r f; do [ -z "$f" ] || [ -f "apps/server/$f" ] || printf '%s ' "$f"; done)
[ -z "$missing" ] || { cat "$out"; echo "slice-check: no such test file: $missing"; exit 2; }
say "slice-check: $(printf '%s\n' "$changed" | grep -c .) changed since $base; $(printf '%s\n' "$tests" | grep -c .) test file(s)"
rc=0
step() {
  local name=$1 t0 log r; shift
  t0=$(date +%s); log=/tmp/slice-check.$name.log
  "$@" >"$log" 2>&1; r=$?
  if [ "$r" = 0 ]; then say "$name ok $(( $(date +%s) - t0 ))s"; return; fi
  say "$name FAILED rc=$r $(( $(date +%s) - t0 ))s: $log"
  # The failing lines (test names, assertion messages, compiler errors), else the tail.
  if grep -qE 'error TS|✖|not ok|AssertionError|Error:' "$log"; then grep -E 'error TS|✖|not ok|AssertionError|Error:' "$log" | head -n 12 >>"$out"; else tail -n 12 "$log" >>"$out"; fi
  [ "$rc" = 0 ] && rc=$r
}
step typecheck npm run typecheck
if [ -n "$tests" ]; then
  mapfile -t files <<<"$tests"
  step tests sh -c 'cd apps/server && exec node --import tsx --disable-warning=ExperimentalWarning --test --test-reporter=spec --test-force-exit --test-concurrency=2 "$@"' sh "${files[@]}"
else
  say "tests: none touched (name test files to add them)"
fi
head -n 19 "$out"
[ "$rc" = 0 ] && echo "slice-check: green" || echo "slice-check: RED rc=$rc"
exit "$rc"
