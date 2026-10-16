#!/usr/bin/env bash
# Test of scripts/worktree-deps.sh: bash scripts/worktree-deps.test.sh
# Builds a fake main checkout (a git repo with an install) and a fake worktree at runtime, in a temp folder inside this checkout (removed at the end).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd -P)
script=$here/scripts/worktree-deps.sh
base=$(mktemp -d "$here/.wdtest.XXXXXX")
trap 'rm -rf "$base"' EXIT
main=$base/main; wt=$base/wt
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
g() { git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false "$@"; }

mkdir -p "$main/packages/contracts" "$main/apps/server" "$main/apps/web" "$main/node_modules/left-pad" "$main/node_modules/@types/node" \
  "$main/node_modules/@portal" "$main/node_modules/.bin" "$main/apps/web/node_modules/vite"
echo '{"name":"root"}' > "$main/package.json"; echo '{"lock":1}' > "$main/package-lock.json"
for d in packages/contracts apps/server apps/web; do echo "{\"name\":\"$d\"}" > "$main/$d/package.json"; done
cp "$here/.gitignore" "$main/.gitignore"   # the real one: a symlink must be ignored too
ln -s ../../apps/web "$main/node_modules/@portal/web"
g -C "$main" init -q -b integration
g -C "$main" add -A
g -C "$main" commit -q -m init
g -C "$main" worktree add -q -b ticket/x "$wt"

run() { WORKTREE_TEST_MODE=1 bash "$script" --main "$main" --root "${root:-$base}" "$@"; }
# expect <name> <exit code> <stderr fragment or ""> -- args...
expect() {
  local name=$1 code=$2 frag=$3; shift 4
  local rc=0 err
  err=$(run "$@" 2>&1 >/dev/null) || rc=$?
  if [ "$rc" = "$code" ] && { [ -z "$frag" ] || [[ $err == *"$frag"* ]]; }; then ok "$name"; else bad "$name (exit $rc: $err)"; fi
}

# happy path
expect "happy path exits 0" 0 "" -- "$wt"
[ "$(readlink "$wt/node_modules/left-pad")" = "$main/node_modules/left-pad" ] && ok "package linked to main" || bad "package linked to main"
[ "$(readlink "$wt/node_modules/@types/node")" = "$main/node_modules/@types/node" ] && ok "scoped package linked to main" || bad "scoped package linked to main"
[ -d "$wt/node_modules/.bin" ] || [ -L "$wt/node_modules/.bin" ] && ok "dot entry linked" || bad "dot entry linked"
[ "$(readlink "$wt/node_modules/@portal/contracts")" = "$wt/packages/contracts" ] && ok "@portal/contracts is the worktree's" || bad "@portal/contracts is the worktree's"
[ "$(readlink "$wt/node_modules/@portal/server")" = "$wt/apps/server" ] && ok "@portal/server is the worktree's" || bad "@portal/server is the worktree's"
[ "$(readlink "$wt/node_modules/@portal/web")" = "$wt/apps/web" ] && ok "@portal/web is the worktree's" || bad "@portal/web is the worktree's"
[ "$(readlink "$wt/apps/web/node_modules")" = "$main/apps/web/node_modules" ] && ok "apps/web/node_modules linked" || bad "apps/web/node_modules linked"
[ -z "$(g -C "$wt" status --porcelain)" ] && ok "git status clean" || bad "git status clean: $(g -C "$wt" status --porcelain)"

# idempotent
before=$(find "$wt/node_modules" "$wt/apps/web/node_modules" -printf '%p -> %l\n' | sort)
expect "second run exits 0" 0 "" -- "$wt"
after=$(find "$wt/node_modules" "$wt/apps/web/node_modules" -printf '%p -> %l\n' | sort)
[ "$before" = "$after" ] && ok "second run changes nothing" || bad "second run changes nothing"
[ -z "$(g -C "$wt" status --porcelain)" ] && ok "git status clean after second run" || bad "git status clean after second run"

# a real file in the way is not deleted
mkdir -p "$wt/node_modules/real-dir"; echo keep > "$wt/node_modules/real-dir/f"
expect "run beside a real folder" 0 "" -- "$wt"
[ "$(cat "$wt/node_modules/real-dir/f")" = keep ] && ok "real folder kept" || bad "real folder kept"

# lockfile difference
echo '{"lock":2}' > "$wt/package-lock.json"
expect "lockfile difference refused" 2 "cluster npm ci needed" -- "$wt"
g -C "$wt" checkout -q -- package-lock.json
# package.json difference (root and a workspace)
echo '{"name":"root","x":1}' > "$wt/package.json"
expect "root package.json difference refused" 2 "cluster npm ci needed" -- "$wt"
g -C "$wt" checkout -q -- package.json
echo '{"name":"changed"}' > "$wt/apps/web/package.json"
expect "workspace package.json difference refused" 2 "cluster npm ci needed" -- "$wt"
g -C "$wt" checkout -q -- apps/web/package.json
expect "clean again passes" 0 "" -- "$wt"

# not a worktree of this repository
mkdir -p "$base/plain"
expect "plain folder refused" 2 "not" -- "$base/plain"
mkdir -p "$base/other"; g -C "$base/other" init -q
expect "other repository refused" 2 "not a worktree" -- "$base/other"
expect "missing folder refused" 2 "not a folder" -- "$base/nope"
# a subfolder of a worktree is not the worktree
expect "subfolder refused" 2 "not the top" -- "$wt/apps"
# the main checkout itself
expect "main checkout refused" 2 "main checkout" -- "$main"
[ -L "$main/node_modules/left-pad" ] && bad "main untouched" || ok "main untouched"
# a worktree outside the worktrees folder is refused, and nothing in it is linked
mkdir -p "$base/elsewhere"
root=$base/elsewhere expect "worktree outside the root refused" 2 "outside the worktrees folder" -- "$wt"
mkdir -p "$base/trees"; g -C "$main" worktree add -q -b ticket/y "$base/trees/y"
root=$base/trees expect "worktree inside the root passes" 0 "" -- "$base/trees/y"
root=$base/nope expect "missing root refused" 2 "no worktrees folder" -- "$wt"
# the flags are refused without the test-only variable
for flag in --main --root; do
  rc=0; err=$(env -u WORKTREE_TEST_MODE bash "$script" "$flag" "$base" "$wt" 2>&1 >/dev/null) || rc=$?
  if [ "$rc" = 2 ] && [[ $err == *"$flag is for tests only"* ]]; then ok "$flag refused without WORKTREE_TEST_MODE"; else bad "$flag refused without WORKTREE_TEST_MODE (exit $rc: $err)"; fi
done
rc=0; err=$(WORKTREE_TEST_MODE=0 bash "$script" --main "$main" "$wt" 2>&1 >/dev/null) || rc=$?
[ "$rc" = 2 ] && ok "--main refused when the variable is not 1" || bad "--main refused when the variable is not 1 (exit $rc)"
# without the flags, the real defaults apply: the fake worktree is not a worktree of the real main checkout, so it is refused
rc=0; err=$(env -u WORKTREE_TEST_MODE bash "$script" "$wt" 2>&1 >/dev/null) || rc=$?
[ "$rc" = 2 ] && ok "defaults apply without flags (refused)" || bad "defaults apply without flags (exit $rc: $err)"

# a symlinked workspace folder (or its parent) in the worktree is refused, and nothing is created through it
n=0
for d in apps/web apps/server packages/contracts apps packages; do
  n=$((n + 1)); w=$base/trees/s$n; out=$base/outside$n
  g -C "$main" worktree add -q -b "ticket/s$n" "$w"
  mkdir -p "$out"; cp -R "$w/$d/." "$out/"; rm -rf "${w:?}/$d"; ln -s "$out" "$w/$d"
  root=$base/trees expect "symlinked $d refused" 2 "is a symbolic link" -- "$w"
  [ -z "$(find "$out" -name node_modules)" ] && ok "nothing created through $d" || bad "nothing created through $d"
  [ ! -e "$w/node_modules" ] && ok "no node_modules made for $d" || bad "no node_modules made for $d"
done

[ "$fails" = 0 ] && { echo "all passed"; exit 0; }
echo "$fails failed"; exit 1
