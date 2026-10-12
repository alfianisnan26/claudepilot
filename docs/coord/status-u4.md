# U4 status (glance widgets + aggregator + approval-text fix) - 2026-10-12: DONE, final report written

RESUME HERE: nothing pending. If anything is reopened: scratch portal recipe = env -i + /tmp/uwhome (see outbox-u4 incident), stand-in
Messages API + chat.mjs + seed were in /tmp/uwstub (deleted; rebuild from the glance PRD section 14 description).

DONE
- Server: apps/server/src/glance/{build,service,routes,authz,index,testkit}.ts, topic `glance` (contracts live.ts, live.ts hub + `watching`),
  wired in index.ts/app.ts; every read takes the seam's Actor (glance/authz.ts, declarePolicies, actorOf); 33 glance tests + live test.
- Web: features/glance/widgets/{shared,sessions,agents,attention,shortcuts}, 4 lines in registry.ts; Ctrl/Cmd+K palette; QA A9 steady lists.
- Approval fix (P1): contracts ChatRequest.full/fullCut/requestReview, protocol requestFull, migration 190, store, controller guard,
  ApprovalCard + ApprovalBlock + approvalReview, widget; chat/approvalText.test.ts (13) + web agreement tests.
- PRDs: glance-widgets.md 8, 10.1-10.6, 13, 14-17; chat-sessions.md FR25a + data model.
- Verified: real Claude Code 2.1.296 + scripted stand-in (no credentials): Deny, Allow, Stop task; 390/landscape/768/1024/1280/1920 light+dark;
  states, extreme data, neighbour shift. Screens: COORD/u4-screens/. Full server suite 1971 tests, 0 fail (21 skipped); web 315 tests, 0 fail;
  web build passes; tsc clean for my files (other agents' files have their own errors).

DECISIONS (also in the PRDs): approve/deny/stop use the chat socket's own messages (no glance write route); Allow only for a whole text
read to its end, else Open to review + Deny; unknown tools show their whole input as JSON and can be allowed; file tools show the path only;
cap 8,000; no migration for the glance itself (190 is the chat's request text); failed CI = latest non-cancelled run of a branch, <= 3 days.

OPEN / for others: approval audit with actor id + can(actor,'operate',session) belong in controller.#respond/socket (asked in outbox);
PLAN-8 rules must match the raw control-request input, not `full`; A9 shared ClampText/ChipList to adopt when they land;
filesystem here is case-insensitive (never two files differing by case); scratch portals need env -i (incident in outbox).
