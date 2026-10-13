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
 *   (exit 4 when it doesn't, printing `#short <got> <expected>`, so a cut-short upload leaves nothing), and its path is printed. `<name>` is plain
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
 * - `repo-find <root> <depth> <max>`, `repo-state <path> <prev>...`, `repo-track <folder> <base>` and `repo-sync <folder>`
 *   are Workspace git (workspace-git PRD, `repos/`): which git repositories are under a folder (a bounded walk that
 *   skips hidden, dependency and cache folders and follows no link), what each one looks like (branch, HEAD,
 *   upstream, change counts, stash, remotes without credentials, worktrees, submodule records, the commits since the
 *   last look), a new worktree's branch made to follow a remote branch, and a fast-forward-only sync of one
 *   checked-out branch. All run git hardened like Diff's; only `repo-sync`'s fetch reaches a network, and it refuses
 *   a repository whose own settings run a program. Their formats are documented where each is implemented.
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

# >>> repo helpers
# Prints each line of stdin after the tag $1 and a tab.
tagged() { while IFS= read -r l; do printf '%s\\t%s\\n' "$1" "$l"; done; }
# The record repo-state prints for folder $1 (the commit its HEAD was at last time is $2, '-' for none). Run it in a subshell: it
# enters the folder and hardens git for that repository. R and Z are the caller's.
repostate() {
  enter "$1" || { printf 'E\\trefused\\n'; return 0; }
  hardened
  err="$t/err"
  top="$(git $gf rev-parse --show-toplevel 2>"$err" && printf x)" || {
    if grep -q 'dubious ownership' "$err"; then printf 'E\\townership\\n'; else printf 'E\\tnotrepo\\n'; fi
    return 0
  }
  top="\${top%x}"; top="\${top%"$nl"}"
  real "$top" && [ "$r" = "$here" ] || { printf 'E\\tnotrepo\\n'; return 0; }
  gd="$(hg rev-parse --absolute-git-dir)" || gd=
  gc="$(hg rev-parse --path-format=absolute --git-common-dir)" || gc=
  su="$(hg rev-parse --show-superproject-working-tree)" || su=
  case "$gd$gc$su" in *"$nl"*|*"$tab"*) printf 'E\\tunreadable\\n'; return 0 ;; esac
  [ -n "$gd" ] && [ -n "$gc" ] || { printf 'E\\tunreadable\\n'; return 0; }
  printf 'T\\t%s\\t%s\\t%s\\n' "$gd" "$gc" "$su"
  st="$t/st"
  timeout 20 git $gf status --porcelain=v2 --branch --untracked-files=normal --ignore-submodules=all >"$st" 2>"$err"
  rc=$?
  if [ "$rc" -eq 124 ]; then printf 'E\\ttimeout\\n'; return 0; fi
  if [ "$rc" -ne 0 ]; then printf 'E\\tunreadable\\n'; return 0; fi
  oid=; bh=; up=; ab=
  while IFS= read -r l; do
    case "$l" in
      '# branch.oid '*) oid="\${l#'# branch.oid '}" ;;
      '# branch.head '*) bh="\${l#'# branch.head '}" ;;
      '# branch.upstream '*) up="\${l#'# branch.upstream '}" ;;
      '# branch.ab '*) ab="\${l#'# branch.ab '}" ;;
      '# '*) ;;
      *) break ;;
    esac
  done < "$st"
  printf 'B\\t%s\\t%s\\n' "$bh" "$oid"
  printf 'D\\t%s\\t%s\\t%s\\t%s\\n' "$(grep -c '^[12] [^.]' "$st")" "$(grep -c '^[12] .[^.]' "$st")" "$(grep -c '^? ' "$st")" "$(grep -c '^u ' "$st")"
  # Untracked folders (a folder of other repositories is one): the portal leaves out those that hold repositories it tracks itself.
  sed -n 's/^? \\(.*\\/\\)$/\\1/p' "$st" | head -n 100 | tagged Q
  if [ -n "$up" ]; then
    case "$ab" in
      '+'*' -'*) a="\${ab#+}"; a="\${a%% *}"; b="\${ab##* -}"; printf 'U\\t%s\\t%s\\t%s\\n' "$up" "$a" "$b" ;;
      *) printf 'U\\t%s\\tgone\\n' "$up" ;;
    esac
  fi
  if [ "$oid" != '(initial)' ] && [ -n "$oid" ]; then
    timeout 20 git $gf log -1 --no-show-signature --no-notes --format='%H%x09%cI%x09%an%x09%s' HEAD 2>/dev/null | head -n 1 | tr -d '\\000-\\010\\013-\\037\\177' | tagged H
  fi
  n="$(timeout 20 git $gf rev-list --walk-reflogs --count refs/stash 2>/dev/null)" || n=
  digits "$n" || n=0
  printf 'S\\t%s\\n' "$n"
  if [ -n "$(timeout 10 git $gf remote 2>/dev/null)" ]; then
    if [ "$oid" != '(initial)' ] && [ -n "$oid" ]; then
      n="$(timeout 20 git $gf rev-list --count --max-count=1001 HEAD --not --remotes -- 2>/dev/null)" || n=
      if digits "$n"; then printf 'P\\t%s\\n' "$n"; fi
    fi
  fi
  timeout 10 git $gf config --get-regexp '^remote\\..*\\.(url|pushurl)$' 2>/dev/null | sed -e 's|\\(://\\)[^/]*@|\\1|' -e 's|[?#].*$||' | head -n 40 | tagged X
  op=
  [ ! -f "$gd/MERGE_HEAD" ] || op=merge
  [ ! -d "$gd/rebase-merge" ] && [ ! -d "$gd/rebase-apply" ] || op=rebase
  [ ! -f "$gd/CHERRY_PICK_HEAD" ] || op=cherry-pick
  [ ! -f "$gd/REVERT_HEAD" ] || op=revert
  [ ! -f "$gd/BISECT_LOG" ] || op=bisect
  if [ -n "$op" ]; then printf 'M\\t%s\\n' "$op"; fi
  n="$(timeout 10 git $gf config --name-only --get-regexp '^filter\\.' 2>/dev/null | sed -n 's/^filter\\.\\([A-Za-z0-9_.-]*\\)\\.[a-z]*$/\\1/p' | sort -u | wc -l)"
  digits "$n" || n=0
  printf 'L\\t%s\\n' "$n"
  if [ -f "$gc/FETCH_HEAD" ]; then
    n="$(stat -c %Y "$gc/FETCH_HEAD" 2>/dev/null)"
    if digits "$n"; then printf 'F\\t%s\\n' "$n"; fi
  fi
  if [ "$gd" = "$gc" ]; then
    timeout 20 git $gf worktree list --porcelain -z 2>/dev/null | jq -Rsr 'split("\\u0000\\u0000") | .[] | select(length > 0) | split("\\u0000") | map(select(length > 0))
      | ["W", (map(select(startswith("worktree "))[9:]) | first // ""), (map(select(startswith("HEAD "))[5:]) | first // ""), (map(select(startswith("branch refs/heads/"))[18:]) | first // ""),
          ((if any(. == "detached") then "d" else "" end) + (if any(. == "locked" or startswith("locked ")) then "l" else "" end) + (if any(. == "prunable" or startswith("prunable ")) then "p" else "" end))] | @tsv' 2>/dev/null | head -n 200
  fi
  if [ -f .gitmodules ] && [ ! -L .gitmodules ]; then
    timeout 10 git $gf config -f .gitmodules --get-regexp '^submodule\\..*\\.(path|url)$' 2>/dev/null | sed -e 's|\\(://\\)[^/]*@|\\1|' -e 's|[?#].*$||' | head -n 2000 | tagged Y
    timeout 20 git $gf ls-files -s 2>/dev/null | grep '^160000 ' | head -n 1000 | tagged N
  fi
  prev="$2"
  if [ "$oid" != '(initial)' ] && [ -n "$oid" ] && [ "$oid" != "$prev" ]; then
    case "$prev" in
      *[!0-9a-f]*|'') ;;
      *)
        if [ "\${#prev}" -eq 40 ] || [ "\${#prev}" -eq 64 ]; then
          if timeout 20 git $gf cat-file -e "$prev^{commit}" 2>/dev/null; then
            if timeout 20 git $gf merge-base --is-ancestor "$prev" HEAD 2>/dev/null; then
              n="$(timeout 20 git $gf rev-list --count "$prev..HEAD" -- 2>/dev/null)" || n=
              digits "$n" || n=0
              printf 'K\\tff\\t%s\\n' "$n"
              timeout 20 git $gf log --no-show-signature --max-count=30 --format='%H%x09%an%x09%s' "$prev..HEAD" -- 2>/dev/null | tr -d '\\000-\\010\\013-\\037\\177' | tagged C
            else
              printf 'K\\trewritten\\n'
              timeout 20 git $gf log --no-show-signature --max-count=5 --format='%H%x09%an%x09%s' HEAD -- 2>/dev/null | tr -d '\\000-\\010\\013-\\037\\177' | tagged C
            fi
          else
            printf 'K\\tunknown\\n'
            timeout 20 git $gf log --no-show-signature --max-count=5 --format='%H%x09%an%x09%s' HEAD -- 2>/dev/null | tr -d '\\000-\\010\\013-\\037\\177' | tagged C
          fi
        fi
        ;;
    esac
  fi
  return 0
}
# <<< repo helpers
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
    # Fewer (or more) bytes than announced: say how many came (exit 4), so the portal can tell a cut transfer from a wrong size.
    got="$(wc -c < "$tmp" | tr -d ' ')"
    [ "$got" -eq "$nbytes" ] || { rm -f "$tmp"; printf '#short %s %s\\n' "$got" "$nbytes"; exit 4; }
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
# >>> repo commands
  repo-find)
    # Where the git repositories are under <root> (a folder the path policy allows; "~" is the files root, "~/work" a folder in it), at
    # most <depth> folders down, at most <max> of them: "#root" and the root's real path, then "<type><TAB><path of the .git entry relative
    # to the root>" per repository (type d: a .git folder; f: a .git file, a submodule or a linked worktree; l: a link, which is no repository),
    # then "#truncated" when there were more than <max> and "#timeout" when the walk ran out of time. Hidden folders, dependency and
    # cache folders are not walked into; nothing is followed through a link. Exit 2 refused (the folder, the numbers).
    exec 2>/dev/null </dev/null
    case "\${1:-}" in '~') p="$froot" ;; '~/'*) p="$froot/\${1#'~/'}" ;; *) p="\${1:-}" ;; esac
    enter "$p" || exit 2
    depth="\${2:-}"; max="\${3:-}"
    digits "$depth" && digits "$max" || exit 2
    [ "$depth" -ge 1 ] && [ "$depth" -le 12 ] && [ "$max" -ge 1 ] && [ "$max" -le 5000 ] || exit 2
    t="$(mktemp)" || exit 1
    trap 'rm -f "$t"' EXIT
    trap 'exit 1' HUP INT TERM
    timeout "\${CLAUDEPILOT_FIND_SECONDS:-25}" find . -mindepth 1 -maxdepth "$depth" \\( -name node_modules -o -name vendor -o -name __pycache__ -o -name venv -o -name site-packages -o -name bower_components -o \\( -name '.*' ! -name .git \\) -o -path "*$nl*" \\) -prune -o -name .git -prune -printf '%y\\t%P\\n' > "$t"
    rc=$?
    # find prints in the file system's order (overlayfs and APFS differ): sorted, the list and what a cut at <max> keeps are the same everywhere.
    LC_ALL=C sort -o "$t" "$t"
    printf '#root\\t%s\\n' "$here"
    head -n "$max" "$t"
    if [ "$(wc -l < "$t")" -gt "$max" ]; then echo '#truncated'; fi
    if [ "$rc" -eq 124 ]; then echo '#timeout'; fi
    exit 0
    ;;
  repo-state)
    # Read-only look at repositories, as records for the portal: <path> <prev> pairs (at most 20), <prev> being the commit HEAD was at last
    # time or '-'. Each record: "R<TAB><path>", then tagged lines (T gitdir, common dir, superproject; B branch and commit; D staged,
    # unstaged, untracked, conflicted counts; Q the untracked folders; U upstream, ahead, behind or gone; H HEAD commit, date, author, subject; S stashes; P commits
    # on no remote; X remote settings with credentials removed; M operation in progress; L filters configured; F FETCH_HEAD time; W worktrees
    # as path, commit, branch, flags; Y and N what .gitmodules declares and the commits the index records for submodules; K and C the commits
    # since <prev>) or "E<TAB><why>" (refused, notrepo, ownership, timeout, unreadable), then "Z". Git runs hardened (no hook, filter or
    # fsmonitor of a repository runs) and never reaches a network; each call has 20 s. Exit 2 for arguments that make no pairs.
    exec 2>/dev/null </dev/null
    [ "$#" -ge 2 ] && [ $(($# % 2)) -eq 0 ] && [ "$#" -le 40 ] || exit 2
    t="$(mktemp -d)" || exit 1
    trap 'rm -rf "$t"' EXIT
    trap 'exit 1' HUP INT TERM
    while [ "$#" -ge 2 ]; do
      case "$1" in
        *"$nl"*|*"$tab"*|'') ;;
        *)
          printf 'R\\t%s\\n' "$1"
          ( repostate "$1" "$2" ) || printf 'E\\tunreadable\\n'
          printf 'Z\\n'
          ;;
      esac
      shift 2
    done
    exit 0
    ;;
  repo-track)
    # Makes the branch checked out in the linked worktree at <folder> follow <base> when <base> is a remote-tracking branch (origin/main): what
    # "git worktree add -b <branch> <path> origin/main" does and the commit id wt-add is given doesn't. Prints "tracking" when it did. Only
    # the branch's own two settings (remote and merge) are written. Exit 2 refused (the folder, a value, not a linked worktree).
    exec 2>/dev/null </dev/null
    enter "\${1:-}" || exit 2
    base="\${2:-}"
    case "$base" in ''|-*|*[!A-Za-z0-9._/@^~-]*) exit 2 ;; esac
    [ "\${#base}" -le 100 ] || exit 2
    [ -f .git ] && [ ! -L .git ] || exit 2
    hardened
    br="$(hg symbolic-ref --short -q HEAD)" || exit 0
    full="$(hg rev-parse --symbolic-full-name "$base" 2>/dev/null)" || exit 0
    case "$full" in refs/remotes/*) ;; *) exit 0 ;; esac
    if hg branch --set-upstream-to="$base" "$br" >/dev/null 2>&1; then echo tracking; fi
    exit 0
    ;;
  repo-sync)
    # Brings the checked-out branch of the repository at <folder> up to its upstream when that takes nothing but a fast-forward: fetches the
    # upstream branch (the only thing here that reaches a network), then "merge --ff-only". Nothing else, ever: no merge commit, rebase,
    # stash, reset or clean; a repository with changes to tracked files, an operation in progress, a detached HEAD, no upstream or a branch
    # that has diverged is left alone and says why. Refused too when the repository's own settings run a program or change where a fetch
    # goes (includes, credential helpers, ssh and proxy commands, upload-pack, URL rewrites, protocol and http settings): those aren't
    # overridden, so nothing of the repository's runs. The URL fetched from must be https, http, ssh, git, file or a path. Prints one line:
    # "sync<TAB>updated|current|refused|failed<TAB>from<TAB>to<TAB>ahead<TAB>behind<TAB>note". Exit 2 refused folder, 3 not a repository.
    exec 2>/dev/null </dev/null
    enter "\${1:-}" || exit 2
    hardened
    top="$(hg rev-parse --show-toplevel 2>/dev/null && printf x)" || exit 3
    top="\${top%x}"; top="\${top%"$nl"}"
    real "$top" && [ "$r" = "$here" ] || exit 3
    syncout() { printf 'sync\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$1" "$2" "$3" "$4" "$5" "$6"; exit 0; }
    bad="$(timeout 20 git $gf config --show-scope --list 2>/dev/null | while IFS="$tab" read -r sc kv; do case "$sc" in local|worktree) printf '%s\\n' "$kv" ;; esac; done | grep -i -E '^(include\\.|includeif\\.|credential\\.|core\\.(sshcommand|gitproxy|askpass)|remote\\.[^=]*\\.(uploadpack|receivepack|proxy|vcs)|url\\.|protocol\\.|http\\.)' | cut -d= -f1 | head -n 3 | tr -cd 'A-Za-z0-9._/@:,\\n-' | tr '\\n' ' ')"
    [ -z "$bad" ] || syncout refused '' '' '' '' "its own settings run programs or change the fetch: \${bad% }"
    from="$(hg rev-parse -q --verify HEAD)" || syncout refused '' '' '' '' 'no commit yet'
    br="$(hg symbolic-ref --short -q HEAD)" || syncout refused "$from" '' '' '' 'detached HEAD'
    gd="$(hg rev-parse --absolute-git-dir)" || syncout failed "$from" '' '' '' 'unreadable'
    for op in MERGE_HEAD rebase-merge rebase-apply CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
      [ ! -e "$gd/$op" ] || syncout refused "$from" '' '' '' 'an operation is in progress'
    done
    upref="$(hg rev-parse --symbolic-full-name '@{u}' 2>/dev/null)" || syncout refused "$from" '' '' '' 'no upstream'
    remote="$(hg config "branch.$br.remote")" || remote=
    merge="$(hg config "branch.$br.merge")" || merge=
    st="$(timeout 30 git $gf status --porcelain=v1 --untracked-files=no --ignore-submodules=all 2>/dev/null)" || syncout failed "$from" '' '' '' 'unreadable'
    [ -z "$st" ] || syncout refused "$from" '' '' '' 'it has changes'
    if [ -n "$remote" ] && [ "$remote" != . ]; then
      case "$merge" in refs/heads/*) ;; *) syncout refused "$from" '' '' '' 'the upstream is not a branch' ;; esac
      case "$merge$upref" in *[!A-Za-z0-9._/-]*) syncout refused "$from" '' '' '' 'unusual branch name' ;; esac
      url="$(hg ls-remote --get-url "$remote" 2>/dev/null)"
      case "$url" in
        -*|*::*|'') syncout refused "$from" '' '' '' 'not a URL sync fetches from' ;;
        https://*|http://*|ssh://*|git://*|file:///*|/*) ;;
        *@*:*) ;;
        *) syncout refused "$from" '' '' '' 'not a URL sync fetches from' ;;
      esac
      export GIT_SSH_COMMAND="\${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes"
      err="$(timeout 120 git $gf -c protocol.ext.allow=never -c submodule.recurse=false -c gc.auto=0 -c maintenance.auto=false fetch --no-tags --no-recurse-submodules --quiet -- "$remote" "+$merge:$upref" 2>&1 >/dev/null)" || syncout failed "$from" '' '' '' "$(oneline "$err")"
    fi
    ab="$(hg rev-list --left-right --count "HEAD...$upref" -- 2>/dev/null)" || syncout failed "$from" '' '' '' 'the upstream is not known here'
    a="\${ab%%"$tab"*}"; b="\${ab##*"$tab"}"
    digits "$a" && digits "$b" || syncout failed "$from" '' '' '' 'unreadable'
    [ "$b" -gt 0 ] || syncout current "$from" "$from" "$a" "$b" ''
    [ "$a" -eq 0 ] || syncout refused "$from" '' "$a" "$b" 'it has diverged'
    err="$(timeout 120 git $gf -c submodule.recurse=false merge --ff-only --no-verify-signatures --no-edit --quiet -- "$upref" 2>&1 >/dev/null)" || syncout failed "$from" '' "$a" "$b" "$(oneline "$err")"
    to="$(hg rev-parse -q --verify HEAD)" || to=
    syncout updated "$from" "$to" 0 0 ''
    ;;
# <<< repo commands
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
