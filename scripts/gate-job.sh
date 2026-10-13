#!/usr/bin/env bash
# The release gate as a Job in the cluster (T-37): scripts/gate.sh on a clean clone of a commit from GitHub, on CPUs other than this pod's,
# so the dev pod's 4 CPUs stay for the agents, and gates for different commits run side by side. The commit must be on GitHub (any branch).
#   scripts/gate-job.sh <commit> [steps]     steps: typecheck,web-build,server-suite (the default, the whole gate), or fewer, e.g.
#                                            typecheck,web-build for a heavy check without the suite
# Prints the summary and one verdict line (scripts/gate-verdict.sh), exits 0 for green, 1 for red, 2 for a usage error. The whole log is kept
# in GATE_JOB_LOG (default /tmp/gate-job-<sha>.log). GATE_IMAGE: the image (default: the newest development workspace image in the registry).
# The GitHub Packages token goes into a Secret that lives as long as the Job's wait and is deleted on exit; the log is searched for it.
set -eu
cd "$(git rev-parse --show-toplevel)"
commit=$(git rev-parse --verify "${1:?usage: scripts/gate-job.sh <commit> [steps]}^{commit}") || exit 2
steps=${2:-typecheck,web-build,server-suite}
[[ $steps =~ ^(typecheck|web-build|server-suite)(,(typecheck|web-build|server-suite))*$ ]] || { echo "steps: typecheck, web-build, server-suite (comma separated)" >&2; exit 2; }
ns=${GATE_NAMESPACE:-isnan-claudepilot}; registry=${DEPLOY_REGISTRY:-registry.int.isnan.me}
sha=${commit:0:7}; job=claudepilot-gate-$sha-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')
out=${GATE_JOB_LOG:-/tmp/gate-job-$sha.log}; wait_s=${GATE_JOB_WAIT_S:-5400}; poll_s=${GATE_JOB_POLL_S:-10}
image=${GATE_IMAGE:-}
if [ -z "$image" ]; then
  tag=$(curl -fsS "https://$registry/v2/claudepilot/workspace/tags/list" | jq -r '.tags[]? | select(test("-dev-"))' | sort -V | tail -n 1)
  [ -n "$tag" ] || { echo "no development workspace image in $registry: set GATE_IMAGE" >&2; exit 1; }
  image=$registry/claudepilot/workspace:$tag
fi
# shellcheck disable=SC2317 # called by the EXIT trap
cleanup() { kubectl -n "$ns" delete secret "$job" --ignore-not-found >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'kubectl -n "$ns" delete job "$job" --ignore-not-found >/dev/null 2>&1 || true; exit 130' INT TERM
# The token reaches kubectl on stdin (printf is a builtin: no argument a process list would show), without gh's newline (npm refuses it).
printf '%s' "$(gh auth token)" | kubectl -n "$ns" create secret generic "$job" --from-file=node-auth-token=/dev/stdin >/dev/null
verdict=$(base64 -w0 < scripts/gate-verdict.sh)
sed -e "s#NAME#$job#g" -e "s#BY_WHOM#${GATE_JOB_BY:-manual}#g" -e "s#\"COMMIT\"#\"$commit\"#" -e "s#\"STEPS\"#\"$steps\"#" -e "s#image: IMAGE#image: $image#" -e "s#\"VERDICT\"#\"$verdict\"#" deploy/k3s-build/gate-job.yaml | kubectl apply -f - >/dev/null
# The Secret belongs to the Job: whoever deletes the Job (its TTL, gate-job-stop.sh, a person) deletes the token with it, also when this script was
# killed before its trap ran (a cancelled pipeline run).
uid=$(kubectl -n "$ns" get job "$job" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
if [ -n "$uid" ]; then
  kubectl -n "$ns" patch secret "$job" --type merge -p "{\"metadata\":{\"ownerReferences\":[{\"apiVersion\":\"batch/v1\",\"kind\":\"Job\",\"name\":\"$job\",\"uid\":\"$uid\"}],\"labels\":{\"app\":\"claudepilot-gate\",\"claudepilot-gate/by\":\"${GATE_JOB_BY:-manual}\"}}}" >/dev/null || true
fi
echo "gate job $job: $steps at $sha on $image ..."
state=
for _ in $(seq 1 $(( wait_s / poll_s ))); do
  state=$(kubectl -n "$ns" get job "$job" -o jsonpath='{.status.succeeded}/{.status.failed}' 2>/dev/null || true)
  case "$state" in 1/*|*/1) break ;; esac
  sleep "$poll_s"
done
kubectl -n "$ns" logs "job/$job" > "$out" 2>&1 || true
t=$(gh auth token 2>/dev/null || true)
if [ -n "$t" ] && grep -q -F -- "$t" "$out"; then
  T="$t" awk 'BEGIN { t = ENVIRON["T"] } { while ((i = index($0, t)) > 0) $0 = substr($0, 1, i - 1) "[redacted]" substr($0, i + length(t)); print }' "$out" > "$out.masked" && mv "$out.masked" "$out"
  echo "WARNING: the token was in the gate log (masked in $out)" >&2
fi
unset t
case "$state" in 1/*|*/1) ;; *) kubectl -n "$ns" delete job "$job" --ignore-not-found >/dev/null 2>&1 || true; echo "GATE-VERDICT: red: the job did not finish in ${wait_s}s"; exit 1 ;; esac
sed -n '/^=== SUMMARY$/,$p' "$out" | grep -v '^GATE-VERDICT: ' || true
echo "log: $out"
rc=0; bash scripts/gate-verdict.sh joblog "$out" || rc=$?
exit "$rc"
