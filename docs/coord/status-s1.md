# S1 status (btw engine) - DONE, final report sent

FILES CLEAN: my files typecheck clean (root typecheck 2026-10-12 after the last edit; remaining red: claudeversion/testkit.ts, workspaces/docker.versions.test.ts: not mine).
Token-shaped literals removed from btw.test.ts and btwContext.test.ts (built at runtime); the commit scanner's show tool reports nothing for my files.

DONE: investigation (docs/prd/chat-sessions.md §20.2); contract packages/contracts/src/chatBtw.ts (+ additive unions in chat.ts); engine apps/server/src/chat/{btw,btwRun,btwContext,btwStore,authz}.ts;
migration 380; controller/socket/store/index wiring; tools/qa/mock-anthropic.mjs answers btw directives; PRD §20 (investigation, design, 13 FRs with observed status, verification, decisions) + README row.
TESTS: btwRun 13, btwContext 8, btw 29, btw.controller 6, btw.socket 5 pass; btw.integration 3 pass on the real CLI in the workspace image; chat dir 407 pass 0 fail; whole server suite 2270 tests, 2244 pass,
3 fail (browser/gate, claudeversion/service, platform/platform: other tracks). Scratch portal E2E (3271, real Docker workspace, real session, stand-in API) passed every step.
CLEANUP DONE: portal tmux, workspace container and volume, /tmp/bt*, mock servers, ports: all gone.
SAFE-MODE CONFIRMED to U1a (outbox): btwRun passes --safe-mode, real CLI answers with it, no user hook ran.
