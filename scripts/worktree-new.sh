#!/usr/bin/env bash
# A new worktree for a ticket slice, with its dependencies linked (T-586, T-595):
#   scripts/worktree-new.sh T-<n> <slug>
# Makes branch ticket/T-<n>-<slug> from origin/integration at /home/node/work/claudepilot.worktrees/ticket-t-<n>-<slug> (main checkout
# /home/node/work/claudepilot), then runs scripts/worktree-deps.sh on it. The flags --main <path> and --root <path> are for the tests
# only: they are refused unless WORKTREE_TEST_MODE=1 is set.
# REFUSES (exit 2) a bad ticket id or slug, a branch or a folder that already exists, and a path outside the root. Deletes nothing.
set -eu
set -o pipefail
refuse() { echo "refused: $*" >&2; exit 2; }
main=/home/node/work/claudepilot; root=/home/node/work/claudepilot.worktrees
# --main and --root exist for the tests only: without WORKTREE_TEST_MODE=1 the caller cannot move the script's reach.
while [ $# -gt 0 ]; do
  case $1 in
    --main|--root)
      [ "${WORKTREE_TEST_MODE:-}" = 1 ] || refuse "$1 is for tests only (set WORKTREE_TEST_MODE=1); the defaults are the only reach"
      if [ "$1" = --main ]; then main=${2:?--main <path>}; else root=${2:?--root <path>}; fi
      shift 2 ;;
    *) break ;;
  esac
done
ticket=${1:?usage: scripts/worktree-new.sh T-<n> <slug>}; slug=${2:?slug}
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
deps_args=(); [ "${WORKTREE_TEST_MODE:-}" = 1 ] && deps_args=(--main "$main" --root "$root")
bash "$(dirname "$0")/worktree-deps.sh" "${deps_args[@]+"${deps_args[@]}"}" "$path" || { echo "worktree $path exists, but its dependencies are not linked (see above)" >&2; exit 2; }
echo "worktree-new: $path on $branch"
