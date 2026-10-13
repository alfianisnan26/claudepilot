# Track B: deploy notification, notifications, triggers, version pin, auto move, flaky tests

> **A work package of the orchestrator** (`orchestrator.md`, rules in `README.md`): a sub-agent takes slices of it, in this package's worktree and branch, and reports to the
> orchestrator in its final message (commits, tests run with their results, what is left, anything for a human). Where this file says "your status file" or
> "merged on `integration`", read: the orchestrator's status file and the orchestrator's merge.

Read: `CLAUDE.md`, the PRDs named per item, `docs/open-items.md` sections 3 (rows V1, N2, N3, N4) and 6 (known problems), and the earlier work:
`docs/coord/prompts/n2.md` `n3.md` `n4.md` `v1.md`, `docs/coord/RESUME-BLOCKS.md` (status-n2, n3, n4, v1), `docs/coord/TODO-coordinator.md`.

## Items, in this order

1. **A deploy that waits for a person must tell the person.** `CiService` calls `hooks.waiting(run, job, environment)` when a deployment starts
   waiting for approval (`apps/server/src/ci/service.ts`, PRD `docs/prd/local-git-ci.md` FR41); nothing listens yet. Wire it to the notify module
   (`apps/server/src/notify`): one notification, "Deploy waits" with the environment and run number, linking to `/admin/ci/runs/<id>`, to Web Push
   and the in-app history, honouring quiet hours and the per-event preferences (add the event to the events matrix; off by default is wrong here:
   on). A test for the event, the link and that nothing secret travels. This is the owner's loop: an agent starts a deploy, the owner's phone buzzes.
2. **V1, the version pin and canary** (`docs/prd/claude-version-pinning.md`): add the four safe-mode guards to the canary (flag present, hook marker
   test, `get_usage` still answers, the env var is not a substitute); make `claudeversion/service.test.ts` deterministic ("at most two per pass" is
   flaky under load: find the real cause); the final report in the PRD.
3. **N2, notifications web**: finish against the real routes: the service worker push, the subscription flow, the Notifications page, presence,
   toasts, the session-menu item, the Bell's unread count, the check that a notification action is authenticated. A real-device checklist for the
   owner (iPhone Home Screen push) goes in `docs/prd/platform-roadmap.md`; you cannot run it, so write it.
4. **N3, triggers** (`docs/prd/triggers.md`): verification in a scratch portal (cron, the webhook receiver `/hooks/:token` for Gitea, GitHub and GitLab
   with signature checks, failed CI as a source, limits, approval rules, run history), the web pages, abuse tests (replay, wrong signature,
   oversized body, a trigger loop), and the parts the status block lists as unwired.
5. **N4, auto move web half** (`docs/prd/auto-transfer.md`). It is parked on `origin/wip/stopped-by-quota-20261012-0712`: take ONLY
   `apps/web/src/features/autotransfer/**` from it (`git checkout origin/wip/stopped-by-quota-20261012-0712 -- apps/web/src/features/autotransfer`);
   do NOT merge that branch (it also holds the unreleased multi-user work and migrations 400-401). Fix the type error in `pure.test.ts`, wire the
   suggestion card, the divider mark, undo and the settings into the chat and settings screens, check it on a phone-width browser with a scratch portal.
   The server half is on `integration`; note that automatic moves keep Bypass (`docs/prd/chat-sessions.md` section 21).
6. **Tests that leak or flake.** `qa/boot.test.ts` leaves portal processes running when it fails or hangs (kill the child in a `finally` and add a
   timeout). `browser/gate.test.ts` is flaky under load. Subscribe `usagespend` to `chatController.onSideUsage` and split by `chat_usage.kind='side'`.

## Done when

Items 1 to 6 are on `integration` with the gate green, each PRD says what was observed, and your status file lists what a person must still do.
Then stop.
