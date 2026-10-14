#!/usr/bin/env bash
# quiet.sh [-n LINES] -- <command...>: run a command with its FULL output in a log file and print only a short result, so a long output does not
# enter the agent's context (every token of a tool result is written to the cache once and read again on every later request).
#   success: one line, `ok rc=0 lines=N log=<file>`            failure: `FAILED rc=N lines=N log=<file>` and the last LINES lines (default 25)
#   the exit code is the command's. Logs are /tmp/quiet-*.log and are removed after four hours. Never prints the command line.
set -u
n=25
if [ "${1:-}" = "-n" ]; then n=${2:?lines}; shift 2; fi
[ "${1:-}" = "--" ] && shift
[ "$#" -gt 0 ] || { echo "usage: quiet.sh [-n LINES] -- <command...>" >&2; exit 2; }
case "$n" in ''|*[!0-9]*) echo "quiet.sh: LINES must be a number" >&2; exit 2;; esac
find /tmp -maxdepth 1 -name 'quiet-*.log' -mmin +240 -delete 2>/dev/null || true
log=$(mktemp /tmp/quiet-XXXXXX.log)
"$@" >"$log" 2>&1
rc=$?
lines=$(wc -l <"$log" | tr -d ' ')
if [ "$rc" -eq 0 ]; then
  echo "ok rc=0 lines=$lines log=$log"
else
  echo "FAILED rc=$rc lines=$lines log=$log"
  tail -n "$n" "$log"
fi
exit "$rc"
