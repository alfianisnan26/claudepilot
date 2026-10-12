Spawn: model=opus effort=medium - Tier A: auth tokens + device flow + REST lifecycle against a stand-in; REDIRECTED by the owner from a Copilot CLI POC to a GitHub Codespaces target POC (PLAN-16 rewritten); escalate to fable/high if token/storage design proves ambiguous
# status K1 (Codespaces POC: auth + lifecycle provider + fake GitHub API + PRD)   updated 2026-10-12   FINISHED
DONE: contract packages/contracts/src/codespaces.ts; server apps/server/src/codespaces/* (github, provider, vault, device, service, routes, authz, index, standin, standin-cli, codespaces.test.ts 17/17, 3 runs agree); app.ts + index.ts + contracts index.ts surgical; docs/prd/codespaces-poc.md + README row.
VERIFIED: scratch portal 3341 + stand-in 3342 (clean env): device flow, manual token, check, options, create/poll/stop/delete, Origin/session guards, canary grep 0 hits. No real GitHub call with a token.
SUITE: 1938 tests, 1918 pass, 2 fail (browser/cpbview, qa/boot: both pass alone; load timing, not my area), 18 skipped. Typecheck: my files clean; errors in claudeversion/canary/runner.ts and connect/authz.ts (others, mid-edit).
CLEANUP: tmux gc-portal/gc-standin killed; /tmp/gc-* removed; no containers.
FOR K2/K3: see outbox-k1.md and PRD §4, §12, §13.
RESUME HERE: nothing pending; next work = K2 (devcontainer side) and K3 (UI) per PLAN-16.
