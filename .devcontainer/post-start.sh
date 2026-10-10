#!/usr/bin/env bash
# Log gh in with the token exported from the Mac by initializeCommand.
set -euo pipefail

token_file="$HOME/.host-secrets/gh_token"
if [ -s "$token_file" ]; then
  gh auth login --hostname github.com --with-token < "$token_file"
else
  echo "post-start: no gh token from host; run 'gh auth login' inside the container" >&2
fi

# The repo's .npmrc reads @isnanme packages from GitHub Packages with NODE_AUTH_TOKEN: take it
# from gh in every new shell, so `npm install` works right after a rebuild.
npm_auth='export NODE_AUTH_TOKEN="$(gh auth token 2>/dev/null)"'
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  if [ -f "$rc" ] && ! grep -qF "$npm_auth" "$rc"; then
    printf '\n# claudepilot: GitHub Packages auth for npm\n%s\n' "$npm_auth" >> "$rc"
  fi
done

bash "$(dirname "$0")/docker-contexts.sh"
