# orchestrator status (2026-10-16 15:00 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file (2026-10-15 DONE batches 1-7: see 4fbab374). Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- BATCH 23 ON INTEGRATION f2843f2e (gate claudepilot-gate-8eeef66-b31a GREEN on 8eeef663; f2843f2e = that + status only):
  T-781 S1-S7 (lead's mechanical index.ts resolution; decision 8094), T-733 S1 S4 S6. Coordinator told 8123.
- BATCH 22 ON INTEGRATION 0d521d67 (gate claudepilot-gate-0d521d6-7b1d GREEN): T-697, T-574 S3, T-731, r.txt drop, T-376 S4b,
  T-732, T-610 r3, T-739 B (mig 383), T-723 S3c. Coordinator told on T-731.
- DEPLOY 233 LIVE (portal 2026.10.16-2, b22). Its Releases/ note exists (coordinator: my search came early) -> QA UI re-reads 4
  notes, close T-591 on PASS. Live checks: coordinator runs them ("Coordinator live check" comments), close each on PASS.
  CLOSED on coordinator live PASS: T-697, T-739 (A split to T-812, coordinator), T-732, T-723. T-574 re-check after 10-17
  15:00Z (8265). T-376 open for S5. T-733 kept open (S5 + gap items, 8277). Ack 8237, 8279.
- BATCH 24B ON INTEGRATION b2932d0e (gate claudepilot-gate-b2932d0-16d9 GREEN, job-out/gate-b24c.log): T-401 S2b + S2c,
  T-736 S3c-S3e, release merge f921fc41. (d9df1221 also green; 0c86256e red, 8224.) Coordinator told on T-731. Deploy 243 LIVE (b23).
  On green + S2c QA: ff integration, tell coordinator on T-731. T-591 QA FAIL (backfill range base, store.ts:608; 8250).
- T-611 S1b..S2 80ffedea: QA done (8186, 8187 16/17) but NOT mechanical onto integration (T-731 --reuse; 8202) -> BE Infra resolves
  after S2b (lead starts the merge in its worktree; --reuse + --pool-env refused). QA UI pre-reads the merge risks.
- T-675 R2b FAIL (QA UI: apostrophe at memoryBudget.test.ts:330 breaks compile) -> Backend R2c. T-781 S8 DONE 543240b8 -> QA BE 2
  + review QA Perf.

## IN FLIGHT (6 of 6, D-71)
- QA PERF 8e8912fc (perf-tester/sonnet): T-426 S1h PASS 14/14 (8270). Now QA T-611 S2b 96d7c148 -> QA T-611 merge f722dca1.
- QA UI 8b13bb5a (no Write): T-772 S2 PWG (8336); T-611 S2b review APPROVE (8349); T-736 S3f review CHANGES 2 (8359);
  T-675 R2c PWG (Job b3f31fbc: each guard alone untested -> R2d; T-675 refuses comments, posted on T-416 8423).
  T-416 S2b 8382eb00 PWG (8445: :3218 untested -> S2c Backend; S2b to batch). Now blind review T-623 S2 (read only).
- QA BE 2 42e5408f (no Write): T-736 S3f PWG (8412 -> S3g); T-781 S8b PWG (8429: cascade -> S8c; S8+S8b batch, 8439).
  Now QA T-623 S2 4869e756 (lead read secrets diff 8438; rev 3 via API not editor until T-856).
- IMPL 46632d91 (sonnet): T-772 S2 DONE 188cd077. Now T-591 S3 lastReleased fix (ticket/T-591-s3 from b2932d0e) -> T-772 S2b
  (container marker, not tabindex -1) -> T-525 proposal draft.
- BE INFRA 16c2494f (sonnet): T-736 S3f a44c7cf8; T-611 merge f722dca1 DONE (8411, Job 112/112; pack stale, lead regenerates);
  T-623 S2 DONE 4869e756 (8418, 48/48, 2 mutants). Now T-736 S3g -> T-610 (8267) -> T-524 S3c + T-733 S5 -> T-612 S1.
- BACKEND 3484bd4d: DONE T-781 S8b e663b9e9 (Jobs 18d0360b, 02b167e7), T-675 R2c f7b4e34a (8ab9c4fa 22/22), T-416 S2b
  8382eb00 (e2a88c2e 11/11, 4 mutants). Now T-675 R2d (one test per guard) -> T-781 S8c -> T-416 S2c -> T-537 docs.
- AFTER T-401: T-426 S1h/S1e; T-379 S2 3f11b28 behind it. T-578 -> owner. T-631 -> coordinator (after this batch).

## DECISIONS (binding)
- 13:45 D-75 AMENDED (coordinator, 1444d836, checked in DECISIONS.md): the lead runs the gate before a merge (gate-job.sh, one per
  batch). Batch 19 rebuilt on 1444d836, then batch 21 = batch 20 + T-739 B + T-723 S3c. The 12:55 hold is superseded.
- 11:00 T-612 default A (pinned prettier/eslint devDeps, changed files only; quick-check must not say "passed" for a skipped step); FOR THE COORDINATOR 7592.
- 07:45 D-75 (coordinator): one Job per commit (checks chained), never the same command twice on a commit, QA reads the builder's log;
  the lead runs no Jobs but the merge gate (13:45); idle QA gets no-Job work (reviews, browser). T-731 -> BE Infra after T-697.
- 03:55 Lead false claim corrected: T-524 6775 said job 4d5cb657 proved the S3 patch; its log shows the rule at creation. 6788; incident T-721.
- 16:30 D-71 (coordinator): limit 6; 3rd build lane BE Infra (CI, runners, job-run, k3s, deploy, secrets delivery, usage, spend, quota):
  T-401, T-426, T-611, T-547, T-610. Backend: T-546, T-597, T-600 route, T-325. Spawn lanes with claude auto.
- 14:56 D-70 LANES (DECISIONS.md; my decision T-595 5380): freed slots become lanes, spawned ONCE on sonnet and fed
  by session_message, never ended for lack of work. Every delivery goes to its side's QA lane before merge. T-595 5389: the LEAD makes
  each ticket's worktree+branch. 16:25 (T-595 5552/5553): QA Perf may `git merge --ff-only` a base the lead pushed; lane-backend may NOT.
  An implementing lane needing a new base is ended and respawned as the same lane on a fresh branch from that base.
- BINDING: the coordinator runs deploys; I start NO deploy.
- 13:20 D-66: quick-check (format, lint, named tests) before the gate. Workers cannot git merge: the lead merges base heads in (4852).
- 11:15 D-65 (coordinator): implementers sonnet by default (opus only with a written why); small QA/review findings fixed in the same
  slice; full report on the ticket, the lead reads line 1 and opens it only on FAIL; ready features over chores.
- 15:29 Coordinator: job-run.sh caps and queues Jobs (2/program, 3 cluster); "one at a time" is PER AGENT. gate-job before each merge stays mine.
- 09:00 Persona/role-tool/permission questions go to the coordinator, NEVER the owner; `owner-checklist` = production only.
- D-63: QA/ux/reviewer on SONNET (opus needs a `why`: security, gate, rule or large slice); the lead never implements or commits code.
- D-61: NO Agent-tool sub-agents, heavy work ONLY via scripts/job-run.sh or gate-job.sh, one at a time. Hand over before 250k.

## NEEDS A HUMAN (D-62)
- T-578 (gate wall, via coordinator): owner picks same-tree gate reuse (a) portal CI store [lead default], (b) pipeline-only RBAC
  ConfigMap, (c) accept risk, (d) drop reuse; reuse also conflicts with "full gate on the exact commit" (charter). Lead can't comment (T-634).
- T-666 (high, RBAC = a person's wall): workspace kohi-event can create/delete ConfigMaps in isnan-claudepilot (review 6168, can-i).
- T-401 gate wall: RESOLVED, coordinator's ack 8027 (13:50, D-62), conditions met except the gate (batch 24 gating).
- T-341 D (updatedInput) needs a real Claude Code session (person/coordinator). T-93 Konfersi production only. Coordinator items: T-422 (sudo), T-306 item 4 / T-340; D-row for T-417's Bypass across sleep;
  T-433's persona-wall question (2984).
- For the coordinator, NOT the owner (not tagged owner-checklist): T-476 lead may START a deploy whose release waits for a person
  (3813); T-491 Event token scope until T-426 (3965); deploys #35/#36/#37 production approval showed "auto", not changed by an agent;
  T-509 kit republish; T-594 alfian.isnan signed out; T-525 session_get + scribe tools + QA UI browser tools (5505); T-595 lane Bash (5443);
  T-591 #40 backfill after deploy (5511); T-325 S3 push door vs charter "only the main chat merges integration" + its token (5549);
  T-527 finding 4 (owner triggers tagging owner-checklist); T-657 reopen T-259/T-317/T-338; T-739 A scoring defs (scoring = person's wall).

## NEXT (in order, as slots free)
0. QA T-611 S2b 96d7c148 (QA Perf after S1h). T-591 lastReleased fix (Impl after T-772 S2). T-525: Impl drafts a persona_propose_update after T-772 S2; a person applies (8236).
1. Next batch (each after QA/review): T-611 S1b..S2b, T-736 S3c-S3e, T-675 R2b, T-781 S8; T-416 S2+S2b (after S2b QA + review).
2. T-401 in b24 (ack 8027 sat unseen 13:50-15:15: re-read HELD tickets' last comments each hour) -> T-426 S1e -> T-379 S2 3f11b28; deploys are the coordinator's. ticket_list fails: use ticket_get.
4. RTK: T-340 (person/coordinator) -> T-341 merge -> T-306 item 3. 5. T-537. 6. T-513. 7. T-472 live re-check (needs portal_status), T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-382, T-377, T-386, T-409, T-402, T-398,
   T-399, T-370 HOLD, T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512, T-520; T-404 open till deployed.

LESSONS: reply_of = LATEST reply only (verdict must be the last reply); node --test, never vitest; a gate-done notice needs action; dontAsk workers cannot read /tmp, merge, gate or wait, and Bash only in their spawn worktree (new branch = new worker); whole
test folders (T-574 red 10-15); integration moved during a gate = merge + re-gate (pack goes stale); FULL hashes; trailers in one block; status via Edit/Write ONLY; ancestor check before ff; NO status push while a gate runs (b23).
