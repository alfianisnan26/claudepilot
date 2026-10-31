#!/usr/bin/env bash
# Run BEFORE merging a release (owner request 2026-10-31, harness): the checks whose failure cost a gate or a deploy that day.
#   scripts/release-prep.sh [<ref>] [--repo <dir>] [--no-fetch] [--no-fix] [--allow-block <n>]...
# <ref> (default HEAD) is the commit to be merged or released. In order:
#   1. context pack: scripts/context-pack.sh --check <ref> (a stale pack failed a gate and cost a cancelled deploy). When it is stale and
#      <ref> is the checked-out HEAD, the pack is regenerated in the working tree (not committed; --no-fix skips that): commit it, run again.
#   2. migrations (apps/server/src/store/migrations.ts): duplicate versions, an edited or dropped released one, a number origin/integration
#      used for another migration (the 884/900 conflict), a new block nobody claimed (scripts/release-prep-lib.mjs migrations).
#   3. package-lock.json: agrees with every package.json, and holds the linux-x64 native optional builds the image build needs
#      (lightningcss-linux-x64-gnu, @rollup/rollup-linux-x64-gnu, ...; scripts/release-prep-lib.mjs lock).
#   4. what scripts/gate-select.mjs would run for <ref> against origin/main (scoped, full or reuse, and why), from the green records
#      in the cluster (scripts/gate-record.sh list; RELEASE_PREP_RECORDS=<file> reads them from a file instead). Information only.
# Fetches origin main and integration first (--no-fetch skips it). Exit 0 when every check passes, 1 with the list of problems, 2 on usage.
set -uo pipefail
here=$(cd "$(dirname "$0")/.." && pwd -P)
ref=HEAD repo='' fetch=1 fix=1 allow=()
while [ $# -gt 0 ]; do
  case $1 in
    --repo) repo=${2:?--repo <dir>}; shift 2 ;;
    --no-fetch) fetch=0; shift ;;
    --no-fix) fix=0; shift ;;
    --allow-block) allow+=(--allow-block "${2:?--allow-block <n>}"); shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    --*) echo "release-prep: unknown option $1" >&2; exit 2 ;;
    *) ref=$1; shift ;;
  esac
done
repo=${repo:-$(git rev-parse --show-toplevel 2>/dev/null)} || { echo "release-prep: not in a git repository" >&2; exit 2; }
G() { git -C "$repo" "$@"; }
if [ "$fetch" = 1 ]; then G fetch -q origin main integration 2>/dev/null || echo "release-prep: warning: could not fetch origin (checking the refs as they are)"; fi
commit=$(G rev-parse --verify -q "$ref^{commit}") || { echo "release-prep: no commit $ref" >&2; exit 2; }
problems=()
say() { printf '%s\n' "$*"; }
echo "release-prep: $(G log -1 --format='%h %s' "$commit")"

# 1. The context pack.
say "== context pack"
if out=$(bash "$here/scripts/context-pack.sh" --repo "$repo" --check "$commit" 2>&1); then
  say "ok: docs/context-pack.md is current"
else
  say "$out"
  if [ "$fix" = 1 ] && [ "$(G rev-parse HEAD)" = "$commit" ] && bash "$here/scripts/context-pack.sh" --repo "$repo" >/dev/null 2>&1; then
    problems+=("context pack stale: regenerated docs/context-pack.md in $repo; commit it and run release-prep again")
  else
    problems+=("context pack stale: run scripts/context-pack.sh on $ref, commit docs/context-pack.md")
  fi
fi

# 2 and 3. Migrations and the lock.
lib() {
  local name=$1; shift
  say "== $name"
  local out rc=0
  out=$(RELEASE_PREP_REPO=$repo node "$here/scripts/release-prep-lib.mjs" "$@" 2>&1) || rc=$?
  say "$out"
  if [ "$rc" != 0 ]; then
    local found=0 line
    while IFS= read -r line; do
      case $line in "problem: "*) problems+=("$name: ${line#problem: }"); found=1 ;; esac
    done <<< "$out"
    [ "$found" = 1 ] || problems+=("$name: the check failed (exit $rc)")
  fi
}
lib migrations migrations "$commit" --base origin/main --other origin/integration "${allow[@]}"
lib lock lock "$commit"

# 4. What the change-scoped gate would run.
say "== gate plan"
records=$(mktemp "${TMPDIR:-/tmp}/release-prep-records.XXXXXX")
trap 'rm -f "$records"' EXIT
if [ -n "${RELEASE_PREP_RECORDS:-}" ]; then cat "$RELEASE_PREP_RECORDS" > "$records" 2>/dev/null || true
else bash "$here/scripts/gate-record.sh" list > "$records" 2>/dev/null || true; fi
say "$(wc -l < "$records" | tr -d ' ') green records"
if plan=$(cd "$repo" && node "$here/scripts/gate-select.mjs" --head "$commit" --base-ref origin/main --records "$records" --format env 2>/dev/null); then
  say "$plan" | grep -E '^(MODE|REASON|BASE|REUSED|STEPS|SERVER_TESTS|SERVER_TOTAL|WEB)=' || say "$plan"
else
  say "gate-select gave no plan (the gate would run in full)"
fi

echo
if [ "${#problems[@]}" = 0 ]; then echo "release-prep: ok, ready to merge"; exit 0; fi
echo "release-prep: ${#problems[@]} problem(s):"
for p in "${problems[@]}"; do echo "  - $p"; done
exit 1
