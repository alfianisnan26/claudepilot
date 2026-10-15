# orchestrator status (2026-10-15 09:49 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file. Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- MERGED ff b37628e (T-515 e021cb6 + T-527 ea81071 + packs). Gate GREEN claudepilot-gate-b37628e-0953 (typecheck 57 s, web-build 35 s,
  suite 504 s, memory peak 2189Mi of 8192Mi, 0 OOM) + web 629/629 (claudepilot-job-a19b47c9). NOT deployed.
- MERGED ff 4ba5d37 (pushed origin+pilot, status 44eb2c8): T-490 c8c8197 + T-450 S3 7f7f18c + T-524 S1 d44bf24 + pack. Gate GREEN
  (/tmp/gate-job-4ba5d37.out: typecheck, web-build, suite 460 s) + web 626/626 (claudepilot-job-d3ad6cc3). NOT deployed (4419, 4420).
- MERGED 73bb581: T-486 (gate green claudepilot-gate-73bb581-463a; 4348). NOT deployed.
- DEPLOYED run #36 rmv9a3nvq86f5b0 (8062398, portal 2026.10.15-7), all jobs passed incl. chats. CLOSED T-483, T-397, T-491, T-435.
- DEPLOYED run #35 (98e6de4): T-449, T-450 S1b+S2, T-472 S1+S2, T-476. CLOSED T-476, T-449.

## IN FLIGHT (3 of 3 workers: e88db594 T-524 S2 QA (GO, has the slot), 74a6ee0e T-531 S1 df65563 WAITING, ad68c3a4 T-416 S1 4ba2d69 WAITING)
- T-416 (high incident; claimed, 4439: L, sev 2, ~5 h): S1 ad68c3a4 (opus, impl-t416) on ticket/T-416-memory-budget from 44eb2c8:
  portal-enforced budget (anon+active_file vs memory.max, 350 MB/session, +1 per sub-agent, 1.5 GiB headroom), 85% attention +
  push (top RSS, names only). c8ee3ea/0af9501 were rules only. S2 = Bypass restore, own slice + blind review (gates unchanged).
- T-515 (high): S1 5846cf5 + S2 e021cb6. QA 7d58ad7b (S1) and 4639c198 (S2, 4418: server 1371/1377 0 fail b466a4d8; web 6/6)
  PASS WITH GAPS; ended. Decision 4424: merge. CANDIDATE b37628e (wip/main-b37628e) = 44eb2c8 + T-515 e021cb6 + T-527 ea81071
  + pack: lead gate + web suite queued -> ff. Gap 1 (routes without can()) -> T-531. Remove refused while unavailable: noted for the owner.
- T-531 (high, authz; claimed, 4427: M, sev 2, ~2 h): S1 74a6ee0e (opus, impl-t531) on ticket/T-531-workspace-route-authz from
  44eb2c8: declare every /api/workspaces route in WORKSPACE_POLICIES + a no-undeclared-route test. Then blind review (opus) + QA.
- T-527 (high): S1 b998fbc; blind review 1382b13a PASS WITH CONDITIONS (4415, no bypass). Decision 4417: S2 cc9740c3 DONE ea81071
  (4430; 259/259 4daa2852; typecheck 2c788396; no proof yet); ended. QA abfb598e (sonnet, qa-t527): proof vs edf9992, can an
  agent forge a `user:` event actor. QA PASS WITH GAPS (4435; proof a0bedfd7; 259/259 2e2dc796); ended. In candidate b37628e.
  Doc gap: tickets.md "Needs you" names only `ui`, add `user:<name>` (next tickets-docs slice).
- T-524 (high): S1 merged (4397). S2 53e546b0 DONE 0fbc6be (4416; src/ci 174/174 a0d203c2; proof 9d596ff1): gate-job Pending report,
  `memory peak=` line, "No space left" hint; ended. Blind review df797f3d PASS WITH CONDITIONS (4440: 4 minors; ended).
  Decision 4442: QA e88db594 (sonnet, qa/t-524-2) re-runs src/ci + proof, then lead gate, merge. Open: master under 85% measured (T-513 cluster).
  Event Jobs over 4Gi need --big (tell Event).
- T-490: merged; close after deploy + live check that a QA spawn with no model gets sonnet. Gaps -> T-520.
- T-450: S3 merged; 5 % real-data check + harness assertions (4354) still open.
- T-486: merged; close after deploy + S2 (attention for a failing sync, webhook, real Event check).
- T-472: live paths/restarts/pool re-assign NOT VERIFIED (4294). Retry with the new read tools.
- T-525 (mine): QA and reviewer have 5 of 6 read tools; session_get MISSING (4362, coordinator decides).

## STATE PER TICKET
- T-404: third blind review gave no verdict (design point -> T-451); fixes verified 3325; open until deployed.
- T-376 (high): S2 dev/t-376-3 0b0faf7 needs integration merged in by the lead, then ux re-check (production build), then S3 perf-tester.
- T-378 S1 dev/t-378-1 9834ff7 ready: needs a verifier.

## DECISIONS (binding)
- 10:02 The free-slot check counts only OUR program's Jobs (labels app=claudepilot-gate or job-run/program=claudepilot). Konfersi Jobs
  (4f43f1f9, a9eb0c7a) are capped per program by job-run.sh. Re-launched the gate b37628e as buobugd21; workers take turns after it.
- 09:49 Deploy waits for the T-515 merge (one deploy for T-486, T-490, T-450 S3, T-524 S1, T-515).
- 09:43 Brief error: server and web tests are node --test (npm test), not vitest. All workers corrected; vitest Jobs are no evidence.
- 09:12 Workers cannot run scripts/gate-job.sh (refused in dontAsk): the lead runs gates for slices; briefs say so.
- 09:05 Coordinator pushed eac20db/82cee3c straight to integration (no trailers); my candidate was re-merged and re-gated (4331).
- 09:00 Coordinator: persona, role-tool and permission questions go to the coordinator (ticket assigned to me), NEVER the owner;
  `owner-checklist` is production only. T-527 (high) closes the tag loophole.
- 08:50 Coordinator: T-524 right after T-515, placement coordinated with T-513 (runner anti-affinity = cluster GitOps MR, own ticket).
- 08:10 A running slice keeps its slot (no preemption).
- 06:00 The lead holds T-n from claim to close so verifiers can comment.
- 05:55 A5 binds touch targets at 390 px; under 44 px at 1280 is a note. Fix shared controls at the cause.
- 05:50 UX checks run as cluster Jobs from a fresh worktree. 05:04 New slices get FRESH worktrees from integration.
- D-63: QA/ux/reviewer on SONNET; opus for blind reviews of gate/rule/security changes and large slices; the lead never implements or
  commits code (merges and status only); close on QA PASS + merge (+ deploy).
- D-61: at most 3 live workers, NO Agent-tool sub-agents, heavy work ONLY via scripts/job-run.sh or gate-job.sh, one at a time.
- Hand over before 250k context (coordinator).

## NEEDS A HUMAN (D-62)
- T-93 Konfersi production only. Coordinator items: T-422 (sudo), T-306 item 4 / T-340; D-row for T-417's Bypass across sleep;
  T-433's persona-wall question (2984).
- For the coordinator, NOT the owner (not tagged owner-checklist): T-476 lead may START a deploy whose release waits for a person
  (3813); T-491 Event token scope until T-426 (3965); deploys #35/#36 production approval showed "auto", not changed by an agent;
  T-509 kit republish; T-525 session_get; T-527 finding 4 (owner triggers tagging owner-checklist without production are not listed).

## NEXT (in order, as slots free)
1. Gate 2d3fe38 (T-515) -> ff. 2. Deploy (gate on): T-486, T-490, T-450 S3, T-524 S1, T-515; live checks (T-486, T-490, T-472).
3. T-524 S2 on review PASS -> QA (sonnet) -> merge. 4. T-527 S2 -> lead gate, QA. 5. T-531 review + QA.
6. T-513 (cluster GitOps MR). 7. T-416 S1 review + QA, then S2. T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-378 S1 verify, T-382, T-377, T-386, T-409,
   T-402, T-398, T-399, T-370 HOLD, T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512, T-520; T-376 S2.

LESSONS: server and web tests run with `node --import tsx --test '<glob>'` (npm test), NEVER vitest; a gate-done notification always
needs action; dontAsk workers cannot Read /tmp, git merge or run gate-job.sh; end job-run commands with the test's own rc; briefs run
the module's WHOLE test folder; trailers in ONE block; FULL hashes with job-run; gate before every integration push; a timed-out spawn
may still have started; the status file is edited with Edit/Write only (D-60 hook); check the ancestor right before the ff;
dontAsk workers CANNOT wait (sleep, Monitor and kubectl wait are refused): the lead hands out the slot with "GO T-n" messages.
Queue after the gate b37628e and the web suite: GO T-524 QA, then T-531, then T-416.
