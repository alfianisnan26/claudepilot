#!/usr/bin/env bash
# Builds an image IN the cluster (kaniko, linux/amd64) and pushes it to registry.int.isnan.me (pushing from outside fails: slow uplink,
# a 60 s request cut, Cloudflare's 100 MB cap). The source is this repository on GitHub, so the commit must be pushed first.
#   scripts/k3s-build.sh portal|workspace|workspace-dev|browser <tag> [commit]      commit: default HEAD; branch: BUILD_BRANCH (default integration)
#   BUILD_NAMESPACE=dev-rig-<name>: run the job in a rig namespace instead (scripts/dev-rig.sh), for a build from a dev branch; not the portal
#   (its job needs the token Secret)
# The portal build needs the GitHub Packages token for the private @isnanme/ui package: a Secret that lives for the build only, deleted on exit,
# and the log is searched for the token before the script says it is clean.
set -eu
what=${1:?portal|workspace|workspace-dev|browser}; tag=${2:?image tag, for example 2026.10.13-1 (workspace: <claude version>-<date>-<n>)}
commit=${3:-$(git rev-parse HEAD)}; branch=${BUILD_BRANCH:-integration}
ns=${BUILD_NAMESPACE:-isnan-claudepilot}; job=claudepilot-build-$what; file=deploy/k3s-build/$what-job.yaml
[ -f "$file" ] || { echo "no job file $file" >&2; exit 2; }
if [ "$ns" != isnan-claudepilot ]; then
  [[ $ns =~ ^dev-rig-[a-z0-9-]+$ ]] || { echo "refused: BUILD_NAMESPACE is isnan-claudepilot or a rig (dev-rig-<name>), not \"$ns\"" >&2; exit 2; }
  [ "$(kubectl get ns "$ns" -o jsonpath='{.metadata.labels.claudepilot\.rig}' 2>/dev/null)" = true ] || { echo "refused: $ns is not a rig namespace (scripts/dev-rig.sh create $ns)" >&2; exit 2; }
  [ "$what" != portal ] || { echo "refused: the portal builds in isnan-claudepilot only" >&2; exit 2; }
fi
git fetch -q origin "$branch" || true
git merge-base --is-ancestor "$commit" "origin/$branch" 2>/dev/null || { echo "commit $commit is not on origin/$branch: push it first" >&2; exit 2; }
kubectl -n "$ns" delete job "$job" --ignore-not-found >/dev/null
if [ "$what" = portal ]; then
  kubectl -n "$ns" create secret generic claudepilot-build --from-literal=node-auth-token="$(gh auth token)" >/dev/null
  trap 'kubectl -n "$ns" delete secret claudepilot-build --ignore-not-found >/dev/null' EXIT
fi
sed -e "s#refs/heads/main\#COMMIT#refs/heads/$branch\#$commit#" -e "s/:TAG/:$tag/" -e "s/=RELEASE_TAG$/=$tag/" -e "s/^  namespace: isnan-claudepilot$/  namespace: $ns/" "$file" | kubectl apply -f - >/dev/null
echo "building $what:$tag from $commit ..."
for _ in $(seq 1 180); do
  s=$(kubectl -n "$ns" get job "$job" -o jsonpath='{.status.succeeded}/{.status.failed}' 2>/dev/null || true)
  case "$s" in 1/*) ok=1; break ;; */1) ok=0; break ;; esac
  sleep 5
done
[ "${ok:-0}" = 1 ] || { echo "BUILD FAILED or timed out; last log lines:" >&2; kubectl -n "$ns" logs "job/$job" --tail=15 >&2 || true; exit 1; }
if [ "$what" = portal ]; then
  t=$(gh auth token); n=$(kubectl -n "$ns" logs "job/$job" | grep -c -F -- "$t" || true); unset t
  [ "$n" = 0 ] && echo "token in the build log: none" || echo "WARNING: the token appears $n times in the build log" >&2
fi
repo=claudepilot/$(case "$what" in portal) echo portal ;; browser) echo browser ;; *) echo workspace ;; esac)
echo "pushed: registry.int.isnan.me/$repo:$tag"; curl -fsS "https://registry.int.isnan.me/v2/$repo/tags/list" | head -c 300; echo
