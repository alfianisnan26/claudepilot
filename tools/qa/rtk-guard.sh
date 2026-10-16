# shellcheck shell=bash
# T-736: the one guard of the rtk measurement scripts (rtk-history.sh, rtk-classes.sh, rtk-measure.sh). Sourced, not run.
# Those scripts rewrite tracked files and end with git reset / checkout, which would wipe uncommitted work. They run only
#   - in a job-run Job (the Job container exports JR_REPO_URL, nothing else does), and
#   - on a clean checkout: `git status --porcelain` succeeds and prints nothing (staged and untracked files count as dirty).
# Usage: rtk_guard <script name> <checkout folder>   (call it before anything is written, created or reset)
# Call it once for EVERY repo the script will reset or rewrite (rtk-measure.sh light claudepilot also rewrites its <repo-dir> argument).
# Fail closed: the caller must stop when this file cannot be sourced or does not define rtk_guard (each script checks both).
# Every git call uses -C <folder>, never the current directory.
rtk_guard() {
  local name=$1 root=$2 st
  [ -n "${JR_REPO_URL:-}" ] || { echo "$name: refusing: it rewrites the checkout; run it through scripts/job-run.sh (JR_REPO_URL not set)" >&2; exit 2; }
  # A failing git status (not a repo, corrupt index) prints nothing, which would read as clean: check the exit status.
  st=$(git -C "$root" status --porcelain 2>&1) || { echo "$name: refusing: git status failed in $root (not a clean, readable checkout)" >&2; exit 2; }
  [ -z "$st" ] || { echo "$name: refusing: the checkout has uncommitted changes" >&2; exit 2; }
}
