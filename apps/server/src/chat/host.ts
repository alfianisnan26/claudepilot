// Chat sessions: the session-host script that runs Claude Code in a workspace (chat-sessions PRD, C1).
// The portal reaches it only through short `docker exec` / `kubectl exec` calls; the script keeps the
// Claude Code process detached, with a FIFO for stdin and an appended segment file for stdout. It also
// serves Files and Diff (C3): folder listings, file bytes and git changes, under a path policy.

import { CHAT_MAX_DOWNLOAD_BYTES, CHAT_MAX_UPLOAD_BYTES } from '@portal/contracts';

/** Where the reconciler installs the script inside a workspace (foundation-owned `bin/` path). */
export const CP_SESSION_PATH = '/etc/claudepilot/bin/cp-session';

/** `ls` lists at most this many entries, then prints `#truncated`. */
export const LS_MAX_ENTRIES = 500;
/** `diff` prints at most this many bytes of patch, then `#truncated`. */
export const DIFF_MAX_PATCH_BYTES = 1_000_000;
/** Exit codes of the Files and Diff commands: a path the policy refuses, a file over the download limit. */
export const HOST_REFUSED = 2;
export const HOST_TOO_LARGE = 6;
/** `put` reads the file as base64 on stdin; it takes at most this many characters (a file of {@link CHAT_MAX_UPLOAD_BYTES}). */
export const PUT_MAX_BASE64 = 4 * Math.ceil(CHAT_MAX_UPLOAD_BYTES / 3);

/** The project settings `trustscan` reads (FR43), in the fixed order their digests are hashed. */
export const TRUST_FILES = ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json'] as const;
/** `trustscan` reads names from a settings file of at most this many bytes; a larger one is only hashed. */
export const TRUST_MAX_FILE_BYTES = 1_000_000;
/** `trustscan`'s hash when none of {@link TRUST_FILES} is there: the sha256 of nothing. */
export const TRUST_EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** The environment names `start --env` accepts (anything else exits 2): a session's portal-tool token and where to reach them, and the switch that keeps claude.ai's connectors out. */
export const HOST_ENV_NAMES = ['PILOT_MCP_TOKEN', 'PILOT_SESSION_ID', 'PILOT_WORKSPACE_ID', 'PILOT_MCP_URL', 'ENABLE_CLAUDEAI_MCP_SERVERS'] as const;

/** Account Pool's managed-settings drop-in, the one file `authcheck` reads (delivery `ownership.ts`). */
export const ACCOUNT_DROPIN = '/etc/claude-code/managed-settings.d/40-claudepilot-account.json';
/** The `apiKeyHelper` that drop-in names: Account Pool's helper and an account id (accounts/pools.ts). */
export const ACCOUNT_HELPER = '/etc/claudepilot/bin/account-key';

/**
 * The POSIX `sh` (dash, no bashisms) session host. One process per session, guarded by a `flock`.
 *
 * - `start <id> <seg> <cwd> [--env <n>] -- <claude-args...>` detaches `claude` (new session via `setsid`) running
 *   in `<cwd>`, its stdin a FIFO opened read-write so sends never close it, its stdout appended to
 *   `out.<seg>.jsonl`. Prints `<pid> <iso8601-utc>`; exit 3 if a session is already running. `--env <n>` reads
 *   `<n>` lines `NAME=value` from stdin into that process's environment (a short fixed list of names; anything
 *   else exits 2): a per-session token must never be on a command line, where any process in the workspace
 *   could read it, or in a file. When `/etc/claudepilot/persona/chat-prompt.md` exists (a persona is delivered;
 *   `CLAUDEPILOT_PERSONA_PROMPT` moves it, for tests), it is appended to the system prompt with
 *   `--append-system-prompt-file`, at every start, resume and wake.
 * - `send <id> <uuid> <nbytes>` stages exactly `<nbytes>` from stdin, checks it is one JSON line, and
 *   appends it to the FIFO under a lock.
 * - `tail <id> <seg> <offset>` streams the segment from a byte offset and follows it, ending when the
 *   exec stdin closes or after 600 s.
 * - `stop <id>` SIGTERMs the whole process group; `status <id>` prints `live <pid>` or `gone`.
 * - `purge <id>` deletes the session's directory (segments, uploads, staged inputs) for a deleted
 *   session; exit 3, nothing deleted, while its process is still alive.
 * - `put <id> <name> <nchars> <nbytes>` stages an attachment (chat content, FR31): `<nchars>` characters of
 *   base64 on stdin become `${CLAUDEPILOT_UPLOADS_DIR:-$HOME/.claudepilot/uploads}/<id>/<name>` (mode 0600,
 *   written under a temporary name and renamed, never through a link), which must come to exactly `<nbytes>`
 *   (exit 4 when it doesn't, so a cut-short upload leaves nothing), and its path is printed. `<name>` is plain
 *   ASCII (letters, digits, dot, dash, underscore; no leading dot); exit 2 for anything else, 6 for more
 *   than {@link PUT_MAX_BASE64} characters. `unstage <id>` deletes the session's staged files.
 * - `produced <dir> <since> <max>` lists the files written in a folder since an instant (artifacts a command
 *   made, chat content): a first line `#dir<TAB><the folder's real path>`, then `<size><TAB><mtime-epoch><TAB>
 *   <path relative to it>` for at most `<max>` regular files newer than `<since>` (epoch seconds), skipping
 *   `.git`, `node_modules`, caches and virtual environments, and never leaving the folder's file system. The
 *   same path policy as `ls`; names with a newline are left out.
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
 * - `authcheck` prints `pass` when the account drop-in ({@link ACCOUNT_DROPIN}) is a regular file (not a
 *   link) holding one JSON object whose `apiKeyHelper` is exactly `{@link ACCOUNT_HELPER} <account id>`,
 *   and `fail` otherwise; it always exits 0 (chat-sessions PRD §6 rule 1). It reads that one root-owned
 *   file and nothing else: never the home folder, a login, a credential or a transcript, and it never
 *   reports what else is configured.
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
# git, hardened as Diff's is: no hook, fsmonitor, pager, external diff or filter (clean, smudge, process) the configuration defines
# ever runs, and nothing asks a question. Call it inside the repository: the filters it names come from that repository's
# configuration and the user's. Then \`hg\` is git with those switches.
hardened() {
  export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat LC_ALL=C
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_CEILING_DIRECTORIES
  gf='-c core.fsmonitor= -c core.hooksPath=/dev/null -c diff.external= -c core.pager=cat -c core.quotePath=false -c color.ui=false'
  for f in $(git $gf config --name-only --get-regexp '^filter\\.' | sed -n 's/^filter\\.\\([A-Za-z0-9_.-]*\\)\\.[a-z]*$/\\1/p' | sort -u); do
    gf="$gf -c filter.$f.clean= -c filter.$f.smudge= -c filter.$f.process= -c filter.$f.required=false"
  done
}
hg() { git $gf "$@"; }
# The first line of git's complaint, printable ASCII only, for the portal to show.
oneline() { printf '%s' "$1" | head -n 1 | tr -cd '\\11\\40-\\176' | cut -c1-200; }
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
    shift 3
    # Optional environment for the process, one NAME=value per line on stdin (never argv, never a file).
    envn=0
    if [ "\${1:-}" = '--env' ]; then envn="\${2:-}"; digits "$envn" || exit 2; shift 2; fi
    [ "\${1:-}" = '--' ] || exit 2
    shift
    i=0
    while [ "$i" -lt "$envn" ]; do
      IFS= read -r line || [ -n "$line" ] || exit 2
      name="\${line%%=*}"
      case "$name" in
        ${HOST_ENV_NAMES.join('|')}) export "$name=\${line#*=}" ;;
        *) exit 2 ;;
      esac
      i=$((i + 1))
    done
    # A delivered persona goes at the end of the system prompt (never replacing it).
    persona="\${CLAUDEPILOT_PERSONA_PROMPT:-/etc/claudepilot/persona/chat-prompt.md}"
    if [ -f "$persona" ]; then set -- "$@" --append-system-prompt-file "$persona"; fi
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
  purge)
    # A deleted session's files: segments, uploads and staged inputs. Refused (3) while its process lives.
    id="\${1:-}"
    valid "$id" || exit 2
    dir="$base/$id"
    pid="$(cat "$dir/parent.pid" 2>/dev/null)"
    if [ -n "\${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then exit 3; fi
    rm -rf -- "$dir"
    exit 0
    ;;
  put)
    # An attachment, staged for Claude to read: ~/.claudepilot/uploads/<id>/<name>. The bytes arrive as base64 on
    # stdin (exactly <nchars> characters), so the same exec works on every target. Never written through a link.
    exec 2>/dev/null
    id="\${1:-}"; name="\${2:-}"; nchars="\${3:-}"; nbytes="\${4:-}"
    valid "$id" || exit 2
    case "$name" in ''|.*|*[!A-Za-z0-9._-]*) exit 2 ;; esac
    [ "\${#name}" -le 96 ] || exit 2
    digits "$nchars" || exit 2
    digits "$nbytes" || exit 2
    [ "$nchars" -le ${PUT_MAX_BASE64} ] || exit 6
    ubase="\${CLAUDEPILOT_UPLOADS_DIR:-$HOME/.claudepilot/uploads}"
    dir="$ubase/$id"
    mkdir -p "$ubase" || exit 1
    [ ! -L "$ubase" ] && [ ! -L "$dir" ] || exit 2
    mkdir -p "$dir" || exit 1
    umask 077
    tmp="$dir/.$name.$$.part"
    head -c "$nchars" | base64 -d > "$tmp" || { rm -f "$tmp"; exit 1; }
    [ "$(wc -c < "$tmp")" -eq "$nbytes" ] || { rm -f "$tmp"; exit 4; }
    [ ! -L "$dir/$name" ] || { rm -f "$tmp"; exit 2; }
    mv -f "$tmp" "$dir/$name" || { rm -f "$tmp"; exit 1; }
    printf '%s\\n' "$dir/$name"
    ;;
  unstage)
    # A deleted chat's staged attachments (a link in the way is removed, never followed).
    id="\${1:-}"
    valid "$id" || exit 2
    ubase="\${CLAUDEPILOT_UPLOADS_DIR:-$HOME/.claudepilot/uploads}"
    dir="$ubase/$id"
    if [ -L "$dir" ]; then rm -f "$dir"; else rm -rf -- "$dir"; fi
    exit 0
    ;;
  produced)
    exec 2>/dev/null
    enter "\${1:-}" || exit 2
    since="\${2:-}"; max="\${3:-}"
    digits "$since" || exit 2
    digits "$max" || exit 2
    printf '#dir\\t%s\\n' "$here"
    find . -xdev \\( -name .git -o -name node_modules -o -name .cache -o -name __pycache__ -o -name .venv -o -name venv -o -name .next -o -name .npm -o -name .gradle -o -name .m2 -o -name .local -o -name .claude -o -name .claudepilot \\) -prune -o -type f -newermt "@$since" ! -name "*$nl*" -printf '%s\\t%T@\\t%p\\n' | head -n "$max"
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
  wt-add)
    # A git worktree of the repository containing <folder>, in <repo top>.worktrees/<leaf> (the host decides where; <leaf> is a plain
    # name and must not exist yet), on <branch>: a new one started from <base> ('-' is the repository's HEAD), or an existing one no
    # other worktree has. The repository may not be the files root itself. Git runs hardened: no hook, filter or fsmonitor of the
    # repository runs while it checks out. Prints "ok", the worktree's real path, branch, commit, the repository's top folder and
    # <folder> relative to it, tab separated. Exit 2 refused (names, places), 3 not a repository, 4 the branch is in use, 5 the base
    # is unknown, 6 the folder exists.
    exec 2>/dev/null </dev/null
    enter "\${1:-}" || exit 2
    leaf="\${2:-}"; branch="\${3:-}"; base="\${4:-}"
    case "$leaf" in ''|.*|*[!A-Za-z0-9._-]*) exit 2 ;; esac
    [ "\${#leaf}" -le 64 ] || exit 2
    case "$branch" in ''|-*|*..*|*//*|*/|*.lock|*[!A-Za-z0-9._/-]*) exit 2 ;; esac
    [ "\${#branch}" -le 100 ] || exit 2
    case "$base" in -) base=HEAD ;; ''|-*|*[!A-Za-z0-9._/@^~-]*) exit 2 ;; esac
    [ "\${#base}" -le 100 ] || exit 2
    hardened
    hg check-ref-format --branch "$branch" >/dev/null || exit 2
    top="$(hg rev-parse --show-toplevel 2>/dev/null && printf x)" || exit 3
    top="\${top%x}"; top="\${top%"$nl"}"
    real "$top" || exit 3
    repo="$r"
    inroot "$repo" && [ "$repo" != "$root" ] || exit 2
    case "$here" in "$repo"|"$repo"/*) ;; *) exit 3 ;; esac
    rel="\${here#"$repo"}"
    parent="$repo.worktrees"
    [ ! -L "$parent" ] || exit 2
    allowed "$parent" 2>/dev/null || { mkdir -p -- "$parent" && allowed "$parent"; } || exit 2
    wpath="$r/$leaf"
    [ ! -e "$wpath" ] && [ ! -L "$wpath" ] || exit 6
    if hg show-ref --verify --quiet "refs/heads/$branch"; then
      commit="$(hg rev-parse --verify -q "refs/heads/$branch")" || exit 1
      err="$(timeout 120 git $gf worktree add --quiet -- "$wpath" "$branch" 2>&1 >/dev/null)" || { printf '#error %s\\n' "$(oneline "$err")"; exit 4; }
    else
      commit="$(hg rev-parse --verify -q --end-of-options "$base^{commit}")" || exit 5
      err="$(timeout 120 git $gf worktree add --quiet -b "$branch" -- "$wpath" "$commit" 2>&1 >/dev/null)" || { printf '#error %s\\n' "$(oneline "$err")"; exit 1; }
    fi
    real "$wpath" && inroot "$r" || exit 1
    printf 'ok\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$r" "$branch" "$commit" "$repo" "$rel"
    exit 0
    ;;
  wt-status)
    # What would be lost by removing the linked worktree at <path>: files with changes (dirty), untracked files, and commits that only
    # this branch has (reachable from no other branch and no remote). One key=value per line. Exit 2 when it isn't a linked worktree.
    exec 2>/dev/null </dev/null
    enter "\${1:-}" || exit 2
    [ -f .git ] && [ ! -L .git ] || exit 2
    hardened
    top="$(hg rev-parse --show-toplevel 2>/dev/null && printf x)" || exit 3
    top="\${top%x}"; top="\${top%"$nl"}"
    real "$top" && [ "$r" = "$here" ] || exit 2
    branch="$(hg symbolic-ref --short -q HEAD)" || branch=
    head="$(hg rev-parse --verify -q HEAD)" || head=
    st="$(timeout 30 git $gf status --porcelain=v1 --untracked-files=normal)" || exit 1
    untracked="$(printf '%s\\n' "$st" | grep -c '^??')"
    dirty="$(printf '%s\\n' "$st" | grep -v '^??' | grep -c .)"
    if [ -n "$branch" ]; then
      unique="$(timeout 30 git $gf rev-list --count HEAD --not --exclude="$branch" --branches --remotes)" || exit 1
    else
      unique="$(timeout 30 git $gf rev-list --count HEAD --not --branches --remotes)" || exit 1
    fi
    printf 'dirty=%s\\nuntracked=%s\\nunique=%s\\nbranch=%s\\nhead=%s\\n' "$dirty" "$untracked" "$unique" "$branch" "$head"
    exit 0
    ;;
  wt-list)
    # The worktrees of the repository containing <folder>, as one JSON array: path, head, branch, detached, locked, prunable.
    exec 2>/dev/null </dev/null
    enter "\${1:-}" || exit 2
    hardened
    timeout 30 git $gf worktree list --porcelain -z | jq -Rsc 'split("\\u0000\\u0000") | map(select(length > 0) | split("\\u0000") | map(select(length > 0))
      | { path: (map(select(startswith("worktree "))[9:]) | first // null), head: (map(select(startswith("HEAD "))[5:]) | first // null),
          branch: (map(select(startswith("branch refs/heads/"))[18:]) | first // null), detached: any(. == "detached"),
          locked: any(. == "locked" or startswith("locked ")), prunable: any(. == "prunable" or startswith("prunable ")) })' || exit 1
    exit 0
    ;;
  wt-remove)
    # Removes the linked worktree at <path>. Mode 'safe' refuses (7) when it has changes or untracked files; 'force' discards them: the
    # caller has asked the person. Its branch is deleted only when fully merged (git branch -d), so commits are never lost with it.
    # Prints branch=deleted|kept and ok.
    exec 2>/dev/null </dev/null
    mode="\${2:-}"
    case "$mode" in safe|force) ;; *) exit 2 ;; esac
    enter "\${1:-}" || exit 2
    [ -f .git ] && [ ! -L .git ] || exit 2
    wt="$here"
    hardened
    branch="$(hg symbolic-ref --short -q HEAD)" || branch=
    common="$(hg rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 3
    main="\${common%/.git}"
    [ "$main" != "$common" ] || exit 3
    real "$main" && inroot "$r" || exit 3
    cd -P -- "$r" || exit 3
    hardened
    if [ "$mode" = force ]; then flag=--force; else flag=; fi
    err="$(timeout 120 git $gf worktree remove $flag -- "$wt" 2>&1 >/dev/null)" || {
      case "$err" in *modified*|*untracked*|*"use --force"*) exit 7 ;; esac
      printf '#error %s\\n' "$(oneline "$err")"; exit 1
    }
    if [ -n "$branch" ]; then
      if timeout 30 git $gf branch -d -- "$branch" >/dev/null 2>&1; then echo branch=deleted; else echo branch=kept; fi
    fi
    echo ok
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
  authcheck)
    # Only whether Account Pool's helper is what Claude Code is configured to use: the drop-in, a regular
    # file and not a link (which could lead anywhere, the home folder included), holding one JSON object
    # that names the helper. Nothing else is read, and only pass or fail is printed. \\A and \\z anchor
    # the whole value (^ and $ would match at a newline inside it).
    exec 2>/dev/null </dev/null
    f="\${CLAUDEPILOT_ACCOUNT_DROPIN:-${ACCOUNT_DROPIN}}"
    if [ -f "$f" ] && [ ! -L "$f" ] && jq -se 'length == 1 and (.[0] | type) == "object" and (.[0].apiKeyHelper | type) == "string" and (.[0].apiKeyHelper | test("\\\\A${ACCOUNT_HELPER} [A-Za-z0-9-]{1,64}\\\\z"))' "$f" >/dev/null; then
      echo pass
    else
      echo fail
    fi
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
