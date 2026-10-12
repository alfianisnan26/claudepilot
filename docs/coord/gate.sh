#!/usr/bin/env bash
# Checkpoint gate: root typecheck under the shared heavy lock. Output: gate-typecheck.log (summary first, counts per file).
C=/tmp/claude-1000/-workspaces-claudepilot/cad07383-74ea-4f0a-88e5-fc51c5b7a125/scratchpad/coord
cd /workspaces/claudepilot || exit 1
date -u +%Y-%m-%dT%H:%M:%SZ > "$C/gate-start.time"
touch "$C/gate-start.marker"
flock "$C/heavy.lock" nice -n 10 env NODE_OPTIONS=--max-old-space-size=2048 npm run typecheck > "$C/gate-typecheck.full" 2>&1
rc=$?
{
  echo "gate finished at $(date -u +%H:%M:%SZ): exit=$rc"
  n=$(grep -c 'error TS' "$C/gate-typecheck.full")
  echo "errors: $n"
  grep 'error TS' "$C/gate-typecheck.full" | sed -E 's/\(.*//' | sort | uniq -c | sort -rn | head -20
} > "$C/gate-typecheck.log"
