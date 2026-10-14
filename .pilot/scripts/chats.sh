#!/usr/bin/env bash
# The chats job (T-277 layer 4), after verify: did the restart end a chat that was attached at release? It reads the chats the release step
# recorded (.pilot/out/chats.env) and watches the new portal's log until DEPLOY_CHATS_WINDOW_S after the new pod started. A chat attached at
# release that ended for integrity in that window FAILS this job, naming the chat (short id), when and why, so the cause is on the run page.
# The chats that survived are listed with their follower count (`cp-session tail` processes, counted for the chats of this workspace).
# It is its own job, not a step of verify: a failure of verify starts the rollback, a second restart that puts every attached chat through
# the same risk again, while the release itself is healthy. Here the run fails loudly and nothing is rolled back.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# shellcheck source=.pilot/scripts/lib.sh
. .pilot/scripts/lib.sh

PUSHED=0 CHATS_STATE=unavailable CHATS='' CHATS_AT='' CHATS_ATTACHED=0
# shellcheck source=/dev/null
[ -f "$OUT/release.env" ] && . "$OUT/release.env"
# shellcheck source=/dev/null
[ -f "$OUT/chats.env" ] && . "$OUT/chats.env"
if dry; then
  log "[dry-run] would watch the chats attached at release (${CHATS_STATE}) for integrity endings in the portal's log, ${DEPLOY_CHATS_WINDOW_S}s from the restart"
  exit 0
fi
if [ "$PUSHED" != 1 ]; then
  log "chats: nothing was released in this run: no restart, nothing to check"
  exit 0
fi
if [ "$CHATS_STATE" != recorded ]; then
  log "WARNING: chats: unavailable: the release step has no record of the chats attached at release, so they are not checked (see its log)"
  exit 0
fi
if [ "${CHATS_ATTACHED:-0}" = 0 ] || [ "$CHATS" = - ]; then
  log "chats: no chat was attached to a live process at release ($CHATS_AT): nothing to check"
  exit 0
fi

ids=() tails=() spaces=()
IFS=, read -r -a entries <<<"$CHATS"
for entry in "${entries[@]}"; do
  IFS=: read -r id _ _ tail _ ws <<<"$entry"
  [[ $id =~ ^[A-Za-z0-9_-]{1,8}$ ]] || continue
  ids+=("$id")
  tails+=("$tail")
  spaces+=("$ws")
done

started=$(portal_started)
start_s=''
[ -n "$started" ] && start_s=$(date -u -d "$started" +%s 2>/dev/null || true)
if [ -z "$start_s" ]; then
  start_s=$(date -u +%s)
  log "chats: the new portal pod's start time is unknown: the window starts now"
fi
end_s=$((start_s + DEPLOY_CHATS_WINDOW_S))
log "chats: ${#ids[@]} attached at release ($CHATS_AT); the portal restarted ${started:-at an unknown time}; watching its log for integrity endings until $(date -u -d "@$end_s" +%H:%M:%SZ) (${DEPLOY_CHATS_WINDOW_S}s)"

since=()
[ -n "$started" ] && since=(--since-time="$started")
ended=() others=()
while :; do
  text=$(kubectl -n "$DEPLOY_NAMESPACE" logs "deploy/$DEPLOY_DEPLOYMENT" --timestamps "${since[@]}" 2>/dev/null || true)
  # `<time> [chat] <session id>: ended for integrity: <why>`, from the line's start (a chat's own text can not make one).
  lines=$(printf '%s\n' "$text" | grep -E '^[0-9TZ:.+-]+ \[chat\] [A-Za-z0-9_-]+: ended for integrity: ' || true)
  ended=() others=()
  if [ -n "$lines" ]; then
    while IFS= read -r l; do
      sid=${l#* \[chat\] }
      sid=${sid%%:*}
      mine=''
      for id in "${ids[@]}"; do [ "${sid:0:${#id}}" = "$id" ] && mine=1; done
      if [ -n "$mine" ]; then ended+=("$l"); else others+=("$l"); fi
    done <<<"$lines"
  fi
  [ "${#ended[@]}" -gt 0 ] && break
  [ "$(date -u +%s)" -ge "$end_s" ] && break
  sleep "$DEPLOY_CHATS_POLL_S"
done

# `<short id> ended at <time>: <why>`, one line each, bounded.
say() {
  local t=${1%% *} rest=${1#* \[chat\] }
  printf '%s ended for integrity at %s: %s\n' "${rest:0:8}" "$t" "${rest#*: ended for integrity: }" | cut -c1-300
}
for l in "${others[@]}"; do log "note: a chat not attached at release: $(say "$l")"; done
if [ "${#ended[@]}" -gt 0 ]; then
  for l in "${ended[@]}"; do log "ENDED: $(say "$l")"; done
  short=$(for l in "${ended[@]}"; do r=${l#* \[chat\] }; printf '%s ' "${r:0:8}"; done)
  die "${#ended[@]} chat(s) attached at release ended for integrity after the restart: ${short% } (the reasons are above; recover them in place: Resume, or POST recover)"
fi

procs=$(ps -eo args= 2>/dev/null || true)
for i in "${!ids[@]}"; do
  if [ "${spaces[$i]}" = "${PILOT_WORKSPACE:-}" ] && [ -n "${tails[$i]}" ] && [ "${tails[$i]}" != - ]; then
    n=$(printf '%s\n' "$procs" | grep -cE "cp-session tail ${tails[$i]}[A-Za-z0-9._-]* " || true)
    note=''
    [ "$n" = 1 ] || note=" (WARNING: one is expected)"
    log "survived: ${ids[$i]}  followers $n$note"
  else
    log "survived: ${ids[$i]}  followers not counted (workspace ${spaces[$i]}, this job runs in ${PILOT_WORKSPACE:-?})"
  fi
done
log "chats: all ${#ids[@]} attached at release survived ${DEPLOY_CHATS_WINDOW_S}s after the restart"
