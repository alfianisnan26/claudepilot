# orchestrator status (2026-10-15 04:35 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md`. Hand-overs: ab99b45 (a8393f6b), bb58413 (83842ba6), 639202e (de232389).

## DONE
- DEPLOYED run 33 (rmv914lde880bdb, ffa7703, portal 2026.10.15-4): all jobs passed. Live: d354977 cost fix, T-366, T-417, T-375, T-369.
- T-375, T-369 CLOSED (deploy evidence run 33).
- T-427 CLOSED (QA 3126), T-413 CLOSED (QA 3123/3138; gaps -> T-448): merged, gate GREEN ed18de4, integration pushed 6629fb9
  (with the coordinator's T-416 supervisor commits merged in; pack regenerated).
- T-404 merged a690f49 (QA PASS WITH GAPS 3325; hook = second layer, decision 3314; primary layer = T-451); gate GREEN (gate-job a690f49-5383).

## IN FLIGHT
- Integration 7f86942 pushed: T-378 S1 + coordinator cc4be7a (gate GREEN 7f86942-e17c).
- Integration 2c500bd pushed: T-376 S2 merge + pack (gate GREEN 2c500bd-daec; proof structural only, gaps -> S3, comment 3464).
- T-460 e9834bc QA round 2 PASS (3535, Jobs 82567c2a + 4db696d8 proof): merge with T-450 S1a after gate 2c500bd; f646e77b ended; fee31b8a (qa, sonnet) kept for S1b QA.
- T-449 UX: db9cedfd NOT VERIFIED (3540: main folder dist stale, job-run refused there). Re-run as a Job by cf7d2801 (ux-checker, sonnet, satria) in worktree qa/t-449-ux with a harness tools/qa/attribution-tab.mjs.
- T-450 S1a 858c4c5 QA PASS WITH GAPS (3513): merge after gate 2c500bd is green (decision 3514). Verifier af18baca and implementer a8412b0f ended.
- T-450 S1b: 3ffbc3e1 (implementer, opus, alfian.isnan) on dev/t-450-2 (base dev/t-450-1), with the S1a gaps in scope.

## STATE PER TICKET
- T-404: third blind review gave NO verdict (declined probes, design point -> T-451); fixes verified 3325; open until deployed.
- T-376 (high): S1 deployed; S2 NOT DONE: dev/t-376-3 0b0faf7 needs integration merged in (the lead's job: dontAsk refused merge), then
  a ux re-check that counts page reads in a production build, then S3 perf-tester.
- T-378 S1 dev/t-378-1 9834ff7 ready (qa tools only): needs a verifier.

## DEPLOY
- Done: run 33 (4th today, comment 3120 on T-375). Integration now 028f7a1 (T-427, T-413, T-404, release merge-back).
- Next batch (2026-10-16): T-427, T-404, T-376 S2 if they pass.

## DECISIONS (binding)
- 05:50 UX checks run as cluster Jobs from a fresh worktree (build + with-portal in the Job), never from the main folder: its dist is stale and job-run is refused there.
- 05:30 Ended a8412b0f (T-450 S1a done) so T-460's re-verify could start at once within the 3-worker cap; af18baca stays on T-450 QA.
- 05:04 T-459 closed: the coordinator fixed the trust scan (cc4be7a; next deploy rebuilds the workspace image) and the 5 stale
  spares were removed (job-out archived to job-out/archive/). New slices get FRESH worktrees from integration, never old spares.
- 05:04 claude auto put an opus worker on fadlilah (projected 91 % at the 06:40 reset): ended it, respawned on alfian.isnan by
  name (T-460 comment 3436). Name the Claude for opus slices until T-460 ships.
- 04:44 T-449 merged (QA 3316, 3375) before its AttributionTab UX check: spares untrusted, T-450 S1a needs ticketCost; UX runs
  from the main folder before the 2026-10-16 deploy (comment 3380). CSV ignores done -> T-450 S2; crew_metrics.py -> T-450.
- 04:50 Spares answer FOLDER_UNTRUSTED (settings changed with the T-404 hook): T-459 to the coordinator; main folder for read-only only.
- 04:12 Resumed: no unmerged good work beyond dev/t-375-1 (merged), dev/t-427-1 and dev/t-404-1 (in QA/fix); every other worktree is 0 ahead
  (dev-t118-login and dev-t293-7 1 ahead each: old, left). Deploy now per the coordinator (see DEPLOY).
- Quota 04:10: fadlilah session 50 %, projected 105 % at 06:40 reset: workers go to claude auto (satria, alfian.isnan), no new opus slice on fadlilah.
- D-63: verifier/ux/reviewer on SONNET; opus only for blind reviews of gate/rule/security changes and large implementer slices; REUSE a live
  role session via session_message; the lead never implements or commits code (merges and status only); close on QA PASS + merge.
- D-61: at most 3 live workers, NO Agent-tool sub-agents, heavy work ONLY via scripts/job-run.sh or gate-job.sh.
- Hand over before 250k context (coordinator).

## NEEDS A HUMAN (D-62)
- T-93 Konfersi production only. Coordinator items: T-397, T-422 (sudo), T-306 item 4 / T-340; D-row for T-417's Bypass across sleep;
  T-433's persona-wall question (comment 2984).

## NEXT (in order, as slots free)
0. Merge T-450 S1a (858c4c5) + T-460 (e9834bc), pack, gate, push. Then T-472 (high, cost: context-only deliveries never restart
   sessions; debounce; path-scope the pack) right after T-449/T-450 S1, before new features (coordinator 05:3x; pool off since 05:29).
1. Deploy watch; then merge T-427 (QA 3126) + T-413 (dev/t-413-2 28f1a00, QA 3138; gaps -> T-448), pack, gate.
2. Coordinator order (04:16): T-449 (spawn takes ticket; small) -> T-450 S1 (crew scorecard server + MCP tool, opus implementer,
   sonnet QA) -> T-450 S2 (page, phone first). Worker titles start with "T-n" until T-449 ships.
3. T-404 fixer (running). T-376 S2: integration merged (4697ac8), ux re-check (sonnet). 4. T-435 (portal:worktree
   trust copy). 5. T-416 (memory budget), T-422 build, T-147. 6. T-438, T-425, T-436, T-437, T-432, T-378 S1 verify + S2-S4, T-382, T-377,
   T-386, T-409, T-402, T-398, T-399. 7. T-370 HOLD, then T-371..T-374, T-363. 8. T-365 rest, T-354, T-347, T-350, T-351, T-355, T-356,
   T-388, T-341, T-344, T-345, T-332, T-335, T-313, T-314, T-306 item 3, T-149.

LESSONS: a gate-done notification always needs action (read the verdict, push or fix), never "no response"; never chain a commit after a merge that may conflict; dontAsk workers cannot Read /tmp (job-out/ inside the worktree) and cannot
git merge; end job-run commands with the test's own rc; FULL hashes with job-run; gate before every integration push.
