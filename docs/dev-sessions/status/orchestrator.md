# orchestrator status (2026-10-16 07:05 UTC, session 355881a3, continuation of de232389)

Older log: `orchestrator-log-2026-10-14.md` and git history of this file (2026-10-15 DONE batches 1-7: see 4fbab374). Hand-overs: ab99b45, bb58413, 639202e.

## DONE
- DEPLOY 191 LIVE (coordinator, 2026.10.16-1 from 12c68374 = batches <=18). T-404 CLOSED (live hook in managed 10-policy.json + D-60
  refusal 7407). T-597 CLOSED (live 6208). Live checks: T-472 UNAVAILABLE with agent tokens (admin read, 7505); T-591 FAIL:
  release_report setting unset = silent skip; a person's PUT + backfill steps in 7556; silent skips -> T-776. FOR THE COORDINATOR.
- T-781, T-731, T-727 assigned to the lead (coordinator). Migration 383: 0.41 s/1M synthetic rows (T-739 7487), for the coordinator.

## IN FLIGHT (6 of 6, D-71)
- GATE b19r: wip/main-f14e9d2 f14e9d2d (1444d836 + T-697 a84a51b3 + T-574 S3 d97cbb16 + pack), gate-job running (Pending for a node).
  Then gate b21 wip/main-91da8de 91da8de3 (on b19r: T-731, r.txt drop, T-376 S4b, T-732, T-610 r3, T-739 B mig 383, T-723 S3c).
  Each green -> ff origin+pilot, rebase+push status, tell the coordinator (deploys at once). Old 35f917a9/71a2317f superseded.
  Lanes' ticket_comment refused on unassigned tickets (T-341, T-549, T-675; T-675 assign refused too): verdicts in replies + this file.
- QA PERF 330855ba (respawned; 7e4879c7 ended: Bash refused twice; new one has no Write and heredocs refused). QA T-611 S1b Job on
  f74638f1, C5e skipped as a probe defect (decided: no edit), mutants 1-3; add-fail cleanup by reading. Probes ready: S1i 6c8a2392, S6 d478c8c0 (in 8fac4ec1).
- QA UI 8b13bb5a (no Write tool, 7939/7944/7947): REVIEW T-781 S6 APPROVE 8006; REVIEW T-611 S1b APPROVE 8018 (3 follow-ups -> S1c).
  Waits: T-772 S2 (plan 7963).
- QA BE 2 42e5408f (no Write tool, 7946): QA T-733 Job at 1afaf8a6 (plan 7964); then QA T-781 S6 on wip/qa-t781s6-8fac4ec 8fac4ec1.
- T-781 (D-76) assigned to the lead: S6 DONE fb70258d 7992 (job b38e850f 145/0), review APPROVE 8006, QA queued.
- IMPL 7cc1b2f5: T-781 S7 (F2 + S5 items 1-4 + sync-throw mutant + #inflight during stop 8006) -> T-736 S3d -> T-772 S2.
- BE INFRA fad38191: T-426 S1i DONE b7fa0ba7 8019 (67/0, M1 M2 red). Lead merged S1i into S1b: ab91adf9 (union of appended tests,
  63; not run). Now T-611 S1c from ab91adf9 (8018 items 1-3 + one Job proving the merge) -> T-611 S2 -> T-524 S3c + T-733 S5 -> T-612 S1.
- BACKEND 3484bd4d: T-733 DONE 1afaf8a6 -> QA BE 2. T-675 items 1-3 already on integration (actors.test 234/243, memory.test,
  memoryBudget.test 520; N stays D-43's 5, lead's 6 was wrong). Now R2 option (a): test a turn starting during the memory read, fix if red.
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
1. Gates b19r then b21 (IN FLIGHT). Next batch: T-733 (after QA), T-781 S6 (after QA), T-611 S1b+S1i+S1c (after QA), T-736 S3c+S3d.
2. T-401 after a person's OK (8023) -> T-426 S1e -> T-379 S2 3f11b28; deploys are the coordinator's.
3. T-416 S2 (Bypass restore).
4. RTK: T-340 (person/coordinator) -> T-341 merge -> T-306 item 3. 5. T-537. 6. T-513. 7. T-472 live re-check (needs portal_status), T-422, T-147, T-438, T-425, T-436, T-437, T-432, T-382, T-377, T-386, T-409, T-402, T-398,
   T-399, T-370 HOLD, T-371..T-374, T-363, T-451, T-470, T-507, T-508, T-512, T-520; T-404 open till deployed.

LESSONS: reply_of = LATEST reply only (verdict must be the last reply); node --test, never vitest; a gate-done notice needs action; dontAsk workers cannot read /tmp, merge, gate or wait, and Bash only in their spawn worktree (new branch = new worker); whole
test folders (T-574 red 10-15); integration moved during a gate = merge + re-gate (pack goes stale); FULL hashes; trailers in one block; status via Edit/Write ONLY; ancestor check before ff.
