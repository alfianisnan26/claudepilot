#!/bin/sh
# Read-only look at ONE of the owner's neighbouring Mac folders, through a throwaway container on the Mac's Docker.
#   ro-mount.sh <isnan-cluster|konfersi-universe> '<shell command, cwd=/c>'
#   IMG=<local image> picks another image (then no --platform is forced; PLATFORM=linux/amd64 forces one). Default image: node:22-bookworm-slim (amd64, no git).
#   An image that has git and jq: vsc-claudepilot-ad0d2e908ca757a62294f42e151f9620351abed6643d168b61eef2a8fedcd2d6:latest (arm64).
# No network, read-only root and mount. Nothing else on the Mac is reachable this way. Never print secret values.
case "$1" in
  isnan-cluster|konfersi-universe) DIR="$1" ;;
  *) echo "ro-mount.sh: only isnan-cluster or konfersi-universe" >&2; exit 2 ;;
esac
if [ -n "${IMG:-}" ]; then
  if [ -n "${PLATFORM:-}" ]; then set -- "$@" ; exec docker --context host run --rm --network none --read-only --platform "$PLATFORM" --entrypoint sh -v "/Users/alfian/Documents/programming/$DIR:/c:ro" -w /c "$IMG" -c "$2"; fi
  exec docker --context host run --rm --network none --read-only --entrypoint sh -v "/Users/alfian/Documents/programming/$DIR:/c:ro" -w /c "$IMG" -c "$2"
fi
exec docker --context host run --rm --network none --read-only --platform linux/amd64 --entrypoint sh \
  -v "/Users/alfian/Documents/programming/$DIR:/c:ro" -w /c node:22-bookworm-slim -c "$2"
