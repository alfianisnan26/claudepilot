#!/usr/bin/env bash
# T-286 step 1: plain vs rtk output size, exit code and wall time, per command class.
#   tools/qa/rtk-measure.sh light <outdir> <repo-dir> <label>    git, ls, grep (local, light)
#   tools/qa/rtk-measure.sh heavy <outdir>                       node --test, tsc (run in a job-run Job, after npm ci; downloads and verifies rtk)
# Both arms run with the SAME clean environment (env -i, empty HOME, no token), RTK_TELEMETRY_DISABLED=1. Outputs go to files, never to the terminal.
set -u
mode=$1; out=$(readlink -f "$2"); mkdir -p "$out"
RTK_TAG=v1.0.0; RTK_ASSET=rtk-x86_64-unknown-linux-musl.tar.gz
RTK_SHA=b0b69fbed72f55d8eae18587c0b6bc140a8a8b39d5b7c6e6df33795249940926
here=$(cd "$(dirname "$0")/../.." && pwd)
if [ "${RTK_BIN:-}" = "" ]; then
  d=$(mktemp -d); curl -fsSL -o "$d/$RTK_ASSET" "https://github.com/rtk-ai/rtk/releases/download/$RTK_TAG/$RTK_ASSET"
  [ "$(sha256sum "$d/$RTK_ASSET" | cut -d' ' -f1)" = "$RTK_SHA" ] || { echo "CHECKSUM MISMATCH" >&2; exit 3; }
  mkdir "$d/x"; tar -xzf "$d/$RTK_ASSET" -C "$d/x"; RTK_BIN=$d/x/rtk
fi
H=$(mktemp -d)
cleanenv() { env -i PATH="$PATH" HOME="$H" LANG=C.UTF-8 NO_COLOR=1 CI=1 RTK_TELEMETRY_DISABLED=1 XDG_CONFIG_HOME="$H/c" XDG_DATA_HOME="$H/d" "$@"; }
tsv=$out/table.tsv; [ -s "$tsv" ] || printf 'class\tlabel\tbytes_plain\tbytes_rtk\tratio\texit_plain\texit_rtk\tms_plain\tms_rtk\n' > "$tsv"
med() { sort -n | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}'; }
# m <class> <label> <dir> <plain command string> <rtk command string>
m() {
  local class=$1 label=$2 dir=$3 pc=$4 rc=$5 n=3 i tp="" tr="" ep er s e
  local base="$out/$class.$label"
  for i in $(seq $n); do
    s=$(date +%s%N); (cd "$dir" && cleanenv sh -c "$pc") > "$base.plain.txt" 2>&1; ep=$?; e=$(date +%s%N); tp="$tp $(( (e-s)/1000000 ))"
    s=$(date +%s%N); (cd "$dir" && cleanenv sh -c "$rc") > "$base.rtk.txt" 2>&1; er=$?; e=$(date +%s%N); tr="$tr $(( (e-s)/1000000 ))"
  done
  local bp br; bp=$(wc -c < "$base.plain.txt"); br=$(wc -c < "$base.rtk.txt")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$class" "$label" "$bp" "$br" "$(awk -v a="$bp" -v b="$br" 'BEGIN{printf "%.3f", (a>0? b/a : 0)}')" "$ep" "$er" "$(echo $tp | tr ' ' '\n' | med)" "$(echo $tr | tr ' ' '\n' | med)" >> "$tsv"
}
R="$RTK_BIN"
if [ "$mode" = light ]; then
  repo=$(readlink -f "$3"); L=$4; cd "$repo"
  if [ "$L" = claudepilot ]; then  # a dirty tree so that status and diff have something to say; restored at the end
    for f in $(git ls-files 'apps/server/src/chat/*.ts' | head -n 6); do echo "// rtk-measure" >> "$f"; done
    for i in 1 2 3; do echo x > "rtkm-untracked-$i.txt"; done
  fi
  m git-status "$L" "$repo" "git status" "$R git status"
  m git-log "$L" "$repo" "git log --oneline -20" "$R git log --oneline -20"
  m git-diff-stat "$L" "$repo" "git diff --stat ${DIFFBASE:-HEAD~10}" "$R git diff --stat ${DIFFBASE:-HEAD~10}"
  m ls "$L" "$repo" "ls -la" "$R ls -la"
  m ls-deep "$L" "$repo" "ls -la ${LSDIR:-apps/server/src/chat}" "$R ls -la ${LSDIR:-apps/server/src/chat}"
  m grep "$L" "$repo" "grep -rn ${GSYM:-actorOf} ${GDIR:-apps/server/src}" "$R grep -rn ${GSYM:-actorOf} ${GDIR:-apps/server/src}"
  m grep-native "$L" "$repo" "grep -rn ${GSYM:-actorOf} ${GDIR:-apps/server/src}" "$R grep ${GSYM:-actorOf} ${GDIR:-apps/server/src}"
  if [ "$L" = claudepilot ]; then git checkout -q -- . ; rm -f rtkm-untracked-*.txt; fi
else
  cd "$here"
  tf="apps/server/src/chat/actors.test.ts apps/server/src/chat/agentAccess.test.ts apps/server/src/chat/agents.test.ts"
  nt="node --import tsx --disable-warning=ExperimentalWarning --test"
  m node-test pass "$here/apps/server" "$nt ${tf//apps\/server\//}" "$R test $nt ${tf//apps\/server\//}"
  m web-node-test pass "$here/apps/web" "$nt src/lib/popover.test.ts src/lib/scrollGuard.test.ts src/lib/sheetDrag.test.ts" "$R test $nt src/lib/popover.test.ts src/lib/scrollGuard.test.ts src/lib/sheetDrag.test.ts"
  m tsc server-pass "$here" "npx tsc --noEmit -p apps/server" "$R npx tsc --noEmit -p apps/server"
  # --- deliberate failures, generated here, never committed ---
  cat > apps/server/src/chat/zzRtkFail.test.ts <<'EOT'
import { test } from "node:test";
import assert from "node:assert/strict";
test("rtk-fail alpha: equal numbers", () => { assert.equal(1 + 1, 3); });
test("rtk-fail beta: deep object", () => { assert.deepEqual({ a: 1, b: [1, 2, 3], c: "x" }, { a: 1, b: [1, 2, 4], c: "y" }); });
test("rtk-fail gamma: thrown", () => { throw new Error("rtk-gamma boom 4242"); });
test("rtk-fail delta: passes", () => { assert.ok(true); });
EOT
  cp apps/server/src/chat/actors.test.ts apps/server/src/chat/zzRtkCopy.test.ts
  printf '\nimport { test as rtkT } from "node:test";\nimport rtkA from "node:assert/strict";\nrtkT("rtk-copy broken assertion", () => { rtkA.equal("left", "right"); });\n' >> apps/server/src/chat/zzRtkCopy.test.ts
  m node-test fail "$here/apps/server" "$nt chat/zzRtkFail.test.ts chat/zzRtkCopy.test.ts chat/agents.test.ts" "$R test $nt chat/zzRtkFail.test.ts chat/zzRtkCopy.test.ts chat/agents.test.ts"
  cat > apps/web/src/lib/zzRtkWebFail.test.ts <<'EOT'
import { test } from "node:test";
import assert from "node:assert/strict";
test("rtk-web-fail one", () => { assert.strictEqual("a".length, 2); });
test("rtk-web-fail two", () => { assert.deepStrictEqual([1, 2], [2, 1]); });
EOT
  m web-node-test fail "$here/apps/web" "$nt src/lib/zzRtkWebFail.test.ts src/lib/popover.test.ts" "$R test $nt src/lib/zzRtkWebFail.test.ts src/lib/popover.test.ts"
  cat > apps/server/src/zzRtkFail.ts <<'EOT'
export const a: number = "not a number";
export function f(x: string): number { return x; }
export const o: { p: number; q: string } = { p: 1, q: 2, r: 3 };
const missing: Foo = 1;
export const u = missing + undefinedName;
EOT
  m tsc server-fail "$here" "npx tsc --noEmit -p apps/server" "$R npx tsc --noEmit -p apps/server"
  rm -f apps/server/src/chat/zzRtk*.test.ts apps/web/src/lib/zzRtkWebFail.test.ts apps/server/src/zzRtkFail.ts
fi
echo "done: $tsv"
