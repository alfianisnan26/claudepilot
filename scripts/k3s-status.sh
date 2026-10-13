#!/usr/bin/env bash
# One screen of cluster health for ClaudePilot: Argo CD app, portal and workspace pods, node load, warnings, the portal's last log lines.
set -u
echo "== argocd";  kubectl -n isnan-argocd get applications.argoproj.io isnan-claudepilot --no-headers -o custom-columns=NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REV:.status.sync.revision 2>&1 | cut -c1-110
echo "== portal";  kubectl -n isnan-claudepilot get deploy,pods --no-headers 2>&1 | awk '{print $1, $2, $3}'
kubectl -n isnan-claudepilot get deploy claudepilot-portal -o jsonpath='image: {.spec.template.spec.containers[0].image}{"\n"}' 2>&1
echo "== workspaces"; kubectl -n isnan-claudepilot-workspaces get deploy,pods,pvc --no-headers 2>&1 | awk '{print $1, $2, $3}'
echo "== nodes";   kubectl top nodes 2>&1 | head -4
echo "== requests per node (CPU/memory reserved by pods)"
for n in $(kubectl get nodes -o name | cut -d/ -f2); do printf '%s: ' "$n"; kubectl describe node "$n" | sed -n '/Allocated resources/,/Events/p' | awk '/^  cpu/{c=$2" "$3} /^  memory/{m=$2" "$3} END{print "cpu "c", memory "m}'; done
echo "== warnings (last 8)"; kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp --no-headers 2>&1 | tail -8 | awk '{$1=$1};1' | cut -c1-170
echo "== portal log"; kubectl -n isnan-claudepilot logs deploy/claudepilot-portal --tail=8 2>&1 | cut -c1-170
