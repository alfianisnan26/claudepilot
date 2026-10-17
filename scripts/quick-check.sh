#!/usr/bin/env bash
# The light checks BEFORE a branch goes to CI (D-66): format and lint of the files the branch changed, and the test files it names, as ONE
# cluster Job (scripts/job-run.sh), never in the shared pod (D-61: its memory; and test or lint config code would run next to every crew's
# credentials). Every check runs even when one fails, and the last line names all failures, so one quick check (about a minute) replaces the
# two or three CI runs a first failure (Prettier stopping the tests) used to cost. The heavy checks (the whole suite, typecheck, build) stay
# with the gate.
#   scripts/quick-check.sh [--base <ref>] [--test <path>]... [--repo <job-run --repo value>] [--no-format] [--no-lint]
# Run it inside the worktree, after pushing HEAD (job-run runs a PUSHED commit: git push origin HEAD:<your work branch>). The base is the
# merge base with --base, or with the first of origin/stg, origin/integration, origin/main, origin/master that exists. --test takes a test
# file of the branch, run from its package's folder: vitest, jest, node --test (a *.test.ts with tsx), or pytest for a *.py (unittest when the
# image has no pytest). A run where every check was skipped is a failure, never "all passed" (T-960).
# Exit: 0 all passed; 1 a check failed (the summary says which); 2 a usage error; anything else is job-run's own (it did not finish).
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
job_run="$here/job-run.sh"
base=""
repo=""
tests=()
fmt=1
lint=1
while [ $# -gt 0 ]; do
  case "$1" in
    --base) base="${2:?--base needs a ref}"; shift 2 ;;
    --test) tests+=("${2:?--test needs a file}"); shift 2 ;;
    --repo) repo="${2:?--repo needs a value}"; shift 2 ;;
    --no-format) fmt=0; shift ;;
    --no-lint) lint=0; shift ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "quick-check: unknown argument $1" >&2; exit 2 ;;
  esac
done

top="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "quick-check: run it inside a git worktree" >&2; exit 2; }
cd "$top" || exit 2
head="$(git rev-parse HEAD)"
if [ -z "$base" ]; then
  for b in origin/stg origin/integration origin/main origin/master; do
    if git rev-parse -q --verify "$b^{commit}" >/dev/null; then base="$b"; break; fi
  done
fi
[ -n "$base" ] || { echo "quick-check: no base branch found; pass --base <ref>" >&2; exit 2; }
mb="$(git merge-base "$base" HEAD 2>/dev/null)" || { echo "quick-check: $base and HEAD have no commit in common" >&2; exit 2; }

files=()
while IFS= read -r f; do [ -n "$f" ] && [ -f "$f" ] && files+=("$f"); done < <(git diff --name-only --diff-filter=ACMR "$mb" HEAD -- | head -500)
lintable=()
for f in "${files[@]}"; do
  case "$f" in *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.vue | *.svelte) lintable+=("$f") ;; esac
done

# Each test runs from the nearest folder with a package.json (a monorepo's package), with the path relative to it.
test_lines=""
for t in "${tests[@]}"; do
  [ -f "$t" ] || { echo "quick-check: no test file $t" >&2; exit 2; }
  rel="$(realpath --relative-to="$top" "$t")"
  case "$rel" in ../*) echo "quick-check: $t is outside this worktree" >&2; exit 2 ;; esac
  dir="$(dirname "$rel")"
  while [ "$dir" != "." ] && [ ! -f "$dir/package.json" ]; do dir="$(dirname "$dir")"; done
  test_lines+="$(printf 'runtest %q %q; ' "$dir" "${rel#"$dir"/}")"
done

if [ ${#files[@]} -eq 0 ] && [ ${#tests[@]} -eq 0 ]; then
  echo "quick-check: nothing changed against $base and no --test given: nothing to check"
  exit 0
fi

q() { printf '%q ' "$@"; }
# The command the Job runs (in the clone, after npm ci): plain bash, every check, then one verdict line.
cmd='set +e; fails=""; ran=0; bin="$PWD/node_modules/.bin";
check() { local name="$1"; shift; ran=$((ran+1)); echo "::: $name"; "$@"; local rc=$?; if [ $rc -eq 0 ]; then echo "::: $name ok"; else fails="$fails $name"; echo "::: $name FAILED (exit $rc)"; fi; };
runtest() { local dir="$1" file="$2"; local b="$PWD/$dir/node_modules/.bin"; [ -x "$b/vitest" ] || b="$bin";
  case "$file" in
    *.py) if python3 -m pytest --version >/dev/null 2>&1; then check "test:$dir/$file" sh -c "cd \"\$0\" && python3 -m pytest -q \"\$1\"" "$dir" "$file";
       else check "test:$dir/$file (unittest, no pytest in the Job image)" sh -c "cd \"\$0\" && python3 -m unittest discover -s \"\$(dirname \"\$1\")\" -p \"\$(basename \"\$1\")\"" "$dir" "$file"; fi ;;
    *) if [ -x "$b/vitest" ]; then check "test:$dir/$file" sh -c "cd \"\$0\" && \"\$1\" run \"\$2\"" "$dir" "$b/vitest" "$file";
       elif [ -x "$b/jest" ]; then check "test:$dir/$file" sh -c "cd \"\$0\" && \"\$1\" --runInBand \"\$2\"" "$dir" "$b/jest" "$file";
       elif [ -x "$bin/tsx" ] || [ -x "$b/tsx" ]; then check "test:$dir/$file" sh -c "cd \"\$0\" && node --import tsx --test \"\$1\"" "$dir" "$file";
       else check "test:$dir/$file" sh -c "cd \"\$0\" && node --test \"\$1\"" "$dir" "$file"; fi ;;
  esac; };
'
if [ $fmt = 1 ] && [ ${#files[@]} -gt 0 ]; then
  cmd+="if [ -x \"\$bin/prettier\" ]; then check format \"\$bin/prettier\" --check --ignore-unknown $(q "${files[@]}"); else echo '::: format skipped (no prettier)'; fi; "
fi
if [ $lint = 1 ] && [ ${#lintable[@]} -gt 0 ]; then
  cmd+="if [ -x \"\$bin/eslint\" ]; then check lint \"\$bin/eslint\" $(q "${lintable[@]}"); else echo '::: lint skipped (no eslint)'; fi; "
fi
cmd+="$test_lines"
# T-960 (2026-10-17): every check skipped (no prettier, no pytest) printed "all passed" with nothing run: a false green. Nothing ran is a failure.
cmd+='echo; if [ "$ran" -eq 0 ]; then echo "QUICK CHECK FAILED: nothing ran (every check was skipped)"; exit 1; fi; if [ -z "$fails" ]; then echo "QUICK CHECK: all passed"; exit 0; fi; echo "QUICK CHECK FAILED:$fails"; exit 1'

echo "quick-check: ${#files[@]} changed file(s) against $base, ${#tests[@]} test file(s), commit ${head:0:12}, as a cluster Job"
args=(--ref "$head" --timeout 900 --role "${PILOT_AGENT:-agent}-quick")
[ -n "$repo" ] && args+=(--repo "$repo")
exec "$job_run" "${args[@]}" -- "$cmd"
