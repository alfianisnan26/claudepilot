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
exit 0
