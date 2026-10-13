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
    # Another portal on the port would answer /healthz for us (and `rm -rf` below would wipe ITS data dir): refuse, say whose it is.
    if curl -fsS -m 2 "http://localhost:$port/healthz" >/dev/null 2>&1; then echo "port $port is already in use by another portal; pick another port (scratch-portal.sh start <port>)" >&2; exit 2; fi
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
    # The process that listens on the port, found through /proc (no ss or lsof needed: the workspace image has neither).
    pid=$(python3 - "$port" <<'PY'
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
PY
)
    [ -n "${pid:-}" ] && kill "$pid" && echo "stopped $port" || echo "nothing on $port"
    rm -rf "$dir" ;;
  *) echo "start|stop" >&2; exit 2 ;;
esac
