# A6 status (Claude account usage monitoring) - FINAL, 2026-10-12 02:25 UTC

DONE. Nothing running, nothing waiting on me. (RESUME HERE: not needed; everything is built, verified and cleaned up.)
TESTKIT: apps/server/src/claudeusage/testkit/ (README.md). PRD: docs/prd/claude-usage.md v0.2 (+ row in docs/prd/README.md).

Built: server apps/server/src/claudeusage/** (parse, probe, store, service, source, routes, portalTools, index, fixtures, testkit/), contracts claudeusage.ts (+ live topic
`claudeusage`), migration 90, config PORTAL_CLAUDE_USAGE_{PROBES,INTERVAL_S,FAST_S,ONLY}; web features/usage/claude/** (Usage -> Claudes tab with meters, countdown + local time on tap,
status icon, sparkline, check-now, history, snooze; ClaudeMeter; ClaudeHeadroom; alert toasts watcher); surgical edits: UsagePage.tsx, ClaudesSection.tsx, App.tsx, app.ts, index.ts,
live.ts, config.ts, migrations.ts, contracts index/live, chat-sessions.md + workspace-claudes.md section 6 wording (approved), README row.
Verified: 56 module tests (parse 12, probe 8, store 5, service 17, routes 4, MCP tool 2, real-CLI integration 8) + qa/boot 4 green; full server suite 1111 tests, 2 failures in
OTHER areas (browser cpb-view screencast timing, secrets job test); QA fuzz: 112 routes, 0 findings; web typecheck + build green; real Docker workspace probe (signed out, apiKeyHelper ->
no plan limits, fake Max login via stand-in -> windows); live push over the socket; UI at 390/1280 light+dark with seeded states.
NOT verified (PRD section 19): a real subscription's reply; a live chat feeding onRateLimit (A2 wired it, no live session run); pool-workspace outbox; k8s / This machine.
Cleanup: tmux sessions, container claudepilot-cu-a + volume, /tmp/cudata, /tmp/cu-scratch, /tmp/cu*.
