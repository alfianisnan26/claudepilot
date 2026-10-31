#!/usr/bin/env bash
# Test of tools/coordinator/gitea.sh: bash tools/coordinator/gitea.test.sh
# A fake kubectl (lists a pod; exec runs the command here) and a fake curl (records argv, the -K file and stdin) on PATH; token files with a
# value made at runtime. No cluster, no network.
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd -P)
base=$(mktemp -d "$here/.gttest.XXXXXX")
trap 'rm -rf "$base"' EXIT
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
mkdir -p "$base/bin"
tok="t$RANDOM$RANDOM$RANDOM"
printf '\n1 %s\n2 other%s\n' "$tok" "$RANDOM" > "$base/fallback.txt"
cat > "$base/bin/kubectl" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_DIR/kubectl"
case " $* " in
  *" get pods "*"-l "*) [ -n "${FAKE_NO_LABEL:-}" ] || echo pod/ws-kohi-event-abc-1 ;;
  *" get pods "*) printf 'pod/other-1\npod/ws-kohi-event-def-2\n' ;;
  *" exec "*) while [ "$1" != -- ]; do shift; done; shift; exec "$@" ;;
esac
FAKE
cat > "$base/bin/curl" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$FAKE_DIR/argv"
body=0 url=''
while [ $# -gt 0 ]; do
  case $1 in
    -K) echo "$2" > "$FAKE_DIR/cfgpath"; cat "$2" > "$FAKE_DIR/cfg"; stat -c %a "$2" > "$FAKE_DIR/cfgmode"; shift 2 ;;
    --data-binary) body=1; shift 2 ;;
    -X|-H|-w) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
[ "$body" = 1 ] && cat > "$FAKE_DIR/stdin"
echo "$url" > "$FAKE_DIR/url"
printf '{"number":7}\n%s' "${FAKE_STATUS:-201}"
FAKE
chmod +x "$base/bin/kubectl" "$base/bin/curl"
export PATH="$base/bin:$PATH" FAKE_DIR=$base GITEA_TOKEN_FILES="$base/missing.txt:$base/fallback.txt" GITEA_URL=https://gitea.example.invalid
g() { bash "$here/tools/coordinator/gitea.sh" "$@" 2>&1; }

out=$(g POST /repos/o/r/pulls '{"title":"x"}') && rc=0 || rc=$?
[ "$rc" = 0 ] && [ "$out" = '{"number":7}' ] && ok "prints the JSON response" || bad "response (exit $rc: $out)"
[[ $out == *"$tok"* ]] && bad "token in the output" || ok "token not in the output"
grep -qF "$tok" "$base/argv" "$base/kubectl" && bad "token in an argv" || ok "token in no argv (curl, kubectl)"
[ "$(cat "$base/cfg")" = "header = \"Authorization: token $tok\"" ] && ok "fallback file, last field of the first line, via curl -K" || bad "cfg: $(cat "$base/cfg")"
[ "$(cat "$base/cfgmode")" = 600 ] && ok "the -K file is 0600" || bad "cfg mode $(cat "$base/cfgmode")"
[ ! -e "$(cat "$base/cfgpath")" ] && ok "the -K file is deleted after" || bad "cfg file left behind"
[ "$(cat "$base/url")" = https://gitea.example.invalid/api/v1/repos/o/r/pulls ] && ok "/api/v1 added" || bad "url $(cat "$base/url")"
[ "$(cat "$base/stdin")" = '{"title":"x"}' ] && ok "body over stdin" || bad "stdin $(cat "$base/stdin")"
grep -q 'exec -i ws-kohi-event-abc-1 -c workspace' "$base/kubectl" && ok "exec in the labelled pod" || bad "pod: $(cat "$base/kubectl")"
: > "$base/kubectl"; rm -f "$base/stdin"
out=$(FAKE_NO_LABEL=1 g GET /api/v1/repos/o/r) && rc=0 || rc=$?
grep -q 'exec -i ws-kohi-event-def-2' "$base/kubectl" && ok "falls back to the name prefix" || bad "prefix: $(cat "$base/kubectl")"
[ "$(cat "$base/url")" = https://gitea.example.invalid/api/v1/repos/o/r ] && [ ! -e "$base/stdin" ] && ok "GET: no body, /api/v1 kept" || bad "GET"
echo '{"body":"from file"}' > "$base/b.json"
out=$(GITEA_POD=ws-x g PATCH /repos/o/r/pulls/7 "@$base/b.json") && rc=0 || rc=$?
[ "$(cat "$base/stdin")" = '{"body":"from file"}' ] && grep -q 'exec -i ws-x ' "$base/kubectl" && ok "@file and GITEA_POD" || bad "@file (exit $rc: $out)"
out=$(FAKE_STATUS=422 g POST /repos/o/r/pulls '{}') && rc=0 || rc=$?
[ "$rc" = 1 ] && [[ $out == *"gitea: HTTP 422"* ]] && ok "HTTP 422 exits 1 with the status" || bad "422 (exit $rc: $out)"
out=$(GITEA_TOKEN_FILES=$base/missing.txt g GET /user) && rc=0 || rc=$?
[ "$rc" = 2 ] && [[ $out == *"no readable token file"* ]] && ok "no token file: clear error" || bad "no token (exit $rc: $out)"
: > "$base/kubectl"
out=$(GITEA_LOCAL=1 g GET /user) && rc=0 || rc=$?
[ "$rc" = 0 ] && [ ! -s "$base/kubectl" ] && ok "GITEA_LOCAL runs without kubectl" || bad "local (exit $rc)"
trace=$(bash -x "$here/tools/coordinator/gitea.sh" GET /user 2>&1) || true
[[ $trace == *"$tok"* ]] && bad "token under bash -x" || ok "token never shows under bash -x"
out=$(g GET user) && rc=0 || rc=$?
[ "$rc" = 2 ] && ok "a path without / is a usage error" || bad "bad path (exit $rc)"

[ "$fails" = 0 ] && { echo "all passed"; exit 0; }
echo "$fails failed"; exit 1
