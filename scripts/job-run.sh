#!/usr/bin/env bash
# Heavy agent work as a Job in the cluster, not in the development pod (T-107): a test file, the suite, tsc, a build, playwright, lighthouse,
# a wrangler dry run. The code is a PUSHED branch or commit (ClaudePilot from GitHub, a Konfersi repository from Gitea), cloned into memory on
# a node without a workspace pod (deploy/k3s-build/job-run.yaml), `npm ci`, then the command. The log streams back, the exit code is the
# command's, artifacts come back to a folder you name.
#   scripts/job-run.sh [options] -- <command>          one argument: a shell command line; several: the words of one command
#     --repo claudepilot | event | konfersi[:<org>/<repo>]
#                                                       default: from the current folder's origin (konfersi alone: the folder's Gitea repo).
#                                                       event (T-491) is exactly GitHub isnanme/event, nothing else: no event:<org>/<repo>;
#                                                       it gets the same GitHub token as claudepilot (npm for @isnanme, and the clone). Git offers it
#                                                       for that one URL only; --also is refused with it. As in every Job (T-401), the token is
#                                                       in the fetch container alone, never in the command's environment or files
#     --ref <branch or commit>                          default: HEAD of the current folder, which must be on the remote (push it first:
#                                                       git push origin HEAD:wip/<name>); uncommitted changes are NOT in the Job
#     --against <ref>                                   PROOF (T-333): run the command on --ref, then on <ref> in the same Job (a full commit hash or
#                                                       branch; the parent of a fix: git rev-parse <fix>~1). npm ci again only when the lockfile
#                                                       differs. Prints "PROOF: passes on <ref>, fails on <against>" (exit 0) or "NO PROOF: <why>"
#                                                       (exit 1; 2 when <ref> or a kept path is missing). Without it nothing changes.
#     --keep-tests <paths>                              with --against: these files (comma separated) are taken from --ref onto the other ref
#     --also <org>/<repo>[@<ref>]                     one more repository cloned next to it (Konfersi's file:../konfersi-shared), ref stg
#     --steps npm-ci|none                               before the command (default npm-ci, at the root of the repository and of each --also clone that has a package-lock.json)
#     --image <ref>                                     (T-379) the COMMAND container's image, for a test stage the workspace image lacks (Python, pytest):
#                                                       registry.int.isnan.me/claudepilot|konfersi|event/<path>, as built by scripts/image-build.sh,
#                                                       pinned by :<tag> (not :latest) or @sha256:<digest>; anything else is refused before any kubectl call. The fetch
#                                                       container (the only one with credentials) keeps the workspace image. The image may have no
#                                                       node, npm or git: the npm steps are skipped (--steps npm-ci is refused) and --against is refused
#     --artifacts <paths>  --out <dir>                  files in the repository (comma separated) copied back into <dir> (default
#                                                       ./job-run-artifacts/<job>); at most JOB_RUN_ARTIFACT_MAX bytes compressed (4 MiB)
#     --timeout <s>                                     the Job's deadline once it runs (default 3600, at most 5400)
#     --role <label>                                    shown on the Job (default PILOT_AGENT or "agent"); the chat is PILOT_SESSION_ID
#     --reuse                                           return the saved result of the same repo, full commit and command that already passed, with no Job;
#                                                       a pass is saved only with it (T-731, see "Reuse" below). Without it every run is a Job.
#     --big                                             8Gi of memory instead of 4Gi (T-524; /tmp 4Gi instead of 2Gi), for a run that was OOMKilled;
#                                                       only k3s-node2 has room for it. Memory is requested = limited: the scheduler places a Job
#                                                       only where it fits, says why it is Pending, and an OOMKilled Job says so with its limit.
#     --pool-env <NAME>                               (repeatable, T-426) a scoped test credential from this workspace's Secrets pool for the
#                                                       command (Konfersi's stg e2e: Cloudflare Access, the QA test account). Only E2E_CF_ACCESS_*,
#                                                       E2E_QA_EMAIL and E2E_QA_PASSWORD (T-384), set here; the
#                                                       value goes on stdin into the Job's Secret (deleted with the Job), the command's container
#                                                       gets it as env by secretKeyRef (fetch does not), and the log is masked for it. Values under 8
#                                                       characters are refused (the mask skips them); an --out file that holds a value, and any
#                                                       compressed file (*.zip, *.gz, a trace.zip: it cannot be checked), is deleted (rc 3); the messages name a file with a masked,
#                                                       sanitized name (a-z A-Z 0-9 . _ / - only) and a count. --out must be new or empty (rc 2 before
#                                                       anything runs): a failed scan wipes its contents. A command
#                                                       that holds a value is refused: single-quote the variable ('$E2E_CF_ACCESS_CLIENT_SECRET'),
#                                                       so the Job expands it, not your shell
# Placement (T-611): the scheduler counts memory REQUESTS, the master (control plane, Argo CD, Gitea...) uses far more for real. Before it creates a
# Job this script reads the master's real memory (kubectl top nodes) and, when that use PLUS the Job's expected peak (JOB_RUN_EXPECTED_PEAK_MI,
# default 2300 Mi; 8192 Mi for --big) is over JOB_RUN_MASTER_MAX_PCT (default 85; 75 until 2026-10-17, T-731: the master sat at 67% with 13% CPU while every Job queued for node2's CPU
# requests, so one normal Job may use the master: 67% + 2300 Mi is about 82%), makes the Job's rule away from the control plane REQUIRED: it
# waits for k3s-node2 or for room. Under the line, or when the metrics fail, the preferred rules stay. The decision, the wait and the node go
# into the Job's log as "=== JOB-RUN PLACEMENT" lines. T-524: it reads again when the queue lets the suspended Job out.
# Reuse (T-731), OPT-IN with --reuse: a run with it that PASSED (exit 0) is saved, masked log, exit code and the Job's name, under JOB_RUN_CACHE_DIR
# (default ~/.cache/claudepilot-job-run, one workspace home: any session there can write an entry). A later --reuse run with the same repo URL, FULL
# commit, exact command, --against, --keep-tests, --also, --steps, --big and runner image, on the same job-run.sh and job-run.yaml (their hash is in
# the key), returns that log and exit code at once with no Job, naming the Job that passed. Not reused: a ref that is not a full 40-hex commit (a
# branch moves), an --also or --against ref that is not one, a run with --artifacts, and a run with --pool-env (refused together with --reuse, rc 2:
# a pass without a credential must never stand for a run with it, and a log made with a credential is never saved). A failure is never saved. A
# result older than JOB_RUN_REUSE_MAX_AGE_DAYS (7) is a miss. A reused log is the saved one, as it was: its PLACEMENT lines name the node of the
# run that passed, and a hit makes no kubectl call (no placement, no Secret, no Job). The key and the store: docs/prd/local-git-ci.md section 24.
#   scripts/job-run.sh --list                           the Jobs, their chat, role and state
#   scripts/job-run.sh --stop [<job> | --chat <id>]     stop Jobs (all, one, or a chat's) and delete their Secrets
# Caps: JOB_RUN_MAX Jobs at once cluster-wide (default 12 since D-96, 2026-10-23; 8 before; 3 until T-1624, when k3s-node3 joined and the master and node3 had room for
# about 6 more 4Gi Jobs while Konfersi Jobs queued a median 6 min to run 5-60 s), JOB_RUN_MAX_PER_CHAT per chat (2) and JOB_RUN_MAX_PER_PROGRAM per program (9 since D-96; 6, was 2;
# claudepilot, event, konfersi: T-524). A Job over a cap is created suspended and waits its turn (creation order), with "queued behind K". The Job stops when this script is interrupted or killed (the next run removes a Job whose
# script is gone), and when the chat ends (the Claude process, CLAUDE_PID or JOB_RUN_WATCH_PID, exits).
# A failed `npm ci` in the Job is tried once more (it says so in the log). Exit 0 of a proof means the proof held, not only the command.
# Credentials (the npm token for GitHub Packages, Gitea's from git's credential helper) go to kubectl on stdin into a Secret that belongs to
# the Job and is deleted on exit; they are never on a command line, and the streamed log is masked for them. Only the Job's init container
# `fetch` reads that Secret (T-401): it clones and runs `npm ci --ignore-scripts`, and no code of the repository or a dependency runs there;
# the install scripts and the command run in the `run` container, which has no git or npm credential in its environment, git config or files, and gets
# only the --pool-env values (T-426) as env. They are kept out of the environment of npm rebuild and the lifecycle scripts, but a lifecycle script of the same user can still read /proc/<ppid>/environ (the shell's start-up environment); the real boundary is that only test credentials may go in (E2E_CF_ACCESS_*, and the stg QA test account's E2E_QA_EMAIL and E2E_QA_PASSWORD, T-384). The raw
# log in the cluster is unmasked until the Job is cleaned up (TTL); only the streamed copy is masked. The whole log: JOB_RUN_LOG
# (default /tmp/job-run-<job>.log). Exit: the command's code; 1 when the Job did not finish, 2 for a usage error, 124 past the deadline.
set -eu
# Under xtrace (bash -x, SHELLOPTS) the trace would print the credentials this script handles: refuse (T-426).
case $- in *x*) echo "job-run: refuses to run under xtrace (set -x / bash -x would print the credentials)" >&2; exit 2 ;; esac
here=$(cd "$(dirname "$0")/.." && pwd)
ns=${JOB_RUN_NAMESPACE:-isnan-claudepilot}; registry=${DEPLOY_REGISTRY:-registry.int.isnan.me}
max=${JOB_RUN_MAX:-12}; per=${JOB_RUN_MAX_PER_CHAT:-2}; pprog=${JOB_RUN_MAX_PER_PROGRAM:-9}; poll=${JOB_RUN_POLL_S:-5}
queue_wait=${JOB_RUN_QUEUE_WAIT_S:-3600}; start_wait=${JOB_RUN_START_WAIT_S:-900}; art_max=${JOB_RUN_ARTIFACT_MAX:-4194304}
gitea=${JOB_RUN_GITEA:-git.konfersi.com}; github_repo=${JOB_RUN_GITHUB_REPO:-alfianisnan26/claudepilot}
event_repo=isnanme/event # fixed on purpose (T-491): the door names one repository, no override
# Memory per Job (T-524), request = limit, sized from measured cgroup peaks (docs/dev-session.md, "Heavy agent work in the cluster"); fixed here,
# no environment override: the size is a cluster decision, not a caller's.
# T-731: 518 measured peaks: median 1133Mi, p90 1971Mi, p99 2270Mi, max 2536Mi, none OOMKilled. D-96 (owner, 2026-10-23, "up to 2-5x speed"):
# 3Gi, measured 02:40 UTC with k3s-master and k3s-node2 at 95% CPU and k3s-node3 at 20% CPU (33% of its CPU requested) but memory-bound at 4Gi,
# so Jobs piled on the two busy nodes. 3Gi keeps ~500Mi over the largest peak; --big (8Gi) stays the answer to an OOMKill.
mem_std=3Gi; tmp_std=2Gi; mem_big=8Gi; tmp_big=4Gi
master_max=${JOB_RUN_MASTER_MAX_PCT:-85}
die() { echo "job-run: $*" >&2; exit 2; }
for n in "$max" "$per" "$pprog" "$art_max"; do [[ $n =~ ^[0-9]+$ ]] || die "the caps are numbers"; done
# The placement numbers are used in $(( )): at most 3 / 6 digits (no wrap-around to a negative), and base 10 (a leading 08 is not octal) (T-611 C1 C2).
[[ $master_max =~ ^[0-9]{1,3}$ ]] || die "JOB_RUN_MASTER_MAX_PCT is a percentage (at most 3 digits)"
master_max=$((10#$master_max))
# T-611 S2: nodes a Job may never run on (a comma list of node names). The names go into JSON: the shape is checked, nothing else passes.
# T-1643 (owner, 2026-10-19: "pindahin ci dari node1 ke node3"): unset means k3s-master, the only control plane (API server, Argo CD); with
# k3s-node3 in the worker pool the required rule no longer leaves every Job Pending (the T-365/T-524 reason for none). Set it empty to allow the master.
# Then (owner, 2026-10-19 15:4x UTC, after the maintenance: "help answer the decisions ... handle the operations fully"): every node is
# control-plane now, and with the master avoided the two workers' memory requests filled (gates Pending "Insufficient memory"), so the
# default is none again: the master takes a Job when the preferred rules and the 85% guard allow it. Set k3s-master to keep it off.
JOB_RUN_AVOID_NODES=${JOB_RUN_AVOID_NODES-}
avoid_json=; avoid_txt=
if [ -n "$JOB_RUN_AVOID_NODES" ]; then
  # The raw value is never echoed (a newline in it could forge a "=== JOB-RUN" line): the checks below say what is wrong, and the messages and
  # log lines carry the validated, joined list (avoid_txt). A newline is refused, not cut (read -a keeps only the first line); ASCII is checked
  # under LC_ALL=C, so the name regex below only ever sees ASCII.
  [[ $JOB_RUN_AVOID_NODES != *$'\n'* && $JOB_RUN_AVOID_NODES != *$'\r'* ]] || die "JOB_RUN_AVOID_NODES must be one line (no newline)"
  ! printf '%s' "$JOB_RUN_AVOID_NODES" | LC_ALL=C grep -q '[^ -~]' || die "JOB_RUN_AVOID_NODES is a comma list of node names (ASCII letters, digits, . and -)"
  [[ $JOB_RUN_AVOID_NODES != *, ]] || die "JOB_RUN_AVOID_NODES is a comma list of node names (no trailing comma)" # read -a would drop the empty last name silently
  IFS=, read -r -a avoid_list <<<"$JOB_RUN_AVOID_NODES"
  [ "${#avoid_list[@]}" -le 20 ] || die "JOB_RUN_AVOID_NODES lists at most 20 node names"
  for n in "${avoid_list[@]}"; do
    [[ $n =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || die "JOB_RUN_AVOID_NODES is a comma list of node names (letters, digits, . and -)"
    avoid_json="${avoid_json:+$avoid_json,}\"$n\""; avoid_txt="${avoid_txt:+$avoid_txt,}$n"
  done
fi
label() { local v; v=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9.-' '-' | cut -c1-63 | sed -E 's/^[^a-z0-9]+//; s/[^a-z0-9]+$//'); printf '%s' "${v:-none}"; }
jobs_json() { kubectl -n "$ns" get jobs -l app=claudepilot-job-run -o json 2>/dev/null; }
stop_one() {
  kubectl -n "$ns" delete job "$1" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl -n "$ns" delete secret "$1" --ignore-not-found >/dev/null 2>&1 || true
}
JQ_FIN='def fin: ([(.status.conditions // [])[] | select((.type == "Complete" or .type == "Failed") and .status == "True")] | length > 0) or ((.status.succeeded // 0) > 0) or ((.status.failed // 0) > 0);'

case "${1:-}" in
  --list)
    jobs_json | jq -r "$JQ_FIN"' .items[] | [.metadata.name, (.metadata.labels["job-run/chat"] // "-"), (.metadata.labels["job-run/role"] // "-"),
      (if fin then (if (.status.succeeded // 0) > 0 then "succeeded" else "failed" end) elif .spec.suspend then "queued" else "running" end),
      .metadata.creationTimestamp] | @tsv' | grep . || echo "no job-run jobs"
    exit 0 ;;
  --stop)
    sel=; chat=
    if [ "${2:-}" = --chat ]; then chat=$(label "${3:?usage: job-run.sh --stop --chat <id>}"); else sel=${2:-}; fi
    [ -z "$sel" ] || [[ $sel =~ ^claudepilot-job-[0-9a-f]{8}$ ]] || die "usage: job-run.sh --stop [claudepilot-job-<hex> | --chat <id>]"
    n=0
    for name in $(jobs_json | jq -r --arg c "$chat" '.items[] | select($c == "" or .metadata.labels["job-run/chat"] == $c) | .metadata.name' | grep -E '^claudepilot-job-[0-9a-f]{8}$' || true); do
      [ -z "$sel" ] || [ "$name" = "$sel" ] || continue
      stop_one "$name"; echo "stopped $name"; n=$((n + 1))
    done
    echo "$n job(s) stopped"; exit 0 ;;
esac

repo=; ref=; against=; keep=; steps=npm-ci; steps_given=; artifacts=; out=; timeout=3600; role=${PILOT_AGENT:-agent}; also=(); big=; pool=(); reuse=; run_image=; image_given=
while [ $# -gt 0 ]; do
  case "$1" in
    --repo|--ref|--against|--keep-tests|--also|--steps|--artifacts|--out|--timeout|--role|--pool-env|--image) [ $# -ge 2 ] || die "$1 needs a value" ;;&
    --pool-env) pool+=("$2"); shift 2 ;;
    --image) run_image=$2; image_given=1; shift 2 ;;
    --big) big=1; shift ;;
    --reuse) reuse=1; shift ;;
    --repo) repo=$2; shift 2 ;;
    --ref) ref=$2; shift 2 ;;
    --against) against=$2; shift 2 ;;
    --keep-tests) keep=${2//,/ }; shift 2 ;;
    --also) also+=("$2"); shift 2 ;;
    --steps) steps=$2; steps_given=1; shift 2 ;;
    --artifacts) artifacts=${2//,/ }; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --timeout) timeout=$2; shift 2 ;;
    --role) role=$2; shift 2 ;;
    --) shift; break ;;
    # T-426: an argument is echoed only when it is a plain option name; anything else (--pool-env=<value>, a stray value after --pool-env NAME)
    # may be a pasted secret.
    *) if [[ $1 =~ ^--[a-z-]+$ ]]; then die "unknown option $1 (see the top of scripts/job-run.sh)"; else die "unknown option (the argument is not shown; see the top of scripts/job-run.sh)"; fi ;;
  esac
done
[ $# -gt 0 ] || die "usage: scripts/job-run.sh [--repo ...] [--ref ...] -- <command>"
if [ $# -eq 1 ]; then cmd=$1; else cmd=$(printf '%q ' "$@"); fi
[[ $steps =~ ^(npm-ci|none)$ ]] || die "--steps: npm-ci or none"
# --image (T-379): the command container's image, from the internal registry only, under the paths scripts/image-build.sh pushes to
# (claudepilot/, konfersi/ and event/, the three programs), pinned by a tag or a sha256 digest. Checked here, before any kubectl call. The fetch container (the only one
# with the credentials) keeps the workspace image; the command's image never sees them.
if [ -n "$image_given" ]; then
  # The host is the literal constant, never $registry (DEPLOY_REGISTRY could widen the allow-list).
  img_re="^registry\\.int\\.isnan\\.me/(claudepilot|konfersi|event)/[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})\$"
  [[ $run_image =~ $img_re && $run_image != *:latest ]] || die "--image: an image on registry.int.isnan.me under claudepilot/, konfersi/ or event/ (as built by scripts/image-build.sh), pinned by a :tag (not :latest) or @sha256:<digest> (got $run_image)"
  # No node, npm or git is assumed in a foreign image: the npm steps are skipped, and the proof (it needs git in the command container) is refused.
  [ -z "$steps_given" ] || [ "$steps" = none ] || die "--image: the image may have no node or npm; use --steps none (or leave --steps out)"
  [ -z "$against" ] || die "--image cannot be used with --against (the proof needs git in the command container)"
  steps=none; echo "job-run: note: --image given: the npm steps are skipped (the image may have no node)" >&2
fi
{ [[ $timeout =~ ^[0-9]+$ ]] && [ "$timeout" -ge 60 ] && [ "$timeout" -le 5400 ]; } || die "--timeout: 60 to 5400 seconds"
for a in $artifacts; do [[ $a =~ ^[A-Za-z0-9_.][A-Za-z0-9_./*-]*$ && ! $a =~ (^|/)\.\.(/|$) ]] || die "--artifacts: paths inside the repository (got $a)"; done
[[ -z $against || ( $against =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ && ! $against =~ \.\. ) ]] || die "--against: a branch or commit name (got $against)"
[ -z "$keep" ] || [ -n "$against" ] || die "--keep-tests needs --against"
# A leading dot is a path too (.pilot/tests/x.py: T-960, 2026-10-17, no test under .pilot/ could be proved); never `..`, `.` or `./` alone.
for a in $keep; do [[ $a =~ ^[A-Za-z0-9_.][A-Za-z0-9_./-]*$ && ! $a =~ (^|/)\.\.(/|$) && ! $a =~ ^\.(/)?$ ]] || die "--keep-tests: file paths inside the repository (got $a)"; done
# --pool-env (T-426): the scoped test credentials of the Secrets pool, by NAME, for the command. Checked here, before any kubectl call.
# Only E2E_CF_ACCESS_* names, and the stg QA test account's two (E2E_QA_EMAIL, E2E_QA_PASSWORD: T-384, coordinator decision 2026-10-17
# #9575; a test account on stg, never a person's). The --pool-env name check and the unknown-option branch never echo what they refuse (it may be a secret value
# pasted by mistake, and a value can look like a name): the message says only that it was refused and why. Other options' messages still show
# their own value (--ref, --repo ... "got X"): never paste a value into any option. Values under 8 characters are refused: the log mask skips them.
pool_names=
for n in ${pool[@]+"${pool[@]}"}; do
  # T-1665: the second stg QA test account (E2E_QA2_*) for two-user checks, a test account like E2E_QA_*.
  [[ $n =~ ^E2E_CF_ACCESS_[A-Z0-9_]+$ || $n =~ ^E2E_QA2?_(EMAIL|PASSWORD)$ ]] || die "--pool-env: refused: not an allowed name (E2E_CF_ACCESS_*, E2E_QA_EMAIL, E2E_QA_PASSWORD, E2E_QA2_EMAIL, E2E_QA2_PASSWORD); the argument is not shown"
  [ -n "${!n:-}" ] || die "--pool-env: $n is not set in this workspace (the Secrets pool delivers it)"
  [[ ${!n} != *[$'\n\r']* ]] || die "--pool-env: $n holds a line break; refused"
  # Printable ASCII only (kubectl's env-file parser fails on other bytes and may then print the line).
  ! printf '%s' "${!n}" | LC_ALL=C grep -q '[^ -~]' || die "--pool-env: $n holds a character that is not printable ASCII; refused"
  v=${!n}; [ "${#v}" -ge 8 ] || die "--pool-env: $n is shorter than 8 characters: the log mask would not hide it; refused"; unset v
  [[ " $pool_names " == *" $n "* ]] || pool_names="$pool_names $n"
done
pool_names=${pool_names# }
# A command that holds a value was expanded in THIS shell (a double-quoted "$E2E_CF_ACCESS_CLIENT_SECRET"): it would go into the Job's spec
# and sed's argv. Refused (the name is shown, never the value). Single-quote the variable so it expands in the Job.
for n in $pool_names; do
  for w in "$cmd" "$@"; do
    [[ $w != *"${!n}"* ]] || die "--pool-env: the command holds the value of $n (your shell expanded it); single-quote the variable, '\$$n', so it expands in the Job; refused"
  done
done

# S1h N3 (review 7773): with --pool-env a failed or hit scan wipes the folder's contents, so --out must be fresh: a folder that holds anything
# (or a file) is refused here, before any kubectl call, in one line that does not show the path. Without --pool-env nothing is deleted.
if [ -n "$pool_names" ] && [ -n "$out" ] && { [ -e "$out" ] || [ -L "$out" ]; }; then
  { [ -d "$out" ] && [ -z "$(ls -A -- "$out" 2>/dev/null)" ]; } || die "--out: with --pool-env the folder must be new or empty (a failed scan deletes its contents); refused"
fi

# The repository: named, or the current folder's origin (its user and password part never kept or shown).
origin=$(git remote get-url origin 2>/dev/null | sed -E 's#^(https?://)[^@/]*@#\1#' || true)
from_origin() {
  case "$origin" in
    *github.com[:/]"$github_repo"|*github.com[:/]"$github_repo".git) echo claudepilot ;;
    *github.com[:/]"$event_repo"|*github.com[:/]"$event_repo".git) echo event ;;
    *"$gitea"/*) echo "konfersi:$(printf '%s' "${origin#*"$gitea"/}" | sed 's/\.git$//')" ;;
  esac
}
[ -n "$repo" ] || repo=$(from_origin)
[ -n "$repo" ] || die "--repo: claudepilot, event or konfersi:<org>/<repo> (the current folder's origin is none of them)"
if [ "$repo" = konfersi ]; then repo=$(from_origin); [[ $repo == konfersi:* ]] || die "--repo konfersi: the current folder is not a Gitea checkout; name it, konfersi:<org>/<repo>"; fi
case "$repo" in
  claudepilot) kind=github; url=https://github.com/$github_repo.git; repo_label=claudepilot ;;
  event) kind=github; url=https://github.com/$event_repo.git; repo_label=event ;;
  konfersi:*)
    path=${repo#konfersi:}
    [[ $path =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo konfersi:<org>/<repo> (got $repo)"
    kind=gitea; url=https://$gitea/$path.git; repo_label=$(label "${path#*/}") ;;
  *) die "--repo: claudepilot, event or konfersi:<org>/<repo>" ;;
esac
# The program a Job counts against (T-524): ClaudePilot, Event, or Konfersi (every konfersi:<org>/<repo>).
case "$repo" in claudepilot|event) program=$repo ;; *) program=konfersi ;; esac
# Memory (T-524): request = limit, so the scheduler places only what the node can hold; /tmp's in-memory sizeLimit fits inside it.
if [ -n "$big" ]; then memory=$mem_big; tmp_size=$tmp_big; else memory=$mem_std; tmp_size=$tmp_std; fi
[ "$repo" != event ] || [ ${#also[@]} -eq 0 ] || die "--also cannot be used with --repo event (T-491: the Event Job's token is for isnanme/event alone)"
alsos=
for a in ${also[@]+"${also[@]}"}; do
  [[ ! $a =~ \.\. && $a =~ ^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(@([A-Za-z0-9][A-Za-z0-9._/-]{0,199}))?$ ]] || die "--also <org>/<repo>[@<ref>] (got $a)"
  p=${BASH_REMATCH[1]}; r=${BASH_REMATCH[3]:-stg}
  if [ "$kind" = gitea ]; then base=https://$gitea; else base=https://github.com; fi
  alsos="$alsos ${p#*/}=$base/$p.git@$r"
done
alsos=${alsos# }
# The ref: given, or HEAD of the current folder, which must be on the remote.
if [ -z "$ref" ]; then
  { [ -n "$origin" ] && [ "$(from_origin)" = "$repo" ]; } || die "--ref: the current folder is not a checkout of $repo; name the branch or commit"
  ref=$(git rev-parse HEAD)
  git branch -r --contains "$ref" 2>/dev/null | grep -q . || die "HEAD (${ref:0:7}) is not on the remote: push it first (git push origin HEAD:wip/<name>)"
  [ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] || echo "job-run: note: uncommitted changes are not in the Job (it runs ${ref:0:7})" >&2
fi
[[ $ref =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ && ! $ref =~ \.\. ]] || die "--ref: a branch or commit name (got $ref)"
chat=$(label "${PILOT_SESSION_ID:-manual}"); role=$(label "$role")

image=${JOB_RUN_IMAGE:-}
if [ -z "$image" ]; then
  # T-1982: the registry directly (the pod, a host whose DNS knows it); when that fails (the coordinator's Mac devcontainer: "Could not resolve
  # host"), the cluster answers through kubectl's own route (its SOCKS tunnel there): the API server proxies the registry's in-cluster service,
  # so this host needs neither its DNS nor a route to it. The fallback is for the internal registry only (DEPLOY_REGISTRY unset or the same).
  tags=$(curl -fsS --connect-timeout 10 -m 30 "https://$registry/v2/claudepilot/workspace/tags/list" 2>/dev/null) || tags=
  if [ -z "$tags" ] && [ "$registry" = registry.int.isnan.me ]; then
    echo "job-run: $registry did not answer from here: asking the cluster for the workspace image" >&2
    tags=$(kubectl get --raw /api/v1/namespaces/isnan-registry/services/registry:5000/proxy/v2/claudepilot/workspace/tags/list 2>/dev/null) || tags=
  fi
  tag=$(printf '%s' "$tags" | jq -r '.tags[]? | select(test("-dev-"))' 2>/dev/null | sort -V | tail -n 1) || tag=
  [ -n "$tag" ] || { echo "job-run: no development workspace image in $registry: set JOB_RUN_IMAGE" >&2; exit 1; }
  image=$registry/claudepilot/workspace:$tag
fi
[[ $image =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || die "JOB_RUN_IMAGE: an image reference"

# Reuse (T-731), only with --reuse (every other run is a Job and neither reads nor writes the store): the same repository, full commit and command
# that already passed on this runner returns its saved log and exit code, no Job. Only exact inputs make a key: a full 40-hex commit for the ref,
# for --against and for every --also ref (a branch or "stg" moves), and no --artifacts (the files are not saved). The key holds the hash of this
# script and of the YAML, the resolved runner image and --big, so a change to the runner is a miss.
hex40='^[0-9a-f]{40}$'; reuse_days=${JOB_RUN_REUSE_MAX_AGE_DAYS:-7}; key=; cache=
if [ -n "$reuse" ]; then
  # T-611 (QA UI 8207, items 2 and 4): a pass without a credential must never stand for a run with it, and a log made with one is never saved.
  # Refused after every --pool-env check above (a bad name still dies there first, without showing the argument) and before any kubectl call.
  [ -z "$pool_names" ] || die "--reuse cannot be used with --pool-env (a reused pass would not have run with the credential, and nothing made with one is saved)"
  cache=${JOB_RUN_CACHE_DIR:-${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}/claudepilot-job-run}
  [[ $reuse_days =~ ^[0-9]+$ ]] || die "JOB_RUN_REUSE_MAX_AGE_DAYS is a number"
  # The store is cleaned and written in: never a folder that holds something else.
  cache_real=$(realpath -m -- "$cache")
  for bad in / "${HOME:-/}" "$here"; do [ "$cache_real" != "$(realpath -m -- "$bad")" ] || die "JOB_RUN_CACHE_DIR must be a folder of its own (not $bad)"; done
  if [[ $ref =~ $hex40 && -z $artifacts ]] && [[ -z $against || $against =~ $hex40 ]]; then
    exact=1
    for a in ${also[@]+"${also[@]}"}; do [[ ${a##*@} != "$a" && ${a##*@} =~ $hex40 ]] || exact=; done
    if [ -n "$exact" ]; then
      key=$({ printf '%s\0' v2 "$(cat "$0" "$here/deploy/k3s-build/job-run.yaml" | sha256sum | cut -d' ' -f1)" "$image" "${big:+big}" "$url" "$ref" "$cmd" "$against" "$keep" "$steps" "$alsos"; } | sha256sum | cut -d' ' -f1)
    fi
  fi
  [ -n "$key" ] || echo "job-run: --reuse: this run has no exact key (a full commit is needed for --ref, --against and --also; no --artifacts): it runs as a Job and is not saved" >&2
fi
if [ -n "$key" ] && [ -s "$cache/$key.log" ] && [ "$(cat "$cache/$key.rc" 2>/dev/null)" = 0 ] \
   && [ -n "$(find "$cache/$key.log" -mmin "-$((reuse_days * 1440))" 2>/dev/null)" ]; then
  read -r from_job from_at 2>/dev/null < "$cache/$key.job" || { from_job=unknown; from_at=unknown; }
  echo "job-run: reused a passed result for $repo@${ref:0:12} from Job ${from_job:-unknown} (passed ${from_at:-unknown}, key ${key:0:12}); drop --reuse to run it again"
  cat "$cache/$key.log"
  [ -n "${JOB_RUN_LOG:-}" ] && cp "$cache/$key.log" "$JOB_RUN_LOG"
  exit 0
fi

# Who owns a Job: this host, this script's PID and its start time. A Job whose script is gone (killed before its trap ran) is removed here.
starttime() { sed -E 's/.*\) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20; }
host=$(hostname)
reap() {
  local name owner pid start
  jobs_json | jq -r "$JQ_FIN"' .items[] | select(fin | not) | [.metadata.name, (.metadata.annotations["job-run/owner"] // "")] | @tsv' 2>/dev/null |
  while IFS=$'\t' read -r name owner; do
    [[ $name =~ ^claudepilot-job-[0-9a-f]{8}$ && $owner == "$host"/* ]] || continue
    pid=$(cut -d/ -f2 <<<"$owner"); start=$(cut -d/ -f3 <<<"$owner")
    [ -n "$pid" ] && [ "$(starttime "$pid")" = "$start" ] && continue
    stop_one "$name"; echo "job-run: removed $name (its job-run.sh is gone)" >&2
  done
}
reap || true

job=claudepilot-job-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
log=${JOB_RUN_LOG:-/tmp/job-run-$job.log}; [ -n "$out" ] || out=./job-run-artifacts/$job
[[ $out != -* ]] || out=./$out # a name that starts with a dash is a path, never an option of mkdir, find or grep
work=$(mktemp -d "${TMPDIR:-/tmp}/cp-job-run-XXXXXX")
: > "$log" # from here the placement lines go into it too (T-611)
phase=setup; wd=
# shellcheck disable=SC2317 # called by the traps
on_exit() {
  [ -z "$wd" ] || kill "$wd" 2>/dev/null || true
  if [ "$phase" = finished ]; then kubectl -n "$ns" delete secret "$job" --ignore-not-found >/dev/null 2>&1 || true; else stop_one "$job"; fi
  rm -rf "$work"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

# Placement (T-611): the control-plane node's real memory (working set against allocatable, from the metrics API). Over the line: a REQUIRED rule
# away from it. A failed or odd reading keeps the preferred rules alone: the metrics must never block every Job.
# Headroom: the Job adds up to its expected peak to the master's use, so the test is on use PLUS that peak (use * pct / used = allocatable, so
# no new verb). The peak: JOB_RUN_EXPECTED_PEAK_MI (default 2300, the measured p99 of Job cgroup peaks, 2270 Mi, T-731 note; the largest in 847
# runs is under 3000 Mi) for a normal Job; for --big (a rerun after an OOM kill, the peak is unknown) its whole limit. If the bytes column is odd,
# the old test on the percentage alone stays. Every number goes into $(( )) in base 10 (10#: a reading of 08 is not octal) and is bounded in
# digits (no wrap-around to a negative that would let the Job on the master).
plog() { echo "$*"; echo "$*" >> "$log"; } # a line that goes to the caller and into the Job's log, where a later diagnosis finds it
if [ -n "$big" ]; then peak_mi=8192; else peak_mi=${JOB_RUN_EXPECTED_PEAK_MI:-2300}; fi
[[ $peak_mi =~ ^[0-9]{1,6}$ ]] || die "JOB_RUN_EXPECTED_PEAK_MI is a number of Mi (at most 6 digits)"
peak_mi=$((10#$peak_mi))
# The decision is a function: it is made at creation and made again just before the Job is released from the queue (C5: the Job may wait
# suspended for minutes, and the master moves). It sets master_known (a usable reading), master_pct, master_proj, master_rule_why/master_rule and
# the three texts the caller shows: place_msg (stderr), place_say (stdout and log), place_log (the log only).
placement() {
  master_rule=; master_rule_why=; master_proj=; master_known=; master_used=; master_pct=; place_msg=; place_say=; place_log=
  read -r master_used master_pct < <(kubectl top nodes -l isnan.me/pool=control --no-headers 2>/dev/null | awk 'NR == 1 { gsub(/%/, "", $5); print $4, $5 }' || true) || true
  if [[ ${master_pct:-} =~ ^[0-9]{1,3}$ ]]; then
    master_known=1; master_pct=$((10#$master_pct)); master_proj=$master_pct
    used_mi=
    if [[ ${master_used:-} =~ ^([0-9]{1,9})Mi$ ]]; then used_mi=$((10#${BASH_REMATCH[1]}))
    elif [[ ${master_used:-} =~ ^([0-9]{1,6})Gi$ ]]; then used_mi=$(( 10#${BASH_REMATCH[1]} * 1024 )); fi
    if [[ ${used_mi:-} =~ ^[0-9]+$ ]] && [ "$used_mi" -gt 0 ] && [ "$master_pct" -gt 0 ]; then
      master_proj=$(( ( ( used_mi + peak_mi ) * master_pct + used_mi - 1 ) / used_mi )) # rounded UP, so "about N%, over M%" never reads N <= M
      [ $(( ( used_mi + peak_mi ) * master_pct )) -le $(( master_max * used_mi )) ] || master_rule_why=headroom
    fi
    [ "$master_pct" -le "$master_max" ] || master_rule_why=over
    if [ -n "$master_rule_why" ]; then
      if [ "$master_rule_why" = over ]; then place_msg="job-run: placement: the control-plane node is at ${master_pct}% of its memory (over ${master_max}%): this Job may not run there; it waits for k3s-node2 or for the master to have room"
      else place_msg="job-run: placement: the control-plane node is at ${master_pct}% of its memory and this Job may add ${peak_mi}Mi (about ${master_proj}%, over ${master_max}%): it may not run there; it waits for k3s-node2 or for the master to have room"; fi
      place_log="=== JOB-RUN PLACEMENT node=control-plane pct=$master_pct projected=$master_proj max=$master_max peak_mi=$peak_mi decision=required-away reason=$master_rule_why"
    else
      place_say="job-run: placement: the control-plane node is at ${master_pct}% of its memory (about ${master_proj}% with this Job; limit ${master_max}%): preferred rules only"
      place_log="=== JOB-RUN PLACEMENT node=control-plane pct=$master_pct projected=$master_proj max=$master_max peak_mi=$peak_mi decision=preferred"
    fi
  else
    place_msg="job-run: placement: the control-plane node's memory is unknown (metrics unavailable): preferred rules only"
    place_log="=== JOB-RUN PLACEMENT node=control-plane pct=unknown max=$master_max peak_mi=$peak_mi decision=preferred-metrics-unavailable"
  fi
  rule_placement
}
# The required rule: the control-plane expression (when the memory decision says so) AND the avoid-nodes expression (always, when set), in ONE term.
# master_aff is the JSON of the rule (for the release patch), master_rule the same as the line the template takes (flow YAML accepts JSON).
rule_placement() {
  local ex=
  [ -z "$master_rule_why" ] || ex='{"key":"isnan.me/pool","operator":"NotIn","values":["control"]}'
  [ -z "$avoid_json" ] || ex="${ex:+$ex,}{\"key\":\"kubernetes.io/hostname\",\"operator\":\"NotIn\",\"values\":[$avoid_json]}"
  master_aff=; master_rule=
  [ -z "$ex" ] || { master_aff="{\"nodeSelectorTerms\":[{\"matchExpressions\":[$ex]}]}"; master_rule="requiredDuringSchedulingIgnoredDuringExecution: $master_aff"; }
}
placement
[ -z "$place_msg" ] || echo "$place_msg" >&2
[ -z "$place_say" ] || plog "$place_say"
plog "$place_log" >/dev/null

# The credentials, into the Secret on stdin (printf is a builtin: no argument a process list would show).
secret="job=$job"; mask=
if [ "$kind" = github ]; then
  t=${NODE_AUTH_TOKEN:-}; [ -n "$t" ] || t=$(gh auth token 2>/dev/null || true)
  if [ -n "$t" ]; then secret="$secret"$'\n'"node-auth-token=$t"; mask=$t; else echo "job-run: no npm token (NODE_AUTH_TOKEN, gh): private packages will not install" >&2; fi
  # Event's repository is private (T-491): the same token is the Job's git credential, through its helper, never in a URL.
  if [ "$repo" = event ]; then
    [ -n "$t" ] || die "--repo event: no GitHub token (NODE_AUTH_TOKEN, gh) to clone the private $event_repo"
    secret="$secret"$'\n'"git-user=x-access-token"$'\n'"git-token=$t"
  fi
else
  creds=$(printf 'protocol=https\nhost=%s\n\n' "$gitea" | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null || true)
  u=$(printf '%s\n' "$creds" | sed -n 's/^username=//p'); t=$(printf '%s\n' "$creds" | sed -n 's/^password=//p'); unset creds
  [ -n "$t" ] || die "no credential for $gitea in git's credential helper"
  secret="$secret"$'\n'"git-user=${u:-git}"$'\n'"git-token=$t"; mask=$t
fi
unset t
# --pool-env (T-426): each value into the Secret under its own name, and onto the mask; the manifest gets only the name and a secretKeyRef,
# in the run container (the command needs it), never in fetch.
pool_refs=
for n in $pool_names; do
  secret="$secret"$'\n'"$n=${!n}"; mask="$mask"$'\n'"${!n}"
  pool_refs="$pool_refs\\n            - {name: JR_POOL_$n, valueFrom: {secretKeyRef: {name: $job, key: $n}}}"
done
pool_refs=${pool_refs#\\n}
[ -n "$pool_refs" ] || pool_refs='            # no --pool-env'
sed -e "s|^ *# __POOL_ENV__.*\$|$pool_refs|" -e "s#__MASTER_REQUIRED__#$master_rule#" -e "s#__NAME__#$job#g" -e "s#__CHAT__#$chat#g" -e "s#__ROLE__#$role#g" -e "s#__REPO__#$repo_label#g" -e "s#__PROGRAM__#$program#g" \
    -e "s#__MEMORY__#$memory#g" -e "s#__TMP_SIZE__#$tmp_size#" -e "s#__OWNER__#$host/$$/$(starttime $$)#" \
    -e "s#__DEADLINE__#$timeout#" -e "s#__IMAGE__#$image#" -e "s#__RUN_IMAGE__#${run_image:-$image}#" -e "s#__REPO_URL__#$url#" -e "s#__REF__#$ref#" -e "s#__ALSO__#$alsos#" \
    -e "s#__AGAINST__#$against#" -e "s#__KEEP__#$keep#" -e "s#__STEPS__#$steps#" -e "s#__ARTIFACTS__#$artifacts#" -e "s#__ARTMAX__#$art_max#" -e "s#__CMD__#$(printf '%s' "$cmd" | base64 -w0)#" \
    "$here/deploy/k3s-build/job-run.yaml" | kubectl apply -f - >/dev/null
# The Secret belongs to the Job from its first moment (T-426): the Job was applied suspended (no pod needs the Secret yet), and the Secret is
# made in ONE call that already carries the label and the ownerReference, so there is no window with an unowned Secret: whoever deletes the Job
# (its TTL, --stop, reap, a person) deletes it. The manifest passes on stdin (a client-side dry run, then jq, then apply): never in an argument.
uid=$(kubectl -n "$ns" get job "$job" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
[ -n "$uid" ] || die "could not read the uid of $job: no credentials were sent"
# kubectl's env-file parser can put a bad line (a value) into its error text: its stderr goes nowhere and the message here is fixed.
# The final call is `create`, not `apply`: apply would store the whole object, data included, in a last-applied annotation (review 5777).
sjson=$(printf '%s\n' "$secret" | kubectl -n "$ns" create secret generic "$job" --from-env-file=/dev/stdin --dry-run=client -o json 2>/dev/null) ||
  die "could not build the Secret for $job (kubectl refused the credentials; the reason is not shown): no credentials were sent"
unset secret
# kubectl's own text is never shown or logged (T-611): a rejected create can echo part of what it was given. Its stderr is read here for ONE fixed
# category, then dropped; the exit code and the category are enough to act on.
kerr=$(printf '%s' "$sjson" | jq --arg job "$job" --arg uid "$uid" --arg chat "$chat" \
  '.metadata.labels = {"app": "claudepilot-job-run", "job-run/chat": $chat} | .metadata.ownerReferences = [{"apiVersion": "batch/v1", "kind": "Job", "name": $job, "uid": $uid}]' |
  kubectl -n "$ns" create -f - 2>&1 >/dev/null) && krc=0 || krc=$?
unset sjson
if [ "$krc" -ne 0 ]; then
  case "$(printf '%s' "$kerr" | tr '[:upper:]' '[:lower:]')" in
    *alreadyexists*|*'already exists'*) kcat=already-exists ;;
    *forbidden*|*unauthorized*) kcat=not-allowed ;;
    *'connection refused'*|*timeout*|*'no such host'*|*'unable to connect'*|*'was refused'*) kcat=cluster-unreachable ;;
    *invalid*) kcat=invalid ;;
    *) kcat=other ;;
  esac
  unset kerr
  plog "=== JOB-RUN SECRET-FAILED rc=$krc category=$kcat" >/dev/null
  die "could not create the Secret for $job (kubectl exit $krc, category: $kcat; the reason is not shown)"
fi
unset kerr
# The chat ends: the Claude process this script runs under exits. Then the Job goes, and so does this script.
watch=${JOB_RUN_WATCH_PID:-${CLAUDE_PID:-}}
if [ -n "$watch" ] && [ "$watch" != none ] && kill -0 "$watch" 2>/dev/null; then
  ( while kill -0 "$watch" 2>/dev/null; do sleep "$poll"; done
    echo "job-run: the chat ended (process $watch): stopping $job" >&2; stop_one "$job"; kill -TERM $$ 2>/dev/null ) &
  wd=$!
fi
t0=$(date +%s)
echo "job-run: $job: $repo@${ref:0:12} ($steps) on $image${run_image:+; the command runs in $run_image}"

# The queue: unfinished Jobs in creation order; the running ones count, then each suspended one is let in while the caps allow.
# shellcheck disable=SC2016 # jq's own variables
QUEUE_JQ="$JQ_FIN"'
def chat: (.metadata.labels["job-run/chat"] // "manual");
def prog: (.metadata.labels["job-run/program"] // (.metadata.labels["job-run/repo"] // "" | if . == "claudepilot" or . == "event" then . else "konfersi" end));
def key: [.metadata.creationTimestamp, .metadata.name];
([.items[] | select(.metadata.deletionTimestamp == null and (fin | not))] | sort_by(key)) as $q
| ([$q[] | select(.metadata.name == $me)] | first) as $mine
| if $mine == null then "gone"
  elif $mine.spec.suspend != true then "go"
  else
    [$q[] | select(.spec.suspend != true)] as $run
    | (reduce $q[] as $j ({total: ($run | length), per: (reduce $run[] as $r ({}; .[$r | chat] += 1)),
          prog: (reduce $run[] as $r ({}; .[$r | prog] += 1)), done: false, go: false};
        if .done or $j.spec.suspend != true then .
        elif .total < $max and ((.per[$j | chat] // 0) < $per) and ((.prog[$j | prog] // 0) < $pprog) then
          .total += 1 | .per[$j | chat] += 1 | .prog[$j | prog] += 1 | (if $j.metadata.name == $me then .go = true | .done = true else . end)
        elif $j.metadata.name == $me then .done = true
        else . end)) as $s
    | if $s.go then "go"
      else "wait \([$q[] | select(.metadata.name != $me and (.spec.suspend != true or (key < ($mine | key))))] | length)" end
  end'
# Gates first (2026-10-17: deploy 361's gate, 8Gi, sat Pending for an hour while 4Gi lane Jobs took every bit of room it freed). While a gate pod
# waits for a node and some Job of ours runs (its memory comes free), a Job about to be let out waits instead; with none running, waiting frees
# nothing, so it goes. JOB_RUN_GATE_FIRST=0 turns it off.
gate_first=${JOB_RUN_GATE_FIRST:-1}
gate_waiting() {
  [ "$gate_first" = 1 ] || return 1
  local unplaced running
  unplaced=$(kubectl -n "$ns" get pods -l app=claudepilot-gate --field-selector=status.phase=Pending -o jsonpath='{range .items[*]}{.metadata.name}={.spec.nodeName}{"\n"}{end}' 2>/dev/null | grep -c '=$')
  [ "${unplaced:-0}" -gt 0 ] || return 1
  running=$(jobs_json | jq '[.items[] | select(.metadata.deletionTimestamp == null and .spec.suspend != true and ((.status.succeeded // 0) == 0) and ((.status.failed // 0) == 0))] | length' 2>/dev/null)
  [ "${running:-0}" -gt 0 ]
}
last=
while :; do
  d=$(jobs_json | jq -r --arg me "$job" --argjson max "$max" --argjson per "$per" --argjson pprog "$pprog" "$QUEUE_JQ" 2>/dev/null || true)
  if [ "$d" = go ] && gate_waiting; then d=gate; fi
  case "$d" in
    go) break ;;
    gate) [ "$d" = "$last" ] || echo "job-run: waits: a gate Job is Pending for room, and gates go first (JOB_RUN_GATE_FIRST=0 turns it off)"; last=$d ;;
    gone) echo "job-run: $job was stopped while queued" >&2; exit 1 ;;
    wait\ *) [ "$d" = "$last" ] || echo "job-run: queued behind ${d#wait } (at most $max at once, $per per chat, $pprog per program)"; last=$d ;;
  esac
  [ $(( $(date +%s) - t0 )) -lt "$queue_wait" ] || { echo "job-run: still queued after ${queue_wait}s: giving up" >&2; exit 1; }
  sleep "$poll"
done
# C5: the master moves while this Job waits suspended (minutes), so the decision is made again just before the release. If the answer changed, the
# suspended Job's affinity is patched first (a suspended Job's scheduling directives are mutable from Kubernetes 1.27; this cluster is 1.35), a merge
# patch that touches only the required rule and keeps the preferred ones. A reading that fails changes nothing. A required rule that cannot be
# added stops the run (the Job would land on a master over its line); a rule that cannot be dropped is only kept (harmless).
was_why=$master_rule_why; was_rule=$master_rule; was_aff=$master_aff; was_pct=$master_pct; was_known=$master_known
placement
if [ -z "$master_known" ]; then
  # The reading failed: the create-time decision, and its percentage, stand (and the log says so, so the last line is not read as "unknown").
  master_rule_why=$was_why; master_rule=$was_rule; master_aff=$was_aff; master_pct=$was_pct; master_known=$was_known
  plog "=== JOB-RUN PLACEMENT node=control-plane at=release reading=failed kept=$([ -n "$was_why" ] && echo required-away || echo preferred) pct=${was_pct:-unknown} (the create-time reading)" >/dev/null
elif [ "$was_rule" != "$master_rule" ]; then
  aff=${master_aff:-null}
  if kubectl -n "$ns" patch job "$job" --type merge -p '{"spec":{"template":{"spec":{"affinity":{"nodeAffinity":{"requiredDuringSchedulingIgnoredDuringExecution":'"$aff"'}}}}}}' >/dev/null 2>&1; then
    # T-524 S3c: one line, only after the patch was accepted, that says which way the rule went (the log of a live run shows it was applied).
    if [ -n "$master_rule_why" ]; then rule_way=added; else rule_way=dropped; fi
    echo "job-run: placement changed while queued: the rule away from the control-plane node was $rule_way: ${place_msg:-$place_say}" >&2
    plog "$place_log at=release changed-from=$([ -n "$was_why" ] && echo required-away || echo preferred)" >/dev/null
  elif [ -n "$master_rule_why" ]; then
    plog "=== JOB-RUN PLACEMENT node=control-plane at=release outcome=patch-failed" >/dev/null
    die "the control-plane node went over its line while $job waited, and its rule could not be added: run it again"
  else
    # The rule could not be dropped: it is only kept (harmless), and the log says so, so the last placement line is not read as "dropped".
    master_rule_why=$was_why; master_rule=$was_rule; master_aff=$was_aff; master_pct=$was_pct; master_known=$was_known
    echo "job-run: the placement rule was not dropped (the patch failed): the Job runs on its create-time rule" >&2
    plog "=== JOB-RUN PLACEMENT node=control-plane at=release outcome=drop-failed (the rule was not dropped: the Job runs on its create-time rule)" >/dev/null
  fi
fi
kubectl -n "$ns" patch job "$job" --type merge -p '{"spec":{"suspend":false}}' >/dev/null
t1=$(date +%s); tw=$t1; phase=running
job_state() { # Complete, Failed:<reason>, gone, or nothing while it runs
  kubectl -n "$ns" get job "$job" -o json 2>/dev/null | jq -r '[(.status.conditions // [])[] | select((.type == "Complete" or .type == "Failed") and .status == "True") | if .type == "Failed" then "Failed:\(.reason // "")" else .type end] | first // ""' 2>/dev/null || echo gone
}
pod_json() { kubectl -n "$ns" get pods -l "job-name=$job" -o json 2>/dev/null || true; }
pod_get() { jq -r "$1"' // ""' <<<"$2" 2>/dev/null || true; }
said=; why=
while :; do
  pj=$(pod_json); ph=$(pod_get '.items[0].status.phase' "$pj")
  case "$ph" in Running|Succeeded|Failed) break ;; esac
  [ -z "$(job_state)" ] || break
  # The fetch container (T-401: the clone and npm ci, with the credentials) is running: started, so the start wait does not apply (the
  # Job's deadline does); its log comes out of the run container.
  if [ -n "$(pod_get '.items[0].status.initContainerStatuses[0].state.running.startedAt' "$pj")" ]; then tw=$(date +%s); sleep "$poll"; continue; fi
  # Pending because no node can hold it (T-524): say so once, instead of a silent wait.
  why=$(pod_get '[.items[0].status.conditions[]? | select(.type == "PodScheduled" and .status == "False" and .reason == "Unschedulable") | .message] | first' "$pj")
  # With the required rule on (T-611) an affinity mismatch is the master being over its line, whatever else the message adds.
  if [ -n "$master_rule_why" ]; then rk=rule; elif [ -n "$master_rule" ]; then rk=avoid; else rk=none; fi
  case "$rk:$why" in
    avoid:*affinity*) [ "$said" = affinity ] || { said=affinity
        echo "job-run: $job is Pending: it may not run on the nodes named in JOB_RUN_AVOID_NODES ($avoid_txt), and no other node fits ($why; waits up to ${start_wait}s)" >&2
        plog "=== JOB-RUN PLACEMENT pending=affinity avoid=$avoid_txt decision=waits-off-avoided-nodes" >/dev/null; } ;;
    rule:*affinity*) [ "$said" = affinity ] || { said=affinity
        echo "job-run: $job is Pending: the control-plane node is over ${master_max}% of its memory, so this Job waits for k3s-node2 to have room ($why; waits up to ${start_wait}s)" >&2
        plog "=== JOB-RUN PLACEMENT pending=affinity pct=$master_pct decision=waits-for-node2" >/dev/null; } ;;
    *:'') ;;
    *:*'Insufficient memory'*)
      [ "$said" = memory ] || { said=memory
        if [ -n "$big" ]; then hint="drop --big if the command fits in $mem_std"; else hint="it starts when a Job ends and frees memory"; fi
        echo "job-run: $job is Pending: no node has $memory of memory free to request ($why); $hint (waits up to ${start_wait}s)" >&2
        plog "=== JOB-RUN PLACEMENT pending=memory pct=${master_pct:-unknown} decision=waits-for-memory" >/dev/null; } ;;
    *) [ "$said" = other ] || { said=other; echo "job-run: $job is Pending: $why (waits up to ${start_wait}s)" >&2
        plog "=== JOB-RUN PLACEMENT pending=other pct=${master_pct:-unknown} decision=waits" >/dev/null; } ;;
  esac
  if [ $(( $(date +%s) - tw )) -ge "$start_wait" ]; then
    # C4: the decision was taken once, at create time: with the required rule on, the master may have room again by now.
    if [ -n "$master_rule_why" ]; then again="; the control-plane node was over its line when this Job was placed: run it again, the master may have room now"; else again=; fi
    echo "job-run: the Job did not start in ${start_wait}s (pod: ${ph:-none}${why:+: $why})$again" >&2
    # QA Perf (7865): a Job that never starts has no final node line otherwise; the log must still show where the decision ended.
    plog "=== JOB-RUN PLACEMENT node=none pct=${master_pct:-unknown} decision=$([ -n "$master_rule_why" ] && echo required-away || echo preferred) outcome=did-not-start waited=$(( $(date +%s) - tw ))s" >/dev/null
    exit 1
  fi
  sleep "$poll"
done

# The log: streamed, masked for the credentials, the artifacts block set aside; NR is kept so a broken stream can be resumed.
# shellcheck disable=SC2016 # awk's own variables
# S1i (review 7888): the mask is ONE pass over the ORIGINAL line, never over its own output. The old loop (index, cut, again) never ended when a mask
# value held the replacement text ("REDACTED", "[redacted]"). Every hit of every value (overlapping, nested, any character: index() is a plain
# substring search, no regex) becomes a span; the spans are sorted and merged; each merged run is replaced once. It always ends: each search
# starts one character after the last hit. A value under 8 characters is not masked (too short to be a credential, and it would eat the log).
MASKFN='function mask(line, nt, toks, repl,   k, tok, p, i, s, e, n, a, b, j, m, t1, t2, out, pos) {
  n = 0
  for (k = 1; k <= nt; k++) { tok = toks[k]; if (length(tok) < 8) continue
    p = 1
    while ((i = index(substr(line, p), tok)) > 0) { s = p + i - 1; n++; a[n] = s; b[n] = s + length(tok) - 1; p = s + 1 } }
  if (n == 0) return line
  hit = 1
  for (j = 2; j <= n; j++) { t1 = a[j]; t2 = b[j]; m = j - 1; while (m >= 1 && a[m] > t1) { a[m + 1] = a[m]; b[m + 1] = b[m]; m-- } a[m + 1] = t1; b[m + 1] = t2 }
  out = ""; pos = 1; j = 1
  while (j <= n) { s = a[j]; e = b[j]; j++
    while (j <= n && a[j] <= e + 1) { if (b[j] > e) e = b[j]; j++ }
    out = out substr(line, pos, s - pos) repl; pos = e + 1 }
  return out substr(line, pos) }'
FILTER="$MASKFN"'
BEGIN { nt = split(ENVIRON["JR_MASK"], toks, "\n"); art = ENVIRON["JR_ART"]; lf = ENVIRON["JR_LOG"] }
{ hit = 0; line = mask($0, nt, toks, "[redacted]"); if (hit) leak = 1
  if (line == "=== JOB-RUN ARTIFACTS BEGIN") { inart = 1; next }
  if (line == "=== JOB-RUN ARTIFACTS END") { inart = 0; next }
  if (inart) { print line >> art; next }
  print line; print line >> lf; fflush() }
END { print NR >> ENVIRON["JR_N"]; if (leak) print "leak" >> ENVIRON["JR_N"] }'
filter() { JR_MASK=$mask JR_ART=$work/art.b64 JR_LOG=$log JR_N=$work/n awk "$FILTER"; }
kubectl -n "$ns" logs -f "job/$job" 2>&1 | filter || true
st=
while :; do st=$(job_state); if [ -n "$st" ] || [ $(( $(date +%s) - t1 )) -ge $(( timeout + start_wait )) ]; then break; fi; sleep "$poll"; done
if ! grep -q '^=== JOB-RUN EXIT ' "$log"; then
  seen=$(awk '/^[0-9]+$/ { n += $1 } END { print n + 0 }' "$work/n" 2>/dev/null || echo 0)
  rm -f "$work/art.b64"
  kubectl -n "$ns" logs "job/$job" 2>/dev/null | tail -n +"$(( ${seen:-0} + 1 ))" | filter || true
fi
phase=finished
rc=$(sed -n 's/^=== JOB-RUN EXIT \([0-9]\{1,3\}\)$/\1/p' "$log" | tail -n 1)
# Out of memory (T-524): the container killed at its limit (no exit line), or one process in it (the memory line counts the kills).
pj=$(pod_json)
if [ -n "$big" ]; then more="$mem_big is the most a Job gets: split the command"; else more="rerun with --big ($mem_big, prefers k3s-node2)"; fi
if [ "$(pod_get '[.items[0].status | (.initContainerStatuses // [])[], (.containerStatuses // [])[] | .state.terminated.reason] | index("OOMKilled") != null' "$pj")" = true ]; then
  echo "job-run: $job was OOMKilled: it reached its memory limit of $memory (the in-memory /tmp counts too); $more" >&2
  [ -n "$rc" ] || rc=137
elif ooms=$(sed -n 's/^=== JOB-RUN MEMORY .* oom_kills=\([0-9]\{1,9\}\)$/\1/p' "$log" | tail -n 1) && [ "${ooms:-0}" -gt 0 ]; then
  echo "job-run: $job: $ooms process(es) were OOM-killed at the memory limit of $memory; $more" >&2
fi
if [ "$(pod_get '.items[0].status.reason' "$pj")" = Evicted ]; then
  echo "job-run: $job was evicted: $(pod_get '.items[0].status.message' "$pj") (/tmp holds at most $tmp_size in memory; --big gives $tmp_big)" >&2
elif { [ -n "$rc" ] && [ "$rc" != 0 ]; } || [ "${st%%:*}" = Failed ]; then
  # A memory-backed /tmp is a tmpfs of its sizeLimit: when it fills, the command gets ENOSPC (no eviction), so the log is the only sign.
  if grep -q 'No space left on device' "$log" 2>/dev/null; then
    if [ -n "$big" ]; then hint="$tmp_big is the most /tmp gets: write less there or split the command"; else hint="rerun with --big (/tmp $tmp_big)"; fi
    echo "job-run: $job: No space left on device: /tmp holds at most $tmp_size in memory (it and /dev/shm count against the $memory limit); $hint" >&2
  fi
fi
if [ -z "$rc" ]; then
  case "$st" in
    Failed:DeadlineExceeded) rc=124; echo "job-run: past the deadline (${timeout}s)" >&2 ;;
    '') rc=1; echo "job-run: the Job did not finish" >&2; phase=setup ;;
    *) rc=1; echo "job-run: the Job ended without an exit code ($st)" >&2 ;;
  esac
fi
grep -qx leak "$work/n" 2>/dev/null && echo "job-run: WARNING: a credential was in the Job's log (masked in the output and in $log)" >&2
if [ -n "$artifacts" ] && [ -s "$work/art.b64" ]; then
  mkdir -p "$out"
  if base64 -d "$work/art.b64" 2>/dev/null | tar -xzf - -C "$out" --no-same-owner --no-same-permissions 2>/dev/null; then echo "job-run: artifacts in $out"
  else echo "job-run: the artifacts did not unpack" >&2; fi
  rm -f "$work/art.b64" # the packed copy is not needed again (a SIGKILL must not leave it in /tmp)
  # --pool-env (T-426): the artifacts block is base64, so the log mask never sees it. A trace, a HAR or a report can hold a request header:
  # scan what was unpacked for each value (the values on stdin, never in argv), delete a file that has one, and fail.
  if [ -n "$pool_names" ]; then
    vals=; for n in $pool_names; do vals="$vals${!n}"$'\n'; done
    # Fail closed (as the fetch scan, T-401): grep 0 = found, 1 = clean, 2 or more = the scan failed: nothing is known to be clean, so every
    # file unpacked is deleted and the run is red (rc 3). The hits are listed NUL-separated into a file (a name may hold a line break, and a
    # command substitution drops NUL bytes).
    # S1h N1 (review 7773): an artifact NAME is the command's to choose, so it may be the value, or hold a line break. Every message that names
    # one goes through the mask first (the value becomes REDACTED, whatever the characters), then the name is cut to a-z A-Z 0-9 . _ / - (anything
    # else, \n and \r too, becomes ?) and to 200 characters; the whole line goes through the mask again (defence in depth).
    redact() { JR_MASK=$mask awk "$MASKFN"'
      BEGIN { nt = split(ENVIRON["JR_MASK"], toks, "\n") }
      { print mask($0, nt, toks, "REDACTED") }'; }
    # (the X keeps a trailing line break in the name: a command substitution would drop it)
    safe_name() { local n; n=$(printf '%sX' "$1" | redact); n=${n%X}; printf '%s' "$n" | LC_ALL=C tr -c 'a-zA-Z0-9._/-' '?' | cut -c1-200; }
    say() { printf '%s\n' "$1" | redact >&2; }
    ndel=0
    wipe_out() { # find's list first; then, whatever find said, the folder's contents by glob (a failed find must never leave a file behind)
      while IFS= read -r -d '' f; do rm -f -- "$f"; done < "$work/all"
      ( shopt -s dotglob nullglob; rm -rf -- "$out"/* ) # a subshell on purpose: the shell options stay as they were
    }
    gst=0; printf '%s' "$vals" | grep -rlaFZ -f - -- "$out" > "$work/hits" 2>/dev/null || gst=$?; unset vals
    if [ "$gst" -ge 2 ]; then
      find "$out" -type f -print0 > "$work/all" 2>/dev/null || : > "$work/all"
      wipe_out
      echo "job-run: ERROR: with --pool-env the artifacts could not be checked for the credentials (the scan failed): all deleted" >&2
      [ "$rc" != 0 ] || rc=3
    elif [ -s "$work/hits" ]; then
      while IFS= read -r -d '' f; do rm -f -- "$f"; ndel=$((ndel + 1)); say "job-run: ERROR: a --pool-env credential was in the artifact $(safe_name "$f"): deleted"; done < "$work/hits"
      [ "$rc" != 0 ] || rc=3
    fi
    # A compressed file (a Playwright trace.zip, the report's data/*.zip, a .gz) cannot be scanned as plain bytes, and a value inside it would
    # survive. Chosen: delete it, fail closed (the known formats, no unzip or zcat needed, nothing about the value in an argument). Found by
    # extension and by magic bytes (a renamed file too). To keep traces, run without --pool-env artifacts, or switch the trace off.
    fst=0; find "$out" -type f -print0 > "$work/all" 2>/dev/null || fst=$?
    if [ "$fst" != 0 ]; then
      wipe_out; echo "job-run: ERROR: with --pool-env the artifacts could not be listed to check for compressed files: all deleted" >&2; [ "$rc" != 0 ] || rc=3
    fi
    while IFS= read -r -d '' f; do
      case "${f,,}" in
        *.zip|*.gz|*.tgz|*.bz2|*.xz|*.zst|*.br|*.7z|*.jar) z=1 ;;
        *) case "$(head -c 6 -- "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n')" in 504b0304*|504b0506*|1f8b*|425a68*|fd377a585a00|28b52ffd*) z=1 ;; *) z=0 ;; esac ;;
      esac
      if [ "$z" = 1 ]; then rm -f -- "$f"; ndel=$((ndel + 1)); say "job-run: ERROR: with --pool-env a compressed artifact cannot be checked for the credentials: $(safe_name "$f"): deleted"; [ "$rc" != 0 ] || rc=3; fi
    done < "$work/all"
    [ "$ndel" -eq 0 ] || say "job-run: ERROR: --pool-env: $ndel artifact file(s) deleted"
  fi
fi
node=$(pod_get '.items[0].spec.nodeName' "$pj")
t2=$(date +%s)
plog "=== JOB-RUN PLACEMENT node=${node:-?} pct=${master_pct:-unknown} decision=$([ -n "$master_rule_why" ] && echo required-away || echo preferred) queued=$((t1 - t0))s${avoid_txt:+ avoid=$avoid_txt}" >/dev/null
echo "job-run: $job rc=$rc in $((t2 - t1))s (queued $((t1 - t0))s) on ${node:-?} with $memory; log: $log"
# Save a pass (T-731, --reuse only): rc is 0 (it is only ever set to 0 from the command's own last "=== JOB-RUN EXIT 0" line), the Job itself ended
# Complete, and the leak check RAN and found nothing (a missing $work/n, written by the log filter, is not a pass: fail closed). The log on disk is
# the masked one. Written to a temporary name and moved, so a reader never sees half of it; the rc file goes last and decides. Only the store's own
# files are touched: the folder is created private when it is new and its mode is never changed; the cleanup matches only *.log, *.rc and *.job.
if [ -n "$key" ] && [ "$rc" = 0 ] && [ "${st:-}" = Complete ] && [ -f "$work/n" ] && ! grep -qx leak "$work/n"; then
  if { [ -d "$cache" ] || mkdir -p -m 700 "$cache"; } && cp "$log" "$cache/$key.log.tmp" && mv "$cache/$key.log.tmp" "$cache/$key.log" \
     && printf '%s %s\n' "$job" "$(date -u +%FT%TZ)" > "$cache/$key.job" && printf '0\n' > "$cache/$key.rc"; then
    echo "job-run: result saved for reuse (key ${key:0:12}, ${reuse_days} days)"
    # Only names of the store's own form (64-hex key + .log/.rc/.job): a folder like /var/log or /tmp loses nothing else.
    find "$cache" -maxdepth 1 -type f -regextype posix-extended -regex '.*/[0-9a-f]{64}\.(log|rc|job)' -mtime "+$((reuse_days * 2))" -delete 2>/dev/null || true
  else
    rm -f "$cache/$key.log.tmp" 2>/dev/null # a failed cp or mv leaves no half file behind
    echo "job-run: could not save the result for reuse (no harm done)" >&2
  fi
fi
exit "$rc"
