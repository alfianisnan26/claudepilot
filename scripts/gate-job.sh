#!/usr/bin/env bash
# The release gate as a Job in the cluster (T-37): scripts/gate.sh on a clean clone of a commit from GitHub, on CPUs other than this pod's,
# so the dev pod's 4 CPUs stay for the agents, and gates for different commits run side by side. The commit must be on GitHub (any branch).
#   scripts/gate-job.sh <commit> [steps] [files]
#                                            files: server test files, space or comma separated, relative to apps/server (default all)
#                                            steps: typecheck,web-build,server-suite (the default, the whole gate), or fewer, e.g.
#                                            typecheck,web-build for a heavy check without the suite
# Prints the summary and one verdict line (scripts/gate-verdict.sh), exits 0 for green, 1 for red, 2 for a usage error. The whole log is kept
# in GATE_JOB_LOG (default /tmp/gate-job-<sha>.log). GATE_IMAGE: the image (default: the newest development workspace image in the registry).
# The GitHub Packages token goes into a Secret that lives as long as the Job's wait and is deleted on exit; the log is searched for it.
set -eu
cd "$(git rev-parse --show-toplevel)"
commit=$(git rev-parse --verify "${1:?usage: scripts/gate-job.sh <commit> [steps]}^{commit}") || exit 2
steps=${2:-typecheck,web-build,server-suite}
files=${3:-}; files=${files//,/ }
for f in $files; do [[ $f =~ ^src/[A-Za-z0-9_./*-]+\.ts$ ]] || { echo "files: test files under apps/server/src (got $f)" >&2; exit 2; }; done
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
sed -e "s#NAME#$job#g" -e "s#BY_WHOM#${GATE_JOB_BY:-manual}#g" -e "s#\"COMMIT\"#\"$commit\"#" -e "s#\"STEPS\"#\"$steps\"#" -e "s#image: IMAGE#image: $image#" -e "s#\"VERDICT\"#\"$verdict\"#" -e "s#\"FILES\"#\"$files\"#" deploy/k3s-build/gate-job.yaml | kubectl apply -f - >/dev/null
# The Secret belongs to the Job: whoever deletes the Job (its TTL, gate-job-stop.sh, a person) deletes the token with it, also when this script was
# killed before its trap ran (a cancelled pipeline run).
uid=$(kubectl -n "$ns" get job "$job" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
if [ -n "$uid" ]; then
  kubectl -n "$ns" patch secret "$job" --type merge -p "{\"metadata\":{\"ownerReferences\":[{\"apiVersion\":\"batch/v1\",\"kind\":\"Job\",\"name\":\"$job\",\"uid\":\"$uid\"}],\"labels\":{\"app\":\"claudepilot-gate\",\"claudepilot-gate/by\":\"${GATE_JOB_BY:-manual}\"}}}" >/dev/null || true
fi
echo "gate job $job: $steps at $sha on $image ..."
state=; why=; t1=$(date +%s); pend_t=; seen_n=0
# T-578: the Job's own progress lines (per test file) while it runs, each once; the pod has no log yet while Pending.
progress() {
  local plog n
  plog=$(kubectl -n "$ns" logs "job/$job" 2>/dev/null | grep '^progress: ' || true)
  [ -n "$plog" ] || return 0
  n=$(printf '%s\n' "$plog" | wc -l)
  [ "$n" -le "$seen_n" ] || printf '%s\n' "$plog" | tail -n +$(( seen_n + 1 )) | sed 's/^/gate job: /'
  seen_n=$n
}
for _ in $(seq 1 $(( wait_s / poll_s ))); do
  state=$(kubectl -n "$ns" get job "$job" -o jsonpath='{.status.succeeded}/{.status.failed}' 2>/dev/null || true)
  case "$state" in 1/*|*/1) break ;; esac
  # Pending because no node can hold it (T-524: 8Gi requested fits one node only): say so when it starts and when it ends, not a silent wait.
  why=$(kubectl -n "$ns" get pods -l "job-name=$job" -o json 2>/dev/null | jq -r '[.items[0].status.conditions[]? | select(.type == "PodScheduled" and .status == "False" and .reason == "Unschedulable") | .message] | first // ""' 2>/dev/null || true)
  if [ -n "$why" ] && [ -z "$pend_t" ]; then
    pend_t=$(date +%s)
    echo "gate job $job is Pending: $why; it waits for a node with room (a Job that ends frees memory), up to ${wait_s}s"
  elif [ -z "$why" ] && [ -n "$pend_t" ]; then
    echo "gate job $job: scheduled after $(( $(date +%s) - pend_t ))s Pending"; pend_t=
  fi
  progress
  sleep "$poll_s"
done
progress
kubectl -n "$ns" logs "job/$job" > "$out" 2>&1 || true
t=$(gh auth token 2>/dev/null || true)
if [ -n "$t" ] && grep -q -F -- "$t" "$out"; then
  T="$t" awk 'BEGIN { t = ENVIRON["T"] } { while ((i = index($0, t)) > 0) $0 = substr($0, 1, i - 1) "[redacted]" substr($0, i + length(t)); print }' "$out" > "$out.masked" && mv "$out.masked" "$out"
  echo "WARNING: the token was in the gate log (masked in $out)" >&2
fi
unset t
case "$state" in 1/*|*/1) ;; *) kubectl -n "$ns" delete job "$job" --ignore-not-found >/dev/null 2>&1 || true
  # Never scheduled is not a slow or failed gate: the verdict names the scheduler's reason (nothing of the commit was checked).
  if [ -n "$pend_t" ]; then echo "GATE-VERDICT: red: not scheduled in $(( $(date +%s) - t1 ))s: $why"
  else echo "GATE-VERDICT: red: the job did not finish in ${wait_s}s"; fi
  exit 1 ;; esac
sed -n '/^=== SUMMARY$/,$p' "$out" | grep -v -e '^GATE-VERDICT: ' -e '^GATE-RESULT ' -e '^memory peak=' || true
# The Job's own memory peak (T-524: the 8Gi request is sized from it), always one line: the Job's cgroup reading, or "unavailable" when
# the Job printed none (a gate-job.yaml from before T-524).
mem=$(grep -E '^memory peak=' "$out" | tail -n 1 || true)
echo "${mem:-memory peak=unavailable (the gate Job printed no memory line)}"
echo "log: $out"
rc=0; bash scripts/gate-verdict.sh joblog "$out" || rc=$?
# T-578: a green run of the WHOLE gate leaves its verdict record (the Job's own GATE-RESULT line, checked against this commit and its tree)
# in a ConfigMap named by the tree, for 24 h of reuse by the deploy pipeline (scripts/gate-reuse.mjs decide). Failing to keep it never fails the gate.
if [ "$rc" = 0 ] && [ -z "$files" ] && [ "$steps" = typecheck,web-build,server-suite ]; then
  tree=$(git rev-parse "$commit^{tree}")
  if rec=$(node scripts/gate-reuse.mjs record --commit "$commit" --tree "$tree" < "$out"); then
    cm=claudepilot-gate-green-$tree
    kubectl -n "$ns" delete configmap "$cm" --ignore-not-found >/dev/null 2>&1 || true
    if kubectl -n "$ns" create configmap "$cm" --from-literal=record="$rec" >/dev/null 2>&1; then
      kubectl -n "$ns" label configmap "$cm" app=claudepilot-gate-verdict >/dev/null 2>&1 || true
      echo "gate verdict kept for reuse (tree ${tree:0:12}, 24 h)"
    else echo "gate verdict not kept for reuse (kubectl create configmap failed)"; fi
  else echo "gate verdict not kept for reuse: $rec"; fi
fi
exit "$rc"
