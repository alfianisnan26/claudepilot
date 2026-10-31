#!/usr/bin/env bash
# Test of scripts/release-prep.sh and scripts/release-prep-lib.mjs: bash scripts/release-prep.test.sh
# A fixture repository (an origin with main and integration, and a checkout) in a temp folder inside this checkout, removed at the end.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd -P)
base=$(mktemp -d "$here/.rptest.XXXXXX")
trap 'rm -rf "$base"' EXIT
repo=$base/repo
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
g() { git -C "$repo" -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false "$@"; }
mig() { # mig <version> <name>...: one migrations.ts entry per pair
  echo 'export const MIGRATIONS: Migration[] = ['
  while [ $# -gt 0 ]; do printf "  {\n    version: %s,\n    name: '%s',\n    up(db) {\n      db.exec('SELECT %s');\n    },\n  },\n" "$1" "$2" "$1"; shift 2; done
  echo '];'
}
lock() { # lock <lightningcss optional deps json> <packages extra json>
  cat <<EOF
{ "name": "root", "lockfileVersion": 3, "packages": {
  "": { "name": "root", "workspaces": ["apps/*"], "devDependencies": { "lightningcss": "^1.0.0" } },
  "apps/server": { "name": "server", "dependencies": { "hono": "^4.0.0" } },
  "node_modules/lightningcss": { "version": "1.0.0", "optionalDependencies": $1 }$2
} }
EOF
}
mkdir -p "$repo/apps/server/src/store" "$repo/docs/coord"
echo '{"name":"root","workspaces":["apps/*"],"devDependencies":{"lightningcss":"^1.0.0"}}' > "$repo/package.json"
echo '{"name":"server","dependencies":{"hono":"^4.0.0"}}' > "$repo/apps/server/package.json"
lock '{ "lightningcss-linux-x64-gnu": "1.0.0", "lightningcss-darwin-arm64": "1.0.0" }' ', "node_modules/lightningcss-linux-x64-gnu": { "version": "1.0.0", "optional": true }' > "$repo/package-lock.json"
printf '| Id | Role | Migrations |\n| A1 | x | 40-49 |\nThe reporter has its own block, 900-909.\n' > "$repo/docs/coord/PLAN.md"
mig 1 one 40 forty > "$repo/apps/server/src/store/migrations.ts"
git init -q --bare -b main "$base/origin.git"
git -C "$base" init -q -b main repo 2>/dev/null || true
g add -A && g commit -q -m init && g remote add origin "$base/origin.git" && g push -q origin main && g push -q origin main:integration
g fetch -q origin
: > "$base/records"
run() { RELEASE_PREP_RECORDS=$base/records bash "$here/scripts/release-prep.sh" --repo "$repo" --no-fetch --no-fix "$@" 2>&1; }
libm() { RELEASE_PREP_REPO=$repo node "$here/scripts/release-prep-lib.mjs" migrations "$@" 2>&1; }
libl() { RELEASE_PREP_REPO=$repo node "$here/scripts/release-prep-lib.mjs" lock "$@" 2>&1; }
expect() { # expect <name> <exit> <fragment> <output> <rc>
  if [ "$5" = "$2" ] && [[ $4 == *"$3"* ]]; then ok "$1"; else bad "$1 (exit $5: $4)"; fi
}
commit() { g add -A && g commit -q -m "$1"; }

rc=0; out=$(libm HEAD) || rc=$?; expect "migrations clean on the base" 0 "2 migrations, 0 new" "$out" "$rc"
rc=0; out=$(libl HEAD) || rc=$?; expect "lock clean" 0 "1 linux-x64 native builds" "$out" "$rc"

# A new migration in a claimed block passes; a duplicate, an edit, a number the other branch used and an unclaimed block fail.
g checkout -q -b feat
mig 1 one 40 forty 41 fortyone 901 reporter > "$repo/apps/server/src/store/migrations.ts"; commit new
rc=0; out=$(libm HEAD) || rc=$?; expect "new migrations in claimed blocks pass" 0 "2 new since the base (41, 901)" "$out" "$rc"
mig 1 one 40 forty 41 fortyone 41 again > "$repo/apps/server/src/store/migrations.ts"; commit dup
rc=0; out=$(libm HEAD) || rc=$?; expect "duplicate version fails" 1 "migration 41 appears twice" "$out" "$rc"
mig 1 one 40 renamed > "$repo/apps/server/src/store/migrations.ts"; commit edit
rc=0; out=$(libm HEAD) || rc=$?; expect "edited released migration fails" 1 "released migration 40 (\"forty\") was edited" "$out" "$rc"
mig 1 one > "$repo/apps/server/src/store/migrations.ts"; commit drop
rc=0; out=$(libm HEAD) || rc=$?; expect "dropped released migration fails" 1 "released migration 40 (\"forty\") is gone" "$out" "$rc"
mig 1 one 40 forty 555 orphan > "$repo/apps/server/src/store/migrations.ts"; commit block
rc=0; out=$(libm HEAD) || rc=$?; expect "unclaimed block fails" 1 "opens the unclaimed block 550-559" "$out" "$rc"
rc=0; out=$(libm HEAD --allow-block 555) || rc=$?; expect "--allow-block claims it" 0 "1 new since the base (555)" "$out" "$rc"
# The other branch took 884 for something else (the 884/900 conflict).
g checkout -q -b other origin/integration
mig 1 one 40 forty 42 theirs > "$repo/apps/server/src/store/migrations.ts"; commit theirs
g push -q origin other:integration && g fetch -q origin
g checkout -q feat
mig 1 one 40 forty 42 mine > "$repo/apps/server/src/store/migrations.ts"; commit mine
rc=0; out=$(libm HEAD) || rc=$?; expect "same number on the other branch fails" 1 "migration 42 differs from the other branch (\"mine\" here, \"theirs\" there)" "$out" "$rc"
mig 1 one 40 forty 42 theirs > "$repo/apps/server/src/store/migrations.ts"; commit same
rc=0; out=$(libm HEAD) || rc=$?; expect "the same migration as the other branch passes" 0 "1 new" "$out" "$rc"

# The lock: a missing linux-x64 build, a package.json out of step.
lock '{ "lightningcss-linux-x64-gnu": "1.0.0", "lightningcss-darwin-arm64": "1.0.0" }' ', "node_modules/lightningcss-darwin-arm64": { "version": "1.0.0", "optional": true }' > "$repo/package-lock.json"; commit mac-lock
rc=0; out=$(libl HEAD) || rc=$?; expect "missing linux-x64 native build fails" 1 "node_modules/lightningcss needs lightningcss-linux-x64-gnu" "$out" "$rc"
lock '{ "lightningcss-linux-x64-gnu": "1.0.0" }' ', "node_modules/lightningcss/node_modules/lightningcss-linux-x64-gnu": { "version": "1.0.0" }' > "$repo/package-lock.json"; commit nested
rc=0; out=$(libl HEAD) || rc=$?; expect "a nested native build counts" 0 "1 linux-x64" "$out" "$rc"
echo '{"name":"server","dependencies":{"hono":"^4.1.0","zod":"^3.0.0"}}' > "$repo/apps/server/package.json"; commit drift
rc=0; out=$(libl HEAD) || rc=$?
expect "range drift fails" 1 "apps/server/package.json dependencies hono: ^4.1.0 in package.json, ^4.0.0 in package-lock.json" "$out" "$rc"
expect "a dependency missing from the lock fails" 1 "dependencies zod ^3.0.0 is not in package-lock.json" "$out" "$rc"

# The whole script: a stale (missing) context pack and the lock problem are listed, with exit 1; the gate plan is printed.
rc=0; out=$(run HEAD) || rc=$?
expect "release-prep lists the stale pack" 1 "context pack stale" "$out" "$rc"
expect "release-prep lists the lock problem" 1 "lock: apps/server/package.json dependencies hono" "$out" "$rc"
expect "release-prep prints the gate plan" 1 "== gate plan" "$out" "$rc"
rc=0; out=$(run no-such-ref) || rc=$?; expect "unknown ref is a usage error" 2 "no commit no-such-ref" "$out" "$rc"

[ "$fails" = 0 ] && { echo "all passed"; exit 0; }
echo "$fails failed"; exit 1
