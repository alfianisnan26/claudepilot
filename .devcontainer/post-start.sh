#!/usr/bin/env bash
# Log gh in with the token exported from the Mac by initializeCommand.
set -euo pipefail

token_file="$HOME/.host-secrets/gh_token"
if [ -s "$token_file" ]; then
  gh auth login --hostname github.com --with-token < "$token_file"
else
  echo "post-start: no gh token from host; run 'gh auth login' inside the container" >&2
fi

bash "$(dirname "$0")/docker-contexts.sh"
