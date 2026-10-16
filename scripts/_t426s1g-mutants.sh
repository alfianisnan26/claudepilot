#!/usr/bin/env bash
# T-426 S1g evidence runner (a scratch file on a wip branch, not part of the change): typecheck, the two test files, the bash proof, then one
# mutant per item, each reverted. A mutant must turn its test red (rc != 0); the line "MUTANT <x>: KILLED" says so.
set -u
q="'"
red=0
echo "=== bash: $(bash --version | head -1)"
bash -uc 'declare -A jr_pool=(); for k in "${!jr_pool[@]}"; do echo bad; done; pool_off() { local k; for k in "${!jr_pool[@]}"; do unset "$k"; done; }; pool_off; echo EMPTY-POOL-OK'
echo "=== proof empty pool rc=$?"
npm run typecheck; rt=$?; echo "=== typecheck rc=$rt"
cd apps/server || exit 9
node --import tsx --test src/ci/jobRun.test.ts; r1=$?; echo "=== jobRun.test.ts rc=$r1"
node --import tsx --test src/ci/jobRunCreds.test.ts; r2=$?; echo "=== jobRunCreds.test.ts rc=$r2"
cd ../.. || exit 9
mut() { # <label> <test file> <name pattern> <file> <from> <to>  [<file2> <from2> <to2>]
  node scripts/_t426s1g-mut.mjs "$4" "$5" "$6" ${7:+"$7" "$8" "${9}"} || { echo "MUTANT $1: NOT APPLIED"; red=1; return; }
  (cd apps/server && node --import tsx --test --test-name-pattern="$3" "$2"); rc=$?
  git checkout -q -- scripts deploy
  if [ "$rc" != 0 ]; then echo "MUTANT $1: KILLED (rc=$rc)"; else echo "MUTANT $1: SURVIVED"; red=1; fi
}
mut O1 src/ci/jobRun.test.ts 'S1g O1' scripts/job-run.sh 'grep -rlaFZ' 'grep -rlaF' scripts/job-run.sh "while IFS= read -r -d ${q}${q} f; do rm -f -- \"\$f\"; echo \"job-run: ERROR: a --pool-env" "while IFS= read -r f; do rm -f -- \"\$f\"; echo \"job-run: ERROR: a --pool-env"
mut C2 src/ci/jobRunCreds.test.ts 'S1g --pool-env --against' deploy/k3s-build/job-run.yaml 'pool_off # the install below' ': # the install below'
mut C3 src/ci/jobRun.test.ts 'S1g C3' scripts/job-run.sh '( shopt -s dotglob nullglob; rm -rf -- "$out"/* )' ':'
echo "=== runner done red=$red tests=$r1/$r2"
[ "$red" = 0 ] && [ "$rt" = 0 ] && [ "$r1" = 0 ] && [ "$r2" = 0 ]
