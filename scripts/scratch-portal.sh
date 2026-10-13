#!/usr/bin/env bash
# A throwaway portal for looking at the UI or trying an API: its own data dir, a fixed sign-in code, from a CLEAN environment.
#   scripts/scratch-portal.sh start [port] [code]     default port 3403, code 24681372; prints the URL
#   scripts/scratch-portal.sh stop  [port]
#   scripts/scratch-portal.sh restart [port] [code]   stops the process and starts it again on the SAME data dir (a portal restart, Connect's A8)
#   PORTAL_CONNECT_ALLOW_HTTP=true PORTAL_CONNECT_URL=http://<pod ip>:3413 scripts/scratch-portal.sh start 3413   Connect variables
#       (PORTAL_CONNECT_*, PORTAL_TRUST_PROXY) are passed through when set, so a rig agent can dial a lab portal over plain http
#   PORTAL_LOCAL_ENABLED=true scripts/scratch-portal.sh start 3405   also offers "This machine" as a workspace (its home is the private one under /tmp;
#       a tools/qa/mock-anthropic.mjs stand-in reached through $dir/home/.claude/settings.json lets the real Claude Code answer without a credential)
# `env -i` matters in a workspace like this one: without it the portal would inherit ~/.kube/config (cluster-admin) and could create or
# delete real workspaces, and the GitHub and Claude credentials in the home folder. It starts with none of them and with Kubernetes off.
set -eu
cmd=${1:?start|stop|restart}; port=${2:-3403}; code=${3:-24681372}
dir=/tmp/scratch-portal-$port
# Starts the portal on $dir (its data, home and key kept there), from a clean environment.
launch() {
  key=$(cat "$dir/key")
  # Connect's variables, when the caller set them (a lab portal for a rig agent); nothing else of the caller's environment.
  passthru=$(env | grep -E '^(PORTAL_CONNECT_[A-Z_]+|PORTAL_TRUST_PROXY)=' || :)
  cd "$(dirname "$0")/../apps/server"
  # Its own session and no stdin or stdout of ours: the script (and a tool that waits for its output) must be able to end while it runs on.
  # shellcheck disable=SC2086 # one VAR=value word per line of $passthru
  env -i "PATH=$PATH" "HOME=$dir/home" LANG=C.UTF-8 PORTAL_K8S_ENABLED=false PORTAL_PORT="$port" \
    PORTAL_DATA_DIR="$dir/data" PORTAL_SERVER_CODE="$code" PORTAL_SECRET_KEY="$key" NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    ${PORTAL_LOCAL_ENABLED:+"PORTAL_LOCAL_ENABLED=$PORTAL_LOCAL_ENABLED"} $passthru \
    setsid nohup npx tsx src/index.ts >> "$dir/log" 2>&1 < /dev/null &
  disown
  cd - >/dev/null
}
waitup() {
  for _ in $(seq 1 60); do curl -fsS -m 2 "http://localhost:$port/healthz" >/dev/null 2>&1 && { echo "scratch portal: http://localhost:$port  (code $code)"; exit 0; }; sleep 1; done
  echo "did not start; see $dir/log" >&2; exit 1
}
# The process that listens on the port, found through /proc (no ss or lsof needed: the workspace image has neither).
pid_of() {
  python3 - "$port" <<'PY2'
import os, sys
port = int(sys.argv[1])
inodes = set()
for f in ('/proc/net/tcp', '/proc/net/tcp6'):
    try:
        for line in open(f).read().splitlines()[1:]:
            c = line.split()
            if c[3] == '0A' and int(c[1].split(':')[1], 16) == port:
                inodes.add(c[9])
    except OSError:
        pass
for p in filter(str.isdigit, os.listdir('/proc')):
    try:
        for fd in os.listdir(f'/proc/{p}/fd'):
            if os.readlink(f'/proc/{p}/fd/{fd}') in {f'socket:[{i}]' for i in inodes}:
                print(p); sys.exit(0)
    except OSError:
        pass
PY2
}
case "$cmd" in
  start)
    # Another portal on the port would answer /healthz for us (and `rm -rf` below would wipe ITS data dir): refuse, say whose it is.
    if curl -fsS -m 2 "http://localhost:$port/healthz" >/dev/null 2>&1; then echo "port $port is already in use by another portal; pick another port (scratch-portal.sh start <port>)" >&2; exit 2; fi
    rm -rf "$dir"; mkdir -p "$dir/home" "$dir/data"
    python3 -c 'import os,base64;print(base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("="))' > "$dir/key"; chmod 600 "$dir/key"
    launch; waitup ;;
  stop)
    pid=$(pid_of)
    [ -n "${pid:-}" ] && kill "$pid" && echo "stopped $port" || echo "nothing on $port"
    rm -rf "$dir" ;;
  restart)
    [ -f "$dir/key" ] || { echo "no scratch portal data in $dir: start one first" >&2; exit 2; }
    pid=$(pid_of)
    if [ -n "${pid:-}" ]; then kill "$pid"; for _ in $(seq 1 30); do [ -z "$(pid_of)" ] && break; sleep 0.5; done; fi
    echo "--- restart $(date -u +%FT%TZ)" >> "$dir/log"
    launch; waitup ;;
  *) echo "start|stop|restart" >&2; exit 2 ;;
esac
