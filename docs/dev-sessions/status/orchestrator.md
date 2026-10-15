# orchestrator status (2026-10-15 08:57 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file. Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- DEPLOYED run #36 rmv9a3nvq86f5b0 (8062398, portal 2026.10.15-7), every job passed incl. chats (11 attached survived).
  CLOSED: T-483 (live D-62 refusal 08:54 by the lead's ticket_update), T-397 (live comments 4294/4295), T-491 (live Event Job
  claudepilot-job-62b9473b rc 0), T-435 (live trust NOT VERIFIED: no tools, T-525). Owner's Needs-you view not verified (agent view only).
- DEPLOYED run #35 (98e6de4): T-449, T-450 S1b+S2, T-472 S1+S2, T-476. CLOSED T-476, T-449.

## IN FLIGHT (3 of 3 workers: 86ebe26c T-524, 307f16d0 T-515 S2, ff736eb0 T-450 S3 QA)
- T-450 S3: 621d958a DONE 7f7f18c (icons on phones, Sources tip, "N warn"; decision 4337; web 569/569 + typecheck 171656e9; proof
  128ef1df; harness 2d6af7e1); ended. QA ff736eb0 (no model given: role default; step 0 lists tools = T-525 proof) on qa/t-450-3.
  5 % real-data check later.
- T-524 (high; 4284): S1 86ebe26c BLOCKED at d44bf24 on ticket/T-524-job-memory (4347): gate-job.sh refused in dontAsk workers.
  Measured peaks: server suite 1480Mi (job 4c34ebf9). job-run 4Gi=4Gi (/tmp 2Gi), --big 8Gi; gate 8Gi=8Gi; browser 6Gi=6Gi (not
  measured). Weight "above the portal rule" impossible (scores are normalised, 4329); control-plane DoesNotExist preferred w100.
  src/ci 123/123 (3ef51d2a). Lead runs the gate on d44bf24; then blind review (opus) + QA. Event Jobs over 4Gi need --big (tell Event).
- T-515 (high; 4211): S1 52f95911 DONE 5846cf5 (4277; server 832/835 0 fail; web 112/112; typecheck; proof; UI harness + shots
  job-out/t515-art2); ended. QA+UI 7d58ad7b PASS WITH GAPS (4314/4334; 1059/1066 0 fail fc0f314c; web 628/628 + typecheck
  5c7ff3db; harness 44/44); ended. Decision 4335: fix round. S2 307f16d0 (sonnet, sekar) on dev/t-515-2 from 5846cf5: reason once,
  server refuses runtime actions on unavailable at once, list wait <= ~8 s, bad stored element skipped, screenshots back. Lead reads, merges.
- T-486 (L; 4020): S1 c670297 (4124), blind review 4cbf90d2 PASS WITH CONDITIONS (4161; D-62 met). Decision 4171: sync off the CI poll path,
  first-sync baseline, no proxy/insteadOf; allow-list setting -> S2. Fixer f83c384d DONE 3ab6e6e (4212; 269/269 + byte-equal runner Job 6c8469a6;
  typecheck 885cfdcf; proof ef980ac1); ended. QA 3c99ce95 PASS WITH GAPS (4228; 269/269 Job 30caf490;
  runner byte-equal f6f38cad); ended. Decision 4231: URL change must reset the baseline. Fixer df6dc0c7 DONE f99c49f (4271; ci+runner+store 183/183;
  proof 8 pass/2 fail on old code; regen byte-equal); lead read the diff; ended. Merged 507e867 + pack 55f9cf3: gate GREEN
  (claudepilot-gate-55f9cf3-297d), but the coordinator's eac20db/82cee3c (persona, no trailers; 4331) landed on integration first ->
  re-merged as 73bb581, gate GREEN (claudepilot-gate-73bb581-463a), MERGED ff into integration, pushed. Close after deploy + S2. Attention for failing sync -> S2 (webhook + real Event check).
- T-490 (4166: M, ~2.5 h): S1 DONE 18dadd3 (4213; server 1000/1000 Job 63f3ddd1; web 626/626 b00ac52f; typecheck 9453d4fb on 3b0070c;
  proof 93946bb7; migration 777, no clash with T-486's 782); 80940188 ended. Blind review d74ad0bc PASS WITH CONDITIONS (4227; major:
  `model:'default'` passes the gate); ended. Decision 4229: allow-list (only sonnet/haiku without why); minors -> follow-up ticket.
  Fixer bbe851a2 DONE c8c8197 (4259; chat+personas+portalmcp 821/821 Job ab99d109; typecheck 36a333e4; proof d0c6fb7f); lead read the
  diff; ended. QA 429def59 PASS WITH GAPS (4276; 922/929 0 fail Job f1a33926; typecheck fde5ef09; web 8af499a3); ended.
  Decision 4292: merge c8c8197 after the T-486 gate; gaps (why redaction probe, 777 upgrade, ScorecardTab 390) -> T-520.
- T-472: live paths/restarts/pool re-assign NOT VERIFIED: qa-verifier role has only ticket_get/ticket_comment (4294) and an agent's
  portal_status has no paths. Stays open; retry with the new read tools (T-525).
- T-525 (mine): coordinator gave qa-verifier/reviewer read tools (persona rev 09:04). Close when the next fresh QA lists them in step 0.

## STATE PER TICKET
- T-404: third blind review gave no verdict (design point -> T-451); fixes verified 3325; open until deployed.
- T-376 (high): S2 dev/t-376-3 0b0faf7 needs integration merged in by the lead, then ux re-check (production build), then S3 perf-tester.
- T-378 S1 dev/t-378-1 9834ff7 ready (qa tools only): needs a verifier.
- T-450: S3 (gaps 3902) and the 5 % real-data check.

## DECISIONS (binding)
- 09:00 Coordinator: persona, role-tool and permission questions go to the coordinator (ticket assigned to me), NEVER the owner;
  `owner-checklist` is production only (my T-525 tag was wrong). T-527 (high) closes the tag loophole.
- 08:50 Coordinator: T-524 (high, Job memory on k3s-master) right after T-515, placement coordinated with T-513. Read the manifests:
  /tmp already has sizeLimit 3Gi (job-run.yaml:143); the gap is request 2Gi vs limit 8Gi (scheduler sees 2Gi), and gate-job.yaml:71 and
  browser-job.yaml:28 have the same overcommit -> one slice covers all three. Plan on claim: request ~= limit (4Gi, a flag for 8Gi that
  prefers node2), node preference by free memory weighted above the portal rule, per-program Job count in job-run.sh's caps. T-513's
  runner anti-affinity is a cluster GitOps MR (outside this repo) and stays its own ticket. A slice of opus + blind review (gate change, D-63).
- 08:15 77ad393 merged ff (origin/integration fac68c4 was an ancestor). Next deploy after T-483 merges (with T-435, T-397, T-491).
- 08:10 Coordinator: T-515 (high) right after T-483; T-490 S1 already running keeps its slot (no preemption).
- 07:58 Coordinator: T-509 folded into the T-483 slice. Kit republish (publish.mjs --apply) is the owner's step (docs/kit/README.md:25).
- 06:46 Coordinator: limit 3, no sub-agents; queue T-491, T-397, T-486, T-483, T-490, then T-450 S3, T-416, T-422, T-147.
- 06:00 An ended implementer's ticket returns to the queue: the lead holds T-n from claim to close so verifiers can comment.
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
1. T-524 gate d44bf24 (lead runs it: gate-job.sh refused to workers) -> blind review (opus) + QA. 2. T-490 merge + gate. 3. Next deploy after T-486/T-490/T-515 merge.
4. T-515 merge on QA PASS. 5. T-524 blind review (opus) + QA after S1. 5b. T-527 (high: owner-checklist tag by an agent needs `production`, D-62; authz-like
   rule -> opus implementer + blind review) on the next free implementer slot. 6. T-513 (cluster GitOps MR) after T-524. 7. T-450 S3, T-416, T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-378 S1 verify, T-382, T-377, T-386, T-409, T-402, T-398, T-399,
   T-370 HOLD, T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512.

LESSONS: a gate-done notification always needs action (read the verdict, push or fix); dontAsk workers cannot Read /tmp or git merge;
end job-run commands with the test's own rc; briefs run the module's WHOLE test folder; trailers in ONE block, no blank lines; FULL
hashes with job-run; gate before every integration push; a spawn that times out may still have started: check its worktree before retrying;
the status file is edited with Edit/Write only (a shell edit is refused by the D-60 hook).
