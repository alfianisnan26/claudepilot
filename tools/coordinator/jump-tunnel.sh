#!/usr/bin/env bash
# SOCKS5 tunnel on 127.0.0.1:1080 through the SSH jump node (Cloudflare Access ProxyCommand); restarts by itself; stops when /tmp/jump-tunnel.stop exists.
# Needs a valid Cloudflare Access login (cloudflared access login ssh-node1-infra.isnan.me) when the cached token has expired.
while [ ! -e /tmp/jump-tunnel.stop ]; do
  echo "$(date -u +%T) tunnel up"
  ssh -N -D 127.0.0.1:1080 -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new -o ProxyCommand="cloudflared access ssh --hostname %h" ssh-node1-infra.isnan.me
  echo "$(date -u +%T) tunnel down (rc=$?), retry in 10s"; sleep 10
done
