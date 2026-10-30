#!/usr/bin/env bash
# pool-env-names.sh (PILOT-998, T-2865): prints the env names this workspace's Secrets pool delivers, one per line: the key names of
# its env drop-in (written by the portal, owner secrets), never a value. job-run.sh calls it for --pool-env.
# READ ONLY, on purpose: the rule guard (D-60) lets a script that names a rule file run only when it writes nothing, so this file never
# writes, redirects or runs a program but jq. jobRun.test.ts checks it with the guard's own check, and a write here fails that test.
# The path is fixed: no variable overrides it, so an agent cannot point the check at a file it wrote (review 42840). The tests run a
# copy with the one dropin= line changed.
# Exit 3: no readable drop-in (nothing exposed). Exit 4: not JSON.
set -u
dropin=/etc/claude-code/managed-settings.d/20-claudepilot-env.json
[ -r "$dropin" ] || exit 3
jq -r '(.env // {}) | keys[] | select(test("^[A-Z][A-Z0-9_]*$"))' "$dropin" || exit 4
