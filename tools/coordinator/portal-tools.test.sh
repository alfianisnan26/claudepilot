#!/usr/bin/env bash
# Test of tools/coordinator/portal-login.sh and portal-api.sh: bash tools/coordinator/portal-tools.test.sh
# A fake curl on PATH (records its argv and stdin, writes the jar) and a fake dev-context.md with a code made at runtime; no network.
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd -P)
base=$(mktemp -d "$here/.pttest.XXXXXX")
trap 'rm -rf "$base"' EXIT
fails=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
mkdir -p "$base/bin"
code="lab$RANDOM$RANDOM"
printf '| What | Who | Value |\n| --- | --- | --- |\n| Sign-in | the owner'"'"'s server code | `%s` (a lab) |\n' "$code" > "$base/ctx.md"
cat > "$base/bin/curl" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$FAKE_DIR/argv"
w='' jar='' url='' readin=0
while [ $# -gt 0 ]; do
  case $1 in
    -w) w=$2; shift 2 ;;
    -c) jar=$2; shift 2 ;;
    -b|-o|-H|-X) shift 2 ;;
    --data-binary) [ "$2" = @- ] && readin=1; [[ $2 == @* && $2 != @- ]] && cp "${2#@}" "$FAKE_DIR/stdin"; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
[ "$readin" = 1 ] && cat > "$FAKE_DIR/stdin"
echo "$url" > "$FAKE_DIR/url"
[ -n "$jar" ] && echo "pilot.ai.isnan.me FALSE / TRUE 0 cp_session fake" > "$jar"
[ "$w" = '\n%{http_code}' ] && printf '{"data":{"ok":true}}\n%s' "${FAKE_STATUS:-200}" || printf '%s' "${FAKE_STATUS:-200}"
FAKE
chmod +x "$base/bin/curl"
export PATH="$base/bin:$PATH" FAKE_DIR=$base PORTAL_DEV_CONTEXT=$base/ctx.md PILOT_URL=https://portal.example.invalid
jar=$base/state/portal.jar

out=$(bash "$here/tools/coordinator/portal-login.sh" "$jar" 2>&1) && rc=0 || rc=$?
[ "$rc" = 0 ] && [ "$out" = "signed in" ] && ok "prints only: signed in" || bad "signed in (exit $rc: $out)"
[ "$(stat -c %a "$jar")" = 600 ] && ok "jar is 0600" || bad "jar mode $(stat -c %a "$jar")"
[ "$(cat "$base/stdin")" = "{\"code\":\"$code\"}" ] && ok "the code goes on stdin as JSON" || bad "stdin: $(cat "$base/stdin")"
grep -qF "$code" "$base/argv" && bad "the code is in curl's argv" || ok "the code is not in argv"
grep -qx 'origin: https://portal.example.invalid' "$base/argv" && ok "origin header sent" || bad "origin header"
[ "$(cat "$base/url")" = https://portal.example.invalid/api/login ] && ok "posts /api/login" || bad "url $(cat "$base/url")"
trace=$(bash -x "$here/tools/coordinator/portal-login.sh" "$jar" 2>&1) || true
[[ $trace == *"$code"* ]] && bad "the code shows under bash -x" || ok "the code never shows under bash -x"
out=$(FAKE_STATUS=403 bash "$here/tools/coordinator/portal-login.sh" "$jar" 2>&1) && rc=0 || rc=$?
[ "$rc" = 1 ] && [ "$out" = "sign-in failed: HTTP 403" ] && ok "a refusal prints only the status" || bad "refusal (exit $rc: $out)"
[[ $out == *"$code"* ]] && bad "code in the failure output" || ok "no code in the failure output"
printf '| Sign-in | nothing here |\n' > "$base/empty.md"
out=$(PORTAL_DEV_CONTEXT=$base/empty.md bash "$here/tools/coordinator/portal-login.sh" "$jar" 2>&1) && rc=0 || rc=$?
[ "$rc" = 2 ] && [[ $out == *"no code in the Sign-in row"* ]] && ok "no code: usage error" || bad "no code (exit $rc: $out)"

# portal-api.sh
export PORTAL_JAR=$jar
: > "$base/argv"; rm -f "$base/stdin"
out=$(bash "$here/tools/coordinator/portal-api.sh" GET /api/health 2>&1) && rc=0 || rc=$?
[ "$rc" = 0 ] && [ "$out" = '{"data":{"ok":true}}' ] && ok "GET prints the body" || bad "GET (exit $rc: $out)"
grep -qx "$jar" "$base/argv" && grep -qx 'origin: https://portal.example.invalid' "$base/argv" && ok "uses the jar and the origin" || bad "jar/origin"
[ ! -e "$base/stdin" ] && ok "GET sends no body" || bad "GET body"
out=$(bash "$here/tools/coordinator/portal-api.sh" POST /api/x '{"a":1}' 2>&1) && rc=0 || rc=$?
[ "$rc" = 0 ] && [ "$(cat "$base/stdin")" = '{"a":1}' ] && ok "POST sends the JSON" || bad "POST (exit $rc)"
echo '{"b":2}' > "$base/body.json"
out=$(bash "$here/tools/coordinator/portal-api.sh" PATCH /api/x "@$base/body.json" 2>&1) && rc=0 || rc=$?
[ "$rc" = 0 ] && [ "$(cat "$base/stdin")" = '{"b":2}' ] && ok "@file sends the file" || bad "@file (exit $rc)"
out=$(FAKE_STATUS=401 bash "$here/tools/coordinator/portal-api.sh" GET /api/x 2>&1) && rc=0 || rc=$?
[ "$rc" = 1 ] && [[ $out == *"HTTP 401"*"portal-login.sh"* ]] && ok "401 says sign in again" || bad "401 (exit $rc: $out)"
out=$(bash "$here/tools/coordinator/portal-api.sh" GET api/x 2>&1) && rc=0 || rc=$?
[ "$rc" = 2 ] && ok "a path without / is a usage error" || bad "bad path (exit $rc)"
out=$(PORTAL_JAR=$base/none bash "$here/tools/coordinator/portal-api.sh" GET /api/x 2>&1) && rc=0 || rc=$?
[ "$rc" = 2 ] && [[ $out == *"portal-login.sh first"* ]] && ok "no jar: sign in first" || bad "no jar (exit $rc: $out)"

[ "$fails" = 0 ] && { echo "all passed"; exit 0; }
echo "$fails failed"; exit 1
