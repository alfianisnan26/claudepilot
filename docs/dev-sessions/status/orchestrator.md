# orchestrator status (2026-10-15 09:14 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file. Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- Integration edf9992 (T-486 at 73bb581, gate GREEN claudepilot-gate-73bb581-463a; earlier 55f9cf3 green) pushed origin+pilot.
- DEPLOYED run #36 rmv9a3nvq86f5b0 (8062398, portal 2026.10.15-7), every job passed incl. chats (11 attached survived).
  CLOSED: T-483 (live D-62 refusal 08:54 by the lead's ticket_update), T-397 (live comments 4294/4295), T-491 (live Event Job
  claudepilot-job-62b9473b rc 0), T-435 (live trust NOT VERIFIED: no tools, T-525). Owner's Needs-you view not verified (agent view only).
- DEPLOYED run #35 (98e6de4): T-449, T-450 S1b+S2, T-472 S1+S2, T-476. CLOSED T-476, T-449.

## IN FLIGHT (3 of 3 workers: cc9740c3 T-527 S2, 4639c198 T-515 S2 QA, df797f3d T-524 S2 review)
- T-524 S2 53e546b0 DONE 0fbc6be (4416; src/ci 174/174 node --test a0d203c2; proof 9d596ff1 2 fail on d44bf24); lead read
  gate-job.sh (memory line printed by gate-job.yaml:74, so only after the merge); ended. Blind review df797f3d (opus).
- MERGED ff 4ba5d37 = T-490 c8c8197 + T-450 S3 7f7f18c + T-524 S1 d44bf24 + pack: gate GREEN (typecheck, web-build, suite 460 s,
  /tmp/gate-job-4ba5d37.out) + web 626/626 (claudepilot-job-d3ad6cc3). Not yet deployed.
- T-527 S1 545a8674 DONE b998fbc (215/215 + typecheck d8a3439c; proof 941d01e9); lead read authz/service; ended. Blind review
  1382b13a PASS WITH CONDITIONS (4415, no bypass); ended. Decision 4417: S2 cc9740c3 (sonnet, impl-t527-2) on
  ticket/T-527-owner-checklist-tag-2: token-for-session audit, 4 tests, `user:` actor, spacing. Then lead gate + QA.
- T-515 S2 307f16d0 DONE e021cb6 (4393; server 865/869 0 fail d94066b2; web 112/112; proof f1406b48); lead read manager.ts (4396);
  ended. QA 4639c198 (sonnet, qa-t515-2). Merge on PASS in its own candidate.
- T-524 blind review 55a7fbc9 PASS WITH CONDITIONS (4372); ended. Decision 4379: merge S1 on a green gate; S2 53e546b0 (opus,
  hasyim, impl-t524-2) on ticket/T-524-job-memory-2 from d44bf24: gate-job.sh Pending report, "No space left" hint, shm doc.
  Master under 85% measurement stays open (T-513 cluster config).
- T-524 (high; 4284): S1 86ebe26c BLOCKED at d44bf24 (ticket/T-524-job-memory, 4347): gate-job.sh refused in dontAsk workers; ended.
  Peaks: server suite 1480Mi (job 4c34ebf9). job-run 4Gi=4Gi (/tmp 2Gi), --big 8Gi; gate 8Gi=8Gi; browser 6Gi=6Gi (not measured).
  "Weight above the portal rule" impossible (normalised scores, 4329); control-plane DoesNotExist preferred w100. src/ci 123/123 (3ef51d2a).
  LEAD gate on d44bf24 running (memory peak line sizes the gate). Then blind review (opus) + QA. Event Jobs over 4Gi need --big (tell Event).
- T-515 (high; 4211): S1 DONE 5846cf5 (4277). QA 7d58ad7b PASS WITH GAPS (4314/4334; fc0f314c 1059/1066 0 fail; 5c7ff3db web 628/628 +
  typecheck; harness 44/44). Decision 4335: fix round S2 307f16d0 (sonnet, sekar) on dev/t-515-2: reason once, server refuses runtime
  actions on unavailable at once, list wait <= ~8 s, bad stored element skipped, screenshots back. Lead reads the diff, merges.
- T-450 S3: 621d958a DONE 7f7f18c (icons on phones, Sources tip, "N warn"; 4337; web 569/569 + typecheck 171656e9; proof 128ef1df;
  harness 2d6af7e1); ended. QA ff736eb0 PASS WITH GAPS (4354, sonnet by role default); ended. In candidate. 5 % real-data later.
- T-490: fix c8c8197 (4259); QA 429def59 PASS WITH GAPS (4276; f1a33926 922/929 0 fail; typecheck fde5ef09; web 8af499a3).
  Decision 4292: merge c8c8197 next (after the d44bf24 gate: one heavy Job at a time); gaps -> T-520.
- T-486: merged (4348). Close after the deploy and S2 (attention for a failing sync, webhook, real Event check).
- T-472: live paths/restarts/pool re-assign NOT VERIFIED (4294: no tools). Retry with the new read tools (T-525).
- T-525 (mine): ff736eb0 step 0 has 5 of 6 read tools; session_get MISSING (4362, coordinator decides). Reviewer proof: 55a7fbc9.

## STATE PER TICKET
- T-404: third blind review gave no verdict (design point -> T-451); fixes verified 3325; open until deployed.
- T-376 (high): S2 dev/t-376-3 0b0faf7 needs integration merged in by the lead, then ux re-check (production build), then S3 perf-tester.
- T-378 S1 dev/t-378-1 9834ff7 ready (qa tools only): needs a verifier.

## DECISIONS (binding)
- 09:12 Workers cannot run scripts/gate-job.sh (refused in dontAsk): the lead runs gates for slices; briefs say so.
- 09:05 Coordinator pushed eac20db/82cee3c straight to integration (no trailers); my gated candidate was re-merged and re-gated (4331).
- 09:00 Coordinator: persona, role-tool and permission questions go to the coordinator (ticket assigned to me), NEVER the owner;
  `owner-checklist` is production only (my T-525 tag was wrong). T-527 (high) closes the tag loophole.
- 08:50 Coordinator: T-524 right after T-515, placement coordinated with T-513 (runner anti-affinity = cluster GitOps MR, own ticket).
- 08:10 Coordinator: T-515 (high) right after T-483; a running slice keeps its slot (no preemption).
- 07:58 Kit republish (publish.mjs --apply) is not an agent step (docs/kit/README.md:25); now the coordinator's (09:00 rule).
- 06:46 Coordinator: limit 3, no sub-agents.
- 06:00 The lead holds T-n from claim to close so verifiers can comment.
- 05:55 A5 binds touch targets at 390 px; under 44 px at 1280 is a note. Fix shared controls at the cause.
- 05:50 UX checks run as cluster Jobs from a fresh worktree, never from the main folder.
- 05:04 New slices get FRESH worktrees from integration, never old spares.
- D-63: QA/ux/reviewer on SONNET; opus for blind reviews of gate/rule/security changes and large slices; the lead never implements or
  commits code (merges and status only); close on QA PASS + merge (+ deploy).
- D-61: at most 3 live workers, NO Agent-tool sub-agents, heavy work ONLY via scripts/job-run.sh or gate-job.sh.
- Hand over before 250k context (coordinator).

## NEEDS A HUMAN (D-62)
- T-93 Konfersi production only. Coordinator items: T-422 (sudo), T-306 item 4 / T-340; D-row for T-417's Bypass across sleep;
  T-433's persona-wall question (2984).
- For the coordinator, NOT the owner (09:00 rule; on the tickets, not tagged owner-checklist): T-476 reading that a lead may START a
  deploy whose release waits for a person (3813); T-491 Event token scope until T-426 (3965); deploys #35/#36 production approval
  showed "auto", not changed by an agent; T-509 kit republish (`node docs/kit/publish.mjs --only=contexts`, dry, then `--apply`).

## NEXT (in order, as slots free)
1. Gate d44bf24 -> T-524 QA (sonnet) after review. 2. Gate candidate b9f077e (T-490 + T-450 S3). 3. T-515 S2 -> lead reads, merge.
4. T-527 lead gate, review + QA. 6. Deploy (gate on) with T-486, T-490, T-515, T-450 S3, T-524; live checks.
7. T-513 (cluster GitOps MR) after T-524. 8. T-472 live retry. 9. T-416, T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-378 S1
   verify, T-382, T-377, T-386, T-409, T-402, T-398, T-399, T-370 HOLD, T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512, T-520.

LESSONS: server and web tests run with `node --import tsx --test '<glob>'` (npm test), NEVER vitest (09:43 brief error, all
workers corrected); a gate-done notification always needs action (read the verdict, push or fix); dontAsk workers cannot Read /tmp, git merge or
run gate-job.sh; end job-run commands with the test's own rc; briefs run the module's WHOLE test folder; trailers in ONE block; FULL
hashes with job-run; gate before every integration push; a spawn that times out may still have started: check its worktree first;
the status file is edited with Edit/Write only (D-60 hook); check origin/integration is an ancestor right before the ff.
