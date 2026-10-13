#!/usr/bin/env bash
# A throwaway portal for looking at the UI or trying an API: its own data dir, a fixed sign-in code, from a CLEAN environment.
#   scripts/scratch-portal.sh start [port] [code]     default port 3403, code 24681372; prints the URL
#   scripts/scratch-portal.sh stop  [port]
# `env -i` matters in a workspace like this one: without it the portal would inherit ~/.kube/config (cluster-admin) and could create or
# delete real workspaces, and the GitHub and Claude credentials in the home folder. It starts with none of them and with Kubernetes off.
set -eu
cmd=${1:?start|stop}; port=${2:-3403}; code=${3:-24681372}
dir=/tmp/scratch-portal-$port
case "$cmd" in
  start)
    rm -rf "$dir"; mkdir -p "$dir/home" "$dir/data"
    key=$(python3 -c 'import os,base64;print(base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("="))')
    cd "$(dirname "$0")/../apps/server"
    # Its own session and no stdin or stdout of ours: the script (and a tool that waits for its output) must be able to end while it runs on.
    env -i "PATH=$PATH" "HOME=$dir/home" LANG=C.UTF-8 PORTAL_K8S_ENABLED=false PORTAL_PORT="$port" \
      PORTAL_DATA_DIR="$dir/data" PORTAL_SERVER_CODE="$code" PORTAL_SECRET_KEY="$key" NODE_OPTIONS=--disable-warning=ExperimentalWarning \
      setsid nohup npx tsx src/index.ts > "$dir/log" 2>&1 < /dev/null &
    disown
    for _ in $(seq 1 60); do curl -fsS -m 2 "http://localhost:$port/healthz" >/dev/null 2>&1 && { echo "scratch portal: http://localhost:$port  (code $code)"; exit 0; }; sleep 1; done
    echo "did not start; see $dir/log" >&2; exit 1 ;;
  stop)
    pid=$(ss -ltnp 2>/dev/null | grep ":$port " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
    [ -n "${pid:-}" ] && kill "$pid" && echo "stopped $port" || echo "nothing on $port"
    rm -rf "$dir" ;;
  *) echo "start|stop" >&2; exit 2 ;;
esac
