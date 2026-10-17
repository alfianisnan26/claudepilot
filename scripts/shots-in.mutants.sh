#!/usr/bin/env bash
# Mutation check of scripts/shots-in.sh (T-868 S2): bash scripts/shots-in.mutants.sh
# Each mutant switches off ONE guard of the door (a sed on a copy of the script put in place for one run of shots-in.test.sh) and the
# test must go red. A mutant that survives means a guard has no test: exit 1. The script is restored at the end, whatever happens.
set -u
here=$(cd "$(dirname "$0")/.." && pwd -P)
script=$here/scripts/shots-in.sh
backup=$(mktemp "$here/.mutant-backup.XXXXXX")
cp -- "$script" "$backup"
trap 'cp -- "$backup" "$script"; rm -f -- "$backup"' EXIT
survived=0

# mutant <name> <sed expression>
mutant() {
  local name=$1 expr=$2 rc=0
  cp -- "$backup" "$script"
  sed -i -e "$expr" "$script"
  if cmp -s "$backup" "$script"; then echo "MUTANT $name: the sed changed nothing (fix the expression)"; survived=$((survived + 1)); return; fi
  bash "$here/scripts/shots-in.test.sh" > /dev/null 2>&1 || rc=$?
  if [ "$rc" != 0 ]; then echo "MUTANT $name: red (test rc=$rc)"; else echo "MUTANT $name: SURVIVED"; survived=$((survived + 1)); fi
}

mutant srcpng        '/G:srcpng/d'
mutant copypng       '/G:copypng/d'
mutant copylink      '/G:copylink/d'
mutant no-dereference 's/cp --no-dereference -T/cp -T/'
mutant copysize      '/G:copysize/d'
mutant cpfail        's/ || refuse "copying \$n failed" # G:cpfail//'
mutant mv-n          's/mv -n -T/mv -T/'
mutant mvexists      '/G:mvexists/d'
mutant force-mv      's|mv -f -T -- "\$stage/\$n" "\$out/\$n"|cat "$stage/$n" > "$out/$n"|'
mutant ihdr          '/G:ihdr/d'
mutant magic-4-bytes 's/"\${h:0:16}" = "\$magic"/"${h:0:8}" = "${magic:0:8}"/'
mutant cleanup-trap  '/^trap /d'
mutant testmode      '/G:testmode/d'

if [ "$survived" = 0 ]; then echo "all mutants red"; exit 0; fi
echo "$survived mutant(s) survived or did not apply"; exit 1
