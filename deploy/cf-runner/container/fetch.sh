#!/usr/bin/env bash
# The fetch phase of a Cloudflare job (T-3542): the clone (with its submodules), any --sub override, `npm ci --ignore-scripts`. The git
# credential is NOT here: the dispatcher's Egress handler adds it to the clone's upload-pack requests, during this phase only. No code of
# the repository or a dependency runs here (the install scripts and the command run in run.sh, after the credential is gone). The k8s
# counterpart is the fetch container of deploy/k3s-build/job-run.yaml; the log lines are the same.
set -u
root=${JR_ROOT:-/work}; mkdir -p "$root/w"
say() { echo "=== JOB-RUN $*"; }
export npm_config_cache=$root/npm-cache npm_config_update_notifier=false CI=1
git config --global advice.detachedHead false
git config --global protocol.file.allow never
t0=$(date +%s)
main=$(basename "$JR_REPO_URL" .git); d=$root/w/$main
git init -q "$d" && git -C "$d" fetch -q --depth 1 "$JR_REPO_URL" "$JR_REF" && git -C "$d" checkout -q FETCH_HEAD \
  || { echo "job-run: $JR_REF of $JR_REPO_URL is not on the remote (push it first)"; say "EXIT 2"; exit 2; }
if [ -f "$d/.gitmodules" ]; then
  # A pinned submodule commit is fetched by its sha (GitLab serves any reachable one); a shallow fetch that fails is tried once in full.
  git -C "$d" submodule update -q --init --recursive --depth 1 2>/dev/null || git -C "$d" submodule update -q --init --recursive \
    || { say "the submodules of $JR_REF could not be fetched"; say "EXIT 2"; exit 2; }
fi
# --sub <path>=<ref>: that submodule at another pushed ref (a lane's branch before the root's bump). Only a path .gitmodules names.
for s in ${JR_SUBS:-}; do
  p=${s%%=*}; r=${s#*=}
  git -C "$d" config -f .gitmodules --get-regexp '^submodule\..*\.path$' | awk '{print $2}' | grep -qxF -- "$p" \
    || { say "--sub $p: not a submodule of $main"; say "EXIT 2"; exit 2; }
  git -C "$d/$p" fetch -q --depth 1 origin "$r" && git -C "$d/$p" checkout -q FETCH_HEAD \
    || { echo "job-run: $r of the submodule $p is not on the remote (push it first)"; say "EXIT 2"; exit 2; }
done
sha=$(git -C "$d" rev-parse --short HEAD); t1=$(date +%s)
say "checked out $main at $sha in $((t1 - t0))s"
git -C "$d" submodule status --recursive 2>/dev/null | awk '{ printf "=== JOB-RUN submodule %s at %s\n", $2, substr($1, 1, 9) }' | tr -d '+-'
npmrun() { (cd "$1" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error); }
if [ "$JR_STEPS" = npm-ci ] && [ -f "$d/package-lock.json" ]; then
  npmrun "$d" || { rc=$?; say "npm ci failed in $main (rc=$rc); retrying once"; npmrun "$d" || { rc=$?; say "npm ci failed in $main (rc=$rc)"; say "EXIT $rc"; exit "$rc"; }; say "npm ci passed on the retry in $main"; }
fi
echo "$t0 $t1" > "$root/fetch.times"; echo "$sha" > "$root/fetch.sha"
say "credentials: none in this container (the clone's was added by the dispatcher, fetch phase only)"
