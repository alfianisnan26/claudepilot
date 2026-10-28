#!/usr/bin/env bash
# approval-passes.sh (T-2889): prints the live one-time passes a person allowed for this workspace, one sha256 a line: the hashes of the
# passes file the portal delivers (root-owned, 0644; hashes and expiry only, never a call or a value). job-run.sh calls it for --pool-env.
# READ ONLY, on purpose (the T-2865 pattern, PILOT-1016): the rule guard (D-60) lets a script that names a policy file run only when it
# writes nothing, so this file never writes or redirects output. ruleGuard.test.ts runs the guard on it, and a write here fails that test.
# Both lines below are fixed: no variable overrides them, so an agent cannot point the check at a file it wrote. The tests run a copy with
# these two lines changed.
# Exit 3: no usable file (missing, a link, not owned by the owner, or group or others may write it). Nothing printed then.
set -u
passes=/etc/claudepilot/approval-passes
owner=0
[ -f "$passes" ] && [ ! -L "$passes" ] || exit 3
[ "$(stat -c %u "$passes" 2>/dev/null)" = "$owner" ] || exit 3
[ $(( 8#$(stat -c %a "$passes" 2>/dev/null || echo 777) & 8#022 )) -eq 0 ] || exit 3
now=$(date +%s)
# Each line is `<64 hex> <expiry, epoch seconds>`; the header and anything else is skipped. The words are hex and digits only.
set -- $(grep -E '^[0-9a-f]{64} [0-9]{1,12}$' "$passes")
while [ $# -ge 2 ]; do
  [ "$2" -gt "$now" ] && printf '%s\n' "$1"
  shift 2
done
exit 0
