#!/usr/bin/env bash
# Emits one line per new outbox request and per new P0/P1 QA finding. Quiet otherwise.
C=/tmp/claude-1000/-workspaces-claudepilot/cad07383-74ea-4f0a-88e5-fc51c5b7a125/scratchpad/coord
Q=/workspaces/claudepilot/docs/qa/qa-report.md
declare -A seen
for f in "$C"/outbox-*.md; do seen[$f]=$(wc -c < "$f"); done
# Start from what the report already says, so a re-arm does not replay old findings.
Q0=/workspaces/claudepilot/docs/qa/qa-report.md
[ -f "$Q0" ] && grep -E 'P0|P1' "$Q0" 2>/dev/null | sort -u > "$C/.qa-seen" || : > "$C/.qa-seen"
while true; do
  for f in "$C"/outbox-*.md; do
    n=$(wc -c < "$f" 2>/dev/null || echo 0)
    if [ "$n" -gt "${seen[$f]:-0}" ]; then
      id=$(basename "$f" .md); id=${id#outbox-}
      tail -c +$(( ${seen[$f]:-0} + 1 )) "$f" | sed "s/^/[outbox $id] /" | cut -c1-400
      seen[$f]=$n
    fi
  done
  if [ -f "$Q" ]; then
    grep -E 'P0|P1' "$Q" 2>/dev/null | sort -u > "$C/.qa-now"
    comm -13 "$C/.qa-seen" "$C/.qa-now" | sed 's/^/[qa] /' | cut -c1-300
    cp "$C/.qa-now" "$C/.qa-seen"
  fi
  sleep 45
done
