#!/usr/bin/env bash
# Green gate results, one per commit, kept in the cluster as ConfigMaps (D-106): what the change-scoped gate (scripts/gate-select.mjs) reuses
# and diffs against. Only a GREEN verdict is ever written; a record holds no log, no secret, only facts.
#   scripts/gate-record.sh list                                 one line per record: `<commit40> <kind> <at> <base>`, newest first
#   scripts/gate-record.sh write <commit> <kind> [base] [steps] [files]
#                                                               kind: full (the whole gate), scoped (a scoped gate against <base>), reuse
#                                                               (green by the record of <base>: the trees differ only in documents)
# GATE_NAMESPACE (default isnan-claudepilot); GATE_RECORD_KEEP (default 200): older records are deleted after a write. A record that can not
# be read or written is never fatal for the caller: list prints nothing (the gate then runs in full), write warns.
# Trust: whoever can create ConfigMaps in the namespace can write a record, the same people who can run a gate Job there.
set -u
ns=${GATE_NAMESPACE:-isnan-claudepilot}
label=app=claudepilot-gate-result
case ${1:-} in
  list)
    kubectl -n "$ns" get configmaps -l "$label" -o jsonpath='{range .items[*]}{.data.commit} {.data.kind} {.data.at} {.data.base}{"\n"}{end}' 2>/dev/null |
      grep -E '^[0-9a-f]{40} (full|scoped|reuse) [0-9TZ:.-]+( [0-9a-f]{40})? *$' | sort -k3,3r || true
    ;;
  write)
    commit=${2:?commit} kind=${3:?kind} base=${4:-} steps=${5:-} files=${6:-}
    [[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "gate-record: a full commit id (got $commit)" >&2; exit 2; }
    [[ $kind =~ ^(full|scoped|reuse)$ ]] || { echo "gate-record: kind full, scoped or reuse" >&2; exit 2; }
    [ -z "$base" ] || [[ $base =~ ^[0-9a-f]{40}$ ]] || { echo "gate-record: base is a full commit id" >&2; exit 2; }
    tree=$(git rev-parse "$commit^{tree}" 2>/dev/null || true)
    name=claudepilot-gate-result-$commit
    kubectl -n "$ns" delete configmap "$name" --ignore-not-found >/dev/null 2>&1 || true
    if ! kubectl -n "$ns" create configmap "$name" --from-literal=commit="$commit" --from-literal=kind="$kind" --from-literal=base="$base" \
      --from-literal=tree="$tree" --from-literal=steps="$steps" --from-literal=files="$files" --from-literal=at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --from-literal=by="${GATE_JOB_BY:-manual}" >/dev/null 2>&1 ||
      ! kubectl -n "$ns" label configmap "$name" "$label" "claudepilot-gate-result/kind=$kind" --overwrite >/dev/null 2>&1; then
      echo "gate-record: WARNING: the green result of ${commit:0:8} could not be recorded (the next gate runs wider)" >&2
      exit 0
    fi
    echo "gate-record: green $kind gate of ${commit:0:8} recorded${base:+ (base ${base:0:8})}"
    keep=${GATE_RECORD_KEEP:-200}
    old=$(kubectl -n "$ns" get configmaps -l "$label" --sort-by=.metadata.creationTimestamp -o name 2>/dev/null | head -n "-$keep" || true)
    # shellcheck disable=SC2086 # one name per word
    [ -z "$old" ] || kubectl -n "$ns" delete $old >/dev/null 2>&1 || true
    ;;
  *) echo "usage: scripts/gate-record.sh list | write <commit> <kind> [base] [steps] [files]" >&2; exit 2 ;;
esac
