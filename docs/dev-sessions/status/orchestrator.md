# orchestrator status (2026-10-16 15:00 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file (2026-10-15 DONE batches 1-7: see 4fbab374). Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- BATCH 23 ON INTEGRATION f2843f2e (gate claudepilot-gate-8eeef66-b31a GREEN on 8eeef663; f2843f2e = that + status only):
  T-781 S1-S7 (lead's mechanical index.ts resolution; decision 8094), T-733 S1 S4 S6. Coordinator told 8123.
- BATCH 22 ON INTEGRATION 0d521d67 (gate claudepilot-gate-0d521d6-7b1d GREEN): T-697, T-574 S3, T-731, r.txt drop, T-376 S4b,
  T-732, T-610 r3, T-739 B (mig 383), T-723 S3c. Coordinator told on T-731.
- DEPLOY 233 LIVE (coordinator, portal 2026.10.16-2 from b2d0a3d9 = batch 22; b23 NOT in it). NO Releases/ note for it (T-591
  still fails; told 8158). Live checks of b22 tickets -> QA UI; close each on LIVE PASS. Deploy 191 = batches <=18.

## IN FLIGHT (6 of 6, D-71)
- NONE gating. Lanes can't comment on unassigned tickets (T-341, T-549, T-675): verdicts in replies + this file.
- QA PERF 8e8912fc (respawned perf-tester/sonnet; old 330855ba had no Write, ended; decision 8148). T-426 S1i PASS WITH GAPS 8109.
  T-611 S1c FAIL 8111 classified 8140: 0 PRODUCT, 6 PROBE. Now fixes its probes on qa/T-611-probes 780ffa57 (48d3230f + S2
  80ffedea, lead merge) + C5e, one Job. Bash denied once (combined cmd) -> told Edit + plain git (8164: C5e-i fail-closed kept,
  probe fixed; C5e-ii known red = product gap -> S2b).
- QA UI 8b13bb5a (no Write tool, 7939/7944/7947): REVIEWS APPROVE: T-781 S6 8006, T-611 S1b 8018, T-781 S7 8049.
  QA T-675 R2 PASS WITH GAPS (mutant `await #restarting` removed at controller.ts:2330 survives) -> R2b to Impl.
  REVIEW T-611 S1c APPROVE 8095. QA T-416 S2 PASS WITH GAPS 8131 (gates red; GAP: workspace stop/person end/restart leave a stale
  kept record -> Bypass could return; HELD for S2b). REVIEW T-736 S3c+S3d APPROVE 8137. REVIEW T-611 S2 APPROVE 8141; T-426 S1i APPROVE 8157. Now LIVE checks deploy 233.
- QA BE 2 42e5408f (no Write tool, 7946): QA T-733 1afaf8a6 PASS 8007 (S1 S4 S6; S5 not delivered). QA T-781 S6 PASS WITH GAPS
  8054; S7 PASS WITH GAPS 8083 (spaced clip probes 5/5: no leak). QA T-736 S3d PASS WITH GAPS 8130 (write list misses touch/sed -i/...;
  S3c QA 7875/7907). Now QA T-611 S2 80ffedea.
- IMPL 7cc1b2f5: T-736 S3d DONE 41daac15 8078 (job 68d3cd21 38/0, M5 M7 red). Now T-675 R2b on ticket/T-675-r2b from b4024e17
  (kill the controller.ts:2330 mutant or prove the real guard) -> T-772 S2.
- BE INFRA fad38191: T-611 S1c DONE 44c293ea 8052 (80/0, proves the S1i merge ab91adf9). T-611 S2 DONE 80ffedea 8129
  (JOB_RUN_AVOID_NODES opt-in; 83/0, M1 M2 red). Now T-736 S3e (widen write list) from 41daac15 -> respawn on T-611 S2b from 80ffedea (8141 newline + tests)
  -> T-524 S3c + T-733 S5 -> T-612 S1.
- BACKEND 3484bd4d: T-416 S2 DONE 8be917e6 (lead read: 'lost' takes the wake's lead gates; a person's stop not kept) -> QA UI.
  Now T-781 S8 (S5-3c dead line, in-flight assertion) from 8eeef663 -> T-416 S2b (stale kept record) -> T-537 (docs).
- HELD: T-401 S2b a4ad3052 (QA PASS, review APPROVE 7387): a person's OK on the gate change (charter wall; 8023), then merge + gate.
  T-426 S1h/S1e after T-401; T-379 S2 3f11b28 behind it. T-578 -> owner. T-631 -> coordinator.

## DECISIONS (binding)
- 13:45 D-75 AMENDED (coordinator, 1444d836, checked in DECISIONS.md): the lead runs the gate before a merge (gate-job.sh, one per
  batch). Batch 19 rebuilt on 1444d836, then batch 21 = batch 20 + T-739 B + T-723 S3c. The 12:55 hold is superseded.
- 13:45 T-739 B in b21 on the coordinator's list; migration 383 (CREATE INDEX on chat_events) cost at real row count is the coordinator's at deploy.
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
- T-401 gate wall (via the coordinator): ack 4941 ON HOLD. Review 7103: exit-3 evidence can leak a token, the scan fails open,
  the commit's .npmrc sees the token. Fix -> re-QA -> re-ask the ack with corrected text (scope: init cache, tw clock).
- T-341 D (updatedInput) needs a real Claude Code session (person/coordinator). T-93 Konfersi production only. Coordinator items: T-422 (sudo), T-306 item 4 / T-340; D-row for T-417's Bypass across sleep;
  T-433's persona-wall question (2984).
- For the coordinator, NOT the owner (not tagged owner-checklist): T-476 lead may START a deploy whose release waits for a person
  (3813); T-491 Event token scope until T-426 (3965); deploys #35/#36/#37 production approval showed "auto", not changed by an agent;
  T-509 kit republish; T-594 alfian.isnan signed out; T-525 session_get + scribe tools + QA UI browser tools (5505); T-595 lane Bash (5443);
  T-591 #40 backfill after deploy (5511); T-325 S3 push door vs charter "only the main chat merges integration" + its token (5549);
  T-527 finding 4 (owner triggers tagging owner-checklist); T-657 reopen T-259/T-317/T-338; T-739 A scoring defs (scoring = person's wall).

## NEXT (in order, as slots free)
1. Next batch (each after QA/review): T-611 S1b..S2b, T-736 S3c-S3e, T-675 R2b, T-781 S8; T-416 S2+S2b (after S2b QA + review).
2. T-401 after a person's OK (8023) -> T-426 S1e -> T-379 S2 3f11b28; deploys are the coordinator's. ticket_list fails: use ticket_get.
4. RTK: T-340 (person/coordinator) -> T-341 merge -> T-306 item 3. 5. T-537. 6. T-513. 7. T-472 live re-check (needs portal_status), T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-382, T-377, T-386, T-409, T-402, T-398,
   T-399, T-370 HOLD, T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512, T-520; T-404 open till deployed.

LESSONS: reply_of = LATEST reply only (verdict must be the last reply); node --test, never vitest; a gate-done notice needs action; dontAsk workers cannot read /tmp, merge, gate or wait, and Bash only in their spawn worktree (new branch = new worker); whole
test folders (T-574 red 10-15); integration moved during a gate = merge + re-gate (pack goes stale); FULL hashes; trailers in one block; status via Edit/Write ONLY; ancestor check before ff; NO status push while a gate runs (b23).
