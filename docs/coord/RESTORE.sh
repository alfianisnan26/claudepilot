#!/usr/bin/env bash
# Rebuilds a working COORD directory from this snapshot: bash docs/coord/RESTORE.sh /path/to/new/coord
# The plans, prompts and status files name the old session-local COORD path; it is rewritten to the new one.
set -eu
SRC="$(cd "$(dirname "$0")" && pwd)"; DST="${1:?target directory}"
OLD="/tmp/claude-1000/-workspaces-claudepilot/cad07383-74ea-4f0a-88e5-fc51c5b7a125/scratchpad/coord"
mkdir -p "$DST"; cp -a "$SRC"/. "$DST"/; rm -f "$DST/RESTORE.sh"
grep -rlF "$OLD" "$DST" | xargs -r sed -i "s#$OLD#$DST#g"
echo "COORD restored at $DST. Read ROSTER.md, TODO-coordinator.md and docs/open-items.md in the repo first."
