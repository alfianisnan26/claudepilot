Spawn: model=sonnet effort=medium - Tier B/C: UI against V1's landed contract (chips, a Configuration section, a canary report view); mechanical, verified by screenshots; escalate to opus if stuck
# status V2  2026-10-12 (real-server pass done)
DONE: UI verified against the REAL V1 portal (3251, docker/vcx): overview, per-workspace info, plan, canary runs, settings panel; shapes matched (plan.hiddenSessions now used). A9: Bounded (+N InfoTip) and Clamp, clamped summaries, tabular-nums, history capped at 10, warnings at 5. Upgrade is icon-only under 420 px; same-version reason now shown.
LOOKED AT: 390 light, 844 landscape dark, 768 light, 1024 dark, 1920 light; no horizontal scroll (scrollWidth-clientWidth = 0 at all).
STUB-ONLY: 403 path, failed-canary accept flow, confirm dialog, Apply/Rollback (never run against the real portal).
BUILD: web typecheck and build green. Server typecheck red in chat/btw.*.test.ts (S1's), earlier glance model.test.ts red was fixed by its owner.
CLEANUP: chromium stopped, /tmp/vudrive and cookie jar removed; V1's portal left alone.
