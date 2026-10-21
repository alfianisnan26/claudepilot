#!/usr/bin/env bash
# The gate's typecheck (tsc --noEmit for packages/contracts, apps/server, apps/web) on a git worktree of this repository, with the main
# checkout's install and no npm ci (T-1982): for a host where the cluster job runner is out of reach or slow (the coordinator's Mac devcontainer).
#   scripts/typecheck-worktree.sh <worktree>
# The main checkout is the worktree's own repository (the folder that holds its git common dir). Its node_modules is only READ: nothing in it is
# created, changed or deleted. <worktree>/node_modules (gitignored) becomes an overlay: a folder whose every entry links to the main install, with
# @portal/contracts, @portal/server and @portal/web linked to THE WORKTREE's own packages, so the worktree's contracts are the ones checked. A
# node_modules this script did not make (a real install, scripts/worktree-deps.sh's links) is used as it is. The overlay stays for test runs;
# the next run rebuilds it.
# Packages the worktree's lockfile needs for the three workspaces but the main install lacks (the Mac's main install has no @codemirror/*,
# @lezer/*) are installed once, at the lockfile's exact versions with --ignore-scripts, into a cache (TYPECHECK_CACHE_DIR, default
# ~/.cache/claudepilot-typecheck/<hash of the list>) and linked into the overlay. With TYPECHECK_NO_INSTALL=1, or when that install fails, they
# are a KNOWN ENVIRONMENT GAP: the errors in files that import them are listed apart, and they do not count as clean.
# Output: the compiler's errors (paths relative to the worktree), then one line per project. Exit 0 clean; 1 type errors; 3 only errors in
# files that import a missing package (not proven clean: use the cluster, scripts/job-run.sh); 2 refused (not a worktree, the main checkout
# itself, package files that differ from the main checkout's: then the install is not the same and the cluster typecheck is the one).
set -eu
set -o pipefail
refuse() { echo "typecheck-worktree: refused: $*" >&2; exit 2; }
wt=${1:?usage: scripts/typecheck-worktree.sh <worktree>}
[ -d "$wt" ] || refuse "$wt is not a folder"
wt=$(cd "$wt" && pwd -P)
[ "$(git -C "$wt" rev-parse --show-toplevel 2>/dev/null || :)" = "$wt" ] || refuse "$wt is not the top of a git worktree"
common=$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || :)
[ -n "$common" ] || refuse "$wt has no git common dir"
main=$(cd "$common/.." && pwd -P)
[ "$wt" != "$main" ] || refuse "$wt is the main checkout: give a worktree (its node_modules is never touched)"
[ "$(git -C "$wt" rev-parse --absolute-git-dir)" != "$(cd "$common" && pwd -P)" ] || refuse "$wt is the main checkout, not a worktree"
[ -d "$main/node_modules" ] || refuse "no install at $main/node_modules"
[ -x "$main/node_modules/typescript/bin/tsc" ] || refuse "no typescript in $main/node_modules"
for d in apps packages apps/web apps/server packages/contracts; do
  [ -d "$wt/$d" ] && [ ! -L "$wt/$d" ] || refuse "$wt/$d is missing or a symbolic link"
done
# Same package files as the main checkout, or a link would lie about the dependencies.
files=$( { git -C "$wt" ls-files; git -C "$main" ls-files; } | grep -E '(^|/)(package\.json|package-lock\.json)$' | sort -u || :)
[ -n "$files" ] || refuse "no package.json found"
for f in $files; do
  cmp -s "$wt/$f" "$main/$f" || refuse "$f differs from the main checkout's: run the typecheck in the cluster (scripts/job-run.sh)"
done

nm=$wt/node_modules; mark=$nm/.typecheck-worktree-overlay
link() { if [ -L "$2" ] || [ ! -e "$2" ]; then ln -sfn "$1" "$2"; fi; }
if [ -e "$nm" ] && [ ! -e "$mark" ]; then
  echo "typecheck-worktree: using the worktree's own node_modules as it is" >&2
else
  # Only this script's overlay is cleared: symlinks and the folders it made, never through a link (find -P does not follow them).
  if [ -e "$mark" ]; then find -P "$nm" -mindepth 1 -depth \( -type l -o -type f \) -delete && find -P "$nm" -mindepth 1 -depth -type d -empty -delete; fi
  mkdir -p "$nm"; : > "$mark"
  for e in "$main"/node_modules/* "$main"/node_modules/.[!.]*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    name=$(basename "$e")
    case $name in
      @portal) continue ;;
      @*)
        if [ -d "$e" ] && [ ! -L "$e" ]; then
          mkdir -p "$nm/$name"
          for s in "$e"/*; do [ -e "$s" ] || [ -L "$s" ] || continue; link "$s" "$nm/$name/$(basename "$s")"; done
        else link "$e" "$nm/$name"; fi ;;
      *) link "$e" "$nm/$name" ;;
    esac
  done
  mkdir -p "$nm/@portal"
  link "$wt/packages/contracts" "$nm/@portal/contracts"
  link "$wt/apps/server" "$nm/@portal/server"
  link "$wt/apps/web" "$nm/@portal/web"
  for d in apps/web apps/server packages/contracts; do
    if [ -d "$main/$d/node_modules" ] && [ ! -e "$wt/$d/node_modules" ]; then link "$main/$d/node_modules" "$wt/$d/node_modules"; fi
  done
fi

# What the three workspaces need (their dependencies, dev and peer, and everything those need, from the lockfile) that the install lacks.
missing=$(node -e '
  const fs = require("fs"), path = require("path"); const [wt, nm] = process.argv.slice(1);
  const lock = JSON.parse(fs.readFileSync(path.join(wt, "package-lock.json"), "utf8")).packages || {};
  const q = [], seen = new Set(), out = [];
  for (const w of ["apps/web", "apps/server", "packages/contracts"]) { const p = lock[w] || {}; q.push(...Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.peerDependencies })); }
  while (q.length) { const n = q.pop(); if (seen.has(n)) continue; seen.add(n); const e = lock["node_modules/" + n];
    if (!e || e.link || e.optional || fs.existsSync(path.join(nm, n))) continue;
    out.push(n + "@" + e.version); q.push(...Object.keys({ ...e.dependencies, ...e.peerDependencies })); }
  process.stdout.write(out.sort().join(" "));' "$wt" "$nm")
gap=
if [ -n "$missing" ]; then
  cache=${TYPECHECK_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/claudepilot-typecheck}/$(printf '%s' "$missing" | sha256sum | cut -c1-16)
  if [ "${TYPECHECK_NO_INSTALL:-}" != 1 ] && [ ! -e "$cache/.done" ]; then
    echo "typecheck-worktree: the main install lacks $(wc -w <<<"$missing") package(s); installing them once into $cache" >&2
    mkdir -p "$cache"; [ -e "$cache/package.json" ] || echo '{"name":"typecheck-worktree-extra","private":true}' > "$cache/package.json"
    # shellcheck disable=SC2086 # the list is words on purpose
    if npm install --prefix "$cache" --no-save --no-package-lock --ignore-scripts --no-audit --no-fund --loglevel=error $missing >/dev/null; then : > "$cache/.done"
    else echo "typecheck-worktree: that install failed" >&2; fi
  fi
  if [ "${TYPECHECK_NO_INSTALL:-}" != 1 ] && [ -e "$cache/.done" ] && [ -e "$mark" ]; then
    for p in $missing; do n=${p%@*}; mkdir -p "$(dirname "$nm/$n")"; link "$cache/node_modules/$n" "$nm/$n"; done
  else
    gap=$missing
    echo "typecheck-worktree: KNOWN ENVIRONMENT GAP: not installed: $gap" >&2
  fi
fi

# The compiler, one project at a time (heavy jobs one at a time), from the worktree so the paths are relative to it.
tsc=$nm/typescript/bin/tsc; rc=0; real=0; gapn=0; summary=
gapre=
for p in $gap; do n=${p%@*}; gapre+="${gapre:+|}${n//./\\.}"; done
for d in packages/contracts apps/server apps/web; do
  out=$(cd "$wt" && node "$tsc" --noEmit --pretty false -p "$d" 2>&1) && { summary+="$d: clean"$'\n'; continue; }
  # An error line starts with the file; the indented lines after it belong to it.
  r=0; g=0; cur=
  while IFS= read -r line; do
    if [[ $line =~ ^([^[:space:]][^\(]*)\([0-9]+,[0-9]+\):\ error ]]; then
      cur=real; f=${BASH_REMATCH[1]}
      if [ -n "$gapre" ] && { [[ $line =~ \'($gapre)(/[^\']*)?\' ]] || grep -Eq "from ['\"]($gapre)(/[^'\"]*)?['\"]" "$wt/$f" 2>/dev/null; }; then cur=gap; fi
      if [ "$cur" = real ]; then r=$((r + 1)); echo "$line"; else g=$((g + 1)); echo "[environment gap] $line"; fi
    elif [ "$cur" = real ]; then echo "$line"
    elif [ "$cur" = gap ]; then echo "[environment gap] $line"
    elif [ -n "$line" ]; then r=$((r + 1)); echo "$line"; fi
  done <<<"$out"
  real=$((real + r)); gapn=$((gapn + g))
  extra=; [ "$g" -eq 0 ] || extra=", $g in files that import a missing package"
  summary+="$d: $r error(s)$extra"$'\n'
done
printf '%s' "$summary" | sed 's/^/typecheck-worktree: /'
if [ "$real" -gt 0 ]; then rc=1; elif [ "$gapn" -gt 0 ]; then rc=3; echo "typecheck-worktree: NOT PROVEN CLEAN: $gapn error(s) only in files that import a missing package (environment gap); run the typecheck in the cluster" >&2; fi
exit $rc
