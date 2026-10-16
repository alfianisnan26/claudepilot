#!/usr/bin/env bash
# QA T-612 S1 diagnostic, inside a Job after `npm ci`: why does eslint fail on a clean one-line file? Raw outputs, nothing hidden.
set -u
mkdir -p qa-scratch
printf 'export const a = 1;\n' > qa-scratch/f.ts
printf 'export const a = 1;\n' > qa-scratch/f.mjs
bin=node_modules/.bin
echo "=== eslint qa-scratch/f.ts"; $bin/eslint qa-scratch/f.ts; echo "rc $?"
echo "=== eslint qa-scratch/f.mjs"; $bin/eslint qa-scratch/f.mjs; echo "rc $?"
echo "=== eslint a repo file"; $bin/eslint apps/server/src/ci/quickCheck.test.ts; echo "rc $?"
echo "=== eslint eslint.config.js"; $bin/eslint eslint.config.js; echo "rc $?"
echo "=== print-config for f.ts (head)"; $bin/eslint --print-config qa-scratch/f.ts 2>&1 | head -n 25; echo "rc $?"
echo "=== prettier --check on the changed repo files"; $bin/prettier --check package.json eslint.config.js .prettierrc.json apps/server/src/ci/quickCheck.test.ts scripts/quick-check.sh --ignore-unknown; echo "rc $?"
echo "=== prettier --check on f.ts"; $bin/prettier --check qa-scratch/f.ts; echo "rc $?"
exit 0
