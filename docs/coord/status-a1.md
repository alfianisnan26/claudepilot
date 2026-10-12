# A1 (QA) status - updated 2026-10-12 ~04:05 UTC: FINAL HARDENING PASS DONE; everything of mine is stopped. Verdict and counts: docs/qa/qa-report.md (Summary).

Done this pass (surgical edits in owners' files, each with a test):
- QA-032 follow-ups: ChatController.create refuses a workspace that does not exist (new workspaceExists hook, Workspaces.exists); GET claudes makes no Default row for an unknown workspace (claudesOf/claudeOf);
  Docker/Kubernetes runtimes refuse non-plain names (names.ts plainName); pools workspaceIdOf uses isWorkspaceId; Reconciler.request ignores invalid ids.
- Phone UI (looked at at 390 px): Pools tab strip scrolls the active tab into view; Settings labels short (+ wrap); Sessions grouping is an icon-only "Group by" button; Tickets no toolbar when empty;
  Knowledge one New; empty states of Skills/MCP sets/Secrets/Browser/Personas/Contexts are one line + New (details in the header ⓘ).
- QA-013: frozen reason names the one-statement repair; README Storage note; qa/oldmain.test.ts runs the printed statement. QA-006: verified with a canary (transcript, events API, frames, DB, log): FIXED.
- Test-infra: idcheck typecheck, claudeusage ENOTEMPTY (retries).
Runs: server suite 1167 tests, 1152 pass, 14 skipped, 1 fail (A5 ci/service.test.ts "kill ESRCH", load race, passes alone: QA-036); QA tests 52/52 incl. boot 4/4; fuzz 112 routes/3326 requests/0 findings;
npm run typecheck clean (server, web, contracts); web build OK; npm audit --omit=dev 0 vulnerabilities.
Open: QA-017/018 (scale, known limitation), QA-034 rest (Start buttons <640 px unnamed, no h1 on session/shell, tap targets, kit menu), QA-033 (A6 migration edited in place), 8 P3.
Not verified: real devices, real Claude sign-in, Kubernetes, push, production image with sharp, I11 beyond static review, A6 API beyond static review.
Resources: portal, mock APIs, qa-ws1 container, browsers all stopped; scratch data /tmp/qadata only.
