#!/usr/bin/env bash
# The one door for QA screenshots (T-868): copies PNGs from the browser's download folder into a worktree's docs/screenshots/.
#   scripts/shots-in.sh [--force] <worktree> <name.png>...
# Why a script and not a `cp` allow line: a `*` in an allow line spans spaces, so `cp <png> <worktree>/docs/screenshots/*` would also let
# `cp <png> ~/.ssh/<key> <worktree>/...` copy a secret into a commit. This door does one job and refuses everything else.
# SOURCES: only a plain file named <name> directly in /home/node/Downloads/.playwright, ending in .png, starting with the PNG
#   magic bytes, at most 5 MB, not a symlink (nor any path part of it).
# DESTINATION: <root>/<worktree>/docs/screenshots/ where <root> is one of the worktree roots below and <worktree> is a git worktree
#   directly in it; no symlink anywhere on the path; made if missing. A file already there is kept unless --force.
# NAMES: [A-Za-z0-9._-] only, no leading dot, no `..`. Paths: no quote, backslash, space, glob or `..`.
# Every source and the destination are checked BEFORE anything is copied: one refusal copies nothing (exit 2, with the reason on stderr).
# Never deletes anything (the source stays). --src and --root are for the tests only: refused unless SHOTS_TEST_MODE=1.
set -eu
set -o pipefail
refuse() { echo "refused: $*" >&2; exit 2; }
src=/home/node/Downloads/.playwright
roots=(/home/node/work/claudepilot.worktrees /home/node/work/tradingbot.worktrees /home/node/work/agentic-worktrees /home/node/work/konfersi.worktrees)
max=5242880; magic=89504e470d0a1a0a; force=0; test_roots=()
while [ $# -gt 0 ]; do
  case $1 in
    --force) force=1; shift ;;
    --src|--root)
      [ "${SHOTS_TEST_MODE:-}" = 1 ] || refuse "$1 is for tests only (set SHOTS_TEST_MODE=1); the defaults are the only reach" # G:testmode
      if [ "$1" = --src ]; then src=${2:?--src <dir>}; else test_roots+=("${2:?--root <dir>}"); fi
      shift 2 ;;
    --) shift; break ;;
    -*) refuse "unknown flag $1" ;;
    *) break ;;
  esac
done
[ ${#test_roots[@]} -eq 0 ] || roots=("${test_roots[@]}")
dest=${1:?usage: scripts/shots-in.sh [--force] <worktree> <name.png>...}; shift
[ $# -gt 0 ] || refuse "no file names given"

# --- the destination
[[ $dest =~ ^/[A-Za-z0-9._/-]+$ ]] || refuse "worktree path has a character outside A-Za-z0-9._/- (quote, backslash, space, glob) or is not absolute" # G:destchars
dest=${dest%/}
[ -d "$dest" ] || refuse "no such worktree folder $dest"
real=$(realpath -e -- "$dest")
# One check for a symlink on any part of the path and for a `.` or `..` part: the path must already be its own real path.
[ "$real" = "$dest" ] || refuse "worktree path is not its own real path: a symlink or a . or .. part ($dest is $real)" # G:destreal
inroot=0
for r in "${roots[@]}"; do
  [ -d "$r" ] || continue
  rr=$(realpath -e -- "$r")
  case $real in "$rr"/*) rest=${real#"$rr"/}; case $rest in */*) ;; *) inroot=1 ;; esac ;; esac # G:destroot
done
[ "$inroot" = 1 ] || refuse "$dest is not directly inside a worktree root"
[ -e "$dest/.git" ] || refuse "$dest is not a git worktree (no .git)" # G:destgit
[ ! -L "$dest/docs" ] || refuse "$dest/docs is a symlink" # G:docslink
[ ! -L "$dest/docs/screenshots" ] || refuse "$dest/docs/screenshots is a symlink" # G:shotslink
out=$dest/docs/screenshots

# --- the sources
[ -d "$src" ] && [ ! -L "$src" ] || refuse "no source folder $src (or it is a symlink)" # G:srcdir
srcreal=$(realpath -e -- "$src")
files=()
for n in "$@"; do
  [[ $n =~ ^[A-Za-z0-9_-][A-Za-z0-9._-]*\.png$ ]] || refuse "name '$n' is not [A-Za-z0-9._-]+.png (no path, no leading dot)" # G:name
  case $n in *..*) refuse "name '$n' has .." ;; esac # G:namedots
  f=$srcreal/$n
  [ ! -L "$f" ] || refuse "$n is a symlink" # G:srclink
  [ -f "$f" ] || refuse "$n is not a regular file in $src" # G:srcfile
  size=$(stat -c %s -- "$f")
  [ "$size" -le "$max" ] || refuse "$n is $size bytes (over $max)" # G:size
  [ "$(head -c 8 -- "$f" | od -An -tx1 | tr -d ' \n')" = "$magic" ] || refuse "$n does not start with the PNG magic bytes" # G:magic
  [ ! -L "$out/$n" ] || refuse "$out/$n is a symlink" # G:tolink
  if [ -e "$out/$n" ] && [ "$force" != 1 ]; then refuse "$out/$n exists (use --force to replace it)"; fi # G:exists
  files+=("$n")
done

# --- the copy
mkdir -p -- "$out"
for n in "${files[@]}"; do
  cp -T -- "$srcreal/$n" "$out/$n"
  echo "shots-in: $srcreal/$n -> $out/$n"
done
