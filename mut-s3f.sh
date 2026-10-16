#!/usr/bin/env bash
# T-736 S3f mutants (wip branch only, never merged). The baseline must pass; each mutant edits ONE file, runs the test file and must FAIL.
set -u
cd "$(dirname "$0")/apps/server" || exit 2
T=src/qa/rtkHistoryGuard.test.ts
run() { node --import tsx --test --test-reporter=spec "$T"; }
echo "=== BASELINE"; run; base=$?
echo "=== BASELINE rc=$base"
bad=0; [ "$base" -eq 0 ] || bad=1
mut() { # name file sed-script
  cp "$2" "$2.orig"; sed -i "$3" "$2"
  if cmp -s "$2" "$2.orig"; then echo "=== MUTANT $1: NOT APPLIED"; bad=1; mv "$2.orig" "$2"; return; fi
  echo "=== MUTANT $1"; run; rc=$?
  mv "$2.orig" "$2"
  if [ "$rc" -ne 0 ]; then echo "=== MUTANT $1: KILLED (rc=$rc)"; else echo "=== MUTANT $1: SURVIVED"; bad=1; fi
}
mut M1-no-danger-check "$T" 's|^const DANGER = .*|const DANGER = /^$/;|'
mut M2-cd-at-any-depth "$T" "s|if (cd < 0 \&\& stack.length === 1 \&\& stack\[0\] === 'if' \&\& |if (cd < 0 \&\& |"
mut M3-first-bare-else "$T" "s|if (stack.length === 1 \&\& stack\[0\] === 'if') elseTop = true;|elseTop = true;|"
mut M4-here-string-is-heredoc "$T" 's#(?:^|\[^<\])<<(-?)#<<(-?)#'
mut M5-assignment-with-command "$T" "s|return a !== null \&\& oneWord(a\[1\] ?? '');|return a !== null;|"
mut M6-continued-line "$T" '/a continued line: the next/d'
mut M7-function-body-not-open "$T" "s|stack.push('brace'); ||"
mut M8-subshell-not-open "$T" "s|stack.push('paren'); cmd = true; continue;|cmd = true; continue;|"
mut M9-and-if-not-open "$T" "s|if (cmd \&\& \['if', 'while'|if (k === 0 \&\& ['if', 'while'|"
mut M10-branch-allow-list-off "$T" "s|if (bad < 0 \&\& !allowed(lines\[i\] ?? '', 'branch')) bad = i;|if (bad < 0 \&\& false) bad = i;|"
mut S1-write-before-guard ../../tools/qa/rtk-history.sh '/^rtk_guard rtk-history.sh/i perl -pi -e 1 x'
mut S2-write-before-cd ../../tools/qa/rtk-measure.sh '/^  cd "\$here" || exit$/i\  perl -pi -e 1 x'
mut S3-cd-in-subshell ../../tools/qa/rtk-measure.sh 's#^  cd "\$here" || exit$#  (cd "$here" || exit)#'
mut S4-guard-not-sourced ../../tools/qa/rtk-classes.sh 's#^\. "\$here/tools/qa/rtk-guard.sh".*$#:#'
git -C ../.. status --short
echo "=== MUTANTS DONE bad=$bad"
exit "$bad"
