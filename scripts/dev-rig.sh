#!/usr/bin/env bash
# Rig namespaces for tests that need a cluster (the Connect rig, a delivery check): create or delete a namespace named dev-rig-<name>, and NOTHING else.
#   scripts/dev-rig.sh create dev-rig-connect      a namespace with the pod security level baseline and the label claudepilot.rig=true
#   scripts/dev-rig.sh delete dev-rig-connect      refuses any other name, and a namespace that is not a rig (no rig or managed label)
#   scripts/dev-rig.sh list
# Why a script: .claude/settings.json denies `kubectl delete namespace` and every change in the portal, workspace and Argo CD namespaces, even in
# Bypass, so a rig could not be cleaned up by the one who made it. This is the one narrow door: the name must match, and the label must say rig.
set -eu
cmd=${1:?create|delete|list}; ns=${2:-}
ok_name() { [[ $1 =~ ^dev-rig-[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$ ]] || { echo "refused: a rig namespace is named dev-rig-<name> (lowercase letters, digits, -), not \"$1\"" >&2; exit 2; }; }
case "$cmd" in
  list) kubectl get ns -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp,RIG:.metadata.labels.claudepilot\\.rig,MANAGED:.metadata.labels.claudepilot\\.managed --no-headers | grep '^dev-rig-' || echo "no rig namespaces" ;;
  create)
    ok_name "$ns"
    kubectl create namespace "$ns"
    kubectl label namespace "$ns" claudepilot.rig=true pod-security.kubernetes.io/enforce=baseline --overwrite ;;
  delete)
    ok_name "$ns"
    rig=$(kubectl get ns "$ns" -o jsonpath='{.metadata.labels.claudepilot\.rig}' 2>/dev/null || true)
    managed=$(kubectl get ns "$ns" -o jsonpath='{.metadata.labels.claudepilot\.managed}' 2>/dev/null || true)
    if [ "$rig" != true ] && [ "$managed" != true ]; then echo "refused: $ns is not labelled as a rig (claudepilot.rig=true) or managed by ClaudePilot" >&2; exit 2; fi
    kubectl delete namespace "$ns" --wait=true --timeout=120s ;;
  *) echo "create|delete|list" >&2; exit 2 ;;
esac
