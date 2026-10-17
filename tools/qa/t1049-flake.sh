#!/bin/sh
# T-1049: run agentFlag.test.ts N times (default 20) with CPU burners alongside, to show the control-timeout race.
# Run it in a Job (scripts/job-run.sh), from the repository root. Exit 0 only if every run passed.
N="${1:-20}"
BURNERS="${2:-3}"
cd apps/server || exit 2
pids=""
i=0
while [ "$i" -lt "$BURNERS" ]; do
  node -e "for(;;){}" &
  pids="$pids $!"
  i=$((i + 1))
done
pass=0
fail=0
i=0
while [ "$i" -lt "$N" ]; do
  i=$((i + 1))
  if node --import tsx --test src/chat/agentFlag.test.ts >"/tmp/t1049-$i.log" 2>&1; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    grep -E "^not ok|^# fail|Error" "/tmp/t1049-$i.log" | head -5
  fi
done
kill $pids 2>/dev/null
echo "T1049-FLAKE pass=$pass fail=$fail of $N (burners=$BURNERS)"
[ "$fail" -eq 0 ]
