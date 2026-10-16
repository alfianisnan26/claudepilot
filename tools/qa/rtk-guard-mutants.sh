#!/usr/bin/env bash
# T-736: proves the guard test has teeth. Applies each mutant to the checkout it runs in, runs apps/server/src/qa/rtkHistoryGuard.test.ts,
# expects it to FAIL, and reverts (git checkout -- tools). Run it only in a job-run Job (it edits tracked files; rtk-guard.sh's own rule):
#   scripts/job-run.sh --ref <hash> -- 'bash tools/qa/rtk-guard-mutants.sh; exit $?'
# Exit 0 when every mutant was caught, 1 when one survived.
set -u
cd "$(dirname "$0")/../.." || exit 2
[ -n "${JR_REPO_URL:-}" ] || { echo "rtk-guard-mutants.sh: refusing: it edits tracked files; run it through scripts/job-run.sh" >&2; exit 2; }
[ -z "$(git status --porcelain)" ] || { echo "rtk-guard-mutants.sh: refusing: the checkout has uncommitted changes" >&2; exit 2; }
T=apps/server/src/qa/rtkHistoryGuard.test.ts
survived=0
mutant() { # <name> <what> <file...> -- <sed script>
  local name=$1 what=$2; shift 2
  local files=() script
  while [ "$1" != -- ]; do files+=("$1"); shift; done; shift; script=$1
  sed -i "$script" "${files[@]}"
  if git diff --quiet; then echo "MUTANT $name: no change made (the sed pattern is stale)"; survived=1; return; fi
  (cd apps/server && node --import tsx --disable-warning=ExperimentalWarning --test "src/qa/rtkHistoryGuard.test.ts" > "/tmp/mutant-$name.log" 2>&1); rc=$?
  git checkout -q -- tools
  if [ "$rc" -ne 0 ]; then echo "MUTANT $name ($what): CAUGHT (test exit $rc; failing: $(grep -c '^not ok\|^    not ok' "/tmp/mutant-$name.log") not-ok lines)"
  else echo "MUTANT $name ($what): SURVIVED"; survived=1; fi
}
mutant MA "delete the marker check" tools/qa/rtk-guard.sh -- '/^  \[ -n "\${JR_REPO_URL/d'
mutant ME "ignore a failing git status" tools/qa/rtk-guard.sh -- 's/ || { echo "\$name: refusing: git status failed.*$/ || true/'
mutant MD "drop --max-time/--retry from every curl" tools/qa/rtk-history.sh tools/qa/rtk-classes.sh tools/qa/rtk-measure.sh -- 's/ --max-time 120 --retry 1//'
mutant MF "drop the guard call from rtk-classes.sh" tools/qa/rtk-classes.sh -- '/rtk_guard rtk-classes.sh/d'
mutant MG "drop the guard call from rtk-measure.sh" tools/qa/rtk-measure.sh -- '/rtk_guard rtk-measure.sh/d'
exit "$survived"
