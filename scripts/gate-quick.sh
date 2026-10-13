#!/usr/bin/env bash
# The integration fast lane (T-36, docs/dev-sessions/README.md "Who integrates"): before integration is pushed, in a few minutes, in THIS
# checkout (no clean copy, no npm ci): typecheck, the web build and web tests when web code changed, and only the server tests of the
# touched areas (apps/server/src/qa/gateQuick.ts maps paths to areas; what everything depends on runs the whole server suite). The full
# gate (scripts/gate.sh) runs before every deploy and every two hours on integration's head.
#   flock /tmp/heavy.lock nice -n 10 scripts/gate-quick.sh [base]     base: what is already pushed (default origin/integration)
set -uo pipefail
root=$(git rev-parse --show-toplevel)
cd "$root" || exit 2
base=${1:-origin/integration}
git rev-parse -q --verify "$base^{commit}" >/dev/null || { echo "gate-quick: unknown base $base" >&2; exit 2; }
changed=$( { git diff --name-only "$base"...HEAD; git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u)
plan=$(printf '%s\n' "$changed" | node --import tsx --disable-warning=ExperimentalWarning apps/server/src/qa/gateQuick.ts)
field() { node -e 'const p=JSON.parse(process.argv[1]); const v=p[process.argv[2]]; console.log(Array.isArray(v) ? v.join("\n") : String(v))' "$plan" "$1"; }
echo "gate-quick: $(printf '%s\n' "$changed" | grep -c .) changed file(s) since $(git rev-parse --short "$base"): $plan"
[ "$(field docsOnly)" = true ] && { echo "gate-quick: documents only, nothing to check"; exit 0; }
fail=0
step() { local name=$1 t0; shift; t0=$(date +%s); if "$@" > "/tmp/gate-quick.$name.log" 2>&1; then echo "$name ok $(( $(date +%s) - t0 ))s"; else echo "$name FAILED $(( $(date +%s) - t0 ))s: see /tmp/gate-quick.$name.log"; tail -20 "/tmp/gate-quick.$name.log"; fail=1; fi; }
step typecheck npm run typecheck
if [ "$(field web)" = true ]; then
  step web-build npm run build -w @portal/web
  step web-tests npm test -w @portal/web
fi
if [ "$(field serverAll)" = true ]; then
  step server-tests sh -c "cd apps/server && node --import tsx --disable-warning=ExperimentalWarning --test --test-force-exit --test-concurrency=2 'src/**/*.test.ts'"
else
  globs=$(field serverTests)
  if [ -n "$globs" ]; then
    # shellcheck disable=SC2086 # one quoted glob per area, node expands them
    step server-tests sh -c "cd apps/server && node --import tsx --disable-warning=ExperimentalWarning --test --test-force-exit --test-concurrency=2 $(printf "'%s' " $globs)"
  fi
fi
[ "$fail" = 0 ] && echo "gate-quick: green: push integration" || echo "gate-quick: RED: fix it before pushing"
exit "$fail"
