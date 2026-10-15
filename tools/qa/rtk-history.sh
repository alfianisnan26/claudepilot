#!/usr/bin/env bash
# T-341 (A, B, C): the fidelity gaps of rtk-classes.sh. Same method (plain vs `rtk rewrite` form, one clean env, rtk-fidelity.mjs --class), but on
#   - this repository's REAL history (the Job's shallow clone is deepened; merges, long bodies, many authors), no scratch commits;
#   - a BUSY worktree (about 200 changed paths: modified, staged, deleted, renamed, untracked in nested folders, a path with a space);
#   - the forms the allowlist was wider than the measurement: git status <paths>, git log <refs/paths>, --max-count=N;
#   - the facts left out before: git log Date and author e-mail (class git-log-meta), ls owner/date/size (class ls-meta).
#   scripts/job-run.sh --ref <full hash> --out job-out/t341 --artifacts job-out -- 'bash tools/qa/rtk-history.sh job-out; exit $?'
# Outputs in <out>: cases.tsv, fidelity.tsv, classes.tsv, <case>.{plain,rtk}.txt, <case>.fid.json, history.txt (what the clone had).
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
cd "$here"

# --- real history: deepen the shallow clone (the clone's own remote and its own git credential helper; nothing else is read) ---
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then git fetch -q --deepen=400 origin 2>"$out/fetch.err" || echo "deepen failed (see fetch.err)" >&2; fi
{ echo "commits: $(git rev-list --count HEAD)"; echo "merges: $(git rev-list --merges --count HEAD)"; echo "authors: $(git log --format=%ae | sort -u | wc -l)"; echo "shallow: $(git rev-parse --is-shallow-repository)"; } > "$out/history.txt"

printf 'case\tclass\tplain\trewrite_exit\trtk\texit_plain\texit_rtk\tbytes_plain\tbytes_rtk\n' > "$out/cases.tsv"
c() {
  local name=$1 class=$2 pc=$3 rc rw ep er
  rc=$(cd "$E" && cleanenv "$R" rewrite "$pc" 2>/dev/null); rw=$?
  (cleanenv sh -c "$pc") > "$out/$name.plain.txt" 2>&1; ep=$?
  if [ -n "$rc" ] && [ "$rw" -ne 1 ] && [ "$rw" -ne 2 ]; then (cleanenv sh -c "$(printf '%s' "$rc" | sed "s#^rtk #$R #")") > "$out/$name.rtk.txt" 2>&1; er=$?
  else rc=-; : > "$out/$name.rtk.txt"; er=-; fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$class" "$pc" "$rw" "$rc" "$ep" "$er" "$(wc -c < "$out/$name.plain.txt")" "$(wc -c < "$out/$name.rtk.txt")" >> "$out/cases.tsv"
}
# lm <case> <command>: a git log case, scored as git-log and again as git-log-meta (date, e-mail)
lm() { c "$1" git-log "$2"; c "$1.meta" git-log-meta "$2"; }

# --- git log on the real history (A, C) ---
lm hlog.oneline "git log --oneline -20"
lm hlog.full5 "git log -5"
lm hlog.full20 "git log -20"
lm hlog.maxc "git log --max-count=10"
lm hlog.maxc-oneline "git log --oneline --max-count=15"
lm hlog.stat "git log --stat -3"
lm hlog.ref "git log -5 HEAD~50"
lm hlog.ref2 "git log --oneline -10 HEAD~200"
lm hlog.path "git log -5 -- apps/server/src/chat"
lm hlog.path2 "git log -10 apps/server/src/chat/"
lm hlog.path3 "git log -5 -- docs/prd"
lm hlog.path-file "git log -5 -- package.json"
lm hlog.ref-path "git log -3 HEAD~20 -- apps/web/src"
lm hlog.maxc-path "git log --max-count=5 -- scripts"
c hlog.merges git-log "git log --merges -5"
c hlog.merges.meta git-log-meta "git log --merges -5"
c hlog.nomerge git-log "git log --no-merges -5"
c hlog.since git-log "git log -10 --since=2026-10-01"
# --- ls with the meta facts (ls itself is dropped; scored to answer "what would an agent lose") ---
c ls.meta-root ls-meta "ls -la"
c ls.meta-chat ls-meta "ls -la apps/server/src/chat"
c ls.meta-docs ls-meta "ls -lh docs"

# --- a busy worktree: about 200 changed paths on the real tree ---
g() { git -c user.name=rtk-scratch -c user.email=rtk-scratch@example.invalid -c commit.gpgsign=false "$@"; }
for f in $(git ls-files 'apps/server/src/*.ts' | head -n 60); do echo "// rtk-history modified" >> "$f"; done
for f in $(git ls-files 'apps/web/src/*.tsx' | head -n 40); do echo "// rtk-history staged" >> "$f"; git add "$f"; done
for f in $(git ls-files 'docs/*.md' | tail -n 15); do rm -f "$f"; done
for f in $(git ls-files 'apps/server/src/chat/*.ts' | head -n 3); do git mv "$f" "${f%.ts}.renamed.ts"; done
mkdir -p "rtkh-new/deep/er" "rtkh-new/with space"
for i in $(seq 1 40); do echo x > "rtkh-new/deep/er/f$i.txt"; done
echo x > "rtkh-new/with space/a b.txt"; echo y > rtkh-untracked.txt
git add rtkh-new/deep/er/f1.txt rtkh-new/deep/er/f2.txt
git ls-files -m -d -o --exclude-standard | wc -l > "$out/busy-count.txt"
git status -s | wc -l >> "$out/busy-count.txt"

c bs.long git-status "git status"
c bs.short git-status "git status -s"
c bs.sb git-status "git status --short --branch"
c bs.p-dir git-status "git status apps/server/src"
c bs.p-docs git-status "git status docs"
c bs.p-two git-status "git status apps/web/src docs"
c bs.p-sep git-status "git status -- apps/server/src/chat"
c bs.p-file git-status "git status package.json"
c bs.p-new git-status "git status rtkh-new"
c bs.p-env git-status "git status .env"
c bs.p-ren git-status "git status apps/server/src/chat"
c bs.p-short git-status "git status -s apps/server/src"
c bs.p-none git-status "git status no-such-dir"

git reset -q; git checkout -q -- . ; rm -rf rtkh-new rtkh-untracked.txt

printf 'case\tclass\titems\tmissing\tparity\n' > "$out/fidelity.tsv"
tail -n +2 "$out/cases.tsv" | while IFS=$'\t' read -r name class _ _ rc ep er _ _; do
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
cat "$out/fidelity.tsv"
echo "done: $out"
