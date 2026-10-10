// Chat sessions: the session-host script that runs Claude Code in a workspace (chat-sessions PRD, C1).
// The portal reaches it only through short `docker exec` / `kubectl exec` calls; the script keeps the
// Claude Code process detached, with a FIFO for stdin and an appended segment file for stdout.

/** Where the reconciler installs the script inside a workspace (foundation-owned `bin/` path). */
export const CP_SESSION_PATH = '/etc/claudepilot/bin/cp-session';

/**
 * The POSIX `sh` (dash, no bashisms) session host. One process per session, guarded by a `flock`.
 *
 * - `start <id> <seg> <cwd> -- <claude-args...>` detaches `claude` (new session via `setsid`) running
 *   in `<cwd>`, its stdin a FIFO opened read-write so sends never close it, its stdout appended to
 *   `out.<seg>.jsonl`. Prints `<pid> <iso8601-utc>`; exit 3 if a session is already running.
 * - `send <id> <uuid> <nbytes>` stages exactly `<nbytes>` from stdin, checks it is one JSON line, and
 *   appends it to the FIFO under a lock.
 * - `tail <id> <seg> <offset>` streams the segment from a byte offset and follows it, ending when the
 *   exec stdin closes or after 600 s.
 * - `stop <id>` SIGTERMs the whole process group; `status <id>` prints `live <pid>` or `gone`.
 *
 * Session files live under `${CLAUDEPILOT_SESSIONS_DIR:-$HOME/.claudepilot/sessions}/<id>/` and are
 * referenced by absolute path, since `claude` runs with its own working directory.
 */
export const CP_SESSION = `#!/bin/sh
set -u
base="\${CLAUDEPILOT_SESSIONS_DIR:-$HOME/.claudepilot/sessions}"
nl='
'
valid() {
  case "$1" in
    ''|.|..) return 1 ;;
    *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  [ "\${#1}" -le 128 ]
}
digits() { case "\${1:-}" in ''|*[!0-9]*) return 1 ;; esac; }

cmd="\${1:-}"
[ "$#" -ge 1 ] && shift

case "$cmd" in
  start)
    id="\${1:-}"; seg="\${2:-}"; cwd="\${3:-}"
    valid "$id" || exit 2
    valid "$seg" || exit 2
    case "$cwd" in /*) ;; *) exit 2 ;; esac
    [ "\${4:-}" = '--' ] || exit 2
    shift 4
    dir="$base/$id"
    mkdir -p "$dir" || exit 1
    # Already running? run.lock is held for the life of claude, so a free lock means no live process.
    if ! flock -n "$dir/run.lock" true 2>/dev/null; then exit 3; fi
    # A fresh pipe and staging area for this run (safe now the lock is free).
    mkdir -p "$dir/in.d"
    rm -f "$dir/in.d"/* 2>/dev/null
    rm -f "$dir/in"
    mkfifo "$dir/in" || exit 1
    # Detach: new session/process group, own fds, writes its own exit.json. -o keeps the lock out of
    # claude's children, so a server it leaves running can't hold the session open.
    setsid sh -c 'dir="$1"; seg="$2"; cd "$3" || exit 1; shift 3; flock -n -o "$dir/run.lock" claude "$@" <>"$dir/in" >>"$dir/out.$seg.jsonl" 2>>"$dir/err.log"; printf "{\\"code\\":%s,\\"at\\":\\"%s\\"}\\n" "$?" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$dir/exit.json"' sh "$dir" "$seg" "$cwd" "$@" </dev/null >/dev/null 2>>"$dir/err.log" &
    pgid="$!"
    echo "$pgid" > "$dir/parent.pid"
    printf '%s %s\\n' "$pgid" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ;;
  send)
    id="\${1:-}"; uuid="\${2:-}"; nbytes="\${3:-}"
    valid "$id" || exit 2
    valid "$uuid" || exit 2
    digits "$nbytes" || exit 2
    dir="$base/$id"
    [ -p "$dir/in" ] || exit 5
    mkdir -p "$dir/in.d"
    file="$dir/in.d/$uuid.jsonl"
    head -c "$nbytes" > "$file"
    # Exactly one newline-terminated line that is a single JSON value, or drop it (exit 4).
    raw="$(cat "$file"; printf x)"; raw="\${raw%x}"
    body="\${raw%"$nl"}"
    ok=1
    [ "$body" != "$raw" ] || ok=
    case "$body" in *"$nl"*) ok= ;; esac
    jq -e . "$file" >/dev/null 2>&1 || ok=
    if [ -z "$ok" ]; then rm -f "$file"; exit 4; fi
    # Open the FIFO read-write so the append never blocks waiting for a reader, then stage is consumed.
    flock "$dir/send.lock" cat "$file" 1<>"$dir/in"
    rm -f "$file"
    ;;
  tail)
    id="\${1:-}"; seg="\${2:-}"; offset="\${3:-}"
    valid "$id" || exit 2
    valid "$seg" || exit 2
    digits "$offset" || exit 2
    dir="$base/$id"
    mkdir -p "$dir"
    : >> "$dir/out.$seg.jsonl"
    # Follow from a 1-based byte position; stop when our own stdin closes (portal ends the exec).
    timeout 600 sh -c 'tail -c "+$(($3 + 1))" -f "$1/out.$2.jsonl" & tp=$!; cat >/dev/null; kill "$tp" 2>/dev/null' sh "$dir" "$seg" "$offset"
    ;;
  stop)
    id="\${1:-}"
    valid "$id" || exit 2
    dir="$base/$id"
    pid="$(cat "$dir/parent.pid" 2>/dev/null)" || exit 0
    digits "$pid" || exit 0
    # Negative pid signals the whole process group.
    if kill -0 "-$pid" 2>/dev/null; then kill -TERM "-$pid" 2>/dev/null; fi
    exit 0
    ;;
  status)
    id="\${1:-}"
    valid "$id" || exit 2
    dir="$base/$id"
    pid="$(cat "$dir/parent.pid" 2>/dev/null)"
    if [ -n "\${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then echo "live $pid"; else echo gone; fi
    ;;
  *)
    exit 2
    ;;
esac
`;

/** The ISO-8601 UTC instant the script prints (`date -u +%Y-%m-%dT%H:%M:%SZ`). */
const PID_LINE = /^(\d{1,20})\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/;

/** Parses the `start` command's one stdout line (`<pid> <iso8601-utc>`); null when it doesn't match. */
export function parseStartOutput(stdout: string): { pid: number; startedAt: string } | null {
  for (const line of stdout.split('\n')) {
    const m = PID_LINE.exec(line.trim());
    if (!m) continue;
    const [, pidStr, startedAt] = m;
    if (!pidStr || !startedAt) continue;
    const pid = Number(pidStr);
    if (Number.isSafeInteger(pid) && pid > 0) return { pid, startedAt };
  }
  return null;
}
