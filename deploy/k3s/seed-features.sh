#!/bin/sh
# Turns on the portal's optional (beta) features through the settings API; safe to run again.
#   PORTAL_URL=https://pilot.ai.isnan.me PORTAL_SERVER_CODE=<8 characters> sh deploy/k3s/seed-features.sh
# Left OFF on purpose (they are protections or cost switches, not features): sessions.allowBypass, automove.allowApiKey,
# mcp.accountOff, mcp.poolOnly. The "This machine" target is an environment switch (PORTAL_LOCAL_ENABLED) and stays off.
set -eu
: "${PORTAL_URL:?set PORTAL_URL}" "${PORTAL_SERVER_CODE:?set PORTAL_SERVER_CODE}"
jar=$(mktemp); trap 'rm -f "$jar"' EXIT
curl -fsS -c "$jar" -o /dev/null -H 'Content-Type: application/json' -H "Origin: $PORTAL_URL" \
  -d "{\"code\":\"$PORTAL_SERVER_CODE\"}" "$PORTAL_URL/api/login"
set_value() { # key, json value
  code=$(curl -sS -b "$jar" -o /tmp/seed-features.out -w '%{http_code}' -X PUT -H 'Content-Type: application/json' -H "Origin: $PORTAL_URL" \
    -d "{\"value\":$2,\"confirm\":true}" "$PORTAL_URL/api/settings/$1")
  echo "$1 = $2 -> HTTP $code"; [ "$code" = 200 ] || { cat /tmp/seed-features.out; echo; return 1; }
}
set_value triggers.enabled true
set_value automove.enabled true
set_value automove.automatic true
set_value agents.selfEdit true
set_value notify.baseUrl "\"$PORTAL_URL\""

# The portal's own tools for sessions (Portal MCP): on, with session control, and agent access for the development workspace.
put_json() { # path, json body
  code=$(curl -sS -b "$jar" -o /tmp/seed-features.out -w '%{http_code}' -X PUT -H 'Content-Type: application/json' -H "Origin: $PORTAL_URL" -d "$2" "$PORTAL_URL$1")
  echo "$1 $2 -> HTTP $code"; [ "$code" = 200 ] || { cat /tmp/seed-features.out; echo; return 1; }
}
put_json /api/portal-mcp/settings '{"enabled":true,"sessionControl":true}'
put_json "/api/portal-mcp/agents/${PORTAL_DEV_WORKSPACE:-kubernetes/kohi-event}" '{"enabled":true}'
rm -f /tmp/seed-features.out
