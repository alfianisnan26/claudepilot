#!/usr/bin/env bash
# CPU and memory of a Kubernetes workspace (its Deployment ws-<name> in isnan-claudepilot-workspaces), and NOTHING else: until the portal can do it
# (T-98), this is the one narrow door. The portal sets resources once, at create; stop and start never re-apply them.
#   scripts/ws-resources.sh <name> [--cpu-request 1] [--memory-request 2Gi] [--cpu-limit 4] [--memory-limit 8Gi]          what would change, and whether it fits
#   scripts/ws-resources.sh <name> ... --apply                                                                             do it
# Why a script: .claude/settings.json denies `kubectl patch` in the workspace namespace, even in Bypass, because the Deployment is Recreate: a change
# restarts the pod and EVERY session in it ends (the orchestrator, the chats, a running CI job). So: run it only when the owner asked for it and
# nothing is mid-deploy (look at ci_run_list first); a dry run is always safe. It touches the `workspace` container's resources and one annotation,
# refuses any Deployment that is not a managed workspace, a request above its limit, and a request that does not fit the pod's node.
set -eu
ns=isnan-claudepilot-workspaces
name=${1:?usage: scripts/ws-resources.sh <name> [--cpu-request C] [--memory-request M] [--cpu-limit C] [--memory-limit M] [--apply]}; shift
[[ $name =~ ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$ ]] || { echo "refused: \"$name\" is not a workspace name" >&2; exit 2; }
cpu_req= mem_req= cpu_lim= mem_lim= apply=0
cpu_ok() { [[ $1 =~ ^([0-9]+m|[0-9]+(\.[0-9]+)?)$ ]] || { echo "refused: \"$1\" is not a CPU quantity (250m, 1, 0.5)" >&2; exit 2; }; }
mem_ok() { [[ $1 =~ ^[0-9]+(Mi|Gi)$ ]] || { echo "refused: \"$1\" is not a memory quantity (512Mi, 2Gi)" >&2; exit 2; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --cpu-request) cpu_ok "${2:?}"; cpu_req=$2; shift 2 ;;
    --memory-request) mem_ok "${2:?}"; mem_req=$2; shift 2 ;;
    --cpu-limit) cpu_ok "${2:?}"; cpu_lim=$2; shift 2 ;;
    --memory-limit) mem_ok "${2:?}"; mem_lim=$2; shift 2 ;;
    --apply) apply=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$cpu_req$mem_req$cpu_lim$mem_lim" ] || { echo "nothing to change: give at least one of --cpu-request, --memory-request, --cpu-limit, --memory-limit" >&2; exit 2; }

dep=$(kubectl -n "$ns" get deploy "ws-$name" -o json 2>/dev/null) || { echo "refused: no Deployment ws-$name in $ns" >&2; exit 2; }
[ "$(jq -r '.metadata.labels["claudepilot.managed"] // ""' <<<"$dep")" = true ] || { echo "refused: ws-$name is not labelled claudepilot.managed=true" >&2; exit 2; }
[ "$(jq -r '.spec.template.spec.containers[0].name' <<<"$dep")" = workspace ] || { echo "refused: the first container of ws-$name is not \"workspace\"" >&2; exit 2; }

cur() { jq -r "$1 // \"-\"" <<<"$dep"; }
c=.spec.template.spec.containers[0].resources
now_cpu_req=$(cur "$c.requests.cpu"); now_mem_req=$(cur "$c.requests.memory"); now_cpu_lim=$(cur "$c.limits.cpu"); now_mem_lim=$(cur "$c.limits.memory")
new_cpu_req=${cpu_req:-$now_cpu_req}; new_mem_req=${mem_req:-$now_mem_req}; new_cpu_lim=${cpu_lim:-$now_cpu_lim}; new_mem_lim=${mem_lim:-$now_mem_lim}

# quantities in millicores and MiB, for the comparisons
J='def cpu: if endswith("m") then (.[:-1]|tonumber) else (tonumber*1000) end; def mem: if endswith("Gi") then (.[:-2]|tonumber*1024) elif endswith("Mi") then (.[:-2]|tonumber) elif endswith("Ki") then (.[:-2]|tonumber/1024) else (tonumber/1048576) end;'
milli() { jq -rn "$J \"$1\"|cpu"; }
mib() { jq -rn "$J \"$1\"|mem"; }
[ "$new_cpu_req" = - ] || [ "$new_cpu_lim" = - ] || [ "$(milli "$new_cpu_req")" -le "$(milli "$new_cpu_lim")" ] || { echo "refused: the CPU request $new_cpu_req is above the limit $new_cpu_lim" >&2; exit 2; }
[ "$new_mem_req" = - ] || [ "$new_mem_lim" = - ] || [ "$(mib "$new_mem_req")" -le "$(mib "$new_mem_lim")" ] || { echo "refused: the memory request $new_mem_req is above the limit $new_mem_lim" >&2; exit 2; }

printf 'ws-%s   cpu request %s -> %s, limit %s -> %s;  memory request %s -> %s, limit %s -> %s\n' "$name" "$now_cpu_req" "$new_cpu_req" "$now_cpu_lim" "$new_cpu_lim" "$now_mem_req" "$new_mem_req" "$now_mem_lim" "$new_mem_lim"

# fit: what the node holds without this workspace's pod, plus the new requests, must stay within what the node can allocate (the pod is
# recreated, so the old one is gone when the new one is scheduled)
node=$(kubectl -n "$ns" get pods -l "claudepilot.workspace=$name" -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null || true)
if [ -n "$node" ]; then
  alloc=$(kubectl get node "$node" -o json)
  pods=$(kubectl get pods -A -o json)
  read -r used_cpu used_mem < <(jq -r --arg node "$node" --arg ns "$ns" --arg name "$name" "$J"'
    [.items[] | select(.spec.nodeName==$node and (.status.phase=="Running" or .status.phase=="Pending"))
       | select((.metadata.namespace==$ns and (.metadata.labels["claudepilot.workspace"]==$name))|not)
       | .spec.containers[] | .resources.requests // {}] as $r
    | "\([$r[] | (.cpu // "0") | cpu] | add // 0) \([$r[] | (.memory // "0") | mem] | add // 0)"' <<<"$pods")
  read -r cap_cpu cap_mem < <(jq -r "$J"'"\(.status.allocatable.cpu|cpu) \(.status.allocatable.memory|mem)"' <<<"$alloc")
  want_cpu=0; [ "$new_cpu_req" = - ] || want_cpu=$(milli "$new_cpu_req")
  want_mem=0; [ "$new_mem_req" = - ] || want_mem=$(mib "$new_mem_req")
  used_cpu=${used_cpu%.*}; used_mem=${used_mem%.*}; cap_cpu=${cap_cpu%.*}; cap_mem=${cap_mem%.*}
  echo "fit on $node: the other pods request ${used_cpu}m and ${used_mem}Mi, this one would ask ${want_cpu}m and ${want_mem}Mi, the node can allocate ${cap_cpu}m and ${cap_mem}Mi"
  if [ $((used_cpu + want_cpu)) -gt "$cap_cpu" ] || [ $((used_mem + want_mem)) -gt "$cap_mem" ]; then
    echo "refused: it does not fit on $node (the pod would stay Pending). Ask for less, or free requests on that node first." >&2; exit 3
  fi
else
  echo "no running pod found for $name: the fit check is skipped"
fi

if [ "$apply" != 1 ]; then echo "dry run: nothing changed (add --apply; the pod restarts and every session in it ends)"; exit 0; fi

patch=$(jq -n --arg a "$(date -u +%FT%TZ)" --arg cr "$cpu_req" --arg mr "$mem_req" --arg cl "$cpu_lim" --arg ml "$mem_lim" '
  def pick($k; $v): if $v == "" then {} else {($k): $v} end;
  { metadata: { annotations: { "claudepilot.resources-changed": $a } },
    spec: { template: { spec: { containers: [ { name: "workspace", resources: {
      requests: (pick("cpu"; $cr) + pick("memory"; $mr)),
      limits: (pick("cpu"; $cl) + pick("memory"; $ml)) } } ] } } } }
  | .spec.template.spec.containers[0].resources |= with_entries(select(.value | length > 0))')
kubectl -n "$ns" patch deploy "ws-$name" --type=strategic -p "$patch"
echo "applied: the pod restarts now (Recreate); every session in it ends"
