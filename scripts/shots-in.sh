#!/usr/bin/env bash
# The one door for QA screenshots (T-868): copies PNGs from the browser's download folder into a worktree's docs/screenshots/.
#   scripts/shots-in.sh [--force] <worktree> <name.png>...
# Why a script and not a `cp` allow line: a `*` in an allow line spans spaces, so `cp <png> <worktree>/docs/screenshots/*` would also let
# `cp <png> ~/.ssh/<key> <worktree>/...` copy a secret into a commit. This door does one job and refuses everything else.
# SOURCES: only a plain file named <name> directly in /home/node/Downloads/.playwright, ending in .png, starting with the PNG
#   signature (all 8 bytes) and an IHDR chunk name at bytes 12-15, at most 5 MB, not a symlink (nor any path part of it).
# DESTINATION: <root>/<worktree>/docs/screenshots/ where <root> is one of the worktree roots below and <worktree> is a git worktree
#   directly in it; no symlink anywhere on the path; made if missing. A file already there is kept unless --force.
# NAMES: [A-Za-z0-9._-] only, no leading dot, no `..`. Paths: no quote, backslash, space, glob or `..`.
# Every source and the destination are checked BEFORE anything is copied: one refusal copies nothing (exit 2, with the reason on stderr).
# The copy is staged in a private folder inside the target and verified there (no check-then-copy race), then renamed with `mv -n`.
# Deletes only that staging folder (the source stays). --src and --root are for the tests only: refused unless SHOTS_TEST_MODE=1.
# There is NO hook option and no code path that runs a caller-chosen program (`--hook` is an unknown flag). The race tests
# (shots-in.test.sh) build a COPY of this script in their own temp folder, with calls inserted at the two `# T:` marker lines below.
set -eu
set -o pipefail
refuse() { echo "refused: $*" >&2; exit 2; }
src=/home/node/Downloads/.playwright
roots=(/home/node/work/claudepilot.worktrees /home/node/work/tradingbot.worktrees /home/node/work/agentic-worktrees /home/node/work/konfersi.worktrees)
max=5242880; magic=89504e470d0a1a0a; force=0; test_roots=(); stage=""
trap 'if [ -n "$stage" ]; then rm -rf -- "$stage"; fi' EXIT
while [ $# -gt 0 ]; do
  case $1 in
    --force) force=1; shift ;;
    --src|--root)
      [ "${SHOTS_TEST_MODE:-}" = 1 ] || refuse "$1 is for tests only (set SHOTS_TEST_MODE=1); the defaults are the only reach" # G:testmode
      case $1 in
        --src) src=${2:?--src <dir>} ;;
        *) test_roots+=("${2:?--root <dir>}") ;;
      esac
      shift 2 ;;
    --) shift; break ;;
    -*) refuse "unknown flag $1" ;;
    *) break ;;
  esac
done
[ ${#test_roots[@]} -eq 0 ] || roots=("${test_roots[@]}")
dest=${1:?usage: scripts/shots-in.sh [--force] <worktree> <name.png>...}; shift
[ $# -gt 0 ] || refuse "no file names given"

# A PNG starts with its 8 signature bytes, then the first chunk: 4 bytes of length and the name IHDR (bytes 12-15).
check_png() {
  local h
  h=$(head -c 16 -- "$1" | od -An -tx1 | tr -d ' \n')
  [ "${#h}" = 32 ] || refuse "$2 is shorter than a PNG signature and its IHDR chunk header"
  [ "${h:0:16}" = "$magic" ] || refuse "$2 does not start with the PNG magic bytes (all 8)" # G:magic
  [ "${h:24:8}" = 49484452 ] || refuse "$2 has no IHDR chunk at bytes 12-15" # G:ihdr
}

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
  check_png "$f" "$n" # G:srcpng
  [ ! -L "$out/$n" ] || refuse "$out/$n is a symlink" # G:tolink
  if [ -e "$out/$n" ] && [ "$force" != 1 ]; then refuse "$out/$n exists (use --force to replace it)"; fi # G:exists
  files+=("$n")
done

# --- the copy (T-868 S2): a check and a copy are two steps, so a same-user process could swap a source for a link between them. The
# copy therefore goes to a fresh private folder INSIDE the target folder, without following a link (--no-dereference: a swapped-in
# link is copied as a link), the COPY is what gets verified, and only a verified regular file is renamed to its final name (`mv -n`:
# it never overwrites, and it never follows a link at the destination). Any refusal removes the staging folder (the trap).
mkdir -p -- "$out"
stage=$(mktemp -d -- "$out/.shots-in.XXXXXX") || refuse "cannot make a staging folder in $out"
# T:before-copy
for n in "${files[@]}"; do
  cp --no-dereference -T -- "$srcreal/$n" "$stage/$n" || refuse "copying $n failed" # G:cpfail
  [ -f "$stage/$n" ] && [ ! -L "$stage/$n" ] || refuse "the copy of $n is not a regular file (the source was swapped for a link?)" # G:copylink
  size=$(stat -c %s -- "$stage/$n")
  [ "$size" -le "$max" ] || refuse "the copy of $n is $size bytes (over $max)" # G:copysize
  check_png "$stage/$n" "$n" # G:copypng
done
# T:before-move
for n in "${files[@]}"; do
  if [ "$force" = 1 ]; then
    mv -f -T -- "$stage/$n" "$out/$n" || refuse "could not move $n into $out"
  else
    mv -n -T -- "$stage/$n" "$out/$n" || refuse "could not move $n into $out" # G:mvn
    [ ! -e "$stage/$n" ] || refuse "$out/$n exists (use --force to replace it)" # G:mvexists
  fi
  echo "shots-in: $srcreal/$n -> $out/$n"
done
