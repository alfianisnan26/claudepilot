#!/usr/bin/env bash
# Runs on the Mac (initializeCommand). Exports host credentials the container
# needs into a dir outside the repo, which is bind-mounted read-only.
set -u
export PATH="/opt/homebrew/bin:$PATH"
umask 077

out="$HOME/.config/claudepilot-devcontainer"
mkdir -p "$out"

gh auth token > "$out/gh_token" || echo "initialize: gh auth token failed" >&2
kubectl config view --minify --flatten --context home-isnan-cluster > "$out/kubeconfig" \
  || echo "initialize: could not export home-isnan-cluster kubeconfig" >&2
# The portal's secret key (encrypts stored secrets). Created once and kept here, outside the repo:
# losing it makes every stored secret unreadable, so keep an offline copy too.
key="$out/portal_secret_key"
if [ ! -s "$key" ]; then
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > "$key" \
    || echo "initialize: could not create the portal secret key" >&2
fi
exit 0
