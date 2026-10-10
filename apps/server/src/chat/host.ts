// Chat sessions: the session-host script that runs Claude Code in a workspace (chat-sessions PRD, C1).
// The portal reaches it only through short `docker exec` / `kubectl exec` calls; the script keeps the
// Claude Code process detached, with a FIFO for stdin and an appended segment file for stdout. It also
// serves Files and Diff (C3): folder listings, file bytes and git changes, under a path policy.

import { CHAT_MAX_DOWNLOAD_BYTES } from '@portal/contracts';

/** Where the reconciler installs the script inside a workspace (foundation-owned `bin/` path). */
export const CP_SESSION_PATH = '/etc/claudepilot/bin/cp-session';

/** `ls` lists at most this many entries, then prints `#truncated`. */
export const LS_MAX_ENTRIES = 500;
/** `diff` prints at most this many bytes of patch, then `#truncated`. */
export const DIFF_MAX_PATCH_BYTES = 1_000_000;
/** Exit codes of the Files and Diff commands: a path the policy refuses, a file over the download limit. */
export const HOST_REFUSED = 2;
export const HOST_TOO_LARGE = 6;

/** The project settings `trustscan` reads (FR43), in the fixed order their digests are hashed. */
export const TRUST_FILES = ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json'] as const;
/** `trustscan` reads names from a settings file of at most this many bytes; a larger one is only hashed. */
export const TRUST_MAX_FILE_BYTES = 1_000_000;
/** `trustscan`'s hash when none of {@link TRUST_FILES} is there: the sha256 of nothing. */
export const TRUST_EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

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
 *
 * Files and Diff take an absolute path and act only on its real path (symlinks resolved), which must
 * lie under `${CLAUDEPILOT_FILES_ROOT:-/home/node}` and outside the portal's own files (`.claudepilot`
 * and Claude Code's `.claude` at the root, `/etc/claudepilot`). A refused path exits 2 and prints
 * nothing; stderr is discarded, since the exec merges it into stdout.
 *
 * - `ls <dir>` prints `<type>\t<size>\t<mtime-epoch>\t<name>` per entry (`find -printf` `%y %s %T@ %f`),
 *   sorted by name, at most {@link LS_MAX_ENTRIES}, then `#truncated` when there were more. The root's
 *   own listing leaves out the folders it refuses; names with a newline are left out.
 * - `cat <file>` prints a regular file's bytes, read through a descriptor that is checked after it is
 *   opened; exit 6 when it's over {@link CHAT_MAX_DOWNLOAD_BYTES}.
 * - `diff <dir>` prints `#norepo` outside a git work tree. Inside one: `#status` (`status
 *   --porcelain=v1`), `#numstat` and `#patch` (`diff` against HEAD, or the empty tree before the first
 *   commit), the patch cut at {@link DIFF_MAX_PATCH_BYTES} and followed by `#truncated` when longer.
 *   Nothing the repository configures runs: no fsmonitor, hooks, external diff, textconv, pager or
 *   filter; each git call has 30 s.
 * - `trustscan <dir>` prints one JSON object naming what the folder's own Claude Code project settings
 *   ({@link TRUST_FILES}) would load, never a value or a command: `mcpServers` (keys of `mcpServers`),
 *   `hooks` (events with at least one command), `plugins` (`enabledPlugins` keys set to true),
 *   `allowRules` (entries in `permissions.allow`) and `envNames` (keys of `env`), from every file read;
 *   `files` (those present) and `invalid` (present but not a JSON object, or not read). `hash` is the
 *   sha256 of `<sha256 of the file>  <name>` lines for the files present, in that order, so any change
 *   to any of them changes it; with none it's {@link TRUST_EMPTY_HASH}. Each file is read once, through
 *   a checked descriptor, and only when it leads to a regular file the policy allows; one over
 *   {@link TRUST_MAX_FILE_BYTES} is hashed whole but not read for names. At the files root `.claude` is
 *   Claude Code's own folder (the user settings), so only `.mcp.json` counts there.
 */
export const CP_SESSION = `#!/bin/sh
set -u
base="\${CLAUDEPILOT_SESSIONS_DIR:-$HOME/.claudepilot/sessions}"
nl='
'
tab="$(printf '\\t')"
valid() {
  case "$1" in
    ''|.|..) return 1 ;;
    *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  [ "\${#1}" -le 128 ]
}
digits() { case "\${1:-}" in ''|*[!0-9]*) return 1 ;; esac; }

# Files and Diff read only real paths under the files root, never the portal's own files.
froot="\${CLAUDEPILOT_FILES_ROOT:-/home/node}"
# Sets r to the real path of $1, symlinks resolved (exact even when it ends in a newline).
real() {
  r="$(realpath -e -- "$1" 2>/dev/null && printf x)" || return 1
  r="\${r%x}"
  r="\${r%"$nl"}"
}
# Whether real path $1 may be shown: under the root, and not the portal's or Claude Code's own files.
inroot() {
  case "$1" in
    "$root/.claudepilot"|"$root/.claudepilot/"*|"$root/.claude"|"$root/.claude/"*) return 1 ;;
    /etc/claudepilot|/etc/claudepilot/*) return 1 ;;
    "$root"|"$root/"*) return 0 ;;
  esac
  return 1
}
# For an absolute path $1 that may be shown, sets root and r (its real path); status 1 otherwise.
allowed() {
  case "$1" in /*) ;; *) return 1 ;; esac
  real "$froot" || return 1
  root="$r"
  real "$1" || return 1
  inroot "$r"
}
# Enters folder $1 when it may be shown, then checks the folder actually entered (sets here).
enter() {
  allowed "$1" && [ -d "$r" ] && cd -P -- "$r" || return 1
  here="$(pwd -P && printf x)" || return 1
  here="\${here%x}"
  here="\${here%"$nl"}"
  inroot "$here" && [ -r . ]
}
# Prints the file open on fd 3 once the opened file itself checks out, so a path swapped after the
# check can't redirect the read; 6 when it's over the download limit.
catfd() {
  l="$(readlink "/proc/$$/fd/3" && printf x)" || return 2
  l="\${l%x}"
  l="\${l%"$nl"}"
  [ "$l" = "$r" ] && [ -f "/proc/$$/fd/3" ] || return 2
  size="$(stat -L -c %s "/proc/$$/fd/3")" || return 2
  [ "$size" -le ${CHAT_MAX_DOWNLOAD_BYTES} ] || return 6
  cat <&3
}
# Copies the settings file open on fd 3, once the opened file itself checks out as $r, into $1 when it
# has at most ${TRUST_MAX_FILE_BYTES} bytes; of a larger one only the digest of all of it is kept, in $1.big.
grab() {
  l="$(readlink "/proc/$$/fd/3" && printf x)" || return 1
  l="\${l%x}"
  l="\${l%"$nl"}"
  [ "$l" = "$r" ] && [ -f "/proc/$$/fd/3" ] || return 1
  head -c ${TRUST_MAX_FILE_BYTES + 1} <&3 > "$1" || return 1
  [ "$(wc -c < "$1")" -le ${TRUST_MAX_FILE_BYTES} ] && return 0
  rm -f "$1"
  sha256sum < "/proc/$$/fd/3" | cut -c1-64 > "$1.big"
}

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
    # Exactly one newline-terminated line that is a single JSON value, or drop it (exit 4). Checked
    # with streaming tools: a line carrying images can be ~20 MB, too big for shell variables.
    ok=1
    [ "$(wc -c < "$file")" -eq "$nbytes" ] || ok=
    [ "$(wc -l < "$file")" -eq 1 ] || ok=
    [ "$(tail -c 1 "$file" | od -An -tx1 | tr -d ' ')" = 0a ] || ok=
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
  ls)
    exec 2>/dev/null
    enter "\${1:-}" || exit 2
    # The root's listing leaves out the folders it refuses anyway.
    if [ "$here" = "$root" ]; then set -- ! -name .claudepilot ! -name .claude; else set --; fi
    find . -mindepth 1 -maxdepth 1 ! -name "*$nl*" "$@" -printf '%y\\t%s\\t%T@\\t%f\\n' | LC_ALL=C sort -t "$tab" -k 4 | head -n ${LS_MAX_ENTRIES + 1} | sed '${LS_MAX_ENTRIES + 1}s/.*/#truncated/'
    exit 0
    ;;
  cat)
    exec 2>/dev/null
    allowed "\${1:-}" && [ -f "$r" ] && [ -r "$r" ] || exit 2
    catfd 3<"$r"
    exit "$?"
    ;;
  diff)
    exec 2>/dev/null
    enter "\${1:-}" || exit 2
    export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat LC_ALL=C
    set -- -c core.fsmonitor= -c core.hooksPath=/dev/null -c diff.external= -c core.pager=cat -c core.quotePath=false -c color.ui=false
    [ "$(git "$@" rev-parse --is-inside-work-tree)" = true ] || { echo '#norepo'; exit 0; }
    # Every filter the configuration defines is switched off (clean, smudge and process alike).
    for f in $(git "$@" config --name-only --get-regexp '^filter\\.' | sed -n 's/^filter\\.\\([A-Za-z0-9_.-]*\\)\\.[a-z]*$/\\1/p' | sort -u); do
      set -- "$@" -c "filter.$f.clean=" -c "filter.$f.smudge=" -c "filter.$f.process=" -c "filter.$f.required=false"
    done
    # Staged and unstaged changes against the last commit; before the first one, against the empty tree.
    against="$(git "$@" rev-parse --verify -q HEAD)" || against="$(git "$@" hash-object -t tree /dev/null)" || exit 1
    echo '#status'
    timeout 30 git "$@" status --porcelain=v1 --untracked-files=normal || exit 1
    echo '#numstat'
    timeout 30 git "$@" diff --numstat --no-ext-diff --no-textconv --no-color --no-relative "$against" -- || exit 1
    echo '#patch'
    timeout 30 git "$@" diff --no-ext-diff --no-textconv --no-color --no-relative --src-prefix=a/ --dst-prefix=b/ "$against" -- | {
      head -c ${DIFF_MAX_PATCH_BYTES}
      if [ "$(head -c 1 | wc -c)" -ne 0 ]; then printf '\\n#truncated\\n'; fi
    }
    exit 0
    ;;
  trustscan)
    exec 2>/dev/null
    enter "\${1:-}" || exit 2
    t="$(mktemp -d)" || exit 1
    trap 'rm -rf "$t"' EXIT
    trap 'exit 1' HUP INT TERM
    : > "$t/sums" || exit 1
    files=
    invalid=
    n=0
    set --
    for name in ${TRUST_FILES.join(' ')}; do
      n=$((n + 1))
      # At the files root, .claude is Claude Code's own folder (the user settings), not the project's.
      if [ "$here" = "$root" ]; then case "$name" in .claude/*) continue ;; esac; fi
      # Not there (a dangling link included): nothing to load.
      [ -e "$name" ] || continue
      files="$files $name"
      d=
      r=
      ok=
      if real "$name" && inroot "$r" && [ -f "$r" ] && [ -r "$r" ] && grab "$t/$n" 3<"$r"; then
        if [ -f "$t/$n" ]; then
          d="$(sha256sum < "$t/$n" | cut -c1-64)"
          jq -se 'length == 1 and (.[0] | type) == "object"' "$t/$n" >/dev/null </dev/null && ok=1
        else
          d="$(cat "$t/$n.big")"
        fi
      fi
      # Present but not read (it leads outside the root or into the portal's own files, or isn't a
      # regular file): it counts all the same, keyed by where it leads.
      [ -n "$d" ] || d="x$(printf '%s' "$r" | sha256sum | cut -c1-64)"
      if [ -n "$ok" ]; then set -- "$@" "$t/$n"; else invalid="$invalid $name"; fi
      printf '%s  %s\\n' "$d" "$name" >> "$t/sums"
    done
    # Names only, from the files that parsed: never a value, a command or an argument.
    jq -cn --arg hash "$(sha256sum < "$t/sums" | cut -c1-64)" --arg files "$files" --arg invalid "$invalid" '[inputs] as $s | {
      hash: $hash,
      files: ($files | split(" ") | map(select(. != ""))),
      invalid: ($invalid | split(" ") | map(select(. != ""))),
      mcpServers: ([$s[] | .mcpServers | objects | keys[]] | unique),
      hooks: ([$s[] | .hooks | objects | to_entries[]
        | select([.value | arrays | .[] | objects | .hooks | arrays | .[] | objects
          | select((.command | if type == "string" then length > 0 else false end) or (.type | if type == "string" then . != "command" else false end))] | length > 0)
        | .key] | unique),
      plugins: ([$s[] | .enabledPlugins | objects | to_entries[] | select(.value == true) | .key] | unique),
      allowRules: ([$s[] | .permissions | objects | .allow | arrays | length] | add // 0),
      envNames: ([$s[] | .env | objects | keys[]] | unique)
    }' "$@" </dev/null || exit 1
    exit 0
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
