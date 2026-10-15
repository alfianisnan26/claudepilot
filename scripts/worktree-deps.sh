#!/usr/bin/env bash
# Gives a git worktree of this repository the dependencies of the main checkout, without npm ci (nothing heavy runs in the pod, D-61):
#   scripts/worktree-deps.sh [--main <main checkout>] <worktree>     --main defaults to /home/node/work/claudepilot (tests point it elsewhere)
# What it does (T-586, the same steps the coordinator did by hand for T-576):
#   - <worktree>/node_modules becomes a real folder whose every entry (and every @scope entry) links to the main checkout's install;
#   - @portal/contracts, @portal/server and @portal/web link to the WORKTREE's own packages/contracts, apps/server and apps/web;
#   - apps/web/node_modules (and apps/server, packages/contracts) link to the main checkout's, when the main one has them.
# node_modules is gitignored, so `git status` stays clean. Running it again changes nothing.
# It REFUSES (exit 2) when package-lock.json or any package.json differs from the main checkout's ("cluster npm ci needed": then the
# dependencies are not the same and a link would lie), when <worktree> is not a git worktree of the main checkout's repository, and
# for the main checkout itself. It deletes only symlinks it replaces; a real file or folder in its way is left and reported.
set -eu
main=/home/node/work/claudepilot
if [ "${1:-}" = "--main" ]; then main=${2:?--main <path>}; shift 2; fi
wt=${1:?usage: scripts/worktree-deps.sh [--main <main checkout>] <worktree>}
refuse() { echo "refused: $*" >&2; exit 2; }

[ -d "$main/node_modules" ] || refuse "no install at $main/node_modules"
[ -d "$wt" ] || refuse "$wt is not a folder"
main=$(cd "$main" && pwd -P)
wt=$(cd "$wt" && pwd -P)
[ "$wt" != "$main" ] || refuse "$wt is the main checkout, not a worktree"
[ "$(git -C "$wt" rev-parse --show-toplevel 2>/dev/null || :)" = "$wt" ] || refuse "$wt is not the top of a git worktree"
common=$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || :)
[ -n "$common" ] && [ "$(cd "$common" && pwd -P)" = "$(cd "$main/.git" && pwd -P)" ] || refuse "$wt is not a worktree of $main"
[ "$(git -C "$wt" rev-parse --absolute-git-dir)" != "$(cd "$main/.git" && pwd -P)" ] || refuse "$wt is the main checkout, not a worktree"

# Same package files as the main checkout? (the lockfile and every package.json, tracked on either side)
files=$( { git -C "$wt" ls-files; git -C "$main" ls-files; } | grep -E '(^|/)(package\.json|package-lock\.json)$' | sort -u || :)
[ -n "$files" ] || refuse "no package.json found"
for f in $files; do
  cmp -s "$wt/$f" "$main/$f" || { echo "refused: $f differs from the main checkout's: cluster npm ci needed" >&2; exit 2; }
done

# Links $2 to $1 (replacing only a symlink); a real file or folder at $2 is left alone.
link() {
  if [ -L "$2" ] || [ ! -e "$2" ]; then ln -sfn "$1" "$2"
  else echo "left alone (not a link): $2" >&2; fi
}

nm=$wt/node_modules
if [ -L "$nm" ]; then rm "$nm"; fi
mkdir -p "$nm"
for e in "$main"/node_modules/* "$main"/node_modules/.[!.]*; do
  [ -e "$e" ] || [ -L "$e" ] || continue
  name=$(basename "$e")
  case $name in
    @portal) continue ;;
    @*)
      [ -d "$e" ] && [ ! -L "$e" ] || { link "$e" "$nm/$name"; continue; }
      if [ -L "$nm/$name" ]; then rm "$nm/$name"; fi
      mkdir -p "$nm/$name"
      for s in "$e"/*; do [ -e "$s" ] || [ -L "$s" ] || continue; link "$s" "$nm/$name/$(basename "$s")"; done ;;
    *) link "$e" "$nm/$name" ;;
  esac
done
# The workspace packages are the worktree's own.
if [ -L "$nm/@portal" ]; then rm "$nm/@portal"; fi
mkdir -p "$nm/@portal"
link "$wt/packages/contracts" "$nm/@portal/contracts"
link "$wt/apps/server" "$nm/@portal/server"
link "$wt/apps/web" "$nm/@portal/web"
# Each workspace's own install, when the main checkout has one.
for d in apps/web apps/server packages/contracts; do
  if [ -d "$main/$d/node_modules" ] && [ -d "$wt/$d" ]; then link "$main/$d/node_modules" "$wt/$d/node_modules"; fi
done
echo "worktree-deps: $wt linked to $main"
