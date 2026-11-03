# shellcheck shell=bash disable=SC2154 # the variables of scripts/job-run.sh, which sources this file
# job-run.sh --backend cf|auto (T-3542, epic PILOT-1127): the job runs in a Cloudflare Container started by the dispatcher Worker
# (deploy/cf-runner, KohiLabs account), not as a k3s Job. SOURCED by scripts/job-run.sh after its argument checks and before any kubectl
# call; never run on its own. Same CLI, same "=== JOB-RUN" lines, same log masking (job-run.sh's FILTER), same exit codes.
#
# Which runs (this slice): memor.id only, the GitLab group memorid (--repo memorid[:<group path>/<repo>], default platforms/root, or the
# current folder's gitlab.com/memorid origin), with its submodules; --sub <path>@<ref> puts one submodule at another pushed ref. Refused
# for cf, before any network call (rc 2): --image, --node, --cpu, --against, --also, --deploy-layout, --reuse, --pool-env (no pool
# credential goes to a Cloudflare container in this slice), a role in JOB_RUN_CF_DENY_ROLES (default konfersi-stg-deploy), a --timeout
# over JOB_RUN_CF_MAX_TIMEOUT (3600, owner decision D2: 60 min per job).
# --backend auto (or JOB_RUN_BACKEND=auto): cf when the run can go there AND its program is in JOB_RUN_CF_PROGRAMS (comma list; only the
# kohilabs workspace sets memorid); anything else stays on k8s, unchanged. (k8s cannot clone memor.id: there is no spill-over choice to
# make for it yet; spill-over of k8s programs is CFR-9.)
# Configuration (environment): JOB_RUN_CF_URL (the dispatcher, https://cp-jobrun-dispatcher.<subdomain>.workers.dev), JOB_RUN_CF_WORKSPACE
# (its key id, e.g. kohilabs), the key (JOB_RUN_CF_KEY, or derived from CF_RUNNER_API_TOKEN by scripts/job-run-cf-client.mjs).
# Credentials: the clone's GitLab token (git's credential helper for gitlab.com, else GITLAB_TOKEN) goes in the job's POST body over TLS
# and lives in the dispatcher's memory for the fetch phase only, where it is added to git upload-pack requests and nothing else; the
# container never has it. It is on the log mask here as well.
# Budget: the dispatcher refuses a job over the daily budget ($5/day): exit 1, "daily CF budget reached". Queue: "queued behind N".
# Metrics (CFR-8): one JSON line per run in ${JOB_RUN_CACHE_DIR:-~/.cache/claudepilot-job-run}/metrics.jsonl; scripts/job-run-metrics.mjs.

cf_reason=
cf_conf() { [ -n "${JOB_RUN_CF_URL:-}" ] && [ -n "${JOB_RUN_CF_WORKSPACE:-}" ]; }
# The repository: memorid, memorid:<path>, or the current folder's gitlab.com/memorid origin (its user and password part never kept).
cf_origin=$(git remote get-url origin 2>/dev/null | sed -E 's#^(https?://)[^@/]*@#\1#' || true)
cf_from_origin() { printf '%s' "$cf_origin" | sed -nE 's#^(git@gitlab\.com:|ssh://git@gitlab\.com/|https://gitlab\.com/)memorid/(.+)$#memorid:\2#p' | sed 's/\.git$//'; }
cf_repo=$repo
case "$cf_repo" in '' | memorid) cf_repo=$(cf_from_origin); [ -n "$cf_repo" ] || { [ "$repo" = memorid ] && cf_repo=memorid:platforms/root; } ;; esac
cf_path=
case "$cf_repo" in
  memorid:*)
    cf_path=${cf_repo#memorid:}
    [[ $cf_path =~ ^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+){0,3}$ && ! $cf_path =~ \.\. ]] || die "--repo memorid:<group path>/<repo> (got $cf_repo)" ;;
  *) cf_reason="the cf backend runs memor.id (gitlab.com/memorid) repositories only in this slice" ;;
esac
cf_max_timeout=${JOB_RUN_CF_MAX_TIMEOUT:-3600}
[[ $cf_max_timeout =~ ^[0-9]{2,5}$ ]] || die "JOB_RUN_CF_MAX_TIMEOUT is a number of seconds"
cf_deny=${JOB_RUN_CF_DENY_ROLES-konfersi-stg-deploy}
cf_role=$(label "$role")
[ -n "$cf_reason" ] || [ -z "$image_given" ] || cf_reason="--image (an internal-registry image; the cf runner has its own)"
[ -n "$cf_reason" ] || [ -z "$pin_given" ] || cf_reason="--node (a fixed k3s node)"
[ -n "$cf_reason" ] || [ -z "$cpu_given" ] || cf_reason="--cpu (a Guaranteed k3s pod)"
[ -n "$cf_reason" ] || [ -z "$against" ] || cf_reason="--against (not on cf in this slice)"
[ -n "$cf_reason" ] || [ ${#also[@]} -eq 0 ] || cf_reason="--also (not on cf in this slice; memor.id's repositories are submodules: use --sub)"
[ -n "$cf_reason" ] || [ -z "$layout" ] || cf_reason="--deploy-layout (not on cf in this slice)"
[ -n "$cf_reason" ] || [ -z "$reuse" ] || cf_reason="--reuse (not on cf in this slice)"
[ -n "$cf_reason" ] || [ -z "$pool_names" ] || cf_reason="--pool-env (no Secrets pool credential goes to a Cloudflare container in this slice)"
[ -n "$cf_reason" ] || [[ ",$cf_deny," != *",$cf_role,"* ]] || cf_reason="the role $cf_role stays on k8s (JOB_RUN_CF_DENY_ROLES)"
[ -n "$cf_reason" ] || [ "$timeout" -le "$cf_max_timeout" ] || cf_reason="--timeout $timeout is over the cf cap of ${cf_max_timeout}s (JOB_RUN_CF_MAX_TIMEOUT)"
[ -n "$cf_reason" ] || cf_conf || cf_reason="not configured here (JOB_RUN_CF_URL and JOB_RUN_CF_WORKSPACE)"
cf_program=memorid
if [ "$backend" = auto ]; then
  [ -n "$cf_reason" ] || [[ ",${JOB_RUN_CF_PROGRAMS:-}," == *",$cf_program,"* ]] || cf_reason="the program $cf_program is not in JOB_RUN_CF_PROGRAMS"
  if [ -n "$cf_reason" ]; then
    # Back to the k8s path, exactly as without --backend (a memor.id repository is then refused there, as before).
    unset cf_origin cf_repo cf_path
    return 0
  fi
else
  [ -z "$cf_reason" ] || die "--backend cf: refused: $cf_reason"
fi

# ---- from here the run is on Cloudflare: this file exits, the k8s code below its `.` line never runs ----
command -v node >/dev/null 2>&1 || die "--backend cf needs node (for the signed requests to the dispatcher)"
command -v jq >/dev/null 2>&1 || die "--backend cf needs jq"
client=(node "$here/scripts/job-run-cf-client.mjs")
for s in ${subs[@]+"${subs[@]}"}; do
  [[ $s =~ ^([A-Za-z0-9_.][A-Za-z0-9_./-]{0,199})@([A-Za-z0-9][A-Za-z0-9._/-]{0,199})$ && ! $s =~ \.\. ]] || die "--sub <submodule path>@<ref> (got $s)"
done
cf_size=s; cf_instance=standard-3; [ -z "$big" ] || { cf_size=b; cf_instance=standard-4; }
url=https://gitlab.com/memorid/$cf_path.git
# The ref: given, or HEAD of the current folder, which must be on the remote.
if [ -z "$ref" ]; then
  [ "$(cf_from_origin)" = "memorid:$cf_path" ] || die "--ref: the current folder is not a checkout of memorid:$cf_path; name the branch or commit"
  ref=$(git rev-parse HEAD)
  git branch -r --contains "$ref" 2>/dev/null | grep -q . || die "HEAD (${ref:0:7}) is not on the remote: push it first (git push origin HEAD:wip/<name>)"
  [ -z "$(git status --porcelain --untracked-files=no --ignore-submodules=all 2>/dev/null)" ] || echo "job-run: note: uncommitted changes are not in the job (it runs ${ref:0:7})" >&2
fi
[[ $ref =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ && ! $ref =~ \.\. ]] || die "--ref: a branch or commit name (got $ref)"
chat=$(label "${PILOT_SESSION_ID:-manual}"); role=$cf_role

# The clone's credential: git's helper for gitlab.com, else GITLAB_TOKEN (the Secrets pool's), as user oauth2. Never on a command line.
creds=$(printf 'protocol=https\nhost=gitlab.com\n\n' | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null || true)
cfu=$(printf '%s\n' "$creds" | sed -n 's/^username=//p'); cft=$(printf '%s\n' "$creds" | sed -n 's/^password=//p'); unset creds
if [ -z "$cft" ] && [ -n "${GITLAB_TOKEN:-}" ]; then cfu=oauth2; cft=$GITLAB_TOKEN; fi
[ -n "$cft" ] || die "no credential for gitlab.com (git's credential helper or GITLAB_TOKEN): memor.id's repositories are private"
[ "${#cft}" -ge 8 ] || die "the gitlab.com credential is shorter than 8 characters: refused"
mask=$cft

job=cp-cf-$cf_size$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
log=${JOB_RUN_LOG:-/tmp/job-run-$job.log}; [ -n "$out" ] || out=./job-run-artifacts/$job
[[ $out != -* ]] || out=./$out
work=$(mktemp -d "${TMPDIR:-/tmp}/cp-job-run-XXXXXX")
: > "$log"
cf_phase=setup; wd=; fp=
# shellcheck disable=SC2317 # called by the traps
cf_on_exit() {
  [ -z "$wd" ] || kill "$wd" 2>/dev/null || true
  [ -z "$fp" ] || { pkill -P "$fp" 2>/dev/null; kill "$fp" 2>/dev/null; } || true
  [ "$cf_phase" = finished ] || [ "$cf_phase" = setup ] || "${client[@]}" cancel "$job" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cf_on_exit EXIT
trap 'exit 130' INT TERM HUP
plog() { echo "$*"; echo "$*" >> "$log"; }

subs_json=$(for s in ${subs[@]+"${subs[@]}"}; do jq -nc --arg p "${s%@*}" --arg r "${s##*@}" '{path: $p, ref: $r}'; done | jq -sc .)
# The token reaches jq through its environment ($ENV), never its argv; the spec (which holds it) goes to the client on stdin.
spec=$(CF_U=$cfu CF_T=$cft jq -nc --arg id "$job" --arg url "$url" --arg ref "$ref" --argjson subs "$subs_json" --arg steps "$steps" \
  --arg cmd "$(printf '%s' "$cmd" | base64 -w0)" --arg art "$artifacts" --argjson timeout "$timeout" --arg chat "$chat" --arg role "$role" \
  --arg program "$cf_program" \
  '{id: $id, repoUrl: $url, ref: $ref, subs: $subs, steps: $steps, cmd: $cmd, artifacts: $art, timeout: $timeout, chat: $chat, role: $role,
    program: $program, creds: {user: $ENV.CF_U, token: $ENV.CF_T}}')
unset cft cfu
t0=$(date +%s); last=
echo "job-run: $job: memorid:$cf_path@${ref:0:12} ($steps) on Cloudflare ($cf_instance)${subs:+; --sub ${subs[*]}}"
while :; do
  resp=$(printf '%s' "$spec" | "${client[@]}" submit) || { unset spec; echo "job-run: the dispatcher did not answer ($JOB_RUN_CF_URL): not started (exit 1)" >&2; exit 1; }
  code=${resp%% *}; body=${resp#* }
  case "$code" in
    200 | 201) break ;;
    429) msg="job-run: queued behind $(jq -r '.ahead // "?"' <<<"$body" 2>/dev/null) on Cloudflare ($(jq -r '.reason // "caps"' <<<"$body" 2>/dev/null))"
         [ "$msg" = "$last" ] || echo "$msg"; last=$msg ;;
    402) unset spec
         plog "=== JOB-RUN PLACEMENT backend=cf decision=budget-refused $(jq -r '"scope=\(.scope) spent_usd=\(.spentUsd) limit_usd=\(.limitUsd)"' <<<"$body" 2>/dev/null)" >/dev/null
         echo "job-run: daily CF budget reached ($(jq -r '"\(.scope): $\(.spentUsd * 100 | round / 100) of $\(.limitUsd)"' <<<"$body" 2>/dev/null)): not started (exit 1)" >&2
         exit 1 ;;
    400) unset spec; die "the dispatcher refused the job: $(jq -r '.error // "bad request"' <<<"$body" 2>/dev/null | tr -cd 'A-Za-z0-9 ,.:/<>()_-' | cut -c1-200)" ;;
    401) unset spec; echo "job-run: the dispatcher refused this workspace's key (401): JOB_RUN_CF_WORKSPACE / the key; not started (exit 1)" >&2; exit 1 ;;
    *) unset spec; echo "job-run: the dispatcher answered HTTP $code: not started (exit 1)" >&2; exit 1 ;;
  esac
  [ $(( $(date +%s) - t0 )) -lt "$queue_wait" ] || { unset spec; echo "job-run: still queued after ${queue_wait}s: giving up" >&2; exit 1; }
  sleep "$poll"
done
unset spec
t1=$(date +%s); cf_phase=running
plog "=== JOB-RUN PLACEMENT backend=cf instance=$cf_instance decision=admitted queued=$((t1 - t0))s" >/dev/null
# The chat ends: the Claude process this script runs under exits. Then the job goes, and so does this script.
watch=${JOB_RUN_WATCH_PID:-${CLAUDE_PID:-}}
if [ -n "$watch" ] && [ "$watch" != none ] && kill -0 "$watch" 2>/dev/null; then
  ( while kill -0 "$watch" 2>/dev/null; do sleep "$poll"; done
    echo "job-run: the chat ended (process $watch): stopping $job" >&2; "${client[@]}" cancel "$job" >/dev/null 2>&1; kill -TERM $$ 2>/dev/null ) &
  wd=$!
fi
# mawk (Debian's awk) reads a pipe in blocks, so lines would show only at the end of the job: -W interactive reads line by line.
awk_live=(awk); awk -W version 2>/dev/null | grep -qi mawk && awk_live=(awk -W interactive)
filter() { JR_MASK=$mask JR_ART=$work/art.b64 JR_LOG=$log JR_N=$work/n "${awk_live[@]}" "$FILTER"; }
# In the background with `wait`: bash runs a trap only after a foreground command ends, and the follow ends only with the job, so an
# interrupt (INT/TERM/HUP, the chat watchdog) would never reach cf_on_exit's cancel otherwise.
( "${client[@]}" follow "$job" "$work/info.json" | filter ) &
fp=$!
wait "$fp" || true
fp=
cf_phase=finished
info=$(cat "$work/info.json" 2>/dev/null || echo '{}')
st=$(jq -r '.state // "unknown"' <<<"$info" 2>/dev/null || echo unknown)
rc=$(sed -n 's/^=== JOB-RUN EXIT \([0-9]\{1,3\}\)$/\1/p' "$log" | tail -n 1)
infra=0
grep -q '^=== JOB-RUN PLATFORM-STOP' "$log" 2>/dev/null && { infra=1; echo "job-run: $job: the Cloudflare container was stopped by the platform (infra failure): run it again" >&2; }
# The dispatcher records the agent's exit code too: a finished job whose EXIT line did not reach the log still has it (never a guess:
# only a number the agent reported, only for state finished).
if [ -z "$rc" ] && [ "$st" = finished ]; then
  rc=$(jq -r '.exit // empty' <<<"$info" 2>/dev/null | grep -xE '[0-9]{1,3}' || true)
  [ -z "$rc" ] || echo "job-run: $job: the exit line was not in the log; the exit code $rc is the one the runner reported" >&2
fi
if [ -z "$rc" ]; then
  case "$st" in
    deadline) rc=124; echo "job-run: past the deadline (${timeout}s)" >&2 ;;
    cancelled) rc=1; echo "job-run: $job was stopped before it finished: no exit code, no result (exit 1)" >&2 ;;
    infra) rc=1; infra=1; echo "job-run: $job: the Cloudflare container failed ($(jq -r '.reason // "?"' <<<"$info")): infra failure, no result (exit 1)" >&2 ;;
    *) rc=1; infra=1; echo "job-run: $job ended without an exit code (state $st)" >&2 ;;
  esac
fi
grep -qx leak "$work/n" 2>/dev/null && echo "job-run: WARNING: a credential was in the job's log (masked in the output and in $log)" >&2
if [ -n "$artifacts" ]; then
  arc=0; "${client[@]}" artifacts "$job" "$work/art.tgz" 2>/dev/null || arc=$?
  if [ "$arc" = 0 ]; then
    mkdir -p "$out"
    if tar -xzf "$work/art.tgz" -C "$out" --no-same-owner --no-same-permissions 2>/dev/null; then echo "job-run: artifacts in $out"
    else echo "job-run: the artifacts did not unpack" >&2; fi
    rm -f "$work/art.tgz"
  elif [ "$arc" != 3 ]; then echo "job-run: the artifacts could not be downloaded" >&2; fi
fi
t2=$(date +%s)
loc=$(jq -r '.location // "?"' <<<"$info" 2>/dev/null || echo '?')
plog "=== JOB-RUN PLACEMENT backend=cf instance=$cf_instance location=$loc decision=done queued=$((t1 - t0))s" >/dev/null
echo "job-run: $job rc=$rc in $((t2 - t1))s (queued $((t1 - t0))s) on cloudflare:$cf_instance${loc:+ ($loc)}; log: $log"
# CFR-8: one line per run for the CF-vs-k8s comparison (scripts/job-run-metrics.mjs). Best effort: a failed write changes nothing.
mdir=${JOB_RUN_CACHE_DIR:-${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}/claudepilot-job-run}
run_s=$(sed -n 's/^=== JOB-RUN SUMMARY .* run=\([0-9]\{1,7\}\)s .*/\1/p' "$log" | tail -n 1)
{ mkdir -p "$mdir" && jq -nc --arg t "$(date -u +%FT%TZ)" --arg job "$job" --arg repo "memorid:$cf_path" --arg program "$cf_program" \
    --arg role "$role" --arg chat "$chat" --arg size "$cf_instance" --argjson queue "$((t1 - t0))" --argjson wall "$((t2 - t1))" \
    --arg run "${run_s:-}" --argjson rc "$rc" --argjson infra "$infra" --argjson info "$info" \
    '{t: $t, backend: "cf", job: $job, repo: $repo, program: $program, role: $role, chat: $chat, size: $size, queue_s: $queue, wall_s: $wall,
      start_s: (if ($info.runPhase // null) != null and ($info.created // null) != null then (($info.runPhase - $info.created) / 1000 | floor) else null end),
      run_s: (if $run == "" then null else ($run | tonumber) end), rc: $rc, est_usd: ($info.costUsd // null), infra_fail: ($infra == 1),
      state: ($info.state // null)}' >> "$mdir/metrics.jsonl"; } 2>/dev/null || true
exit "$rc"
