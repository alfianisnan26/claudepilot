#!/usr/bin/env bash
# ph.sh METHOD PATH [json]: one call to the cluster portal as the owner (code from PORTAL_SERVER_CODE); through the SSH jump SOCKS tunnel on 127.0.0.1:1080 when it is up
set -eu
P=https://pilot.ai.isnan.me; jar=$(mktemp); trap 'rm -f "$jar"' EXIT
px=(); if (exec 3<>/dev/tcp/127.0.0.1/1080) 2>/dev/null; then px=(--socks5-hostname 127.0.0.1:1080); fi
curl -fsS "${px[@]}" -m 60 -c "$jar" -o /dev/null -H 'Content-Type: application/json' -H "Origin: $P" -d "{\"code\":\"${PORTAL_SERVER_CODE:?}\"}" "$P/api/login"
if [ -n "${3:-}" ]; then curl -sS "${px[@]}" -m 60 -b "$jar" -X "$1" -H 'Content-Type: application/json' -H "Origin: $P" -d "$3" "$P$2"; else curl -sS "${px[@]}" -m 60 -b "$jar" -X "$1" -H 'Content-Type: application/json' -H "Origin: $P" "$P$2"; fi
