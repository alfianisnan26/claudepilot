#!/usr/bin/env bash
# The run phase of a Cloudflare job (T-3542), after the dispatcher dropped the git credential: the install scripts `npm ci
# --ignore-scripts` left out, the command, the artifacts (to R2 through http://artifacts.jobrun, never base64 in the log), then the same
# SUMMARY / MEMORY / EXIT lines as the k8s run container (deploy/k3s-build/job-run.yaml), so scripts/job-run.sh reads both alike.
set -u
root=${JR_ROOT:-/work}; say() { echo "=== JOB-RUN $*"; }
export HOME=$root/home npm_config_cache=$root/npm-cache npm_config_update_notifier=false CI=1 NODE_AUTH_TOKEN=
mkdir -p "$HOME"
read -r t0 t1 < "$root/fetch.times"
main=$(basename "$JR_REPO_URL" .git); sha=$(cat "$root/fetch.sha" 2>/dev/null || true)
lifecycle() { [ -f package.json ] || return 0; node -e 'const s = require("./package.json").scripts || {}; for (const n of ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"]) if (s[n]) console.log(n)'; }
if [ "$JR_STEPS" = npm-ci ] && [ -f "$root/w/$main/package-lock.json" ]; then
  (cd "$root/w/$main" && npm rebuild --no-audit --no-fund --loglevel=error && for s in $(lifecycle); do npm run --ignore-scripts --loglevel=error "$s" || exit; done) \
    || { rc=$?; say "install scripts failed in $main (rc=$rc)"; say "EXIT $rc"; exit "$rc"; }
fi
t2=$(date +%s); say "steps ($JR_STEPS) in $((t2 - t1))s; running the command"
cd "$root/w/$main" && printf '%s' "$JR_CMD" | base64 -d > "$root/cmd.sh"
bash -o pipefail "$root/cmd.sh"; rc=$?
t3=$(date +%s)
cd "$root/w/$main" || true
if [ -n "${JR_ARTIFACTS:-}" ]; then
  # shellcheck disable=SC2086 # a list of paths
  if tar -czf "$root/artifacts.tgz" --ignore-failed-read -C "$root/w/$main" -- $JR_ARTIFACTS 2>/dev/null || [ -s "$root/artifacts.tgz" ]; then
    size=$(stat -c %s "$root/artifacts.tgz")
    if [ "$size" -le "${JR_ARTIFACT_MAX:-0}" ]; then
      if curl -sf -X PUT -H 'content-type: application/gzip' --data-binary @"$root/artifacts.tgz" http://artifacts.jobrun/upload >/dev/null; then
        say "ARTIFACTS R2 bytes=$size"
      else say "artifacts not copied back: the upload failed"; fi
    else say "artifacts not copied back: $size bytes compressed, over the cap of ${JR_ARTIFACT_MAX:-0}"; fi
  else say "artifacts: nothing at $JR_ARTIFACTS"; fi
fi
say "SUMMARY $main@$sha checkout=$((t1 - t0))s steps=$((t2 - t1))s run=$((t3 - t2))s rc=$rc node=cf:${JR_LOCATION:-?}"
cg=/sys/fs/cgroup; mib() { v=$(cat "$cg/$1" 2>/dev/null) && [[ $v =~ ^[0-9]+$ ]] && echo "$((v / 1048576))Mi" || echo "${v:-?}"; }
say "MEMORY peak=$(mib memory.peak) limit=$(mib memory.max) oom_kills=$(sed -n 's/^oom_kill //p' "$cg/memory.events" 2>/dev/null | grep . || echo '?')"
say "EXIT $rc"
exit "$rc"
