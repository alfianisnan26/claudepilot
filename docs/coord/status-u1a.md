# U1a status (usage engine A) - FINAL, 2026-10-12

STATE: probe safe-mode fix DONE (coordinator's security request); the round-4 usage engine work is DONE as reported before.
Probe fix: apps/server/src/claudeusage/probe.ts adds SAFE_MODE_FLAG '--safe-mode' to probeCommand; askUsage/probeClaude detect a Claude Code that rejects
it (ProbeResult.unsupported, fails closed, no retry, no second call); service.ts logs it once per workspace; testkit localExec takes a cwd.
Tests: probe.test.ts 11 (3 new), service.safemode.test.ts 1, claude.integration.test.ts 9 (1 new: SessionStart/SessionEnd hooks in the Claude's
settings AND the project's leave no marker, the plan is still read, control without the flag fires them). Real CLI 2.1.296, private HOME + stand-in,
a private mount namespace for real managed settings, a throwaway container of the workspace image (dash), and CLI 2.1.168 from npm in /tmp (removed).
PRD claude-usage.md: section 11 "Hooks never run (safe mode)" with the observations, 7, 6, 10.1, 14, 15, 16, 19 (U10) updated.
Outbox: V1 gets the exact flag and what to guard; optional UsageProblem 'unsupported' + web word request; A2 note on btwRun.
Cleanup: scratch dirs, old CLI install, /etc/claude-code (empty dir I made) removed; two cp-fake-claude-* dirs kept (not provably mine).
RESUME HERE: nothing pending.
