#!/usr/bin/env bash
# A new worktree for a ticket slice, with its dependencies linked (T-586, T-595):
#   scripts/worktree-new.sh [--main <main checkout>] [--root <worktrees folder>] T-<n> <slug>
# Makes branch ticket/T-<n>-<slug> from origin/integration at <root>/ticket-t-<n>-<slug> (root defaults to
# /home/node/work/claudepilot.worktrees, main to /home/node/work/claudepilot), then runs scripts/worktree-deps.sh on it.
# REFUSES (exit 2) a bad ticket id or slug, a branch or a folder that already exists, and a path outside <root>. Deletes nothing.
set -eu
main=/home/node/work/claudepilot; root=/home/node/work/claudepilot.worktrees
while [ $# -gt 0 ]; do
  case $1 in
    --main) main=${2:?--main <path>}; shift 2 ;;
    --root) root=${2:?--root <path>}; shift 2 ;;
    *) break ;;
  esac
done
ticket=${1:?usage: scripts/worktree-new.sh [--main <path>] [--root <path>] T-<n> <slug>}; slug=${2:?slug}
refuse() { echo "refused: $*" >&2; exit 2; }
[[ $ticket =~ ^T-[0-9]+$ ]] || refuse "ticket id is T-<n>"
[[ $slug =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || refuse "slug is lowercase words joined by -"
branch=ticket/$ticket-$slug
dir=$(printf '%s' "ticket-$ticket-$slug" | tr 'A-Z' 'a-z')
[ -d "$root" ] || refuse "no worktrees folder $root"
root=$(cd "$root" && pwd -P)
path=$root/$dir
case $path in "$root"/*) ;; *) refuse "$path is outside $root" ;; esac
[ ! -e "$path" ] || refuse "$path already exists"
git -C "$main" show-ref --verify --quiet "refs/heads/$branch" && refuse "branch $branch already exists"
git -C "$main" fetch -q origin integration
git -C "$main" worktree add -q -b "$branch" "$path" origin/integration
bash "$(dirname "$0")/worktree-deps.sh" --main "$main" "$path" || { echo "worktree $path exists, but its dependencies are not linked (see above)" >&2; exit 2; }
echo "worktree-new: $path on $branch"
