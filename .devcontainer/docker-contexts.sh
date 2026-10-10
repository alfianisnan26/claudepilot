#!/usr/bin/env bash
# Registers the Mac's Docker Desktop as the `host` docker context. The default context stays the
# Docker-in-Docker daemon from the devcontainer feature.
set -u

sock=/var/run/docker-host.sock
if [ ! -S "$sock" ]; then
  echo "docker-contexts: $sock not mounted; host Docker unavailable" >&2
  exit 0
fi
if ! command -v docker >/dev/null; then
  echo "docker-contexts: docker CLI missing (docker-in-docker feature not installed?)" >&2
  exit 0
fi

# The mounted socket is root-owned; let the docker group (node is in it) use it.
sudo chgrp docker "$sock" && sudo chmod g+rw "$sock"

docker context inspect host >/dev/null 2>&1 \
  || docker context create host --description "Docker Desktop on the Mac" \
       --docker "host=unix://$sock" >/dev/null
exit 0
