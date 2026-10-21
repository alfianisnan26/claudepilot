#!/usr/bin/env bash
# Builds, tests and packages the extension: tools/vscode/claudepilot.vsix (T-1974). Run from anywhere; it works in its own folder only and
# never touches the root workspaces. In the cluster:
#   scripts/job-run.sh --ref <pushed commit> --steps none --artifacts tools/vscode/claudepilot.vsix --out job-out/vsix -- 'tools/vscode/scripts/package.sh'
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --no-audit --no-fund
npm test
npm run typecheck
npm run package
ls -l claudepilot.vsix
