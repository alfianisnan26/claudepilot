#!/usr/bin/env bash
# Runs npm ci for an image build with the token trimmed and masked in all output (KONF-3073 follow-up):
#   - NODE_AUTH_TOKEN is trimmed of every space and newline first (a Secret made from stdin kept a trailing newline, npm sent
#     "Bearer <token>\n" and its error printed the token), and an empty token fails before npm runs;
#   - everything the command prints, stdout and stderr, goes through scripts/mask-secrets.sh, so the token never reaches a build log;
#   - the command's own exit status is kept.
#   usage: NODE_AUTH_TOKEN=... scripts/npm-ci-masked.sh [command ...]      default: npm ci
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tok=$(printf '%s' "${NODE_AUTH_TOKEN-}" | tr -d '[:space:]')
[ -n "$tok" ] || { echo "npm-ci-masked: NODE_AUTH_TOKEN is empty (after trimming whitespace): refusing to run" >&2; exit 2; }
export NODE_AUTH_TOKEN=$tok
[ $# -gt 0 ] || set -- npm ci
"$@" 2>&1 | MASK_TOKEN=$tok bash "$here/mask-secrets.sh"
exit "${PIPESTATUS[0]}"
