#!/usr/bin/env bash
# Runs a browser or API harness against its own scratch portal, then stops the portal: the one way to run tools/qa/*.mjs in a Job
# (scripts/job-run.sh), where nothing else starts a portal. T-259 QA 4A: keepgoing.mjs in a Job failed at once with ECONNREFUSED on
# 127.0.0.1:3471 because the command ran the harness alone.
#   tools/qa/with-portal.sh <port> <command...>
#   scripts/job-run.sh --ref <branch> -- 'tools/qa/with-portal.sh 3471 env KG_PORT=3471 node tools/qa/keepgoing.mjs'
# It builds the web app first when apps/web/dist is missing (a fresh clone), starts scripts/scratch-portal.sh on <port> (code 24681372, the
# harnesses' default), runs the command with QA_PORT and QA_CODE set, stops the portal whatever happened, and exits with the command's code.
set -eu
port=${1:?usage: with-portal.sh <port> <command...>}
shift
[ "$#" -gt 0 ] || { echo "usage: with-portal.sh <port> <command...>" >&2; exit 2; }
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
if [ ! -f apps/web/dist/index.html ]; then
  echo "with-portal: building the web app (apps/web/dist is missing)"
  npm run build -w @portal/web >/tmp/with-portal-build-$port.log 2>&1 || { tail -n 30 /tmp/with-portal-build-$port.log >&2; echo "with-portal: the web build failed" >&2; exit 1; }
fi
stop() { scripts/scratch-portal.sh stop "$port" >/dev/null 2>&1 || :; }
trap stop EXIT
if ! scripts/scratch-portal.sh start "$port"; then
  echo "with-portal: the scratch portal did not start on $port; its log:" >&2
  tail -n 40 "/tmp/scratch-portal-$port/log" >&2 2>/dev/null || :
  exit 1
fi
set +e
QA_PORT=$port QA_CODE=24681372 "$@"
code=$?
set -e
exit "$code"
