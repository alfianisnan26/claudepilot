#!/usr/bin/env bash
# QA T-612 S1, runs INSIDE one cluster Job after `npm ci`, from the clone root. The transport (job-run) is a stub that runs the real `cmd`
# body locally, with the real prettier and eslint from node_modules; the real quick-check.sh does everything else (git, base, file lists).
set -u
top=$PWD
qc=/tmp/qc; rm -rf $qc; mkdir -p $qc
cat > $qc/job-run.sh <<'STUB'
#!/usr/bin/env bash
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec bash -c "$1"
STUB
chmod +x $qc/job-run.sh
git config user.email qa@example.invalid; git config user.name qa
base0=$(git rev-parse HEAD)
good='export const a = 1;\n'
badfmt='export const   a =  "x"\n'
badlint='debugger;\nexport const a = 1;\n'
hide() { for t in "$@"; do mv node_modules/.bin/$t node_modules/.bin/$t.off; done; }
unhide() { for t in prettier eslint; do [ -e node_modules/.bin/$t.off ] && mv node_modules/.bin/$t.off node_modules/.bin/$t; done; return 0; }
# scenario <name> <file content> <tools to hide> <expected rc> <expected last line>
mism=""
scenario() {
  local name=$1 content=$2 hidden=$3 erc=$4 elast=$5
  git reset -q --hard $base0; rm -rf qa-scratch; mkdir qa-scratch
  printf "$content" > qa-scratch/f.ts
  git add qa-scratch; git commit -qm scratch
  [ -n "$hidden" ] && hide $hidden
  out=$(bash $qc/quick-check.sh --base $base0 2>&1); rc=$?
  unhide
  last=$(printf '%s\n' "$out" | tail -n 1)
  if [ "$rc" = "$erc" ] && [ "$last" = "$elast" ]; then echo "  ok   $name (rc $rc: $last)"; else echo "  MISMATCH $name: rc $rc want $erc; last '$last' want '$elast'"; mism="$mism $name"; fi
  LASTOUT=$out
}
run_all() {
  mism=""
  scenario good "$good" "" 0 "QUICK CHECK: all passed"
  case "$LASTOUT" in *"::: format ok"*"::: lint ok"*) echo "  ok   good: format and lint both ran and passed";; *) echo "  MISMATCH good: no 'format ok' and 'lint ok' lines"; mism="$mism good-ran";; esac
  scenario badfmt "$badfmt" "" 1 "QUICK CHECK FAILED: format"
  scenario badlint "$badlint" "" 1 "QUICK CHECK FAILED: lint"
  scenario nopretty "$good" "prettier" 1 "QUICK CHECK INCOMPLETE: SKIPPED format (the other steps passed)"
  scenario noeslint "$good" "eslint" 1 "QUICK CHECK INCOMPLETE: SKIPPED lint (the other steps passed)"
  scenario nopretty_badlint "$badlint" "prettier" 1 "QUICK CHECK FAILED: lint (also SKIPPED: format)"
  scenario noeslint_badfmt "$badfmt" "eslint" 1 "QUICK CHECK FAILED: format (also SKIPPED: lint)"
  scenario neither "$good" "prettier eslint" 1 "QUICK CHECK INCOMPLETE: SKIPPED format lint (the other steps passed)"
}
echo "=== (c) lockfile"; npm ls --depth=0 2>&1 | tail -n 8; git status --porcelain | head -n 5; echo "(nothing listed above means npm ci left the tree as committed)"
node_modules/.bin/prettier --version; node_modules/.bin/eslint --version
echo "=== (a,b) the real quick-check.sh, unmutated"
cp $top/scripts/quick-check.sh $qc/quick-check.sh
run_all > $qc/out.txt; cat $qc/out.txt; echo "BASELINE mismatches:${mism:- none}"
echo "=== (a) real branch diff of 889071cd against d10f6537"
git reset -q --hard $base0; git checkout -q 889071cd8e3838517edd66184b71ac655b0dc03d 2>&1 | tail -n 2
bash $qc/quick-check.sh --base d10f65376acc2f03ddb25320258a110811569df7 > $qc/real.txt 2>&1; echo "rc $?"; tail -n 8 $qc/real.txt
git checkout -q $base0 2>&1 | tail -n 1
echo "=== (d) mutants"
for m in skipinit noappend skipname incexit0 alsodrop failexit0 fmtecho lintecho noskipcheck norecord rctrue nocheckflag failsfirst; do
  cp $top/scripts/quick-check.sh $qc/quick-check.sh
  node $top/qa-mut/mutate612.mjs $qc/quick-check.sh $m || { echo "=== $m NOT APPLIED"; continue; }
  echo "--- mutant $m"; run_all > $qc/out.txt; grep -v "^  ok" $qc/out.txt
  if [ -n "$mism" ]; then echo "KILLED $m by:$mism"; else echo "SURVIVED $m"; fi
done
exit 0
