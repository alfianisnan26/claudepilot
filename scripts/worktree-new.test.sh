#!/usr/bin/env bash
# Test of scripts/worktree-new.sh: bash scripts/worktree-new.test.sh
# A fake origin and main checkout, and a worktrees folder, at runtime in a temp folder inside this checkout (removed at the end).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd -P)
script=$here/scripts/worktree-new.sh
base=$(mktemp -d "$here/.wntest.XXXXXX")
trap 'rm -rf "$base"' EXIT
main=$base/main; root=$base/trees
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
g() { git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false "$@"; }

mkdir -p "$root" "$main/packages/contracts" "$main/apps/server" "$main/apps/web" "$main/node_modules/left-pad"
echo '{"name":"root"}' > "$main/package.json"; echo '{"lock":1}' > "$main/package-lock.json"
for d in packages/contracts apps/server apps/web; do echo "{\"name\":\"$d\"}" > "$main/$d/package.json"; done
cp "$here/.gitignore" "$main/.gitignore"
g init -q --bare -b integration "$base/origin.git"
g -C "$main" init -q -b integration
g -C "$main" add -A
g -C "$main" commit -q -m init
g -C "$main" remote add origin "$base/origin.git"
g -C "$main" push -q origin integration

run() { WORKTREE_TEST_MODE=1 bash "$script" --main "$main" --root "$root" "$@"; }
expect() {
  local name=$1 code=$2 frag=$3; shift 4
  local rc=0 err
  err=$(run "$@" 2>&1 >/dev/null) || rc=$?
  if [ "$rc" = "$code" ] && { [ -z "$frag" ] || [[ $err == *"$frag"* ]]; }; then ok "$name"; else bad "$name (exit $rc: $err)"; fi
}

expect "new worktree exits 0" 0 "" -- T-12 my-slice
wt=$root/ticket-t-12-my-slice
[ "$(g -C "$wt" rev-parse --abbrev-ref HEAD)" = ticket/T-12-my-slice ] && ok "on branch ticket/T-12-my-slice" || bad "on branch"
[ "$(g -C "$wt" rev-parse HEAD)" = "$(g -C "$main" rev-parse origin/integration)" ] && ok "from origin/integration" || bad "from origin/integration"
[ "$(readlink "$wt/node_modules/left-pad")" = "$main/node_modules/left-pad" ] && ok "deps linked" || bad "deps linked"
[ -z "$(g -C "$wt" status --porcelain)" ] && ok "git status clean" || bad "git status clean"
expect "existing path refused" 2 "already exists" -- T-12 my-slice
mkdir -p "$base/x"; g -C "$main" branch ticket/T-13-taken
expect "existing branch refused" 2 "branch ticket/T-13-taken already exists" -- T-13 taken
expect "bad ticket id refused" 2 "T-<n>" -- 13 slug
expect "path escape refused" 2 "slug" -- T-14 ../evil
expect "slash slug refused" 2 "slug" -- T-14 a/b
expect "leading-dash slug refused" 2 "slug" -- T-14 -evil
expect "glob star slug refused" 2 "slug" -- T-14 'a*'
expect "glob bracket slug refused" 2 "slug" -- T-14 '[a]b'
expect "glob question slug refused" 2 "slug" -- T-14 'a?b'
# --main and --root are refused without the test-only variable (env -u: the variable may be set around this test)
for flag in --main --root; do
  rc=0; err=$(env -u WORKTREE_TEST_MODE bash "$script" "$flag" "$base" T-16 flagtest 2>&1 >/dev/null) || rc=$?
  if [ "$rc" = 2 ] && [[ $err == *"$flag is for tests only"* ]]; then ok "$flag refused without WORKTREE_TEST_MODE"; else bad "$flag refused without WORKTREE_TEST_MODE (exit $rc: $err)"; fi
done
rc=0; err=$(WORKTREE_TEST_MODE=0 bash "$script" --root "$base" T-16 flagtest 2>&1 >/dev/null) || rc=$?
[ "$rc" = 2 ] && ok "--root refused when the variable is not 1" || bad "--root refused when the variable is not 1 (exit $rc)"
[ ! -e "$root/ticket-t-16-flagtest" ] && ok "nothing made by a refused flag" || bad "nothing made by a refused flag"
[ ! -e "$base/evil" ] && ok "nothing made outside the folder" || bad "nothing made outside the folder"

[ "$fails" = 0 ] && { echo "all passed"; exit 0; }
echo "$fails failed"; exit 1
