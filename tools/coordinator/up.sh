#!/usr/bin/env bash
# up.sh: (re)start the coordinator's background helpers after a restart of the dev container or of the Claude session: the SSH jump SOCKS tunnel,
# the HTTP proxy shim for Node, and the supervisor (outside the pod, D-14). Safe to run again: it starts only what is not listening / not running.
# Needs PORTAL_SERVER_CODE in the environment for the supervisor. Logs: ~/.claudepilot/dev-sessions/*.log. Stop the tunnel: touch /tmp/jump-tunnel.stop
here=$(cd "$(dirname "$0")" && pwd); logs=$HOME/.claudepilot/dev-sessions; mkdir -p "$logs"; rm -f /tmp/jump-tunnel.stop
up() { (exec 3<>/dev/tcp/127.0.0.1/$1) 2>/dev/null; }
up 1080 || { setsid nohup "$here/jump-tunnel.sh" >> "$logs/tunnel.log" 2>&1 < /dev/null & }
for _ in $(seq 1 20); do up 1080 && break; sleep 1; done
up 3128 || { setsid nohup node "$here/socks-http-proxy.mjs" >> "$logs/proxy.log" 2>&1 < /dev/null & }
# The process itself (program node, first argument the script), not `pgrep -f`: that matched the CALLING shell whenever its own command line
# named the supervisor, so up.sh thought it ran and started nothing (2026-10-15 21:18).
running() { ps -eo args= | awk '$1=="node" && $2=="docs/dev-sessions/supervisor.mjs" {f=1} END {exit !f}'; }
# 2026-10-21: the supervisor is OFF by default. Its Konfersi track still starts the pre-D-88 single lead with the old prompt, which
# collides with the four leads (it woke the superseded lead 1134fd27). The portal's flow watchdog (T-1966) replaces it. SUPERVISOR=1 starts it.
if [ "${SUPERVISOR:-0}" = 1 ] && ! running; then
  cd "$here/../.." && NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:3128 NODE_NO_WARNINGS=1 setsid nohup node docs/dev-sessions/supervisor.mjs >> "$logs/supervisor.log" 2>&1 < /dev/null &
fi
sleep 3; up 1080 && echo "tunnel 1080 up" || echo "tunnel 1080 DOWN (Cloudflare Access login may be needed)"; up 3128 && echo "proxy 3128 up" || echo "proxy 3128 DOWN"
ps -eo pid,etime,cmd | grep "[n]ode docs/dev-sessions/supervisor.mjs" | cut -c1-80 || true
