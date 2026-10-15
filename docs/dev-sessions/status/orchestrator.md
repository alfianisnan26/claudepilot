# orchestrator status (2026-10-15 08:15 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file. Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- Integration 77ad393 (gate GREEN, Job claudepilot-gate-77ad393; flaky on rerun: repos/actions, repos/live -> T-512) pushed origin+pilot:
  T-435 (review 3974, QA 4015, gaps T-507), T-397 (review 4027, QA 4048, gaps T-508), T-491 (reviews 3959/4046, QA 4110), release merge-back fac68c4.
  Candidates gated on the way: 0594c99 green, a2b6ce5 green (limits.test.ts flaky -> T-512).
- DEPLOYED run #35 rmv97lowgb5d2fc (98e6de4, portal 2026.10.15-6): T-449, T-450 S1b+S2, T-472 S1+S2, T-476.
- T-476 CLOSED (live: Event run #18 rmv98eb24ebf4b2 via T-467). T-449 CLOSED (QA 4155: Jobs 1874be50, aa4ff157).

## IN FLIGHT (3 of 3 workers)
- T-483 (urgent; 4057): 8ca232d (impl 4105) + blind review 93b26659 PASS WITH CONDITIONS (4123; D-62 met); decision 4126/4138.
  Slice 999d9653 (impl-t483-2, sonnet, alfian.isnan) on dev/t-483-2 from 8ca232d: FR12 docs, audit row for allowed person assignments,
  + T-509 (4146): kit bootstrap line 19, Needs-you shows open `owner-checklist` tickets. DONE d2dcd92 (4191; 172/172 Job 7ace90e8;
  typecheck 6d53be3f; proof f3b2f879); 999d9653 ended. QA 0b695a8d PASS WITH GAPS (4207; 246/246 Job 7a6bbbf0; typecheck 4bc9caea); ended.
  MERGED: integration c0837f7 (merge 4103c8f + pack), gate GREEN (Job claudepilot-gate-c0837f7-a5af; repos/actions flaky -> T-512), pushed.
  Deploy run started 08:3x (gate on); close after a live refusal by a fresh worker. Kit republish = owner (T-509).
- T-515 (high; 4211: M, sev 2, ~2.5 h): S1 52f95911 (implementer, opus, rossi) on dev/t-515-1 from be31491: last-known workspaces
  `unavailable` + reason + last good time, store-backed; bounded kube list; UI InfoTip 390/1280. Then QA (sonnet) + ux-checker.
- T-486 (L; 4020): S1 c670297 (4124), blind review 4cbf90d2 PASS WITH CONDITIONS (4161; D-62 met). Decision 4171: sync off the CI poll path,
  first-sync baseline, no proxy/insteadOf; allow-list setting -> S2. Fixer f83c384d DONE 3ab6e6e (4212; 269/269 + byte-equal runner Job 6c8469a6;
  typecheck 885cfdcf; proof ef980ac1); ended. QA 3c99ce95 PASS WITH GAPS (4228; 269/269 Job 30caf490;
  runner byte-equal f6f38cad); ended. Decision 4231: URL change must reset the baseline (fix df6dc0c7, sonnet, dev/t-486-3 from 3ab6e6e;
  lead reads the diff); attention for failing sync -> S2. Then merge (pack by lead). S2: webhook + real Event check.
- T-490 (4166: M, ~2.5 h): S1 DONE 18dadd3 (4213; server 1000/1000 Job 63f3ddd1; web 626/626 b00ac52f; typecheck 9453d4fb on 3b0070c;
  proof 93946bb7; migration 777, no clash with T-486's 782); 80940188 ended. Blind review d74ad0bc PASS WITH CONDITIONS (4227; major:
  `model:'default'` passes the gate); ended. Decision 4229: allow-list (only sonnet/haiku without why); minors -> follow-up ticket.
  Fixer bbe851a2 DONE c8c8197 (4259; chat+personas+portalmcp 821/821 Job ab99d109; typecheck 36a333e4; proof d0c6fb7f); lead read the
  diff (BELOW_OPUS_MODEL allow-list, agents.ts ~199-226); ended. QA 429def59 (sonnet, two.claude) on qa/t-490-1 at c8c8197. Minors -> T-520.
- T-472: live check NOT VERIFIED (4157, 4168): needs a verifier WITH portal_status/session_context/attention_list (check its tools first).
- T-435, T-397, T-491: merged; close after the next deploy (live checks per ticket).

## STATE PER TICKET
- T-404: third blind review gave no verdict (design point -> T-451); fixes verified 3325; open until deployed.
- T-376 (high): S2 dev/t-376-3 0b0faf7 needs integration merged in by the lead, then ux re-check (production build), then S3 perf-tester.
- T-378 S1 dev/t-378-1 9834ff7 ready (qa tools only): needs a verifier.
- T-450: S3 (gaps 3902) and the 5 % real-data check.

## DECISIONS (binding)
- 08:15 77ad393 merged ff (origin/integration fac68c4 was an ancestor). Next deploy after T-483 merges (with T-435, T-397, T-491).
- 08:10 Coordinator: T-515 (high) right after T-483; T-490 S1 already running keeps its slot (no preemption).
- 07:58 Coordinator: T-509 folded into the T-483 slice. Kit republish (publish.mjs --apply) is the owner's step (docs/kit/README.md:25).
- 07:56 T-483: one QA on the slice head instead of QA on 8ca232d plus again after the slice (3-worker limit).
- 06:46 Coordinator: limit 3, no sub-agents; queue T-491, T-397, T-486, T-483, T-490, then T-450 S3, T-416, T-422, T-147.
- 06:26/05:55 Supervisor says five workers; D-61 (3) is the standing row and wins.
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
- Owner checklist (not blocking): T-476 reading that a lead may START a deploy pipeline whose release waits for a person (3813);
  T-491 Event Jobs use the workspace token scoped to isnanme/event until T-426 (3965); deploy #35 production approval showed "auto"
  (protection off?), not changed by an agent; T-509 after the T-483 merge: run `node docs/kit/publish.mjs --only=contexts` (dry, read it),
  then with `--apply`.

## NEXT (in order, as slots free)
1. Deploy #36 (gate on) -> live checks T-435, T-397, T-491, T-483 (+ T-472) by a verifier WITH portal tools; close.
2. T-486 lead reads df6dc0c7's diff; merge. 3. T-490 merge on QA PASS. 4. T-515 QA + ux-checker. 5. Remove wip-t483-premerge.
7. T-450 S3, T-416, T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-378 S1 verify, T-382, T-377, T-386, T-409, T-402, T-398, T-399,
   T-370 HOLD, T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512.

LESSONS: a gate-done notification always needs action (read the verdict, push or fix); dontAsk workers cannot Read /tmp or git merge;
end job-run commands with the test's own rc; briefs run the module's WHOLE test folder; trailers in ONE block, no blank lines; FULL
hashes with job-run; gate before every integration push; a spawn that times out may still have started: check its worktree before retrying.
