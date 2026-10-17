#!/usr/bin/env bash
# Scheduling helpers for job-run.sh and gate-job.sh (T-961). Sourced, never run. Each is a pure function of JSON, so a test feeds it fixtures.
#
# sched_preempted <pods-json>      prints "yes" when a pod of the list was preempted by the scheduler (a higher-priority pod, the portal, took
#                                  its node's room): condition DisruptionTarget=True with reason PreemptionByScheduler, or the pod's status reason
#                                  Preempted. Otherwise "no". A Job that was preempted did not fail on its own account: rerun it (D-75).
# sched_cpu_free_m <nodes-json> <pods-json> <node>
#                                  prints the CPU REQUESTS still free on the node, in millicores: allocatable minus the requests of its pods that
#                                  are not finished (a pod counts the larger of the sum of its containers and its biggest init container, as the
#                                  scheduler does). Prints "unknown" when the node or its allocatable is not in the list.
# sched_cpu_short <free-m> <need-m>   exit 0 when the node is SHORT: free is a number below need. "unknown" is never short (a failed reading must not
#                                  block every Job).

sched_preempted() {
  jq -r 'if ([.items[]? | select(
        ((.status.reason // "") == "Preempted")
        or any((.status.conditions // [])[]?; .type == "DisruptionTarget" and .status == "True" and (.reason // "") == "PreemptionByScheduler"))] | length) > 0
      then "yes" else "no" end' <<<"$1" 2>/dev/null || echo no
}

sched_cpu_free_m() {
  jq -r --arg node "$3" '
    def m: if . == null then 0 elif endswith("m") then (.[:-1] | tonumber) else ((tonumber) * 1000) end;
    def podreq: ([(.spec.containers // [])[] | .resources.requests.cpu | m] | add // 0) as $c
      | ([(.spec.initContainers // [])[] | .resources.requests.cpu | m] | max // 0) as $i
      | if $c > $i then $c else $i end;
    ([$nodes[0].items[]? | select(.metadata.name == $node) | .status.allocatable.cpu | select(. != null) | m] | first) as $alloc
    | if $alloc == null then "unknown"
      else ($alloc - ([$pods[0].items[]? | select(.spec.nodeName == $node and ((.status.phase // "") != "Succeeded") and ((.status.phase // "") != "Failed")) | podreq] | add // 0)) end' \
    --slurpfile nodes <(printf '%s' "$1") --slurpfile pods <(printf '%s' "$2") -n 2>/dev/null || echo unknown
}

# sched_fit <nodes-json> <pods-json> <node> <cpu-m> <mem-mi> [<portal-label-app>]
#                                  prints fits (the new pod's requests are free on the node now, with the old portal's pod gone: the Recreate
#                                  strategy stops it first), preempt (they are free once the pods of the class claudepilot-jobs are gone: the
#                                  portal's class preempts them), or no (neither; also when the node is not in the list). Conservative: other
#                                  pods are never counted as room, although the scheduler may preempt them too.
sched_fit() {
  jq -r --arg node "$3" --argjson cpu "$4" --argjson mem "$5" --arg app "${6:-claudepilot-portal}" '
    def cpum: if . == null then 0 elif endswith("m") then (.[:-1] | tonumber) else ((tonumber) * 1000) end;
    def memmi: if . == null then 0
      elif endswith("Ki") then ((.[:-2] | tonumber) / 1024)
      elif endswith("Mi") then (.[:-2] | tonumber)
      elif endswith("Gi") then ((.[:-2] | tonumber) * 1024)
      else ((tonumber) / 1048576) end;
    def req(f): ([(.spec.containers // [])[] | .resources.requests | f] | add // 0) as $c
      | ([(.spec.initContainers // [])[] | .resources.requests | f] | max // 0) as $i | if $c > $i then $c else $i end;
    def rc: req(.cpu | cpum);
    def rm: req(.memory | memmi);
    ([$nodes[0].items[]? | select(.metadata.name == $node) | .status.allocatable | select(. != null)] | first) as $a
    | if $a == null then "no"
      else
        [$pods[0].items[]? | select(.spec.nodeName == $node and ((.status.phase // "") != "Succeeded") and ((.status.phase // "") != "Failed")
            and ((.metadata.labels.app // "") != $app))] as $p
        | ($a.cpu | cpum) as $ac | ($a.memory | memmi) as $am
        | ($ac - ([$p[] | rc] | add // 0)) as $fc | ($am - ([$p[] | rm] | add // 0)) as $fm
        | ([$p[] | select((.spec.priorityClassName // "") == "claudepilot-jobs") | rc] | add // 0) as $jc
        | ([$p[] | select((.spec.priorityClassName // "") == "claudepilot-jobs") | rm] | add // 0) as $jm
        | if $fc >= $cpu and $fm >= $mem then "fits"
          elif ($fc + $jc) >= $cpu and ($fm + $jm) >= $mem then "preempt"
          else "no" end
      end' \
    --slurpfile nodes <(printf '%s' "$1") --slurpfile pods <(printf '%s' "$2") -n 2>/dev/null || echo no
}

sched_cpu_short() {
  [[ ${1:-} =~ ^-?[0-9]+$ ]] && [[ ${2:-} =~ ^[0-9]+$ ]] && [ "$1" -lt "$2" ]
}
