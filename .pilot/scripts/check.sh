#!/usr/bin/env bash
# The Check pipeline's step (.pilot/check.yml). A push that changes only documents (docs/, *.md, the context pack) ends at once, and so does
# a run whose commit is no longer the branch's head (the newer commit has its own run). Otherwise:
# on a runner (PILOT_RUNNER is set: the Mac), the gate runs here, in the run's clean clone (scripts/gate.sh, what the gate Job runs);
# in the repository's own workspace (the fallback), nothing heavy may run in the pod (D-61), so the gate goes to the cluster as one Job
# (scripts/gate-job.sh on this commit, which must be on GitHub: integration is).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
sha="${PILOT_SHA:?PILOT_SHA is not set: run this from the Check pipeline}"
base="${PILOT_BASE_SHA:-}"
if [ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then
  code=$(git diff --name-only "$base" "$sha" | grep -vE '^docs/|\.md$' || true)
  if [ -z "$code" ]; then
    echo "check: $(git diff --name-only "$base" "$sha" | wc -l) changed file(s), all documents: nothing to gate"
    exit 0
  fi
fi
# A newer commit on the branch gets its own run: this one ends at once, so runs never queue up behind a long gate (2026-10-15: nine waited).
branch="${PILOT_BRANCH:-integration}"
head=$(git ls-remote origin "refs/heads/$branch" 2>/dev/null | cut -c1-40 || true)
if [ -n "$head" ] && [ "$head" != "$sha" ]; then
  echo "check: superseded: $branch is at ${head:0:8} now, and that commit is checked by its own run"
  exit 0
fi
if [ -n "${PILOT_RUNNER:-}" ]; then
  echo "check: on the runner $PILOT_RUNNER: the gate at ${sha:0:8} runs here"
  exec bash scripts/gate.sh "$sha"
fi
# T-1609: a gate Job for this commit already exists in the cluster (the deploy's whole gate, or an earlier check): another one only waits in
# the shared Job queue for what that one checks (2026-10-18: #464, #466 and #470 each waited 30-40 min behind Konfersi Jobs for nothing).
# T-2167: the list is read whole first. `kubectl ... | grep -q` under pipefail read as "none" whenever grep matched an early line and quit
# before kubectl wrote the rest: kubectl's next write failed (SIGPIPE), so the pipeline failed and a second Job went to the queue anyway.
jobs=""
if command -v kubectl >/dev/null 2>&1; then jobs=$(kubectl -n "${GATE_NAMESPACE:-isnan-claudepilot}" get jobs -o name 2>/dev/null || true); fi
if grep -q "^job.batch/claudepilot-gate-${sha:0:7}-" <<<"$jobs"; then
  echo "check: a gate Job for ${sha:0:8} is already in the cluster (the deploy's or an earlier check's): nothing to add"
  exit 0
fi
# The cluster is shared and busy: here only typecheck, the web build and the web unit tests (the deploy runs the whole gate, the suite included).
echo "check: no runner free (or the hand-off failed): typecheck, web build and web tests at ${sha:0:8} go to the cluster as a Job"
exec bash scripts/gate-job.sh "$sha" typecheck,web-build,web-tests
