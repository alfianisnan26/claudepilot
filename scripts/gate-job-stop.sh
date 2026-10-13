#!/usr/bin/env bash
# Stops gate Jobs of scripts/gate-job.sh and deletes their Secrets (each holds a GitHub Packages token): the ones that outlive a cancelled pipeline run, whose runner kills
# gate-job.sh before its trap can clean up. Touches only objects named claudepilot-gate-<sha>-<hex> in the build namespace; nothing else (kubectl delete elsewhere is denied
# by .claude/settings.json, this script is the narrow door, like scripts/dev-rig.sh).
#   scripts/gate-job-stop.sh            every gate Job and gate Secret
#   scripts/gate-job-stop.sh <sha>      those of one commit (the first characters of its hash)
#   scripts/gate-job-stop.sh --by <who>  those started by <who> (gate-job.sh's GATE_JOB_BY: the deploy pipeline is "pipeline")
#   scripts/gate-job-stop.sh --list
set -eu
ns=${GATE_NAMESPACE:-isnan-claudepilot}; pre=${1:-}
list() { kubectl -n "$ns" get jobs,secrets -o name 2>/dev/null | sed 's#.*/##' | grep -E '^claudepilot-gate-[0-9a-f]{7}-[0-9a-f]{4}$' | sort -u || true; }
if [ "$pre" = --list ]; then
  kubectl -n "$ns" get jobs -o custom-columns=NAME:.metadata.name,ACTIVE:.status.active,SUCCEEDED:.status.succeeded,FAILED:.status.failed,AGE:.metadata.creationTimestamp --no-headers 2>/dev/null | grep '^claudepilot-gate-' || echo "no gate jobs"
  exit 0
fi
if [ "$pre" = --by ]; then
  who=${2:?usage: gate-job-stop.sh --by <who>}
  [[ $who =~ ^[a-z][a-z0-9-]{0,30}$ ]] || { echo "usage: gate-job-stop.sh --by <who>" >&2; exit 2; }
  list() { kubectl -n "$ns" get jobs,secrets -l "app=claudepilot-gate,claudepilot-gate/by=$who" -o name 2>/dev/null | sed 's#.*/##' | grep -E '^claudepilot-gate-[0-9a-f]{7}-[0-9a-f]{4}$' | sort -u || true; }
  pre=
fi
[ -z "$pre" ] || [[ $pre =~ ^[0-9a-f]{4,40}$ ]] || { echo "usage: gate-job-stop.sh [<sha prefix>|--by <who>|--list]" >&2; exit 2; }
pre=${pre:0:7}
n=0
for name in $(list); do
  [ -z "$pre" ] || [[ $name == claudepilot-gate-$pre* ]] || continue
  kubectl -n "$ns" delete job "$name" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl -n "$ns" delete secret "$name" --ignore-not-found >/dev/null 2>&1 || true
  echo "stopped $name"; n=$((n + 1))
done
echo "$n gate job(s) stopped"
