#!/usr/bin/env bash
# The Check pipeline's step (.pilot/check.yml). A push that changes only documents (docs/, *.md, the context pack) ends at once. Otherwise:
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
if [ -n "${PILOT_RUNNER:-}" ]; then
  echo "check: on the runner $PILOT_RUNNER: the gate at ${sha:0:8} runs here"
  exec bash scripts/gate.sh "$sha"
fi
echo "check: no runner free (or the hand-off failed): the gate at ${sha:0:8} goes to the cluster as a Job"
exec bash scripts/gate-job.sh "$sha"
