#!/usr/bin/env bash
# Test of scripts/shots-in.sh: bash scripts/shots-in.test.sh
# A fake download folder and a fake worktree root, at runtime in a temp folder inside this checkout (removed at the end). Each refusal
# test checks the exit code (2), the reason and that nothing was copied; each guard of the script has a test that fails without it.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd -P)
script=$here/scripts/shots-in.sh
base=$(mktemp -d "$here/.sitest.XXXXXX")
base=$(cd "$base" && pwd -P)
trap 'rm -rf "$base"' EXIT
src=$base/dl; root=$base/trees; outside=$base/outside; wt=$root/wt
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
mkdir -p "$src" "$root" "$outside"

HDR='\211PNG\r\n\032\n\000\000\000\rIHDR'                                                 # the signature and the IHDR chunk header
png() { printf "$HDR%s" "${2:-body}" > "$src/$1"; }                                    # a file that passes: signature, IHDR, a body
reset() { rm -rf "$wt"; mkdir -p "$wt"; echo "gitdir: x" > "$wt/.git"; }              # a clean worktree
run() { SHOTS_TEST_MODE=1 bash "$script" --src "$src" --root "$root" "$@"; }
# expect <name> <exit code> <fragment of stderr or ""> <args...>
expect() {
  local name=$1 code=$2 frag=$3; shift 3
  local rc=0 err
  err=$(run "$@" 2>&1 >/dev/null) || rc=$?
  if [ "$rc" = "$code" ] && { [ -z "$frag" ] || [[ $err == *"$frag"* ]]; }; then ok "$name"; else bad "$name (exit $rc: $err)"; fi
}
# refused <name> <fragment> <args...>: a refusal on a clean worktree leaves docs/screenshots empty or absent
refused() {
  local name=$1 frag=$2; shift 2
  reset
  expect "$name" 2 "$frag" "$@"
  if [ -z "$(ls -A "$wt/docs/screenshots" 2>/dev/null)" ]; then ok "$name: nothing copied"; else bad "$name: something was copied: $(ls -A "$wt/docs/screenshots")"; fi
}

# --- a good copy
reset; png a.png one; png b.png two
expect "good copy of two files exits 0" 0 "" "$wt" a.png b.png
cmp -s "$src/a.png" "$wt/docs/screenshots/a.png" && cmp -s "$src/b.png" "$wt/docs/screenshots/b.png" && ok "both copied, bytes equal" || bad "both copied, bytes equal"
[ -f "$src/a.png" ] && [ -f "$src/b.png" ] && ok "sources are kept" || bad "sources are kept"
out=$(run --force "$wt" a.png 2>&1) && [[ $out == *"-> $wt/docs/screenshots/a.png"* ]] && ok "prints what it copied" || bad "prints what it copied ($out)"
expect "an existing file is refused" 2 "exists" "$wt" a.png
png a.png changed
expect "--force replaces it" 0 "" --force "$wt" a.png
cmp -s "$src/a.png" "$wt/docs/screenshots/a.png" && ok "--force: new bytes" || bad "--force: new bytes"
expect "trailing slash on the worktree is fine" 0 "" --force "$wt/" a.png

# --- sources
printf 'not a png at all' > "$src/text.png"
refused "a non-PNG with a .png name is refused" "PNG magic" "$wt" text.png
printf '\211PNG\r\n\032\nx' > "$src/pic.jpg"
refused "a PNG under another extension is refused" "not [A-Za-z0-9._-]+.png" "$wt" pic.jpg
png real.png; ln -s "$src/real.png" "$src/link.png"
refused "a symlink source is refused" "symlink" "$wt" link.png
png secret.bin; ln -s "$src/secret.bin" "$src/link2.png"
refused "a symlink to a file that is not a png name is refused" "symlink" "$wt" link2.png
mkdir -p "$src/dir.png"
refused "a directory named x.png is refused" "not a regular file" "$wt" dir.png
refused "a missing file is refused" "not a regular file" "$wt" nope.png
printf '\211PNG\r\n\032\n' > "$src/big.png"; truncate -s 5242881 "$src/big.png"
refused "a file over 5 MB is refused" "over" "$wt" big.png
mkdir -p "$src/sub"; printf '\211PNG\r\n\032\nx' > "$src/sub/a.png"
refused "a name with a slash is refused" "not [A-Za-z0-9._-]+.png" "$wt" sub/a.png
png ok.png; printf '\211PNG\r\n\032\nx' > "$outside/o.png"
refused "a name with .. and a slash is refused" "not [A-Za-z0-9._-]+.png" "$wt" ../outside/o.png
refused "an absolute path outside the download folder is refused" "not [A-Za-z0-9._-]+.png" "$wt" "$outside/o.png"
png ..png; png .hidden.png
refused "a leading-dot name is refused" "not [A-Za-z0-9._-]+.png" "$wt" .hidden.png
png a..b.png
refused "a name with .. inside is refused" "has .." "$wt" a..b.png
png "it's.png"; png 'back\slash.png'; png 'sp ace.png'; png 'st*r.png'; png 'q"uote.png'
refused "a quote in a name is refused" "not [A-Za-z0-9._-]+.png" "$wt" "it's.png"
refused "a double quote in a name is refused" "not [A-Za-z0-9._-]+.png" "$wt" 'q"uote.png'
refused "a backslash in a name is refused" "not [A-Za-z0-9._-]+.png" "$wt" 'back\slash.png'
refused "a space in a name is refused" "not [A-Za-z0-9._-]+.png" "$wt" 'sp ace.png'
refused "a glob in a name is refused" "not [A-Za-z0-9._-]+.png" "$wt" 'st*r.png'
refused "one bad name copies none: the good one before it stays out" "PNG magic" "$wt" ok.png text.png
reset
ln -s "$src" "$base/srclink"
rc=0; err=$(SHOTS_TEST_MODE=1 bash "$script" --src "$base/srclink" --root "$root" "$wt" ok.png 2>&1 >/dev/null) || rc=$?
[ "$rc" = 2 ] && [[ $err == *"no source folder"* ]] && [ ! -e "$wt/docs/screenshots/ok.png" ] && ok "a symlinked source folder is refused" || bad "a symlinked source folder is refused (exit $rc: $err)"

# --- the destination
mkdir -p "$outside/wt"; echo "gitdir: x" > "$outside/wt/.git"
expect "a worktree outside the roots is refused" 2 "not directly inside a worktree root" "$outside/wt" ok.png
[ ! -e "$outside/wt/docs" ] && ok "a worktree outside the roots: nothing made" || bad "a worktree outside the roots: nothing made"
mkdir -p "$root/nogit"
expect "a folder that is not a git worktree is refused" 2 "not a git worktree" "$root/nogit" ok.png
[ ! -e "$root/nogit/docs" ] && ok "not a git worktree: nothing made" || bad "not a git worktree: nothing made"
mkdir -p "$root/deep/wt"; echo "gitdir: x" > "$root/deep/wt/.git"
expect "a worktree two levels under the root is refused" 2 "not directly inside a worktree root" "$root/deep/wt" ok.png
expect "the root itself is refused" 2 "not directly inside a worktree root" "$root" ok.png
reset; ln -s "$wt" "$root/linkwt"
expect "a symlink to a worktree is refused" 2 "own real path" "$root/linkwt" ok.png
ln -s "$root" "$base/linkroot"
expect "a symlinked parent of the worktree is refused" 2 "own real path" "$base/linkroot/wt" ok.png
expect "a .. part in the worktree path is refused" 2 "own real path" "$root/wt/../wt" ok.png
expect "a relative worktree path is refused" 2 "character outside" "wt" ok.png
for d in "it's" 'back\slash' 'sp ace' 'st*r' 'q"uote'; do
  mkdir -p "$root/$d"; echo "gitdir: x" > "$root/$d/.git"
  expect "a worktree path with ${d:0:2}... in it is refused" 2 "character outside" "$root/$d" ok.png
  [ ! -e "$root/$d/docs" ] && ok "nothing made in $d" || bad "nothing made in $d"
done
reset; mkdir -p "$outside/docs-target"; ln -s "$outside/docs-target" "$wt/docs"
expect "docs as a symlink is refused" 2 "docs is a symlink" "$wt" ok.png
[ -z "$(ls -A "$outside/docs-target")" ] && ok "docs symlink: nothing written through it" || bad "docs symlink: nothing written through it"
reset; mkdir -p "$wt/docs" "$outside/shots-target"; ln -s "$outside/shots-target" "$wt/docs/screenshots"
expect "docs/screenshots as a symlink is refused" 2 "screenshots is a symlink" "$wt" ok.png
[ -z "$(ls -A "$outside/shots-target")" ] && ok "screenshots symlink: nothing written through it" || bad "screenshots symlink: nothing written through it"
reset; mkdir -p "$wt/docs/screenshots"; printf 'secret' > "$outside/victim"; ln -s "$outside/victim" "$wt/docs/screenshots/ok.png"
expect "a symlink in the destination is refused even with --force" 2 "is a symlink" --force "$wt" ok.png
[ "$(cat "$outside/victim")" = secret ] && ok "nothing written through the destination symlink" || bad "nothing written through the destination symlink"
reset; mkdir -p "$wt/docs/screenshots"; ln -s "$outside/never-made" "$wt/docs/screenshots/ok.png"
expect "a dangling symlink in the destination is refused" 2 "is a symlink" "$wt" ok.png
[ ! -e "$outside/never-made" ] && ok "dangling symlink: nothing created through it" || bad "dangling symlink: nothing created through it"
reset; mkdir -p "$wt/docs/screenshots"; png ok.png; printf 'old' > "$wt/docs/screenshots/ok.png"
expect "an existing regular file is refused without --force" 2 "exists" "$wt" ok.png
[ "$(cat "$wt/docs/screenshots/ok.png")" = old ] && ok "the existing file is untouched" || bad "the existing file is untouched"

# --- the PNG check: all 8 signature bytes, then the IHDR chunk name at bytes 12-15 (T-868 S2, finding 2)
printf '\211PNG' > "$src/four.png"; printf 'xxxx\000\000\000\rIHDR' >> "$src/four.png"
refused "only the first 4 signature bytes right is refused" "PNG magic" "$wt" four.png
printf '\211PNG\r\n\032\nxxxxxxxx' > "$src/noihdr.png"
refused "a signature with no IHDR chunk is refused" "IHDR" "$wt" noihdr.png
printf '\211PNG\r\n\032\nIHDR\000\000\000\r' > "$src/shift.png"
refused "IHDR at bytes 8-11 instead of 12-15 is refused" "IHDR" "$wt" shift.png
printf '\211PNG\r\n\032\n\000\000\000\rIHDX' > "$src/ihdx.png"
refused "a chunk name that is not IHDR is refused" "IHDR" "$wt" ihdx.png
printf '\211PNG\r\n\032\n\000\000' > "$src/short.png"
refused "a file shorter than 16 bytes is refused" "shorter than" "$wt" short.png
reset; printf "$HDR" > "$src/exact.png"
expect "exactly the 16 header bytes is accepted" 0 "" "$wt" exact.png

# --- the copy is staged and verified (T-868 S2, finding 1): a hook swaps a file AFTER the checks, as a racing process would
real_png=$outside/real.png; printf "${HDR}real" > "$real_png"
mkhook() { printf '#!/usr/bin/env bash\n%s\nexit 0\n' "$1" > "$base/hook.sh"; chmod +x "$base/hook.sh"; }
# refused_hook <name> <fragment> <hook body> <args...>: the hook runs at before-copy ($1) or before-move; nothing may be left behind
refused_hook() {
  local name=$1 frag=$2 body=$3; shift 3
  reset; rm -rf "$src/ok.png"; png ok.png; mkhook "$body"
  local rc=0 err
  err=$(SHOTS_TEST_MODE=1 bash "$script" --src "$src" --root "$root" --hook "$base/hook.sh" "$@" 2>&1 >/dev/null) || rc=$?
  if [ "$rc" = 2 ] && [[ $err == *"$frag"* ]]; then ok "$name"; else bad "$name (exit $rc: $err)"; fi
}
nothing_left() { if [ -z "$(ls -A "$wt/docs/screenshots" 2>/dev/null)" ]; then ok "$1: nothing left, staging removed"; else bad "$1: left behind: $(ls -A "$wt/docs/screenshots")"; fi; }
refused_hook "a source swapped for a link to a PNG is refused" "not a regular file" "[ \"\$1\" = before-copy ] && rm -f '$src/ok.png' && ln -s '$real_png' '$src/ok.png'" "$wt" ok.png
nothing_left "link swap"
refused_hook "a source swapped for other bytes is refused" "PNG magic" "[ \"\$1\" = before-copy ] && printf 'swapped for text, not a png' > '$src/ok.png'" "$wt" ok.png
nothing_left "bytes swap"
refused_hook "a source swapped for a PNG without IHDR is refused" "IHDR" "[ \"\$1\" = before-copy ] && printf '\\211PNG\\r\\n\\032\\nxxxxxxxxxxxx' > '$src/ok.png'" "$wt" ok.png
nothing_left "IHDR swap"
refused_hook "a source grown over 5 MB after the check is refused" "over" "[ \"\$1\" = before-copy ] && truncate -s 5242881 '$src/ok.png'" "$wt" ok.png
nothing_left "size swap"
refused_hook "a source swapped for a folder is refused" "failed" "[ \"\$1\" = before-copy ] && rm -f '$src/ok.png' && mkdir '$src/ok.png'" "$wt" ok.png
nothing_left "folder swap"
reset; rm -rf "$src/ok.png"; png ok.png; rm -f "$base/hook-ran"; mkhook "touch '$base/hook-ran'"
rc=0; SHOTS_TEST_MODE=1 bash "$script" --src "$src" --root "$root" --hook "$base/hook.sh" "$wt" text.png >/dev/null 2>&1 || rc=$?
{ [ "$rc" = 2 ] && [ ! -e "$base/hook-ran" ] && [ ! -e "$wt/docs/screenshots" ]; } && ok "a bad source is refused before anything is staged" || bad "a bad source is refused before anything is staged (exit $rc)"
rc=0; SHOTS_TEST_MODE=1 bash "$script" --src "$src" --root "$root" --hook "$base/hook.sh" "$wt" ok.png >/dev/null 2>&1 || rc=$?
{ [ "$rc" = 0 ] && [ -e "$base/hook-ran" ]; } && ok "the hook runs for a good copy (the swap tests rely on it)" || bad "the hook runs for a good copy (exit $rc)"
printf 'old' > "$base/old.txt"
refused_hook "a file that appears at the destination before the move is kept" "exists" "[ \"\$1\" = before-move ] && cp '$base/old.txt' \"\$2/../ok.png\"" "$wt" ok.png
[ "$(cat "$wt/docs/screenshots/ok.png")" = old ] && ok "the late file is untouched" || bad "the late file is untouched"
[ -z "$(ls -A "$wt/docs/screenshots" | grep -v '^ok.png$' || true)" ] && ok "late file: staging removed" || bad "late file: staging left behind"
printf 'secret' > "$outside/victim"
refused_hook "a link that appears at the destination before the move is refused" "exists" "[ \"\$1\" = before-move ] && ln -s '$outside/victim' \"\$2/../ok.png\"" "$wt" ok.png
[ "$(cat "$outside/victim")" = secret ] && ok "nothing written through the late link" || bad "nothing written through the late link"
reset; rm -rf "$src/ok.png"; png ok.png; mkhook "[ \"\$1\" = before-move ] && ln -s '$outside/victim' \"\$2/../ok.png\""
rc=0; SHOTS_TEST_MODE=1 bash "$script" --src "$src" --root "$root" --hook "$base/hook.sh" --force "$wt" ok.png >/dev/null 2>&1 || rc=$?
{ [ "$rc" = 0 ] && [ ! -L "$wt/docs/screenshots/ok.png" ] && [ -f "$wt/docs/screenshots/ok.png" ] && [ "$(cat "$outside/victim")" = secret ]; } && ok "--force replaces a late link itself, never writing through it" || bad "--force and a late link (exit $rc, victim: $(cat "$outside/victim"))"
reset; rm -rf "$src/ok.png"; png ok.png
expect "a clean copy through the staging folder still works" 0 "" "$wt" ok.png
cmp -s "$src/ok.png" "$wt/docs/screenshots/ok.png" && [ -z "$(ls -A "$wt/docs/screenshots" | grep -v '^ok.png$' || true)" ] && ok "clean copy: bytes equal, no staging left" || bad "clean copy: bytes or leftovers"

# --- the flags
rc=0; err=$(env -u SHOTS_TEST_MODE bash "$script" --hook "$base/hook.sh" "$wt" ok.png 2>&1 >/dev/null) || rc=$?
if [ "$rc" = 2 ] && [[ $err == *"--hook is for tests only"* ]]; then ok "--hook refused without SHOTS_TEST_MODE"; else bad "--hook refused without SHOTS_TEST_MODE (exit $rc: $err)"; fi
for flag in --src --root; do
  rc=0; err=$(env -u SHOTS_TEST_MODE bash "$script" "$flag" "$base" "$wt" ok.png 2>&1 >/dev/null) || rc=$?
  if [ "$rc" = 2 ] && [[ $err == *"$flag is for tests only"* ]]; then ok "$flag refused without SHOTS_TEST_MODE"; else bad "$flag refused without SHOTS_TEST_MODE (exit $rc: $err)"; fi
done
rc=0; err=$(SHOTS_TEST_MODE=0 bash "$script" --root "$base" "$wt" ok.png 2>&1 >/dev/null) || rc=$?
[ "$rc" = 2 ] && ok "--root refused when the variable is not 1" || bad "--root refused when the variable is not 1 (exit $rc)"
expect "no names is refused" 2 "no file names" "$wt"
expect "an unknown flag is refused" 2 "unknown flag" --evil "$wt" ok.png
# the real defaults: this test's worktree is outside the real roots, and the real download folder is not this test's
rc=0; err=$(env -u SHOTS_TEST_MODE bash "$script" "$wt" ok.png 2>&1 >/dev/null) || rc=$?
[ "$rc" = 2 ] && ok "with the real defaults, a worktree outside the real roots is refused" || bad "with the real defaults (exit $rc: $err)"

[ "$fails" = 0 ] && { echo "all passed"; exit 0; }
echo "$fails failed"; exit 1
