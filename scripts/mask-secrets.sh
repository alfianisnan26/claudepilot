#!/usr/bin/env bash
# Masks credentials in build output: a stdin-to-stdout filter (KONF-3073 follow-up).
# On 2026-11-21 an npm auth error printed the GitHub Packages token into a kaniko Job's log. It replaces every occurrence of the value in MASK_TOKEN (read from the environment,
# never an argument, and trimmed of whitespace) and anything shaped like a GitHub token (ghp_/gho_/ghs_/ghu_..., github_pat_...) with
# [REDACTED]. Line buffered, so a long build streams. Used by scripts/npm-ci-masked.sh and scripts/k3s-build.sh.
set -u
MASK_TOKEN=$(printf '%s' "${MASK_TOKEN-}" | tr -d '[:space:]') exec awk '
  BEGIN { t = ENVIRON["MASK_TOKEN"] }
  {
    if (t != "") while ((i = index($0, t)) > 0) $0 = substr($0, 1, i - 1) "[REDACTED]" substr($0, i + length(t))
    gsub(/gh[opsu]_[A-Za-z0-9]+/, "[REDACTED]")
    gsub(/github_pat_[A-Za-z0-9_]+/, "[REDACTED]")
    print
    fflush()
  }'
