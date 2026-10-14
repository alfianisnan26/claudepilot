#!/usr/bin/env bash
# T-306 step 2 item 1: plain vs rtk output of read-only, high-volume commands, PER COMMAND CLASS, and the fidelity of each case
# (tools/qa/rtk-fidelity.mjs --class). Run it in a job-run Job (it downloads and verifies rtk like rtk-measure.sh):
#   scripts/job-run.sh --ref <branch> --artifacts job-out --steps npm-ci -- 'tools/qa/rtk-classes.sh job-out'
# The rtk form of each command is what `rtk rewrite` proposes (run in an empty folder with an empty HOME); a case rtk does not rewrite is
# recorded as such and not scored. Both arms run in the SAME clean environment (env -i, empty HOME, no token, RTK_TELEMETRY_DISABLED=1).
# History: the Job's clone has depth 1, so the script adds 10 small commits on top (a scratch identity, never pushed) and dirties the tree.
# Outputs: <out>/cases.tsv (one row per case), <out>/fidelity.tsv (per case), <out>/classes.tsv (per class), <out>/<case>.{plain,rtk}.txt.
set -u
out=$(readlink -f "$1"); mkdir -p "$out"
RTK_TAG=v1.0.0; RTK_ASSET=rtk-x86_64-unknown-linux-musl.tar.gz
RTK_SHA=b0b69fbed72f55d8eae18587c0b6bc140a8a8b39d5b7c6e6df33795249940926
here=$(cd "$(dirname "$0")/../.." && pwd)
if [ "${RTK_BIN:-}" = "" ]; then
  d=$(mktemp -d); curl -fsSL -o "$d/$RTK_ASSET" "https://github.com/rtk-ai/rtk/releases/download/$RTK_TAG/$RTK_ASSET"
  [ "$(sha256sum "$d/$RTK_ASSET" | cut -d' ' -f1)" = "$RTK_SHA" ] || { echo "CHECKSUM MISMATCH" >&2; exit 3; }
  mkdir "$d/x"; tar -xzf "$d/$RTK_ASSET" -C "$d/x"; RTK_BIN=$d/x/rtk
fi
R=$RTK_BIN
H=$(mktemp -d); E=$(mktemp -d)
cleanenv() { env -i PATH="$PATH" HOME="$H" LANG=C.UTF-8 NO_COLOR=1 CI=1 RTK_TELEMETRY_DISABLED=1 XDG_CONFIG_HOME="$H/c" XDG_DATA_HOME="$H/d" "$@"; }
"$R" --version > "$out/rtk-version.txt" 2>&1
for t in tree rg git grep find ls npm; do printf '%s\t%s\n' "$t" "$(command -v "$t" || echo MISSING)"; done > "$out/tools.tsv"

cd "$here"
# --- 10 commits on top of the shallow clone, then a dirty tree (modified, deleted, new, untracked) ---
g() { git -c user.name=rtk-scratch -c user.email=rtk-scratch@example.invalid -c commit.gpgsign=false "$@"; }
i=0
for f in $(git ls-files 'apps/server/src/*/routes.ts' | head -n 10); do
  i=$((i + 1)); printf '\n// rtk-classes scratch %s\n' "$i" >> "$f"; g commit -q -am "scratch $i: touch $(dirname "$f")" -m "Why: body line $i of a scratch commit, kept by the fidelity check." -m "Ticket: T-$((900 + i))" || exit 4
done
for f in $(git ls-files 'apps/server/src/chat/*.ts' | head -n 30); do echo "// rtk-classes" >> "$f"; done
git rm -q --cached "$(git ls-files 'docs/prd/*.md' | tail -n 1)" >/dev/null
mkdir -p rtkc-new && echo x > rtkc-new/a.txt && echo y > rtkc-untracked.txt && g add rtkc-new/a.txt

printf 'case\tclass\tplain\trewrite_exit\trtk\texit_plain\texit_rtk\tbytes_plain\tbytes_rtk\n' > "$out/cases.tsv"
# c <case> <class> <plain command>
c() {
  local name=$1 class=$2 pc=$3 rc rw ep er
  rc=$(cd "$E" && cleanenv "$R" rewrite "$pc" 2>/dev/null); rw=$?
  (cleanenv sh -c "$pc") > "$out/$name.plain.txt" 2>&1; ep=$?
  if [ -n "$rc" ] && [ "$rw" -ne 1 ] && [ "$rw" -ne 2 ]; then (cleanenv sh -c "$(printf '%s' "$rc" | sed "s#^rtk #$R #")") > "$out/$name.rtk.txt" 2>&1; er=$?
  else rc=-; : > "$out/$name.rtk.txt"; er=-; fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$class" "$pc" "$rw" "$rc" "$ep" "$er" "$(wc -c < "$out/$name.plain.txt")" "$(wc -c < "$out/$name.rtk.txt")" >> "$out/cases.tsv"
}
c git-status.long git-status "git status"
c git-status.short git-status "git status -s"
c git-status.sb git-status "git status --short --branch"
c git-log.oneline git-log "git log --oneline -20"
c git-log.full git-log "git log -5"
c git-log.stat git-log "git log --stat -3"
c git-diff-stat.range git-diff-stat "git diff --stat HEAD~10"
c git-diff-stat.tree git-diff-stat "git diff --stat"
c git-diff-stat.cached git-diff-stat "git diff --cached --stat"
c git-diff-names.range git-diff-names "git diff --name-only HEAD~10"
c git-diff-names.status git-diff-names "git diff --name-status HEAD~10"
c ls.plain ls "ls"
c ls.la ls "ls -la"
c ls.la-deep ls "ls -la apps/server/src/chat"
c ls.one ls "ls -1 apps/server/src"
c ls.lh ls "ls -lh docs/prd"
c ls.la-many ls "ls -la docs/coord"
c find.name find "find apps/server/src/chat -name '*.test.ts'"
c find.type-f find "find docs -type f"
c find.dirs find "find apps/web/src -maxdepth 2 -type d"
c tree.l2 tree "tree -L 2 apps/server/src"
c tree.dirs tree "tree -d apps/web/src"
c grep.rn grep-lines "grep -rn actorOf apps/server/src"
c grep.rn-small grep-lines "grep -rn sameHostOrigin apps/server/src"
c grep.n-file grep-lines "grep -n export apps/server/src/app.ts"
c rg.n grep-lines "rg -n actorOf apps/server/src"
c grep.rl grep-list "grep -rl actorOf apps/server/src"
c grep.rl-docs grep-list "grep -rl ticket docs"
c rg.l grep-list "rg -l actorOf apps/server/src"
c rg.l-docs grep-list "rg -l ticket docs"
c grep.rc grep-count "grep -rc actorOf apps/server/src/chat"
c rg.count grep-count "rg --count actorOf apps/server/src"
c npm-ls.depth0 npm-ls "npm ls --depth=0"
c npm-ls.pkg npm-ls "npm ls tsx"
c npm-ls.ws npm-ls "npm ls -w @portal/server --depth=0"

git reset -q --soft HEAD~10 2>/dev/null; git reset -q; git checkout -q -- . ; rm -rf rtkc-new rtkc-untracked.txt

# --- fidelity per case, then per class (a class passes when EVERY scored case of it is >= 95 percent) ---
printf 'case\tclass\titems\tmissing\tparity\n' > "$out/fidelity.tsv"
tail -n +2 "$out/cases.tsv" | while IFS=$'\t' read -r name class _ _ rc _ er _ _; do
  [ "$rc" = - ] && { printf '%s\t%s\t-\t-\tnot rewritten\n' "$name" "$class" >> "$out/fidelity.tsv"; continue; }
  j=$(node tools/qa/rtk-fidelity.mjs "$out/$name.plain.txt" "$out/$name.rtk.txt" --class "$class" --json 2>"$out/$name.fid.err")
  printf '%s\n' "$j" > "$out/$name.fid.json"
  node -e 'const j=JSON.parse(process.argv[1]);process.stdout.write([process.argv[2],process.argv[3],j.items,j.missing_items,j.parity_percent].join("\t")+"\n")' "$j" "$name" "$class" >> "$out/fidelity.tsv" 2>>"$out/$name.fid.err" || printf '%s\t%s\t-\t-\terror\n' "$name" "$class" >> "$out/fidelity.tsv"
done
node -e '
const fs=require("fs");const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").slice(1).map(l=>l.split("\t"));
const by={};for(const [n,c,it,mi,p] of rows){(by[c]??=[]).push({n,it,mi,p});}
let s="class\tcases\tscored\titems\tmissing\tmin_parity\tverdict\n";
for(const [c,rs] of Object.entries(by)){const sc=rs.filter(r=>r.it!=="-"&&r.p!=="null");const items=sc.reduce((a,r)=>a+ +r.it,0),miss=sc.reduce((a,r)=>a+ +r.mi,0);
const min=sc.length?Math.min(...sc.map(r=>+r.p)):null;const bad=rs.some(r=>r.p==="error");
s+=[c,rs.length,sc.length,items,miss,min,bad||!sc.length?"NOT SCORED":(min>=95&&sc.length===rs.length?"KEEP":"DROP")].join("\t")+"\n";}
fs.writeFileSync(process.argv[2],s);process.stdout.write(s);' "$out/fidelity.tsv" "$out/classes.tsv"
echo "done: $out"
