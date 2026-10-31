#!/usr/bin/env bash
# Vendors the UI reporter SDK (repo alfianisnan26/pilot-reporter) into the portal, repeatably (docs/prd/ui-reporter.md, ui-reporter-server.md).
#   scripts/vendor-reporter.sh <sdk commit>
# Clones the SDK at that exact commit into a temporary folder, installs its locked dependencies (npm ci), builds it (npm run build) and
# writes:
#   apps/server/src/reporter/vendor/reporter.js   the built script (dist/reporter.js), served at /reporter/v1/reporter.js
#   apps/server/src/reporter/vendor/VERSION       "<sdk package version>+<short commit>"
#   apps/server/src/reporter/vendor/axe.min.js    axe-core at AXE_VERSION (npm pack, integrity checked by npm), served at /reporter/v1/axe.js
# It also checks that the fresh build equals the dist/reporter.js committed at that commit, so what is vendored is what the SDK repo reviewed.
# Options (env): PILOT_REPORTER_REPO (default https://github.com/alfianisnan26/pilot-reporter.git; the git credential helper answers for a
# private repo, nothing is printed), AXE_VERSION (default below). Needs git, node and npm. Run from anywhere inside the claudepilot checkout.
set -euo pipefail

commit=${1:?usage: scripts/vendor-reporter.sh <sdk commit (full sha)>}
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "vendor-reporter: give the full 40-character commit sha" >&2; exit 2; }
repo_url=${PILOT_REPORTER_REPO:-https://github.com/alfianisnan26/pilot-reporter.git}
axe_version=${AXE_VERSION:-4.10.3}

root=$(git rev-parse --show-toplevel)
out="$root/apps/server/src/reporter/vendor"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "vendor-reporter: SDK $commit"
git init -q "$work/sdk"
git -C "$work/sdk" remote add origin "$repo_url"
git -C "$work/sdk" fetch -q --depth 1 origin "$commit"
git -C "$work/sdk" checkout -q --detach FETCH_HEAD
[ "$(git -C "$work/sdk" rev-parse HEAD)" = "$commit" ] || { echo "vendor-reporter: fetched commit differs" >&2; exit 1; }

version=$(node -p 'require(process.argv[1]).version' "$work/sdk/package.json")
short=${commit:0:7}
cp "$work/sdk/dist/reporter.js" "$work/committed.js"
(cd "$work/sdk" && npm ci --no-audit --no-fund --ignore-scripts --loglevel=error && npm run -s build)
if ! cmp -s "$work/sdk/dist/reporter.js" "$work/committed.js"; then
  echo "vendor-reporter: the fresh build differs from dist/reporter.js committed at $short; fix the SDK repo first" >&2
  exit 1
fi

echo "vendor-reporter: axe-core $axe_version"
(cd "$work" && npm pack -s --pack-destination "$work" "axe-core@$axe_version" >/dev/null)
tar -xzf "$work/axe-core-$axe_version.tgz" -C "$work" package/axe.min.js package/LICENSE

mkdir -p "$out"
cp "$work/sdk/dist/reporter.js" "$out/reporter.js"
printf '%s+%s\n' "$version" "$short" >"$out/VERSION"
cp "$work/package/axe.min.js" "$out/axe.min.js"
cp "$work/package/LICENSE" "$out/axe-core.LICENSE"
printf 'axe-core %s\n' "$axe_version" >"$out/AXE_VERSION"
echo "vendor-reporter: wrote $(cat "$out/VERSION") ($(wc -c <"$out/reporter.js") bytes), axe-core $axe_version ($(wc -c <"$out/axe.min.js") bytes)"
