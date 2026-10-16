# orchestrator status (2026-10-16 15:00 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file (2026-10-15 DONE batches 1-7: see 4fbab374). Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- Batches 22-24B: git history (e8b962f9, 1e9737d5). Close on "Coordinator live check" PASS (T-401 8549). T-574 re-check after 10-17 15:00Z.
- BATCH 25 ON INTEGRATION 7c3c1e44 (gate claudepilot-gate-7c3c1e4-c387 GREEN, re-gated after release merge-back f649e481):
  T-781 S8+S8b, T-623 S2, T-416 S2+S2b (lead's mechanical controller.ts resolution 056fe1a4). Coordinator told T-731 8617.
- BATCH 26 ON INTEGRATION 83b7213e (gate claudepilot-gate-83b7213-b968 GREEN, suite 672s; after 3 re-merges as integration moved):
  T-591 S3, T-610 (mig 384; pre-deploy read-only prod count of the 2 rows is the coordinator's), T-772 S2b-S2d 03b635b5 + S2c
  464be382. Main folder ff'd (165db813 in). Coordinator told T-731.
- RESPAWN rule (coordinator, 165db813): respawn each lane BETWEEN tickets on a worktree cut from integration (or a head containing
  165db813); brief: scripts ONLY by /home/node/work/claudepilot/scripts/.... Left on old rules: QA Perf 8e8912fc, Impl is new.
- BATCH 27 ON INTEGRATION bda180d2 (gate claudepilot-gate-bda180d-3921 GREEN, suite 888s; quick-check job-5eb2f86f green):
  T-611 merge f722dca1, T-537, T-623 S2c+S2d c288c0d5, T-856 7d2acb8d (lead's mechanical PRD resolution), T-772 S2e fc9158ed,
  T-881 S1 0946106271 (S1b follow-up 8938; live proof coordinator's). Coordinator told T-731.
- BATCH 28 ON INTEGRATION 63ff971c (gate 63ff971 GREEN; quick-check job-b8b7ca64): T-860 S2+S2b ALONE. Told T-731 9085, T-860 9086.
  Flake boot.test.ts "newer portal" passed on rerun -> T-903.
## IN FLIGHT (6 of 6, D-71)
- QA PERF 82f006cf (new rules; was 8e8912fc: T-868 S2 re-review CHANGES 1 8803 (drop --hook from allowed script) -> Impl;
  T-524 S3c PWG 8969; T-612 S1 FAIL 9040 -> BE Infra). T-881 S1b PWG 9046 (READY b28; S1c param test, 9065).
  NOW QA T-781 S8c 8cb00f79 -> QA T-675 R2c f7b4e34a + R2d b82cdcb9 (moved from QA BE 2).
- QA UI 66c13056 (new rules): T-881 S1 QA PWG 8916, T-772 S2e rev APPROVE W/ NOTES 8867, T-436 rev APPROVE W/ NOTES (relayed 8941;
  notes -> T-436 S2). T-856 browser check blocked (no node_modules, 8855) = open follow-up 8860. NOW QA T-736 S3g 4eb08f4e.
- QA BE 2 b6579580 (new rules; was 42e5408f: T-860 PWG 8912). NOW QA T-436 5be5699a (own Job) -> QA T-382 S1 88b663fe
  -> T-416 S2c dcdb6553.
- IMPL 89ca3bd2 (new rules): T-425 c22a76b3 (8957; "Queued" kept; -> QA UI), T-772 S2f b36f6a54 (9014, Job 4c8104e6; -> QA UI 3rd).
  NOW T-436 S2 (review notes 8941: guarded rebind, audit names, VALIDATION_FAILED) on ticket/T-436-s2 from 5be5699a.
- BATCH 29 READY TO GATE after restart: premerge-b29 62f72772 (wip/main-62f7277) = T-524 S3c+T-733 S5 ee56bab9 + T-881 S1b
  4dba5701 + release merge-back e6d403d9. Quick-check job-89646cfa green (on 3f591f5). First gate never ran (integration moved).
  After restart: merge integration (status) in, pack, push wip, gate-job. BATCH 30 (after QA): T-436+S2, T-382 S1, T-425, T-772 S2f, T-736 S3f+S3g, T-416 S2c,
  T-675 R2c/R2d, T-781 S8c, T-612 S1 fix.
- BE INFRA 4ed98960 (new rules): NOW fix T-612 S1 per QA FAIL 9040 (eslint tseslint base spread; prettier quickCheck.test.ts; a real
  quick-check run) -> S2a baseline -> T-860 S2c after T-860 merges (gaps 8936 + 8845).
- BACKEND 658bdc65 (new rules; was 1e80e003: T-881 S1b DONE 4dba5701). NOW T-382 S2 GET /api/chat/sessions cursor (ticket/T-382-s2-sessions
  from S1 88b663fe).
- QUEUE Impl after T-436 S2: T-868 S3 (CHANGES 8803: test-only copy with hook via sed; .gitignore .shots-in.*).

## DECISIONS (binding)
- 22:45 Coordinator: workspace RESTART 23:10 UTC (cpb-secrets volume for T-623). All 6 lanes told to push WIP, no Job after 23:05,
  end `PAUSED <hash>`. Batch 29 gate deferred to after the restart (a ~40 min queue+suite would be cut). Respawn ended lanes after.
- 13:45 D-75 AMENDED (coordinator, 1444d836, in DECISIONS.md): the lead runs the gate before a merge (gate-job.sh, one per batch).
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
- 09:00 Persona/role-tool/permission questions go to the coordinator, NEVER the owner; `owner-checklist` = production only.
- D-63: QA/ux/reviewer on SONNET (opus needs a `why`: security, gate, rule or large slice); the lead never implements or commits code.
- D-61: NO Agent-tool sub-agents, heavy work ONLY via scripts/job-run.sh or gate-job.sh, one at a time. Hand over before 250k.

## NEEDS A HUMAN (D-62)
- T-578 (gate wall, via coordinator): owner picks same-tree gate reuse (a) portal CI store [lead default], (b) pipeline-only RBAC
  ConfigMap, (c) accept risk, (d) drop reuse; reuse also conflicts with "full gate on the exact commit" (charter). Lead can't comment (T-634).
- T-666 (high, RBAC = a person's wall): workspace kohi-event can create/delete ConfigMaps in isnan-claudepilot (review 6168, can-i).
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

LESSONS: a lane's rules are its worktree's .claude/settings.json: cut worktrees from integration (>= 165db813) for the absolute form; reply_of = LATEST reply only (verdict must be the last reply; T-860 S2 sat 20 min unseen: check the urgent ticket's comments too); node --test, never vitest; a gate-done notice needs action; dontAsk workers cannot read /tmp, merge, gate or wait, and Bash only in their spawn worktree (new branch = new worker); whole
test folders (T-574 red 10-15); integration moved during a gate = merge + re-gate (pack goes stale); FULL hashes; trailers in one block; status via Edit/Write ONLY; ancestor check before ff; NO status push while a gate runs (b23).
